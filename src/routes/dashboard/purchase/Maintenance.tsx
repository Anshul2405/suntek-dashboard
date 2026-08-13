import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { fetchActivePlants } from '../../../lib/plants';
import { freeQty } from '../../../lib/store/registers';
import { insertRows, updateRows } from '../../../lib/db';
import { resizeImageToDataUrl, extractSupplierBill, type SupplierBillLine } from '../../../lib/nvidiaOcr';
import { useRoleContext } from '../../../contexts/RoleContext';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { withEmbedFallback } from '../../../lib/scopedList';
import { fetchAllRows } from '../../../lib/fetchAll';
import type { RoleRow } from '../../../lib/profiles';
import { useBlacklist } from '../../../contexts/BlacklistContext';
import { uploadMaintenancePhoto } from '../../../lib/cloudinary';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, PanelFooter } from '../../../components/SlidePanel';
import { MentionText, NotesButton, ReadReceipt } from '../../../components/mentions';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, ErrorState } from '../../../components/ui/states';
import { ImageLightbox, type LightboxImage } from '../../../components/ui/ImageLightbox';
import { useTranslation } from 'react-i18next';
import { useDirectory, useMentionNotifier, notifyWatchers, postNote, extractMentionIds, getNotes, getReceipts, seenProfileIds, tickState } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { similarity } from '../../../lib/blacklist/similarity';
import { PMScheduleImport } from './PMScheduleImport';
import { suggestAssets } from '../../../lib/far/assets';
import { exportToCsv, type CsvColumn } from '../../../lib/utils/exportCsv';
import type { AppNotification } from '../../../contexts/NotificationsContext';
import { callRpc } from '../../../lib/db';
import {
  validateSplit, isSplitValid, splitTotals, unaccounted, defaultReplacedQty, cleanPartName,
  type DefectiveSplitLine,
} from '../../../lib/store/defectiveSplit';
import type { Database } from '../../../lib/database.types';
import {
  FREQ_OPTIONS, FREQ_LABEL, STATUS_CFG, STAGE_LABELS, STAGE_LABEL_KEYS, INHOUSE_STAGE_LABEL_KEYS,
  statusBadge, formatDate, daysFromNow, dueDateLabel, calculateNextDue,
  PhotoUploader, StageStrip, EMERGENCY_STAGES, INHOUSE_STAGES, INHOUSE_STAGE_LABELS, AVAILABLE_STAGES,
} from './maintenance/shared';
import { usePagination } from '../../../components/ui/usePagination';
import { useSortable } from '../../../components/ui/useSortable';
import { SegmentTabs, StatCard, SectionCard, FilterBar, FilterSelect, ButtonV2, TablePaginationV2, ThV2 as Th } from '../../../components/v2';
import { Calendar, CalendarDays, AlertTriangle, CheckCircle2, Hourglass, ShoppingCart, Settings, Building2, Activity, Plus, Upload, FileText, Trash2 } from 'lucide-react';

type EntityNoteRow = Database['public']['Tables']['entity_notes']['Row'];

// ── Store-inventory type-ahead ───────────────────────────────────────────────
type StoreStockItem = {
  id: string; item_name: string; on_hand: number; unit: string | null;
  /** Claimed by approved-but-not-handed-over requests. Free = on_hand - reserved_qty.
   *  Absent before migration 59. */
  reserved_qty?: number | null;
};


// Measurement units a requested part can be recorded in (count / weight / volume).
const STORE_UNITS = ['Units', 'mg', 'g', 'kg', 'mL', 'L'];

/** Rank the plant's stock items against what the technician is typing. */
function suggestParts(query: string, stock: StoreStockItem[]): StoreStockItem[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return stock
    .map(s => ({ s, score: s.item_name.toLowerCase().includes(q) ? 1 : similarity(q, s.item_name) }))
    .filter(x => x.score > 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(x => x.s);
}

type FarAssetLite = { id: string; name: string; identification_mark: string | null; plant_id: string | null };

/** Equipment field backed by the FAR — pick a registered asset (links it) or type
 *  free text (allowed, flagged as not-in-FAR). */
function FarEquipField({ value, assets, onChange, onPick }: {
  value: string;
  assets: FarAssetLite[];
  onChange: (v: string) => void;
  onPick: (asset: FarAssetLite | null) => void;
}) {
  const { t } = useTranslation();
  const [focus, setFocus] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const suggestions = React.useMemo(() => suggestAssets(value, assets), [value, assets]);
  React.useEffect(() => { setActive(0); }, [value]);
  const choose = (a: FarAssetLite) => { onChange(`${a.name}${a.identification_mark ? ` (${a.identification_mark})` : ''}`); onPick(a); setFocus(false); };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!focus || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && active < suggestions.length) { e.preventDefault(); choose(suggestions[active].asset); }
    else if (e.key === 'Escape') { setFocus(false); }
  };
  return (
    <div style={{ position: 'relative' }}>
      <input value={value}
        onChange={e => { onChange(e.target.value); onPick(null); }}
        onFocus={() => setFocus(true)}
        onBlur={() => window.setTimeout(() => setFocus(false), 150)}
        onKeyDown={onKeyDown}
        placeholder={t('maint.farSearchPlaceholder', 'Search the FAR — e.g. Cooling Tower CT-1, Melter M1')}
        style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 10, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
      {focus && suggestions.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, marginTop: 4, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', maxHeight: 240, overflowY: 'auto' }}>
          {suggestions.map((s, i) => (
            <button key={s.asset.id} type="button"
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => { e.preventDefault(); choose(s.asset); }}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderBottom: '1px solid #F1F5F9', background: i === active ? '#F1F5F9' : '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
              <span style={{ color: '#334155', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.asset.name}</span>
              <span style={{ color: '#16A34A', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>{s.asset.identification_mark || '—'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Part-name input backed by the plant's stock register (type-ahead + free text). */
function PartNameField({ value, stock, onChange, onPick }: {
  value: string;
  stock: StoreStockItem[];
  onChange: (v: string) => void;
  onPick: (item: StoreStockItem | null) => void;
}) {
  const { t } = useTranslation();
  const [focus, setFocus] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const suggestions = React.useMemo(() => suggestParts(value, stock), [value, stock]);
  React.useEffect(() => { setActive(0); }, [value]);
  const choose = (it: StoreStockItem) => { onChange(it.item_name); onPick(it); setFocus(false); };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!focus || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && active < suggestions.length) { e.preventDefault(); choose(suggestions[active]); }
    else if (e.key === 'Escape') { setFocus(false); }
  };
  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value); onPick(null); }}
        onFocus={() => setFocus(true)}
        onBlur={() => window.setTimeout(() => setFocus(false), 150)}
        onKeyDown={onKeyDown}
        placeholder={stock.length ? t('maint.partSearchPlaceholder', 'Type to search store — e.g. Acid Pump seal') : t('maint.partExamplePlaceholder', 'e.g. Mechanical seal, O-ring kit')}
        style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 10, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
      />
      {focus && suggestions.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, marginTop: 4, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', maxHeight: 240, overflowY: 'auto' }}>
          {suggestions.map((s, i) => (
            <button key={s.id} type="button"
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => { e.preventDefault(); choose(s); }}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderBottom: '1px solid #F1F5F9', background: i === active ? '#F1F5F9' : '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
              <span style={{ color: '#334155', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.item_name}</span>
              {/* FREE stock, not raw on-hand: on a register shared by several
                  factories, units already reserved by another approved ticket
                  are not available to this one. */}
              <span style={{ color: freeQty(s) > 0 ? '#16A34A' : '#DC2626', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>{freeQty(s) > 0 ? t('maint.inStockCount', { defaultValue: '{{n}} in stock', n: freeQty(s) }) : t('maint.outOfStock', 'out of stock')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Full date+time for report cells (locale, IST).
function fmtDT(d: string | null | undefined): string {
  return d ? new Date(d).toLocaleString('en-IN') : '';
}
// Map a stored role id (e.g. 'technician_shd') to its human label using the
// role catalog (from RoleContext). Falls back to the raw id when unknown.
function roleLabelFor(roleId: string | null | undefined, roles: RoleRow[]): string {
  if (!roleId) return '';
  return roles.find((r) => r.id === roleId)?.label || roleId;
}

// CSV layout for the maintenance report — the full life of each ticket.
const REPORT_COLUMNS: CsvColumn[] = [
  { header: 'Maintenance ID', key: 'id' },
  { header: 'Ref #', key: 'shortId' },
  { header: 'Type', key: 'type' },
  { header: 'Equipment', key: 'equipment' },
  { header: 'Plant', key: 'plant' },
  { header: 'Issue / description', key: 'issue' },
  { header: 'Current status', key: 'status' },
  { header: 'Stage reached', key: 'stage' },
  { header: 'Raised by', key: 'raised_by' },
  { header: 'Raised by role', key: 'raised_role' },
  { header: 'Assigned to', key: 'assigned_to' },
  { header: 'Created at', key: 'created' },
  { header: 'Closed at', key: 'closed' },
  { header: 'Days open', key: 'days' },
  { header: 'How resolved', key: 'how' },
  { header: 'Defective part decision', key: 'defective' },
  { header: 'Part requested', key: 'part' },
  { header: 'Qty requested', key: 'qty' },
  { header: 'Specification', key: 'spec' },
  { header: 'Store decision', key: 'store_decision' },
  { header: 'Qty in store', key: 'qty_in_store' },
  { header: 'Shelf location', key: 'shelf' },
  { header: 'Part condition', key: 'condition' },
  { header: 'Unit head approval', key: 'approval' },
  { header: 'BUSY ref', key: 'busy' },
  { header: 'Handover at', key: 'handover' },
  { header: 'Handover notes', key: 'handover_notes' },
  { header: 'Tagged / watchers', key: 'tagged' },
  { header: 'Notes count', key: 'notes_count' },
];
const NOTE_COLUMNS: CsvColumn[] = [
  { header: 'Maintenance ID', key: 'id' },
  { header: 'Ref #', key: 'shortId' },
  { header: 'Equipment', key: 'equipment' },
  { header: 'Note / activity', key: 'note' },
  { header: 'Author', key: 'author' },
  { header: 'Tagged', key: 'tagged' },
  { header: 'At', key: 'at' },
];

// ── Row types (base table rows + the joined plants(name) relation) ─────────────
type Tables = Database['public']['Tables'];
type PlantRel = { plants?: { name: string | null } | null };
type TicketRow = Tables['maintenance_tickets']['Row'] & PlantRel;
type ScheduleRow = Tables['maintenance_schedules']['Row'] & PlantRel;
type StoreReqRow = Tables['maintenance_store_requests']['Row'];
type NotificationInsert = Tables['notifications']['Insert'];
type TicketUpdate = Tables['maintenance_tickets']['Update'];
type TicketStatus = Tables['maintenance_tickets']['Row']['status'];

// ── Per-item workflow helpers ──────────────────────────────────────────────────
// Each store-request row (item) moves through its own lifecycle. The ticket's
// single status is a roll-up of the least-advanced open item, used only for the
// timeline + table; the modal drives actions per item.

type ItemStage = 'store' | 'unit_head' | 'purchase' | 'purchase_manager' | 'handover' | 'done' | 'rejected';

/** Derive an item's current stage from its own fields. */
function itemStage(r: StoreReqRow): ItemStage {
  const decision = (r.store_decision as string | null) ?? 'pending';
  if (r.unit_head_approval === 'rejected') return 'rejected';
  if (!decision || decision === 'pending') return 'store';
  if (r.unit_head_approval !== 'approved') return 'unit_head';
  // approved:
  if (decision === 'available') {
    return r.handover_confirmed_at ? 'done' : 'handover';
  }
  // not in stock + approved → external procurement path
  if (!r.busy_transaction_ref) return 'purchase';
  if (!r.bill_verified) return 'purchase_manager'; // awaiting the aggregate PM bill
  return r.handover_confirmed_at ? 'done' : 'handover';
}

const STAGE_RANK: Record<ItemStage, number> = {
  store: 0, unit_head: 1, purchase: 2, purchase_manager: 3, handover: 4, done: 5, rejected: 5,
};
const STAGE_TO_TICKET: Record<string, TicketStatus> = {
  store: 'pending_store', unit_head: 'pending_unit_head', purchase: 'pending_purchase',
  purchase_manager: 'pending_purchase_manager', handover: 'pending_handover',
};

/** Roll the item stages up to a single ticket status (least-advanced open item). */
function rollupStatus(reqs: StoreReqRow[], current: TicketStatus): TicketStatus {
  if (!reqs.length) return current;
  const open = reqs.filter(r => { const s = itemStage(r); return s !== 'done' && s !== 'rejected'; });
  if (!open.length) {
    // Everything resolved. If any item was actually delivered → defective return;
    // if all were rejected → back to the technician to re-assess.
    return reqs.some(r => itemStage(r) === 'done') ? 'pending_defective_return' : 'open';
  }
  const least = open.reduce((a, r) => STAGE_RANK[itemStage(r)] < STAGE_RANK[itemStage(a)] ? r : a, open[0]);
  return STAGE_TO_TICKET[itemStage(least)] ?? current;
}

// ── Domain write helpers (use Supabase; kept local) ────────────────────────────

function notify(payload: NotificationInsert) {
  insertRows('notifications', payload).then(() => {}, () => {});
}

/** Deep-link a maintenance notification to the exact ticket so clicking the bell
 *  opens that ticket (and the right Periodic/Emergency tab) instead of the default
 *  Periodic list. Falls back to the plain page when no ticket applies (e.g. the
 *  periodic-due summary and schedule notifications). */
const MAINT_ROUTE = '/dashboard/purchase/maint';
function maintRoute(ticketId?: string | null) {
  return ticketId ? `${MAINT_ROUTE}?ticket=${ticketId}` : MAINT_ROUTE;
}

async function updateTicketStatus(ticketId: string, status: TicketStatus, extra?: TicketUpdate) {
  await updateRows('maintenance_tickets', { status, ...extra })
    .eq('id', ticketId);
}

// Role ids whose (real) holders an admin can assign a maintenance task to. The
// actual people are resolved from the directory (allProfiles) inside the
// component. Name-based so the blacklist guard (which matches on person name)
// can flag a restricted assignee.
// Any role granted 'perform_maintenance' is added to this list at runtime.
const ASSIGNABLE_ROLE_IDS = ['technician_shd', 'store_manager_maint', 'factory_operator', 'unit_head'];

// Common deficiencies a reviewer can tick when sending a ticket back for changes.
// The English value is what gets persisted; the key translates the chip at render.
const CHANGE_ISSUE_TAGS = [
  'Blurry / unclear photo', 'Missing photo', 'Incomplete description',
  'Incorrect information', 'Missing maintenance details', 'Missing asset information',
  'Incorrect assessment',
];
const CHANGE_TAG_KEYS: Record<string, string> = {
  'Blurry / unclear photo': 'maint.tagBlurryPhoto',
  'Missing photo': 'maint.tagMissingPhoto',
  'Incomplete description': 'maint.tagIncompleteDescription',
  'Incorrect information': 'maint.tagIncorrectInformation',
  'Missing maintenance details': 'maint.tagMissingMaintDetails',
  'Missing asset information': 'maint.tagMissingAssetInfo',
  'Incorrect assessment': 'maint.tagIncorrectAssessment',
};

// Store requests route to the store manager. There is ONE store-manager role.
//
// There used to be two more — store_manager_chlorides and _plasticiser — from
// when Rehla was a single plant with Chlorides and Plasticiser as units inside
// it, and a request had to reach the right unit's keeper. The factories now
// carry that meaning (SCPL – Rehla IS chlorides, SPPL – Rehla IS plasticiser)
// and they share one register, so routing by unit is routing by a distinction
// that no longer exists. It also relied on substring-matching the plant NAME
// for "chlorid"/"plastic" — exactly the name-as-logic this model removed.
const ALL_STORE_MANAGER_IDS = ['store_manager_maint', 'warehouse_manager'];

/** The technician's persisted first decision for an emergency ticket — the single
 *  source of truth for both the stage strip and the action body, so a reopened ticket
 *  never re-asks "in-house vs store". Derived from the title suffix set at raise
 *  ("— Repairable" / "— Needs part") plus any store request already created.
 *  'undecided' only for legacy tickets with neither signal (they still see the chooser). */
function ticketDecision(title: string | null | undefined, hasStoreReqs: boolean): 'inhouse' | 'store' | 'undecided' {
  if (hasStoreReqs || /Needs part\s*$/i.test(title || '')) return 'store';
  if (/Repairable\s*$/i.test(title || '')) return 'inhouse';
  return 'undecided';
}

/** Fuzzy-match a requested part name to a line on a bulk supplier bill, so the bill's
 *  per-item unit price + line total can be attributed to that specific maintenance
 *  request (the full invoice total still lives on the ticket for FAR). */
function matchBillLine(partName: string, lines: SupplierBillLine[]): SupplierBillLine | null {
  const q = (partName || '').toLowerCase().trim();
  if (!q || !lines.length) return null;
  let best: { line: SupplierBillLine; score: number } | null = null;
  for (const ln of lines) {
    const d = (ln.description || '').toLowerCase().trim();
    if (!d) continue;
    const score = d.includes(q) || q.includes(d) ? 1 : similarity(q, d);
    if (!best || score > best.score) best = { line: ln, score };
  }
  return best && best.score >= 0.5 ? best.line : null;
}

// ── Row actions menu (gear → dropdown) ─────────────────────────────────────────
// Replaces a row of inline buttons with one gear icon that opens a compact menu.
function ScheduleRowMenu({ isActive, deleting, onRevise, onToggle, onDuplicate, onDelete }: {
  isActive: boolean;
  deleting: boolean;
  onRevise: () => void;
  onToggle: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setCoords({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
    setOpen(o => !o);
  }

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    function onScroll() { setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const item: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px',
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#334155',
    textAlign: 'left', whiteSpace: 'nowrap',
  };
  const run = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        title={t('maint.manageSchedule', 'Manage schedule')}
        aria-label={t('maint.manageSchedule', 'Manage schedule')}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: 30, height: 30, borderRadius: 8, border: '1px solid #E2E8F0',
          background: open ? '#F1F5F9' : '#fff', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#475569',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && createPortal(
        <div ref={menuRef} role="menu" style={{
          position: 'fixed', top: coords.top, right: coords.right, zIndex: 1000,
          minWidth: 168, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
          boxShadow: '0 12px 32px rgba(15,23,42,0.14)', padding: 4, overflow: 'hidden',
        }}>
          <button role="menuitem" style={item} onClick={run(onRevise)} onMouseEnter={e => (e.currentTarget.style.background = '#F1F5F9')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            {t('maint.revise', 'Revise')}
          </button>
          <button role="menuitem" style={item} onClick={run(onToggle)} onMouseEnter={e => (e.currentTarget.style.background = '#F1F5F9')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            {isActive ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            )}
            {isActive ? t('maint.pause', 'Pause') : t('maint.resume', 'Resume')}
          </button>
          <button role="menuitem" style={item} onClick={run(onDuplicate)} onMouseEnter={e => (e.currentTarget.style.background = '#F1F5F9')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            {t('maint.duplicate', 'Duplicate')}
          </button>
          <div style={{ height: 1, background: '#F1F5F9', margin: '4px 0' }} />
          <button role="menuitem" disabled={deleting} style={{ ...item, color: '#DC2626' }} onClick={run(onDelete)} onMouseEnter={e => (e.currentTarget.style.background = '#FEF2F2')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            {deleting ? t('maint.deleting', 'Deleting…') : t('maint.delete', 'Delete')}
          </button>
        </div>,
        document.body
      )}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function Maintenance() {
  const { activeProfile, allProfiles, roles, can } = useRoleContext();
  const { scopeQuery, units: scopeUnits, allowedPlants, storeIdFor } = usePlantScope();
  const { isPersonBlacklisted, notifyActivity, tableReady: blacklistReady } = useBlacklist();
  const toast = useToast();
  const { t } = useTranslation();
  const people = useDirectory();
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const actionBusyRef = useRef(false); // guards one-shot workflow actions from double-clicks
  const role = activeProfile.id;

  // Translated status label for a ticket status (falls back to the raw config label).
  const statusLabel = (s: string) => {
    const cfg = STATUS_CFG[s];
    if (!cfg) return s;
    return cfg.labelKey ? t(cfg.labelKey, cfg.label) : cfg.label;
  };
  // Translate a stage-label map (StageStrip labels / renderStageDetail heading).
  const trStageLabels = (labels: Record<string, string>, keys: Record<string, string>) =>
    Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, keys[k] ? t(keys[k], v) : v]));

  // Real people (from the DB directory) an admin can assign a task to — those whose
  // role is in ASSIGNABLE_ROLE_IDS, plus anyone holding 'perform_maintenance', so a
  // newly created role becomes assignable the moment it is granted the allowance.
  // baseRoleId is the directory entry's role.
  const assignableRoleIds = useMemo(
    () => new Set([...ASSIGNABLE_ROLE_IDS, ...roles.filter(r => (r.capabilities ?? []).includes('perform_maintenance')).map(r => r.id)]),
    [roles],
  );
  const ASSIGNABLE_STAFF = allProfiles
    .filter((p) => assignableRoleIds.has(p.baseRoleId ?? p.id))
    .map((p) => ({ name: p.name, label: `${p.name} · ${p.roleLabel}` }));

  // ── @-mention / watcher plumbing for tickets ────────────────────────────────
  const ticketRef = (t: TicketRow) => ({
    entityType: 'maintenance_ticket', entityId: t.id,
    entityLabel: t.equipment || t.title || 'Maintenance ticket',
    route: `/dashboard/purchase/maint?ticket=${t.id}`,
  });
  const actorObj = () => ({ id: activeProfile.id, name: activeProfile.name, role: activeProfile.roleLabel });
  // Insert directly (mirrors the module's role-based notify) so it doesn't depend on context tableReady.
  // Returns whether the row was created (delivered) so receipts can be stamped.
  const addNote = async (n: Omit<AppNotification, 'id' | 'created_at' | 'read_by'>): Promise<boolean> => {
    let ok = false;
    await insertRows('notifications', { ...n, read_by: [] }).then(() => { ok = true; }, () => {});
    return ok;
  };
  // Ping everyone tagged / CC'd on a ticket that its workflow moved.
  async function notifyTicketWatchers(t: TicketRow, title: string, body: string, type: AppNotification['type'] = 'info') {
    await notifyWatchers({ ref: ticketRef(t), actor: actorObj(), title, body, type, addNotification: addNote });
  }

  const isAdmin = role === 'admin';
  // "Does the shop-floor work on a ticket." The seeded Technician role has it by
  // birth; any other role (Operator / Technical Team / a role the client invents
  // next month) earns it through the grantable 'perform_maintenance' allowance.
  // Gating on the capability instead of the 'technician_shd' slug is what makes
  // this work for multi-role users too — RoleContext unions capabilities across
  // every role a person holds, but activeProfile.id is only their PRIMARY role.
  // Admin is excluded so the capability (which admins hold implicitly) doesn't
  // demote them into a technician view and hide Schedule Setup from them.
  const isTechnician = role === 'technician_shd' || (!isAdmin && can('perform_maintenance'));
  const isUnitHead = role === 'unit_head';
  const isStoreManager = ALL_STORE_MANAGER_IDS.includes(role);
  const isPurchaseManager = role === 'purchase_manager';
  // Every role slug that does maintenance work, resolved from the live catalog so
  // role-targeted notifications reach capability-holders and not just technicians.
  const maintenanceRoleIds = useMemo(
    () => [...new Set(['technician_shd', ...roles.filter(r => (r.capabilities ?? []).includes('perform_maintenance')).map(r => r.id)])],
    [roles],
  );
  // POC: Mark Complete + upload is a Manage Roles toggle — assignable to any role.
  const canMarkPeriodicComplete = can('complete_periodic_maintenance') || isAdmin;
  /** Who can act on an open emergency ticket (raise store indent / start repair). */
  const canWorkEmergency = (tk: TicketRow | null | undefined) => {
    if (!tk) return false;
    if (isAdmin || isUnitHead || isTechnician || role === 'factory_operator') return true;
    const me = activeProfile.name?.trim().toLowerCase();
    if (!me) return false;
    return (tk.raised_by || '').trim().toLowerCase() === me
      || (tk.assigned_to || '').trim().toLowerCase() === me;
  };
  /** Who can Revise & Resubmit after Request Changes — original entry user, not only Operator. */
  const canResubmitChanges = (tk: TicketRow | null | undefined) => {
    if (!tk) return false;
    if (isAdmin || isTechnician) return true;
    const me = activeProfile.name?.trim().toLowerCase();
    if (!me) return false;
    return (tk.raised_by || '').trim().toLowerCase() === me
      || (tk.assigned_to || '').trim().toLowerCase() === me;
  };

  // Data
  const [tab, setTab] = useState<'periodic' | 'emergency' | 'schedule'>('periodic');
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [dbPlants, setDbPlants] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Panel state
  const [completingSchedule, setCompletingSchedule] = useState<ScheduleRow | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<TicketRow | null>(null);
  // Evidence photos opened from the ticket panel's thumbnail strip.
  const [ticketLightbox, setTicketLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  // All store-request rows (items) for the selected ticket. A ticket can need
  // several parts at once; each row is one item with its own per-item lifecycle.
  const [storeReqs, setStoreReqs] = useState<StoreReqRow[]>([]);
  const patchDefectiveLine = (i: number, patch: Partial<DefectiveSplitLine>) =>
    setDefectiveLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const selectedStoreReq = storeReqs[0] ?? null; // kept for the read-only timeline detail
  // The item the user is currently acting on (store check / unit-head / purchase / handover).
  const [actingReqId, setActingReqId] = useState<string | null>(null);
  const [showRaisePanel, setShowRaisePanel] = useState(false);
  const [showSchedulePanel, setShowSchedulePanel] = useState(false);
  const [showPMImport, setShowPMImport] = useState(false);
  const [schedPlantFilter, setSchedPlantFilter] = useState<string[]>([]); // empty = all plants
  // When set, the schedule panel is in "revise" mode editing this row; null = creating new.
  const [editingSchedule, setEditingSchedule] = useState<ScheduleRow | null>(null);
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(null);

  // Form state
  const today = new Date().toISOString().split('T')[0];
  // unit is NOT seeded from the legacy plant_name (that mis-tagged non-Jharkhand users
  // with Plasticiser/Chlorides). Plant defaults from the real data scope; unit only
  // applies when the chosen plant is a Jharkhand plant.
  const [raiseForm, setRaiseForm] = useState({ equipment: '', plant: '', description: '', assessment: 'repairable', unit: '', farAssetId: '', equipmentMark: '' });
  const [scheduleForm, setScheduleForm] = useState({ title: '', equipment: '', plant: '', frequency: 'weekly', description: '', firstDue: today, assignedTo: '', farAssetId: '', equipmentMark: '', until: '', unmatchedReason: '' });
  const [farAssets, setFarAssets] = useState<{ id: string; name: string; identification_mark: string | null; plant_id: string | null }[]>([]);
  // Multi-item store request: a list of parts entered together (+ Add item).
  type StoreItem = { partName: string; quantity: string; unit: string; specification: string; storeItemId: string | null };
  const BLANK_ITEM: StoreItem = { partName: '', quantity: '', unit: 'Units', specification: '', storeItemId: null };
  const [storeItems, setStoreItems] = useState<StoreItem[]>([{ ...BLANK_ITEM }]);
  const [showStoreForm, setShowStoreForm] = useState(false);
  // The ticket-plant's stock register — powers the part-name type-ahead.
  const [storeStock, setStoreStock] = useState<StoreStockItem[]>([]);

  // Store manager availability form. registerQty = what the stock file says (for
  // the default + override check); qtyJustification is required if they differ.
  const BLANK_STORE_DECISION = {
    available: null as boolean | null,
    qtyInStore: '',
    shelfLocation: '',
    partCondition: 'new',
    registerQty: null as number | null,
    qtyJustification: '',
  };
  const [storeDecisionForm, setStoreDecisionForm] = useState(BLANK_STORE_DECISION);

  // Handover form (store manager uploads invoice + product photo)
  const [handoverInvoiceBlob, setHandoverInvoiceBlob] = useState<Blob | null>(null);
  const [handoverPhotoBlob, setHandoverPhotoBlob] = useState<Blob | null>(null);
  const [dispatchBlob, setDispatchBlob] = useState<Blob | null>(null); // purchase manager bill photo
  const [handoverNotes, setHandoverNotes] = useState('');

  // Purchase Manager aggregate bill form (one bill for all procured items).
  const [pmForm, setPmForm] = useState({ itemsCount: '', billTotal: '' });

  // Other action state
  const [busyRef, setBusyRef] = useState('');
  const [unitPrice, setUnitPrice] = useState(''); // procurement unit price (₹) → feeds FAR cost
  const [supplierName, setSupplierName] = useState(''); // external vendor → recorded as a Purchase Order
  const [purchaseQty, setPurchaseQty] = useState(''); // how many were actually bought (bulk ≥ shortfall)
  const [defectiveDecision, setDefectiveDecision] = useState<'repair' | 'scrap' | ''>('');
  // Per-replaced-part Repair/Scrap split recorded when the ticket is closed.
  // Seeded from the ticket's store-request lines (defaulting "replaced" to what
  // the store actually handed over) and editable before submit.
  const [defectiveLines, setDefectiveLines] = useState<DefectiveSplitLine[]>([]);

  // Upload
  const [completionBlob, setCompletionBlob] = useState<Blob | null>(null);
  const [completionChecklist, setCompletionChecklist] = useState<{ component: string; activity: string; done: boolean }[]>([]);
  const [verifyingTicket, setVerifyingTicket] = useState<TicketRow | null>(null); // unit-head verification of a completed periodic ticket
  const [defectiveBlob, setDefectiveBlob] = useState<Blob | null>(null);
  const [raisePhotoBlob, setRaisePhotoBlob] = useState<Blob | null>(null); // optional defective-item photo at raise
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  // Distinguishes the two slow steps of a bill submit: the AI read/verify (no % yet)
  // vs the actual file upload (real %). Only set during submitPurchaseManagerBill.
  const [busyPhase, setBusyPhase] = useState<'verifying' | 'uploading'>('uploading');

  // Save states
  const [raiseSaved, setRaiseSaved] = useState(false);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [raising, setRaising] = useState(false);          // double-submit guard
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  // Admin edit + report
  const [editingTicket, setEditingTicket] = useState(false);
  const [editForm, setEditForm] = useState({ equipment: '', description: '', plant: '', status: '' });

  // Request Changes (reviewer) + Revise & Resubmit (technician) — the same ticket
  // loops back for correction instead of forcing a new one.
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changeReason, setChangeReason] = useState('');
  const [changeTags, setChangeTags] = useState<string[]>([]);
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitForm, setResubmitForm] = useState({ equipment: '', description: '', plant: '', assessment: 'repairable' });
  const [resubmitPhotoBlob, setResubmitPhotoBlob] = useState<Blob | null>(null);
  const [savingRevision, setSavingRevision] = useState(false); // shared submit guard
  const [rejectReason, setRejectReason] = useState(''); // optional reason on a part-level reject
  const [viewStage, setViewStage] = useState<string | null>(null); // clicked stage in the timeline
  const [showReport, setShowReport] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reportForm, setReportForm] = useState({ emergency: true, periodic: true, status: 'all', from: '', to: '', includeNotes: true });

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    let ticketsData: TicketRow[] | null = null;
    let schedulesData: ScheduleRow[] | null = null;
    try {
      const [tRes, sRes, pRes] = await Promise.all([
        withEmbedFallback(
          // PAGED: this factory already holds ~1,300 tickets and PostgREST caps a
          // response at 1000 SILENTLY — which is why the OVERDUE card could never
          // read above 1000 and the oldest tickets were invisible entirely.
          fetchAllRows<TicketRow>((from, to) =>
            scopeQuery(supabase.from('maintenance_tickets').select('*, plants(name)'), { unitCol: 'unit_id' })
              .order('created_at', { ascending: false }).range(from, to).returns<TicketRow[]>()),
          () => fetchAllRows<TicketRow>((from, to) =>
            scopeQuery(supabase.from('maintenance_tickets').select('*'), { unitCol: 'unit_id' })
              .order('created_at', { ascending: false }).range(from, to).returns<TicketRow[]>()),
          'Maintenance.tickets',
        ),
        withEmbedFallback(
          scopeQuery(supabase.from('maintenance_schedules').select('*, plants(name)')).order('next_due_at', { ascending: true }).returns<ScheduleRow[]>(),
          () => scopeQuery(supabase.from('maintenance_schedules').select('*')).order('next_due_at', { ascending: true }).returns<ScheduleRow[]>(),
          'Maintenance.schedules',
        ),
        fetchActivePlants<{ id: string; name: string }>('id, name'),
      ]);
      if (tRes.error) throw tRes.error;
      if (sRes.error) throw sRes.error;
      ticketsData = tRes.data;
      schedulesData = sRes.data;
      setTickets(ticketsData || []);
      setSchedules(schedulesData || []);
      if (pRes.data?.length) setDbPlants(pRes.data);
      setLoadError(false);
    } catch (err) {
      console.error('[Maintenance] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }

    // Materialise due periodic tickets — batched, so importing hundreds of schedules
    // doesn't fire hundreds of sequential inserts/notifications on load.
    if (schedulesData) {
      try {
        const nowTs = Date.now();
        const toCreate: Record<string, unknown>[] = [];
        const toDeactivate: string[] = [];
        for (const s of schedulesData) {
          if (!s.is_active || !s.next_due_at) continue;
          if (new Date(s.next_due_at).getTime() > nowTs) continue;
          if (s.until_date && new Date(s.next_due_at) > new Date(`${s.until_date}T23:59:59`)) { toDeactivate.push(s.id); continue; }
          if ((ticketsData || []).some((t) => t.schedule_id === s.id && t.status !== 'closed')) continue;
          toCreate.push({
            type: 'periodic', status: 'open', title: s.title,
            equipment: s.equipment, plant_id: s.plant_id || null,
            schedule_id: s.id, description: s.description || null,
            far_asset_id: s.far_asset_id || null, // inherit the schedule's asset link
            assigned_to: s.assigned_to || null,
            due_date: s.next_due_at ? s.next_due_at.split('T')[0] : null,
            checklist: (s.checklist || []).map(c => ({ component: c.component, activity: c.activity, done: false })),
            requires_approval: s.requires_approval ?? (s.frequency !== 'daily'),
          });
        }
        if (toDeactivate.length) await (supabase.from('maintenance_schedules') as never as { update: (v: unknown) => { in: (c: string, v: string[]) => Promise<unknown> } }).update({ is_active: false }).in('id', toDeactivate);
        if (toCreate.length) {
          for (let i = 0; i < toCreate.length; i += 200) await insertRows('maintenance_tickets', toCreate.slice(i, i + 200) as never);
          notify({
            target_roles: ['admin', 'unit_head', ...maintenanceRoleIds],
            title: `${toCreate.length} periodic maintenance task${toCreate.length === 1 ? '' : 's'} due`,
            body: `Auto-generated from the maintenance schedule — open the Periodic tab.`,
            type: 'warning', route: '/dashboard/purchase/maint',
            actor_name: 'System', actor_role: 'system', read_by: [],
            plant_id: null, unit_id: null,
          });
          // Reflect the new tickets without a full reload loop.
          const { data: refreshed } = await scopeQuery(supabase.from('maintenance_tickets').select('*, plants(name)'), { unitCol: 'unit_id' }).order('created_at', { ascending: false }).returns<TicketRow[]>();
          if (refreshed) setTickets(refreshed);
        }
      } catch (e) { console.error('[Maintenance] periodic generation failed', e); }
    }
  }, [scopeQuery, maintenanceRoleIds]);

  useEffect(() => { loadData(); }, [loadData]);

  // Guard against accidentally closing the tab mid-upload — the browser shows a
  // native "leave site?" prompt so an in-flight bill upload isn't lost.
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  // Deep-link: a notification's "?ticket=<id>" opens that ticket directly.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const tid = searchParams.get('ticket');
    if (!tid) return;
    const clearTicketParam = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('ticket');
      setSearchParams(next, { replace: true });
    };
    const matched = tickets.find((x) => x.id === tid);
    if (!matched) {
      // NOT NECESSARILY STILL LOADING. PostgREST caps a response at 1000 rows by
      // default, and this factory already has ~1,300 tickets — so an older one
      // simply is not in `tickets` and never will be, however long we wait.
      // Returning here is what made a To-Do link dump the user on the full list
      // with 1,000 overdue rows to search by hand.
      //
      // Fetch the one ticket directly instead. Deep-linking must not depend on
      // the row happening to fall inside the first page of an unrelated query.
      let cancelled = false;
      (async () => {
        const { data } = await withEmbedFallback(
          supabase.from('maintenance_tickets').select('*, plants(name)').eq('id', tid).limit(1).returns<TicketRow[]>(),
          () => supabase.from('maintenance_tickets').select('*').eq('id', tid).limit(1).returns<TicketRow[]>(),
          'Maintenance.ticketDeepLink',
        );
        if (cancelled) return;
        const found = data?.[0];
        if (!found) {
          // Deleted / out of scope — bare Periodic list with no explanation looked
          // like a broken flow after clicking To-Do / bell.
          toast.info(t('maint.ticketGoneDeepLink', 'That ticket is no longer available — it may have been deleted.'));
          clearTicketParam();
          return;
        }
        setSelectedTicket(found);
        setTab(found.type === 'periodic' ? 'periodic' : 'emergency');
        clearTicketParam();
      })();
      return () => { cancelled = true; };
    }
    setSelectedTicket(matched);
    setTab(matched.type === 'periodic' ? 'periodic' : 'emergency');
    clearTicketParam();
    // toast/t intentionally omitted — ToastApi object is not referentially stable.
  }, [searchParams, tickets, setSearchParams]);

  const loadStoreReqs = useCallback(async (ticketId: string) => {
    const { data } = await supabase.from('maintenance_store_requests')
      .select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true })
      .returns<StoreReqRow[]>();
    setStoreReqs(data || []);
  }, []);

  useEffect(() => {
    if (!selectedTicket) { setStoreReqs([]); return; }
    loadStoreReqs(selectedTicket.id);
  }, [selectedTicket?.id, loadStoreReqs]);

  // Seed the defective Repair/Scrap split from the ticket's part lines. Default
  // "replaced" to what the store ACTUALLY handed over (you can only swap out as
  // many old parts as you were given new ones) and start the whole quantity as
  // Repair — the technician adjusts before submitting. An in-house job with no
  // store request still gets one line so the ticket can be closed.
  useEffect(() => {
    if (!selectedTicket) { setDefectiveLines([]); return; }
    const lines: DefectiveSplitLine[] = storeReqs.length
      ? storeReqs.map(sr => {
          const replaced = defaultReplacedQty(sr);
          return {
            storeRequestId: sr.id,
            partName: sr.part_name,
            replacedQty: replaced,
            repairQty: replaced,
            scrapQty: 0,
            storeItemId: sr.store_item_id ?? null,
          };
        })
      : [{
          storeRequestId: null,
          // No store request (in-house fix): fall back to the equipment name.
          // NEVER the ticket title — that carries the "— Needs part" suffix.
          partName: cleanPartName(selectedTicket.equipment) || cleanPartName(selectedTicket.title) || 'Defective part',
          replacedQty: 1, repairQty: 1, scrapQty: 0, storeItemId: null,
        }];
    setDefectiveLines(lines);
  }, [selectedTicket?.id, storeReqs]);

  // Load the register of the STORE this ticket's factory draws from → powers
  // the part-name type-ahead.
  //
  // Keyed on the store, not the factory. At Rehla, SCPL / SPPL / SPPL(K) all
  // resolve to the same Rehla Common Store, so a technician at any of them sees
  // the one shared register — stock held once, not three copies. Everywhere
  // else a factory maps to its own store, so this is identical to the old
  // `.eq('plant_id', pid)` behaviour.
  useEffect(() => {
    const pid = selectedTicket?.plant_id;
    if (!pid) { setStoreStock([]); return; }
    let alive = true;
    const storeId = storeIdFor(pid);
    const q = supabase.from('store_items').select('id, item_name, on_hand, reserved_qty, unit');
    // Before migration 59 there are no stores; fall back to the factory's own rows.
    (storeId ? q.eq('store_id', storeId) : q.eq('plant_id', pid))
      .order('item_name')
      .returns<StoreStockItem[]>().then(({ data }) => { if (alive) setStoreStock(data || []); });
    return () => { alive = false; };
  }, [selectedTicket?.plant_id, storeIdFor]);

  // FAR assets → the equipment dropdown when creating a schedule (validation
  // against the register). SCOPED: an unscoped fetch would pull every factory's
  // register into memory, and at Rehla three separate FARs share one site — so
  // "assets of one factory must never appear under another" has to hold here,
  // not just in the picker below. RLS on fixed_assets is the real boundary;
  // this keeps the client from ever holding what it may not show.
  useEffect(() => {
    let alive = true;
    scopeQuery(supabase.from('fixed_assets').select('id, name, identification_mark, plant_id'))
      .order('name')
      .returns<{ id: string; name: string; identification_mark: string | null; plant_id: string | null }[]>()
      .then(({ data }) => { if (alive) setFarAssets(data || []); });
    return () => { alive = false; };
  }, [scopeQuery]);

  // Seed the completion checklist from the open ticket (preserves prior ticks) or the schedule.
  useEffect(() => {
    if (!completingSchedule) return;
    const lt = tickets.find(t => t.schedule_id === completingSchedule.id && t.status !== 'closed');
    const base = (lt?.checklist as { component: string; activity: string; done?: boolean }[] | null) || completingSchedule.checklist || [];
    setCompletionChecklist(base.map(c => ({ component: c.component, activity: c.activity, done: !!(c as { done?: boolean }).done })));
  }, [completingSchedule]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restrict the factory picker to the user's allowed factories (all if global)
  // so a scoped user can't raise a ticket for another factory.
  //
  // Options carry the plant ID, and every form below stores that ID rather than
  // the display name. Names are not stable — factories are renamed — and at
  // Rehla three factories sit at one site, so matching on a label is both
  // fragile and ambiguous. The ID is the only thing that is neither.
  const plantOptions = useMemo(() => {
    const src = allowedPlants.length > 0 ? allowedPlants : dbPlants;
    return [...src].sort((a, b) => a.name.localeCompare(b.name));
  }, [allowedPlants, dbPlants]);

  const plantNameById = useMemo(
    () => new Map(dbPlants.map(p => [p.id, p.name] as const)),
    [dbPlants],
  );

  // Emergency raise: factory defaults to the user's own (alphabetically first
  // when several); the equipment picker + Jharkhand-unit selector derive from it.
  const defaultRaisePlantId = plantOptions[0]?.id ?? '';
  // Only plants that actually have chlorides/plasticiser units are "Jharkhand" plants —
  // the sole place the procurement-unit selector should appear.
  const jharkhandPlantIds = useMemo(
    () => new Set(scopeUnits.filter(u => /chlorid|plastic/i.test(u.code || '') || /chlorid|plastic/i.test(u.name)).map(u => u.plant_id)),
    [scopeUnits],
  );
  const raisePlantIsJharkhand = !!raiseForm.plant && jharkhandPlantIds.has(raiseForm.plant);
  // No factory chosen ⇒ NO assets. Never fall back to the full register: at
  // Rehla that would show SCPL's and SPPL's assets to an SPPL(K) technician,
  // which is exactly the isolation the client asked for.
  const raiseFarAssets = useMemo(
    () => (raiseForm.plant ? farAssets.filter(a => a.plant_id === raiseForm.plant) : []),
    [farAssets, raiseForm.plant],
  );

  // Default the raise form's factory to the user's own when the panel opens.
  useEffect(() => {
    if (showRaisePanel) setRaiseForm(f => (f.plant ? f : { ...f, plant: defaultRaisePlantId }));
  }, [showRaisePanel, defaultRaisePlantId]);

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const periodicTickets = tickets.filter(t => t.type === 'periodic');
  // Schedule-list plant filter (each plant has its own PM workbook).
  //
  // Sourced from the factories the user may SEE, not from the factories that
  // happen to have schedules — otherwise the control disappears whenever only
  // one workbook has been imported and the register stops saying whose schedules
  // it is showing. `hasData` marks the ones still waiting for a workbook, which
  // is also the fastest way to spot a factory nobody has set up yet.
  const schedulePlants = useMemo(() => {
    const withData = new Set(schedules.map(s => s.plant_id).filter(Boolean) as string[]);
    return plantOptions.map(p => ({ id: p.id, name: p.name, hasData: withData.has(p.id) }));
  }, [plantOptions, schedules]);
  const shownSchedules = schedPlantFilter.length ? schedules.filter(s => s.plant_id && schedPlantFilter.includes(s.plant_id)) : schedules;
  const emergencyTickets = tickets.filter(t => t.type === 'emergency');

  // ── v2 filter bar (client-side; resets when switching tabs) ───────────────
  const [fltQ, setFltQ] = useState('');
  const [fltPlant, setFltPlant] = useState('all');
  const [fltStatus, setFltStatus] = useState('all');
  useEffect(() => { setFltQ(''); setFltPlant('all'); setFltStatus('all'); }, [tab]);
  const resetFilters = () => { setFltQ(''); setFltPlant('all'); setFltStatus('all'); };

  /** Derived schedule state — same classification the periodic rows render. */
  const schedStatusOf = (s: ScheduleRow): string => {
    const linked = tickets.find(t => t.schedule_id === s.id && t.status !== 'closed');
    if (linked?.status === 'pending_unit_head') return 'verify';
    if (linked) return 'ticket';
    const d = daysFromNow(s.next_due_at);
    if (d !== null && d < 0) return 'overdue';
    if (d !== null && d <= 3) return 'due-soon';
    return 'on-track';
  };
  const matchQ = (...txt: (string | null | undefined)[]) => {
    const q = fltQ.trim().toLowerCase();
    return !q || txt.some(x => (x || '').toLowerCase().includes(q));
  };
  const fltPeriodic = schedules.filter(s =>
    matchQ(s.title, s.equipment, s.plants?.name)
    && (fltPlant === 'all' || s.plant_id === fltPlant)
    && (fltStatus === 'all' || schedStatusOf(s) === fltStatus));
  const fltEmergency = emergencyTickets.filter(t =>
    matchQ(t.equipment, t.title, t.description, t.plants?.name, t.raised_by)
    && (fltPlant === 'all' || t.plant_id === fltPlant)
    && (fltStatus === 'all' || t.status === fltStatus));
  const plantFilterOptions = [
    { value: 'all', label: t('common.allPlants') },
    ...dbPlants.map(p => ({ value: p.id, label: p.name })),
  ];
  const statusFilterOptions = tab === 'periodic'
    ? [
        { value: 'all', label: t('common.allStatus') },
        { value: 'overdue', label: t('maint.schedStatusOverdue') },
        { value: 'due-soon', label: t('maint.schedStatusDueSoon') },
        { value: 'on-track', label: t('maint.schedStatusOnTrack') },
        { value: 'ticket', label: t('maint.schedStatusTicketOpen') },
      ]
    : [
        { value: 'all', label: t('common.allStatus') },
        ...[...new Set(emergencyTickets.map(tk => tk.status))].map(s => ({ value: s, label: statusLabel(s) })),
      ];

  // Click-to-sort for the three maintenance tables (sorts feed pagination below).
  const periodicSort = useSortable(fltPeriodic, {
    task: s => s.title,
    equipment: s => s.equipment,
    plant: s => s.plants?.name,
    frequency: s => s.frequency,
    lastDone: s => (s.last_completed_at ? new Date(s.last_completed_at) : null),
    due: s => (s.next_due_at ? new Date(s.next_due_at) : null),
  }, { key: 'due', dir: 'asc' });
  const emergencySort = useSortable(fltEmergency, {
    ticket: t => t.id,
    equipment: t => t.equipment,
    plant: t => t.plants?.name,
    issue: t => t.description || t.title,
    status: t => t.status,
    raisedBy: t => t.raised_by,
    created: t => (t.created_at ? new Date(t.created_at) : null),
  }, { key: 'created', dir: 'desc' });
  const scheduleSort = useSortable(shownSchedules, {
    task: s => s.title,
    equipment: s => s.equipment,
    plant: s => s.plants?.name,
    frequency: s => s.frequency,
    assignedTo: s => s.assigned_to,
    due: s => (s.next_due_at ? new Date(s.next_due_at) : null),
    status: s => (s.is_active ? 1 : 0),
  }, { key: 'due', dir: 'asc' });

  // Pagination for the three long maintenance tables (default 10/page).
  const fltKey = `${fltQ}|${fltPlant}|${fltStatus}`;
  const periodicPg = usePagination(periodicSort.sorted, { resetKey: `${fltKey}|${schedules.length}|${periodicSort.sort.key}|${periodicSort.sort.dir}` });
  const emergencyPg = usePagination(emergencySort.sorted, { resetKey: `${fltKey}|${emergencyTickets.length}|${emergencySort.sort.key}|${emergencySort.sort.dir}` });
  const schedulePg = usePagination(scheduleSort.sorted, { resetKey: `${schedPlantFilter.join(',')}|${scheduleSort.sort.key}|${scheduleSort.sort.dir}` });
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const openEmergency = emergencyTickets.filter(t => t.status !== 'closed').length;
  const pendingStore = emergencyTickets.filter(t => ['pending_store', 'pending_unit_head'].includes(t.status)).length;
  const pendingPurchase = emergencyTickets.filter(t => ['pending_purchase', 'pending_purchase_manager', 'pending_handover'].includes(t.status)).length;
  const closedMTD = emergencyTickets.filter(t => t.status === 'closed' && !!t.closed_at && t.closed_at >= monthStart).length;

  const dueToday = periodicTickets.filter(t => t.status === 'open' && t.due_date === today).length;
  const dueWeek = periodicTickets.filter(t => { const d = daysFromNow(t.due_date); return t.status === 'open' && d !== null && d >= 0 && d <= 7; }).length;
  const overdue = periodicTickets.filter(t => { const d = daysFromNow(t.due_date); return t.status === 'open' && d !== null && d < 0; }).length;
  const closedPeriodicMTD = periodicTickets.filter(t => t.status === 'closed' && !!t.closed_at && t.closed_at >= monthStart).length;

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleRaiseTicket() {
    if (!raiseForm.equipment.trim() || raising) return;
    setRaising(true);
    try {
    const plant = dbPlants.find(p => p.id === raiseForm.plant);
    // Resolve the unit text ('chlorides'/'plasticiser') to its unit_id within
    // this plant — the scoping key used for routing + isolation.
    const unitRow = raiseForm.unit
      ? scopeUnits.find(u => u.plant_id === plant?.id && (u.code === raiseForm.unit || u.name.toLowerCase() === raiseForm.unit.toLowerCase()))
      : undefined;
    const { data: newTicket, error } = await insertRows('maintenance_tickets', {
      type: 'emergency', status: 'open',
      title: `${raiseForm.equipment} — ${raiseForm.assessment === 'repairable' ? 'Repairable' : 'Needs part'}`,
      equipment: raiseForm.equipment,
      plant_id: plant?.id || null,
      unit: raiseForm.unit || null,
      unit_id: unitRow?.id || null,
      description: raiseForm.description || null,
      // Reliable FAR link when the equipment was picked from the type-ahead — powers
      // the asset QR profile's history (was previously captured but dropped).
      far_asset_id: raiseForm.farAssetId || null,
      raised_by: activeProfile.name, raised_role: role,
      // A technician / Technical raiser is implicitly assigned to themselves so
      // they can continue the store-indent / repair loop without role confusion.
      assigned_to: (isTechnician || role === 'factory_operator') ? activeProfile.name : null,
    }).select('*, plants(name)').single();
    if (error) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: error.message })); return; }

    // Optional: photo of the broken/defective item(s) attached at raise time.
    if (newTicket && raisePhotoBlob) {
      try {
        setUploading(true);
        const r = await uploadMaintenancePhoto(raisePhotoBlob, {
          ticketId: newTicket.id, plantName: newTicket.plants?.name || 'Plant',
          photoType: 'defective', creator: activeProfile.name, onProgress: setUploadPct,
        });
        await updateRows('maintenance_tickets', { defective_raise_photo_url: r.secure_url }).eq('id', newTicket.id);
        newTicket.defective_raise_photo_url = r.secure_url;
      } catch { /* non-blocking — the ticket is already raised */ }
      finally { setUploading(false); setUploadPct(0); }
    }

    notify({
      target_roles: ['admin', 'unit_head', 'store_manager_maint'],
      title: `Maintenance ticket raised: ${raiseForm.equipment}`,
      body: `${activeProfile.name} · ${raiseForm.assessment === 'repairable' ? 'Repairable in-house' : 'Needs store part'}${raiseForm.farAssetId ? '' : ' · ⚠ Equipment not in FAR (entered manually)'}`,
      type: 'urgent', route: maintRoute(newTicket?.id),
      actor_name: activeProfile.name, actor_role: role, read_by: [],
      // Scope the ticket to its plant/unit so only that plant's unit head +
      // store manager are notified (never another plant's).
      plant_id: plant?.id || null, unit_id: unitRow?.id || null,
    });

    // Anyone @-tagged in the description becomes a watcher AND gets a realtime
    // ping, and the description is persisted as the ticket's FIRST note so it
    // shows in the Notes thread with delivery/read ticks. Same single path the
    // edit / store-req / handover flows use (notifyMentions writes the
    // entity_notes row + watchers + receipts + notification together).
    if (newTicket) {
      await notifyMentions(raiseForm.description, {
        entityType: 'maintenance_ticket', entityId: newTicket.id,
        entityLabel: raiseForm.equipment,
        route: `/dashboard/purchase/maint?ticket=${newTicket.id}`,
      });
    }

    // Screen the equipment/description against the blacklist.
    const hits = await screenBlacklist(
      [{ value: raiseForm.equipment, label: 'Equipment' }, { value: raiseForm.description, label: 'Description' }],
      { workflow: 'Maintenance', source: 'entry', entityLabel: raiseForm.equipment },
    );
    if (hits.length) {
      const h = hits[0];
      toast.error(t('maint.blacklistMatchToast', { defaultValue: '⚠ "{{value}}" ≈ blacklisted {{type}} "{{name}}" ({{pct}}%). Admin notified.', value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) }));
    }

    setRaiseSaved(true);
    await loadData();
    const needsPart = raiseForm.assessment === 'needs_part';
    const ticketForStore = newTicket;
    setTimeout(() => {
      setShowRaisePanel(false); setRaiseSaved(false); setRaisePhotoBlob(null);
      setRaiseForm({ equipment: '', plant: '', description: '', assessment: 'repairable', unit: '', farAssetId: '', equipmentMark: '' });
      // Always open the store parts form when "Need a part from store" was chosen
      // (meeting 3.2 — flow must not stop after ticket create).
      if (ticketForStore && needsPart) {
        setSelectedTicket(ticketForStore);
        setShowStoreForm(true);
      }
    }, 900);
    } finally { setRaising(false); }
  }

  // ── Admin: edit / delete a ticket ───────────────────────────────────────────
  function startEdit(t: TicketRow) {
    setEditForm({ equipment: t.equipment || '', description: t.description || '', plant: t.plant_id || '', status: t.status });
    setEditingTicket(true);
  }

  async function saveEdit() {
    if (!selectedTicket) return;
    const plant = dbPlants.find(p => p.id === editForm.plant);
    await updateRows('maintenance_tickets', {
      equipment: editForm.equipment,
      description: editForm.description || null,
      plant_id: plant?.id ?? selectedTicket.plant_id ?? null,
      status: editForm.status as TicketStatus,
    }).eq('id', selectedTicket.id);
    setSelectedTicket((t) => t ? { ...t, equipment: editForm.equipment, description: editForm.description || null, status: editForm.status as TicketStatus, plants: plant ? { name: plant.name } : t.plants } : t);
    await notifyMentions(editForm.description, {
      entityType: 'maintenance_ticket', entityId: selectedTicket.id,
      entityLabel: editForm.equipment || 'Ticket', route: `/dashboard/purchase/maint?ticket=${selectedTicket.id}`,
    });
    setEditingTicket(false);
    toast.success(t('maint.ticketUpdated', 'Ticket updated'));
    await loadData();
  }

  async function handleDeleteTicket(tk: TicketRow) {
    if (!isAdmin) return;
    if (!window.confirm(t('maint.confirmDeleteTicket', { defaultValue: 'Delete ticket "{{name}}"? This permanently removes it and cannot be undone.', name: tk.equipment || tk.title }))) return;
    // Remove dependent store-request rows first (FK: maintenance_store_requests.ticket_id).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: srErr } = await (supabase.from('maintenance_store_requests') as any).delete().eq('ticket_id', tk.id);
    if (srErr) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: srErr.message })); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('maintenance_tickets') as any).delete().eq('id', tk.id);
    if (error) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: error.message })); return; }
    setTickets((prev) => prev.filter((x) => x.id !== tk.id));
    if (selectedTicket?.id === tk.id) { setSelectedTicket(null); setEditingTicket(false); }
    toast.success(t('maint.ticketDeleted', 'Ticket deleted'));
  }

  // ── Request Changes / Resubmit loop ─────────────────────────────────────────
  // Append-only audit entry on a ticket's Notes thread (also delivers @-mentions
  // + watcher notifications). This is the durable per-cycle history.
  async function auditNote(t: TicketRow, body: string) {
    const mentionIds = extractMentionIds(body, people);
    await postNote({ ref: ticketRef(t), actor: actorObj(), body, mentionIds, people, addNotification: addNote });
  }

  // Reviewer (unit head / admin): send the ticket back to the technician for
  // correction. The SAME record moves to 'changes_requested'; revision_prev_status
  // remembers the stage so Resubmit re-enters the exact review point.
  async function submitRequestChanges() {
    if (!selectedTicket || savingRevision) return;
    const reason = [changeTags.join(', '), changeReason.trim()].filter(Boolean).join(' — ');
    if (!reason) { toast.error(t('maint.addFixNote', 'Add a note on what needs fixing')); return; }
    setSavingRevision(true);
    try {
      const nowIso = new Date().toISOString();
      // Rejecting a *completed in-house repair* must send it back to the work
      // itself, not to the review point — the technician redoes the repair and
      // uploads a fresh completion photo. Every other stage resumes where it paused.
      const isInhouseVerify = selectedTicket.status === 'pending_unit_head'
        && ticketDecision(selectedTicket.title, storeReqs.length > 0) === 'inhouse';
      const prevStatus = isInhouseVerify ? 'in_progress' : selectedTicket.status;
      await updateRows('maintenance_tickets', {
        status: 'changes_requested',
        revision_prev_status: prevStatus,
        revision_reason: reason,
        revision_requested_by: activeProfile.name,
        revision_requested_at: nowIso,
        revision_count: (selectedTicket.revision_count ?? 0) + 1,
      }).eq('id', selectedTicket.id);
      await auditNote(selectedTicket, `🔁 Changes requested by ${activeProfile.name}: ${reason}`);
      // Notify all maintenance-capability roles + whoever raised it, so Request
      // Changes reaches capability-holders (not just the technician slug) and is
      // never a dead end.
      const changeTargets = Array.from(new Set([
        ...maintenanceRoleIds,
        'admin',
        'factory_operator',
        selectedTicket.raised_role,
      ].filter(Boolean) as string[]));
      notify({
        target_roles: changeTargets,
        title: `Changes requested: ${selectedTicket.equipment}`,
        body: reason,
        type: 'warning',
        route: maintRoute(selectedTicket.id),
        actor_name: activeProfile.name,
        actor_role: role,
        read_by: [],
        plant_id: selectedTicket.plant_id ?? null,
        unit_id: selectedTicket.unit_id ?? null,
      });
      await notifyTicketWatchers(selectedTicket, `Changes requested: ${selectedTicket.equipment}`, reason, 'warning');
      setSelectedTicket((t) => t ? { ...t, status: 'changes_requested', revision_prev_status: prevStatus, revision_reason: reason, revision_requested_by: activeProfile.name, revision_requested_at: nowIso, revision_count: (t.revision_count ?? 0) + 1 } : t);
      setRequestingChanges(false); setChangeReason(''); setChangeTags([]);
      toast.success(t('maint.sentBackToTechToast', 'Sent back for changes'));
      await loadData();
    } catch (e) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: e instanceof Error ? e.message : String(e) })); }
    finally { setSavingRevision(false); }
  }

  // Technician: open the revise form seeded from the current ticket.
  function startResubmit(t: TicketRow) {
    const assessment = /needs part/i.test(t.title || '') ? 'needs_part' : 'repairable';
    setResubmitForm({ equipment: t.equipment || '', description: t.description || '', plant: t.plant_id || '', assessment });
    setResubmitPhotoBlob(null);
    setResubmitting(true);
  }

  // Technician: apply the corrections and resubmit — status returns to the stage
  // it paused at so the reviewer picks up right where they left off.
  async function submitResubmit() {
    if (!selectedTicket || savingRevision) return;
    if (!resubmitForm.equipment.trim()) { toast.error(t('maint.equipmentRequired', 'Equipment is required')); return; }
    setSavingRevision(true);
    try {
      let newPhotoUrl: string | null = null;
      const priorPhoto = selectedTicket.defective_raise_photo_url;
      if (resubmitPhotoBlob) {
        setUploading(true);
        const r = await uploadMaintenancePhoto(resubmitPhotoBlob, { ticketId: selectedTicket.id, plantName: plantNameById.get(resubmitForm.plant) || selectedTicket.plants?.name || '', photoType: 'completion', creator: activeProfile.name });
        newPhotoUrl = r.secure_url;
        setUploading(false);
      }
      const plant = dbPlants.find((p) => p.id === resubmitForm.plant);
      const restoreStatus = (selectedTicket.revision_prev_status as TicketStatus) || 'open';
      const title = `${resubmitForm.equipment} — ${resubmitForm.assessment === 'repairable' ? 'Repairable' : 'Needs part'}`;
      const patch: TicketUpdate = {
        equipment: resubmitForm.equipment,
        title,
        description: resubmitForm.description || null,
        plant_id: plant?.id ?? selectedTicket.plant_id ?? null,
        status: restoreStatus,
        revision_reason: null,
      };
      if (newPhotoUrl) patch.defective_raise_photo_url = newPhotoUrl;
      await updateRows('maintenance_tickets', patch).eq('id', selectedTicket.id);
      const photoNote = newPhotoUrl ? ` · replaced photo${priorPhoto ? ` (prev: ${priorPhoto})` : ''}` : '';
      await auditNote(selectedTicket, `✅ Resubmitted by ${activeProfile.name} after revision${photoNote}`);
      await notifyMentions(resubmitForm.description, ticketRef(selectedTicket));
      notify({ target_roles: ['unit_head', 'admin'], title: `Ticket resubmitted: ${resubmitForm.equipment}`, body: `${activeProfile.name} updated the ticket and resubmitted it for review.`, type: 'info', route: maintRoute(selectedTicket.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: selectedTicket.plant_id ?? null, unit_id: selectedTicket.unit_id ?? null });
      await notifyTicketWatchers(selectedTicket, `Ticket resubmitted: ${resubmitForm.equipment}`, 'Updated and resubmitted for review', 'info');
      setSelectedTicket((t) => t ? { ...t, equipment: resubmitForm.equipment, title, description: resubmitForm.description || null, status: restoreStatus, revision_reason: null, plants: plant ? { name: plant.name } : t.plants, defective_raise_photo_url: newPhotoUrl ?? t.defective_raise_photo_url } : t);
      setResubmitting(false); setResubmitPhotoBlob(null);
      toast.success(t('maint.resubmittedForReview', 'Resubmitted for review'));
      await loadData();
    } catch (e) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: e instanceof Error ? e.message : String(e) })); setUploading(false); }
    finally { setSavingRevision(false); }
  }

  // Bulk-delete every emergency ticket currently shown (admin cleanup tool).
  async function handleDeleteAllEmergency() {
    if (!isAdmin) return;
    const ids = emergencyTickets.map((t) => t.id);
    if (!ids.length) return;
    if (!window.confirm(t('maint.confirmDeleteAllTickets', { defaultValue: 'Delete ALL {{count}} emergency tickets? This permanently removes every emergency ticket and cannot be undone.', count: ids.length }))) return;
    setDeletingAll(true);
    try {
      // Delete in chunks so a long id list doesn't blow the URL length limit.
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        // Remove dependent store-request rows first (FK: maintenance_store_requests.ticket_id).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: srErr } = await (supabase.from('maintenance_store_requests') as any).delete().in('ticket_id', chunk);
        if (srErr) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: srErr.message })); return; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase.from('maintenance_tickets') as any).delete().in('id', chunk);
        if (error) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: error.message })); return; }
      }
      setTickets((prev) => prev.filter((t) => !ids.includes(t.id)));
      setSelectedTicket(null); setEditingTicket(false);
      toast.success(t('maint.deletedNTickets', { defaultValue: 'Deleted {{count}} emergency tickets', count: ids.length }));
    } finally {
      setDeletingAll(false);
    }
  }

  // ── Admin: generate CSV maintenance report ──────────────────────────────────
  function reportTickets(): TicketRow[] {
    return tickets.filter((t) => {
      if (t.type === 'emergency' && !reportForm.emergency) return false;
      if (t.type === 'periodic' && !reportForm.periodic) return false;
      if (t.type !== 'emergency' && t.type !== 'periodic') return false;
      if (reportForm.status === 'open' && t.status === 'closed') return false;
      if (reportForm.status === 'closed' && t.status !== 'closed') return false;
      const created = (t.created_at || '').slice(0, 10);
      if (reportForm.from && created < reportForm.from) return false;
      if (reportForm.to && created > reportForm.to) return false;
      return true;
    });
  }

  async function generateReport() {
    if (generating) return;
    setGenerating(true);
    try {
      const rows = reportTickets();
      if (!rows.length) { toast.error(t('maint.noTicketsMatchFilters', 'No tickets match these filters')); return; }
      const ids = rows.map((t) => t.id);

      // Enrich each ticket with its full trail: store-request lifecycle,
      // watchers (who's tagged/following), and the notes/@-mention thread.
      const [srRes, wRes, nRes] = await Promise.all([
        supabase.from('maintenance_store_requests').select('*').in('ticket_id', ids).returns<StoreReqRow[]>(),
        supabase.from('entity_watchers').select('entity_id, profile_name, kind').eq('entity_type', 'maintenance_ticket').in('entity_id', ids).returns<{ entity_id: string; profile_name: string; kind: string }[]>(),
        supabase.from('entity_notes').select('*').eq('entity_type', 'maintenance_ticket').in('entity_id', ids).order('created_at', { ascending: true }).returns<EntityNoteRow[]>(),
      ]);

      const srBy = new Map<string, StoreReqRow>();
      (srRes.data ?? []).forEach((s) => { if (s.ticket_id && !srBy.has(s.ticket_id)) srBy.set(s.ticket_id, s); });

      const watchersBy = new Map<string, Set<string>>();
      (wRes.data ?? []).forEach((w) => {
        if (!watchersBy.has(w.entity_id)) watchersBy.set(w.entity_id, new Set());
        watchersBy.get(w.entity_id)!.add(w.profile_name);
      });

      const notes = nRes.data ?? [];
      const notesBy = new Map<string, EntityNoteRow[]>();
      notes.forEach((n) => {
        if (!notesBy.has(n.entity_id)) notesBy.set(n.entity_id, []);
        notesBy.get(n.entity_id)!.push(n);
      });

      const csvRows = rows.map((t) => {
        const sr = srBy.get(t.id);
        const created = t.created_at ? new Date(t.created_at).getTime() : null;
        const closedT = t.closed_at ? new Date(t.closed_at).getTime() : null;
        const days = created != null ? Math.max(0, Math.round(((closedT ?? Date.now()) - created) / 86400000)) : '';
        const how = t.status === 'closed'
          ? (t.defective_part_decision ? `Part replaced · old part ${t.defective_part_decision}` : sr ? 'Part from store' : 'Fixed in-house')
          : (sr ? 'Awaiting part / approval' : 'In progress');
        return {
          id: t.id,
          shortId: t.id.slice(0, 8),
          type: t.type,
          equipment: t.equipment || '',
          plant: t.plants?.name || '',
          issue: t.description || t.title || '',
          status: STATUS_CFG[t.status]?.label || t.status,
          stage: STAGE_LABELS[t.status] || '',
          raised_by: t.raised_by || '',
          raised_role: roleLabelFor(t.raised_role, roles),
          assigned_to: t.assigned_to || '',
          created: fmtDT(t.created_at),
          closed: fmtDT(t.closed_at),
          days,
          how,
          defective: t.defective_part_decision || '',
          part: sr?.part_name || '',
          qty: sr?.quantity ?? '',
          spec: sr?.specification || '',
          store_decision: sr?.store_decision || '',
          qty_in_store: sr?.qty_in_store ?? '',
          shelf: sr?.shelf_location || '',
          condition: sr?.part_condition || '',
          approval: sr?.unit_head_approval || '',
          busy: sr?.busy_transaction_ref || '',
          handover: fmtDT(sr?.handover_confirmed_at),
          handover_notes: sr?.handover_notes || '',
          tagged: [...(watchersBy.get(t.id) ?? new Set<string>())].join('; '),
          notes_count: (notesBy.get(t.id) ?? []).length,
        };
      });

      // Report metadata header (who generated it, when, and the filters used).
      const typeSel = [reportForm.emergency && 'Emergency', reportForm.periodic && 'Periodic'].filter(Boolean).join(' + ') || 'None';
      const statusSel = reportForm.status === 'all' ? 'All statuses' : reportForm.status === 'open' ? 'Open / in progress' : 'Closed only';
      const dateSel = (reportForm.from || reportForm.to) ? `${reportForm.from || '…'} → ${reportForm.to || '…'}` : 'All dates';
      const preamble: (string | number)[][] = [
        ['Suntek — Maintenance Report'],
        ['Generated by', `${activeProfile.name} (${activeProfile.roleLabel})`],
        ['Generated at', new Date().toLocaleString('en-IN')],
        ['Scope', `${typeSel} · ${statusSel} · ${dateSel}`],
        ['Total tickets', rows.length],
      ];

      exportToCsv(`maintenance-report-${today}`, REPORT_COLUMNS, csvRows, preamble);

      // Optional second CSV: the notes / @-mention activity timeline.
      if (reportForm.includeNotes && notes.length) {
        const eqById = new Map(rows.map((t) => [t.id, t.equipment || '']));
        const noteRows = notes.map((n) => ({
          id: n.entity_id,
          shortId: n.entity_id.slice(0, 8),
          equipment: eqById.get(n.entity_id) || '',
          note: n.body,
          author: n.author_name,
          tagged: people.filter((p) => (n.mentions || []).includes(p.id)).map((p) => p.name).join('; '),
          at: fmtDT(n.created_at),
        }));
        exportToCsv(`maintenance-activity-${today}`, NOTE_COLUMNS, noteRows, preamble);
      }

      toast.success(t('maint.reportReady', { defaultValue: 'Report ready · {{count}} tickets exported', count: csvRows.length }));
      setShowReport(false);
    } catch (err) {
      toast.error(t('maint.reportFailedMsg', { defaultValue: 'Report failed: {{message}}', message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setGenerating(false);
    }
  }

  // Advance a schedule to its next occurrence — calendar-anchored, rolls forward if
  // behind, and self-deactivates once the "continue until" date is passed.
  async function advanceSchedule(s: ScheduleRow) {
    let nextDue = calculateNextDue(s.frequency, s.next_due_at || undefined);
    let guard = 0;
    while (new Date(nextDue) < new Date() && guard++ < 400) nextDue = calculateNextDue(s.frequency, nextDue);
    const ended = !!s.until_date && new Date(nextDue) > new Date(`${s.until_date}T23:59:59`);
    await updateRows('maintenance_schedules', { last_completed_at: new Date().toISOString(), next_due_at: nextDue, ...(ended ? { is_active: false } : {}) }).eq('id', s.id);
  }

  async function handleCompletePeriodicTicket() {
    if (!completingSchedule || !completionBlob) return;
    setUploading(true);
    try {
      const requiresApproval = completingSchedule.requires_approval ?? (completingSchedule.frequency !== 'daily');
      let ticket = tickets.find(t => t.schedule_id === completingSchedule.id && t.status !== 'closed');
      if (!ticket) {
        const { data } = await insertRows('maintenance_tickets', {
          type: 'periodic', status: 'open', title: completingSchedule.title,
          equipment: completingSchedule.equipment, plant_id: completingSchedule.plant_id || null,
          schedule_id: completingSchedule.id,
          far_asset_id: completingSchedule.far_asset_id || null, // inherit the schedule's asset link
          due_date: completingSchedule.next_due_at ? completingSchedule.next_due_at.split('T')[0] : null,
          raised_by: activeProfile.name, raised_role: role,
          assigned_to: completingSchedule.assigned_to || null,
          checklist: completionChecklist,
          requires_approval: requiresApproval,
        }).select('*, plants(name)').single();
        ticket = data ?? undefined;
      }
      if (!ticket) throw new Error('Could not create ticket');
      const result = await uploadMaintenancePhoto(completionBlob, {
        ticketId: ticket.id, plantName: ticket.plants?.name || completingSchedule.plants?.name || 'Plant',
        photoType: 'completion', creator: activeProfile.name, onProgress: setUploadPct,
      });
      if (requiresApproval) {
        // ≥ weekly → technician submits; the unit head must verify before it closes.
        await updateRows('maintenance_tickets', { status: 'pending_unit_head', completion_photo_url: result.secure_url, checklist: completionChecklist, assigned_to: completingSchedule.assigned_to || activeProfile.name }).eq('id', ticket.id);
        notify({
          target_roles: ['unit_head', 'admin'],
          title: `Verify maintenance: ${completingSchedule.title}`,
          body: `${completingSchedule.equipment} · completed by ${activeProfile.name} · awaiting verification`,
          type: 'warning', route: `/dashboard/purchase/maint?ticket=${ticket.id}`,
          actor_name: activeProfile.name, actor_role: role, read_by: [],
          plant_id: completingSchedule.plant_id ?? null, unit_id: null,
        });
      } else {
        // Daily → auto-close on submit + advance immediately.
        await updateRows('maintenance_tickets', { status: 'closed', completion_photo_url: result.secure_url, closed_at: new Date().toISOString(), checklist: completionChecklist, assigned_to: completingSchedule.assigned_to || activeProfile.name }).eq('id', ticket.id);
        await advanceSchedule(completingSchedule);
        notify({
          target_roles: ['admin', 'unit_head'],
          title: `Periodic done: ${completingSchedule.title}`,
          body: `${completingSchedule.equipment} · By ${activeProfile.name}`,
          type: 'info', route: maintRoute(ticket?.id),
          actor_name: activeProfile.name, actor_role: role, read_by: [],
          plant_id: completingSchedule.plant_id ?? null, unit_id: null,
        });
      }
      setCompletingSchedule(null); setCompletionBlob(null); setUploadPct(0); setCompletionChecklist([]);
      await loadData();
    } catch (err) { toast.error(t('maint.uploadFailedMsg', { defaultValue: 'Upload failed: {{message}}', message: err instanceof Error ? err.message : String(err) })); }
    finally { setUploading(false); }
  }

  // Unit-head verification of a submitted (≥weekly) periodic ticket.
  async function verifyPeriodicTicket(ticket: TicketRow, approve: boolean) {
    const sched = schedules.find(s => s.id === ticket.schedule_id);
    try {
      if (approve) {
        await updateRows('maintenance_tickets', { status: 'closed', closed_at: new Date().toISOString() }).eq('id', ticket.id);
        if (sched) await advanceSchedule(sched);
        notify({ target_roles: [...maintenanceRoleIds, 'admin'], title: `Maintenance verified: ${ticket.title}`, body: `${ticket.equipment} · verified by ${activeProfile.name}`, type: 'info', route: maintRoute(ticket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: ticket.plant_id ?? null, unit_id: null });
        toast.success(t('maint.verifiedClosed', 'Verified & closed'));
      } else {
        await updateRows('maintenance_tickets', { status: 'open' }).eq('id', ticket.id);
        notify({ target_roles: [...maintenanceRoleIds, 'admin'], title: `Maintenance sent back: ${ticket.title}`, body: `${ticket.equipment} · ${activeProfile.name} asked for rework`, type: 'warning', route: maintRoute(ticket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: ticket.plant_id ?? null, unit_id: null });
        toast.success(t('maint.sentBackForRework', 'Sent back for rework'));
      }
      setVerifyingTicket(null);
      await loadData();
    } catch (e) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: e instanceof Error ? e.message : String(e) })); }
  }

  async function handleRaiseStoreReq() {
    const items = storeItems
      .map(it => ({ ...it, partName: it.partName.trim() }))
      .filter(it => it.partName);
    if (!items.length || !selectedTicket || actionBusyRef.current) return;
    actionBusyRef.current = true;
    try {
    const plant = dbPlants.find(p => p.id === selectedTicket.plant_id);
    // One store-request row per item — a ticket can need several parts at once.
    const rows = items.map(it => ({
      ticket_id: selectedTicket.id, part_name: it.partName,
      quantity: parseFloat(it.quantity) || null,
      unit: it.unit || 'Units',
      specification: it.specification || null,
      // The two answers are deliberately separate columns:
      //   plant_id        → the REQUESTING factory: who asked, and who pays
      //   source_store_id → the store the part comes OUT of
      // At Rehla these differ (three factories, one shared store); everywhere
      // else they resolve to the same site, which is why nothing changes there.
      plant_id: plant?.id || selectedTicket.plant_id || null,
      source_store_id: storeIdFor(selectedTicket.plant_id),
      store_item_id: it.storeItemId || null,
    }));
    await insertRows('maintenance_store_requests', rows);
    await updateTicketStatus(selectedTicket.id, 'pending_store');
    setSelectedTicket((t) => t ? { ...t, status: 'pending_store' } : t);
    // One store per factory (shared at Rehla), so one store-manager audience.
    // Do NOT plant-scope this alert — store managers often sit on a different
    // plant/unit scope than the requesting factory; plant_id filtering was
    // hiding indents from Store / Unit Head (meeting issue 3.2).
    const storeTargets = ['admin', 'store_manager_maint', 'warehouse_manager', 'unit_head'];
    const names = items.map(i => i.partName).join(', ');
    notify({
      target_roles: storeTargets,
      title: `Store parts needed: ${items.length} item${items.length > 1 ? 's' : ''}`,
      body: `${selectedTicket.equipment} · ${names} · Check availability`,
      type: 'warning', route: maintRoute(selectedTicket?.id),
      actor_name: activeProfile.name, actor_role: role, read_by: [],
      plant_id: null,
      unit_id: null,
    });
    await notifyMentions(items.map(i => i.specification).filter(Boolean).join(' '), {
      entityType: 'maintenance_ticket', entityId: selectedTicket.id,
      entityLabel: selectedTicket.equipment || 'Ticket', route: `/dashboard/purchase/maint?ticket=${selectedTicket.id}`,
    });
    setShowStoreForm(false);
    setStoreItems([{ ...BLANK_ITEM }]);
    await loadStoreReqs(selectedTicket.id);
    await loadData();
    } finally { actionBusyRef.current = false; }
  }


  async function startRepair() {
    if (!selectedTicket) return;
    await updateTicketStatus(selectedTicket.id, 'in_progress', { assigned_to: activeProfile.name });
    setSelectedTicket((t) => t ? { ...t, status: 'in_progress' } : t);
    await notifyTicketWatchers(selectedTicket, `Repair started: ${selectedTicket.equipment}`, `${activeProfile.name} started fixing it in-house.`);
    await loadData();
  }

  // Technician finishes an in-house repair. This does NOT close the ticket: the
  // completion photo goes to the unit head, who is the only one who can close it.
  // Previously this wrote 'closed' directly, so an in-house repair was the one path
  // in the module that no reviewer ever saw.
  async function closeInHouse() {
    if (!selectedTicket || !completionBlob) return;
    setUploading(true);
    try {
      const result = await uploadMaintenancePhoto(completionBlob, {
        ticketId: selectedTicket.id, plantName: selectedTicket.plants?.name || 'Plant',
        photoType: 'completion', creator: activeProfile.name, onProgress: setUploadPct,
      });
      await updateTicketStatus(selectedTicket.id, 'pending_unit_head', {
        completion_photo_url: result.secure_url,
      });
      notify({
        target_roles: ['unit_head', 'admin'],
        title: `Verify repair: ${selectedTicket.equipment}`,
        body: `Fixed in-house by ${activeProfile.name} · awaiting your verification`,
        type: 'warning', route: maintRoute(selectedTicket?.id),
        actor_name: activeProfile.name, actor_role: role, read_by: [],
        plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id,
      });
      await notifyTicketWatchers(selectedTicket, `Awaiting verification: ${selectedTicket.equipment}`, `${activeProfile.name} finished the in-house repair — sent to the unit head to verify.`, 'warning');
      setSelectedTicket((tk) => tk ? { ...tk, status: 'pending_unit_head', completion_photo_url: result.secure_url } : tk);
      setCompletionBlob(null); setUploadPct(0);
      toast.success(t('maint.sentForVerification', 'Sent for verification'));
      await loadData();
    } catch (err) { toast.error(t('maint.uploadFailedMsg', { defaultValue: 'Upload failed: {{message}}', message: err instanceof Error ? err.message : String(err) })); }
    finally { setUploading(false); }
  }

  // Unit head / admin verifies a completed in-house repair. Approving is what
  // finally closes the ticket; sending back reuses the Request Changes form so
  // the rejection carries a written reason (submitRequestChanges rewinds an
  // in-house ticket to 'in_progress', i.e. redo the work + new photo).
  async function verifyInHouse() {
    if (!selectedTicket || actionBusyRef.current) return;
    actionBusyRef.current = true;
    try {
      const closedAt = new Date().toISOString();
      await updateTicketStatus(selectedTicket.id, 'closed', { closed_at: closedAt });
      await auditNote(selectedTicket, `✅ In-house repair verified & closed by ${activeProfile.name}`);
      notify({
        target_roles: [...maintenanceRoleIds, 'admin'],
        title: `Repair verified: ${selectedTicket.equipment}`,
        body: `Verified & closed by ${activeProfile.name}`,
        type: 'info', route: maintRoute(selectedTicket?.id),
        actor_name: activeProfile.name, actor_role: role, read_by: [],
        plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id,
      });
      await notifyTicketWatchers(selectedTicket, `Ticket closed: ${selectedTicket.equipment}`, `In-house repair verified by ${activeProfile.name}.`);
      setSelectedTicket((tk) => tk ? { ...tk, status: 'closed', closed_at: closedAt } : tk);
      toast.success(t('maint.verifiedClosed', 'Verified & closed'));
      await loadData();
    } catch (e) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: e instanceof Error ? e.message : String(e) })); }
    finally { actionBusyRef.current = false; }
  }

  // Store manager submits availability decision with full part details
  // Reload all items + roll the ticket status up from their per-item stages.
  async function refreshAfterItemChange() {
    if (!selectedTicket) return;
    const { data } = await supabase.from('maintenance_store_requests')
      .select('*').eq('ticket_id', selectedTicket.id).order('created_at', { ascending: true })
      .returns<StoreReqRow[]>();
    const reqs = data || [];
    setStoreReqs(reqs);
    const next = rollupStatus(reqs, selectedTicket.status);
    if (next !== selectedTicket.status) {
      await updateTicketStatus(selectedTicket.id, next);
      setSelectedTicket((t) => t ? { ...t, status: next } : t);
    }
    await loadData();
  }

  async function submitStoreDecision(req: StoreReqRow) {
    if (!selectedTicket || storeDecisionForm.available === null || actionBusyRef.current) return;
    const available = storeDecisionForm.available;
    const regQty = storeDecisionForm.registerQty;
    const enteredQty = available ? (parseFloat(storeDecisionForm.qtyInStore) || 0) : null;
    // The register is the default; overriding its quantity needs a justification.
    const overrode = available && regQty != null && enteredQty != null && enteredQty !== regQty;
    if (overrode && !storeDecisionForm.qtyJustification.trim()) {
      toast.error(t('maint.qtyDiffersJustify', 'Your count differs from the register — please add a justification.'));
      return;
    }
    actionBusyRef.current = true;   // guard against a double-submit creating two shortfall rows
    try {
    // ── Partial fulfilment: if the store can't cover the full request, issue what
    // it has and route the shortfall (requested − available) to procurement. This
    // is what keeps stock from ever going negative. The two rows share a
    // split_group so the UI shows them as two parallel tracks of one part. ───────
    const requestedQty = Number(req.quantity) || 0;
    const availQty = enteredQty ?? 0;
    const fulfilledQty = available ? (requestedQty > 0 ? Math.min(availQty, requestedQty) : availQty) : 0;
    const shortfall = available && requestedQty > availQty ? requestedQty - availQty : 0;
    const splitGroup = shortfall > 0 ? req.id : null;

    await updateRows('maintenance_store_requests', {
        store_decision: available ? 'available' : 'unavailable',
        purchase_required: !available,
        // when split, this row now represents only the part issued from store
        quantity: available ? fulfilledQty : requestedQty,
        qty_in_store: available ? availQty : null,
        shelf_location: available ? (storeDecisionForm.shelfLocation || null) : null,
        part_condition: available ? storeDecisionForm.partCondition : null,
        ...(splitGroup ? { split_group: splitGroup } : {}),
      })
      .eq('id', req.id);

    // Create the ONE procurement row for the shortfall → external procurement path.
    if (shortfall > 0) {
      await insertRows('maintenance_store_requests', {
        ticket_id: selectedTicket.id, part_name: req.part_name, quantity: shortfall,
        specification: `${req.specification ? req.specification + ' · ' : ''}Shortfall — ${shortfall} of ${requestedQty} not in store`,
        // The shortfall row is still a request from THIS factory against the
        // SAME store — a partial fulfilment does not change where the part
        // comes from. Set explicitly rather than leaning on the DB trigger
        // (migration 65), so the intent is visible at the call site.
        plant_id: selectedTicket.plant_id,
        source_store_id: storeIdFor(selectedTicket.plant_id),
        store_item_id: req.store_item_id ?? null,
        store_decision: 'unavailable', purchase_required: true, split_group: splitGroup,
      });
      notify({
        target_roles: ['admin', 'unit_head'],
        title: `Partial stock — procure ${shortfall}× ${req.part_name}`,
        body: `${fulfilledQty} issued from store, ${shortfall} short → procurement. Awaiting unit head approval.`,
        type: 'warning', route: maintRoute(selectedTicket?.id),
        actor_name: activeProfile.name, actor_role: role, read_by: [],
        plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id,
      });
    }
    // Record a register-override so admins can reconcile file vs physical count.
    if (overrode) {
      if (req.store_item_id) {
        await insertRows('store_stock_events', {
          item_id: req.store_item_id, plant_id: selectedTicket.plant_id, event_type: 'manual_edit',
          // Where it moved / who it was for — a movement missing either is
          // invisible to the per-factory reconciliation.
          store_id: storeIdFor(selectedTicket.plant_id),
          requesting_plant_id: selectedTicket.plant_id,
          qty_delta: (enteredQty as number) - (regQty as number), on_hand_after: null,
          ref: `store-check · ticket ${selectedTicket.id.slice(0, 8)}`,
          justification: `Register ${regQty} → counted ${enteredQty}. ${storeDecisionForm.qtyJustification.trim()}`,
          actor_name: activeProfile.name,
        });
      }
      await insertRows('activity_logs', {
        equipment: `Stock check: ${req.part_name}`, type: 'stock_check_override',
        date: new Date().toISOString().slice(0, 10), done_by: activeProfile.name, plant_id: selectedTicket.plant_id,
        note: `Register said ${regQty}, store counted ${enteredQty}. ${storeDecisionForm.qtyJustification.trim()}`,
      });
    }
    notify({
      target_roles: ['admin', 'unit_head'],
      title: available ? `Part available: ${req.part_name}` : `Part not in store: ${req.part_name}`,
      body: available
        ? `Issuing ${fulfilledQty} from store${shortfall > 0 ? ` (${shortfall} short → procurement)` : ''}${overrode ? ` · register ${regQty}: ${storeDecisionForm.qtyJustification.trim()}` : ''} · Shelf: ${storeDecisionForm.shelfLocation || '—'} · Awaiting unit head approval`
        : `${selectedTicket.equipment} — external procurement needed. Awaiting unit head approval.`,
      type: available ? 'info' : 'warning', route: maintRoute(selectedTicket?.id),
      actor_name: activeProfile.name, actor_role: role, read_by: [],
      plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id,
    });
    setStoreDecisionForm({ ...BLANK_STORE_DECISION });
    setActingReqId(null);
    await refreshAfterItemChange();
    } finally { actionBusyRef.current = false; }
  }

  async function unitHeadApprove(req: StoreReqRow, approved: boolean) {
    if (!selectedTicket) return;
    const partAvailable = req.store_decision === 'available';
    const reason = rejectReason.trim(); // optional note when rejecting this part
    await updateRows('maintenance_store_requests', { unit_head_approval: approved ? 'approved' : 'rejected' })
      .eq('id', req.id);

    // Claim (or give back) the stock this decision commits.
    //
    // Stock only leaves the register at handover, so without a reservation
    // three technicians drawing on the SAME shared Rehla row can each be told
    // "1 in stock" for the same last unit and two of them find it gone. The
    // reservation is per request, so approving here cannot consume another
    // ticket's claim. Best-effort: a failure here must not block the approval
    // the unit head has already made.
    if (req.store_item_id && partAvailable) {
      const qty = Number(req.quantity) || 0;
      if (qty > 0) {
        const { error: resErr } = await (supabase.rpc as any)('issue_store_item', {
          payload: {
            action: approved ? 'reserve' : 'release',
            store_item_id: req.store_item_id,
            store_request_id: req.id,
            qty,
            requesting_plant_id: selectedTicket.plant_id,
            ref: `ticket ${selectedTicket.id.slice(0, 8)}`,
            actor_name: activeProfile.name,
          },
        });
        // eslint-disable-next-line no-console
        if (resErr) console.error('[Maintenance] stock reservation failed:', resErr);
      }
    }

    if (approved && partAvailable) {
      notify({ target_roles: ['store_manager_maint', 'warehouse_manager', ...maintenanceRoleIds], title: `Approved: hand over ${req.part_name}`, body: `Unit head approved. Store manager to hand part to technician.`, type: 'info', route: maintRoute(selectedTicket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id });
    } else if (approved && !partAvailable) {
      notify({ target_roles: ['admin', 'unit_head'], title: `Procurement approved: ${req.part_name}`, body: `${selectedTicket.equipment} — procure from market. Enter BUSY ref when done.`, type: 'warning', route: maintRoute(selectedTicket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id });
    } else {
      notify({ target_roles: [...maintenanceRoleIds, 'admin'], title: `Item rejected: ${req.part_name}`, body: reason ? `Unit head rejected this item: ${reason}` : `Unit head rejected this item.`, type: 'warning', route: maintRoute(selectedTicket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id });
      // Keep the reason on the ticket's audit thread.
      await auditNote(selectedTicket, `⛔ Part rejected by ${activeProfile.name}: "${req.part_name}"${reason ? ` — ${reason}` : ''}`);
    }
    await notifyTicketWatchers(selectedTicket, approved ? `Approved: ${selectedTicket.equipment}` : `Item rejected: ${selectedTicket.equipment}`, `${activeProfile.name} ${approved ? 'approved' : 'rejected'} "${req.part_name}".`);
    setActingReqId(null);
    setRejectReason('');
    await refreshAfterItemChange();
  }

  async function markPurchased(req: StoreReqRow) {
    if (!selectedTicket || !busyRef.trim()) return;
    const supplier = supplierName.trim();
    const need = Number(req.quantity) || 0;
    // Bulk buy: default to the shortfall, but they can buy more (excess → stock on handover).
    const bought = Math.max(need, parseFloat(purchaseQty) || need);
    await updateRows('maintenance_store_requests', { busy_transaction_ref: busyRef, supplier_name: supplier || null, purchased_qty: bought })
      .eq('id', req.id);
    notify({ target_roles: ['purchase_manager', 'admin'], title: `Procured — Purchase Manager to bill: ${req.part_name}`, body: `BUSY ref: ${busyRef}${supplier ? ` · ${supplier}` : ''} — Purchase Manager to upload the bill.`, type: 'info', route: maintRoute(selectedTicket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: selectedTicket?.plant_id ?? null, unit_id: selectedTicket?.unit_id ?? null });
    if (supplier) {
      const hits = await screenBlacklist([{ value: supplier, label: 'Supplier' }], { workflow: 'Maintenance Procurement', source: 'entry', entityLabel: selectedTicket.equipment });
      if (hits.length) { const h = hits[0]; toast.error(t('maint.blacklistSupplierToast', { defaultValue: '⚠ Supplier "{{value}}" ≈ blacklisted {{type}} "{{name}}" ({{pct}}%). Admin notified.', value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) })); }
    }
    setBusyRef(''); setSupplierName(''); setPurchaseQty(''); setActingReqId(null);
    await refreshAfterItemChange();
  }

  // Purchase Manager: ONE aggregate bill for all externally-procured items on this
  // ticket. PM declares # items + total; we OCR the bill and FLAG (never block) a
  // mismatch. Procured items are marked billed → they move to handover.
  async function submitPurchaseManagerBill() {
    if (!selectedTicket || !dispatchBlob) return;
    const declaredItems = parseInt(pmForm.itemsCount, 10);
    const declaredTotal = parseFloat(pmForm.billTotal.replace(/[^0-9.]/g, ''));
    if (!declaredItems || !declaredTotal) { toast.error(t('maint.enterItemsAndTotal', 'Enter the number of items and the total bill amount.')); return; }
    setUploading(true);
    setBusyPhase('verifying');
    try {
      // OCR the bill (best-effort) — this never blocks submission.
      let ocrTotal: number | null = null, ocrItems: number | null = null, ocrStatus = 'unread';
      let ocrRaw: unknown = null, mismatch = false;
      let ocrLines: SupplierBillLine[] = [];
      try {
        const file = new File([dispatchBlob], 'bill.jpg', { type: dispatchBlob.type || 'image/jpeg' });
        const dataUrl = await resizeImageToDataUrl(file, 1600);
        const ocr = await extractSupplierBill(dataUrl);
        // Robust grand total: prefer subTotal + tax so the model can't report the tax
        // figure (or a subtotal) as the invoice total; fall back to its totalAmount.
        const ocrGrand = (ocr.subTotal != null && ocr.taxAmount != null) ? ocr.subTotal + ocr.taxAmount : ocr.totalAmount;
        ocrTotal = ocrGrand; ocrItems = ocr.lineItemCount; ocrRaw = ocr;
        ocrLines = ocr.lineItems || [];
        // Verify against the bill's DECLARED TOTAL (the reliable summary), NOT the count
        // of detected rows. "Number of items" is ambiguous (line rows vs total quantity),
        // so the line-item count is recorded for info only and never fails the check.
        const totalOff = ocrTotal != null && Math.abs(ocrTotal - declaredTotal) > Math.max(1, declaredTotal * 0.05);
        mismatch = !!totalOff;
        ocrStatus = ocrTotal == null ? 'unread' : (mismatch ? 'mismatch' : 'match');
      } catch { ocrStatus = 'unread'; }

      setBusyPhase('uploading'); setUploadPct(0);
      const r = await uploadMaintenancePhoto(dispatchBlob, {
        ticketId: selectedTicket.id, plantName: selectedTicket.plants?.name || 'Plant',
        photoType: 'bill', creator: activeProfile.name, onProgress: setUploadPct,
      });

      const billedAt = new Date().toISOString();
      await updateRows('maintenance_tickets', {
        pm_items_count: declaredItems, pm_bill_total: declaredTotal, pm_bill_url: r.secure_url,
        pm_billed_by: activeProfile.name, pm_billed_at: billedAt,
        pm_ocr_total: ocrTotal, pm_ocr_items: ocrItems, pm_ocr_status: ocrStatus, pm_ocr_raw: ocrRaw, pm_mismatch: mismatch,
      }).eq('id', selectedTicket.id);
      setSelectedTicket((t) => t ? { ...t, pm_items_count: declaredItems, pm_bill_total: declaredTotal, pm_bill_url: r.secure_url, pm_billed_by: activeProfile.name, pm_billed_at: billedAt, pm_ocr_total: ocrTotal, pm_ocr_items: ocrItems, pm_ocr_status: ocrStatus, pm_mismatch: mismatch } : t);

      // Mark all procured-but-unbilled items as billed → they move to handover.
      const procured = storeReqs.filter(sr => itemStage(sr) === 'purchase_manager');
      for (const sr of procured) {
        // Attribute this requested part's cost from the bill's matching line item, so the
        // Maintenance Purchase record shows the item-specific unit price + total. The full
        // invoice total stays on the ticket (pm_bill_total) for FAR — unchanged.
        const line = ocrLines.length ? matchBillLine(sr.part_name, ocrLines) : null;
        const patch: Record<string, unknown> = { bill_verified: true, handover_invoice_url: r.secure_url };
        if (line?.unitPrice != null) {
          patch.unit_price = line.unitPrice;
          // Cost for the actually-procured quantity (not the full invoice line, which may
          // cover more units than this ticket needed).
          patch.total_price = sr.quantity != null ? line.unitPrice * Number(sr.quantity) : (line.amount ?? null);
        } else if (line?.amount != null) {
          patch.total_price = line.amount;
        }
        await updateRows('maintenance_store_requests', patch).eq('id', sr.id);
      }
      notify({ target_roles: ['store_manager_maint', 'warehouse_manager', 'admin'], title: `Bill uploaded — ${procured.length} item(s) en route`, body: `${activeProfile.name} billed ₹${declaredTotal.toLocaleString('en-IN')} for ${declaredItems} item(s).`, type: 'info', route: maintRoute(selectedTicket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: selectedTicket?.plant_id ?? null, unit_id: selectedTicket?.unit_id ?? null });

      if (mismatch) {
        const ocrTotalTxt = ocrTotal != null ? `₹${ocrTotal.toLocaleString('en-IN')}` : '₹?';
        toast.error(t('maint.billMismatchToast', { defaultValue: '⚠ Bill total mismatch — you entered ₹{{declared}}, OCR read {{ocr}}. Submitted, but admin has been notified to verify.', declared: declaredTotal.toLocaleString('en-IN'), ocr: ocrTotalTxt }));
        notify({ target_roles: ['admin', 'unit_head'], title: `⚠ Bill total mismatch flagged: ${selectedTicket.equipment}`, body: `${activeProfile.name} declared ₹${declaredTotal.toLocaleString('en-IN')} (${declaredItems} line item${declaredItems === 1 ? '' : 's'}); OCR read ${ocrTotalTxt}. Please verify the bill.`, type: 'urgent', route: maintRoute(selectedTicket?.id), actor_name: activeProfile.name, actor_role: role, read_by: [], plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id });
      }
      await notifyTicketWatchers(selectedTicket, `Bill uploaded: ${selectedTicket.equipment}`, `${activeProfile.name} uploaded the supplier bill — items en route to store.`);
      setDispatchBlob(null); setUploadPct(0); setPmForm({ itemsCount: '', billTotal: '' });
      await refreshAfterItemChange();
    } catch (err) { toast.error(t('maint.uploadFailedMsg', { defaultValue: 'Upload failed: {{message}}', message: err instanceof Error ? err.message : String(err) })); }
    finally { setUploading(false); setBusyPhase('uploading'); }
  }

  // Store manager: confirm physical handover to technician.
  // Procured items carry a supplier bill (invoice photo); items issued from the
  // store's own stock have no bill — the manager writes a short description instead.
  async function confirmHandover(req: StoreReqRow) {
    if (!selectedTicket) return;
    const fromOwnStore = req.store_decision === 'available';
    if (fromOwnStore) {
      if (!handoverNotes.trim() && !handoverPhotoBlob) { toast.error(t('maint.handoverNeedDescription', "Please add a short description (why you're providing this part) or a part photo before confirming handover.")); return; }
    } else if (!handoverInvoiceBlob && !handoverPhotoBlob) {
      toast.error(t('maint.handoverNeedInvoice', 'Please upload at least the invoice or part photo before confirming handover.')); return;
    }
    setUploading(true);
    try {
      let invoiceUrl: string | null = null;
      let photoUrl: string | null = null;
      if (handoverInvoiceBlob) {
        const r = await uploadMaintenancePhoto(handoverInvoiceBlob, {
          ticketId: selectedTicket.id, plantName: selectedTicket.plants?.name || 'Plant',
          photoType: 'bill', creator: activeProfile.name, onProgress: pct => setUploadPct(Math.round(pct / 2)),
        });
        invoiceUrl = r.secure_url;
      }
      if (handoverPhotoBlob) {
        const r = await uploadMaintenancePhoto(handoverPhotoBlob, {
          ticketId: selectedTicket.id, plantName: selectedTicket.plants?.name || 'Plant',
          photoType: 'completion', creator: activeProfile.name, onProgress: pct => setUploadPct(50 + Math.round(pct / 2)),
        });
        photoUrl = r.secure_url;
      }
      await updateRows('maintenance_store_requests', {
          ...(invoiceUrl ? { handover_invoice_url: invoiceUrl } : {}),
          ...(photoUrl ? { handover_photo_url: photoUrl } : {}),
          ...(handoverNotes.trim() ? { handover_notes: handoverNotes } : {}),
          handover_confirmed_at: new Date().toISOString(),
          bill_verified: true,
        })
        .eq('id', req.id);

      // Decrement the store register: an own-store part linked to a stock item
      // leaves the store on handover → issued_qty ↑, on_hand ↓, with an audit event.
      if (req.store_item_id) {
        const qty = Number(req.quantity) || 0;
        if (fromOwnStore && qty > 0) {
          // In-store track: issue from the register through the atomic RPC.
          //
          // This used to be a client-side read-modify-write (select on_hand →
          // compute → update). Two handovers of the same item both read 10,
          // both wrote 5, and five units went missing from the books. With a
          // private register per factory that race was rare; with three Rehla
          // factories drawing on ONE row it is the normal case. issue_store_item
          // does the read, the clamp, the reservation release and the audit
          // event inside a single transaction under SELECT … FOR UPDATE.
          const { data: res, error: issueErr } = await (supabase.rpc as any)('issue_store_item', {
            payload: {
              action: 'issue',
              store_item_id: req.store_item_id,
              store_request_id: req.id,
              qty,
              requesting_plant_id: selectedTicket.plant_id,
              ref: `ticket ${selectedTicket.id.slice(0, 8)}`,
              justification: `Handed over to technician · ${req.part_name}`,
              actor_name: activeProfile.name,
            },
          });
          if (issueErr) throw issueErr;
          // The RPC clamps to what was actually on hand — say so rather than
          // letting the technician assume the full quantity was issued.
          const short = Number(res?.short ?? 0);
          if (short > 0) {
            toast.error(t('maint.issuedShort', {
              defaultValue: 'Only {{applied}} of {{requested}} {{part}} were in stock — {{short}} still outstanding.',
              applied: Number(res?.applied ?? 0), requested: qty, part: req.part_name, short,
            }));
          }
        } else if (!fromOwnStore) {
          // Procurement track: `qty` units were bought for the ticket (handed to the
          // technician — recorded in ticket_procured_qty for visibility, does NOT change
          // on_hand). Any BULK excess over the ticket need goes into the store (on_hand ↑).
          const bought = Number(req.purchased_qty) || qty;
          const excess = Math.max(0, bought - qty);
          const { data: si } = await (supabase.from('store_items') as any).select('*').eq('id', req.store_item_id).single();
          if (si) {
            const newOnHand = Number(si.on_hand) + excess;
            await (supabase.from('store_items') as any).update({
              ticket_procured_qty: Number(si.ticket_procured_qty || 0) + qty,
              procured_qty: Number(si.procured_qty) + excess,
              on_hand: newOnHand, updated_at: new Date().toISOString(),
            }).eq('id', req.store_item_id);
            await insertRows('store_stock_events', {
              item_id: req.store_item_id, plant_id: selectedTicket.plant_id, event_type: 'procure',
              // Both facts, so the same row feeds a consolidated store report
              // AND a per-factory consumption/cost report.
              store_id: storeIdFor(selectedTicket.plant_id),
              requesting_plant_id: selectedTicket.plant_id,
              qty_delta: bought, on_hand_after: newOnHand, ref: req.busy_transaction_ref || `ticket ${selectedTicket.id.slice(0, 8)}`,
              justification: `Procured ${bought} · ${qty} handed to technician${excess > 0 ? `, ${excess} added to stock` : ''} · ${req.part_name}`,
              actor_name: activeProfile.name,
            });
          }
        }
      }
      notify({
        target_roles: [...maintenanceRoleIds, 'admin', 'unit_head'],
        title: `Part handed over: ${req.part_name}`,
        body: `${activeProfile.name} confirmed handover of "${req.part_name}".`,
        type: 'info', route: maintRoute(selectedTicket?.id),
        actor_name: activeProfile.name, actor_role: role, read_by: [],
        plant_id: selectedTicket?.plant_id ?? null, unit_id: selectedTicket?.unit_id ?? null,
      });
      await notifyMentions(handoverNotes, {
        entityType: 'maintenance_ticket', entityId: selectedTicket.id,
        entityLabel: selectedTicket.equipment || 'Ticket', route: `/dashboard/purchase/maint?ticket=${selectedTicket.id}`,
      });
      setHandoverInvoiceBlob(null); setHandoverPhotoBlob(null); setHandoverNotes(''); setUploadPct(0); setActingReqId(null);
      await refreshAfterItemChange();
    } catch (err) { toast.error(t('maint.uploadFailedMsg', { defaultValue: 'Upload failed: {{message}}', message: err instanceof Error ? err.message : String(err) })); }
    finally { setUploading(false); }
  }

  async function submitDefectiveReturn() {
    if (!selectedTicket || !defectiveBlob) return;
    // Client-side mirror of the DB rule: every removed part must be accounted
    // for as either repair or scrap before the ticket can close.
    const splitErrors = validateSplit(defectiveLines);
    if (splitErrors.length) {
      const first = splitErrors[0];
      toast.error(first.code === 'unbalanced' && first.difference != null
        ? t('maint.splitErrUnbalanced', {
            defaultValue: '{{part}}: repair + scrap must equal the {{replaced}} replaced ({{n}} unaccounted for).',
            part: first.partName ?? '', replaced: defectiveLines[first.index]?.replacedQty ?? 0,
            n: Math.abs(first.difference),
          })
        : t('maint.splitErrInvalid', 'Check the repair / scrap quantities before closing.'));
      return;
    }
    setUploading(true);
    try {
      const result = await uploadMaintenancePhoto(defectiveBlob, {
        ticketId: selectedTicket.id, plantName: selectedTicket.plants?.name || 'Plant',
        photoType: 'defective', creator: activeProfile.name, onProgress: setUploadPct,
      });
      // One transaction: writes the per-part split, mirrors the ticket totals
      // and closes it. Replaces the old single-decision ticket update.
      const totals = splitTotals(defectiveLines);
      const { error } = await callRpc('record_defective_disposition', {
        payload: {
          ticket_id: selectedTicket.id,
          plant_id: selectedTicket.plant_id,
          photo_url: result.secure_url,
          actor_name: activeProfile.name,
          lines: defectiveLines.map(l => ({
            store_request_id: l.storeRequestId,
            part_name: l.partName.trim(),
            replaced_qty: Number(l.replacedQty),
            repair_qty: Number(l.repairQty),
            scrap_qty: Number(l.scrapQty),
            store_item_id: l.storeItemId ?? null,
          })),
        },
      });
      if (error) throw new Error(friendlyDispositionError(error.message || ''));
      const summary = `${totals.repair} ${t('maint.toRepair', 'to repair')} · ${totals.scrap} ${t('maint.scrapped', 'scrapped')}`;
      notify({
        target_roles: ['admin', 'unit_head', 'store_manager_maint'],
        title: `Ticket closed: ${selectedTicket.equipment}`,
        body: `Defective parts → ${summary} · By ${activeProfile.name}`,
        type: 'info', route: maintRoute(selectedTicket?.id),
        actor_name: activeProfile.name, actor_role: role, read_by: [],
        plant_id: selectedTicket.plant_id, unit_id: selectedTicket.unit_id,
      });
      await notifyTicketWatchers(selectedTicket, `Ticket closed: ${selectedTicket.equipment}`, `Defective parts → ${summary} · closed by ${activeProfile.name}.`);
      setSelectedTicket(null); setDefectiveBlob(null); setDefectiveDecision(''); setDefectiveLines([]); setUploadPct(0);
      await loadData();
    } catch (err) { toast.error(t('maint.uploadFailedMsg', { defaultValue: 'Upload failed: {{message}}', message: err instanceof Error ? err.message : String(err) })); }
    finally { setUploading(false); }
  }

  /** Map record_defective_disposition failures to something a technician can act on. */
  function friendlyDispositionError(raw: string): string {
    if (/split_mismatch/i.test(raw)) return t('maint.splitErrInvalid', 'Check the repair / scrap quantities before closing.');
    if (/disposition_locked/i.test(raw)) return t('maint.splitErrLocked', 'Repaired units have already been returned against this ticket, so the split can no longer be changed.');
    if (/PGRST202|Could not find the function|schema cache/i.test(raw)) return t('maint.splitErrMigration', 'The defective-parts service is not installed yet — run migration 56_defective_part_split.sql in Supabase, then retry.');
    if (/forbidden: plant out of scope/i.test(raw)) return t('maint.splitErrScope', 'This plant is outside your data scope.');
    if (/not_authenticated/i.test(raw)) return t('maint.splitErrAuth', 'Your session has expired — sign in again.');
    return raw;
  }

  const EMPTY_SCHEDULE_FORM = { title: '', equipment: '', plant: '', frequency: 'weekly', description: '', firstDue: today, assignedTo: '', farAssetId: '', equipmentMark: '', until: '', unmatchedReason: '' };

  // Open the panel to create a brand-new schedule.
  function openAddSchedule() {
    setEditingSchedule(null);
    setScheduleForm(EMPTY_SCHEDULE_FORM);
    setShowSchedulePanel(true);
  }

  // Open the panel pre-filled to revise an existing schedule — reassign owner,
  // change frequency, reschedule next due, edit the checklist, etc.
  function openEditSchedule(s: ScheduleRow) {
    setEditingSchedule(s);
    setScheduleForm({
      title: s.title,
      equipment: s.equipment,
      plant: s.plant_id || '',
      frequency: s.frequency,
      description: s.description || '',
      firstDue: s.next_due_at ? s.next_due_at.split('T')[0] : today,
      assignedTo: s.assigned_to || '',
      farAssetId: s.far_asset_id || '',
      equipmentMark: s.equipment_mark || '',
      until: s.until_date || '',
      unmatchedReason: s.unmatched_justification || '',
    });
    setShowSchedulePanel(true);
  }

  // Clone an existing schedule into a new draft (calendar-style "duplicate event").
  function openDuplicateSchedule(s: ScheduleRow) {
    setEditingSchedule(null);
    setScheduleForm({
      title: `${s.title} (copy)`,
      equipment: s.equipment,
      plant: s.plant_id || '',
      frequency: s.frequency,
      description: s.description || '',
      firstDue: today,
      assignedTo: s.assigned_to || '',
      farAssetId: s.far_asset_id || '',
      equipmentMark: s.equipment_mark || '',
      until: s.until_date || '',
      unmatchedReason: s.unmatched_justification || '',
    });
    setShowSchedulePanel(true);
  }

  function closeSchedulePanel() {
    setShowSchedulePanel(false); setScheduleSaved(false); setEditingSchedule(null);
  }

  // Pause (snooze) or resume a recurring schedule without deleting it — paused
  // schedules stop auto-generating tickets. Useful when an owner leaves and the
  // task needs a temporary hold until it's reassigned.
  async function toggleScheduleActive(s: ScheduleRow) {
    if (!isAdmin) return;
    const next = !s.is_active;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await updateRows('maintenance_schedules', { is_active: next }).eq('id', s.id);
    if (error) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: error.message })); return; }
    setSchedules(prev => prev.map(x => (x.id === s.id ? { ...x, is_active: next } : x)));
    toast.success(next ? t('maint.scheduleResumed', 'Schedule resumed') : t('maint.schedulePaused', 'Schedule paused'));
  }

  // Delete a schedule.
  //  • Pending (still 'open', un-started) auto-tickets it generated are DELETED
  //    alongside it — so KPI counters (Due today / Overdue) and the tab badge
  //    drop back to reality immediately.
  //  • Tickets that were actually worked on (in_progress … closed) are KEPT but
  //    unlinked (schedule_id → null) so the maintenance history stays intact.
  async function handleDeleteSchedule(s: ScheduleRow) {
    if (!isAdmin || deletingScheduleId) return;
    if (!window.confirm(t('maint.confirmDeleteSchedule', { defaultValue: 'Delete schedule "{{name}}"? This stops auto-ticket generation and removes any pending tickets it created (started/completed ones are kept for history). This cannot be undone.', name: s.title }))) return;
    setDeletingScheduleId(s.id);
    try {
      const pendingIds = tickets.filter(t => t.schedule_id === s.id && t.status === 'open').map(t => t.id);
      if (pendingIds.length) {
        // Remove dependent store-request rows first (FK: maintenance_store_requests.ticket_id).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: srErr } = await (supabase.from('maintenance_store_requests') as any).delete().in('ticket_id', pendingIds);
        if (srErr) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: srErr.message })); return; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: tdErr } = await (supabase.from('maintenance_tickets') as any).delete().in('id', pendingIds);
        if (tdErr) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: tdErr.message })); return; }
      }
      // Unlink any remaining (worked-on/closed) tickets so the FK clears but history survives.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: tErr } = await (supabase.from('maintenance_tickets') as any).update({ schedule_id: null }).eq('schedule_id', s.id);
      if (tErr) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: tErr.message })); return; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('maintenance_schedules') as any).delete().eq('id', s.id);
      if (error) { toast.error(t('maint.deleteFailedMsg', { defaultValue: 'Delete failed: {{message}}', message: error.message })); return; }
      setSchedules(prev => prev.filter(x => x.id !== s.id));
      // Update local tickets so the periodic KPIs recompute instantly.
      setTickets(prev => prev
        .filter(t => !pendingIds.includes(t.id))
        .map(t => (t.schedule_id === s.id ? { ...t, schedule_id: null } : t)));
      toast.success(t('maint.scheduleDeleted', 'Schedule deleted'));
    } finally {
      setDeletingScheduleId(null);
    }
  }

  async function handleSaveSchedule() {
    if (!scheduleForm.title.trim() || !scheduleForm.equipment.trim() || savingSchedule) return;
    setSavingSchedule(true);
    try {
    // A linked FAR asset dictates the plant — never let a mismatched selection through.
    const linkedAsset = farAssets.find(a => a.id === scheduleForm.farAssetId);
    const plant = dbPlants.find(p => p.id === scheduleForm.plant);
    const payload = {
      title: scheduleForm.title, equipment: scheduleForm.equipment,
      plant_id: linkedAsset?.plant_id ?? plant?.id ?? null, frequency: scheduleForm.frequency as ScheduleRow['frequency'],
      description: scheduleForm.description || null,
      assigned_to: scheduleForm.assignedTo || null,
      next_due_at: scheduleForm.firstDue ? new Date(scheduleForm.firstDue).toISOString() : null,
      far_asset_id: scheduleForm.farAssetId || null,
      equipment_mark: scheduleForm.equipmentMark || null,
      until_date: scheduleForm.until || null,
      start_date: scheduleForm.firstDue || null,
      requires_approval: scheduleForm.frequency !== 'daily',
      unmatched_justification: (!scheduleForm.farAssetId && scheduleForm.unmatchedReason) ? scheduleForm.unmatchedReason : null,
    };
    const reassigned = !!editingSchedule && (editingSchedule.assigned_to || '') !== scheduleForm.assignedTo;
    if (editingSchedule) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await updateRows('maintenance_schedules', payload).eq('id', editingSchedule.id);
      if (error) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: error.message })); return; }
    } else {
      const { error } = await insertRows('maintenance_schedules', { ...payload, is_active: true });
      if (error) { toast.error(t('maint.failedMsg', { defaultValue: 'Failed: {{message}}', message: error.message })); return; }
    }
    // If the assignee is restricted, alert admin + unit head immediately.
    if (scheduleForm.assignedTo && (!editingSchedule || reassigned)) {
      const entry = isPersonBlacklisted(scheduleForm.assignedTo);
      if (entry) notifyActivity(entry, `assigned the recurring task "${scheduleForm.title}" (${FREQ_LABEL[scheduleForm.frequency] || scheduleForm.frequency})`);
    }
    await notifyMentions(scheduleForm.description, {
      entityLabel: scheduleForm.title || 'Maintenance schedule', route: '/dashboard/purchase/maint',
    });
    setScheduleSaved(true);
    await loadData();
    setTimeout(() => {
      setShowSchedulePanel(false); setScheduleSaved(false); setEditingSchedule(null);
      setScheduleForm(EMPTY_SCHEDULE_FORM);
    }, 1400);
    } finally { setSavingSchedule(false); }
  }

  // ── Read-only stage history (click a stage in the strip) ────────────────────
  function renderStageDetail(stage: string) {
    const tk = selectedTicket;
    if (!tk) return null;
    const sr = selectedStoreReq;
    const label = STAGE_LABEL_KEYS[stage] ? t(STAGE_LABEL_KEYS[stage], STAGE_LABELS[stage]) : (STAGE_LABELS[stage] || stage);

    const photo = (url: string | null | undefined, cap: string) => url ? (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 4 }}>{cap}</div>
        <img src={url} alt={cap} style={{ width: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 10, border: '1px solid #E2E8F0' }} />
        <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#2563EB', display: 'block', marginTop: 4 }}>{t('maint.openFullImage', 'Open full image ↗')}</a>
      </div>
    ) : null;
    const line = (k: string, v: React.ReactNode) => (v || v === 0) ? (
      <div style={{ fontSize: 12.5, color: '#334155', marginTop: 5 }}><span style={{ color: '#94A3B8' }}>{k}: </span><strong>{v}</strong></div>
    ) : null;

    let body: React.ReactNode = <div style={{ fontSize: 12.5, color: '#94A3B8' }}>{t('maint.noStepDetails', 'No details captured for this step.')}</div>;
    switch (stage) {
      case 'open':
        body = <>{line(t('maint.colRaisedBy', 'Raised by'), tk.raised_by)}{line(t('maint.roleLabel', 'Role'), roleLabelFor(tk.raised_role, roles))}{line(t('maint.whenLabel', 'When'), formatDate(tk.created_at))}{tk.description && <div style={{ fontSize: 12.5, color: '#334155', marginTop: 6 }}><MentionText text={tk.description} /></div>}</>;
        break;
      case 'in_progress':
        body = <>{line(t('maint.handledBy', 'Handled by'), tk.assigned_to || tk.raised_by)}<div style={{ fontSize: 12.5, color: '#334155', marginTop: 5 }}>{sr ? t('maint.needsPartStoreRaised', 'Needs a part — store request raised.') : t('maint.decidedInhouse', 'Decided to fix in-house.')}</div></>;
        break;
      case 'pending_store':
        if (sr) body = <>{line(t('maint.partRequested', 'Part requested'), sr.part_name)}{line(t('maint.qtyLabel', 'Qty'), sr.quantity)}{line(t('maint.specificationLabel', 'Specification'), sr.specification)}{line(t('maint.storeDecisionLabel', 'Store decision'), sr.store_decision)}{line(t('maint.qtyInStoreLabel', 'Qty in store'), sr.qty_in_store)}{line(t('maint.shelfLabel', 'Shelf'), sr.shelf_location)}{line(t('maint.conditionLabel', 'Condition'), sr.part_condition)}</>;
        break;
      case 'pending_unit_head':
        // Two meanings on this stage: approve a part request (store path) or
        // verify finished work (in-house path, which has no store request).
        if (sr) body = <>{line(t('maint.unitHeadDecision', 'Unit head decision'), sr.unit_head_approval)}{line(t('maint.partAvailability', 'Part availability'), sr.store_decision)}</>;
        else body = <>{line(t('maint.handledBy', 'Handled by'), tk.assigned_to || tk.raised_by)}{line(t('maint.unitHeadDecision', 'Unit head decision'), tk.status === 'closed' ? t('maint.verifiedClosed', 'Verified & closed') : t('maint.awaitingVerification', 'Awaiting verification'))}{photo(tk.completion_photo_url, t('maint.completionPhoto', 'Completion photo'))}</>;
        break;
      case 'pending_purchase': {
        const pr = storeReqs.find(r => r.store_decision === 'unavailable' || r.purchase_required) ?? sr;
        if (pr) body = <>{line(t('maint.qtyProcured', 'Qty procured'), pr.quantity)}{line(t('maint.busyTransactionRef', 'BUSY transaction ref'), pr.busy_transaction_ref)}{line(t('maint.supplierLabel', 'Supplier'), pr.supplier_name)}{line(t('maint.unitHeadLabel', 'Unit head'), pr.unit_head_approval === 'approved' ? t('maint.approvedProcurement', 'Approved procurement') : pr.unit_head_approval)}<div style={{ fontSize: 12.5, color: '#334155', marginTop: 5 }}>{t('maint.externalProcurementNote', 'External procurement for the quantity not in store.')}</div></>;
        break;
      }
      case 'pending_purchase_manager': {
        const pr = storeReqs.find(r => r.store_decision === 'unavailable' || r.purchase_required) ?? sr;
        const amount = tk.pm_bill_total ?? pr?.total_price ?? null;
        if (pr) body = <>{line(t('maint.qtyProcured', 'Qty procured'), pr.quantity)}{line(t('maint.purchaseAmount', 'Purchase amount'), amount != null ? `₹ ${Number(amount).toLocaleString('en-IN')}` : null)}{line(t('maint.itemsOnBill', 'Items on bill'), tk.pm_items_count)}{line(t('maint.supplierLabel', 'Supplier'), pr.supplier_name)}{line(t('maint.busyRefLabel', 'BUSY ref'), pr.busy_transaction_ref)}{line(t('maint.purchaseManagerLabel', 'Purchase Manager'), tk.pm_billed_by)}{line(t('maint.billedOn', 'Billed on'), tk.pm_billed_at ? formatDate(tk.pm_billed_at) : null)}{line(t('maint.billVerifiedLabel', 'Bill verified'), pr.bill_verified ? t('maint.yes', 'Yes') : '—')}{photo(tk.pm_bill_url || pr.handover_invoice_url, t('maint.supplierBillPmCaption', 'Supplier bill (Purchase Manager)'))}</>;
        break;
      }
      case 'pending_handover':
        if (sr) body = <>{line(t('maint.receiptConfirmed', 'Receipt confirmed'), sr.handover_confirmed_at ? formatDate(sr.handover_confirmed_at) : '—')}{line(t('maint.notesLabel', 'Notes'), sr.handover_notes)}{photo(sr.handover_invoice_url, t('maint.billInvoiceCaption', 'Bill / invoice'))}{photo(sr.handover_photo_url, t('maint.partReceivedPhoto', 'Part received photo'))}</>;
        break;
      case 'pending_defective_return':
        body = <>{line(t('maint.defectivePartDecision', 'Defective part decision'), tk.defective_part_decision)}{photo(tk.defective_part_photo_url, t('maint.defectivePartPhoto', 'Defective part photo'))}</>;
        break;
      case 'closed':
        body = <>{line(t('maint.closedAtLabel', 'Closed at'), tk.closed_at ? formatDate(tk.closed_at) : '—')}{line(t('maint.defectivePartLabel', 'Defective part'), tk.defective_part_decision)}{photo(tk.completion_photo_url, t('maint.completionPhoto', 'Completion photo'))}</>;
        break;
    }

    return (
      <div style={{ border: '1px solid #E2E8F0', borderRadius: 14, padding: 16, marginBottom: 16, background: '#FCFCFD' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#0F172A' }}>{t('maint.stageWhatHappened', { defaultValue: '{{stage}} — what happened', stage: label })} <span style={{ fontWeight: 500, color: '#94A3B8' }}>{t('maint.readOnlySuffix', '(read-only)')}</span></div>
          <button onClick={() => setViewStage(null)} style={{ border: 'none', background: 'transparent', color: '#94A3B8', cursor: 'pointer', fontSize: 16, lineHeight: 1, fontFamily: 'inherit' }}>×</button>
        </div>
        {body}
      </div>
    );
  }

  // ── Ticket action panel ───────────────────────────────────────────────────

  function renderTicketActions() {
    if (!selectedTicket) return null;
    const tk = selectedTicket;
    const status = selectedTicket.status;
    // Persisted first decision — drives the body so an open ticket is never re-asked.
    const decision = ticketDecision(tk.title, storeReqs.length > 0);

    if (status === 'closed') {
      return (
        <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 700, color: '#16A34A', marginBottom: 8 }}>{t('maint.ticketClosed', 'Ticket closed')}</div>
          {selectedTicket.completion_photo_url && (
            <>
              <img src={selectedTicket.completion_photo_url} alt="Completion" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 10, marginTop: 4 }} />
              <a href={selectedTicket.completion_photo_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#2563EB', display: 'block', marginTop: 6 }}>{t('maint.viewInCloudinary', 'View in Cloudinary ↗')}</a>
            </>
          )}
          {selectedStoreReq?.handover_invoice_url && (
            <a href={selectedStoreReq.handover_invoice_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#2563EB', display: 'block', marginTop: 4 }}>{t('maint.viewHandoverInvoice', 'View handover invoice ↗')}</a>
          )}
          {selectedTicket.defective_part_decision && (
            <div style={{ fontSize: 12, marginTop: 8, color: '#475569' }}>{t('maint.defectivePartLabel', 'Defective part')}: <strong style={{ textTransform: 'capitalize' }}>{selectedTicket.defective_part_decision}</strong></div>
          )}
        </div>
      );
    }

    // ── open: resume the persisted path (never re-ask a decided ticket) ──
    if (status === 'open' && canWorkEmergency(tk)) {
      if (decision === 'store' || (decision === 'undecided' && showStoreForm)) {
        const validItems = storeItems.filter(it => it.partName.trim()).length;
        return (
          <div style={{ border: '1px solid #E2E8F0', borderRadius: 14, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 13 }}>{t('maint.storeRequestPartsNeeded', 'Store request — parts needed')}</div>
            <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 12 }}>{t('maint.storeRequestHint', 'Add every part this breakdown needs. Each is tracked and approved individually.')}</div>
            {storeItems.map((it, idx) => (
              <div key={idx} style={{ border: '1px solid #F1F5F9', borderRadius: 12, padding: 12, marginBottom: 10, background: '#FCFCFD' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#64748B' }}>{t('maint.itemN', { defaultValue: 'Item {{n}}', n: idx + 1 })}</span>
                  {storeItems.length > 1 && (
                    <button onClick={() => setStoreItems(items => items.filter((_, i) => i !== idx))} style={{ border: 'none', background: 'transparent', color: '#DC2626', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>{t('maint.removeItem', '✕ Remove')}</button>
                  )}
                </div>
                <PanelField label={t('maint.partNameRequired', 'Part name *')}>
                  <PartNameField
                    value={it.partName}
                    stock={storeStock}
                    onChange={v => setStoreItems(items => items.map((x, i) => i === idx ? { ...x, partName: v } : x))}
                    onPick={picked => setStoreItems(items => items.map((x, i) => i === idx ? { ...x, storeItemId: picked?.id ?? null, unit: picked?.unit || x.unit } : x))}
                  />
                  {it.storeItemId
                    ? <div style={{ fontSize: 11, color: '#16A34A', marginTop: 4 }}>{t('maint.linkedToStoreStock', '✓ Linked to store stock — availability will be checked automatically.')}</div>
                    : (storeStock.length > 0 && it.partName.trim().length > 1 && <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{t('maint.notInStoreList', 'Not in store list — will be treated as a new part to procure.')}</div>)}
                </PanelField>
                <PanelRow>
                  <PanelField label={t('maint.quantityLabel', 'Quantity')}>
                    <PanelInput type="number" value={it.quantity} onChange={e => setStoreItems(items => items.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x))} placeholder={t('maint.qtyPlaceholder2', 'e.g. 2')} />
                  </PanelField>
                  <PanelField label={t('maint.unitLabel', 'Unit')}>
                    <PanelSelect value={it.unit} onChange={e => setStoreItems(items => items.map((x, i) => i === idx ? { ...x, unit: e.target.value } : x))}>
                      {STORE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                      {/* keep a registry-supplied unit selectable even if it's outside the standard list */}
                      {it.unit && !STORE_UNITS.includes(it.unit) && <option value={it.unit}>{it.unit}</option>}
                    </PanelSelect>
                  </PanelField>
                </PanelRow>
                <PanelField label={t('maint.specificationQuality', 'Specification / quality')}>
                  <PanelTextarea value={it.specification} onChange={e => setStoreItems(items => items.map((x, i) => i === idx ? { ...x, specification: e.target.value } : x))} placeholder={t('maint.specPlaceholder', 'Brand, size, grade, tolerance…')} />
                </PanelField>
              </div>
            ))}
            <button onClick={() => setStoreItems(items => [...items, { ...BLANK_ITEM }])} style={{ width: '100%', padding: '9px', borderRadius: 10, border: '1.5px dashed #CBD5E1', background: '#fff', color: '#475569', cursor: 'pointer', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit', marginBottom: 12 }}>{t('maint.addAnotherItem', '+ Add another item')}</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setShowStoreForm(false); setStoreItems([{ ...BLANK_ITEM }]); }} style={{ flex: 1, padding: '10px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: 'inherit' }}>{t('common.cancel', 'Cancel')}</button>
              <button onClick={handleRaiseStoreReq} disabled={!validItems} style={{ flex: 2, padding: '10px', borderRadius: 12, border: 'none', background: '#EF6C00', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'inherit', opacity: !validItems ? 0.5 : 1 }}>{validItems > 1 ? t('maint.sendNItems', { defaultValue: 'Send {{n}} items', n: validItems }) : t('maint.sendToStoreManager', 'Send to Store Manager')}</button>
            </div>
          </div>
        );
      }
      // Decided in-house at raise → just proceed to the completion step (no re-ask).
      if (decision === 'inhouse') {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, color: '#64748B', fontWeight: 600 }}>{t('maint.inhouseStartHint', 'In-house repair — start when you begin work.')}</div>
            <button onClick={startRepair} style={{ padding: '12px 16px', borderRadius: 12, border: 'none', background: '#16A34A', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', textAlign: 'center', fontFamily: 'inherit' }}>
              {t('maint.startInhouseRepair', '✓ Start in-house repair')}
            </button>
          </div>
        );
      }
      // Legacy/undecided ticket only (no persisted path) → let them choose once.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 4 }}>{t('maint.whatNeedsToHappen', 'What needs to happen?')}</div>
          <button onClick={startRepair} style={{ padding: '12px 16px', borderRadius: 12, border: '1px solid #16A34A', background: '#F0FDF4', color: '#16A34A', fontWeight: 700, fontSize: 13, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
            {t('maint.canFixInhouseStart', '✓ Can fix in-house — start working on it')}
          </button>
          <button onClick={() => setShowStoreForm(true)} style={{ padding: '12px 16px', borderRadius: 12, border: '1px solid #EF6C00', background: '#FFF7F5', color: '#EF6C00', fontWeight: 700, fontSize: 13, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
            {t('maint.needPartRaiseRequest', '🔧 Need a part from store — raise request')}
          </button>
        </div>
      );
    }

    // ── in_progress: technician submits the completion photo for verification ──
    if (status === 'in_progress' && (isTechnician || isAdmin || canWorkEmergency(tk))) {
      return (
        <div>
          <div style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 12 }}>{t('maint.uploadPhotoProofVerify', 'Upload photo proof — the unit head verifies before the ticket closes')}</div>
          <PhotoUploader onBlobReady={setCompletionBlob} label={t('maint.completionPhoto', 'Completion photo')} hint={t('maint.completionPhotoHint', 'Photo of the fixed equipment / completed repair')} />
          {uploading && <UploadBar pct={uploadPct} color="#EF6C00" />}
          <button onClick={closeInHouse} disabled={!completionBlob || uploading} style={{ width: '100%', padding: '12px', borderRadius: 12, border: 'none', background: '#16A34A', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: (!completionBlob || uploading) ? 0.5 : 1 }}>
            {uploading ? t('maint.uploadingEllipsis', 'Uploading…') : t('maint.sendToUnitHeadVerify', 'Send to unit head for verification')}
          </button>
        </div>
      );
    }

    // ── in-house repair completed → unit head verifies, and only they can close ──
    // Guarded on "no store request rows" so this never shadows the part-approval
    // meaning of pending_unit_head on the procurement path.
    if (status === 'pending_unit_head' && decision !== 'store' && storeReqs.length === 0) {
      const canVerify = isUnitHead || isAdmin;
      return (
        <div style={{ border: '1px solid #DDD6FE', background: '#F1F5F9', borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#5B21B6' }}>{t('maint.verifyInhouseTitle', 'In-house repair — awaiting unit head verification')}</div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 4, lineHeight: 1.5 }}>
            {t('maint.verifyInhouseSub', { defaultValue: '{{name}} completed the repair and uploaded proof. It stays open until the unit head verifies it.', name: tk.assigned_to || tk.raised_by || '—' })}
          </div>
          {tk.completion_photo_url && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{t('maint.completionPhoto', 'Completion photo')}</div>
              <img
                src={tk.completion_photo_url}
                alt={t('maint.completionPhoto', 'Completion photo')}
                onClick={() => setTicketLightbox({ images: [{ url: tk.completion_photo_url!, label: t('maint.completionPhoto', 'Completion photo') }], index: 0 })}
                style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 10, border: '1px solid #E2E8F0', cursor: 'zoom-in', display: 'block' }}
              />
            </div>
          )}
          {canVerify ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button onClick={() => { setChangeTags([]); setChangeReason(''); setRequestingChanges(true); }} style={{ flex: 1, padding: '11px', borderRadius: 12, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                {t('maint.sendBack', '↩ Send back')}
              </button>
              <button onClick={verifyInHouse} style={{ flex: 2, padding: '11px', borderRadius: 12, border: 'none', background: '#16A34A', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                {t('maint.verifyAndClose', '✓ Verify & close')}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#0A1628', fontWeight: 600, marginTop: 14 }}>{t('maint.awaitingUnitHead', 'Waiting on the unit head — you will be notified when it is closed.')}</div>
          )}
        </div>
      );
    }

    // ── Per-item workflow (multi-item) ──────────────────────────────────────
    // Each item card shows its own stage + the action for the current role.
    // Items flow independently; the Purchase Manager bills the procured ones
    // together below. The ticket status is a roll-up of the least-advanced item.
    // Any store manager may act: the register they serve is decided by the
    // ticket's factory, not by which unit-flavoured role they happen to hold.
    const storeManagerCanAct = isAdmin || isStoreManager;
    const cancelBtn: React.CSSProperties = { flex: 1, padding: '9px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', fontWeight: 600, fontSize: 12.5, fontFamily: 'inherit' };
    const primaryBtn = (bg: string): React.CSSProperties => ({ padding: '9px 12px', borderRadius: 10, border: 'none', background: bg, color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit' });
    const awaitTxt: React.CSSProperties = { fontSize: 12, color: '#94A3B8', textAlign: 'center', padding: '10px 0', marginTop: 6 };
    // Compact numeric input for the defective Repair/Scrap split.
    const numInput: React.CSSProperties = { width: 68, boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 8, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none' };

    const STAGE_BADGE: Record<ItemStage, { label: string; bg: string; color: string }> = {
      store: { label: t('maint.badgeStoreCheck', 'Store check'), bg: '#FFF7ED', color: '#EA580C' },
      unit_head: { label: t('maint.unitHeadLabel', 'Unit head'), bg: '#F1F5F9', color: '#0A1628' },
      purchase: { label: t('maint.badgeProcure', 'Procure'), bg: '#EFF6FF', color: '#2563EB' },
      purchase_manager: { label: t('maint.badgeAwaitingBill', 'Awaiting bill'), bg: '#FDF4FF', color: '#A21CAF' },
      handover: { label: t('maint.badgeHandover', 'Handover'), bg: '#F8FAFC', color: '#9333EA' },
      done: { label: t('common.done', 'Done'), bg: '#F0FDF4', color: '#16A34A' },
      rejected: { label: t('maint.badgeRejected', 'Rejected'), bg: '#FEF2F2', color: '#DC2626' },
    };

    const procuredAwaitingBill = storeReqs.filter(r => itemStage(r) === 'purchase_manager');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(() => {
          const renderReq = (req: StoreReqRow, grouped = false) => {
          const s = itemStage(req);
          const acting = actingReqId === req.id;
          const badge = STAGE_BADGE[s];
          // Available-from-store items skip procurement → no bill; procured items carry one.
          const fromOwnStore = req.store_decision === 'available';
          const canConfirmHandover = fromOwnStore
            ? (!!handoverNotes.trim() || !!handoverPhotoBlob)
            : (!!handoverInvoiceBlob || !!handoverPhotoBlob);
          // Map the request to the plant's stock so the store manager confirms
          // rather than re-counts: exact link if the tech picked it, else fuzzy.
          const linkedStock = req.store_item_id ? storeStock.find(x => x.id === req.store_item_id) ?? null : null;
          const storeSuggestions = (s === 'store' && acting)
            ? (linkedStock ? [linkedStock] : suggestParts(req.part_name, storeStock).slice(0, 3))
            : [];
          return (
            <div key={req.id} style={{ border: `1px solid ${grouped ? '#F1F5F9' : '#E2E8F0'}`, borderRadius: grouped ? 10 : 14, padding: grouped ? 11 : 14, background: grouped ? '#FCFCFD' : undefined }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  {grouped ? (
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#475569' }}>
                      {req.store_decision === 'available' ? t('maint.trackFromStore', '① From store') : req.store_decision === 'unavailable' ? t('maint.trackProcurement', '② Procurement') : t('maint.badgeStoreCheck', 'Store check')} · {t('maint.qtyLabel', 'Qty')} {req.quantity ?? '—'}{req.quantity != null && req.unit ? ` ${req.unit}` : ''}
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{req.part_name}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>
                        {req.quantity ? `${t('maint.qtyLabel', 'Qty')} ${req.quantity}${req.unit ? ` ${req.unit}` : ''}` : ''}{req.specification ? `${req.quantity ? ' · ' : ''}${req.specification}` : ''}
                      </div>
                    </>
                  )}
                </div>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: badge.bg, color: badge.color, whiteSpace: 'nowrap' }}>{badge.label}</span>
              </div>

              {/* STORE CHECK */}
              {s === 'store' && (storeManagerCanAct ? (acting ? (() => {
                const regQty = storeDecisionForm.registerQty;
                const enteredQty = storeDecisionForm.qtyInStore.trim() === '' ? null : Number(storeDecisionForm.qtyInStore);
                const qtyDiffers = regQty != null && enteredQty != null && enteredQty !== regQty;
                const needJustify = qtyDiffers && !storeDecisionForm.qtyJustification.trim();
                const reqQty = Number(req.quantity) || 0;
                const willSplit = enteredQty != null && reqQty > 0 && enteredQty < reqQty;
                return (
                <div style={{ marginTop: 12 }}>
                  {storeSuggestions.length > 0 && (
                    <div style={{ border: '1px solid #BBF7D0', background: '#F0FDF4', borderRadius: 10, padding: 10, marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#16A34A', marginBottom: 6 }}>{linkedStock ? t('maint.linkedToYourStoreStock', 'Linked to your store stock') : t('maint.closestMatchInStore', 'Closest match in your store — is it one of these?')}</div>
                      {storeSuggestions.map(mi => (
                        <div key={mi.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                          <span style={{ fontSize: 12.5, color: '#334155', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mi.item_name} · <strong style={{ color: mi.on_hand > 0 ? '#16A34A' : '#DC2626' }}>{t('maint.inStockCount', { defaultValue: '{{n}} in stock', n: mi.on_hand })}</strong></span>
                          <button onClick={() => setStoreDecisionForm(f => ({ ...f, available: mi.on_hand > 0, qtyInStore: String(mi.on_hand), registerQty: Number(mi.on_hand) }))} style={{ border: '1px solid #16A34A', background: '#fff', color: '#16A34A', borderRadius: 8, padding: '4px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>{t('maint.useQty', { defaultValue: 'Use {{n}}', n: mi.on_hand })}</button>
                        </div>
                      ))}
                      <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 5 }}>{t('maint.qtyFromStockFile', 'Quantity comes from the uploaded stock file — you just confirm it, or correct it with a reason.')}</div>
                    </div>
                  )}
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 8 }}>{t('maint.isThisPartInStore', 'Is this part in store?')}</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    {([true, false] as const).map(v => (
                      <button key={String(v)} onClick={() => setStoreDecisionForm(f => ({ ...f, available: v }))} style={{ flex: 1, padding: '10px', borderRadius: 10, border: `2px solid ${storeDecisionForm.available === v ? (v ? '#16A34A' : '#DC2626') : '#E2E8F0'}`, background: storeDecisionForm.available === v ? (v ? '#F0FDF4' : '#FEF2F2') : '#F8FAFC', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', color: storeDecisionForm.available === v ? (v ? '#16A34A' : '#DC2626') : '#64748B', fontFamily: 'inherit' }}>{v ? t('maint.inStockYes', '✓ In stock') : t('maint.inStockNo', '✗ Not in stock')}</button>
                    ))}
                  </div>
                  {storeDecisionForm.available === true && (
                    <>
                      <PanelRow>
                        <PanelField label={regQty != null ? t('maint.qtyAvailableRegisterSays', { defaultValue: 'Qty available · register says {{n}}', n: regQty }) : t('maint.qtyAvailable', 'Qty available')}><PanelInput type="number" value={storeDecisionForm.qtyInStore} onChange={e => setStoreDecisionForm(f => ({ ...f, qtyInStore: e.target.value }))} placeholder={t('maint.qtyPlaceholder3', 'e.g. 3')} /></PanelField>
                        <PanelField label={t('maint.shelfBin', 'Shelf / bin')}><PanelInput value={storeDecisionForm.shelfLocation} onChange={e => setStoreDecisionForm(f => ({ ...f, shelfLocation: e.target.value }))} placeholder={t('maint.shelfPlaceholder', 'Rack B-12')} /></PanelField>
                      </PanelRow>
                      {willSplit && (
                        <div style={{ fontSize: 11.5, color: '#0A1628', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: '7px 10px', marginTop: 6 }}>
                          {t('maint.splitOnlyInStore', { defaultValue: '⤿ Only {{have}} of {{need}} in store → ', have: enteredQty, need: reqQty })}<strong>{t('maint.splitIssuedNow', { defaultValue: '{{n}} issued now', n: enteredQty })}</strong>, <strong>{t('maint.splitSentToProcurement', { defaultValue: '{{n}} sent to procurement', n: reqQty - (enteredQty ?? 0) })}</strong>{t('maint.splitAutomatically', ' automatically.')}
                        </div>
                      )}
                      {qtyDiffers && (
                        <div style={{ marginTop: 6 }}>
                          <div style={{ fontSize: 11, color: '#B45309', marginBottom: 4 }}>{t('maint.regSaysPrefix', '⚠ Register says ')}<strong>{regQty}</strong>{t('maint.youEnteredInfix', ', you entered ')}<strong>{enteredQty}</strong>{t('maint.justifyRequiredSuffix', ' — a justification is required.')}</div>
                          <PanelTextarea value={storeDecisionForm.qtyJustification} onChange={e => setStoreDecisionForm(f => ({ ...f, qtyJustification: e.target.value }))} placeholder={t('maint.qtyJustifyPlaceholder', 'Why does your count differ from the register? e.g. 2 damaged units removed; file not yet updated.')} />
                        </div>
                      )}
                    </>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => { setActingReqId(null); setStoreDecisionForm({ ...BLANK_STORE_DECISION }); }} style={cancelBtn}>{t('common.cancel', 'Cancel')}</button>
                    <button onClick={() => submitStoreDecision(req)} disabled={storeDecisionForm.available === null || needJustify} style={{ ...primaryBtn('#EF6C00'), flex: 2, opacity: (storeDecisionForm.available === null || needJustify) ? 0.4 : 1 }}>{t('maint.submitToUnitHead', 'Submit to unit head')}</button>
                  </div>
                </div>
                );
              })() : (
                <button onClick={() => { const linked = req.store_item_id ? storeStock.find(x => x.id === req.store_item_id) : null; setActingReqId(req.id); setStoreDecisionForm({ ...BLANK_STORE_DECISION, available: linked ? Number(linked.on_hand) > 0 : null, qtyInStore: linked ? String(linked.on_hand) : '', registerQty: linked ? Number(linked.on_hand) : null }); }} style={{ ...primaryBtn('#EF6C00'), width: '100%', marginTop: 10 }}>{t('maint.checkAvailability', 'Check availability')}</button>
              )) : <div style={awaitTxt}>{t('maint.awaitingStoreManager', 'Awaiting store manager…')}</div>)}

              {/* UNIT HEAD */}
              {s === 'unit_head' && ((isUnitHead || isAdmin) ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, color: req.store_decision === 'available' ? '#16A34A' : '#DC2626', marginBottom: 8 }}>
                    {t('maint.storeSays', 'Store says:')} <strong>{req.store_decision === 'available' ? t('maint.inStock', 'In stock') : t('maint.notInStock', 'Not in stock')}</strong>{req.store_decision === 'available' && req.qty_in_store ? ` · ${t('maint.qtyLabel', 'Qty')} ${req.qty_in_store}` : ''}
                  </div>
                  <input
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder={t('maint.rejectReasonPlaceholder', 'Reason if rejecting (optional)')}
                    style={{ width: '100%', padding: '7px 10px', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 12, fontFamily: 'inherit', marginBottom: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => unitHeadApprove(req, true)} style={{ ...primaryBtn('#16A34A'), flex: 2 }}>{req.store_decision === 'available' ? t('maint.approveHandover', 'Approve handover') : t('maint.approveProcurement', 'Approve procurement')}</button>
                    <button onClick={() => unitHeadApprove(req, false)} style={{ ...primaryBtn('#DC2626'), flex: 1 }}>{t('maint.reject', 'Reject')}</button>
                  </div>
                </div>
              ) : <div style={awaitTxt}>{t('maint.awaitingUnitHeadApproval', 'Awaiting unit head approval…')}</div>)}

              {/* PURCHASE (procurement) */}
              {s === 'purchase' && ((isUnitHead || isAdmin) ? (acting ? (
                <div style={{ marginTop: 10 }}>
                  <PanelField label={t('maint.busyTransactionRefRequired', 'BUSY transaction reference *')}><PanelInput value={busyRef} onChange={e => setBusyRef(e.target.value)} placeholder={t('maint.busyRefPlaceholder', 'e.g. PUR/2026/04421')} /></PanelField>
                  <PanelRow>
                    <PanelField label={t('maint.qtyPurchasedNeed', { defaultValue: 'Qty purchased · need {{n}}', n: req.quantity ?? 0 })}><PanelInput type="number" value={purchaseQty} onChange={e => setPurchaseQty(e.target.value)} placeholder={`${req.quantity ?? ''}`} /></PanelField>
                    <PanelField label={t('maint.supplierVendor', 'Supplier / vendor')}><PanelInput value={supplierName} onChange={e => setSupplierName(e.target.value)} placeholder={t('maint.supplierPlaceholder', 'e.g. Madan Chemicals')} /></PanelField>
                  </PanelRow>
                  {req.store_item_id && (parseFloat(purchaseQty) || 0) > (Number(req.quantity) || 0) && (
                    <div style={{ fontSize: 11.5, color: '#0A1628', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: '6px 10px', marginBottom: 8 }}>
                      {t('maint.boughtInBulkPrefix', { defaultValue: 'Bought in bulk → {{n}} to the technician, ', n: req.quantity })}<strong>{t('maint.addedToStoreStock', { defaultValue: '{{n}} added to store stock', n: (parseFloat(purchaseQty) || 0) - (Number(req.quantity) || 0) })}</strong>{t('maint.onHandoverSuffix', ' on handover.')}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => { setActingReqId(null); setBusyRef(''); setSupplierName(''); setPurchaseQty(''); }} style={cancelBtn}>{t('common.cancel', 'Cancel')}</button>
                    <button onClick={() => markPurchased(req)} disabled={!busyRef.trim()} style={{ ...primaryBtn('#0A1628'), flex: 2, opacity: !busyRef.trim() ? 0.5 : 1 }}>{t('maint.markPurchased', 'Mark purchased')}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setActingReqId(req.id); setBusyRef(''); setSupplierName(''); setPurchaseQty(String(req.quantity ?? '')); }} style={{ ...primaryBtn('#0A1628'), width: '100%', marginTop: 10 }}>{t('maint.procureEnterBusyRef', 'Procure — enter BUSY ref')}</button>
              )) : <div style={awaitTxt}>{t('maint.unitHeadProcuring', 'Unit head procuring…')}</div>)}

              {s === 'purchase_manager' && <div style={awaitTxt}>{t('maint.procuredAwaitingBill', { defaultValue: 'Procured ({{ref}}) · awaiting purchase bill below…', ref: req.busy_transaction_ref || t('maint.refPending', 'ref pending') })}</div>}

              {/* HANDOVER */}
              {s === 'handover' && (storeManagerCanAct ? (acting ? (
                <div style={{ marginTop: 10 }}>
                  {fromOwnStore ? (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 }}>{t('maint.reasonDescription', 'Reason / description')}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 6 }}>{t('maint.issuedFromOwnStoreHint', "Issued from own store — no bill. Note why you're providing this part (condition, source shelf, any caveat).")}</div>
                      <textarea value={handoverNotes} onChange={e => setHandoverNotes(e.target.value)} placeholder={t('maint.handoverNotesPlaceholder', 'e.g. Issued from Rack B-12 — spare seal in good condition, replaces the worn one.')} rows={3} style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 10, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }} />
                    </div>
                  ) : (
                    <PhotoUploader onBlobReady={setHandoverInvoiceBlob} label={t('maint.invoiceBill', 'Invoice / bill')} hint={t('maint.invoiceBillHint', 'Photo of the invoice or purchase bill')} />
                  )}
                  <PhotoUploader onBlobReady={setHandoverPhotoBlob} label={t('maint.partPhoto', 'Part photo')} hint={t('maint.partPhotoHint', 'Photo of the part being handed over')} />
                  {uploading && <UploadBar pct={uploadPct} color="#9333EA" />}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button onClick={() => { setActingReqId(null); setHandoverInvoiceBlob(null); setHandoverPhotoBlob(null); setHandoverNotes(''); }} style={cancelBtn}>{t('common.cancel', 'Cancel')}</button>
                    <button onClick={() => confirmHandover(req)} disabled={!canConfirmHandover || uploading} style={{ ...primaryBtn('#9333EA'), flex: 2, opacity: (!canConfirmHandover || uploading) ? 0.5 : 1 }}>{uploading ? t('maint.uploadingPct', { defaultValue: 'Uploading… {{pct}}%', pct: uploadPct }) : t('maint.confirmHandover', 'Confirm handover')}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setActingReqId(req.id); setHandoverInvoiceBlob(null); setHandoverPhotoBlob(null); setHandoverNotes(''); }} style={{ ...primaryBtn('#9333EA'), width: '100%', marginTop: 10 }}>{t('maint.handOverToTechnician', 'Hand over to technician')}</button>
              )) : <div style={awaitTxt}>{t('maint.storeManagerToHandOver', 'Store manager to hand over…')}</div>)}

              {s === 'done' && <div style={{ fontSize: 12, color: '#16A34A', marginTop: 8, fontWeight: 600 }}>{t('maint.handedOver', '✓ Handed over')}{req.handover_confirmed_at ? ` · ${formatDate(req.handover_confirmed_at)}` : ''}</div>}
              {s === 'rejected' && <div style={{ fontSize: 12, color: '#DC2626', marginTop: 8 }}>{t('maint.rejectedByUnitHead', 'Rejected by unit head.')}</div>}
            </div>
          );
          };
          // Group the two parallel tracks (same split_group) under one part header.
          const groups: StoreReqRow[][] = [];
          const groupIdx = new Map<string, number>();
          for (const r of storeReqs) {
            const k = r.split_group || r.id;
            if (groupIdx.has(k)) groups[groupIdx.get(k)!].push(r);
            else { groupIdx.set(k, groups.length); groups.push([r]); }
          }
          return groups.map(group => {
            if (group.length === 1) return renderReq(group[0]);
            const sorted = [...group].sort((a, b) => (a.store_decision === 'available' ? 0 : 1) - (b.store_decision === 'available' ? 0 : 1));
            const g = sorted[0];
            const allDone = sorted.every(r => itemStage(r) === 'done');
            const issuedQty = sorted.filter(r => r.store_decision === 'available').reduce((n, r) => n + (Number(r.quantity) || 0), 0);
            const procuredQty = sorted.filter(r => r.store_decision === 'unavailable' || r.purchase_required).reduce((n, r) => n + (Number(r.quantity) || 0), 0);
            const requestedQty = issuedQty + procuredQty;
            const deliveredQty = sorted.filter(r => itemStage(r) === 'done').reduce((n, r) => n + (Number(r.quantity) || 0), 0);
            return (
              <div key={g.split_group || g.id} style={{ border: '1px solid #E2E8F0', borderRadius: 14, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{g.part_name}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>{t('maint.twoParallelTracks', 'Two parallel tracks — each is delivered to the technician as it completes.')}</div>
                  </div>
                  {allDone && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#DCFCE7', color: '#16A34A', whiteSpace: 'nowrap' }}>{t('maint.doneUpper', 'DONE')}</span>}
                </div>
                {/* Fulfilment summary — how the requested qty is being delivered */}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: '#64748B', marginTop: 8, background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: '7px 10px' }}>
                  <span>{t('maint.requestedLabel', 'Requested')} <strong style={{ color: '#334155' }}>{requestedQty}</strong></span>
                  <span>· {t('maint.fromStoreLabel', 'From store')} <strong style={{ color: '#16A34A' }}>{issuedQty}</strong></span>
                  <span>· {t('maint.procuredLabel', 'Procured')} <strong style={{ color: '#0A1628' }}>{procuredQty}</strong></span>
                  <span>· {t('maint.deliveredLabel', 'Delivered')} <strong style={{ color: deliveredQty >= requestedQty ? '#16A34A' : '#D97706' }}>{deliveredQty}/{requestedQty}</strong></span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>{sorted.map(r => renderReq(r, true))}</div>
              </div>
            );
          });
        })()}

        {/* PURCHASE MANAGER — aggregate bill for all procured items */}
        {procuredAwaitingBill.length > 0 && (isPurchaseManager || isAdmin) && (
          <div style={{ border: '1px solid #F5D0FE', borderRadius: 14, padding: 14, background: '#FDF4FF' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#A21CAF', textTransform: 'uppercase', marginBottom: 4 }}>{t('maint.pmBillHeading', { defaultValue: 'Purchase Manager — bill {{n}} procured item(s)', n: procuredAwaitingBill.length })}</div>
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>{t('maint.pmBillIntroPre', 'One supplier bill covers all procured items (incl. GST). OCR verifies the ')}<strong>{t('maint.pmBillTotalAmount', 'total amount')}</strong>{t('maint.pmBillIntroPost', ' against the photo; the line-item count is recorded for reference.')}</div>
            <PanelRow>
              <PanelField label={t('maint.pmLineItemsLabel', 'No. of line items on bill *')}><PanelInput type="number" value={pmForm.itemsCount} onChange={e => setPmForm(f => ({ ...f, itemsCount: e.target.value }))} placeholder={String(procuredAwaitingBill.length)} /></PanelField>
              <PanelField label={t('maint.pmTotalBillLabel', 'Total bill amount (₹) *')}><PanelInput value={pmForm.billTotal} onChange={e => setPmForm(f => ({ ...f, billTotal: e.target.value }))} placeholder={t('maint.pmBillTotalPlaceholder', 'e.g. 177936.50')} /></PanelField>
            </PanelRow>
            <PhotoUploader onBlobReady={setDispatchBlob} label={t('maint.supplierBillPhoto', 'Supplier bill photo *')} hint={t('maint.supplierBillPhotoHint', 'Clear photo of the full supplier bill')} />
            {uploading && <UploadBar pct={uploadPct} color="#A21CAF" phase={busyPhase} />}
            <button onClick={submitPurchaseManagerBill} disabled={!dispatchBlob || uploading} style={{ ...primaryBtn('#A21CAF'), width: '100%', marginTop: 8, opacity: (!dispatchBlob || uploading) ? 0.5 : 1 }}>{uploading ? (busyPhase === 'verifying' ? t('maint.verifyingBill', 'Verifying bill…') : t('maint.uploadingPct', { defaultValue: 'Uploading… {{pct}}%', pct: uploadPct })) : t('maint.uploadBillVerify', 'Upload bill — verify & mark en route')}</button>
          </div>
        )}
        {procuredAwaitingBill.length > 0 && !(isPurchaseManager || isAdmin) && <div style={awaitTxt}>{t('maint.awaitingPmBill', 'Purchase Manager (Anshul) to upload the bill…')}</div>}

        {/* PM mismatch banner */}
        {tk.pm_mismatch && (
          <div style={{ border: '1px solid #FECACA', background: '#FEF2F2', borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#DC2626' }}>{t('maint.billTotalMismatch', '⚠ Bill total mismatch')}</div>
            <div style={{ fontSize: 11.5, color: '#7F1D1D', marginTop: 3 }}>
              {t('maint.billMismatchDetail', { defaultValue: 'Declared total ₹{{declared}} · OCR read ₹{{read}}. Please verify the bill', declared: Number(tk.pm_bill_total || 0).toLocaleString('en-IN'), read: tk.pm_ocr_total != null ? Number(tk.pm_ocr_total).toLocaleString('en-IN') : '?' })}{tk.pm_ocr_items != null ? ` ${t('maint.ocrSawLineItems', { defaultValue: '(OCR saw {{n}} line items)', n: tk.pm_ocr_items })}` : ''}.
            </div>
          </div>
        )}

        {/* DEFECTIVE RETURN + close (technician) */}
        {status === 'pending_defective_return' && ((isTechnician || isAdmin) ? (
          <div style={{ border: '1px solid #FED7AA', borderRadius: 14, padding: 14, background: '#FFF7ED' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#EA580C', textTransform: 'uppercase', marginBottom: 8 }}>{t('maint.returnDefectiveClose', 'Return defective part & close')}</div>
            <PhotoUploader onBlobReady={setDefectiveBlob} label={t('maint.photoOfDefectivePart', 'Photo of defective part')} hint={t('maint.photoOfDefectivePartHint', 'Clear photo of the old/broken part')} />

            {/* Per-part disposition. A job that replaced 5 parts must account for
                all 5 — every removed unit is either repaired or scrapped, so the
                Repair page and inventory reflect the real quantities. */}
            <div style={{ margin: '10px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9A3412' }}>
                {t('maint.splitHeading', 'How many of each removed part go to Repair vs Scrap?')}
              </div>
              {defectiveLines.map((ln, i) => {
                const left = unaccounted(ln);
                return (
                  <div key={ln.storeRequestId ?? i} style={{ border: `1px solid ${left === 0 ? '#BBF7D0' : '#FED7AA'}`, background: '#fff', borderRadius: 10, padding: 9 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginBottom: 6 }}>{ln.partName}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <label style={{ fontSize: 10.5, color: '#64748B', fontWeight: 600 }}>
                        {t('maint.splitReplaced', 'Replaced')}
                        <input type="number" min="1" step="any" value={ln.replacedQty}
                          onChange={e => patchDefectiveLine(i, { replacedQty: Number(e.target.value) })}
                          style={{ ...numInput, display: 'block', marginTop: 3 }} />
                      </label>
                      <span style={{ color: '#CBD5E1', paddingBottom: 8 }}>=</span>
                      <label style={{ fontSize: 10.5, color: '#16A34A', fontWeight: 700 }}>
                        🔧 {t('maint.splitRepair', 'Repair')}
                        <input type="number" min="0" step="any" value={ln.repairQty}
                          onChange={e => patchDefectiveLine(i, { repairQty: Number(e.target.value) })}
                          style={{ ...numInput, display: 'block', marginTop: 3, borderColor: '#BBF7D0' }} />
                      </label>
                      <span style={{ color: '#CBD5E1', paddingBottom: 8 }}>+</span>
                      <label style={{ fontSize: 10.5, color: '#DC2626', fontWeight: 700 }}>
                        🗑 {t('maint.splitScrap', 'Scrap')}
                        <input type="number" min="0" step="any" value={ln.scrapQty}
                          onChange={e => patchDefectiveLine(i, { scrapQty: Number(e.target.value) })}
                          style={{ ...numInput, display: 'block', marginTop: 3, borderColor: '#FECACA' }} />
                      </label>
                      <span style={{ fontSize: 11, fontWeight: 700, paddingBottom: 8, color: left === 0 ? '#16A34A' : '#B45309' }}>
                        {left === 0
                          ? t('maint.splitBalanced', '✓ all accounted for')
                          : left > 0
                            ? t('maint.splitShort', { defaultValue: '{{n}} unaccounted for', n: left })
                            : t('maint.splitOver', { defaultValue: '{{n}} too many', n: -left })}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {uploading && <UploadBar pct={uploadPct} color="#EF6C00" />}
            <button onClick={submitDefectiveReturn} disabled={!defectiveBlob || !isSplitValid(defectiveLines) || uploading} style={{ ...primaryBtn('#EF6C00'), width: '100%', opacity: (!defectiveBlob || !isSplitValid(defectiveLines) || uploading) ? 0.5 : 1 }}>{uploading ? t('maint.uploadingEllipsis', 'Uploading…') : t('maint.submitCloseTicket', 'Submit & close ticket')}</button>
          </div>
        ) : <div style={awaitTxt}>{t('maint.awaitingDefectiveReturn', 'Awaiting technician defective-part return…')}</div>)}
      </div>
    );
  }

  // Adaptive workflow — show only the stages that apply to this ticket's actual path:
  //  • In-house repair (repairable, no store parts) → Raised → Completion Photo → Closed
  //  • Needs part, available in store        → Raised → Assessed → Store Check → Unit Head → Handover → Defective → Closed
  //  • Needs part, procurement required       → …+ Purchase → Purchase Manager between Unit Head and Handover
  // "Needs part" is known immediately from the ticket (title suffix set at raise), so a
  // freshly-raised part ticket shows the store path even before its store-request row exists.
  const anyProcured = storeReqs.some(sr => sr.store_decision === 'unavailable' || sr.purchase_required);
  const ticketPath = selectedTicket ? ticketDecision(selectedTicket.title, storeReqs.length > 0) : 'undecided';
  const wfStages = ticketPath === 'inhouse'
    ? INHOUSE_STAGES
    : ticketPath === 'store'
      ? (anyProcured ? EMERGENCY_STAGES : AVAILABLE_STAGES)
      : EMERGENCY_STAGES;
  const wfLabels = ticketPath === 'inhouse'
    ? trStageLabels(INHOUSE_STAGE_LABELS, INHOUSE_STAGE_LABEL_KEYS)
    : trStageLabels(STAGE_LABELS, STAGE_LABEL_KEYS);

  // ── Blacklist guard ─────────────────────────────────────────────────────────
  // A ticket assigned to (or raised by) a restricted person is flagged. We check
  // assigned_to first (the active worker), then fall back to raised_by. When a hit
  // is found we surface a banner in the drawer AND fire one urgent notification to
  // admin + unit_head so the restriction is visible even to supervisors who aren't
  // themselves locked out by the dashboard-level overlay.
  const blacklistHit = (() => {
    if (!selectedTicket || !blacklistReady) return null;
    // `who` stays English (it is persisted into the notification body); `whoLabel`
    // is the translated copy rendered in the banner.
    const candidates: { who: string; whoLabel: string; name: string | null }[] = [
      { who: 'assigned to', whoLabel: t('maint.whoAssignedTo', 'assigned to'), name: selectedTicket.assigned_to },
      { who: 'raised by',   whoLabel: t('maint.whoRaisedBy', 'raised by'),     name: selectedTicket.raised_by   },
    ];
    for (const c of candidates) {
      if (!c.name) continue;
      const entry = isPersonBlacklisted(c.name);
      if (entry) return { entry, who: c.who, whoLabel: c.whoLabel, name: c.name };
    }
    return null;
  })();

  const blacklistNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!blacklistHit || !selectedTicket) return;
    const key = `${selectedTicket.id}:${blacklistHit.entry.id}`;
    if (blacklistNotifiedRef.current === key) return;
    blacklistNotifiedRef.current = key;
    notifyActivity(
      blacklistHit.entry,
      `${blacklistHit.who} maintenance ticket "${selectedTicket.equipment}" (#${selectedTicket.id.slice(0, 8)})`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blacklistHit?.entry.id, selectedTicket?.id]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Tab bar */}
      <SegmentTabs
        className="mb-5"
        items={[
          { key: 'periodic', label: t('maint.periodic'), icon: <Calendar /> },
          { key: 'emergency', label: t('maint.emergency'), icon: <AlertTriangle /> },
          // Role gate identical to the old strip: hidden for technicians + store managers.
          { key: 'schedule', label: t('maint.scheduleSetup'), icon: <Settings />, hidden: isTechnician || isStoreManager },
        ]}
        value={tab}
        onChange={setTab}
      />

      {loadError ? (
        <ErrorState
          title={t('maint.loadErrorTitle', "Couldn't load maintenance")}
          message={t('maint.loadErrorMessage', 'The maintenance tickets and schedules failed to load. Check your connection and try again.')}
          onRetry={() => { setLoading(true); setLoadError(false); loadData(); }}
        />
      ) : loading ? (
        <div className="card2 p-5"><SkeletonRows rows={6} /></div>
      ) : (
      <>

      {/* ── PERIODIC TAB ─────────────────────────────────────────────────── */}
      {tab === 'periodic' && (
        <>
          <div className="grid grid-cols-12 gap-4 mb-4">
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<Calendar />} tone="amber"
              label={t('maint.dueToday')} value={dueToday}
              caption={dueToday === 0 ? t('maint.noDueToday') : t('maint.needsAttention')} />
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<CalendarDays />} tone="amber"
              label={t('maint.dueThisWeek')} value={dueWeek}
              caption={dueWeek === 0 ? t('maint.noDueWeek') : undefined} />
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<AlertTriangle />} tone="red" valueTone={overdue > 0 ? 'red' : 'default'}
              label={t('maint.overdue')} value={overdue}
              caption={overdue > 0 ? t('maint.needsAttention') : undefined} />
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<CheckCircle2 />} tone="green"
              label={t('maint.completedMtd')} value={closedPeriodicMTD}
              caption={t('maint.completedThisMonth')} />
          </div>

          <FilterBar
            className="mb-4"
            search={fltQ} onSearch={setFltQ} searchPlaceholder={t('maint.filterSearchPlaceholder')}
            onReset={resetFilters}
          >
            <FilterSelect icon={<Building2 />} value={fltPlant} onChange={setFltPlant} options={plantFilterOptions} />
            <FilterSelect icon={<Activity />} value={fltStatus} onChange={setFltStatus} options={statusFilterOptions} />
          </FilterBar>

          <SectionCard
            flush
            title={t('maint.periodicScheduleTitle')}
            subtitle={t('maint.periodicScheduleSub')}
          >
            <div className="overflow-x-auto scroll-x">
              <table className="dt2">
                <thead>
                  <tr>
                    <Th sortKey="task" s={periodicSort}>{t('maint.colTask')}</Th><Th sortKey="equipment" s={periodicSort}>{t('maint.colEquipment')}</Th><Th sortKey="plant" s={periodicSort}>{t('common.plant')}</Th><Th sortKey="frequency" s={periodicSort}>{t('maint.colFrequency')}</Th>
                    <Th sortKey="lastDone" s={periodicSort} firstDir="desc">{t('maint.colLastDone')}</Th><Th sortKey="due" s={periodicSort} firstDir="desc">{t('maint.colNextDue')}</Th><th>{t('maint.colStatus')}</th>
                    {(canMarkPeriodicComplete || isUnitHead || isAdmin) && <th>{t('maint.colAction')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {periodicSort.sorted.length === 0 && (
                    <tr><td colSpan={8} className="text-center text-slate-400 py-6 text-sm">
                      {!isTechnician ? t('maint.noSchedulesAddSelf') : t('maint.noSchedulesAdmin')}
                    </td></tr>
                  )}
                  {periodicPg.pageRows.map(s => {
                    const linkedTicket = tickets.find(tk => tk.schedule_id === s.id && tk.status !== 'closed');
                    const awaitingVerify = linkedTicket?.status === 'pending_unit_head';
                    const days = daysFromNow(s.next_due_at);
                    const due = dueDateLabel(days, t);
                    let statusKey = 'maint.schedStatusOnTrack'; let statusBg = '#DCFCE7'; let statusColor = '#16A34A';
                    if (awaitingVerify) { statusKey = ''; statusBg = '#E2E8F0'; statusColor = '#0A1628'; }
                    else if (linkedTicket) { statusKey = 'maint.schedStatusTicketOpen'; statusBg = '#DBEAFE'; statusColor = '#2563EB'; }
                    else if (days !== null && days < 0) { statusKey = 'maint.schedStatusOverdue'; statusBg = '#FEE2E2'; statusColor = '#DC2626'; }
                    else if (days !== null && days <= 3) { statusKey = 'maint.schedStatusDueSoon'; statusBg = '#FEF3C7'; statusColor = '#D97706'; }
                    return (
                      <tr key={s.id}>
                        <td className="font-semibold">{s.title}</td>
                        <td>{s.equipment}</td>
                        <td>{s.plants?.name || '—'}</td>
                        <td className="text-slate-500">{t('maint.freq_' + s.frequency, FREQ_LABEL[s.frequency] || s.frequency)}</td>
                        <td className="text-slate-500 text-xs">{s.last_completed_at ? formatDate(s.last_completed_at) : '—'}</td>
                        <td style={{ color: due.color, fontWeight: 600, fontSize: 12 }}>{due.text}</td>
                        <td><span className="badge" style={{ background: statusBg, color: statusColor }}>{awaitingVerify ? t('maint.awaitingVerification', 'Awaiting verification') : t(statusKey)}</span></td>
                        {(canMarkPeriodicComplete || isUnitHead || isAdmin) && (
                          <td>
                            {awaitingVerify ? (
                              (isUnitHead || isAdmin)
                                ? <ButtonV2 size="sm" onClick={() => setVerifyingTicket(linkedTicket!)} className="bg-[#0A1628] text-white border-none hover:bg-[#152338]">{t('maint.verify', 'Verify')}</ButtonV2>
                                : <span className="text-xs" style={{ color: '#0A1628' }}>{t('maint.awaitingVerify', 'Awaiting verify')}</span>
                            ) : canMarkPeriodicComplete && (linkedTicket || (days !== null && days <= 0)) ? (
                              <ButtonV2 size="sm" variant="primary" onClick={() => setCompletingSchedule(s)}>
                                {t('maint.markComplete')}
                              </ButtonV2>
                            ) : (
                              <span className="text-xs text-slate-400">{t('maint.notDue')}</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TablePaginationV2 controls={periodicPg.controls} label={t('maint.tasksNoun')} />
          </SectionCard>
        </>
      )}

      {/* ── EMERGENCY TAB ─────────────────────────────────────────────────── */}
      {tab === 'emergency' && (
        <>
          <div className="grid grid-cols-12 gap-4 mb-4">
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<AlertTriangle />} tone="red" valueTone={openEmergency > 0 ? 'red' : 'default'}
              label={t('maint.openTickets')} value={openEmergency}
              caption={openEmergency > 0 ? t('maint.needsAttention') : undefined} />
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<Hourglass />} tone="amber"
              label={t('maint.pendingStoreApproval')} value={pendingStore} />
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<ShoppingCart />} tone="amber"
              label={t('maint.purchaseHandover')} value={pendingPurchase} />
            <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<CheckCircle2 />} tone="green"
              label={t('maint.closedMtd')} value={closedMTD}
              caption={t('maint.completedThisMonth')} />
          </div>

          <FilterBar
            className="mb-4"
            search={fltQ} onSearch={setFltQ} searchPlaceholder={t('maint.filterSearchPlaceholder')}
            onReset={resetFilters}
          >
            <FilterSelect icon={<Building2 />} value={fltPlant} onChange={setFltPlant} options={plantFilterOptions} />
            <FilterSelect icon={<Activity />} value={fltStatus} onChange={setFltStatus} options={statusFilterOptions} />
          </FilterBar>

          <SectionCard
            flush
            title={t('maint.emergencyTitle')}
            subtitle={t('maint.emergencySub')}
            actions={
              <>
                {isAdmin && emergencyTickets.length > 0 && (
                  <ButtonV2 variant="outline" icon={<Trash2 />} onClick={handleDeleteAllEmergency} disabled={deletingAll} className="text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300">
                    {deletingAll ? t('maint.deleting') : t('maint.deleteAll', { count: emergencyTickets.length })}
                  </ButtonV2>
                )}
                {(isAdmin || isUnitHead) && (
                  <ButtonV2 variant="outline" icon={<FileText />} onClick={() => setShowReport(true)}>
                    {t('maint.createReport')}
                  </ButtonV2>
                )}
                <ButtonV2 variant="primary" icon={<Plus />} onClick={() => setShowRaisePanel(true)}>
                  {t('maint.raiseTicket')}
                </ButtonV2>
              </>
            }
          >
            <div className="overflow-x-auto scroll-x">
              <table className="dt2">
                <thead>
                  <tr>
                    <Th sortKey="ticket" s={emergencySort}>{t('maint.colTicketNo')}</Th><Th sortKey="equipment" s={emergencySort}>{t('maint.colEquipment')}</Th><Th sortKey="plant" s={emergencySort}>{t('common.plant')}</Th><Th sortKey="issue" s={emergencySort}>{t('maint.colIssue')}</Th>
                    <Th sortKey="status" s={emergencySort}>{t('maint.colStatus')}</Th><Th sortKey="raisedBy" s={emergencySort}>{t('maint.colRaisedBy')}</Th><Th sortKey="created" s={emergencySort} firstDir="desc">{t('maint.colCreated')}</Th>
                    {isAdmin && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {emergencySort.sorted.length === 0 && (
                    <tr><td colSpan={isAdmin ? 8 : 7} className="text-center text-slate-400 py-6 text-sm">{t('maint.noEmergencyTickets')}</td></tr>
                  )}
                  {emergencyPg.pageRows.map(tk => (
                    <tr key={tk.id} onClick={() => setSelectedTicket(tk)} style={{ cursor: 'pointer' }}>
                      <td className="font-mono text-xs text-slate-400">{tk.id.slice(0, 8)}</td>
                      <td className="font-semibold">{tk.equipment}</td>
                      <td>{tk.plants?.name || '—'}</td>
                      <td className="text-slate-500 text-xs">{tk.description ? <MentionText text={tk.description} /> : tk.title}</td>
                      <td>{statusBadge(tk.status, t)}</td>
                      <td className="text-slate-500 text-xs">{tk.raised_by || '—'}</td>
                      <td className="text-slate-500 text-xs">{formatDate(tk.created_at)}</td>
                      {isAdmin && (
                        <td>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteTicket(tk); }}
                            title={t('maint.deleteTicketTitle', 'Delete ticket')}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#DC2626', fontSize: 13, padding: '2px 6px', lineHeight: 1 }}
                          >🗑</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePaginationV2 controls={emergencyPg.controls} label={t('maint.ticketsNoun')} />
          </SectionCard>
        </>
      )}

      {/* ── SCHEDULE SETUP TAB ─────────────────────────────────────────────── */}
      {tab === 'schedule' && !isTechnician && !isStoreManager && (
        <SectionCard
          flush
          title={t('maint.schedulesTitle')}
          subtitle={t('maint.schedulesSub')}
          actions={(isAdmin || isUnitHead) && (
            <>
              <ButtonV2 variant="outline" icon={<Upload />} onClick={() => setShowPMImport(true)}>{t('maint.importPmWorkbook', 'Import PM workbook')}</ButtonV2>
              <ButtonV2 variant="accent" icon={<Plus />} onClick={openAddSchedule}>
                {t('maint.addSchedule')}
              </ButtonV2>
            </>
          )}
        >
          {/* Each plant maintains its own PM workbook — filter the register by
              plant. Always shown, even with one factory, so the register is never
              ambiguous about whose schedules these are. */}
          {schedulePlants.length === 1 && (
            <div className="flex gap-2 mb-3 flex-wrap px-5 items-center">
              <span className="chip active" style={{ cursor: 'default' }}>
                {t('common.plant', 'Plant')}: {schedulePlants[0].name}
              </span>
              {!schedulePlants[0].hasData && (
                <span style={{ fontSize: 11, color: '#94A3B8' }}>{t('maint.noScheduleImport', 'no PM workbook imported yet')}</span>
              )}
            </div>
          )}
          {schedulePlants.length > 1 && (
            <div className="flex gap-2 mb-3 flex-wrap px-5">
              <button onClick={() => setSchedPlantFilter([])} className={`chip${schedPlantFilter.length === 0 ? ' active' : ''}`}>{t('common.allPlants')}</button>
              {schedulePlants.map(p => (
                <button
                  key={p.id}
                  onClick={() => setSchedPlantFilter(f => f.includes(p.id) ? f.filter(x => x !== p.id) : [...f, p.id])}
                  className={`chip${schedPlantFilter.includes(p.id) ? ' active' : ''}`}
                  style={p.hasData ? undefined : { opacity: 0.55 }}
                  title={p.hasData ? undefined : t('maint.noScheduleImport', 'no PM workbook imported yet')}
                >
                  {p.name}{p.hasData ? '' : ' ·'}
                </button>
              ))}
              {schedPlantFilter.length > 1 && <span style={{ fontSize: 11, color: '#94A3B8', alignSelf: 'center' }}>{t('maint.combined', 'combined')}</span>}
            </div>
          )}
          <div className="overflow-x-auto scroll-x">
            <table className="dt2">
              <thead>
                <tr>
                  <Th sortKey="task" s={scheduleSort}>{t('maint.colTaskTitle')}</Th><Th sortKey="equipment" s={scheduleSort}>{t('maint.colEquipment')}</Th><Th sortKey="plant" s={scheduleSort}>{t('common.plant')}</Th><Th sortKey="frequency" s={scheduleSort}>{t('maint.colFrequency')}</Th>
                  <Th sortKey="assignedTo" s={scheduleSort}>{t('maint.colAssignedTo')}</Th><Th sortKey="due" s={scheduleSort} firstDir="desc">{t('maint.colNextDue')}</Th><Th sortKey="status" s={scheduleSort}>{t('maint.colStatus')}</Th>
                  {(isAdmin || isUnitHead) && <th>{t('maint.colActions')}</th>}
                </tr>
              </thead>
              <tbody>
                {shownSchedules.length === 0 && (
                  <tr><td colSpan={(isAdmin || isUnitHead) ? 8 : 7} className="text-center text-slate-400 py-6 text-sm">{t('maint.noSchedulesDefined')}</td></tr>
                )}
                {schedulePg.pageRows.map(s => {
                  const due = dueDateLabel(daysFromNow(s.next_due_at), t);
                  const paused = !s.is_active;
                  return (
                    <tr key={s.id} style={paused ? { opacity: 0.6 } : undefined}>
                      <td className="font-semibold">{s.title}</td>
                      <td>{s.equipment}</td>
                      <td>{s.plants?.name || '—'}</td>
                      <td>{t('maint.freq_' + s.frequency, FREQ_LABEL[s.frequency] || s.frequency)}</td>
                      <td>{s.assigned_to || <span className="text-slate-400">{t('maint.unassigned')}</span>}</td>
                      <td style={{ color: paused ? '#94A3B8' : due.color, fontWeight: 600 }}>{paused ? t('maint.paused') : due.text}</td>
                      <td><span className="badge" style={{ background: s.is_active ? '#DCFCE7' : '#F1F5F9', color: s.is_active ? '#16A34A' : '#94A3B8' }}>{s.is_active ? t('maint.active') : t('maint.paused')}</span></td>
                      {(isAdmin || isUnitHead) && (
                        <td>
                          <ScheduleRowMenu
                            isActive={s.is_active}
                            deleting={deletingScheduleId === s.id}
                            onRevise={() => openEditSchedule(s)}
                            onToggle={() => toggleScheduleActive(s)}
                            onDuplicate={() => openDuplicateSchedule(s)}
                            onDelete={() => handleDeleteSchedule(s)}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TablePaginationV2 controls={schedulePg.controls} label={t('maint.tasksNoun')} />
        </SectionCard>
      )}

      </>
      )}

      {/* ── PANEL: Raise ticket ──────────────────────────────────────────── */}
      <SlidePanel open={showRaisePanel} onClose={() => { setShowRaisePanel(false); setRaiseSaved(false); }} title={t('maint.raisePanelTitle')} subtitle={t('maint.raisePanelSubtitle')}>
        <PanelField label={t('maint.equipmentAsset')}>
          <FarEquipField
            value={raiseForm.equipment}
            assets={raiseFarAssets}
            onChange={v => setRaiseForm(f => ({ ...f, equipment: v, farAssetId: '', equipmentMark: '' }))}
            onPick={a => setRaiseForm(f => ({ ...f, farAssetId: a?.id ?? '', equipmentMark: a?.identification_mark ?? '', plant: a?.plant_id ?? f.plant }))}
          />
          {raiseForm.equipment.trim().length > 1 && (raiseForm.farAssetId
            ? <div style={{ fontSize: 11, color: '#16A34A', marginTop: 4 }}>{t('maint.linkedToFarAsset', '✓ Linked to FAR asset')}{raiseForm.equipmentMark ? ` · ${raiseForm.equipmentMark}` : ''}.</div>
            : <div style={{ fontSize: 11, color: '#B45309', marginTop: 4 }}>{t('maint.manualEntryNotInFar', '✎ Manual entry — not in the FAR (allowed; the notification flags it).')}</div>)}
        </PanelField>
        {/* No procurement-unit selector.
            Chlorides and Plasticiser were sub-units of a single 'Rehla' plant,
            invented to route procurement inside it. They are now first-class
            factories — SCPL – Rehla IS chlorides, SPPL – Rehla IS plasticiser —
            so picking a factory already says which unit it is. Asking again was
            asking the same question twice. */}
        <PanelField label={t('common.plant')}>
          <PanelSelect value={raiseForm.plant} onChange={e => setRaiseForm(f => ({ ...f, plant: e.target.value, unit: '' }))}>
            <option value="">{t('maint.selectPlant')}</option>
            {plantOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </PanelSelect>
        </PanelField>
        <PanelField label={t('maint.issueDescription')}>
          <PanelTextarea value={raiseForm.description} onChange={e => setRaiseForm(f => ({ ...f, description: e.target.value }))} placeholder={t('maint.issuePlaceholder')} />
        </PanelField>
        <PanelField label={t('maint.initialAssessment')}>
          <PanelSelect value={raiseForm.assessment} onChange={e => setRaiseForm(f => ({ ...f, assessment: e.target.value }))}>
            <option value="repairable">{t('maint.canRepair')}</option>
            <option value="needs_part">{t('maint.needPart')}</option>
          </PanelSelect>
        </PanelField>
        <PhotoUploader onBlobReady={setRaisePhotoBlob} label={t('maint.defectivePhoto')} hint={t('maint.defectivePhotoHint')} />
        {uploading && <UploadBar pct={uploadPct} color="#EF6C00" />}
        <PanelDivider />
        <PanelFooter saved={raiseSaved} onCancel={() => setShowRaisePanel(false)} onSave={handleRaiseTicket} saveLabel={raising ? t('maint.raising') : t('maint.raiseTicket')} successLabel={t('maint.ticketRaised')} successSub={t('maint.ticketRaisedSub')} disabled={!raiseForm.equipment.trim() || raising} requiredHint={t('maint.raiseRequiredHint')} />
      </SlidePanel>

      {/* ── PANEL: Complete periodic ─────────────────────────────────────── */}
      <SlidePanel open={!!completingSchedule} onClose={() => { setCompletingSchedule(null); setCompletionBlob(null); }} title={t('maint.markMaintenanceComplete', 'Mark maintenance complete')} subtitle={completingSchedule?.title || t('maint.periodicMaintenanceSub', 'Periodic · Maintenance')} locked={uploading}>
        {completingSchedule && (
          <>
            {(() => { const ra = completingSchedule.requires_approval ?? (completingSchedule.frequency !== 'daily'); const doneN = completionChecklist.filter(c => c.done).length; return (
            <>
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, padding: 14, marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{completingSchedule.equipment}</div>
              <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{t('maint.freqMaintenanceLine', { defaultValue: '{{freq}} maintenance', freq: t('maint.freq_' + completingSchedule.frequency, FREQ_LABEL[completingSchedule.frequency] || completingSchedule.frequency) })} · {completingSchedule.plants?.name || '—'}</div>
              {completingSchedule.description && <div style={{ fontSize: 12, color: '#475569', marginTop: 6 }}>{completingSchedule.description}</div>}
              <div style={{ fontSize: 11.5, color: ra ? '#B45309' : '#16A34A', marginTop: 6, fontWeight: 600 }}>{ra ? t('maint.needsUnitHeadVerification', '🔎 Needs unit-head verification after you submit.') : t('maint.dailyTaskAutoCloses', '✓ Daily task — closes automatically on submit.')}</div>
            </div>
            {/* Checklist — technician ticks off each checkpoint */}
            {completionChecklist.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t('maint.checkpoints', 'Checkpoints')}</span><span style={{ color: doneN === completionChecklist.length ? '#16A34A' : '#94A3B8' }}>{t('maint.nOfMDone', { defaultValue: '{{n}}/{{m}} done', n: doneN, m: completionChecklist.length })}</span>
                </div>
                <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, maxHeight: 220, overflowY: 'auto' }}>
                  {completionChecklist.map((c, i) => (
                    <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 12px', borderBottom: i < completionChecklist.length - 1 ? '1px solid #F1F5F9' : 'none', cursor: 'pointer' }}>
                      <input type="checkbox" checked={c.done} onChange={e => setCompletionChecklist(prev => prev.map((x, j) => j === i ? { ...x, done: e.target.checked } : x))} style={{ marginTop: 2 }} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: c.done ? '#94A3B8' : '#334155', textDecoration: c.done ? 'line-through' : 'none' }}>{c.component}</span>
                        {c.activity && <span style={{ fontSize: 11.5, color: '#94A3B8' }}> · {c.activity}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <PhotoUploader onBlobReady={setCompletionBlob} label={t('maint.uploadCompletionPhoto', 'Upload completion photo *')} hint={t('maint.uploadCompletionPhotoHint', 'Photo of the completed maintenance work as proof')} />
            {uploading && <UploadBar pct={uploadPct} color="#EF6C00" />}
            <PanelDivider />
            <PanelFooter saved={false} onCancel={() => { setCompletingSchedule(null); setCompletionBlob(null); }} onSave={handleCompletePeriodicTicket} saveLabel={uploading ? t('maint.uploadingPct', { defaultValue: 'Uploading… {{pct}}%', pct: uploadPct }) : (ra ? t('maint.submitForVerification', 'Submit for verification') : t('maint.submitAndClose', 'Submit & close'))} successLabel={ra ? t('maint.sentForVerification', 'Sent for verification') : t('maint.ticketClosed', 'Ticket closed')} successSub={ra ? t('maint.unitHeadNotifiedToVerify', 'Unit head notified to verify') : t('maint.nextDueDateUpdated', 'Next due date updated')} disabled={!completionBlob || uploading} requiredHint={t('maint.uploadPhotoToConfirm', 'Upload a photo to confirm completion')} />
            </>
            ); })()}
          </>
        )}
      </SlidePanel>

      {/* ── PANEL: Verify periodic (unit head) ───────────────────────────── */}
      <SlidePanel open={!!verifyingTicket} onClose={() => setVerifyingTicket(null)} title={t('maint.verifyMaintenance', 'Verify maintenance')} subtitle={verifyingTicket?.equipment || t('maint.periodicVerificationSub', 'Periodic · Verification')}>
        {verifyingTicket && (
          <>
            <div style={{ background: '#F1F5F9', border: '1px solid #DDD6FE', borderRadius: 12, padding: 14, marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{verifyingTicket.title}</div>
              <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{verifyingTicket.equipment} · {verifyingTicket.plants?.name || '—'} · {t('maint.completedBy', { defaultValue: 'completed by {{name}}', name: verifyingTicket.assigned_to || '—' })}</div>
            </div>
            {Array.isArray(verifyingTicket.checklist) && verifyingTicket.checklist.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', marginBottom: 6 }}>{t('maint.checkpointsReported', 'Checkpoints reported')}</div>
                <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, maxHeight: 220, overflowY: 'auto' }}>
                  {verifyingTicket.checklist.map((c, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', borderBottom: i < verifyingTicket.checklist!.length - 1 ? '1px solid #F1F5F9' : 'none' }}>
                      <span style={{ color: c.done ? '#16A34A' : '#CBD5E1', fontWeight: 800 }}>{c.done ? '✓' : '○'}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#334155' }}>{c.component}</span>
                      {c.activity && <span style={{ fontSize: 11.5, color: '#94A3B8' }}> · {c.activity}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {verifyingTicket.completion_photo_url && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', marginBottom: 6 }}>{t('maint.completionPhoto', 'Completion photo')}</div>
                <a href={verifyingTicket.completion_photo_url} target="_blank" rel="noreferrer"><img src={verifyingTicket.completion_photo_url} alt="Completion" style={{ width: '100%', borderRadius: 10, border: '1px solid #E2E8F0' }} /></a>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => verifyPeriodicTicket(verifyingTicket, false)} style={{ flex: 1, padding: '11px', borderRadius: 12, border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>{t('maint.sendBack', '↩ Send back')}</button>
              <button onClick={() => verifyPeriodicTicket(verifyingTicket, true)} style={{ flex: 2, padding: '11px', borderRadius: 12, border: 'none', background: '#16A34A', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>{t('maint.verifyAndClose', '✓ Verify & close')}</button>
            </div>
          </>
        )}
      </SlidePanel>

      {/* ── PANEL: Ticket detail ─────────────────────────────────────────── */}
      <SlidePanel
        open={!!selectedTicket}
        onClose={() => { setSelectedTicket(null); setTicketLightbox(null); setEditingTicket(false); setViewStage(null); setShowStoreForm(false); setStoreItems([{ ...BLANK_ITEM }]); setActingReqId(null); setPmForm({ itemsCount: '', billTotal: '' }); setCompletionBlob(null); setDefectiveBlob(null); setHandoverInvoiceBlob(null); setHandoverPhotoBlob(null); setDispatchBlob(null); setBusyRef(''); setUnitPrice(''); setSupplierName(''); setDefectiveDecision(''); setStoreDecisionForm({ ...BLANK_STORE_DECISION }); setRequestingChanges(false); setResubmitting(false); setChangeReason(''); setChangeTags([]); setResubmitPhotoBlob(null); setRejectReason(''); }}
        title={selectedTicket?.equipment || t('maint.ticketDetail', 'Ticket detail')}
        subtitle={`${t('maint.emergency')} · ${selectedTicket?.plants?.name || t('nav.maintenance')}`}
        locked={uploading}
      >
        {selectedTicket && (
          <>
            <StageStrip status={selectedTicket.status === 'changes_requested' ? (selectedTicket.revision_prev_status || 'open') : selectedTicket.status} stages={wfStages} labels={wfLabels} onStageClick={(s) => setViewStage((cur) => cur === s ? null : s)} activeStage={viewStage} />
            {viewStage && renderStageDetail(viewStage)}
            {blacklistHit && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 12, padding: '12px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#DC2626', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {t('maint.restrictedPersonOnTicket', '🚫 Restricted person on this ticket')}
                </div>
                <div style={{ fontSize: 12, color: '#7F1D1D', marginTop: 4, lineHeight: 1.5 }}>
                  <strong>{blacklistHit.name}</strong>{t('maint.blacklistIsWho', { defaultValue: ' is {{who}} this ticket but is on the active blacklist (', who: blacklistHit.whoLabel })}<strong>{blacklistHit.entry.severity}</strong>{t('maint.blacklistReason', { defaultValue: '). Reason: {{reason}}.', reason: blacklistHit.entry.reason })}
                  <br />{t('maint.adminUnitHeadNotified', 'Admin & Unit Head have been notified.')}
                </div>
              </div>
            )}
            <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 12, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#64748B', marginBottom: 2 }}>
                #{selectedTicket.id.slice(0, 8)} · {t('maint.colRaisedBy', 'Raised by')} {selectedTicket.raised_by || '—'}
                {selectedTicket.assigned_to && <> · {t('maint.colAssignedTo', 'Assigned to')} {selectedTicket.assigned_to}</>} · {formatDate(selectedTicket.created_at)}
                {/* Historical only — tickets raised before the units were retired
                    still record which one they were routed to. Shown so the old
                    audit trail stays readable; nothing writes it any more. */}
                {selectedTicket.unit && <> · <span style={{ color: '#A21CAF', fontWeight: 700 }}>{selectedTicket.unit}</span></>}
              </div>
              {selectedTicket.description && <div style={{ fontSize: 13, color: '#0F172A', marginTop: 4 }}><TicketDescription entityId={selectedTicket.id} text={selectedTicket.description} /></div>}
              {/* Evidence photos inline. The defect photo the technician attaches at
                  raise time used to live only in the Activity Log, so a reviewer had
                  to leave the ticket to see what actually broke. */}
              {(() => {
                const shots: LightboxImage[] = [];
                const add = (url: string | null | undefined, label: string) => { if (url) shots.push({ url, label }); };
                add(selectedTicket.defective_raise_photo_url, t('maint.reportedDefectPhoto', 'Reported defect'));
                add(selectedStoreReq?.handover_photo_url, t('maint.partReceivedPhoto', 'Part received photo'));
                add(selectedTicket.defective_part_photo_url, t('maint.defectivePartPhoto', 'Defective part photo'));
                add(selectedTicket.completion_photo_url, t('maint.completionPhoto', 'Completion photo'));
                if (!shots.length) return null;
                return (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                      {t('maint.photosOnTicket', 'Photos on this ticket')}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {shots.map((s, i) => (
                        <button
                          key={s.url}
                          type="button"
                          onClick={() => setTicketLightbox({ images: shots, index: i })}
                          title={t('activity.viewPhotos', 'View photo(s)')}
                          style={{ padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in', fontFamily: 'inherit', textAlign: 'left', maxWidth: 108 }}
                        >
                          <img src={s.url} alt={s.label} loading="lazy" style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 10, border: '1px solid #E2E8F0', display: 'block', background: '#F1F5F9' }} />
                          <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 4, lineHeight: 1.3 }}>{s.label}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Notes are visible to everyone on the ticket; edit/delete are admin-only.
                Request Changes lets a reviewer send the ticket back for correction. */}
            {!editingTicket && !requestingChanges && !resubmitting && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <NotesButton entityType="maintenance_ticket" entityId={selectedTicket.id} entityLabel={selectedTicket.equipment || selectedTicket.title || 'Ticket'} route={`/dashboard/purchase/maint?ticket=${selectedTicket.id}`} />
                {(isUnitHead || isAdmin) && !['closed', 'changes_requested'].includes(selectedTicket.status) && (
                  <button onClick={() => { setChangeTags([]); setChangeReason(''); setRequestingChanges(true); }} className="chip" style={{ color: '#DC2626' }}>{t('maint.requestChangesChip', '↩ Request Changes')}</button>
                )}
                {isAdmin && <button onClick={() => startEdit(selectedTicket)} className="chip">{t('maint.editChip', '✎ Edit')}</button>}
                {isAdmin && <button onClick={() => handleDeleteTicket(selectedTicket)} className="chip" style={{ color: '#DC2626' }}>{t('maint.deleteChip', '🗑 Delete')}</button>}
              </div>
            )}

            {editingTicket ? (
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 14, padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>{t('maint.editTicketAdmin', 'Edit ticket (admin)')}</div>
                <PanelField label={t('maint.equipmentAssetPlain', 'Equipment / asset')}>
                  <PanelInput value={editForm.equipment} onChange={e => setEditForm(f => ({ ...f, equipment: e.target.value }))} />
                </PanelField>
                <PanelRow>
                  <PanelField label={t('common.plant')}>
                    <PanelSelect value={editForm.plant} onChange={e => setEditForm(f => ({ ...f, plant: e.target.value }))}>
                      <option value="">{t('maint.selectPlant')}</option>
                      {plantOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </PanelSelect>
                  </PanelField>
                  <PanelField label={t('maint.colStatus')}>
                    <PanelSelect value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}>
                      {Object.keys(STATUS_CFG).map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
                    </PanelSelect>
                  </PanelField>
                </PanelRow>
                <PanelField label={t('maint.issueDescription')}>
                  <PanelTextarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} placeholder={t('maint.editDescPlaceholder', 'What broke? Type @ to tag someone.')} />
                </PanelField>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={() => setEditingTicket(false)} style={{ flex: 1, padding: '10px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: 'inherit' }}>{t('common.cancel', 'Cancel')}</button>
                  <button onClick={saveEdit} disabled={!editForm.equipment.trim()} style={{ flex: 2, padding: '10px', borderRadius: 12, border: 'none', background: '#EF6C00', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'inherit', opacity: !editForm.equipment.trim() ? 0.5 : 1 }}>{t('maint.saveChanges', 'Save changes')}</button>
                </div>
              </div>
            ) : requestingChanges ? (
              /* Reviewer: send back for correction */
              <div style={{ border: '1px solid #FCA5A5', borderRadius: 14, padding: 16, background: '#FFF7F7' }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{t('maint.requestChangesTitle', '↩ Request changes')}</div>
                <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>{t('maint.requestChangesSub', 'Send this ticket back to the technician to correct. They edit the same ticket and resubmit for another review.')}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{t('maint.whatNeedsFixing', 'What needs fixing?')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {CHANGE_ISSUE_TAGS.map(tag => {
                    const on = changeTags.includes(tag);
                    return <button key={tag} onClick={() => setChangeTags(s => on ? s.filter(x => x !== tag) : [...s, tag])} style={{ padding: '5px 10px', borderRadius: 999, border: '1px solid ' + (on ? '#DC2626' : '#E2E8F0'), background: on ? '#DC2626' : '#fff', color: on ? '#fff' : '#475569', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>{CHANGE_TAG_KEYS[tag] ? t(CHANGE_TAG_KEYS[tag], tag) : tag}</button>;
                  })}
                </div>
                <PanelField label={t('maint.commentRequired', 'Comment (required)')}>
                  <PanelTextarea value={changeReason} onChange={e => setChangeReason(e.target.value)} placeholder={t('maint.commentPlaceholder', 'Explain what to correct. Type @ to tag someone.')} />
                </PanelField>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={() => { setRequestingChanges(false); setChangeTags([]); setChangeReason(''); }} style={{ flex: 1, padding: '10px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: 'inherit' }}>{t('common.cancel', 'Cancel')}</button>
                  <button onClick={submitRequestChanges} disabled={savingRevision || (!changeTags.length && !changeReason.trim())} style={{ flex: 2, padding: '10px', borderRadius: 12, border: 'none', background: '#DC2626', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'inherit', opacity: (savingRevision || (!changeTags.length && !changeReason.trim())) ? 0.5 : 1 }}>{savingRevision ? t('maint.sendingEllipsis', 'Sending…') : t('maint.sendBackToTechnician', 'Send back to technician')}</button>
                </div>
              </div>
            ) : resubmitting ? (
              /* Technician: revise & resubmit the same ticket */
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 14, padding: 16 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{t('maint.reviseResubmitTitle', '✎ Revise & resubmit')}</div>
                <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>{t('maint.reviseResubmitSub', 'Fix what the reviewer flagged, then resubmit the same ticket for another review.')}</div>
                {selectedTicket.revision_reason && <div style={{ fontSize: 12, color: '#7F1D1D', background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 10, padding: '8px 10px', marginBottom: 12 }}><strong>{t('maint.reviewerAsked', 'Reviewer asked:')}</strong> {selectedTicket.revision_reason}</div>}
                <PanelField label={t('maint.equipmentAssetPlain', 'Equipment / asset')}>
                  <PanelInput value={resubmitForm.equipment} onChange={e => setResubmitForm(f => ({ ...f, equipment: e.target.value }))} />
                </PanelField>
                <PanelRow>
                  <PanelField label={t('common.plant')}>
                    <PanelSelect value={resubmitForm.plant} onChange={e => setResubmitForm(f => ({ ...f, plant: e.target.value }))}>
                      <option value="">{t('maint.selectPlant')}</option>
                      {plantOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </PanelSelect>
                  </PanelField>
                  <PanelField label={t('maint.assessmentLabel', 'Assessment')}>
                    <PanelSelect value={resubmitForm.assessment} onChange={e => setResubmitForm(f => ({ ...f, assessment: e.target.value }))}>
                      <option value="repairable">{t('maint.canRepair')}</option>
                      <option value="needs_part">{t('maint.needAPart', 'Need a part')}</option>
                    </PanelSelect>
                  </PanelField>
                </PanelRow>
                <PanelField label={t('maint.issueDescription')}>
                  <PanelTextarea value={resubmitForm.description} onChange={e => setResubmitForm(f => ({ ...f, description: e.target.value }))} placeholder={t('maint.resubmitDescPlaceholder', 'Describe the issue. Type @ to tag someone.')} />
                </PanelField>
                <PhotoUploader label={t('maint.replacePhotoOptional', 'Replace photo (optional)')} hint={t('maint.replacePhotoHint', 'Upload a clearer photo of the item')} onBlobReady={setResubmitPhotoBlob} />
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={() => { setResubmitting(false); setResubmitPhotoBlob(null); }} style={{ flex: 1, padding: '10px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: 'inherit' }}>{t('common.cancel', 'Cancel')}</button>
                  <button onClick={submitResubmit} disabled={savingRevision || uploading || !resubmitForm.equipment.trim()} style={{ flex: 2, padding: '10px', borderRadius: 12, border: 'none', background: '#EF6C00', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'inherit', opacity: (savingRevision || uploading || !resubmitForm.equipment.trim()) ? 0.5 : 1 }}>{(savingRevision || uploading) ? t('maint.resubmittingEllipsis', 'Resubmitting…') : t('maint.resubmitForReview', 'Resubmit for review')}</button>
                </div>
              </div>
            ) : selectedTicket.status === 'changes_requested' ? (
              /* Paused for correction — show the reviewer's request + resubmit CTA */
              <div style={{ border: '1px solid #FCA5A5', background: '#FEF2F2', borderRadius: 14, padding: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#DC2626', display: 'flex', alignItems: 'center', gap: 6 }}>{t('maint.changesRequestedTitle', '↩ Changes requested')}{selectedTicket.revision_count ? ` · ${t('maint.cycleN', { defaultValue: 'cycle {{n}}', n: selectedTicket.revision_count })}` : ''}</div>
                {selectedTicket.revision_reason && <div style={{ fontSize: 12.5, color: '#7F1D1D', marginTop: 6, lineHeight: 1.5 }}>{selectedTicket.revision_reason}</div>}
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>{t('maint.requestedByName', { defaultValue: 'Requested by {{name}}', name: selectedTicket.revision_requested_by || '—' })}{selectedTicket.revision_requested_at ? ` · ${formatDate(selectedTicket.revision_requested_at)}` : ''}</div>
                {canResubmitChanges(selectedTicket) ? (
                  <button onClick={() => startResubmit(selectedTicket)} style={{ marginTop: 12, width: '100%', padding: '10px', borderRadius: 12, border: 'none', background: '#EF6C00', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'inherit' }}>{t('maint.reviseResubmitBtn', '✎ Revise & Resubmit')}</button>
                ) : (
                  <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 10 }}>{t('maint.waitingForTechnicianResubmit', 'Waiting for the operator to correct & resubmit.')}</div>
                )}
              </div>
            ) : (
              renderTicketActions()
            )}
          </>
        )}
      </SlidePanel>

      {/* PM workbook import → FAR-validated recurring schedules */}
      <PMScheduleImport open={showPMImport} onClose={() => setShowPMImport(false)} onImported={loadData} />

      {/* ── PANEL: Add / revise schedule ─────────────────────────────────── */}
      <SlidePanel open={showSchedulePanel} onClose={closeSchedulePanel} title={editingSchedule ? t('maint.reviseSchedulePanelTitle', 'Revise maintenance schedule') : t('maint.addSchedulePanelTitle', 'Add maintenance schedule')} subtitle={t('maint.schedulePanelSubtitle', 'Schedule Setup · Maintenance')}>
        <PanelField label={t('maint.taskTitleRequired', 'Task title *')}>
          <PanelInput value={scheduleForm.title} onChange={e => setScheduleForm(f => ({ ...f, title: e.target.value }))} placeholder={t('maint.taskTitlePlaceholder', 'e.g. Boiler bearing check, Filter replacement')} />
        </PanelField>
        <PanelField label={t('maint.equipmentFromFar', 'Equipment * (from FAR)')}>
          <FarEquipField
            value={scheduleForm.equipment}
            assets={farAssets}
            onChange={v => setScheduleForm(f => ({ ...f, equipment: v }))}
            onPick={a => setScheduleForm(f => ({ ...f, farAssetId: a?.id ?? '', equipmentMark: a?.identification_mark ?? '', plant: a?.plant_id ?? f.plant }))}
          />
          {scheduleForm.equipment.trim().length > 1 && (scheduleForm.farAssetId
            ? <div style={{ fontSize: 11, color: '#16A34A', marginTop: 4 }}>{t('maint.linkedToFarAsset', '✓ Linked to FAR asset')}{scheduleForm.equipmentMark ? ` · ${scheduleForm.equipmentMark}` : ''}.</div>
            : <div style={{ fontSize: 11, color: '#B45309', marginTop: 4 }}>{t('maint.notRegisteredFarAsset', '⚠ Not a registered FAR asset — allowed, but add a reason below (admin is notified).')}</div>)}
        </PanelField>
        {scheduleForm.equipment.trim().length > 1 && !scheduleForm.farAssetId && (
          <PanelField label={t('maint.reasonNotInFar', 'Reason (equipment not in FAR)')}>
            <PanelInput value={scheduleForm.unmatchedReason} onChange={e => setScheduleForm(f => ({ ...f, unmatchedReason: e.target.value }))} placeholder={t('maint.reasonNotInFarPlaceholder', 'e.g. Newly installed; FAR upload pending')} />
          </PanelField>
        )}
        <PanelRow>
          <PanelField label={scheduleForm.farAssetId ? t('maint.plantSetByFar', 'Plant (set by FAR asset)') : t('common.plant')}>
            <PanelSelect value={scheduleForm.plant} disabled={!!scheduleForm.farAssetId} onChange={e => setScheduleForm(f => ({ ...f, plant: e.target.value }))}>
              <option value="">{t('maint.allPlantsOption', '— All plants —')}</option>
              {plantOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </PanelSelect>
            {scheduleForm.farAssetId && <div style={{ fontSize: 11, color: '#64748B', marginTop: 4 }}>{t('maint.lockedToFarPlant', "🔒 Locked to the FAR asset's plant.")}</div>}
          </PanelField>
          <PanelField label={t('maint.colFrequency')}>
            <PanelSelect value={scheduleForm.frequency} onChange={e => setScheduleForm(f => ({ ...f, frequency: e.target.value }))}>
              {FREQ_OPTIONS.map(f => <option key={f} value={f}>{t('maint.freq_' + f, FREQ_LABEL[f] || f)}</option>)}
            </PanelSelect>
          </PanelField>
        </PanelRow>
        <PanelRow>
          <PanelField label={editingSchedule ? t('maint.nextDueDate', 'Next due date') : t('maint.firstDueDate', 'First due date')}>
            <PanelInput type="date" value={scheduleForm.firstDue} onChange={e => setScheduleForm(f => ({ ...f, firstDue: e.target.value }))} />
          </PanelField>
          <PanelField label={t('maint.continueUntilOptional', 'Continue until (optional)')}>
            <PanelInput type="date" value={scheduleForm.until} onChange={e => setScheduleForm(f => ({ ...f, until: e.target.value }))} />
          </PanelField>
        </PanelRow>
        <PanelRow>
          <PanelField label={t('maint.assignTo', 'Assign to')}>
            <PanelSelect value={scheduleForm.assignedTo} onChange={e => setScheduleForm(f => ({ ...f, assignedTo: e.target.value }))}>
              <option value="">{t('maint.unassignedOption', '— Unassigned —')}</option>
              {ASSIGNABLE_STAFF.map(s => <option key={s.name} value={s.name}>{s.label}</option>)}
              {/* Keep a current assignee selectable even if they're no longer in the standard staff list. */}
              {scheduleForm.assignedTo && !ASSIGNABLE_STAFF.some(s => s.name === scheduleForm.assignedTo) && (
                <option value={scheduleForm.assignedTo}>{scheduleForm.assignedTo} {t('maint.currentSuffix', '(current)')}</option>
              )}
            </PanelSelect>
          </PanelField>
        </PanelRow>
        {editingSchedule && (
          <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 11, color: '#0369A1' }}>
            {t('maint.reassignOwnerHintPre', 'Reassign the owner here if the current person has left — the schedule and its history stay intact. Use ')}<b>{t('maint.pause', 'Pause')}</b>{t('maint.reassignOwnerHintPost', ' on the row to put it on hold instead.')}
          </div>
        )}
        {scheduleForm.assignedTo && blacklistReady && isPersonBlacklisted(scheduleForm.assignedTo) && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 11, color: '#B91C1C', fontWeight: 600 }}>
            {t('maint.assigneeBlacklisted', { defaultValue: '🚫 {{name}} is on the active blacklist. Admin & Unit Head will be notified on save.', name: scheduleForm.assignedTo })}
          </div>
        )}
        <PanelField label={t('maint.taskDescriptionChecklist', 'Task description / checklist')}>
          <PanelTextarea value={scheduleForm.description} onChange={e => setScheduleForm(f => ({ ...f, description: e.target.value }))} placeholder={t('maint.taskDescPlaceholder', 'Steps to complete, tools needed, safety precautions…')} />
        </PanelField>
        <PanelDivider />
        <PanelFooter saved={scheduleSaved} onCancel={closeSchedulePanel} onSave={handleSaveSchedule} saveLabel={savingSchedule ? t('maint.savingEllipsis', 'Saving…') : (editingSchedule ? t('maint.saveChanges', 'Save changes') : t('maint.saveSchedule', 'Save schedule'))} successLabel={editingSchedule ? t('maint.scheduleUpdated', 'Schedule updated') : t('maint.scheduleCreated', 'Schedule created')} successSub={editingSchedule ? t('maint.scheduleUpdatedSub', 'Changes saved · next ticket uses new settings') : t('maint.scheduleCreatedSub', 'Ticket will auto-generate on due date')} disabled={!scheduleForm.title.trim() || !scheduleForm.equipment.trim() || savingSchedule} requiredHint={t('maint.scheduleRequiredHint', 'Fill in title and equipment to create schedule')} />
      </SlidePanel>

      {/* ── PANEL: Create maintenance report (CSV) ───────────────────────────── */}
      <SlidePanel open={showReport} onClose={() => setShowReport(false)} title={t('maint.createReportPanelTitle', 'Create maintenance report')} subtitle={t('maint.createReportPanelSub', 'Export · CSV')}>
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 18, lineHeight: 1.5 }}>
          {t('maint.reportIntro', "Pick what to include. The CSV carries the full life of each ticket — maintenance ID, who raised it & their role, who's tagged/watching, the whole part-procurement trail, every timestamp, and how it was resolved — plus a header noting who generated the report and when. Tick the box below to also export the @-mention/notes timeline as a second CSV.")}
        </div>

        <PanelField label={t('maint.includeTicketTypes', 'Include ticket types')}>
          <div style={{ display: 'flex', gap: 8 }}>
            {([['emergency', t('maint.reportEmergencyOption', '⚡ Emergency')], ['periodic', t('maint.reportPeriodicOption', '🔄 Periodic')]] as const).map(([key, label]) => {
              const on = reportForm[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setReportForm(f => ({ ...f, [key]: !f[key] }))}
                  style={{
                    flex: 1, padding: '10px', borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'inherit',
                    border: `2px solid ${on ? '#EF6C00' : '#E2E8F0'}`, background: on ? '#FFF7F5' : '#F8FAFC', color: on ? '#EF6C00' : '#64748B',
                  }}
                >
                  {on ? '✓ ' : ''}{label}
                </button>
              );
            })}
          </div>
        </PanelField>

        <PanelField label={t('maint.colStatus')}>
          <PanelSelect value={reportForm.status} onChange={e => setReportForm(f => ({ ...f, status: e.target.value }))}>
            <option value="all">{t('maint.allStatuses', 'All statuses')}</option>
            <option value="open">{t('maint.openInProgressOnly', 'Open / in progress only')}</option>
            <option value="closed">{t('maint.closedOnly', 'Closed only')}</option>
          </PanelSelect>
        </PanelField>

        <PanelRow>
          <PanelField label={t('maint.fromDateCreated', 'From date (created)')}>
            <PanelInput type="date" value={reportForm.from} onChange={e => setReportForm(f => ({ ...f, from: e.target.value }))} />
          </PanelField>
          <PanelField label={t('maint.toDateCreated', 'To date (created)')}>
            <PanelInput type="date" value={reportForm.to} onChange={e => setReportForm(f => ({ ...f, to: e.target.value }))} />
          </PanelField>
        </PanelRow>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', cursor: 'pointer', marginBottom: 8 }}>
          <input type="checkbox" checked={reportForm.includeNotes} onChange={e => setReportForm(f => ({ ...f, includeNotes: e.target.checked }))} />
          {t('maint.alsoExportNotes', 'Also export the notes / @-mention activity log (second CSV)')}
        </label>

        <PanelDivider />
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12, textAlign: 'center' }}>
          <strong style={{ color: '#0F172A' }}>{reportTickets().length}</strong> {t('maint.ticketsMatchFilters', 'tickets match these filters')}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={() => setShowReport(false)} style={{ flex: 1, padding: '11px 0', borderRadius: 24, border: '1px solid #E2E8F0', background: '#F8FAFC', fontSize: 13, fontWeight: 600, color: '#475569', cursor: 'pointer', fontFamily: 'inherit' }}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button type="button" onClick={generateReport} disabled={generating || reportTickets().length === 0} style={{ flex: 2, padding: '11px 0', borderRadius: 24, border: 'none', background: (generating || reportTickets().length === 0) ? '#CBD5E1' : '#EF6C00', fontSize: 13, fontWeight: 700, color: '#fff', cursor: (generating || reportTickets().length === 0) ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
            {generating ? t('maint.generatingEllipsis', 'Generating…') : t('maint.generateCsvReport', 'Generate CSV report')}
          </button>
        </div>
      </SlidePanel>

      {/* Mounted outside the panels so closing a panel can't strand an open viewer. */}
      <ImageLightbox
        images={ticketLightbox?.images ?? []}
        startIndex={ticketLightbox?.index ?? 0}
        open={!!ticketLightbox}
        onClose={() => setTicketLightbox(null)}
      />
    </>
  );
}

/**
 * The ticket description shown in the detail panel. The raise description is
 * persisted as the ticket's first note, so we mirror that note's read-receipt
 * here: @names go green per-person as they're seen, and a WhatsApp-style tick
 * (sent / delivered / seen) sits beside the line. Degrades to plain highlighted
 * text when no matching note/receipt exists (e.g. tickets raised before this).
 */
function TicketDescription({ entityId, text }: { entityId: string; text: string }) {
  const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set());
  const [tick, setTick] = useState<ReturnType<typeof tickState>>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const notes = await getNotes('maintenance_ticket', entityId);
      const target = (text || '').trim();
      // The raise note: earliest note whose body matches the description and
      // that actually tagged someone (so there's a receipt to show).
      const note = notes.find((n) => (n.body || '').trim() === target && (n.mentions?.length ?? 0) > 0);
      if (!note) { if (!cancelled) { setSeenIds(new Set()); setTick(null); } return; }
      const recs = await getReceipts([note.id]);
      if (cancelled) return;
      setSeenIds(seenProfileIds(recs));
      setTick(tickState(note.mentions || [], recs));
    })();
    return () => { cancelled = true; };
  }, [entityId, text]);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <MentionText text={text} seenIds={seenIds} />
      {tick && <ReadReceipt state={tick} />}
    </span>
  );
}

// ── Inline upload progress bar ────────────────────────────────────────────────

function UploadBar({ pct, color, phase = 'uploading' }: { pct: number; color: string; phase?: 'verifying' | 'uploading' }) {
  const { t } = useTranslation();
  // "verifying" = the AI is reading the bill (a single call with no real streaming),
  // so we show an indeterminate sliding bar and an explicit label instead of a stuck 0%.
  if (phase === 'verifying') {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: '#64748B', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 11, height: 11, borderRadius: '50%', border: `2px solid ${color}55`, borderTopColor: color, display: 'inline-block', animation: 'sp-spin 0.7s linear infinite' }} />
          {t('maint.readingVerifyingBill', 'Reading & verifying the bill with AI… this can take up to a minute')}
        </div>
        <div style={{ position: 'relative', height: 4, background: '#E2E8F0', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 0, bottom: 0, background: color, borderRadius: 4, animation: 'sp-indeterminate 1.3s ease-in-out infinite' }} />
        </div>
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: '#64748B', marginBottom: 4 }}>{t('maint.uploadingPct', { defaultValue: 'Uploading… {{pct}}%', pct })}</div>
      <div style={{ height: 4, background: '#E2E8F0', borderRadius: 4 }}>
        <div style={{ height: 4, background: color, borderRadius: 4, width: `${pct}%`, transition: 'width 0.2s' }} />
      </div>
    </div>
  );
}
