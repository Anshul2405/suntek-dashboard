import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDate } from '../../../lib/utils/formatting';
import { useNavigate } from 'react-router-dom';
import { useUrlFilters } from '../../../lib/urlFilters';
import { useUrlTable } from '../../../lib/urlTable';
import { hereNow, withBack } from '../../../lib/backLink';
import { useTranslation } from 'react-i18next';
import { Wrench, Trash2, PackageCheck } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { callRpc } from '../../../lib/db';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { useRoleContext } from '../../../contexts/RoleContext';
import { profileHasCapability } from '../../../lib/profiles';
import { withEmbedFallback } from '../../../lib/scopedList';
import { SkeletonRows, EmptyState } from '../../../components/ui/states';
import { ImageLightbox, type LightboxImage } from '../../../components/ui/ImageLightbox';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../../components/v2';
import { useSortable } from '../../../components/ui/useSortable';
import { ThV2 as Th, StatusPill } from '../../../components/v2';
import { TableSearch, useTextFilter } from '../../../components/ui/TableSearch';
import { useToast } from '../../../components/ui/toast';
import { RepairReturnModal } from './RepairReturnModal';
import { ticketNoLabel, useTicketNos } from '../../../lib/ticketNo';
import { statusText } from './maintenance/statusText';
import { repairPending } from '../../../lib/store/repairReturn';
import { cleanPartName } from '../../../lib/store/defectiveSplit';
import type { Database } from '../../../lib/database.types';
import { displayLocationName } from '../../../lib/plantLabels';

type TicketRow = Database['public']['Tables']['maintenance_tickets']['Row'] & { plants?: { name: string | null } | null };
type DefectivePartRow = Database['public']['Tables']['maintenance_defective_parts']['Row'];
/** One replaced part line together with the ticket it came from. */
interface PartItem { part: DefectivePartRow; ticket: TicketRow }
type ReceiptRow = Database['public']['Tables']['repair_return_receipts']['Row'] & { plants?: { name: string | null } | null };
type AllocRow = Database['public']['Tables']['repair_return_allocations']['Row'];

const fmtDate = (d: string | null | undefined) =>
  d ? formatDate(d) : '—';

/** Units of THIS part line still awaiting return from the vendor. */
function partPending(p: DefectivePartRow): number {
  return Math.max(0, Number(p.repair_qty) - Number(p.repair_returned_qty));
}

/** Return progress of one repaired part line: pending / partial / returned. */
function partReturnState(p: DefectivePartRow): 'pending' | 'partial' | 'returned' {
  const ret = Number(p.repair_returned_qty ?? 0);
  if (ret <= 0) return 'pending';
  return partPending(p) > 0 ? 'partial' : 'returned';
}

/**
 * Repair & scrap tracking — where a maintenance job's defective part ended up.
 * Sourced from maintenance_tickets.defective_part_decision ('repair' | 'scrap').
 * Repair rows carry sent/returned/pending quantities and (for authorized users)
 * a Return-to-Inventory action: returned units land in the register's separate
 * repaired-stock bucket via the apply_repair_return RPC. Scrap rows never get
 * the action — scrapped parts cannot re-enter stock.
 */
export function RepairScrapPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { scopeQuery, storeQuery } = usePlantScope();
  const { activeProfile } = useRoleContext();
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [parts, setParts] = useState<DefectivePartRow[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [allocs, setAllocs] = useState<AllocRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Search lives in the URL (?rsq=) so opening a ticket and coming back keeps it.
  const urlSearch = useUrlFilters(['rsq'] as const);
  const search = urlSearch.values.rsq;
  const setSearch = (rsq: string) => urlSearch.set({ rsq });
  const [lightbox, setLightbox] = useState<LightboxImage[] | null>(null);
  const [returnItem, setReturnItem] = useState<PartItem | null>(null);

  const canReturn = profileHasCapability(activeProfile, 'return_repairs');
  const canReverse = profileHasCapability(activeProfile, 'reverse_repair_return');

  const load = useCallback(async () => {
    const { data } = await withEmbedFallback(
      scopeQuery(supabase.from('maintenance_tickets').select('*, plants(name)'), { unitCol: 'unit_id' })
        .in('defective_part_decision', ['repair', 'scrap', 'mixed']).order('closed_at', { ascending: false }).returns<TicketRow[]>(),
      () => scopeQuery(supabase.from('maintenance_tickets').select('*'), { unitCol: 'unit_id' })
        .in('defective_part_decision', ['repair', 'scrap', 'mixed']).order('closed_at', { ascending: false }).returns<TicketRow[]>(),
      'RepairScrap.tickets',
    );
    const ticketRows = data || [];
    setRows(ticketRows);
    // Per-part Repair/Scrap split (migration 56). Best-effort: until that
    // migration runs the table is absent, and the panel falls back to the old
    // one-decision-per-ticket view rather than showing nothing.
    try {
      const { data: dp, error: dpErr } = await scopeQuery(
        supabase.from('maintenance_defective_parts').select('*'),
      ).order('created_at', { ascending: false }).returns<DefectivePartRow[]>();
      setParts(dpErr ? [] : (dp || []));
    } catch { setParts([]); }
    // Return history (best-effort — tables arrive with migration 55).
    try {
      // Receipts are STORE-keyed — a repaired part comes back into the store,
      // not into the factory that sent it out. The defective-parts list above
      // stays factory-scoped: that is maintenance, which a store grant does not
      // carry.
      const { data: rc, error: rcErr } = await withEmbedFallback(
        storeQuery(supabase.from('repair_return_receipts').select('*, plants(name)'))
          .order('created_at', { ascending: false }).limit(200).returns<ReceiptRow[]>(),
        () => storeQuery(supabase.from('repair_return_receipts').select('*'))
          .order('created_at', { ascending: false }).limit(200).returns<ReceiptRow[]>(),
        'RepairScrap.receipts',
      );
      const receiptRows = rcErr ? [] : (rc || []);
      setReceipts(receiptRows);
      if (receiptRows.length) {
        const { data: al } = await supabase.from('repair_return_allocations')
          .select('*').in('receipt_id', receiptRows.map(r => r.id)).returns<AllocRow[]>();
        setAllocs(al || []);
      } else setAllocs([]);
    } catch { setReceipts([]); setAllocs([]); }
    setLoading(false);
  }, [scopeQuery, storeQuery]);

  useEffect(() => { load(); }, [load]);

  // Join each part line to its ticket. When migration 56 hasn't run yet, derive
  // a single synthetic line per ticket from the old enum so the page still works.
  const partItems = useMemo<PartItem[]>(() => {
    const byTicket = new Map(rows.map(r => [r.id, r]));
    if (parts.length) {
      return parts
        .map(p => ({ part: p, ticket: byTicket.get(p.ticket_id) }))
        .filter((x): x is PartItem => !!x.ticket);
    }
    return rows.map(r => ({
      ticket: r,
      part: {
        id: `legacy:${r.id}`, ticket_id: r.id, store_request_id: null, plant_id: r.plant_id,
        part_name: cleanPartName(r.equipment) || cleanPartName(r.title) || 'Defective part',
        replaced_qty: Number(r.repair_qty ?? 1),
        repair_qty: r.defective_part_decision === 'scrap' ? 0 : Number(r.repair_qty ?? (r.defective_part_decision === 'repair' || r.defective_part_decision === 'mixed' ? 1 : 0)),
        scrap_qty: r.defective_part_decision === 'repair' || r.defective_part_decision === 'consumed' ? 0 : 1,
        repair_returned_qty: Number(r.repair_returned_qty ?? 0),
        store_item_id: null, photo_url: r.defective_part_photo_url,
        actor: null, actor_name: null, created_at: r.closed_at || r.created_at,
      } as DefectivePartRow,
    }));
  }, [parts, rows]);

  const filteredItems = useTextFilter(partItems, search,
    i => [i.part.part_name, i.ticket.equipment, i.ticket.plants?.name, i.ticket.id.slice(0, 8), ticketNoLabel(i.ticket), i.ticket.assigned_to]);
  // A ticket that repaired 3 and scrapped 2 appears in BOTH lists, each with
  // its own quantity — which is the whole point of the split.
  const repair = useMemo(() => filteredItems.filter(i => Number(i.part.repair_qty) > 0), [filteredItems]);
  const scrap = useMemo(() => filteredItems.filter(i => Number(i.part.scrap_qty) > 0), [filteredItems]);

  if (loading) return <div className="card2 p-6" style={{ marginTop: 20 }}><SkeletonRows rows={4} /></div>;
  // Nothing sent to repair or scrap yet. This used to `return null`, which hid
  // the panel completely — clicking the Repair/Scrap tab gave a blank page with
  // no heading and no message, indistinguishable from the screen being broken.
  // An empty state says which it is, and explains how rows get here.
  if (rows.length === 0) {
    return (
      <div className="card2 p-6" style={{ marginTop: 20 }}>
        <div className="text-base font-bold font-heading">{t('repairScrap.title', 'Repair & scrap tracking')}</div>
        <div className="text-xs text-slate-500 mb-3">{t('repairScrap.subtitle', 'Assets sent for repair or scrapped at the end of a maintenance job — with photo proof and a link to the ticket.')}</div>
        <div className="text-center text-slate-400 py-10 text-sm">
          {t('repairScrap.emptyTitle', 'Nothing has been sent for repair or scrap yet.')}
          <br />
          {t('repairScrap.emptyBody', 'When a maintenance job is closed, any parts marked for repair or scrap appear here with their photo proof and a link back to the ticket.')}
        </div>
      </div>
    );
  }

  // Closing the ticket returns here (same tab, search and page).
  const openTicket = (id: string) => navigate(withBack(`/dashboard/purchase/maint?ticket=${id}`, hereNow()));

  return (
    <div className="card2 p-6" style={{ marginTop: 20, position: 'relative' }}>
      <div className="text-base font-bold font-heading">{t('repairScrap.title', 'Repair & scrap tracking')}</div>
      <div className="text-xs text-slate-500 mb-3">{t('repairScrap.subtitle', 'Assets sent for repair or scrapped at the end of a maintenance job — with photo proof and a link to the ticket.')}</div>
      <TableSearch value={search} onChange={setSearch} placeholder={t('repairScrap.searchPh', 'Search equipment, plant, ticket…')} />
      <RepairScrapTable variant="repair" title={t('repairScrap.repairItems', 'Repair items')} tone="amber" icon={<Wrench size={14} />} rows={repair} urlPrefix="rp" ready={!loading} resetKey={search}
        canReturn={canReturn} onReturn={setReturnItem}
        onOpenTicket={openTicket} onPhoto={setLightbox} />
      <div style={{ height: 20 }} />
      <RepairScrapTable variant="scrap" title={t('repairScrap.scrapItems', 'Scrap items')} tone="red" icon={<Trash2 size={14} />} rows={scrap} urlPrefix="sc" ready={!loading} resetKey={search}
        canReturn={false} onReturn={() => {}}
        onOpenTicket={openTicket} onPhoto={setLightbox} />
      {receipts.length > 0 && (
        <>
          <div style={{ height: 20 }} />
          <ReturnHistory receipts={receipts} allocs={allocs} canReverse={canReverse}
            onReversed={() => { load(); }} onOpenTicket={openTicket}
            toastError={m => toast.error(m)} toastOk={m => toast.success(m)} />
        </>
      )}
      <ImageLightbox images={lightbox || []} open={!!lightbox} onClose={() => setLightbox(null)} />
      <RepairReturnModal open={!!returnItem} focusPart={returnItem?.part ?? null} parts={partItems.map(i => i.part)} tickets={rows}
        onClose={() => setReturnItem(null)} onSaved={() => { load(); toast.success(t('repairReturn.saved', 'Repaired items added to inventory.')); }} />
    </div>
  );
}

function RepairScrapTable({ variant, title, tone, icon, rows, urlPrefix, ready, resetKey, canReturn, onReturn, onOpenTicket, onPhoto }: {
  variant: 'repair' | 'scrap';
  /** Keeps this table's page / sort in the URL apart from the other table's. */
  urlPrefix: string;
  ready: boolean;
  /** The panel's search: a new search goes back to page 1 (a reload does not). */
  resetKey: string;
  title: string;
  tone: 'amber' | 'red';
  icon: React.ReactNode;
  rows: PartItem[];
  canReturn: boolean;
  onReturn: (r: PartItem) => void;
  onOpenTicket: (id: string) => void;
  onPhoto: (imgs: LightboxImage[]) => void;
}) {
  const { t } = useTranslation();
  const isRepair = variant === 'repair';
  const url = useUrlTable({ key: 'closed', dir: 'desc' }, urlPrefix);
  const s = useSortable(rows, {
    part: i => i.part.part_name,
    equipment: i => i.ticket.equipment,
    plant: i => i.ticket.plants?.name,
    ticket: i => i.ticket.id,
    closed: i => (i.ticket.closed_at ? new Date(i.ticket.closed_at) : null),
    status: i => i.ticket.status,
    qty: i => (isRepair ? Number(i.part.repair_qty) : Number(i.part.scrap_qty)),
    ...(isRepair ? { pending: (i: PartItem) => partPending(i.part) } : {}),
  }, url.sort, url.onSort);
  // Rows arrive already filtered by the panel's search — a new search goes back
  // to page 1. Keyed on the search, not rows.length: a reload after a return
  // changed the length and threw the user off their page.
  const { pageRows, controls } = usePagination(s.sorted, { resetKey: `${resetKey}|${s.sort.key}|${s.sort.dir}`, ...url.paging, ready });
  const iconSq = tone === 'amber' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600';
  const cols = isRepair ? 10 : 7;
  return (
    <div className="border border-slate-200 rounded-[12px] overflow-hidden">
      {/* Section header — icon square + Poppins title + count pill */}
      <div className="flex items-center gap-2.5 px-4 py-3 bg-slate-50/60 border-b border-slate-100">
        <span className={`w-7 h-7 rounded-lg inline-flex items-center justify-center shrink-0 ${iconSq}`}>{icon}</span>
        <span className="font-heading font-semibold text-[14px] text-slate-800">{title}</span>
        <StatusPill tone={tone} label={rows.length} className="ml-1" />
      </div>
      {rows.length === 0 ? (
        <div className="p-4"><EmptyState title={t('repairScrap.emptySection', { defaultValue: 'No {{what}} yet', what: title.toLowerCase() })} /></div>
      ) : (
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead><tr>
              <Th sortKey="part" s={s}>{t('repairScrap.colPart', 'Part')}</Th>
              <Th sortKey="equipment" s={s}>{t('repairScrap.colEquipment', 'Equipment')}</Th>
              <Th sortKey="plant" s={s}>{t('repairScrap.colPlant', 'Plant')}</Th>
              <Th sortKey="ticket" s={s}>{t('repairScrap.colTicket', 'Ticket #')}</Th>
              <Th sortKey="closed" s={s} firstDir="desc">{t('repairScrap.colClosed', 'Closed')}</Th>
              {!isRepair && <Th sortKey="qty" s={s} firstDir="desc" className="num">{t('repairScrap.colScrapped', 'Scrapped')}</Th>}
              {isRepair && <Th sortKey="pending" s={s} firstDir="desc">{t('repairScrap.colReturn', 'Sent · Returned · Pending')}</Th>}
              {isRepair && <th>{t('repairScrap.colReturnStatus', 'Return')}</th>}
              <Th sortKey="status" s={s}>{t('repairScrap.colStatus', 'Status')}</Th>
              <th>{t('repairScrap.colPhoto', 'Photo')}</th>
              {isRepair && <th></th>}
            </tr></thead>
            <tbody>
              {pageRows.map(item => {
                const r = item.ticket;
                const p = item.part;
                const rs = partReturnState(p);
                const pending = partPending(p);
                return (
                  <tr key={p.id} onClick={() => onOpenTicket(r.id)} style={{ cursor: 'pointer' }} title={t('repairScrap.openTicket', 'Open maintenance ticket')}>
                    <td className="font-semibold">{p.part_name}</td>
                    <td className="text-slate-500">{r.equipment}</td>
                    <td className="text-slate-500">{displayLocationName(r.plants?.name) || '—'}</td>
                    <td><span className="num text-xs text-blue-600 font-semibold">#{ticketNoLabel(r)}</span></td>
                    <td className="text-slate-500">{fmtDate(r.closed_at)}</td>
                    {!isRepair && <td className="num font-bold" style={{ color: '#DC2626' }}>{Number(p.scrap_qty)}</td>}
                    {isRepair && (
                      <td className="num text-xs text-slate-600">
                        {Number(p.repair_qty)} · {Number(p.repair_returned_qty)} · <strong style={{ color: pending > 0 ? '#D97706' : '#16A34A' }}>{pending}</strong>
                      </td>
                    )}
                    {isRepair && (
                      <td>
                        <StatusPill
                          tone={rs === 'returned' ? 'green' : rs === 'partial' ? 'blue' : 'amber'}
                          label={t(`repairScrap.return_${rs}`, rs)} />
                      </td>
                    )}
                    {/* A repair ticket is not "Closed" while repaired parts are still out. */}
                    <td>{isRepair && r.status === 'closed' && pending > 0
                      ? <StatusPill tone="amber" label={t('repairScrap.closedReturnPending', 'Closed · return pending')} />
                      : <StatusPill tone={r.status === 'closed' ? 'green' : 'slate'} label={statusText(r.status, t)} />}</td>
                    <td>
                      {(p.photo_url || r.defective_part_photo_url) ? (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); onPhoto([{ url: (p.photo_url || r.defective_part_photo_url) as string, label: p.part_name }]); }}
                          title={t('repairScrap.viewPhoto', 'View photo')}
                          style={{ padding: 0, border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'none', lineHeight: 0 }}
                        >
                          <img src={(p.photo_url || r.defective_part_photo_url) as string} alt={`${p.part_name} photo`} style={{ width: 40, height: 40, objectFit: 'cover', display: 'block' }} loading="lazy" />
                        </button>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    {isRepair && (
                      <td>
                        {canReturn && pending > 0 && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); onReturn(item); }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#16A34A', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                            <PackageCheck size={12} /> {t('repairScrap.returnToInventory', 'Return to Inventory')}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {pageRows.length === 0 && <tr><td colSpan={cols} className="text-center text-slate-400 py-6 text-sm">{t('repairScrap.noMatch', 'No rows match.')}</td></tr>}
            </tbody>
          </table>
          <TablePagination controls={controls} />
        </div>
      )}
    </div>
  );
}

/** Append-only return history: every receipt with its per-ticket allocations.
 *  Corrections happen via controlled reversal (offsetting movement) — never
 *  deletion. */
function ReturnHistory({ receipts, allocs, canReverse, onReversed, onOpenTicket, toastError, toastOk }: {
  receipts: ReceiptRow[];
  allocs: AllocRow[];
  canReverse: boolean;
  onReversed: () => void;
  onOpenTicket: (id: string) => void;
  toastError: (m: string) => void;
  toastOk: (m: string) => void;
}) {
  const { t } = useTranslation();
  const urlSearch = useUrlFilters(['rhq'] as const);
  const search = urlSearch.values.rhq;
  const setSearch = (rhq: string) => urlSearch.set({ rhq });
  const url = useUrlTable({ key: 'date', dir: 'desc' }, 'rh');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reverseFor, setReverseFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const ticketNoForId = useTicketNos(allocs.map(a => a.ticket_id));
  const [busy, setBusy] = useState(false);

  const byReceipt = useMemo(() => {
    const m = new Map<string, AllocRow[]>();
    for (const a of allocs) { const arr = m.get(a.receipt_id); if (arr) arr.push(a); else m.set(a.receipt_id, [a]); }
    return m;
  }, [allocs]);

  const filtered = useTextFilter(receipts, search, r => [
    r.vendor_name, r.invoice_no, r.actor_name, r.plants?.name, r.id.slice(0, 8),
    ...(byReceipt.get(r.id) || []).map(a => a.item_name),
  ]);

  const s = useSortable(filtered, {
    date: r => (r.return_date ? new Date(r.return_date) : null),
    vendor: r => r.vendor_name,
    invoice: r => r.invoice_no,
    qty: r => (byReceipt.get(r.id) || []).reduce((sum, a) => sum + Number(a.qty), 0),
    by: r => r.actor_name,
    status: r => r.status,
  }, url.sort, url.onSort);
  const { pageRows, controls } = usePagination(s.sorted, { resetKey: `${search}|${s.sort.key}|${s.sort.dir}`, ...url.paging });

  async function doReverse(receiptId: string) {
    if (!reason.trim()) { toastError(t('repairReturn.errReason', 'A reason is required to reverse a return.')); return; }
    setBusy(true);
    try {
      const { error } = await callRpc('reverse_repair_return', { p_receipt_id: receiptId, p_reason: reason.trim() });
      if (error) {
        const raw = error.message || '';
        if (/reversal_blocked/i.test(raw)) throw new Error(t('repairReturn.errReversalBlocked', 'Cannot reverse — some returned units have already been issued from stock.'));
        if (/forbidden: missing capability/i.test(raw)) throw new Error(t('repairReturn.errReverseForbidden', 'You do not have permission to reverse repair returns.'));
        throw new Error(raw);
      }
      toastOk(t('repairReturn.reversed', 'Return reversed — stock and tickets restored.'));
      setReverseFor(null); setReason('');
      onReversed();
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-slate-200 rounded-[12px] overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 bg-slate-50/60 border-b border-slate-100 flex-wrap">
        <span className="w-7 h-7 rounded-lg inline-flex items-center justify-center shrink-0 bg-green-50 text-green-600"><PackageCheck size={14} /></span>
        <span className="font-heading font-semibold text-[14px] text-slate-800">{t('repairReturn.historyTitle', 'Repair return history')}</span>
        <StatusPill tone="green" label={receipts.length} className="ml-1" />
        <div style={{ marginLeft: 'auto', minWidth: 220 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('repairReturn.historySearchPh', 'Filter by item, vendor, invoice…')}
            style={{ boxSizing: 'border-box', width: '100%', border: '1px solid #E2E8F0', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none' }} />
        </div>
      </div>
      <div className="overflow-x-auto scroll-x">
        <table className="dt2">
          <thead><tr>
            <Th sortKey="date" s={s} firstDir="desc">{t('repairReturn.colDate', 'Return date')}</Th>
            <Th sortKey="vendor" s={s}>{t('repairReturn.colVendor', 'Vendor')}</Th>
            <Th sortKey="invoice" s={s}>{t('repairReturn.colInvoice', 'Invoice')}</Th>
            <Th sortKey="qty" s={s} firstDir="desc" className="num">{t('repairReturn.colQty', 'Qty')}</Th>
            <Th sortKey="by" s={s}>{t('repairReturn.colBy', 'By')}</Th>
            <Th sortKey="status" s={s}>{t('repairReturn.colStatus', 'Status')}</Th>
            <th>{t('repairReturn.colBill', 'Bill')}</th>
          </tr></thead>
          <tbody>
            {pageRows.map(r => {
              const rowAllocs = byReceipt.get(r.id) || [];
              const totalQty = rowAllocs.reduce((sum, a) => sum + Number(a.qty), 0);
              const isOpen = expanded === r.id;
              return (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setExpanded(isOpen ? null : r.id)} style={{ cursor: 'pointer', opacity: r.status === 'reversed' ? 0.6 : 1 }}>
                    <td className="text-slate-600">{fmtDate(r.return_date)}</td>
                    <td className="text-slate-600">{r.vendor_name || '—'}</td>
                    <td className="text-slate-600">{r.invoice_no || '—'}</td>
                    <td className="num font-bold">{totalQty}</td>
                    <td className="text-slate-500 text-xs">{r.actor_name || '—'}</td>
                    <td><StatusPill tone={r.status === 'active' ? 'green' : 'red'} label={r.status === 'active' ? t('repairReturn.stActive', 'active') : t('repairReturn.stReversed', 'reversed')} /></td>
                    <td onClick={e => e.stopPropagation()}>
                      {r.invoice_url
                        ? <a href={r.invoice_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 font-semibold">{t('repairReturn.viewBill', 'view')}</a>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} style={{ background: '#F8FAFC', padding: '10px 14px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#475569' }}>
                          {rowAllocs.map(a => (
                            <div key={a.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                              <strong>{a.item_name}</strong>
                              <span>+{Number(a.qty)} {t('repairReturn.toRepairedStock', 'to repaired stock')}</span>
                              <button onClick={() => onOpenTicket(a.ticket_id)} style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, padding: 0 }}>
                                #{ticketNoForId(a.ticket_id)}
                              </button>
                            </div>
                          ))}
                          <div style={{ color: '#64748B' }}>
                            “{r.comment}”{r.condition_note ? ` · ${r.condition_note}` : ''}{r.repair_cost != null ? ` · ${t('repairReturn.costShort', 'Repair cost')} ₹${Number(r.repair_cost).toLocaleString('en-IN')}` : ''}
                          </div>
                          {r.status === 'reversed' && (
                            <div style={{ color: '#DC2626', fontSize: 11.5 }}>
                              {t('repairReturn.reversedBy', { defaultValue: 'Reversed by {{name}}', name: r.reversed_by_name || '—' })} · {fmtDate(r.reversed_at)} · “{r.reversal_reason}”
                            </div>
                          )}
                          {canReverse && r.status === 'active' && (
                            reverseFor === r.id ? (
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                                <input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('repairReturn.reasonPh', 'reason for the reversal (required)')}
                                  style={{ boxSizing: 'border-box', flex: 1, minWidth: 200, border: '1px solid #E2E8F0', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none' }} />
                                <button disabled={busy} onClick={() => doReverse(r.id)}
                                  style={{ fontSize: 12, fontWeight: 700, color: '#fff', background: '#DC2626', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}>
                                  {busy ? t('repairReturn.reversing', 'Reversing…') : t('repairReturn.confirmReverse', 'Confirm reversal')}
                                </button>
                                <button disabled={busy} onClick={() => { setReverseFor(null); setReason(''); }}
                                  style={{ fontSize: 12, fontWeight: 600, color: '#475569', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                                  {t('repairReturn.cancel', 'Cancel')}
                                </button>
                              </div>
                            ) : (
                              <button onClick={() => { setReverseFor(r.id); setReason(''); }}
                                style={{ alignSelf: 'flex-start', fontSize: 11.5, fontWeight: 700, color: '#DC2626', background: 'none', border: '1px solid #FECACA', borderRadius: 8, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 }}>
                                {t('repairReturn.reverse', 'Reverse this return')}
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {pageRows.length === 0 && <tr><td colSpan={7} className="text-center text-slate-400 py-6 text-sm">{t('repairScrap.noMatch', 'No rows match.')}</td></tr>}
          </tbody>
        </table>
        <TablePagination controls={controls} />
      </div>
    </div>
  );
}
