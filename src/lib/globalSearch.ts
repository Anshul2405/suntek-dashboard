/**
 * Global quick-search (Cmd+K palette) data layer.
 *
 * Searches across the app's records — tickets, people, customers, store
 * requisitions, assets, blacklist, batches, purchase contracts — by matching
 * the query against each table's key text columns (case-insensitive `ilike`).
 *
 * Access-aware: an entity is only searched if the active profile can reach its
 * page (so a technician never sees admin-only records). Every table query is
 * wrapped so a missing table / RLS denial yields no results instead of throwing.
 */
import { supabase } from './supabase';

export type SearchType =
  | 'ticket' | 'note' | 'user' | 'customer' | 'storereq' | 'asset' | 'blacklist' | 'batch' | 'po';

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
  /** Columns matched with ilike. */
  columns: string[];
  /** Page route — also the access gate. */
  route: string;
  /** i18n key for this group's heading. */
  groupKey: string;
  map: (row: Record<string, unknown>) => Omit<SearchResult, 'type'>;
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const join = (parts: unknown[]): string | undefined => {
  const s = parts.map(str).filter(Boolean).join(' · ');
  return s || undefined;
};
const clip = (s: string, n = 90): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const ENTITIES: EntityConfig[] = [
  {
    type: 'ticket',
    table: 'maintenance_tickets',
    select: 'id, title, equipment, description, raised_by, assigned_to, status',
    columns: ['id', 'title', 'equipment', 'description', 'raised_by', 'assigned_to'],
    route: '/dashboard/purchase/maint',
    groupKey: 'palette.groupTickets',
    map: (r) => ({
      id: str(r.id),
      title: str(r.equipment) || str(r.title) || 'Ticket',
      subtitle: clip(join([r.status, r.description]) ?? ''),
      // Maintenance tickets have a real record-level deep-link.
      route: `/dashboard/purchase/maint?ticket=${str(r.id)}`,
    }),
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
      subtitle: join([r.role_label, r.plant_name, r.email]),
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
    type: 'storereq',
    table: 'store_requisitions',
    select: 'id, item, raised_by, status',
    columns: ['item', 'raised_by', 'approved_by', 'remarks'],
    route: '/dashboard/purchase/storereq',
    groupKey: 'palette.groupStoreReq',
    map: (r) => ({ id: str(r.id), title: str(r.item) || 'Requisition', subtitle: join([r.status, r.raised_by]), route: '/dashboard/purchase/storereq' }),
  },
  {
    type: 'asset',
    table: 'fixed_assets',
    select: 'id, name, model, identification_mark, account_head, job_no',
    columns: ['name', 'identification_mark', 'model', 'capacity', 'invoice_no', 'account_head', 'job_no'],
    route: '/dashboard/purchase/far',
    groupKey: 'palette.groupAssets',
    map: (r) => ({ id: str(r.id), title: str(r.name) || 'Asset', subtitle: join([r.job_no, r.model, r.identification_mark, r.account_head]), route: '/dashboard/purchase/far' }),
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
    select: 'id, oil_type, company, status',
    columns: ['oil_type', 'company', 'paraffin_type', 'port'],
    route: '/dashboard/purchase/purchase',
    groupKey: 'palette.groupPurchase',
    map: (r) => ({ id: str(r.id), title: join([r.oil_type, r.company]) ?? 'Purchase order', subtitle: join([r.status]), route: '/dashboard/purchase/purchase' }),
  },
];

/** i18n group key per result type (for headings in the palette). */
export const GROUP_KEY: Record<SearchType, string> = {
  ...Object.fromEntries(ENTITIES.map((e) => [e.type, e.groupKey])),
  note: 'palette.groupNotes',
} as Record<SearchType, string>;

/**
 * Maps an entity_notes row's entity_type to the page that owns it. The note
 * deep-links to that record (so searching a comment opens the workflow it's on)
 * and is access-gated by that route. Unknown entity types are skipped.
 */
const NOTE_ENTITY: Record<string, { route: string; link: (id: string) => string }> = {
  maintenance_ticket: { route: '/dashboard/purchase/maint', link: (id) => `/dashboard/purchase/maint?ticket=${id}` },
  anomaly: { route: '/dashboard/anomaly-center', link: () => '/dashboard/anomaly-center' },
  active_batch: { route: '/dashboard/predictive-qc', link: () => '/dashboard/predictive-qc' },
};

/**
 * Search the free-text comments/notes people leave on records (entity_notes).
 * Lets someone find a workflow by a fragment of a comment they remember
 * ("Sahil will need to look…") and jump straight to its ticket.
 */
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

/** Strip characters that would break the PostgREST `or(...)` filter syntax. */
function sanitize(q: string): string {
  return q.replace(/[%,()*\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Search every entity the active profile can access. Each entity is capped to a
 * handful of hits; the palette groups the flat list by `type`.
 */
export async function searchEntities(
  query: string,
  canAccess: (route: string) => boolean,
): Promise<SearchResult[]> {
  const q = sanitize(query);
  if (q.length < 2) return [];

  const targets = ENTITIES.filter((e) => canAccess(e.route));
  const orFilter = (cols: string[]) => cols.map((c) => `${c}.ilike.%${q}%`).join(',');

  const [settled, notes] = await Promise.all([
    Promise.all(
      targets.map(async (e) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const qb: any = (supabase as any).from(e.table);
          const { data, error } = await qb.select(e.select).or(orFilter(e.columns)).limit(6);
          if (error || !Array.isArray(data)) return [] as SearchResult[];
          return (data as Record<string, unknown>[]).map((row) => ({ type: e.type, ...e.map(row) }) as SearchResult);
        } catch {
          return [] as SearchResult[];
        }
      }),
    ),
    searchNotes(q, canAccess),
  ]);

  return [...settled.flat(), ...notes];
}
