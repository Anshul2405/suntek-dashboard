-- Rename Technician → Operator (keep role id technician_shd).
-- Add assignable capability: complete_periodic_maintenance (Mark Complete + upload).

update public.roles
   set label = 'Operator',
       description = coalesce(description, 'Maintenance tickets · repairs · photo proof')
 where id = 'technician_shd'
   and label in ('Technician', 'technician');

-- Capability toggle — grantable to any role via Manage Roles.
-- Default ON for Operator so existing plant workflow keeps working until reassigned.
update public.roles
   set capabilities = (
     select array_agg(distinct c)
     from unnest(coalesce(capabilities, '{}'::text[]) || array['complete_periodic_maintenance']) as c
   )
 where id = 'technician_shd'
   and not ('complete_periodic_maintenance' = any (coalesce(capabilities, '{}'::text[])));

update public.user_accounts
   set role_label = 'Operator'
 where role_id = 'technician_shd'
   and role_label in ('Technician', 'technician');
