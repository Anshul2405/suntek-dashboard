-- Extra evidence photos. The original single-url columns stay as the first
-- photo so older screens keep working. New uploads write both.

alter table public.maintenance_tickets
  add column if not exists completion_photo_urls text[] not null default '{}',
  add column if not exists defective_raise_photo_urls text[] not null default '{}',
  add column if not exists defective_part_photo_urls text[] not null default '{}';

alter table public.maintenance_store_requests
  add column if not exists handover_photo_urls text[] not null default '{}',
  add column if not exists handover_invoice_urls text[] not null default '{}';

update public.maintenance_tickets
set completion_photo_urls = array[completion_photo_url]
where completion_photo_url is not null
  and cardinality(completion_photo_urls) = 0;

update public.maintenance_tickets
set defective_raise_photo_urls = array[defective_raise_photo_url]
where defective_raise_photo_url is not null
  and cardinality(defective_raise_photo_urls) = 0;

update public.maintenance_tickets
set defective_part_photo_urls = array[defective_part_photo_url]
where defective_part_photo_url is not null
  and cardinality(defective_part_photo_urls) = 0;

update public.maintenance_store_requests
set handover_photo_urls = array[handover_photo_url]
where handover_photo_url is not null
  and cardinality(handover_photo_urls) = 0;

update public.maintenance_store_requests
set handover_invoice_urls = array[handover_invoice_url]
where handover_invoice_url is not null
  and cardinality(handover_invoice_urls) = 0;
