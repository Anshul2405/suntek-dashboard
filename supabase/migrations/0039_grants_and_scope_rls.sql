-- Close the grant hole and scope the tables that were still open (27 Oct 2026 audit).
-- Applied live 27 Oct 2026 (hosting follow-up same day). Backup: /tmp/suntek-backups/2026-10-27/{schema.sql,data.sql,pg_policies.txt}.
-- Rollback = restore those dumps (or re-create the dropped policies listed in pg_policies.txt).
--
-- Additive only: policies are replaced with tighter ones and two guard triggers
-- are added. No row is deleted or updated. Every user_plants / user_units /
-- user_roles / user_stores row stays exactly as it is.
--
-- Live before this (pg_policies 27 Oct):
--   user_plants, user_units, user_roles, user_stores  anon_all USING (true) WITH CHECK (true)
--   user_accounts                                     anon_all USING (not deleted) WITH CHECK (true)
--   incident_reports                                  incident_reports_rw TO authenticated USING (true)
--   late_entry_requests, ops_settings, system_audit   *_all USING (true) WITH CHECK (true)
--   shift_logs                                        SELECT USING (true); INSERT WITH CHECK (true)
--   notifications, entity_notes, user_account_events  anon_all USING (true) WITH CHECK (true)
-- Left as they are on purpose:
--   dispatch_logs (0038, already signed-in only), marine_insurance (live is L4-only,
--   tighter than the repo), profiles (own row / L4), Busy feed tables.
--
-- Blank grant stays fail-closed: my_plant_ids() reads user_plants only, so an
-- account with no user_plants row and no is_global sees no plant-scoped row.

begin;

-- ── Helpers ────────────────────────────────────────────────────────────────

-- Who may change accounts and grants: admins / global users, or a role with
-- the existing User Management capability.
create or replace function public.can_manage_users() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_global_user() or public.has_capability('manage_users');
$$;

-- Managers: user managers, or anyone holding the management / admin role.
create or replace function public.is_manager() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.can_manage_users()
      or exists (
        select 1 from user_accounts ua
         where ua.auth_user_id = auth.uid()
           and (ua.role_id in ('admin', 'management')
                or exists (select 1 from user_roles ur
                            where ur.user_account_id = ua.id
                              and ur.role_id in ('admin', 'management')))
      );
$$;

-- The caller's own account row ids (security definer: no policy recursion).
create or replace function public.my_account_ids() returns setof uuid
  language sql stable security definer set search_path = public as $$
  select id from user_accounts where auth_user_id = auth.uid();
$$;

-- ── user_accounts: everyone may read (login looks up the e-mail by phone
--    before sign-in); only user managers write; a user may edit their own
--    name / language / photo and nothing else. ─────────────────────────────
alter table public.user_accounts enable row level security;
drop policy if exists "anon_all" on public.user_accounts;
drop policy if exists user_accounts_read on public.user_accounts;
drop policy if exists user_accounts_insert on public.user_accounts;
drop policy if exists user_accounts_update on public.user_accounts;
drop policy if exists user_accounts_delete on public.user_accounts;
create policy user_accounts_read on public.user_accounts
  for select using (coalesce(is_deleted, false) = false);
create policy user_accounts_insert on public.user_accounts
  for insert to authenticated with check (public.can_manage_users());
create policy user_accounts_update on public.user_accounts
  for update to authenticated
  using (public.can_manage_users() or auth_user_id = auth.uid())
  with check (public.can_manage_users() or auth_user_id = auth.uid());
create policy user_accounts_delete on public.user_accounts
  for delete to authenticated using (public.can_manage_users());

create or replace function public.guard_user_account_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  self_ok constant text[] := array['name', 'preferred_language', 'photo_url', 'updated_at', 'mobile_norm'];
begin
  -- Nobody makes an account global (or admin) unless they are global already.
  if (tg_op = 'INSERT' and (coalesce(new.is_global, false) or new.role_id = 'admin'))
     or (tg_op = 'UPDATE' and (new.is_global is distinct from old.is_global
                               or (new.role_id = 'admin' and old.role_id is distinct from 'admin'))) then
    if not public.is_global_user() then
      raise exception 'Only an admin can grant all-plants or admin access';
    end if;
  end if;
  -- A user editing their own row may change only their own display fields.
  if tg_op = 'UPDATE' and not public.can_manage_users() then
    if (to_jsonb(new) - self_ok) is distinct from (to_jsonb(old) - self_ok) then
      raise exception 'You can change only your own name, language and photo';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_user_account_change on public.user_accounts;
create trigger guard_user_account_change
  before insert or update on public.user_accounts
  for each row execute function public.guard_user_account_change();

-- ── Grant tables: read your own (or as a user manager); write as a user manager.
do $$
declare t text;
begin
  foreach t in array array['user_plants', 'user_units', 'user_stores'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "anon_all" on public.%I', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using (public.can_manage_users() or user_account_id in (select public.my_account_ids()))$p$,
                   t || '_read', t);
    execute format($p$create policy %I on public.%I for all to authenticated
                     using (public.can_manage_users()) with check (public.can_manage_users())$p$,
                   t || '_write', t);
  end loop;
end $$;

-- user_roles: the people directory shows everyone's role, so signed-in users
-- may read it; only user managers write; only an admin hands out an admin role.
alter table public.user_roles enable row level security;
drop policy if exists "anon_all" on public.user_roles;
drop policy if exists user_roles_read on public.user_roles;
drop policy if exists user_roles_write on public.user_roles;
create policy user_roles_read on public.user_roles
  for select to authenticated using (true);
create policy user_roles_write on public.user_roles
  for all to authenticated using (public.can_manage_users()) with check (public.can_manage_users());

create or replace function public.guard_admin_role_grant() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from roles r where r.id = new.role_id and r.is_admin)
     and not public.is_global_user() then
    raise exception 'Only an admin can grant an admin role';
  end if;
  return new;
end $$;
drop trigger if exists guard_admin_role_grant on public.user_roles;
create trigger guard_admin_role_grant
  before insert or update on public.user_roles
  for each row execute function public.guard_admin_role_grant();

-- ── Plant-scoped tables that were open ──────────────────────────────────────
-- plant_in_scope(NULL) is true only for global users: a row with no plant stays
-- in the table and is visible to admin / all-plants users only. (This is why a
-- plant-scoped user may not see an incident saved without a plant — e.g. the
-- Ganjam incident of 2 Oct if its plant_id is NULL. The row is kept.)

alter table public.incident_reports enable row level security;
drop policy if exists incident_reports_rw on public.incident_reports;
drop policy if exists incident_reports_read on public.incident_reports;
drop policy if exists incident_reports_insert on public.incident_reports;
drop policy if exists incident_reports_update on public.incident_reports;
drop policy if exists incident_reports_delete on public.incident_reports;
create policy incident_reports_read on public.incident_reports
  for select to authenticated using (public.plant_in_scope(plant_id));
create policy incident_reports_insert on public.incident_reports
  for insert to authenticated with check (public.plant_in_scope(plant_id));
create policy incident_reports_update on public.incident_reports
  for update to authenticated
  using (public.plant_in_scope(plant_id)) with check (public.plant_in_scope(plant_id));
create policy incident_reports_delete on public.incident_reports
  for delete to authenticated using (public.is_global_user());

-- shift_logs: check-ins. Anyone signed in may check in (night duty can be at
-- another plant); reading is by plant, or a check-in for your own night duty
-- (My night duty reads its row back right after inserting it).
alter table public.shift_logs enable row level security;
drop policy if exists "L2+ can view all check-ins" on public.shift_logs;
drop policy if exists "L1 can log own check-in" on public.shift_logs;
drop policy if exists shift_logs_read on public.shift_logs;
drop policy if exists shift_logs_insert on public.shift_logs;
create policy shift_logs_read on public.shift_logs
  for select to authenticated
  using (
    public.plant_in_scope(plant_id)
    or employee_id = auth.uid()
    or night_duty_id in (select nd.id from night_duty nd
                          where nd.technician_id in (select public.my_account_ids()))
  );
create policy shift_logs_insert on public.shift_logs
  for insert to authenticated with check (auth.uid() is not null);

-- notifications: broadcast (no plant) or a plant you can see. Anyone signed in
-- may send one; read_by / cleared_by updates follow the read rule.
alter table public.notifications enable row level security;
drop policy if exists "anon_all" on public.notifications;
drop policy if exists notifications_read on public.notifications;
drop policy if exists notifications_insert on public.notifications;
drop policy if exists notifications_update on public.notifications;
drop policy if exists notifications_delete on public.notifications;
create policy notifications_read on public.notifications
  for select to authenticated using (plant_id is null or public.plant_in_scope(plant_id));
create policy notifications_insert on public.notifications
  for insert to authenticated with check (auth.uid() is not null);
create policy notifications_update on public.notifications
  for update to authenticated
  using (plant_id is null or public.plant_in_scope(plant_id))
  with check (plant_id is null or public.plant_in_scope(plant_id));
create policy notifications_delete on public.notifications
  for delete to authenticated using (public.is_global_user());

-- ── Settings, late requests and audit: signed-in only; managers decide. ────
alter table public.ops_settings enable row level security;
drop policy if exists ops_settings_all on public.ops_settings;
drop policy if exists ops_settings_read on public.ops_settings;
drop policy if exists ops_settings_write on public.ops_settings;
-- The Busy link secret is read only by the security-definer publish functions.
create policy ops_settings_read on public.ops_settings
  for select to authenticated using (key <> 'busy_link_secret');
create policy ops_settings_write on public.ops_settings
  for all to authenticated using (public.is_manager()) with check (public.is_manager());

alter table public.late_entry_requests enable row level security;
drop policy if exists late_entry_all on public.late_entry_requests;
drop policy if exists late_entry_read on public.late_entry_requests;
drop policy if exists late_entry_insert on public.late_entry_requests;
drop policy if exists late_entry_review on public.late_entry_requests;
create policy late_entry_read on public.late_entry_requests
  for select to authenticated using (true);
create policy late_entry_insert on public.late_entry_requests
  for insert to authenticated with check (auth.uid() is not null);
-- Approving / rejecting a late entry is a manager's call, never the requester's.
create policy late_entry_review on public.late_entry_requests
  for update to authenticated using (public.is_manager()) with check (public.is_manager());

-- Audit history is append-only: anyone signed in adds a line, managers read it,
-- nobody edits or deletes it.
alter table public.system_audit enable row level security;
drop policy if exists system_audit_all on public.system_audit;
drop policy if exists system_audit_read on public.system_audit;
drop policy if exists system_audit_insert on public.system_audit;
create policy system_audit_read on public.system_audit
  for select to authenticated using (public.is_manager());
create policy system_audit_insert on public.system_audit
  for insert to authenticated with check (auth.uid() is not null);

-- Ticket notes and account history: signed-in users only (was anon).
alter table public.entity_notes enable row level security;
drop policy if exists "anon_all" on public.entity_notes;
drop policy if exists entity_notes_auth on public.entity_notes;
create policy entity_notes_auth on public.entity_notes
  for all to authenticated using (true) with check (auth.uid() is not null);

alter table public.user_account_events enable row level security;
drop policy if exists "anon_all" on public.user_account_events;
drop policy if exists user_account_events_read on public.user_account_events;
drop policy if exists user_account_events_insert on public.user_account_events;
create policy user_account_events_read on public.user_account_events
  for select to authenticated
  using (public.can_manage_users() or user_account_id in (select public.my_account_ids()));
create policy user_account_events_insert on public.user_account_events
  for insert to authenticated with check (auth.uid() is not null);

grant execute on function public.can_manage_users() to authenticated;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.my_account_ids() to authenticated;

commit;

notify pgrst, 'reload schema';
