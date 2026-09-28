-- ═══════════════════════════════════════════════════════════════════════════
-- 90_issue_store_item_unissue.sql — reverse an issued handover (ticket delete /
-- item change after handover)
-- ═══════════════════════════════════════════════════════════════════════════
-- Extends issue_store_item() with action = 'unissue':
--   • issued_qty ↓, on_hand ↑ (clamped so we never invent stock beyond what was
--     issued)
--   • writes store_stock_events with positive qty_delta (event_type 'unissue')
--
-- Pair with release for approved-but-not-handed-over requests.
-- Idempotent. Requires 61. Does NOT run itself.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.issue_store_item(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action   text;
  v_item     uuid;
  v_qty      numeric;
  v_plant    uuid;
  v_req      uuid;
  v_ref      text;
  v_just     text;
  v_actor    uuid;
  v_actorname text;

  v_store    uuid;
  v_name     text;
  v_on_hand  numeric;
  v_reserved numeric;
  v_issued   numeric;
  v_free     numeric;
  v_applied  numeric;
  v_req_res  numeric;
  v_release  numeric;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  v_action := lower(btrim(coalesce(payload->>'action', '')));
  v_item   := (payload->>'store_item_id')::uuid;
  v_qty    := (payload->>'qty')::numeric;
  v_plant  := (payload->>'requesting_plant_id')::uuid;
  v_req    := nullif(payload->>'store_request_id', '')::uuid;
  v_ref    := nullif(btrim(coalesce(payload->>'ref', '')), '');
  v_just   := nullif(btrim(coalesce(payload->>'justification', '')), '');

  if v_action not in ('reserve', 'issue', 'release', 'unissue') then
    raise exception 'invalid: action must be reserve, issue, release or unissue';
  end if;
  if v_item is null then raise exception 'invalid: store_item_id is required'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'invalid: qty must be > 0'; end if;
  if v_plant is null then raise exception 'invalid: requesting_plant_id is required'; end if;

  select si.store_id, si.item_name, si.on_hand, si.reserved_qty, si.issued_qty
    into v_store, v_name, v_on_hand, v_reserved, v_issued
    from store_items si
   where si.id = v_item
   for update;

  if not found then
    raise exception 'not_found: store item %', v_item;
  end if;

  if not (public.store_in_scope(v_store) or public.store_in_plant_scope(v_store)) then
    raise exception 'forbidden: store out of scope';
  end if;
  if not exists (select 1 from factory_store_access f
                  where f.store_id = v_store and f.plant_id = v_plant) then
    raise exception 'forbidden: factory % is not served by this store', v_plant;
  end if;

  v_reserved := coalesce(v_reserved, 0);
  v_on_hand  := coalesce(v_on_hand, 0);
  v_issued   := coalesce(v_issued, 0);

  v_req_res := 0;
  if v_req is not null then
    select coalesce(reserved_qty, 0) into v_req_res
      from maintenance_store_requests where id = v_req for update;
    v_req_res := coalesce(v_req_res, 0);
  end if;

  if v_action = 'reserve' then
    v_free := greatest(0, v_on_hand - v_reserved);
    v_applied := least(v_qty, v_free);
    if v_applied > 0 then
      update store_items
         set reserved_qty = reserved_qty + v_applied, updated_at = now()
       where id = v_item;
      v_reserved := v_reserved + v_applied;
      if v_req is not null then
        update maintenance_store_requests
           set reserved_qty = coalesce(reserved_qty, 0) + v_applied where id = v_req;
      end if;
    end if;

  elsif v_action = 'release' then
    v_applied := least(v_qty, case when v_req is not null then v_req_res else v_reserved end);
    if v_applied > 0 then
      update store_items
         set reserved_qty = greatest(0, reserved_qty - v_applied), updated_at = now()
       where id = v_item
       returning reserved_qty into v_reserved;
      if v_req is not null then
        update maintenance_store_requests
           set reserved_qty = greatest(0, coalesce(reserved_qty, 0) - v_applied) where id = v_req;
      end if;
    end if;

  elsif v_action = 'unissue' then
    -- Reverse a prior issue (ticket delete / item change after handover).
    -- Cap to issued_qty so we never create free stock that was never taken.
    v_applied := least(v_qty, v_issued);
    if v_applied > 0 then
      update store_items
         set issued_qty = greatest(0, issued_qty - v_applied),
             on_hand    = on_hand + v_applied,
             updated_at = now()
       where id = v_item
       returning on_hand, reserved_qty, issued_qty into v_on_hand, v_reserved, v_issued;

      select ua.id into v_actor from user_accounts ua where ua.auth_user_id = auth.uid() limit 1;
      v_actorname := coalesce(nullif(btrim(coalesce(payload->>'actor_name','')), ''), 'Unknown');

      insert into store_stock_events
        (item_id, plant_id, store_id, requesting_plant_id, event_type,
         qty_delta, on_hand_after, ref, justification, actor, actor_name)
      values
        (v_item, v_plant, v_store, v_plant, 'unissue',
         v_applied, v_on_hand, coalesce(v_ref, 'manual unissue'),
         coalesce(v_just, format('Restored %s · %s (ticket undo)', v_applied, v_name)),
         v_actor, v_actorname);
    end if;

  else  -- issue
    v_applied := least(v_qty, v_on_hand);
    v_release := least(v_applied, case when v_req is not null then v_req_res else v_reserved end);
    if v_applied > 0 then
      update store_items
         set issued_qty   = issued_qty + v_applied,
             on_hand      = on_hand - v_applied,
             reserved_qty = least(
               greatest(0, reserved_qty - v_release),
               greatest(0, on_hand - v_applied)
             ),
             updated_at   = now()
       where id = v_item
       returning on_hand, reserved_qty into v_on_hand, v_reserved;

      if v_req is not null and v_release > 0 then
        update maintenance_store_requests
           set reserved_qty = greatest(0, coalesce(reserved_qty, 0) - v_release) where id = v_req;
      end if;

      select ua.id into v_actor from user_accounts ua where ua.auth_user_id = auth.uid() limit 1;
      v_actorname := coalesce(nullif(btrim(coalesce(payload->>'actor_name','')), ''), 'Unknown');

      insert into store_stock_events
        (item_id, plant_id, store_id, requesting_plant_id, event_type,
         qty_delta, on_hand_after, ref, justification, actor, actor_name)
      values
        (v_item, v_plant, v_store, v_plant, 'issue',
         -v_applied, v_on_hand, coalesce(v_ref, 'manual issue'),
         coalesce(v_just, format('Issued %s · %s', v_applied, v_name))
           || case when v_applied < v_qty
                   then format(' (only %s of %s were on hand)', v_applied, v_qty)
                   else '' end,
         v_actor, v_actorname);
    end if;
  end if;

  return jsonb_build_object(
    'ok',            true,
    'action',        v_action,
    'store_item_id', v_item,
    'store_id',      v_store,
    'requested',     v_qty,
    'applied',       coalesce(v_applied, 0),
    'short',         greatest(0, v_qty - coalesce(v_applied, 0)),
    'on_hand',       v_on_hand,
    'reserved_qty',  v_reserved
  );
end $$;

grant execute on function public.issue_store_item(jsonb) to authenticated;

notify pgrst, 'reload schema';
