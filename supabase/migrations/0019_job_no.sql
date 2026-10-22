-- Sequential job numbers: FAR-001 / STK-001 (meeting 25 Sep).
-- Re-number from created_at so a partial backfill cannot leave duplicate codes.

alter table public.fixed_assets add column if not exists job_no text;
alter table public.store_items add column if not exists job_no text;

-- lpad(..., 3) TRUNCATES 1000+ to 3 chars (FAR-1000 → FAR-100). Keep 3-digit
-- padding for 1–999 and the full number after that.
update public.fixed_assets a
   set job_no = 'FAR-' || case when n.n < 1000 then lpad(n.n::text, 3, '0') else n.n::text end
  from (
    select id, row_number() over (order by created_at, id) as n
      from public.fixed_assets
  ) n
 where a.id = n.id;

update public.store_items s
   set job_no = 'STK-' || case when n.n < 1000 then lpad(n.n::text, 3, '0') else n.n::text end
  from (
    select id, row_number() over (order by created_at, id) as n
      from public.store_items
  ) n
 where s.id = n.id;

drop index if exists public.fixed_assets_job_no_uidx;
drop index if exists public.store_items_job_no_uidx;
create unique index fixed_assets_job_no_uidx on public.fixed_assets (job_no) where job_no is not null;
create unique index store_items_job_no_uidx on public.store_items (job_no) where job_no is not null;

notify pgrst, 'reload schema';
