import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
// Shared humanizer — a user should never be shown a raw error object.
import { humanizeError as errMsg } from '../../../lib/errors';
import { fetchActivePlants } from '../../../lib/plants';
import { displayLocationName } from '../../../lib/plantLabels';
import { insertRows } from '../../../lib/db';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows } from '../../../components/ui/states';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../../components/v2';
import { useSortable } from '../../../components/ui/useSortable';
import { ThV2 as Th } from '../../../components/v2';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { useRoleContext } from '../../../contexts/RoleContext';
import { isAdminProfile, profileHasCapability } from '../../../lib/profiles';
import { canDeleteModule, canEditModule, ensureLateApproval, recordAudit, useOpsSettings } from '../../../lib/opsControls';
import { billBufferDays } from '../../../lib/datePolicy';
import { uploadWorkflowFile } from '../../../lib/cloudinary';
import { parseStockFile, reconcile, reconcileAll, labelForPeriod, normalizeUnit, UNIT_OPTIONS, type StockParseResult, type MonthParse, type MonthItem, type Anomaly } from '../../../lib/store/parseStockFile';
import { indexResolutions, joinAnomalies, type AnomalyResolutionRow, type ReviewedAnomaly } from '../../../lib/store/anomalyKeys';
import { registerIdOf } from '../../../lib/store/registers';
import { assignSequentialJobNos, jobNoStock, persistMissingJobNos, ticketShort } from '../../../lib/jobNo';
import { fetchAllRows, fetchAllRowsProgressive } from '../../../lib/fetchAll';
import { createImportBatch, setImportBatchRowCount, buildItemOwnerMap, resolveItemOwner } from '../../../lib/imports/batches';
import { AddPurchaseModal } from './AddPurchaseModal';
import { AnomalyReviewModal } from './AnomalyReviewModal';
import { StoreReconciliation } from './StoreReconciliation';
import type { Database } from '../../../lib/database.types';

type StockItem = Database['public']['Tables']['store_items']['Row'];
type StockMonthRow = Database['public']['Tables']['store_stock_months']['Row'];
type Plant = { id: string; name: string };

interface StoreBreakdown { id: string; plantId: string | null; plant: string; opening: number; onHand: number; issued: number; procured: number; repaired: number; raw: StockItem; }
interface MergedRow {
  key: string; itemName: string; equipment: string; model: string | null; unit: string;
  opening: number; onHand: number; issued: number; procured: number; repaired: number; stores: StoreBreakdown[];
  jobNo: string; ticketNos: string[]; entryAt: string;
}

interface BillHit { itemKey: string; url: string; at: string; by: string | null; }

function stockItemKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA');
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const CHUNK = 500;

function stockStatus(onHand: number): { key: 'out' | 'low' | 'in'; label: string; bg: string; color: string } {
  if (onHand <= 0) return { key: 'out', label: 'Out', bg: '#FEE2E2', color: '#DC2626' };
  if (onHand <= 2) return { key: 'low', label: 'Low', bg: '#FEF3C7', color: '#D97706' };
  return { key: 'in', label: 'In stock', bg: '#DCFCE7', color: '#16A34A' };
}

// i18n keys for the stockStatus labels — translated at render (module-level fn can't use the hook).
const STATUS_LABEL_KEYS: Record<'out' | 'low' | 'in', string> = {
  out: 'storereq.legend_out', low: 'storereq.legend_low', in: 'storereq.legend_in_stock',
};

// label = English default; labelKey resolved via t() at render.
const ANOM_META: Record<Anomaly['type'], { label: string; labelKey: string; icon: string }> = {
  carry_forward:  { label: 'Carry-forward drift', labelKey: 'storereq.stockAnomCarryForward', icon: '⚠' },
  purchase_carry: { label: 'Purchase carry-forward', labelKey: 'storereq.stockAnomPurchaseCarry', icon: '⚠' },
  intra_month:   { label: 'Sheet mismatch',      labelKey: 'storereq.stockAnomSheetMismatch', icon: '⚠' },
  sheet_self:    { label: 'Sheet contradicts itself', labelKey: 'storereq.stockAnomSheetSelf', icon: '✎' },
  negative:      { label: 'Negative stock',      labelKey: 'storereq.stockAnomNegative',      icon: '🔴' },
  added:         { label: 'New item',            labelKey: 'storereq.stockAnomNewItem',       icon: '＋' },
  removed:       { label: 'Removed item',        labelKey: 'storereq.stockAnomRemovedItem',   icon: '－' },
};

// Persisted review statuses — translated at render.
const RES_STATUS_KEYS: Record<string, [string, string]> = {
  open: ['storereq.stockStOpen', 'open'],
  resolved: ['storereq.stockStResolved', 'resolved'],
  false_positive: ['storereq.stockStFalsePositive', 'false positive'],
  confirmed: ['storereq.stockStConfirmed', 'confirmed'],
};

/** Rebuild MonthParse[] from persisted snapshot rows (keyed by item name). */
function monthsFromRows(rows: StockMonthRow[]): MonthParse[] {
  const byPeriod = new Map<string, MonthItem[]>();
  for (const r of rows) {
    const list = byPeriod.get(r.period_month) ?? [];
    list.push({
      itemName: r.item_name, key: r.item_name.toLowerCase().replace(/\s+/g, ' ').trim(),
      unit: r.unit || '', equipment: '', model: null,
      opening: Number(r.opening), purchaseOpening: Number(r.purchase_opening),
      // Falls back to the Purchase sheet's own arithmetic for snapshots taken
      // before migration 67 added the column.
      purchaseClosing: Number(
        (r as { purchase_closing?: number | null }).purchase_closing
        ?? (Number(r.purchase_opening) + Number(r.purchased)),
      ),
      purchased: Number(r.purchased), used: Number(r.used), closing: Number(r.computed_closing),
    });
    byPeriod.set(r.period_month, list);
  }
  // `label` feeds the anomaly text ("Jun 2026 Purchase Register closed at …"),
  // so it must be a readable month, not the raw '2026-06-01' the snapshot is
  // keyed by — and it must always carry the year so a Dec→Jan pair reads
  // unambiguously.
  return [...byPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([pk, items]) => ({ periodKey: pk.slice(0, 7), periodMonth: pk, label: labelForPeriod(pk), items, hasSales: true, hasPurchase: true }));
}

type RegisterItem = StockItem & { plants?: { name: string | null } | null };

/** Rows synthesized from the latest monthly snapshot per register. */
function snapshotFallbackItems(months: StockMonthRow[]): RegisterItem[] {
  if (!months.length) return [];
  const latestPeriod = new Map<string, string>();
  for (const row of months) {
    const regId = registerIdOf(row);
    if (!regId) continue;
    const cur = latestPeriod.get(regId);
    if (!cur || row.period_month > cur) latestPeriod.set(regId, row.period_month);
  }
  const now = new Date().toISOString();
  const out: RegisterItem[] = [];
  for (const row of months) {
    const regId = registerIdOf(row);
    if (!regId || row.period_month !== latestPeriod.get(regId)) continue;
    out.push({
      id: `snapshot:${row.id}`,
      plant_id: row.plant_id,
      store_id: row.store_id,
      job_no: null,
      value_category: null,
      reserved_qty: 0,
      item_name: row.item_name,
      unit: row.unit,
      equipment: null,
      model: null,
      baseline_qty: Math.max(0, Number(row.computed_closing)),
      baseline_month: row.period_month,
      procured_qty: Number(row.purchased),
      issued_qty: Number(row.used),
      manual_delta: 0,
      ticket_procured_qty: 0,
      repaired_qty: 0,
      on_hand: Math.max(0, Number(row.computed_closing)),
      created_by_batch_id: null,
      created_at: now,
      updated_at: now,
    });
  }
  return out.sort((a, b) => a.item_name.localeCompare(b.item_name));
}

function isSnapshotItem(id: string): boolean {
  return id.startsWith('snapshot:');
}

function normSearch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

const inputStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
};

export function StockRegister() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { storeQuery, allowedPlants, stores, allowedStores, storeIdFor } = usePlantScope();
  const { activeProfile, activePersonId } = useRoleContext();

  const [items, setItems] = useState<RegisterItem[]>([]);
  const [months, setMonths] = useState<StockMonthRow[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [ticketList, setTicketList] = useState<{ item: string; ids: string[] } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAnoms, setShowAnoms] = useState(false);
  const [showSettled, setShowSettled] = useState(false);   // resolved / false-positive rows
  const [resolutions, setResolutions] = useState<AnomalyResolutionRow[]>([]);
  const [reviewItem, setReviewItem] = useState<ReviewedAnomaly | null>(null);
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' ? !window.matchMedia('(max-width: 767px)').matches : true,
  );        // desktop: collapsed until asked; phone: open so cards are usable
  const [plantFilter, setPlantFilter] = useState<string[]>([]); // empty = all plants (merged)
  const [showPurchase, setShowPurchase] = useState(false);
  const [purchaseLinkSeen, setPurchaseLinkSeen] = useState(false);
  const purchaseLinked = searchParams.get('addPurchase') === '1';
  if (purchaseLinked && !purchaseLinkSeen) {
    setPurchaseLinkSeen(true);
    setShowPurchase(true);
  }

  // Cmd+K / Quick search lands here with ?q=STK-001 (or item name).
  useEffect(() => {
    const q = (searchParams.get('q') || '').trim();
    if (!q) return;
    setSearch(q);
    setCollapsed(false);
  }, [searchParams]);

  const receiptId = searchParams.get('receipt');
  const [openedReceipt, setOpenedReceipt] = useState<{
    id: string;
    vendor_name: string | null;
    invoice_no: string | null;
    purchase_date: string | null;
    amount: number | null;
    bill_url: string | null;
    actor_name: string | null;
    notes: string | null;
    lines: { item_name: string | null; qty: number | null; unit: string | null }[];
  } | null>(null);
  useEffect(() => {
    if (!receiptId) { setOpenedReceipt(null); return; }
    let cancel = false;
    void (async () => {
      const { data } = await supabase.from('stock_purchase_receipts')
        .select('id, vendor_name, invoice_no, purchase_date, amount, bill_url, actor_name, notes')
        .eq('id', receiptId)
        .limit(1)
        .returns<{ id: string; vendor_name: string | null; invoice_no: string | null; purchase_date: string | null; amount: number | null; bill_url: string | null; actor_name: string | null; notes: string | null }[]>();
      const row = data?.[0];
      if (!row || cancel) { if (!cancel) setOpenedReceipt(null); return; }
      const { data: lines } = await supabase.from('stock_purchase_lines')
        .select('item_name, qty, unit')
        .eq('receipt_id', receiptId)
        .returns<{ item_name: string | null; qty: number | null; unit: string | null }[]>();
      if (cancel) return;
      setOpenedReceipt({ ...row, lines: lines || [] });
      setCollapsed(false);
    })();
    return () => { cancel = true; };
  }, [receiptId]);

  // Import flow
  const [stage, setStage] = useState<'idle' | 'uploading' | 'parsing' | 'review' | 'importing' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<StockParseResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [importStore, setImportStore] = useState('');   // a workbook belongs to a STORE
  const [importAnoms, setImportAnoms] = useState<Anomaly[]>([]);
  const [importedCount, setImportedCount] = useState(0);
  // Items whose computed closing was negative in the source workbook. The
  // register cannot hold negative stock, so they land at 0 — but the person who
  // uploaded needs to know WHICH, or the sheet never gets corrected.
  const [clampedItems, setClampedItems] = useState<{ name: string; closing: number }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Manual edit modal
  const [editItem, setEditItem] = useState<StockItem | null>(null);
  const [editForm, setEditForm] = useState({ name: '', equipment: '', model: '', onHand: '', unit: '', reason: '' });
  const [deleteItem, setDeleteItem] = useState<StockItem | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  /** store_item_id → emergency ticket ids that issued this part */
  const [issueTickets, setIssueTickets] = useState<Record<string, string[]>>({});

  const canUploadExcel =
    isAdminProfile(activeProfile);
  const ops = useOpsSettings();
  const allowStockEdit = canEditModule(ops, activeProfile, 'stock');
  const allowStockDelete = canDeleteModule(ops, activeProfile, 'stock', activePersonId);
  const allowImportEdit = profileHasCapability(activeProfile, 'edit_import_batch');
  // Import edit covers rows the workbook created. It does not open hand-entered
  // rows, and it never grants the row-delete or ticket-delete switches.
  const canEditStockRow = (it: StockItem) => allowStockEdit || (allowImportEdit && !!it.created_by_batch_id);
  const [billHits, setBillHits] = useState<BillHit[]>([]);
  const [billTarget, setBillTarget] = useState<MergedRow | null>(null);
  const billFileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const { data: pl } = await fetchActivePlants<Plant>('id, name');
      setPlants(pl || []);
      // STORE-scoped, not plant-scoped. Migration 60 stamps every Rehla row
      // with one anchor factory (SCPL – Rehla), so a plant filter showed the
      // shared register as empty to a keeper granted the store and the other
      // two factories — the exact case this screen exists for.
      // PAGED: PostgREST caps at 1000 rows silently — a large register would
      // otherwise show a random slice and miss items like "Cup brush".
      const pageItems = (select: string) => (from: number, to: number) =>
        storeQuery(supabase.from('store_items').select(select))
          .order('item_name', { ascending: true }).order('id', { ascending: true })
          .range(from, to)
          .returns<RegisterItem[]>()
          .then(({ data, error }) => ({ data, error }));
      let siRes = await fetchAllRowsProgressive<RegisterItem>(pageItems('*, plants(name)'), rows => {
        setItems(rows);
        setLoading(false);
      });
      if (siRes.error) {
        console.error('[StockRegister.items] embed failed; retrying without plants(name):', siRes.error);
        siRes = await fetchAllRowsProgressive<RegisterItem>(pageItems('*'), rows => {
          setItems(rows);
          setLoading(false);
        });
      }
      if (siRes.error) throw siRes.error;
      const loaded = siRes.data || [];
      setItems(loaded);
      setLoading(false);
      persistMissingJobNos('store_items', loaded, 'STK').then(map => {
        setItems(prev => prev.map(it => ({ ...it, job_no: map.get(it.id) ?? it.job_no })));
      }).catch(() => { /* column may not exist until 0019 is applied */ });
      // PAGED: ~1,791 snapshot rows already, and PostgREST caps a response at
      // 1000 silently. A truncated read here does not error — it just makes the
      // reconciler compare months it only partially loaded, which is the worst
      // possible failure for anomaly detection.
      const { data: sm } = await fetchAllRows<StockMonthRow>((from, to) =>
        storeQuery(supabase.from('store_stock_months').select('*'))
          .order('period_month', { ascending: true }).order('id', { ascending: true })
          .range(from, to).returns<StockMonthRow[]>());
      setMonths(sm || []);
      // Persisted anomaly review state (best-effort — table arrives with migration 54).
      try {
        const { data: ar, error: arErr } = await storeQuery(
          supabase.from('store_stock_anomalies')
            .select('id, plant_id, store_id, period_month, item_name, anomaly_type, status, action, corrected_value, resolution_comment, resolved_by_name, resolved_at, version'),
        ).returns<AnomalyResolutionRow[]>();
        setResolutions(arErr ? [] : (ar || []));
      } catch { setResolutions([]); }
      try {
        const { data: sr } = await fetchAllRows<{ store_item_id: string | null; ticket_id: string | null }>((from, to) =>
          supabase.from('maintenance_store_requests').select('store_item_id, ticket_id')
            .not('store_item_id', 'is', null)
            .not('ticket_id', 'is', null)
            .range(from, to)
            .returns<{ store_item_id: string | null; ticket_id: string | null }[]>());
        const map: Record<string, string[]> = {};
        for (const r of sr || []) {
          if (!r.store_item_id || !r.ticket_id) continue;
          const arr = map[r.store_item_id] || (map[r.store_item_id] = []);
          if (!arr.includes(r.ticket_id)) arr.push(r.ticket_id);
        }
        setIssueTickets(map);
      } catch { setIssueTickets({}); }
      void loadBills();
    } catch (e) {
      console.error('[StockRegister] load failed', e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [storeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadBills() {
    try {
      const db = supabase as unknown as { from: (t: string) => any };
      const [receiptsRes, linesRes, extraRes] = await Promise.all([
        supabase.from('stock_purchase_receipts').select('id, bill_url, created_at, actor_name').not('bill_url', 'is', null).order('created_at', { ascending: false }).limit(800).returns<{ id: string; bill_url: string | null; created_at: string; actor_name: string | null }[]>(),
        supabase.from('stock_purchase_lines').select('item_name, receipt_id').limit(3000).returns<{ item_name: string | null; receipt_id: string }[]>(),
        db.from('stock_bill_uploads').select('item_key, bill_url, uploaded_at, uploaded_by').order('uploaded_at', { ascending: false }).limit(500),
      ]);
      const receiptRows = (receiptsRes.data || []) as { id: string; bill_url: string | null; created_at: string; actor_name: string | null }[];
      const lineRows = (linesRes.data || []) as { item_name: string | null; receipt_id: string }[];
      const receipts = new Map(receiptRows.map(r => [r.id, r]));
      const hits: BillHit[] = [];
      for (const line of lineRows) {
        const rec = receipts.get(line.receipt_id);
        if (!rec?.bill_url || !line.item_name) continue;
        hits.push({ itemKey: stockItemKey(line.item_name), url: rec.bill_url, at: rec.created_at, by: rec.actor_name });
      }
      for (const row of extraRes.data || []) {
        if (!row.bill_url) continue;
        hits.push({ itemKey: row.item_key, url: row.bill_url, at: row.uploaded_at, by: row.uploaded_by });
      }
      hits.sort((a, b) => b.at.localeCompare(a.at));
      setBillHits(hits);
    } catch {
      setBillHits([]);
    }
  }

  async function uploadItemBill(file: File) {
    const row = billTarget;
    if (!row) return;
    const entryDate = (row.entryAt || '').slice(0, 10);
    const allowed = await ensureLateApproval({
      module: 'stock bill',
      entryDate,
      profile: activeProfile,
      bufferDays: billBufferDays(row.stores.map((s) => s.plantId), ops.bufferDaysByPlant, ops.bufferDays),
    });
    if (!allowed) {
      toast.error('Bill not uploaded. Management has to approve this late upload first.');
      return;
    }
    try {
      const up = await uploadWorkflowFile(file, { workflow: 'store-req', subfolder: 'stock-bills', kind: 'item-bill', creator: activeProfile.name });
      const db = supabase as unknown as { from: (t: string) => any };
      const { error } = await db.from('stock_bill_uploads').insert({
        item_key: row.key,
        item_name: row.itemName,
        entry_date: entryDate || null,
        bill_url: up.secure_url,
        uploaded_by: activeProfile.name,
        late: false,
      });
      if (error) throw error;
      await recordAudit({
        module: 'stock',
        action: 'bill_uploaded',
        summary: `Uploaded a bill for ${row.itemName}`,
        actorName: activeProfile.name,
        actorRole: activeProfile.roleLabel,
        photoUrl: up.secure_url,
      });
      toast.success('Bill saved on the stock row.');
      await loadBills();
    } catch (e) {
      toast.error(errMsg(e, { action: 'upload this bill', context: 'StockRegister.bill' }));
    }
  }

  // When the living register is empty but monthly snapshots exist, show the
  // latest month's closing balances so search still works (e.g. Cup brush).
  const { registerItems, fromSnapshot } = useMemo(() => {
    if (items.length) return { registerItems: items, fromSnapshot: false };
    const snap = snapshotFallbackItems(months);
    return { registerItems: snap, fromSnapshot: snap.length > 0 };
  }, [items, months]);

  // (No plantOptions here: this screen is keyed on STORES, not factories — see
  // storeChips below. A factory list was left over from before the store split.)
  const plantName = (id: string | null) => displayLocationName(plants.find(p => p.id === id)?.name) || '—';

  // Live anomalies from persisted snapshots (latest two months). Respects the active
  // store filter so the count always matches the visible table (fixes the count being
  // stuck at the all-plants total when a single store is selected). Each plant is
  // reconciled independently — same-named items in different plants are distinct — then
  // the per-plant anomalies are combined.
  const anomalies = useMemo(() => {
    // Same register key as the chips and the table — a monthly snapshot belongs
    // to a STORE once migration 59 exists. Filtering these by plant_id while the
    // chips carry store ids would silently reconcile nothing.
    const monthRegisterId = (m: StockMonthRow) => registerIdOf(m);
    const scoped = plantFilter.length
      ? months.filter(m => { const id = monthRegisterId(m); return id && plantFilter.includes(id); })
      : months;
    if (!scoped.length) return [];
    const byPlant = new Map<string, StockMonthRow[]>();
    for (const r of scoped) {
      const k = monthRegisterId(r) || '—';
      const arr = byPlant.get(k);
      if (arr) arr.push(r); else byPlant.set(k, [r]);
    }
    const out: { anomaly: Anomaly; plant?: string; plantId: string | null; periodMonth: string; periodKey: string }[] = [];
    for (const [pid, rows] of byPlant.entries()) {
      const ms = monthsFromRows(rows);
      if (!ms.length) continue;
      // `pid` may now be a store id, so resolve the label from either master.
      const plant = pid === '—' ? undefined : displayLocationName(stores.find(s => s.id === pid)?.name ?? plantName(pid));
      // EVERY consecutive pair, not just the newest. Reconciling only the last
      // two months meant an unresolved discrepancy silently disappeared the
      // moment a newer month was uploaded — a real mismatch inside June stopped
      // being reported as soon as July landed, without anyone having looked at
      // it. Each anomaly is filed under the later month of its pair.
      for (const d of reconcileAll(ms)) {
        out.push({
          anomaly: d.anomaly, plant, plantId: pid === '—' ? null : pid,
          periodMonth: d.periodMonth, periodKey: d.periodKey,
        });
      }
    }
    return out;
  }, [months, plantFilter, plants, stores]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Months that actually produced anomalies, newest first — the month picker. */
  const anomalyMonths = useMemo(
    () => [...new Set(anomalies.map(a => a.periodKey))].sort().reverse(),
    [anomalies],
  );
  /** '' = every month. Defaults to the newest, so the day-to-day view stays as
   *  quiet as it was while older months remain one click away rather than
   *  silently dropped. */
  const [anomMonth, setAnomMonth] = useState<string>('');
  const effectiveAnomMonth = anomMonth || anomalyMonths[0] || '';

  // Join computed anomalies to their persisted review state (natural-key match).
  const reviewed = useMemo(() => {
    const idx = indexResolutions(resolutions);
    const inMonth = anomMonth === '*'
      ? anomalies
      : anomalies.filter(a => a.periodKey === effectiveAnomMonth);
    const joined = joinAnomalies(
      inMonth.filter(a => a.plantId).map(a => ({ anomaly: a.anomaly, plantId: a.plantId as string, periodMonth: a.periodMonth })),
      idx,
    );
    // Anomalies without a register can't be persisted — always open, review disabled.
    const noPlant: ReviewedAnomaly[] = inMonth.filter(a => !a.plantId)
      .map(a => ({ anomaly: a.anomaly, plantId: '', periodMonth: a.periodMonth, resolution: null, isOpen: true }));
    return [...joined, ...noPlant];
  }, [anomalies, resolutions, anomMonth, effectiveAnomMonth]);

  const openAnoms    = reviewed.filter(r => r.isOpen);
  const settledAnoms = reviewed.filter(r => !r.isOpen);

  /** Open anomalies in EVERY month, so the banner never understates the backlog
   *  just because the view is scoped to one month. */
  const openAllMonths = useMemo(() => {
    const idx = indexResolutions(resolutions);
    return joinAnomalies(
      anomalies.filter(a => a.plantId).map(a => ({ anomaly: a.anomaly, plantId: a.plantId as string, periodMonth: a.periodMonth })),
      idx,
    ).filter(r => r.isOpen).length
      + anomalies.filter(a => !a.plantId).length;
  }, [anomalies, resolutions]);
  const canReview = profileHasCapability(activeProfile, 'resolve_stock_anomaly');

  const latestUpload = useMemo(() => {
    if (!months.length) return null;
    return months.reduce((mx, m) => (m.period_month > mx ? m.period_month : mx), months[0].period_month);
  }, [months]);

  /**
   * The register a stock row belongs to. MUST be the same expression the filter
   * below uses — the chips are keyed by whatever this returns, so if the two
   * disagree every chip selects nothing.
   *
   * store_id once migration 59 exists (the three Rehla factories then share one
   * register and appear as a single chip); plant_id before it.
   */
  // Shared helper (lib/store/registers) — the chips, the table and the anomaly
  // reconciler must all key a row the same way, or a chip selects nothing.

  // Registers that actually have stock rows. Used ONLY to mark which registers
  // are still empty — never as the source of the selector, see storeChips.
  const plantsInData = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of registerItems) {
      const id = registerIdOf(it);
      if (!id) continue;
      const label = displayLocationName(it.store_id
        ? (stores.find(s => s.id === it.store_id)?.name || '')
        : (it.plants?.name || plantName(it.plant_id))) || t('storereq.store', 'Store');
      seen.set(id, label);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [registerItems, plants, stores]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The store selector.
   *
   * Sourced from the stores the user may ACT ON, not from the stores that happen
   * to hold items. Keying it on the data is what produced the reported bug: with
   * one store's workbook uploaded the chips disappeared, so the register never
   * said which store it was showing, and an empty register said nothing at all.
   *
   * Falls back to the registers present in the data on a database where
   * migration 59 has not been applied and `stores` is therefore empty — the same
   * degrade-gracefully posture as registerIdOf().
   */
  const storeChips = useMemo(() => {
    const withData = new Set(plantsInData.map(p => p.id));
    if (allowedStores.length) {
      return allowedStores
        .map(s => ({ id: s.id, name: displayLocationName(s.name), hasData: withData.has(s.id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return plantsInData.map(p => ({ ...p, hasData: true }));
  }, [allowedStores, plantsInData]);

  /** What the header says this register is. Never blank. */
  const activeStoreLabel = useMemo(() => {
    if (plantFilter.length === 1) {
      return storeChips.find(s => s.id === plantFilter[0])?.name ?? null;
    }
    if (plantFilter.length > 1) {
      return t('storereq.stockPlantsOf', {
        defaultValue: '{{sel}} of {{total}} stores', sel: plantFilter.length, total: storeChips.length,
      });
    }
    if (storeChips.length === 1) return storeChips[0].name;
    if (storeChips.length > 1) {
      return t('storereq.stockPlantsCount', { defaultValue: '{{n}} stores', n: storeChips.length });
    }
    return null;
  }, [plantFilter, storeChips, t]);

  function togglePlant(id: string) { setPlantFilter(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); }

  // Group identical items across the selected registers.
  //
  // This merge used to exist to HIDE a bug: the Rehla store had been imported
  // twice (once as 'Rehla', once as 'SPPL'), so the same 434 items appeared as
  // two sets of rows and summing them made the totals look right whenever both
  // plants were selected — and wrong whenever only one was. Migration 60
  // collapses those copies into one Rehla Common Store, so after it runs each
  // item is a single row and this loop simply passes it through.
  //
  // It is kept because it is still correct and still needed for the genuine
  // case: a user with access to several SEPARATE stores (say Ganjam and
  // Sikandarabad) viewing them together. `stores` on each row records which
  // register each contribution came from, so the breakdown stays visible.
  const stockJobMap = useMemo(() => assignSequentialJobNos(registerItems, 'STK'), [registerItems]);
  const merged = useMemo<MergedRow[]>(() => {
    const q = normSearch(search);
    const map = new Map<string, MergedRow>();
    for (const it of registerItems) {
      const regId = registerIdOf(it);
      if (plantFilter.length && !(regId && plantFilter.includes(regId))) continue;
      const tickets = issueTickets[it.id] || [];
      const job = stockJobMap.get(it.id) || jobNoStock(it.id, it.job_no);
      const hay = normSearch([it.item_name, it.equipment || '', it.model || '', job, ...tickets.map(ticketShort)].join(' '));
      if (q && !hay.includes(q)) continue;
      const key = stockItemKey(it.item_name);
      const store = { id: it.id, plantId: it.plant_id, plant: displayLocationName((it.store_id ? stores.find(s => s.id === it.store_id)?.name : null) || it.plants?.name || plantName(it.plant_id)), opening: Number(it.baseline_qty), onHand: Number(it.on_hand), issued: Number(it.issued_qty), procured: Number(it.ticket_procured_qty || 0), repaired: Number(it.repaired_qty || 0), raw: it };
      const ex = map.get(key);
      if (ex) {
        ex.opening += store.opening; ex.onHand += store.onHand; ex.issued += store.issued; ex.procured += store.procured; ex.repaired += store.repaired; ex.stores.push(store);
        const stamp = it.created_at || it.updated_at || '';
        if (stamp > ex.entryAt) ex.entryAt = stamp;
        for (const tid of tickets) if (!ex.ticketNos.includes(tid)) ex.ticketNos.push(tid);
      }
      else map.set(key, { key, itemName: it.item_name, equipment: it.equipment || '', model: it.model, unit: it.unit || '', opening: store.opening, onHand: store.onHand, issued: store.issued, procured: store.procured, repaired: store.repaired, stores: [store], jobNo: job, ticketNos: [...tickets], entryAt: it.created_at || it.updated_at || '' });
    }
    return [...map.values()].sort((a, b) => (b.entryAt || '').localeCompare(a.entryAt || '') || a.itemName.localeCompare(b.itemName));
  }, [registerItems, plantFilter, search, plants, stores, issueTickets, stockJobMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const billsByKey = useMemo(() => {
    const map = new Map<string, BillHit[]>();
    for (const hit of billHits) {
      const list = map.get(hit.itemKey) || [];
      list.push(hit);
      map.set(hit.itemKey, list);
    }
    return map;
  }, [billHits]);

  const summary = useMemo(() => {
    let inStock = 0, low = 0, out = 0;
    for (const m of merged) { const s = stockStatus(m.onHand); if (s.key === 'out') out++; else if (s.key === 'low') low++; else inStock++; }
    return { total: merged.length, inStock, low, out };
  }, [merged]);

  // Column sort — click a header to sort by it (toggles asc/desc).
  const mergedSort = useSortable(merged, {
    date: r => (billsByKey.get(r.key) || [])[0]?.at || r.entryAt || '',
    item: r => r.itemName,
    opening: r => r.opening,
    onHand: r => r.onHand,
    issued: r => r.issued,
    procured: r => r.procured,
    status: r => (r.onHand <= 0 ? 0 : r.onHand <= 2 ? 1 : 2),
  }, { key: 'date', dir: 'desc' });

  // Paginate the register — it can hold hundreds of items per plant.
  const { pageRows, controls } = usePagination(mergedSort.sorted, { resetKey: `${search}|${plantFilter.join(',')}|${mergedSort.sort.key}|${mergedSort.sort.dir}` });

  // ── Import ──────────────────────────────────────────────────────────────────
  // Stores this user may upload against. At Rehla that is the one shared
  // register, which is what the client's single Jharkhand workbook maps to.
  const storeOptions = allowedStores.length ? allowedStores : stores;
  function defaultStore(): string { return storeOptions[0]?.id || ''; }

  async function handleFile(file: File) {
    setErr(null); setFileName(file.name); setStage('uploading'); setCloudUrl(null); setParseResult(null);
    try {
      try {
        const up = await uploadWorkflowFile(file, { workflow: 'store-req', subfolder: 'stock', kind: 'stock', creator: activeProfile.name });
        setCloudUrl(up.secure_url);
      } catch { /* cloud archive is best-effort */ }
      setStage('parsing');
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error(t('storereq.stockErrFileType', 'Please upload an .xlsx / .xls spreadsheet.'));
      const res = await parseStockFile(file);
      if (!res.latest || !res.months.length) throw new Error(t('storereq.stockErrNoSheets', 'No "Sales <Month>" / "Purchase <Month>" sheets found in this file.'));
      setParseResult(res);
      const n = res.months.length;
      setImportAnoms(reconcile(n >= 2 ? res.months[n - 2] : null, res.months[n - 1]));
      setImportStore(defaultStore());
      setStage('review');
    } catch (e) {
      setErr(errMsg(e, { action: 'read this stock file', context: 'StockRegister.handleFile' })); setStage('error');
    }
  }

  async function confirmImport() {
    if (!parseResult?.latest) return;
    setStage('importing');
    try {
      const res = parseResult;
      const latest = res.latest!;
      const storeId = importStore || null;
      if (!storeId) throw new Error('Choose the store this file belongs to.');
      // plant_id is kept as a legacy anchor only — store_id is authoritative.
      const anchorPlantId = plants.find(p => storeIdFor(p.id) === storeId)?.id ?? null;
      const monthDates = res.months.map(m => m.periodMonth);

      // 0) Register the upload batch first, so the manifest and every register
      //    row this file creates can be stamped with it. Without that stamp a
      //    wrong workbook is unremovable — which is the problem this whole
      //    batch mechanism exists to fix.
      const batchId = await createImportBatch({
        module: 'stock',
        plantId: anchorPlantId,
        storeId,
        fileName,
        fileUrl: cloudUrl,
        periodMonth: latest.periodMonth,
        rowCount: res.totalItems,
        sheetCount: res.sheetCount,
        uploadedByName: activeProfile.name,
      });

      // 1) Upload manifest (latest month; re-upload replaces).
      //    Keyed on (store_id, period_month) — migration 60 replaced the old
      //    (plant_id, period_month) constraint, and upserting against a
      //    constraint that no longer exists is what produced "there is no unique
      //    or exclusion constraint matching the ON CONFLICT specification".
      const { data: up, error: upErr } = await (supabase.from('store_stock_uploads') as any).upsert({
        store_id: storeId, plant_id: anchorPlantId, period_month: latest.periodMonth,
        file_name: fileName, file_url: cloudUrl,
        uploaded_by_name: activeProfile.name, row_count: res.totalItems, sheet_count: res.sheetCount,
        // Re-uploading the same store+month REPLACES the manifest, so this
        // repoints it at the new batch. The previous batch is left as an empty
        // 'active' row in Upload History, which is honest: its data no longer
        // exists, and deleting it is a one-click no-op.
        import_batch_id: batchId,
      }, { onConflict: 'store_id,period_month' }).select('id').single();
      if (upErr) throw upErr;
      const uploadId = up?.id ?? null;

      // 2) Replace this STORE's month snapshots (the file is the source of truth).
      await supabase.from('store_stock_months').delete().eq('store_id', storeId).in('period_month', monthDates);
      const monthRows = res.months.flatMap(m => m.items.map(it => ({
        upload_id: uploadId, plant_id: anchorPlantId, store_id: storeId, period_month: m.periodMonth, item_name: it.itemName, unit: it.unit,
        opening: it.opening, purchase_opening: it.purchaseOpening, purchase_closing: it.purchaseClosing,
        purchased: it.purchased, used: it.used, computed_closing: it.closing,
      })));
      for (let i = 0; i < monthRows.length; i += CHUNK) {
        const { error } = await insertRows('store_stock_months', monthRows.slice(i, i + CHUNK));
        if (error) throw error;
      }

      // 3) Seed the living register from the latest month's computed closing.
      const nowIso = new Date().toISOString();
      // A negative closing means the sheet recorded more issued than was ever
      // available — a real bookkeeping error, and exactly what the parser's
      // `negative` anomaly type is for. The living register has a hard
      // on_hand >= 0 constraint, so those rows are clamped to zero rather than
      // failing the whole import: one impossible row must not block the other
      // 515 legitimate ones. The month snapshot below keeps the TRUE negative
      // value, so the audit trail stays honest and the anomaly still surfaces.
      const negatives = latest.items.filter(it => it.closing < 0);
      setClampedItems(negatives.map(it => ({ name: it.itemName, closing: it.closing })));

      // Which items this register ALREADY holds, and which batch created each.
      //
      // The upsert below writes every column it is given, so sending
      // created_by_batch_id blindly would re-stamp rows that a PREVIOUS upload
      // created — and then deleting this batch would delete their rows instead
      // of only rolling their baseline back. Read the current owner first and
      // preserve it per row; only genuinely new items get this batch's id.
      const { data: existing } = await supabase
        .from('store_items').select('item_name, created_by_batch_id').eq('store_id', storeId)
        .returns<{ item_name: string; created_by_batch_id: string | null }[]>();
      const ownerByName = buildItemOwnerMap(existing ?? []);

      const itemRows = latest.items.map(it => ({
        // store_id decides which register the row lands in. A DB trigger
        // (migration 62) fills it from plant_id if omitted, but sending it
        // explicitly is what lets the upsert below match on it.
        plant_id: anchorPlantId, store_id: storeId, item_name: it.itemName, unit: it.unit, equipment: it.equipment, model: it.model,
        baseline_qty: Math.max(0, it.closing), baseline_month: latest.periodMonth,
        procured_qty: 0, issued_qty: 0, manual_delta: 0,
        ticket_procured_qty: 0, on_hand: Math.max(0, it.closing), updated_at: nowIso,
        created_by_batch_id: resolveItemOwner(ownerByName, it.itemName, batchId),
      }));
      for (let i = 0; i < itemRows.length; i += CHUNK) {
        // Conflict target follows the authoritative key. Migration 60 replaced
        // unique(plant_id,item_name) with unique(store_id,item_name) — matching
        // on the old pair would insert a SECOND row for an item the shared
        // Rehla store already holds instead of updating it.
        const { error } = await (supabase.from('store_items') as any)
          .upsert(itemRows.slice(i, i + CHUNK), { onConflict: 'store_id,item_name' });
        if (error) throw error;
      }

      await setImportBatchRowCount(batchId, latest.items.length);
      setImportedCount(latest.items.length);
      setStage('done');
      await load();
    } catch (e) {
      setErr(errMsg(e, { action: 'import this stock file', context: 'StockRegister.confirmImport' })); setStage('error');
    }
  }

  function resetImport() { setStage('idle'); setParseResult(null); setErr(null); setCloudUrl(null); setImportAnoms([]); }

  // ── Manual edit (requires justification, logged to Activity Log) ─────────────
  function openEdit(it: StockItem) {
    if (!canEditStockRow(it)) return;
    if (isSnapshotItem(it.id)) {
      toast.error(t('storereq.stockSnapshotReadOnly', 'This view is from a monthly snapshot — upload or refresh the living register to edit stock.'));
      return;
    }
    setEditItem(it);
    setEditForm({
      name: it.item_name,
      equipment: it.equipment || '',
      model: it.model || '',
      onHand: String(it.on_hand),
      unit: normalizeUnit(it.unit),
      reason: '',
    });
  }

  async function saveEdit() {
    if (!editItem || !canEditStockRow(editItem)) return;
    const reason = editForm.reason.trim();
    if (!reason) { toast.error(t('storereq.stockToastNeedJust', 'A justification is required for any stock edit.')); return; }
    const oldOnHand = Number(editItem.on_hand);
    const newOnHand = parseFloat(editForm.onHand);
    const newName = editForm.name.trim() || editItem.item_name;
    const newEquipment = editForm.equipment.trim();
    const newModel = editForm.model.trim();
    const oldEquipment = (editItem.equipment || '').trim();
    const oldModel = (editItem.model || '').trim();
    const oldUnit = normalizeUnit(editItem.unit);
    const newUnit = normalizeUnit(editForm.unit);
    const nameChanged = newName !== editItem.item_name;
    const equipmentChanged = newEquipment !== oldEquipment;
    const modelChanged = newModel !== oldModel;
    const qtyChanged = !isNaN(newOnHand) && newOnHand !== oldOnHand;
    const unitChanged = newUnit !== oldUnit;
    if (!nameChanged && !equipmentChanged && !modelChanged && !qtyChanged && !unitChanged) { toast.error(t('storereq.stockToastNoChange', 'Nothing changed.')); return; }
    if (qtyChanged && newOnHand < 0) { toast.error(t('storereq.stockToastNegative', 'On-hand cannot be negative.')); return; }
    const delta = qtyChanged ? newOnHand - oldOnHand : 0;
    try {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (nameChanged) patch.item_name = newName;
      if (equipmentChanged) patch.equipment = newEquipment || null;
      if (modelChanged) patch.model = newModel || null;
      if (unitChanged) patch.unit = newUnit;
      if (qtyChanged) { patch.on_hand = newOnHand; patch.manual_delta = Number(editItem.manual_delta) + delta; }
      const { error } = await (supabase.from('store_items') as any).update(patch).eq('id', editItem.id);
      if (error) throw error;
      await insertRows('store_stock_events', {
        item_id: editItem.id, plant_id: editItem.plant_id, event_type: qtyChanged ? 'manual_edit' : 'rename',
        // A manual correction is still a movement in a register, attributed to
        // the factory whose row it is.
        store_id: editItem.store_id ?? storeIdFor(editItem.plant_id),
        requesting_plant_id: editItem.plant_id,
        qty_delta: delta, on_hand_after: qtyChanged ? newOnHand : oldOnHand, justification: reason,
        actor_name: activeProfile.name,
      });
      await insertRows('activity_logs', {
        equipment: `Stock: ${newName}`, type: 'stock_edit', date: new Date().toISOString().slice(0, 10),
        done_by: activeProfile.name, plant_id: editItem.plant_id,
        note: `${qtyChanged ? `Qty ${oldOnHand} → ${newOnHand} (${delta > 0 ? '+' : ''}${delta}). ` : ''}${nameChanged ? `Renamed from "${editItem.item_name}". ` : ''}${equipmentChanged ? `Equipment "${oldEquipment || '—'}" → "${newEquipment || '—'}". ` : ''}${modelChanged ? `Model "${oldModel || '—'}" → "${newModel || '—'}". ` : ''}${unitChanged ? `Unit ${oldUnit} → ${newUnit}. ` : ''}${reason}`,
      });
      void recordAudit({ module: 'stock', action: 'edited', summary: `Edited ${newName}`, actorName: activeProfile.name, actorRole: activeProfile.roleLabel });
      setEditItem(null);
      toast.success(t('storereq.stockToastSaved', 'Stock updated and logged to the Activity Log.'));
      await load();
    } catch (e) {
      toast.error(errMsg(e, { action: 'save this stock change', context: 'StockRegister.saveEdit' }));
    }
  }

  function openDelete(it: StockItem) {
    if (!allowStockDelete) return;
    if (isSnapshotItem(it.id)) {
      toast.error(t('storereq.stockSnapshotReadOnly', 'This view is from a monthly snapshot — upload or refresh the living register to edit stock.'));
      return;
    }
    setDeleteItem(it);
    setDeleteReason('');
  }

  async function confirmDelete() {
    if (!deleteItem || !allowStockDelete) return;
    const reason = deleteReason.trim();
    if (!reason) {
      toast.error(t('storereq.stockDeleteNeedJust', 'A justification is required to delete a stock item.'));
      return;
    }
    setDeleting(true);
    try {
      await insertRows('activity_logs', {
        equipment: `Stock: ${deleteItem.item_name}`,
        type: 'stock_delete',
        date: new Date().toISOString().slice(0, 10),
        done_by: activeProfile.name,
        plant_id: deleteItem.plant_id,
        note: `Deleted stock item "${deleteItem.item_name}" (on-hand ${Number(deleteItem.on_hand)} ${normalizeUnit(deleteItem.unit)}). ${reason}`,
      });
      void recordAudit({ module: 'stock', action: 'deleted', summary: `Deleted stock item ${deleteItem.item_name}. ${reason}`, actorName: activeProfile.name, actorRole: activeProfile.roleLabel });
      // Movement history cascades with the row (store_stock_events.item_id ON DELETE CASCADE).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('store_items') as any).delete().eq('id', deleteItem.id);
      if (error) throw error;
      setDeleteItem(null);
      setDeleteReason('');
      toast.success(t('storereq.stockToastDeleted', 'Stock item removed and logged to the Activity Log.'));
      await load();
    } catch (e) {
      toast.error(errMsg(e, { action: 'delete this stock item', context: 'StockRegister.confirmDelete' }));
    } finally {
      setDeleting(false);
    }
  }

  const busy = stage === 'uploading' || stage === 'parsing';

  const multiStore = plantFilter.length !== 1 && plantsInData.length > 1;

  function openTicketFromStock(tid: string) {
    const back = new URLSearchParams({ tab: 'stock' });
    if (search.trim()) back.set('q', search.trim());
    navigate(`/dashboard/purchase/maint?ticket=${encodeURIComponent(tid)}&from=${encodeURIComponent(`/dashboard/purchase/storereq?${back.toString()}`)}`);
  }

  function renderTicketLinks(itemName: string, ids: string[], phone: boolean) {
    if (!ids.length) return <span className="text-slate-300">—</span>;
    const shown = ids.slice(0, 3);
    const extra = ids.length - shown.length;
    const btn = phone
      ? 'min-h-[36px] px-3 rounded-lg text-[13px] font-semibold text-blue-600 bg-blue-50 border border-blue-100'
      : 'num text-blue-600 font-semibold mr-1';
    const more = phone
      ? 'min-h-[36px] px-3 rounded-lg text-[13px] font-semibold text-slate-600 bg-slate-50 border border-slate-200'
      : 'num text-slate-500 font-semibold';
    return (
      <>
        {shown.map(tid => (
          <button
            key={tid}
            type="button"
            onClick={() => openTicketFromStock(tid)}
            className={btn}
            style={phone ? undefined : { background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
            title={t('storereq.open_ticket', 'Open maintenance ticket')}
          >#{ticketShort(tid)}</button>
        ))}
        {extra > 0 && (
          <button
            type="button"
            onClick={() => setTicketList({ item: itemName, ids })}
            className={more}
            style={phone ? undefined : { background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
            title={t('storereq.ticketsForItem', { item: itemName })}
          >{t('storereq.moreTickets', { n: extra })}</button>
        )}
      </>
    );
  }

  return (
    <div className="card2 p-4 sm:p-6 mb-5">
      {openedReceipt && (
        <div style={{ border: '1px solid #FDE68A', background: '#FFFBEB', borderRadius: 12, padding: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#92400E', textTransform: 'uppercase' }}>Purchase</div>
              <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2 }}>{openedReceipt.vendor_name || 'Purchase'}</div>
              <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
                {openedReceipt.invoice_no ? `Bill ${openedReceipt.invoice_no}` : 'No bill number'}
                {openedReceipt.purchase_date ? ` · ${openedReceipt.purchase_date}` : ''}
                {openedReceipt.amount != null ? ` · ₹${Number(openedReceipt.amount).toLocaleString('en-IN')}` : ''}
                {openedReceipt.actor_name ? ` · ${openedReceipt.actor_name}` : ''}
              </div>
              {openedReceipt.lines.length > 0 && (
                <div style={{ fontSize: 12, color: '#0F172A', marginTop: 6 }}>
                  {openedReceipt.lines.map((ln, i) => `${ln.item_name || 'Item'}${ln.qty != null ? ` × ${ln.qty}${ln.unit ? ` ${ln.unit}` : ''}` : ''}`).join(', ')}
                </div>
              )}
              {openedReceipt.notes && <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>{openedReceipt.notes}</div>}
              {openedReceipt.bill_url && (
                <a href={openedReceipt.bill_url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 8, fontSize: 12, fontWeight: 700, color: '#2563EB' }}>Open bill</a>
              )}
            </div>
            <button type="button" onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('receipt');
              setSearchParams(next, { replace: true });
            }} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#64748B', fontSize: 18 }}>×</button>
          </div>
        </div>
      )}
      {ticketList && (
        <div style={overlay} onClick={() => setTicketList(null)}>
          <div style={{ ...modal, width: 'min(420px, 100%)', maxHeight: 'min(70vh, 560px)', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{t('storereq.ticketsForItem', { item: ticketList.item })}</div>
              <button type="button" onClick={() => setTicketList(null)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: '#64748B' }} aria-label={t('storereq.stockClose', 'Close')}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>{t('storereq.ticketsForItemCount', { n: ticketList.ids.length })}</div>
            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ticketList.ids.map(tid => (
                <button
                  key={tid}
                  type="button"
                  onClick={() => openTicketFromStock(tid)}
                  style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#2563EB', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}
                >#{ticketShort(tid)}</button>
              ))}
            </div>
          </div>
        </div>
      )}
      <input ref={billFileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadItemBill(f); e.target.value = ''; }} />
      <div className="flex items-start sm:items-center justify-between mb-3 flex-col sm:flex-row gap-3">
        <div className="min-w-0">
          <div className="text-base font-bold font-heading">{t('storereq.stockHeading', 'Stock register')}</div>
          <div className="text-xs text-slate-500 leading-snug">
            {t('storereq.stockSubtitle', 'Software register — Excel / raw upload does not write to Busy. OP − Issue (+ restock / repair / manual) = CL.')}
            {latestUpload ? ` · ${t('storereq.stockLatestMonth', { defaultValue: 'Latest month: {{month}}', month: latestUpload.slice(0, 7) })}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
          {items.length > 0 && !fromSnapshot && profileHasCapability(activeProfile, 'add_stock_purchase') && (
            <button onClick={() => setShowPurchase(true)} className="pill px-4 py-2.5 font-semibold text-sm min-h-[44px] md:min-h-0" style={{ border: '1px solid #E2E8F0', background: '#fff', color: '#334155', cursor: 'pointer' }}>{t('storereq.stockAddPurchase', '＋ Add Purchase')}</button>
          )}
          {/* The delete-a-bad-upload flow lives in Admin → Upload History, but
              the moment you NEED it is while you are standing here looking at a
              register full of wrong numbers. Linking from the point of use,
              pre-filtered to this store, saves hunting for it — and re-uploading
              a corrected file cannot on its own remove rows that were in the bad
              file and are absent from the good one, so this is the only route
              back to a clean register. */}
          {profileHasCapability(activeProfile, 'delete_import_batch') && (
            <button
              onClick={() => {
                const p = new URLSearchParams({ module: 'stock' });
                const sid = plantFilter.length === 1 ? plantFilter[0] : (storeChips.length === 1 ? storeChips[0].id : '');
                if (sid) p.set('store', sid);
                navigate(`/dashboard/admin/uploads?${p.toString()}`);
              }}
              className="pill px-4 py-2 font-semibold text-sm"
              style={{ border: '1px solid #E2E8F0', background: '#fff', color: '#334155', cursor: 'pointer' }}
              title={t('storereq.manageUploadsHint', 'View the files this register was built from, and delete the records imported by an incorrect one')}
            >
              {t('storereq.manageUploads', '⌫ Manage uploads')}
            </button>
          )}
          {canUploadExcel && (
            <>
              <button onClick={() => fileRef.current?.click()} className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm">{t('storereq.stockUploadExcel', '↑ Upload Excel')}</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
            </>
          )}
        </div>
      </div>

      {loading ? <SkeletonRows rows={4} /> : registerItems.length === 0 ? (
        // The empty state names the store too. "No stock file uploaded yet" on
        // its own is the worst version of the reported bug: the one screen where
        // the user most needs to know WHICH register they are looking at said
        // nothing about it at all.
        <div className="text-center text-slate-400 py-8 text-sm">
          {activeStoreLabel && (
            <div className="mb-2">
              <span className="chip active" style={{ cursor: 'default' }}>
                {t('storereq.storePrefix', 'Store')}: {activeStoreLabel}
              </span>
            </div>
          )}
          {t('storereq.stockEmptyTitle', 'No stock file uploaded yet.')}<br />
          {canUploadExcel
            ? <>{t('storereq.stockEmptyBodyPre', 'Upload the monthly')} <strong>{t('storereq.stockEmptyBodyStrong', 'Store Keeping')}</strong> {t('storereq.stockEmptyBodyPost', 'Excel to seed the register.')}</>
            : t('storereq.stockEmptyAskAdmin', 'Ask an administrator to upload the monthly Store Keeping Excel.')}
        </div>
      ) : (
        <>
          {fromSnapshot && (
            <div className="mb-3 text-sm" style={{ background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 10, padding: '10px 14px', color: '#92400E' }}>
              {t('storereq.stockSnapshotBanner', 'Living register is empty — showing quantities from the latest uploaded monthly snapshot. Re-upload the Store Keeping Excel to refresh on-hand stock.')}
            </div>
          )}
          {/* Summary strip + expand toggle (the big table stays collapsed) */}
          <div className="flex items-center justify-between flex-wrap gap-2" style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 12, padding: '10px 14px' }}>
            <div style={{ fontSize: 13, color: '#334155' }}>
              <strong>{summary.total}</strong> {summary.total === 1 ? t('storereq.stockItemSingular', 'item') : t('storereq.stockItemPlural', 'items')}
              {/* Always name the register — including when there is only one
                  store, which is exactly the case that used to show nothing. */}
              {activeStoreLabel && <span> · <strong>{activeStoreLabel}</strong></span>}
              <span className="text-slate-400"> · </span>
              <span style={{ color: '#16A34A' }}>{t('storereq.stockInStockCount', { defaultValue: '{{n}} in stock', n: summary.inStock })}</span>
              <span className="text-slate-400"> · </span>
              <span style={{ color: '#D97706' }}>{t('storereq.stockLowCount', { defaultValue: '{{n}} low', n: summary.low })}</span>
              <span className="text-slate-400"> · </span>
              <span style={{ color: '#DC2626' }}>{t('storereq.stockOutCount', { defaultValue: '{{n}} out', n: summary.out })}</span>
            </div>
            <div className="flex items-center gap-2">
              {openAnoms.length > 0 && (
                <button onClick={() => { setCollapsed(false); setShowAnoms(true); }} style={{ fontSize: 12, fontWeight: 700, color: '#B45309', background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>{t('storereq.stockAnomBtn', { defaultValue: '⚠ {{n}} anomalies', n: openAnoms.length })}</button>
              )}
              <button onClick={() => setCollapsed(c => !c)} className="text-sm font-semibold" style={{ color: '#F47651', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {collapsed ? t('storereq.stockShowRegister', 'Show register ▾') : t('storereq.stockHideRegister', 'Hide register ▴')}
              </button>
            </div>
          </div>

          {!collapsed && (
            <div style={{ marginTop: 14 }}>
              {/* Store selector — ALWAYS rendered. With a single store it is a
                  plain label rather than a button: there is nothing to switch to,
                  but the register still has to say whose stock this is. */}
              {storeChips.length === 1 && (
                <div className="flex gap-2 mb-3 flex-wrap items-center">
                  <span className="chip active" style={{ cursor: 'default' }}>
                    {t('storereq.storePrefix', 'Store')}: {storeChips[0].name}
                  </span>
                  {!storeChips[0].hasData && (
                    <span style={{ fontSize: 11, color: '#94A3B8' }}>{t('storereq.storeNoStock', 'no stock file uploaded yet')}</span>
                  )}
                </div>
              )}
              {storeChips.length > 1 && (
                <div className="flex gap-2 mb-3 flex-wrap">
                  <button onClick={() => setPlantFilter([])} className={`chip${plantFilter.length === 0 ? ' active' : ''}`}>{t('storereq.all_stores', 'All stores')}</button>
                  {storeChips.map(p => (
                    <button
                      key={p.id} onClick={() => togglePlant(p.id)}
                      className={`chip${plantFilter.includes(p.id) ? ' active' : ''}`}
                      // An empty register stays selectable — that is how you
                      // confirm it is genuinely empty rather than filtered out.
                      style={p.hasData ? undefined : { opacity: 0.55 }}
                      title={p.hasData ? undefined : t('storereq.storeNoStock', 'no stock file uploaded yet')}
                    >
                      {p.name}{p.hasData ? '' : ' ·'}
                    </button>
                  ))}
                  {plantFilter.length > 1 && <span style={{ fontSize: 11, color: '#94A3B8', alignSelf: 'center' }}>{t('storereq.stockCombinedNote', 'combined · identical items summed')}</span>}
                </div>
              )}

              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('storereq.stockSearchPh', 'Search item, equipment, or ticket #…')}
                style={{ ...inputStyle, width: '100%', marginBottom: 12, minHeight: 44, fontSize: 16 }}
              />

              {/* Anomalies — open ones count; settled (resolved / false-positive) collapse
                  behind a toggle. Review actions go through the resolve_stock_anomaly RPC. */}
              {reviewed.length > 0 && (
                <div style={{ border: '1px solid #FED7AA', background: '#FFFBEB', borderRadius: 12, padding: 12, marginBottom: 14 }}>
                  <button onClick={() => setShowAnoms(v => !v)} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#B45309' }}>
                      {/* The heading names the month being shown. It used to say
                          "the latest file vs the prior month" regardless of what
                          was actually compared, which is how a May→June anomaly
                          came to be read as a June→July one. */}
                      {openAnoms.length === 1
                        ? t('storereq.stockOpenAnomOneIn', { defaultValue: '⚠ {{n}} open anomaly in {{month}}', n: openAnoms.length, month: anomMonth === '*' ? t('storereq.allMonths', 'all months') : labelForPeriod(`${effectiveAnomMonth}-01`) })
                        : t('storereq.stockOpenAnomManyIn', { defaultValue: '⚠ {{n}} open anomalies in {{month}}', n: openAnoms.length, month: anomMonth === '*' ? t('storereq.allMonths', 'all months') : labelForPeriod(`${effectiveAnomMonth}-01`) })}
                      {settledAnoms.length > 0 && <span style={{ fontWeight: 600, color: '#92400E' }}> {t('storereq.stockSettledCount', { defaultValue: '· {{n}} settled', n: settledAnoms.length })}</span>}
                      {/* Never let a month-scoped view hide the real backlog. */}
                      {anomMonth !== '*' && openAllMonths > openAnoms.length && (
                        <span style={{ fontWeight: 600, color: '#92400E' }}>
                          {' '}{t('storereq.stockOpenElsewhere', { defaultValue: '· {{n}} more in earlier months', n: openAllMonths - openAnoms.length })}
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 12, color: '#B45309' }}>{showAnoms ? t('storereq.stockHide', 'Hide') : t('storereq.stockShow', 'Show')}</span>
                  </button>
                  {/* Month picker — every pair is reconciled, so earlier months
                      stay reachable instead of vanishing when a newer file lands. */}
                  {showAnoms && anomalyMonths.length > 1 && (
                    <div className="flex gap-2 mt-2.5 flex-wrap items-center">
                      {anomalyMonths.map(mk => (
                        <button
                          key={mk} onClick={() => setAnomMonth(mk)}
                          className={`chip${effectiveAnomMonth === mk && anomMonth !== '*' ? ' active' : ''}`}
                        >
                          {labelForPeriod(`${mk}-01`)}
                        </button>
                      ))}
                      <button
                        onClick={() => setAnomMonth('*')}
                        className={`chip${anomMonth === '*' ? ' active' : ''}`}
                      >
                        {t('storereq.allMonths', 'All months')}
                      </button>
                    </div>
                  )}
                  {showAnoms && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                      {(showSettled ? reviewed : openAnoms).map((r, i) => {
                        const a = r.anomaly;
                        const st = r.resolution?.status ?? 'open';
                        const stTone = st === 'resolved' ? { bg: '#F0FDF4', color: '#16A34A' }
                          : st === 'false_positive' ? { bg: '#F1F5F9', color: '#64748B' }
                          : st === 'confirmed' ? { bg: '#FEF2F2', color: '#DC2626' }
                          : { bg: '#FEF3C7', color: '#B45309' };
                        return (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, background: '#fff', border: '1px solid #FDE68A', borderRadius: 8, padding: '7px 10px', opacity: r.isOpen ? 1 : 0.75 }}>
                            <span title={t(ANOM_META[a.type].labelKey, ANOM_META[a.type].label)}>{ANOM_META[a.type].icon}</span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontWeight: 600, color: '#334155' }}>
                                {a.item}
                                {r.plantId && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: '#B45309', background: '#FEF3C7', borderRadius: 6, padding: '1px 6px' }}>{plantName(r.plantId)}</span>}
                                {r.resolution && (
                                  <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: stTone.color, background: stTone.bg, borderRadius: 6, padding: '1px 6px' }}>
                                    {RES_STATUS_KEYS[st] ? t(RES_STATUS_KEYS[st][0], RES_STATUS_KEYS[st][1]) : st.replace('_', ' ')}
                                  </span>
                                )}
                              </div>
                              <div style={{ color: '#64748B' }}>{a.detail}</div>
                              {r.resolution?.resolution_comment && (
                                <div style={{ color: '#94A3B8', fontSize: 11 }}>“{r.resolution.resolution_comment}” — {r.resolution.resolved_by_name || '—'}</div>
                              )}
                            </div>
                            {canReview && r.plantId && (
                              <button onClick={() => setReviewItem(r)} style={{ fontSize: 11.5, fontWeight: 700, color: '#2563EB', background: 'none', border: '1px solid #BFDBFE', borderRadius: 8, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                                {r.isOpen ? t('storereq.stockReview', 'Review') : t('storereq.stockReopen', 'Reopen')}
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {settledAnoms.length > 0 && (
                        <button onClick={() => setShowSettled(v => !v)} style={{ fontSize: 11.5, fontWeight: 600, color: '#92400E', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'flex-start', padding: 0 }}>
                          {showSettled
                            ? t('storereq.stockHideSettled', '▴ Hide settled anomalies')
                            : settledAnoms.length === 1
                              ? t('storereq.stockShowSettledOne', { defaultValue: '▾ Show {{n}} settled anomaly', n: settledAnoms.length })
                              : t('storereq.stockShowSettledMany', { defaultValue: '▾ Show {{n}} settled anomalies', n: settledAnoms.length })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Desktop wide table — hidden below md so the phone is not crushed. */}
              <div className="overflow-x-auto scroll-x desktop-only-table hidden md:block">
                <table className="dt2">
                  <thead>
                    <tr>
                      <Th sortKey="date" s={mergedSort} firstDir="desc">{t('storereq.stockColDate', 'Date')}</Th>
                      <Th sortKey="item" s={mergedSort}>{t('storereq.col_item', 'Item')}</Th>
                      <th>{t('storereq.col_equipment', 'Equipment')}</th>
                      {multiStore && <th>{t('storereq.stockColStores', 'Stores')}</th>}
                      <th>{t('storereq.field_unit', 'Unit')}</th>
                      <Th sortKey="opening" s={mergedSort} firstDir="desc" className="num">{t('storereq.stockColOp', 'OP')}</Th>
                      <Th sortKey="issued" s={mergedSort} firstDir="desc" className="num">{t('storereq.stockColIssued', 'Issue')}</Th>
                      <Th sortKey="onHand" s={mergedSort} firstDir="desc" className="num">{t('storereq.stockColCl', 'CL')}</Th>
                      <th>Bill</th>
                      <th>Bill upload date & time</th>
                      <th>{t('storereq.col_ticket', 'Ticket #')}</th>
                      <Th sortKey="status" s={mergedSort} firstDir="desc">{t('storereq.col_status', 'Status')}</Th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergedSort.sorted.length === 0 && <tr><td colSpan={multiStore ? 13 : 12} className="text-center text-slate-400 py-6 text-sm">{t('storereq.stockNoItemsMatch', 'No items match.')}</td></tr>}
                    {pageRows.map((m, idx) => {
                      const st = stockStatus(m.onHand);
                      const isOpen = expanded === m.key;
                      const single = m.stores.length === 1;
                      const stamp = (billsByKey.get(m.key) || [])[0]?.at || m.entryAt || '';
                      const prevStamp = idx > 0 ? ((billsByKey.get(pageRows[idx - 1].key) || [])[0]?.at || pageRows[idx - 1].entryAt || '') : '';
                      const showDay = stamp && dayKey(stamp) !== dayKey(prevStamp);
                      return (
                        <React.Fragment key={m.key}>
                          {showDay && (
                            <tr>
                              <td colSpan={multiStore ? 13 : 12} style={{ background: '#161616', color: '#F3EFE8', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 10px' }}>
                                {fmtDay(stamp)}
                              </td>
                            </tr>
                          )}
                          <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(isOpen ? null : m.key)}>
                            <td className="text-xs text-slate-500 whitespace-nowrap">{stamp ? fmtDay(stamp) : '—'}</td>
                            <td className="font-semibold text-slate-700">{m.itemName}</td>
                            <td className="text-slate-500 text-xs">{m.equipment}{m.model ? ` · ${m.model}` : ''}</td>
                            {multiStore && <td className="text-slate-500 text-xs">{single ? m.stores[0].plant : t('storereq.stockStoresCount', { defaultValue: '{{n}} stores', n: m.stores.length })}</td>}
                            <td className="text-slate-500 text-xs">{m.unit}</td>
                            <td className="num" title={t('storereq.stockColOpHint', 'Opening / baseline')}>{m.opening}</td>
                            <td className="num" style={{ color: m.issued > 0 ? '#2563EB' : '#CBD5E1' }}>{m.issued || '—'}</td>
                            <td className="num font-bold" style={{ color: st.color }}
                              title={t('storereq.stockClHint', { defaultValue: 'Closing = OP − Issue + restock / repair / manual. New: {{fresh}} · Repaired: {{repaired}}', fresh: m.onHand - m.repaired, repaired: m.repaired })}>
                              {m.onHand}{m.repaired > 0 && <span aria-label={`includes ${m.repaired} repaired unit(s)`} style={{ color: '#7C3AED' }}>*</span>}
                            </td>
                            <td onClick={e => e.stopPropagation()}>
                              {(() => {
                                const list = billsByKey.get(m.key) || [];
                                const latest = list[0];
                                return (
                                  <div className="flex items-center gap-2">
                                    {latest
                                      ? <a href={latest.url} target="_blank" rel="noreferrer" title="View bill"><img src={latest.url} alt="Bill" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 6, border: '1px solid #E2E8F0' }} /></a>
                                      : <span className="text-slate-300">—</span>}
                                    {allowStockEdit && (
                                      <button type="button" onClick={() => { setBillTarget(m); billFileRef.current?.click(); }} style={{ fontSize: 11, fontWeight: 700, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Upload</button>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="text-xs font-extrabold text-slate-800 whitespace-nowrap">{(billsByKey.get(m.key) || [])[0] ? fmtWhen(billsByKey.get(m.key)![0].at) : '—'}</td>
                            <td className="text-xs" onClick={e => e.stopPropagation()}>
                              {renderTicketLinks(m.itemName, m.ticketNos, false)}
                            </td>
                            <td><span className="badge" style={{ background: st.bg, color: st.color, fontWeight: 700 }}>{t(STATUS_LABEL_KEYS[st.key], st.label)}</span></td>
                            <td>
                              {single && !fromSnapshot && (canEditStockRow(m.stores[0].raw) || allowStockDelete) ? (
                                <span className="inline-flex items-center gap-2 text-xs" onClick={e => e.stopPropagation()}>
                                  {canEditStockRow(m.stores[0].raw) && <button onClick={() => openEdit(m.stores[0].raw)} style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>{t('storereq.stockEdit', 'Edit')}</button>}
                                  {allowStockDelete && (
                                    <button onClick={() => openDelete(m.stores[0].raw)} style={{ color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>{t('storereq.stockDelete', 'Delete')}</button>
                                  )}
                                </span>
                              ) : (
                                <span className="text-xs text-slate-400">{single ? '—' : '▾'}</span>
                              )}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={multiStore ? 13 : 12} style={{ background: '#F8FAFC', padding: '8px 12px' }}>
                                {(billsByKey.get(m.key) || []).length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, fontWeight: 800, color: '#334155', marginBottom: 4 }}>Bill history · newest first</div>
                                    {(billsByKey.get(m.key) || []).map((b, i) => (
                                      <div key={`${b.url}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
                                        <a href={b.url} target="_blank" rel="noreferrer"><img src={b.url} alt="" style={{ width: 42, height: 42, objectFit: 'cover', borderRadius: 6 }} /></a>
                                        <div>
                                          <div className="font-extrabold">{fmtWhen(b.at)}</div>
                                          <div style={{ color: '#64748B' }}>{b.by || '—'}</div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {m.stores.map(s => (
                                  <div key={s.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, fontSize: 11.5, color: '#64748B', padding: '3px 0' }}>
                                    <strong style={{ color: '#334155', minWidth: 70 }}>{s.plant}</strong>
                                    <span>{t('storereq.stockColOnHand', 'On-hand')}: <strong>{s.onHand}</strong></span>
                                    {s.repaired > 0 && <span style={{ color: '#7C3AED' }}>{t('storereq.stockExpNewStock', 'New stock')}: <strong>{s.onHand - s.repaired}</strong> · {t('storereq.stockExpRepairedStock', 'Repaired stock')}: <strong>{s.repaired}</strong></span>}
                                    <span>{t('storereq.stockExpBaseline', 'Baseline')} ({s.raw.baseline_month?.slice(0, 7) || '—'}): <strong>{Number(s.raw.baseline_qty)}</strong></span>
                                    <span>− {t('storereq.stockExpIssuedFromStore', 'Issued from store')}: <strong>{Number(s.raw.issued_qty)}</strong></span>
                                    <span style={{ color: '#7C3AED' }}>{t('storereq.stockExpProcuredTickets', 'Procured for tickets')}: <strong>{s.procured}</strong></span>
                                    {Number(s.raw.procured_qty) > 0 && <span>+ {t('storereq.stockExpRestocked', 'Restocked')}: <strong>{Number(s.raw.procured_qty)}</strong></span>}
                                    <span>{t('storereq.stockExpManual', 'Manual')}: <strong>{Number(s.raw.manual_delta) > 0 ? '+' : ''}{Number(s.raw.manual_delta)}</strong></span>
                                    {!fromSnapshot && (canEditStockRow(s.raw) || allowStockDelete) && (
                                      <span className="inline-flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                        {canEditStockRow(s.raw) && <button onClick={() => openEdit(s.raw)} style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, padding: 0 }}>{t('storereq.stockEdit', 'Edit')}</button>}
                                        {allowStockDelete && (
                                          <button onClick={() => openDelete(s.raw)} style={{ color: '#DC2626', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, padding: 0 }}>{t('storereq.stockDelete', 'Delete')}</button>
                                        )}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Phone: one card per item — readable type, tap to expand detail. */}
              <div className="mobile-stack flex flex-col gap-2.5 md:hidden">
                {mergedSort.sorted.length === 0 && (
                  <div className="text-center text-slate-400 py-8 text-sm">{t('storereq.stockNoItemsMatch', 'No items match.')}</div>
                )}
                {pageRows.map(m => {
                  const st = stockStatus(m.onHand);
                  const isOpen = expanded === m.key;
                  const single = m.stores.length === 1;
                  const equipLine = [m.equipment, m.model].filter(Boolean).join(' · ');
                  const showEquip = equipLine && equipLine.toLowerCase() !== m.itemName.toLowerCase();
                  return (
                    <div
                      key={m.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpanded(isOpen ? null : m.key)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(isOpen ? null : m.key); } }}
                      className="rounded-[12px] border border-slate-200 bg-white p-3.5 active:bg-slate-50"
                      style={{ borderLeft: `3px solid ${st.color}` }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-[15px] font-semibold text-slate-800 leading-snug break-words">{m.itemName}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-slate-500">
                            {m.unit && <span>{m.unit}</span>}
                            {multiStore && (
                              <span>· {single ? m.stores[0].plant : t('storereq.stockStoresCount', { defaultValue: '{{n}} stores', n: m.stores.length })}</span>
                            )}
                          </div>
                          {showEquip && <div className="mt-0.5 text-[12px] text-slate-400 truncate">{equipLine}</div>}
                        </div>
                        <span className="badge shrink-0" style={{ background: st.bg, color: st.color, fontWeight: 700 }}>{t(STATUS_LABEL_KEYS[st.key], st.label)}</span>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-lg bg-slate-50 py-2 px-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t('storereq.stockColOp', 'OP')}</div>
                          <div className="mt-0.5 text-[16px] font-bold tabular-nums text-slate-700">{m.opening}</div>
                        </div>
                        <div className="rounded-lg bg-slate-50 py-2 px-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t('storereq.stockColIssued', 'Issue')}</div>
                          <div className="mt-0.5 text-[16px] font-bold tabular-nums" style={{ color: m.issued > 0 ? '#2563EB' : '#94A3B8' }}>{m.issued || '—'}</div>
                        </div>
                        <div className="rounded-lg bg-slate-50 py-2 px-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t('storereq.stockColCl', 'CL')}</div>
                          <div className="mt-0.5 text-[16px] font-bold tabular-nums" style={{ color: st.color }}>
                            {m.onHand}{m.repaired > 0 && <span style={{ color: '#7C3AED' }}>*</span>}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-2" onClick={e => e.stopPropagation()}>
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Bill upload</div>
                          <div className="text-[13px] font-extrabold text-slate-800">{(billsByKey.get(m.key) || [])[0] ? fmtWhen(billsByKey.get(m.key)![0].at) : '—'}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {(billsByKey.get(m.key) || [])[0] && (
                            <a href={billsByKey.get(m.key)![0].url} target="_blank" rel="noreferrer" className="text-[13px] font-bold text-blue-600">View bill</a>
                          )}
                          {allowStockEdit && (
                            <button type="button" onClick={() => { setBillTarget(m); billFileRef.current?.click(); }} className="min-h-[36px] px-3 rounded-lg text-[13px] font-bold text-blue-700 bg-blue-50 border border-blue-100">Upload</button>
                          )}
                        </div>
                      </div>

                      {(m.ticketNos.length > 0 || (single && !fromSnapshot)) && (
                        <div className="mt-3 flex flex-wrap items-center gap-2" onClick={e => e.stopPropagation()}>
                          {renderTicketLinks(m.itemName, m.ticketNos, true)}
                          {single && !fromSnapshot && (canEditStockRow(m.stores[0].raw) || allowStockDelete) && (
                            <>
                              {canEditStockRow(m.stores[0].raw) && <button type="button" onClick={() => openEdit(m.stores[0].raw)} className="min-h-[36px] px-3 rounded-lg text-[13px] font-semibold text-blue-600 bg-white border border-slate-200">{t('storereq.stockEdit', 'Edit')}</button>}
                              {allowStockDelete && (
                                <button type="button" onClick={() => openDelete(m.stores[0].raw)} className="min-h-[36px] px-3 rounded-lg text-[13px] font-semibold text-red-600 bg-white border border-red-100">{t('storereq.stockDelete', 'Delete')}</button>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {isOpen && (
                        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2" onClick={e => e.stopPropagation()}>
                          {m.stores.map(s => (
                            <div key={s.id} className="text-[12.5px] text-slate-600 space-y-1">
                              <div className="font-semibold text-slate-800">{s.plant}</div>
                              <div>{t('storereq.stockColOnHand', 'On-hand')}: <strong>{s.onHand}</strong>
                                {s.repaired > 0 && <> · <span style={{ color: '#7C3AED' }}>{t('storereq.stockExpRepairedStock', 'Repaired stock')}: <strong>{s.repaired}</strong></span></>}
                              </div>
                              <div>{t('storereq.stockExpBaseline', 'Baseline')} ({s.raw.baseline_month?.slice(0, 7) || '—'}): <strong>{Number(s.raw.baseline_qty)}</strong>
                                {' '}− {t('storereq.stockExpIssuedFromStore', 'Issued from store')}: <strong>{Number(s.raw.issued_qty)}</strong>
                              </div>
                              {!fromSnapshot && (canEditStockRow(s.raw) || allowStockDelete) && (
                                <div className="flex gap-2 pt-1">
                                  {canEditStockRow(s.raw) && <button type="button" onClick={() => openEdit(s.raw)} className="min-h-[36px] px-3 rounded-lg text-[13px] font-semibold text-blue-600 border border-slate-200">{t('storereq.stockEdit', 'Edit')}</button>}
                                  {allowStockDelete && (
                                    <button type="button" onClick={() => openDelete(s.raw)} className="min-h-[36px] px-3 rounded-lg text-[13px] font-semibold text-red-600 border border-red-100">{t('storereq.stockDelete', 'Delete')}</button>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <TablePagination controls={controls} />
            </div>
          )}
        </>
      )}

      {/* ── Who bought it vs who used it ──────────────────────────────────────
          Only meaningful once a store is shared, which is exactly when it
          becomes necessary: stock is held once, but the money came off two
          different companies' invoices. Collapsed by default. */}
      <div style={{ marginTop: 14 }}>
        <StoreReconciliation />
      </div>

      {/* ── Add purchase modal ────────────────────────────────────────────────── */}
      <AddPurchaseModal open={showPurchase} onClose={() => setShowPurchase(false)} onApplied={load} />
      <AnomalyReviewModal item={reviewItem} onClose={() => setReviewItem(null)} onSaved={load} />

      {/* ── Import modal ──────────────────────────────────────────────────────── */}
      {stage !== 'idle' && (
        <div style={overlay} onClick={() => { if (!busy && stage !== 'importing') resetImport(); }}>
          <div style={modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{t('storereq.stockUploadModalTitle', 'Upload stock file')}</div>
            <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 14 }}>{fileName}</div>

            {busy && <div style={{ fontSize: 13, color: '#475569', padding: '18px 0' }}>{stage === 'uploading' ? t('storereq.stockArchiving', 'Archiving file to cloud…') : t('storereq.stockReadingSheets', 'Reading Sales & Purchase sheets…')}</div>}

            {stage === 'error' && (
              <div style={{ fontSize: 13, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 10, marginBottom: 12 }}>{err}</div>
            )}

            {stage === 'review' && parseResult && (
              <div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                  <Stat label={t('storereq.stockStatMonths', 'Months found')} value={parseResult.months.length} />
                  <Stat label={t('storereq.stockStatLatest', 'Latest month')} value={parseResult.latest!.periodKey} />
                  <Stat label={t('storereq.stockStatItems', 'Items (latest)')} value={parseResult.totalItems} />
                </div>
                <div style={{ fontSize: 12, color: '#475569', marginBottom: 10 }}>
                  {t('storereq.stockSeedNotePre', 'Register on-hand will be seeded from')} <strong>{parseResult.latest!.label}</strong>{t('storereq.stockSeedNotePost', "'s computed closing (opening + purchased − used). Existing snapshots for these months will be replaced.")}
                </div>
                <div style={{ marginBottom: 12 }}>
                  {/* A monthly workbook is a STORE's register, not a factory's.
                      The client keeps ONE "Store Keeping … Jharkhand" file for all
                      three Rehla factories, so asking which factory it belongs to
                      had no correct answer — and picking any one of them filed the
                      same stock under a single factory instead of the shared store. */}
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 }}>{t('storereq.stockStoreBelongs', 'Store this file belongs to')}</div>
                  <select value={importStore} onChange={e => setImportStore(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                    {storeOptions.length === 0 && <option value="">{t('storereq.stockNoStoreOpt', '(no store)')}</option>}
                    {storeOptions.map(st => <option key={st.id} value={st.id}>{displayLocationName(st.name)}</option>)}
                  </select>
                  {storeOptions.length === 0 ? (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px' }}>
                      {t('storereq.stockNoStoresConfigured', 'No stores configured yet. Refresh after admin seeds SCPL/SPPL store, Ganjam, Madan and Drum stores.')}
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#94A3B8' }}>
                      {t('storereq.stockStoreHint', 'Jharkhand workbook → SCPL/SPPL store. Ganjam, Madan and Drum Plant each have their own register.')}
                    </div>
                  )}
                </div>
                {importAnoms.length > 0 && (
                  <div style={{ fontSize: 12, color: '#B45309', background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 8, padding: 10, marginBottom: 12 }}>
                    {importAnoms.length === 1
                      ? t('storereq.stockImportAnomOne', { defaultValue: "⚠ {{n}} anomaly detected between the last two months in this file — you'll be able to review and fix them in the register after import.", n: importAnoms.length })
                      : t('storereq.stockImportAnomMany', { defaultValue: "⚠ {{n}} anomalies detected between the last two months in this file — you'll be able to review and fix them in the register after import.", n: importAnoms.length })}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={resetImport} style={btnGhost}>{t('storereq.stockCancel', 'Cancel')}</button>
                  <button onClick={confirmImport} style={{ ...btnPrimary, flex: 1 }}>{t('storereq.stockImportBtn', { defaultValue: 'Import {{n}} items', n: parseResult.totalItems })}</button>
                </div>
              </div>
            )}

            {stage === 'importing' && <div style={{ fontSize: 13, color: '#475569', padding: '18px 0' }}>{t('storereq.stockWriting', 'Writing register…')}</div>}

            {stage === 'done' && (
              <div>
                <div style={{ fontSize: 13, color: '#16A34A', marginBottom: clampedItems.length ? 10 : 14 }}>{t('storereq.stockImportedDone', { defaultValue: '✓ Imported {{n}} items into the register.', n: importedCount })}</div>
                {clampedItems.length > 0 && (
                  <div style={{ fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 10, marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {t('storereq.stockClampedTitle', {
                        defaultValue: '{{n}} item(s) showed less than zero in the sheet and were set to 0',
                        n: clampedItems.length,
                      })}
                    </div>
                    <div style={{ marginBottom: 6 }}>
                      {t('storereq.stockClampedBody', 'The sheet records more issued than was ever received, so the closing balance is impossible. Everything else imported normally. Please correct these rows in the workbook and upload again:')}
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {clampedItems.slice(0, 8).map(c => (
                        <li key={c.name}><strong>{c.name}</strong> — sheet says {c.closing}</li>
                      ))}
                    </ul>
                    {clampedItems.length > 8 && (
                      <div style={{ marginTop: 4 }}>{t('storereq.stockClampedMore', { defaultValue: '…and {{n}} more.', n: clampedItems.length - 8 })}</div>
                    )}
                  </div>
                )}
                <button onClick={resetImport} style={{ ...btnPrimary, width: '100%' }}>{t('storereq.stockDone', 'Done')}</button>
              </div>
            )}

            {stage === 'error' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={resetImport} style={{ ...btnGhost, flex: 1 }}>{t('storereq.stockClose', 'Close')}</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Manual edit modal ─────────────────────────────────────────────────── */}
      {editItem && (
        <div style={overlay} onClick={() => setEditItem(null)}>
          <div style={modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>{t('storereq.stockEditModalTitle', 'Edit stock item')}</div>
            <div style={{ marginBottom: 10 }}>
              <div style={label}>{t('storereq.stockFieldItemName', 'Item name')}</div>
              <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={label}>{t('storereq.col_equipment', 'Equipment')}</div>
                <input value={editForm.equipment} onChange={e => setEditForm(f => ({ ...f, equipment: e.target.value }))} style={{ ...inputStyle, width: '100%' }} placeholder={t('storereq.stockFieldEquipmentPh', 'e.g. same as item, or the machine this part fits')} />
              </div>
              <div style={{ width: 140 }}>
                <div style={label}>{t('storereq.stockFieldModel', 'Model')}</div>
                <input value={editForm.model} onChange={e => setEditForm(f => ({ ...f, model: e.target.value }))} style={{ ...inputStyle, width: '100%' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={label}>{t('storereq.stockFieldOnHand', 'On-hand quantity')}</div>
                <input type="number" value={editForm.onHand} onChange={e => setEditForm(f => ({ ...f, onHand: e.target.value }))} style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div style={{ width: 120 }}>
                <div style={label}>{t('storereq.field_unit', 'Unit')}</div>
                <select value={editForm.unit} onChange={e => setEditForm(f => ({ ...f, unit: e.target.value }))} style={{ ...inputStyle, width: '100%' }}>
                  {(UNIT_OPTIONS.includes(editForm.unit) ? UNIT_OPTIONS : [...UNIT_OPTIONS, editForm.unit])
                    .map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={label}>{t('storereq.stockFieldJustification', 'Justification (required)')}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 4 }}>{t('storereq.stockJustHint', 'Why is this changing? e.g. "physically counted", a ticket #, or a description.')}</div>
              <textarea value={editForm.reason} onChange={e => setEditForm(f => ({ ...f, reason: e.target.value }))} rows={3} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} placeholder={t('storereq.stockJustPh', 'e.g. Ticket #4b7bd471 — 4 issued to technician manually while system was down.')} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setEditItem(null)} style={btnGhost}>{t('storereq.stockCancel', 'Cancel')}</button>
              <button onClick={saveEdit} style={{ ...btnPrimary, flex: 1, opacity: editForm.reason.trim() ? 1 : 0.5 }} disabled={!editForm.reason.trim()}>{t('storereq.stockSaveLog', 'Save & log')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Admin delete modal ───────────────────────────────────────────────── */}
      {deleteItem && (
        <div style={overlay} onClick={() => { if (!deleting) { setDeleteItem(null); setDeleteReason(''); } }}>
          <div style={modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: '#DC2626' }}>{t('storereq.stockDeleteModalTitle', 'Delete stock item')}</div>
            <div style={{ fontSize: 13, color: '#475569', marginBottom: 12, lineHeight: 1.5 }}>
              {t('storereq.stockDeleteConfirm', {
                defaultValue: 'Remove "{{name}}" from the living register? On-hand {{qty}} {{unit}}. This cannot be undone. Monthly snapshots are kept for history.',
                name: deleteItem.item_name,
                qty: Number(deleteItem.on_hand),
                unit: normalizeUnit(deleteItem.unit),
              })}
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={label}>{t('storereq.stockFieldJustification', 'Justification (required)')}</div>
              <textarea
                value={deleteReason}
                onChange={e => setDeleteReason(e.target.value)}
                rows={3}
                style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
                placeholder={t('storereq.stockDeleteJustPh', 'e.g. Duplicate row / wrong item uploaded — removing from register.')}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setDeleteItem(null); setDeleteReason(''); }} disabled={deleting} style={btnGhost}>{t('storereq.stockCancel', 'Cancel')}</button>
              <button
                onClick={confirmDelete}
                disabled={deleting || !deleteReason.trim()}
                style={{ ...btnPrimary, flex: 1, background: '#DC2626', opacity: (deleting || !deleteReason.trim()) ? 0.5 : 1 }}
              >
                {deleting ? t('storereq.stockDeleting', 'Deleting…') : t('storereq.stockDeleteConfirmBtn', 'Delete & log')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 90, background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: '8px 12px' }}>
      <div style={{ fontSize: 10.5, color: '#94A3B8', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#334155', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modal: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, width: 'min(460px, 100%)', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 };
const btnPrimary: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#F47651', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
const btnGhost: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
