/**
 * Global quick-search (Cmd+K palette) data layer.
 *
 * Searches tickets, schedules, stock/FAR job nos, plants, people, store reqs,
 * activity, sales, purchases, batches, and the rest of the workspace. Access-
 * aware: an entity is only searched if the profile can open its page.
 */
import { callRpc } from './db';
import { fetchAllRows } from './fetchAll';
import { supabase } from './supabase';
import { displayLocationName } from './plantLabels';

export type SearchType =
  | 'ticket' | 'schedule' | 'note' | 'user' | 'customer' | 'plant'
  | 'storereq' | 'stock' | 'asset' | 'activity' | 'blacklist' | 'batch'
  | 'po' | 'marine' | 'sales' | 'upload' | 'part' | 'cpm' | 'supplier';

export interface SearchResult {
  id: string;
  type: SearchType;
  title: string;
  subtitle?: string;
  /** Where selecting the result navigates. */
  route: string;
}

interface EntityConfig {
  type: SearchType;
  table: string;
  select: string;
  columns: string[];
  route: string;
  groupKey: string;
  /** Handled by a dedicated RPC / helper — skip the generic ilike loop. */
  skipGeneric?: boolean;
  order?: { column: string; ascending?: boolean };
  map: (row: Record<string, unknown>) => Omit<SearchResult, 'type'>;
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const join = (parts: unknown[]): string | undefined => {
  const s = parts.map(str).filter(Boolean).join(' · ');
  return s || undefined;
};
const clip = (s: string, n = 90): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const shortId = (id: string): string => (id ? id.slice(0, 8) : '');

const TICKET_ROUTE = '/dashboard/purchase/maint';
const STORE_ROUTE = '/dashboard/purchase/storereq';
const FAR_ROUTE = '/dashboard/purchase/far';

const ENTITIES: EntityConfig[] = [
  {
    type: 'ticket',
    table: 'maintenance_tickets',
    select: 'id, title, equipment, description, raised_by, assigned_to, status, far_asset_id, plant_id',
    columns: ['title', 'equipment', 'description', 'raised_by', 'assigned_to'],
    route: TICKET_ROUTE,
    groupKey: 'palette.groupTickets',
    skipGeneric: true,
    map: (r) => {
      const id = str(r.id);
      const label = str(r.equipment) || str(r.title) || 'Ticket';
      return {
        id,
        title: id ? `#${shortId(id)} · ${label}` : label,
        subtitle: clip(join([r.job_no, displayLocationName(str(r.plant_name)), r.status, r.description]) ?? ''),
        route: `${TICKET_ROUTE}?ticket=${id}`,
      };
    },
  },
  {
    type: 'schedule',
    table: 'maintenance_schedules',
    select: 'id, title, equipment, equipment_mark, frequency, assigned_to, description',
    columns: ['title', 'equipment', 'equipment_mark', 'assigned_to', 'description'],
    route: TICKET_ROUTE,
    groupKey: 'palette.groupSchedules',
    skipGeneric: true,
    map: (r) => {
      const label = str(r.title) || str(r.equipment) || 'Schedule';
      const q = encodeURIComponent(str(r.job_no) || str(r.equipment_mark) || str(r.equipment) || label);
      return {
        id: str(r.id),
        title: str(r.job_no) ? `${str(r.job_no)} · ${label}` : label,
        subtitle: clip(join([r.equipment, r.frequency, displayLocationName(str(r.plant_name)), r.equipment_mark]) ?? ''),
        route: `${TICKET_ROUTE}?tab=periodic&q=${q}`,
      };
    },
  },
  {
    type: 'user',
    table: 'user_accounts',
    select: 'id, name, role_label, plant_name, email, mobile, designation',
    columns: ['name', 'email', 'mobile', 'whatsapp', 'role_label', 'plant_name', 'designation'],
    route: '/dashboard/users',
    groupKey: 'palette.groupPeople',
    map: (r) => ({
      id: str(r.id),
      title: str(r.name),
      subtitle: join([r.role_label, displayLocationName(str(r.plant_name)), r.email]),
      route: '/dashboard/users',
    }),
  },
  {
    type: 'customer',
    table: 'customers',
    select: 'id, name, place',
    columns: ['name', 'place'],
    route: '/dashboard/customers',
    groupKey: 'palette.groupCustomers',
    map: (r) => ({ id: str(r.id), title: str(r.name), subtitle: join([r.place]), route: '/dashboard/customers' }),
  },
  {
    type: 'plant',
    table: 'plants',
    select: 'id, name, factory_code, entity_name, company_name, legacy_names',
    columns: ['name', 'factory_code', 'entity_name', 'company_name'],
    route: '/dashboard',
    groupKey: 'palette.groupPlants',
    skipGeneric: true,
    map: (r) => {
      const name = displayLocationName(str(r.name)) || 'Plant';
      return {
        id: str(r.id),
        title: name,
        subtitle: join([r.factory_code, r.entity_name, r.company_name]),
        route: `${TICKET_ROUTE}?tab=periodic&q=${encodeURIComponent(name)}`,
      };
    },
  },
  {
    type: 'storereq',
    table: 'store_requisitions',
    select: 'id, item, raised_by, status',
    columns: ['item', 'raised_by', 'approved_by', 'remarks'],
    route: STORE_ROUTE,
    groupKey: 'palette.groupStoreReq',
    skipGeneric: true,
    map: (r) => {
      const id = str(r.id);
      const item = str(r.item) || 'Requisition';
      return {
        id,
        title: id ? `#${shortId(id)} · ${item}` : item,
        subtitle: join([r.status, displayLocationName(str(r.plant_name)), r.raised_by]),
        route: `${STORE_ROUTE}?q=${encodeURIComponent(shortId(id) || item)}`,
      };
    },
  },
  {
    type: 'stock',
    table: 'store_items',
    select: 'id, item_name, job_no, equipment, model, on_hand, unit',
    columns: ['item_name', 'job_no', 'equipment', 'model'],
    route: STORE_ROUTE,
    groupKey: 'palette.groupStock',
    order: { column: 'job_no', ascending: true },
    map: (r) => {
      const job = str(r.job_no);
      const name = str(r.item_name) || 'Stock item';
      const q = encodeURIComponent(job || name);
      return {
        id: str(r.id),
        title: job ? `${job} · ${name}` : name,
        subtitle: join([r.equipment, r.model, r.on_hand != null ? `${r.on_hand}${r.unit ? ` ${r.unit}` : ''}` : '']),
        route: `${STORE_ROUTE}?tab=stock&q=${q}`,
      };
    },
  },
  {
    type: 'asset',
    table: 'fixed_assets',
    select: 'id, name, model, identification_mark, account_head, job_no, make, serial_no',
    columns: ['name', 'identification_mark', 'model', 'capacity', 'invoice_no', 'account_head', 'job_no', 'make', 'serial_no'],
    route: FAR_ROUTE,
    groupKey: 'palette.groupAssets',
    order: { column: 'job_no', ascending: true },
    map: (r) => {
      const job = str(r.job_no);
      const name = str(r.name) || 'Asset';
      const q = encodeURIComponent(job || name);
      return {
        id: str(r.id),
        title: job ? `${job} · ${name}` : name,
        subtitle: join([r.model, r.identification_mark, r.serial_no, r.account_head]),
        route: `${FAR_ROUTE}?q=${q}`,
      };
    },
  },
  {
    type: 'activity',
    table: 'activity_logs',
    select: 'id, type, equipment, note, done_by, verified_by, date',
    columns: ['equipment', 'note', 'done_by', 'verified_by', 'type'],
    route: '/dashboard/purchase/activity',
    groupKey: 'palette.groupActivity',
    map: (r) => ({
      id: str(r.id),
      title: str(r.equipment) || str(r.type) || 'Activity',
      subtitle: clip(join([r.type, r.done_by, r.date, r.note]) ?? ''),
      route: `/dashboard/purchase/activity?q=${encodeURIComponent(str(r.equipment) || str(r.note) || str(r.type))}`,
    }),
  },
  {
    type: 'blacklist',
    table: 'blacklist',
    select: 'id, name, type, severity, reason',
    columns: ['name', 'identifier', 'reason', 'notes', 'reference_no', 'added_by'],
    route: '/dashboard/blacklist',
    groupKey: 'palette.groupBlacklist',
    map: (r) => ({ id: str(r.id), title: str(r.name), subtitle: join([r.type, r.severity, r.reason]), route: '/dashboard/blacklist' }),
  },
  {
    type: 'batch',
    table: 'production_batch_sheets',
    select: 'id, batch_no, colour_note, created_by_name, oil_grade, density',
    columns: ['batch_no', 'colour_note', 'created_by_name', 'oil_grade'],
    route: '/dashboard/batches',
    groupKey: 'palette.groupBatches',
    map: (r) => ({
      id: str(r.id),
      title: str(r.batch_no) ? `#${str(r.batch_no)}` : 'Batch sheet',
      subtitle: join([r.oil_grade, r.density, r.created_by_name]),
      route: `/dashboard/batches?highlight=${encodeURIComponent(str(r.batch_no))}`,
    }),
  },
  {
    type: 'batch',
    table: 'active_batches',
    select: 'id, batch_no, recipe, status',
    columns: ['batch_no', 'recipe'],
    route: '/dashboard/batches',
    groupKey: 'palette.groupBatches',
    map: (r) => ({ id: str(r.id), title: str(r.batch_no) ? `#${str(r.batch_no)}` : 'Batch', subtitle: join([r.recipe, r.status]), route: '/dashboard/batches' }),
  },
  {
    type: 'po',
    table: 'oil_contracts',
    select: 'id, oil_type, company, status, paraffin_type, port',
    columns: ['oil_type', 'company', 'paraffin_type', 'port'],
    route: '/dashboard/purchase/purchase',
    groupKey: 'palette.groupPurchase',
    map: (r) => ({
      id: str(r.id),
      title: join([r.oil_type, r.company]) ?? 'Purchase order',
      subtitle: join([r.status, r.port, r.paraffin_type]),
      route: `/dashboard/purchase/purchase?q=${encodeURIComponent(str(r.company) || str(r.oil_type))}`,
    }),
  },
  {
    type: 'po',
    table: 'stock_purchase_receipts',
    select: 'id, vendor_name, invoice_no, gst_no, notes, amount, purchase_date',
    columns: ['vendor_name', 'invoice_no', 'gst_no', 'notes'],
    route: STORE_ROUTE,
    groupKey: 'palette.groupPurchase',
    map: (r) => ({
      id: str(r.id),
      title: str(r.vendor_name) || str(r.invoice_no) || 'Purchase receipt',
      subtitle: join([r.invoice_no, r.gst_no, r.amount, r.purchase_date]),
      route: `${STORE_ROUTE}?tab=stock&q=${encodeURIComponent(str(r.vendor_name) || str(r.invoice_no))}`,
    }),
  },
  {
    type: 'marine',
    table: 'marine_insurance',
    select: 'id, reference, type, amount, date',
    columns: ['reference'],
    route: '/dashboard/purchase/marine',
    groupKey: 'palette.groupMarine',
    map: (r) => ({
      id: str(r.id),
      title: str(r.reference) || 'Marine entry',
      subtitle: join([r.type, r.amount, r.date]),
      route: '/dashboard/purchase/marine',
    }),
  },
  {
    type: 'sales',
    table: 'sales_ledger',
    select: 'id, invoice_no, vehicle_no, transporter, location, date, qty',
    columns: ['invoice_no', 'vehicle_no', 'transporter', 'location'],
    route: '/dashboard/sales',
    groupKey: 'palette.groupSales',
    map: (r) => ({
      id: str(r.id),
      title: str(r.invoice_no) ? `Invoice ${str(r.invoice_no)}` : (str(r.vehicle_no) || 'Dispatch'),
      subtitle: join([r.vehicle_no, r.transporter, r.location, r.date]),
      route: `/dashboard/sales?q=${encodeURIComponent(str(r.invoice_no) || str(r.vehicle_no) || str(r.transporter))}`,
    }),
  },
  {
    type: 'sales',
    table: 'dispatch_logs',
    select: 'id, destination, item, vehicle_no, document_ref, supplier, sender, receiver',
    columns: ['destination', 'item', 'vehicle_no', 'document_ref', 'supplier', 'sender', 'receiver'],
    route: '/dashboard/sales',
    groupKey: 'palette.groupSales',
    map: (r) => ({
      id: str(r.id),
      title: str(r.item) || str(r.destination) || 'Dispatch',
      subtitle: join([r.vehicle_no, r.document_ref, r.destination, r.supplier]),
      route: `/dashboard/sales?q=${encodeURIComponent(str(r.vehicle_no) || str(r.item) || str(r.destination))}`,
    }),
  },
  {
    type: 'part',
    table: 'maintenance_store_requests',
    select: 'id, part_name, ticket_id, busy_transaction_ref, supplier_name, specification, store_decision',
    columns: ['part_name', 'busy_transaction_ref', 'supplier_name', 'specification'],
    route: TICKET_ROUTE,
    groupKey: 'palette.groupParts',
    map: (r) => ({
      id: str(r.id),
      title: str(r.part_name) || 'Store part',
      subtitle: join([r.busy_transaction_ref, r.supplier_name, r.store_decision]),
      route: str(r.ticket_id) ? `${TICKET_ROUTE}?ticket=${str(r.ticket_id)}` : TICKET_ROUTE,
    }),
  },
  {
    type: 'part',
    table: 'maintenance_defective_parts',
    select: 'id, part_name, ticket_id, actor_name',
    columns: ['part_name', 'actor_name'],
    route: STORE_ROUTE,
    groupKey: 'palette.groupParts',
    map: (r) => ({
      id: str(r.id),
      title: str(r.part_name) || 'Defective part',
      subtitle: join([r.actor_name]),
      route: str(r.ticket_id)
        ? `${TICKET_ROUTE}?ticket=${str(r.ticket_id)}`
        : `${STORE_ROUTE}?tab=scrap&q=${encodeURIComponent(str(r.part_name))}`,
    }),
  },
  {
    type: 'part',
    table: 'repair_return_receipts',
    select: 'id, vendor_name, invoice_no, comment, status',
    columns: ['vendor_name', 'invoice_no', 'comment'],
    route: STORE_ROUTE,
    groupKey: 'palette.groupParts',
    map: (r) => ({
      id: str(r.id),
      title: str(r.vendor_name) || str(r.invoice_no) || 'Repair return',
      subtitle: join([r.invoice_no, r.status, r.comment]),
      route: `${STORE_ROUTE}?tab=scrap&q=${encodeURIComponent(str(r.vendor_name) || str(r.invoice_no))}`,
    }),
  },
  {
    type: 'upload',
    table: 'import_batches',
    select: 'id, file_name, module, uploaded_by_name, status, created_at',
    columns: ['file_name', 'uploaded_by_name', 'module'],
    route: '/dashboard/admin/uploads',
    groupKey: 'palette.groupUploads',
    map: (r) => ({
      id: str(r.id),
      title: str(r.file_name) || 'Upload',
      subtitle: join([r.module, r.uploaded_by_name, r.status]),
      route: `/dashboard/admin/uploads?q=${encodeURIComponent(str(r.file_name))}`,
    }),
  },
  {
    type: 'cpm',
    table: 'cpm_drum_stock',
    select: 'id, location, density, drums',
    columns: ['location'],
    route: '/dashboard/stock',
    groupKey: 'palette.groupCpm',
    map: (r) => ({
      id: str(r.id),
      title: str(r.location) || 'Drum stock',
      subtitle: join([r.density, r.drums != null ? `${r.drums} drums` : '']),
      route: '/dashboard/stock',
    }),
  },
  {
    type: 'cpm',
    table: 'tanks',
    select: 'id, name, location, unit',
    columns: ['name', 'location'],
    route: '/dashboard/stock',
    groupKey: 'palette.groupCpm',
    map: (r) => ({
      id: str(r.id),
      title: str(r.name) || 'Tank',
      subtitle: join([r.location, r.unit]),
      route: '/dashboard/stock',
    }),
  },
];

export const GROUP_KEY: Record<SearchType, string> = {
  ...Object.fromEntries(ENTITIES.map((e) => [e.type, e.groupKey])),
  note: 'palette.groupNotes',
  supplier: 'palette.groupSuppliers',
} as Record<SearchType, string>;

const BUSY_CUSTOMER_ROUTE = '/dashboard/customers';
const BUSY_SUPPLIER_ROUTE = '/dashboard/purchase/purchase';

/** Busy customers and suppliers from the last read. Read only, never a Busy query. */
async function searchBusy(q: string, canAccess: (route: string) => boolean): Promise<SearchResult[]> {
  const wantCustomers = canAccess(BUSY_CUSTOMER_ROUTE);
  const wantSuppliers = canAccess(BUSY_SUPPLIER_ROUTE);
  if (!wantCustomers && !wantSuppliers) return [];
  const needle = q.toLowerCase();
  try {
    const { fetchBusy, fmtINR } = await import('../hooks/useBusyData');
    const [customers, purchases] = await Promise.all([
      wantCustomers
        ? fetchBusy<{ code: number; name: string; fyRevenue: number; outstanding: number }[]>('/api/customers/list', 'all').catch(() => [])
        : Promise.resolve([]),
      wantSuppliers
        ? fetchBusy<{ supplier: string; company: string; amount: number; date: string }[]>('/api/purchases/recent', 'all').catch(() => [])
        : Promise.resolve([]),
    ]);
    const out: SearchResult[] = [];
    for (const c of (Array.isArray(customers) ? customers : [])) {
      if (!String(c.name || '').toLowerCase().includes(needle)) continue;
      out.push({
        id: `busy-customer-${c.code}-${c.name}`,
        type: 'customer',
        title: c.name,
        subtitle: join(['Busy', c.fyRevenue ? `FY ${fmtINR(c.fyRevenue)}` : '', c.outstanding > 0 ? `owes ${fmtINR(c.outstanding)}` : '']),
        route: `${BUSY_CUSTOMER_ROUTE}?q=${encodeURIComponent(c.name)}`,
      });
      if (out.length >= 6) break;
    }
    const suppliers = new Map<string, { total: number; count: number; last: string; companies: Set<string> }>();
    for (const p of (Array.isArray(purchases) ? purchases : [])) {
      const name = String(p.supplier || '');
      if (!name || !name.toLowerCase().includes(needle)) continue;
      const hit = suppliers.get(name) ?? { total: 0, count: 0, last: '', companies: new Set<string>() };
      hit.total += Number(p.amount) || 0;
      hit.count += 1;
      if (String(p.date) > hit.last) hit.last = String(p.date);
      if (p.company) hit.companies.add(p.company);
      suppliers.set(name, hit);
    }
    for (const [name, s] of [...suppliers.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 6)) {
      out.push({
        id: `busy-supplier-${name}`,
        type: 'supplier',
        title: name,
        subtitle: join(['Busy', `${s.count} recent invoice${s.count === 1 ? '' : 's'}`, fmtINR(s.total), s.last ? `last ${s.last}` : '']),
        route: `${BUSY_SUPPLIER_ROUTE}?busy=${encodeURIComponent(name)}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const NOTE_ENTITY: Record<string, { route: string; link: (id: string) => string }> = {
  maintenance_ticket: { route: TICKET_ROUTE, link: (id) => `${TICKET_ROUTE}?ticket=${id}` },
  anomaly: { route: '/dashboard/anomaly-center', link: () => '/dashboard/anomaly-center' },
  active_batch: { route: '/dashboard/predictive-qc', link: () => '/dashboard/predictive-qc' },
};

async function searchNotes(q: string, canAccess: (route: string) => boolean): Promise<SearchResult[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qb: any = (supabase as any).from('entity_notes');
    const { data, error } = await qb
      .select('id, body, author_name, entity_type, entity_id, created_at')
      .or(`body.ilike.%${q}%,author_name.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(8);
    if (error || !Array.isArray(data)) return [];
    const out: SearchResult[] = [];
    for (const row of data as Record<string, unknown>[]) {
      const cfg = NOTE_ENTITY[str(row.entity_type)];
      if (!cfg || !canAccess(cfg.route)) continue;
      out.push({
        id: str(row.id),
        type: 'note',
        title: clip(str(row.body)),
        subtitle: join([row.author_name ? `— ${str(row.author_name)}` : '']),
        route: cfg.link(str(row.entity_id)),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function sanitize(q: string): string {
  return q.replace(/[%,()*\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function ticketIdMatches(id: string, q: string): boolean {
  const raw = q.trim().toLowerCase();
  if (raw.length < 2) return false;
  const compactQ = raw.replace(/-/g, '');
  const compactId = id.toLowerCase().replace(/-/g, '');
  return compactId.startsWith(compactQ) || id.toLowerCase().startsWith(raw);
}

function looksLikeIdFrag(q: string): boolean {
  return /^[0-9a-f-]{2,36}$/i.test(q.trim());
}

function mapCfg(type: SearchType): EntityConfig | undefined {
  return ENTITIES.find((e) => e.type === type);
}

async function rpcRows(fn: Parameters<typeof callRpc>[0], q: string): Promise<Record<string, unknown>[] | null> {
  const res = await callRpc<Record<string, unknown>[]>(fn, { p_q: q });
  if (res.error || !Array.isArray(res.data)) return null;
  return res.data;
}

async function fallbackTextAndId(
  cfg: EntityConfig,
  q: string,
): Promise<SearchResult[]> {
  try {
    const textOr = cfg.columns.map((c) => `${c}.ilike.%${q}%`).join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: textData, error: textErr } = await (supabase as any)
      .from(cfg.table)
      .select(cfg.select)
      .or(textOr)
      .limit(6);
    const textHits = (!textErr && Array.isArray(textData) ? textData : []) as Record<string, unknown>[];

    let idHits: Record<string, unknown>[] = [];
    if (looksLikeIdFrag(q)) {
      const { data: recent } = await fetchAllRows<Record<string, unknown>>((from, to) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from(cfg.table)
          .select(cfg.select)
          .order('created_at', { ascending: false })
          .range(from, to),
      );
      idHits = recent.filter((r) => ticketIdMatches(str(r.id), q));
    }

    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const row of [...idHits, ...textHits]) {
      const id = str(row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ type: cfg.type, ...cfg.map(row) });
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function searchTickets(q: string): Promise<SearchResult[]> {
  const cfg = mapCfg('ticket');
  if (!cfg) return [];
  const rows = await rpcRows('search_maintenance_tickets', q);
  if (rows) return rows.map((row) => ({ type: 'ticket' as const, ...cfg.map(row) }));
  return fallbackTextAndId(cfg, q);
}

async function searchSchedules(q: string): Promise<SearchResult[]> {
  const cfg = mapCfg('schedule');
  if (!cfg) return [];
  const rows = await rpcRows('search_maintenance_schedules', q);
  if (rows) return rows.map((row) => ({ type: 'schedule' as const, ...cfg.map(row) }));
  return fallbackTextAndId(cfg, q);
}

async function searchStoreReqs(q: string): Promise<SearchResult[]> {
  const cfg = mapCfg('storereq');
  if (!cfg) return [];
  const rows = await rpcRows('search_store_requisitions', q);
  if (rows) return rows.map((row) => ({ type: 'storereq' as const, ...cfg.map(row) }));
  return fallbackTextAndId(cfg, q);
}

async function searchPlants(q: string): Promise<SearchResult[]> {
  const cfg = mapCfg('plant');
  if (!cfg) return [];
  const ql = q.toLowerCase();
  const matches = (p: Record<string, unknown>) => {
    const aliases = Array.isArray(p.legacy_names) ? p.legacy_names.map(str) : [];
    const shown = displayLocationName(str(p.name));
    return [shown, str(p.name), str(p.factory_code), str(p.entity_name), str(p.company_name), ...aliases]
      .some((x) => x.toLowerCase().includes(ql));
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).from('plants').select(cfg.select).limit(80);
    if (!error && Array.isArray(data)) {
      return (data as Record<string, unknown>[]).filter(matches).slice(0, 8)
        .map((row) => ({ type: 'plant' as const, ...cfg.map(row) }));
    }
  } catch { /* the RPC below still answers a plain name search */ }
  const rows = await rpcRows('search_plants', q);
  if (rows) return rows.map((row) => ({ type: 'plant' as const, ...cfg.map(row) }));
  return [];
}

export async function searchEntities(
  query: string,
  canAccess: (route: string) => boolean,
): Promise<SearchResult[]> {
  const q = sanitize(query);
  if (q.length < 2) return [];

  const targets = ENTITIES.filter((e) => !e.skipGeneric && canAccess(e.route));
  const orFilter = (cols: string[]) => cols.map((c) => `${c}.ilike.%${q}%`).join(',');

  const [settled, notes, tickets, schedules, storeReqs, plants, busy] = await Promise.all([
    Promise.all(
      targets.map(async (e) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const qb: any = (supabase as any).from(e.table);
          let queryb = qb.select(e.select).or(orFilter(e.columns)).limit(6);
          if (e.order) queryb = queryb.order(e.order.column, { ascending: e.order.ascending !== false });
          const { data, error } = await queryb;
          if (error || !Array.isArray(data)) return [] as SearchResult[];
          return (data as Record<string, unknown>[]).map((row) => ({ type: e.type, ...e.map(row) }) as SearchResult);
        } catch {
          return [] as SearchResult[];
        }
      }),
    ),
    searchNotes(q, canAccess),
    canAccess(TICKET_ROUTE) ? searchTickets(q) : Promise.resolve([] as SearchResult[]),
    canAccess(TICKET_ROUTE) ? searchSchedules(q) : Promise.resolve([] as SearchResult[]),
    canAccess(STORE_ROUTE) ? searchStoreReqs(q) : Promise.resolve([] as SearchResult[]),
    canAccess(FAR_ROUTE) || canAccess(TICKET_ROUTE) ? searchPlants(q) : Promise.resolve([] as SearchResult[]),
    searchBusy(q, canAccess),
  ]);

  return [...tickets, ...schedules, ...plants, ...storeReqs, ...settled.flat(), ...busy, ...notes];
}
