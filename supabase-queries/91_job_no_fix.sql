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
