-- ═══════════════════════════════════════════════════════════════════════════
-- 25_roles_and_reference.sql — DB-driven roles + editable reference data
-- ═══════════════════════════════════════════════════════════════════════════
-- Moves the role/permission catalog out of hardcoded MOCK_PROFILES and the oil-
-- ratio reference tables out of mockData.ts, into the database so the client's
-- admin can manage them from the dashboard.
--
-- Run once in the (client) Supabase SQL Editor. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- roles — permission catalog (replaces MOCK_PROFILES). One row per role.
--   allowed_routes: exact dashboard route strings the role may open.
--                   ['*'] = unrestricted (admin). Empty = no dashboard pages.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists roles (
  id              text primary key,                 -- slug e.g. 'unit_head'
  label           text not null,                    -- 'Unit Head'
  level           text,                             -- 'L1'..'L4' (display only)
  description     text,
  home_route      text not null default '/dashboard',
  allowed_routes  text[] not null default '{}',     -- exact routes; {'*'} = all
  standalone_only boolean not null default false,
  is_admin        boolean not null default false,   -- true → full access (['*'])
  is_system       boolean not null default false,   -- true → cannot be deleted
  avatar_from     text,                             -- tailwind gradient (badge color)
  avatar_to       text,
  sort_order      int default 100,
  created_at      timestamptz default now()
);

alter table roles enable row level security;
drop policy if exists "anon_all" on roles;
create policy "anon_all" on roles for all using (true) with check (true);

-- Seed the existing occupational roles (no fake person names — just the role).
insert into roles (id, label, level, description, home_route, allowed_routes, standalone_only, is_admin, is_system, avatar_from, avatar_to, sort_order) values
  ('admin', 'Owner · Admin', 'L4', 'Full access to all modules and data',
    '/dashboard', array['*'], false, true, true, 'from-orange-300', 'to-orange-500', 10),

  ('unit_head', 'Unit Head', 'L3', 'Ops oversight · procurement approvals',
    '/dashboard',
    array['/dashboard','/dashboard/batches','/dashboard/stock','/dashboard/night-manager',
          '/dashboard/purchase/far','/dashboard/purchase/maint','/dashboard/purchase/activity',
          '/dashboard/purchase/storereq','/dashboard/purchase/purchase','/dashboard/oil-ratio',
          '/dashboard/audit','/dashboard/anomalies','/dashboard/anomaly-center',
          '/dashboard/cost-intelligence','/dashboard/benchmarking','/dashboard/predictive-qc',
          '/dashboard/working-capital','/dashboard/blacklist'],
    false, false, false, 'from-blue-400', 'to-blue-600', 20),

  ('warehouse_manager', 'Warehouse Dispatch', 'L2', 'Dispatch · shipping · inventory out',
    '/dashboard/warehouse-entry',
    array['/dashboard/stock','/dashboard/purchase/storereq','/dashboard/warehouse-entry'],
    false, false, false, 'from-teal-400', 'to-teal-600', 30),

  ('night_manager', 'Night Manager', 'L1', 'GPS check-in · shift photo upload',
    '/dashboard/night-entry',
    array['/dashboard/night-entry'],
    false, false, false, 'from-indigo-400', 'to-indigo-600', 40),

  ('factory_operator', 'Technical Team', 'L1', 'Data entry · OCR uploads · batch logging',
    '/dashboard/batches',
    array['/dashboard/batch-entry','/dashboard/batches','/dashboard/stock','/dashboard/daily-log'],
    false, false, false, 'from-purple-400', 'to-purple-600', 50),

  ('store_manager_maint', 'Store Manager · Maint', 'L2', 'Spare parts store · availability · handover docs',
    '/dashboard/purchase/maint',
    array['/dashboard/purchase/maint','/dashboard/purchase/storereq'],
    false, false, false, 'from-lime-400', 'to-lime-600', 60),

  ('store_manager_chlorides', 'Store Manager · Chlorides', 'L2', 'Spare-parts store for the Suntek Chlorides unit',
    '/dashboard/purchase/maint',
    array['/dashboard/purchase/maint','/dashboard/purchase/storereq'],
    false, false, false, 'from-lime-400', 'to-lime-600', 61),

  ('store_manager_plasticiser', 'Store Manager · Plasticiser', 'L2', 'Spare-parts store for the Suntek Plasticiser unit',
    '/dashboard/purchase/maint',
    array['/dashboard/purchase/maint','/dashboard/purchase/storereq'],
    false, false, false, 'from-teal-400', 'to-teal-600', 62),

  ('technician_shd', 'Operator', 'L1', 'Maintenance tickets · repairs · photo proof',
    '/dashboard/purchase/maint',
    array['/dashboard/purchase/maint'],
    false, false, false, 'from-cyan-400', 'to-cyan-600', 70),

  ('purchase_manager', 'Purchase Manager', 'L2', 'Procurement bills · dispatch tracking',
    '/dashboard/purchase/maint',
    array['/dashboard/purchase/maint','/dashboard/purchase/purchase'],
    false, false, false, 'from-fuchsia-400', 'to-fuchsia-600', 80),

  ('accountant_delhi', 'Accountant · Delhi', 'L2', 'Delhi factory financial & operational data',
    '/dashboard',
    array['/dashboard','/dashboard/sales','/dashboard/customers','/dashboard/anomalies',
          '/dashboard/anomaly-center','/dashboard/cost-intelligence','/dashboard/benchmarking',
          '/dashboard/predictive-qc','/dashboard/working-capital','/dashboard/purchase/purchase',
          '/dashboard/purchase/marine','/dashboard/purchase/labour','/dashboard/audit'],
    false, false, false, 'from-rose-400', 'to-rose-600', 90),

  ('accountant_other', 'Accountant · Other', 'L2', 'All factories (excl. Delhi) financial data',
    '/dashboard',
    array['/dashboard','/dashboard/sales','/dashboard/customers','/dashboard/anomalies',
          '/dashboard/anomaly-center','/dashboard/cost-intelligence','/dashboard/benchmarking',
          '/dashboard/predictive-qc','/dashboard/working-capital','/dashboard/purchase/purchase',
          '/dashboard/purchase/marine','/dashboard/purchase/labour','/dashboard/audit'],
    false, false, false, 'from-amber-400', 'to-amber-600', 91)
on conflict (id) do nothing;

-- Every role gets the personal To-Do page (/dashboard/todo). Admin holds '*'.
-- Idempotent; also shipped standalone as 50_todo_route_grant.sql for existing DBs
-- and for the `management` role (added later in 30_management_role.sql).
update roles set allowed_routes = array_append(allowed_routes, '/dashboard/todo')
 where not ('*' = any(allowed_routes)) and not ('/dashboard/todo' = any(allowed_routes));

-- ───────────────────────────────────────────────────────────────────────────
-- oil_ratios — editable reference table (replaces OIL_RATIO_SUNTEK/MANAV)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists oil_ratios (
  id         uuid primary key default gen_random_uuid(),
  brand      text not null,            -- 'suntek' | 'manav'
  density    integer not null,
  np         text,                     -- NP grams
  wx         text,                     -- WX grams
  cl         text,                     -- Cl ratio
  hcl        text,                     -- HCl ratio
  vr         numeric,                  -- variance %
  ok         boolean default true,
  sort_order int default 0,
  unique (brand, density)
);

alter table oil_ratios enable row level security;
drop policy if exists "anon_all" on oil_ratios;
create policy "anon_all" on oil_ratios for all using (true) with check (true);

insert into oil_ratios (brand, density, np, wx, cl, hcl, vr, ok, sort_order) values
  ('suntek', 1100, '565 g', '575 g', '0.70', '1.05',  -0.4, true,  1),
  ('suntek', 1200, '510 g', '520 g', '0.95', '1.43',   0.6, true,  2),
  ('suntek', 1300, '448 g', '458 g', '1.10', '1.65',  -1.1, true,  3),
  ('suntek', 1390, '395 g', '405 g', '1.29', '1.94',   2.4, false, 4),
  ('suntek', 1400, '390 g', '400 g', '1.30', '1.95',   0.8, true,  5),
  ('suntek', 1450, '365 g', '—',     '1.40', '2.10',  -0.2, true,  6),
  ('suntek', 1500, '335 g', '—',     '1.65', '2.475',  0.3, true,  7),
  ('manav',  1100, '571 g', '581 g', '0.68', '1.02',   0.0, true,  1),
  ('manav',  1200, '516 g', '526 g', '0.92', '1.38',   0.4, true,  2),
  ('manav',  1300, '453 g', '463 g', '1.08', '1.62',  -0.5, true,  3),
  ('manav',  1390, '399 g', '409 g', '1.25', '1.88',   1.7, true,  4),
  ('manav',  1400, '394 g', '404 g', '1.25', '1.88',   0.2, true,  5),
  ('manav',  1450, '369 g', '—',     '1.35', '2.03',   0.0, true,  6),
  ('manav',  1500, '339 g', '—',     '1.60', '2.40',  -0.3, true,  7)
on conflict (brand, density) do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- Realtime (so role/ratio edits propagate live)
-- ───────────────────────────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table roles;      exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table oil_ratios; exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTE: CP stock grid axes are already DB-driven via the cpm_drum_stock table
-- (location + density columns). No separate table needed — adding rows there
-- adds locations/densities to the grid automatically.
-- ═══════════════════════════════════════════════════════════════════════════

