/**
 * To-Do / Personal Work Queue — the section registry.
 *
 * The To-Do page is a LIVE, READ-ONLY aggregation: it derives "what is pending on
 * me" on the fly from each module's existing status / assignee columns. Nothing is
 * written, so an item auto-disappears the moment the underlying record advances.
 * Because the source tables ARE the truth, acting on a ticket in the Maintenance
 * page is reflected here immediately (realtime + refresh-on-open).
 *
 * Presentation model: each section renders as a compact TABLE. A section declares
 * `columns` (Ticket #, Asset, Opened, Status, …) and every item supplies `cells`
 * keyed by column — so each fact sits in its own column and the status appears
 * exactly once (never duplicated as both a label and a badge). A cell is plain
 * text or a coloured `{ badge }` chip.
 *
 * Ownership is resolved through existing primitives (role slugs + plant scope +
 * the notifications feed). To add a workflow, append one descriptor here.
 */
import { supabase } from '../supabase';
import { STATUS_CFG, daysFromNow, dueDateLabel, formatDate } from '../../routes/dashboard/purchase/maintenance/shared';
import type { AppNotification } from '../../contexts/NotificationsContext';

export type TodoTone = 'red' | 'amber' | 'blue' | 'green' | 'purple' | 'slate';

const ROW_CAP = 500;

/** A table cell — plain text (or number), a coloured chip, or empty. */
export type TodoCell = string | number | { badge: { text: string; tone: TodoTone } } | null | undefined;

/** A table column. `align:'right'` for the trailing status/badge column. */
export interface TodoColumn {
  key: string;
  /** i18n key under `todo.col.*`. */
  labelKey: string;
  align?: 'right';
  /** The wide name column that should absorb remaining width + truncate. */
  grow?: boolean;
}

/** One row in a section's table. */
export interface TodoItem {
  /** Unique within its section. */
  id: string;
  /** Deep-link into the owning module. */
  route: string;
  /** Primary name (used for A–Z sort). */
  title: string;
  /** Column values keyed by TodoColumn.key. */
  cells: Record<string, TodoCell>;
  /** Primary timestamp for date sorting (ISO) — never displayed directly. */
  sortDate?: string;
  /** Lowercased haystack for free-text search — never displayed. */
  search?: string;
}

export interface TodoCtx {
  personName: string;
  accountId: string | null;
  roleSlugs: Set<string>;
  scopeQuery: <T>(q: T, opts?: { plantCol?: string; unitCol?: string }) => T;
  plantName: (plantId: string | null | undefined) => string;
  notifications: AppNotification[];
  /** True when the workflow a notification points at is already closed — such
   *  rows are history, not pending work, so To-Do must drop them. */
  isNotificationCompleted?: (n: AppNotification) => boolean;
}

export interface TodoSectionDef {
  key: string;
  titleKey: string;
  icon: string;
  tone: TodoTone;
  columns: TodoColumn[];
  appliesTo: (ctx: TodoCtx) => boolean;
  fetch: (ctx: TodoCtx) => Promise<TodoItem[]>;
}

export interface TodoSectionResult {
  key: string;
  titleKey: string;
  icon: string;
  tone: TodoTone;
  columns: TodoColumn[];
  items: TodoItem[];
}

// ── helpers ───────────────────────────────────────────────────────────────────

const MAINT = '/dashboard/purchase/maint';
const ticketRoute = (id: string) => `${MAINT}?ticket=${id}`;
/** Human ticket reference from a uuid (the Maintenance modal shows the same). */
const shortId = (id: string) => `#${id.slice(0, 8)}`;

function hasRole(ctx: TodoCtx, ...slugs: string[]): boolean {
  if (ctx.roleSlugs.has('*')) return true;
  return slugs.some((s) => ctx.roleSlugs.has(s));
}

const statusLabel = (status: string): string => STATUS_CFG[status]?.label ?? status;

/** Compact "how long ago": "just now" / "5m" / "3h" / "4d" / "2w". */
function agoLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

const dateCell = (iso: string | null | undefined): string => (iso ? formatDate(iso) : '—');
const ageCell = (iso: string | null | undefined): string => { const a = agoLabel(iso); return a ? `${a} ago` : '—'; };

// ── shared column sets ──────────────────────────────────────────────────────────

/** Ticket # · Asset · Raised · Age · <trailing status/action badge>. */
const TICKET_COLS = (trailingLabel: string): TodoColumn[] => [
  { key: 'ticket', labelKey: 'todo.col.ticket' },
  { key: 'asset', labelKey: 'todo.col.asset', grow: true },
  { key: 'raised', labelKey: 'todo.col.raised' },
  { key: 'age', labelKey: 'todo.col.age' },
  { key: 'status', labelKey: trailingLabel, align: 'right' },
];

const TICKET_SELECT = 'id,title,equipment,status,type,due_date,created_at,description,assigned_to,raised_by,plant_id';

type TicketRow = {
  id: string; title: string | null; equipment: string | null; status: string;
  type: string | null; due_date: string | null; created_at: string | null;
  description: string | null; assigned_to: string | null; raised_by: string | null; plant_id: string | null;
};

const ticketName = (t: TicketRow) => t.equipment || t.title || 'Maintenance ticket';

/** Standard ticket row (ticket / asset / raised / age / trailing badge). */
function ticketItem(
  ctx: TodoCtx,
  t: TicketRow,
  opts: { idPrefix?: string; badge: { text: string; tone: TodoTone }; extraCells?: Record<string, TodoCell>; sortDate?: string | null },
): TodoItem {
  const name = ticketName(t);
  const plant = ctx.plantName(t.plant_id);
  return {
    id: `${opts.idPrefix ?? ''}${t.id}`,
    route: ticketRoute(t.id),
    title: name,
    sortDate: opts.sortDate ?? t.created_at ?? undefined,
    cells: {
      ticket: shortId(t.id),
      asset: name,
      raised: dateCell(t.created_at),
      age: ageCell(t.created_at),
      status: { badge: opts.badge },
      ...opts.extraCells,
    },
    search: [
      shortId(t.id), t.equipment, t.title, t.description, t.assigned_to, t.raised_by,
      statusLabel(t.status), opts.badge.text, plant,
    ].filter(Boolean).join(' ').toLowerCase(),
  };
}

/** Urgent-alerts rows come from the in-memory notifications feed (no query), so
 *  this is exported for TodoContext to reuse — keeping the shape in one place.
 *  Notifications whose linked workflow is already closed are excluded: the feed
 *  itself is an immutable audit trail, but To-Do only lists actionable work. */
export function buildUrgentItems(
  notifications: AppNotification[],
  isCompleted: (n: AppNotification) => boolean = () => false,
): TodoItem[] {
  const isUrgent = (n: AppNotification) => n.type === 'urgent' || n.type === 'critical';
  return notifications.filter((n) => isUrgent(n) && !isCompleted(n)).slice(0, ROW_CAP).map((n) => ({
    id: n.id,
    route: n.route || '/dashboard',
    title: n.title,
    sortDate: n.created_at,
    cells: {
      alert: n.title,
      raised: ageCell(n.created_at),
      by: n.actor_name || '—',
      status: { badge: { text: n.type === 'critical' ? 'Critical' : 'Urgent', tone: 'red' as TodoTone } },
    },
    search: [n.title, n.body, n.actor_name].filter(Boolean).join(' ').toLowerCase(),
  }));
}

// ── section registry (display order = priority: my-action first, then FYI) ──────

export const TODO_SECTIONS: TodoSectionDef[] = [
  // ── Approvals awaiting a Unit Head ────────────────────────────────────────
  {
    key: 'approvals',
    titleKey: 'todo.section.approvals',
    icon: '✅',
    tone: 'purple',
    columns: [
      { key: 'ticket', labelKey: 'todo.col.ref' },
      { key: 'asset', labelKey: 'todo.col.item', grow: true },
      { key: 'raised', labelKey: 'todo.col.raised' },
      { key: 'by', labelKey: 'todo.col.by' },
      { key: 'status', labelKey: 'todo.col.action', align: 'right' },
    ],
    appliesTo: (ctx) => hasRole(ctx, 'unit_head'),
    fetch: async (ctx) => {
      const tickets = ctx.scopeQuery(
        supabase.from('maintenance_tickets').select(TICKET_SELECT).in('status', ['pending_unit_head', 'pending_purchase', 'pending_defective_return']),
        { unitCol: 'unit_id' },
      ).order('created_at', { ascending: true }).limit(ROW_CAP).returns<TicketRow[]>();

      const reqs = ctx.scopeQuery(
        supabase.from('store_requisitions').select('id,item,qty,urgency,status,remarks,created_at,plant_id').eq('status', 'pending'),
        { unitCol: 'unit_id' },
      ).order('created_at', { ascending: true }).limit(ROW_CAP).returns<
        { id: string; item: string; qty: number | null; urgency: string | null; remarks: string | null; created_at: string | null; plant_id: string | null }[]
      >();

      const [{ data: tk }, { data: rq }] = await Promise.all([tickets, reqs]);
      const items: TodoItem[] = [];
      const me = (ctx.personName || '').trim().toLowerCase();
      for (const t of tk ?? []) {
        if (t.status === 'pending_defective_return') {
          if ((t.assigned_to || '').trim().toLowerCase() !== me) continue;
          items.push(ticketItem(ctx, t, {
            idPrefix: 'mt_',
            badge: { text: 'Scrap or repairable', tone: 'amber' },
            extraCells: { by: t.raised_by || '—' },
          }));
          continue;
        }
        items.push(ticketItem(ctx, t, {
          idPrefix: 'mt_',
          badge: { text: 'Approve', tone: 'purple' },
          extraCells: { by: t.raised_by || '—' },
        }));
      }
      for (const r of rq ?? []) {
        const urgent = r.urgency === 'urgent' || r.urgency === 'high';
        const plant = ctx.plantName(r.plant_id);
        items.push({
          id: `sr_${r.id}`,
          route: '/dashboard/purchase/storereq',
          title: r.item,
          sortDate: r.created_at ?? undefined,
          cells: {
            ticket: 'Req',
            asset: `${r.item}${r.qty ? ` · qty ${r.qty}` : ''}`,
            raised: dateCell(r.created_at),
            by: '—',
            status: { badge: { text: urgent ? 'Urgent' : 'Approve', tone: urgent ? 'red' : 'amber' } },
          },
          search: [r.item, r.remarks, r.urgency, plant, 'store requisition'].filter(Boolean).join(' ').toLowerCase(),
        });
      }
      return items;
    },
  },

  // ── Purchase Manager: bill upload & dispatch ──────────────────────────────
  {
    key: 'purchase-bill',
    titleKey: 'todo.section.purchaseBill',
    icon: '🧾',
    tone: 'purple',
    columns: TICKET_COLS('todo.col.action'),
    appliesTo: (ctx) => hasRole(ctx, 'purchase_manager'),
    fetch: async (ctx) => {
      const { data } = await ctx.scopeQuery(
        supabase.from('maintenance_tickets').select(TICKET_SELECT).eq('status', 'pending_purchase_manager'),
        { unitCol: 'unit_id' },
      ).order('created_at', { ascending: true }).limit(ROW_CAP).returns<TicketRow[]>();
      return (data ?? []).map((t) => ticketItem(ctx, t, { badge: { text: 'Bill & dispatch', tone: 'purple' } }));
    },
  },

  // ── Store Manager: store check + physical handover ────────────────────────
  {
    key: 'store-checks',
    titleKey: 'todo.section.storeChecks',
    icon: '📦',
    tone: 'amber',
    columns: TICKET_COLS('todo.col.stage'),
    appliesTo: (ctx) =>
      hasRole(ctx, 'store_manager_maint', 'warehouse_manager'),
    fetch: async (ctx) => {
      const { data } = await ctx.scopeQuery(
        supabase.from('maintenance_tickets').select(TICKET_SELECT).in('status', ['pending_store', 'pending_handover', 'pending_defective_return']),
        { unitCol: 'unit_id' },
      ).order('created_at', { ascending: true }).limit(ROW_CAP).returns<TicketRow[]>();
      const me = (ctx.personName || '').trim().toLowerCase();
      return (data ?? []).filter((t) => t.status !== 'pending_defective_return' || (t.assigned_to || '').trim().toLowerCase() === me).map((t) => ticketItem(ctx, t, {
        badge: { text: t.status === 'pending_defective_return' ? 'Accept item' : t.status === 'pending_handover' ? 'Handover' : 'Store check', tone: 'amber' },
      }));
    },
  },

  // ── Technician: my open EMERGENCY tickets (periodic lives separately) ──────
  {
    key: 'my-tickets',
    titleKey: 'todo.section.myTickets',
    icon: '🔧',
    tone: 'blue',
    columns: TICKET_COLS('todo.col.status'),
    appliesTo: (ctx) => hasRole(ctx, 'technician_shd', 'factory_operator', 'cap:perform_maintenance'),
    fetch: async (ctx) => {
      if (!ctx.personName) return [];
      const { data } = await ctx.scopeQuery(
        supabase.from('maintenance_tickets').select(TICKET_SELECT)
          .eq('type', 'emergency').eq('assigned_to', ctx.personName)
          .in('status', ['open', 'in_progress', 'pending_defective_return']),
        { unitCol: 'unit_id' },
      ).order('created_at', { ascending: true }).limit(ROW_CAP).returns<TicketRow[]>();
      return (data ?? []).map((t) =>
        ticketItem(ctx, t, { badge: { text: statusLabel(t.status), tone: 'blue' } }));
    },
  },

  // ── Changes requested back to whoever raised the ticket ───────────────────
  {
    key: 'changes-requested',
    titleKey: 'todo.section.changesRequested',
    icon: '↩️',
    tone: 'red',
    columns: TICKET_COLS('todo.col.status'),
    appliesTo: () => true,
    fetch: async (ctx) => {
      if (!ctx.personName) return [];
      const { data } = await ctx.scopeQuery(
        supabase.from('maintenance_tickets').select(TICKET_SELECT)
          .eq('raised_by', ctx.personName).eq('status', 'changes_requested'),
        { unitCol: 'unit_id' },
      ).order('created_at', { ascending: true }).limit(ROW_CAP).returns<TicketRow[]>();
      return (data ?? []).map((t) =>
        ticketItem(ctx, t, { badge: { text: 'Action needed', tone: 'red' } }));
    },
  },

  // ── Preventive (scheduled) maintenance due to me ──────────────────────────
  {
    key: 'pm-due',
    titleKey: 'todo.section.pmDue',
    icon: '🗓️',
    tone: 'amber',
    columns: [
      { key: 'ticket', labelKey: 'todo.col.ticket' },
      { key: 'asset', labelKey: 'todo.col.asset', grow: true },
      { key: 'scheduled', labelKey: 'todo.col.scheduled' },
      { key: 'due', labelKey: 'todo.col.due' },
      { key: 'status', labelKey: 'todo.col.overdue', align: 'right' },
    ],
    appliesTo: (ctx) => hasRole(ctx, 'technician_shd', 'factory_operator', 'cap:perform_maintenance'),
    fetch: async (ctx) => {
      if (!ctx.personName) return [];
      const { data } = await ctx.scopeQuery(
        supabase.from('maintenance_tickets').select(TICKET_SELECT)
          .eq('type', 'periodic').eq('assigned_to', ctx.personName).eq('status', 'open'),
        { unitCol: 'unit_id' },
      ).order('due_date', { ascending: true }).limit(ROW_CAP).returns<TicketRow[]>();
      return (data ?? []).map((t) => {
        const days = daysFromNow(t.due_date);
        const due = dueDateLabel(days);
        const overdue = days !== null && days < 0;
        return ticketItem(ctx, t, {
          sortDate: t.due_date ?? t.created_at,
          badge: { text: due.text, tone: overdue ? 'red' : days === 0 ? 'amber' : 'green' },
          extraCells: { scheduled: dateCell(t.created_at), due: dateCell(t.due_date) },
        });
      });
    },
  },

  // ── Night duty scheduled onto me ──────────────────────────────────────────
  {
    key: 'night-duty',
    titleKey: 'todo.section.nightDuty',
    icon: '🌙',
    tone: 'blue',
    columns: [
      { key: 'date', labelKey: 'todo.col.date', grow: true },
      { key: 'plant', labelKey: 'todo.col.plant' },
      { key: 'status', labelKey: 'todo.col.when', align: 'right' },
    ],
    appliesTo: (ctx) => !!ctx.accountId,
    fetch: async (ctx) => {
      if (!ctx.accountId) return [];
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const { data } = await supabase.from('night_duty').select('id,duty_date,status,plant_id')
        .eq('technician_id', ctx.accountId).eq('status', 'scheduled').gte('duty_date', todayIso)
        .order('duty_date', { ascending: true }).limit(ROW_CAP)
        .returns<{ id: string; duty_date: string; status: string; plant_id: string | null }[]>();
      return (data ?? []).map((d) => {
        const isTonight = d.duty_date === todayIso;
        const days = daysFromNow(d.duty_date);
        const dateLabel = new Date(d.duty_date + 'T00:00:00').toLocaleDateString('en-IN', {
          weekday: 'long', day: '2-digit', month: 'short', year: 'numeric',
        });
        const plant = ctx.plantName(d.plant_id);
        const when = isTonight ? 'Tonight' : days === 1 ? 'Tomorrow' : days != null ? `In ${days} days` : 'Scheduled';
        return {
          id: d.id,
          route: '/dashboard/night-manager',
          title: dateLabel,
          sortDate: d.duty_date,
          cells: {
            date: dateLabel,
            plant: plant || '—',
            status: { badge: { text: when, tone: (isTonight ? 'red' : 'blue') as TodoTone } },
          },
          search: `night duty ${dateLabel} ${plant} ${when}`.toLowerCase(),
        };
      });
    },
  },

  // ── Anomaly flags assigned to me ──────────────────────────────────────────
  {
    key: 'anomalies',
    titleKey: 'todo.section.anomalies',
    icon: '⚠️',
    tone: 'amber',
    columns: [
      { key: 'alert', labelKey: 'todo.col.anomaly', grow: true },
      { key: 'plant', labelKey: 'todo.col.plant' },
      { key: 'flagged', labelKey: 'todo.col.flagged' },
      { key: 'status', labelKey: 'todo.col.severity', align: 'right' },
    ],
    appliesTo: () => true,
    fetch: async (ctx) => {
      if (!ctx.personName) return [];
      const { data } = await supabase.from('anomaly_flags').select('id,title,route,severity,status,plant,created_at')
        .eq('assigned_to', ctx.personName).in('status', ['open', 'acknowledged'])
        .order('created_at', { ascending: false }).limit(ROW_CAP)
        .returns<{ id: string; title: string; route: string | null; severity: string; status: string; plant: string | null; created_at: string | null }[]>();
      return (data ?? []).map((a) => ({
        id: a.id,
        route: a.route || '/dashboard/anomaly-center',
        title: a.title,
        sortDate: a.created_at ?? undefined,
        cells: {
          alert: a.title,
          plant: a.plant || '—',
          flagged: dateCell(a.created_at),
          status: {
            badge: {
              text: a.severity === 'critical' ? 'Critical' : a.severity === 'warning' ? 'Warning' : 'Watch',
              tone: (a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'amber' : 'slate') as TodoTone,
            },
          },
        },
        search: [a.title, a.severity, a.status, a.plant, 'anomaly'].filter(Boolean).join(' ').toLowerCase(),
      }));
    },
  },

  // ── Urgent alerts (blacklist matches etc.) — from the notifications feed ──
  {
    key: 'urgent-alerts',
    titleKey: 'todo.section.urgentAlerts',
    icon: '🚨',
    tone: 'red',
    columns: [
      { key: 'alert', labelKey: 'todo.col.alert', grow: true },
      { key: 'raised', labelKey: 'todo.col.raised' },
      { key: 'by', labelKey: 'todo.col.by' },
      { key: 'status', labelKey: 'todo.col.severity', align: 'right' },
    ],
    appliesTo: (ctx) => hasRole(ctx, 'admin', 'unit_head'),
    fetch: async (ctx) => buildUrgentItems(ctx.notifications, ctx.isNotificationCompleted),
  },

  // ── Updates on requests I raised (now in someone else's court) ────────────
  {
    key: 'my-requests',
    titleKey: 'todo.section.myRequests',
    icon: '📨',
    tone: 'slate',
    columns: TICKET_COLS('todo.col.status'),
    appliesTo: () => true,
    fetch: async (ctx) => {
      if (!ctx.personName) return [];
      const { data } = await ctx.scopeQuery(
        supabase.from('maintenance_tickets').select(TICKET_SELECT).eq('raised_by', ctx.personName)
          .in('status', ['pending_store', 'pending_unit_head', 'pending_purchase', 'pending_purchase_manager', 'pending_handover']),
        { unitCol: 'unit_id' },
      ).order('created_at', { ascending: false }).limit(ROW_CAP).returns<TicketRow[]>();
      return (data ?? []).map((t) =>
        ticketItem(ctx, t, { badge: { text: statusLabel(t.status), tone: 'slate' } }));
    },
  },
];
