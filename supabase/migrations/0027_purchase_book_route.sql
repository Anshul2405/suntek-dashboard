-- Grant the Purchase book page to roles that already see purchase orders or marine insurance.
-- Admin holds '*' and is skipped. Safe to run again.

update roles
   set allowed_routes = array_append(allowed_routes, '/dashboard/purchase/book')
 where not ('*' = any(allowed_routes))
   and not ('/dashboard/purchase/book' = any(allowed_routes))
   and (
     '/dashboard/purchase/purchase' = any(allowed_routes)
     or '/dashboard/purchase/marine' = any(allowed_routes)
   );
