import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
// Shared humanizer — a user should never be shown a raw error object.
import { humanizeError as errMsg } from '../../../lib/errors';
import { fetchActivePlants } from '../../../lib/plants';
import { insertRows } from '../../../lib/db';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows } from '../../../components/ui/states';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../../components/v2';
import { useSortable } from '../../../components/ui/useSortable';
import { ThV2 as Th } from '../../../components/v2';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { useRoleContext } from '../../../contexts/RoleContext';
import { profileHasCapability } from '../../../lib/profiles';
import { withEmbedFallback } from '../../../lib/scopedList';
import { uploadWorkflowFile } from '../../../lib/cloudinary';
import { parseStockFile, reconcile, reconcileAll, labelForPeriod, normalizeUnit, UNIT_OPTIONS, type StockParseResult, type MonthParse, type MonthItem, type Anomaly } from '../../../lib/store/parseStockFile';
import { indexResolutions, joinAnomalies, type AnomalyResolutionRow, type ReviewedAnomaly } from '../../../lib/store/anomalyKeys';
import { registerIdOf } from '../../../lib/store/registers';
import { fetchAllRows } from '../../../lib/fetchAll';
import { createImportBatch, setImportBatchRowCount, buildItemOwnerMap, resolveItemOwner } from '../../../lib/imports/batches';
import { AddPurchaseModal } from './AddPurchaseModal';
import { AnomalyReviewModal } from './AnomalyReviewModal';
import { StoreReconciliation } from './StoreReconciliation';
import type { Database } from '../../../lib/database.types';

type StockItem = Database['public']['Tables']['store_items']['Row'];
type StockMonthRow = Database['public']['Tables']['store_stock_months']['Row'];
type Plant = { id: string; name: string };

interface StoreBreakdown { id: string; plantId: string | null; plant: string; onHand: number; issued: number; procured: number; repaired: number; raw: StockItem; }
interface MergedRow {
  key: string; itemName: string; equipment: string; model: string | null; unit: string;
  onHand: number; issued: number; procured: number; repaired: number; stores: StoreBreakdown[];
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

const inputStyle: React.CSSProperties = {
  border: '1px solid #E2E8F0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
};

export function StockRegister() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { storeQuery, allowedPlants, stores, allowedStores, storeIdFor } = usePlantScope();
  const { activeProfile } = useRoleContext();

  const [items, setItems] = useState<(StockItem & { plants?: { name: string | null } | null })[]>([]);
  const [months, setMonths] = useState<StockMonthRow[]>([]);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAnoms, setShowAnoms] = useState(false);
  const [showSettled, setShowSettled] = useState(false);   // resolved / false-positive rows
  const [resolutions, setResolutions] = useState<AnomalyResolutionRow[]>([]);
  const [reviewItem, setReviewItem] = useState<ReviewedAnomaly | null>(null);
  const [collapsed, setCollapsed] = useState(true);        // the 400+ row table is hidden until asked
  const [plantFilter, setPlantFilter] = useState<string[]>([]); // empty = all plants (merged)
  const [showPurchase, setShowPurchase] = useState(false);

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
  const [editForm, setEditForm] = useState({ name: '', onHand: '', unit: '', reason: '' });

  async function load() {
    try {
      const { data: pl } = await fetchActivePlants<Plant>('id, name');
      setPlants(pl || []);
      // STORE-scoped, not plant-scoped. Migration 60 stamps every Rehla row
      // with one anchor factory (SCPL – Rehla), so a plant filter showed the
      // shared register as empty to a keeper granted the store and the other
      // two factories — the exact case this screen exists for.
      const { data: si } = await withEmbedFallback(
        storeQuery(supabase.from('store_items').select('*, plants(name)')).order('item_name').returns<(StockItem & { plants?: { name: string | null } | null })[]>(),
        () => storeQuery(supabase.from('store_items').select('*')).order('item_name').returns<(StockItem & { plants?: { name: string | null } | null })[]>(),
        'StockRegister.items',
      );
      setItems(si || []);
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
    } catch (e) {
      console.error('[StockRegister] load failed', e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [storeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // (No plantOptions here: this screen is keyed on STORES, not factories — see
  // storeChips below. A factory list was left over from before the store split.)
  const plantName = (id: string | null) => plants.find(p => p.id === id)?.name || '—';

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
      const plant = pid === '—' ? undefined : (stores.find(s => s.id === pid)?.name ?? plantName(pid));
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
    for (const it of items) {
      const id = registerIdOf(it);
      if (!id) continue;
      const label = it.store_id
        ? (stores.find(s => s.id === it.store_id)?.name ?? t('storereq.store', 'Store'))
        : (it.plants?.name || plantName(it.plant_id));
      seen.set(id, label);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, plants, stores]); // eslint-disable-line react-hooks/exhaustive-deps

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
        .map(s => ({ id: s.id, name: s.name, hasData: withData.has(s.id) }))
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
  const merged = useMemo<MergedRow[]>(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, MergedRow>();
    for (const it of items) {
      const regId = registerIdOf(it);
      if (plantFilter.length && !(regId && plantFilter.includes(regId))) continue;
      if (q && !(it.item_name.toLowerCase().includes(q) || (it.equipment || '').toLowerCase().includes(q) || (it.model || '').toLowerCase().includes(q))) continue;
      const key = it.item_name.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
      const store = { id: it.id, plantId: it.plant_id, plant: (it.store_id ? stores.find(s => s.id === it.store_id)?.name : null) || it.plants?.name || plantName(it.plant_id), onHand: Number(it.on_hand), issued: Number(it.issued_qty), procured: Number(it.ticket_procured_qty || 0), repaired: Number(it.repaired_qty || 0), raw: it };
      const ex = map.get(key);
      if (ex) { ex.onHand += store.onHand; ex.issued += store.issued; ex.procured += store.procured; ex.repaired += store.repaired; ex.stores.push(store); }
      else map.set(key, { key, itemName: it.item_name, equipment: it.equipment || '', model: it.model, unit: it.unit || '', onHand: store.onHand, issued: store.issued, procured: store.procured, repaired: store.repaired, stores: [store] });
    }
    return [...map.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
  }, [items, plantFilter, search, plants, stores]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => {
    let inStock = 0, low = 0, out = 0;
    for (const m of merged) { const s = stockStatus(m.onHand); if (s.key === 'out') out++; else if (s.key === 'low') low++; else inStock++; }
    return { total: merged.length, inStock, low, out };
  }, [merged]);

  // Column sort — click a header to sort by it (toggles asc/desc).
  const mergedSort = useSortable(merged, {
    item: r => r.itemName,
    onHand: r => r.onHand,
    issued: r => r.issued,
    procured: r => r.procured,
    status: r => (r.onHand <= 0 ? 0 : r.onHand <= 2 ? 1 : 2),
  }, { key: 'item', dir: 'asc' });

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
    setEditItem(it);
    setEditForm({ name: it.item_name, onHand: String(it.on_hand), unit: normalizeUnit(it.unit), reason: '' });
  }

  async function saveEdit() {
    if (!editItem) return;
    const reason = editForm.reason.trim();
    if (!reason) { toast.error(t('storereq.stockToastNeedJust', 'A justification is required for any stock edit.')); return; }
    const oldOnHand = Number(editItem.on_hand);
    const newOnHand = parseFloat(editForm.onHand);
    const newName = editForm.name.trim() || editItem.item_name;
    const oldUnit = normalizeUnit(editItem.unit);
    const newUnit = normalizeUnit(editForm.unit);
    const nameChanged = newName !== editItem.item_name;
    const qtyChanged = !isNaN(newOnHand) && newOnHand !== oldOnHand;
    const unitChanged = newUnit !== oldUnit;
    if (!nameChanged && !qtyChanged && !unitChanged) { toast.error(t('storereq.stockToastNoChange', 'Nothing changed.')); return; }
    if (qtyChanged && newOnHand < 0) { toast.error(t('storereq.stockToastNegative', 'On-hand cannot be negative.')); return; }
    const delta = qtyChanged ? newOnHand - oldOnHand : 0;
    try {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (nameChanged) patch.item_name = newName;
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
        note: `${qtyChanged ? `Qty ${oldOnHand} → ${newOnHand} (${delta > 0 ? '+' : ''}${delta}). ` : ''}${nameChanged ? `Renamed from "${editItem.item_name}". ` : ''}${unitChanged ? `Unit ${oldUnit} → ${newUnit}. ` : ''}${reason}`,
      });
      setEditItem(null);
      toast.success(t('storereq.stockToastSaved', 'Stock updated and logged to the Activity Log.'));
      await load();
    } catch (e) {
      toast.error(errMsg(e, { action: 'save this stock change', context: 'StockRegister.saveEdit' }));
    }
  }

  const busy = stage === 'uploading' || stage === 'parsing';

  const multiStore = plantFilter.length !== 1 && plantsInData.length > 1;

  return (
    <div className="card2 p-6 mb-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div>
          <div className="text-base font-bold font-heading">{t('storereq.stockHeading', 'Stock register')}</div>
          <div className="text-xs text-slate-500">
            {t('storereq.stockSubtitle', 'On-hand seeded from the monthly Store Keeping file, adjusted live as parts are issued.')}
            {latestUpload ? ` · ${t('storereq.stockLatestMonth', { defaultValue: 'Latest month: {{month}}', month: latestUpload.slice(0, 7) })}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {items.length > 0 && profileHasCapability(activeProfile, 'add_stock_purchase') && (
            <button onClick={() => setShowPurchase(true)} className="pill px-4 py-2 font-semibold text-sm" style={{ border: '1px solid #E2E8F0', background: '#fff', color: '#334155', cursor: 'pointer' }}>{t('storereq.stockAddPurchase', '＋ Add Purchase')}</button>
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
          <button onClick={() => fileRef.current?.click()} className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm">{t('storereq.stockUploadExcel', '↑ Upload Excel')}</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
        </div>
      </div>

      {loading ? <SkeletonRows rows={4} /> : items.length === 0 ? (
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
          {t('storereq.stockEmptyTitle', 'No stock file uploaded yet.')}<br />{t('storereq.stockEmptyBodyPre', 'Upload the monthly')} <strong>{t('storereq.stockEmptyBodyStrong', 'Store Keeping')}</strong> {t('storereq.stockEmptyBodyPost', 'Excel to seed the register.')}
        </div>
      ) : (
        <>
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

              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('storereq.stockSearchPh', 'Search item / equipment…')} style={{ ...inputStyle, width: '100%', marginBottom: 12 }} />

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

              <div className="overflow-x-auto scroll-x">
                <table className="dt2">
                  <thead>
                    <tr>
                      <Th sortKey="item" s={mergedSort}>{t('storereq.col_item', 'Item')}</Th><th>{t('storereq.col_equipment', 'Equipment')}</th>{multiStore && <th>{t('storereq.stockColStores', 'Stores')}</th>}<th>{t('storereq.field_unit', 'Unit')}</th>
                      <Th sortKey="onHand" s={mergedSort} firstDir="desc" className="num">{t('storereq.stockColOnHand', 'On-hand')}</Th>
                      <Th sortKey="issued" s={mergedSort} firstDir="desc" className="num">{t('storereq.stockColIssued', 'Issued')}</Th>
                      <Th sortKey="procured" s={mergedSort} firstDir="desc" className="num">{t('storereq.stockColProcured', 'Procured')}</Th>
                      <Th sortKey="status" s={mergedSort} firstDir="desc">{t('storereq.col_status', 'Status')}</Th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergedSort.sorted.length === 0 && <tr><td colSpan={multiStore ? 9 : 8} className="text-center text-slate-400 py-6 text-sm">{t('storereq.stockNoItemsMatch', 'No items match.')}</td></tr>}
                    {pageRows.map(m => {
                      const st = stockStatus(m.onHand);
                      const isOpen = expanded === m.key;
                      const single = m.stores.length === 1;
                      return (
                        <React.Fragment key={m.key}>
                          <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(isOpen ? null : m.key)}>
                            <td className="font-semibold text-slate-700">{m.itemName}</td>
                            <td className="text-slate-500 text-xs">{m.equipment}{m.model ? ` · ${m.model}` : ''}</td>
                            {multiStore && <td className="text-slate-500 text-xs">{single ? m.stores[0].plant : t('storereq.stockStoresCount', { defaultValue: '{{n}} stores', n: m.stores.length })}</td>}
                            <td className="text-slate-500 text-xs">{m.unit}</td>
                            <td className="num font-bold" style={{ color: st.color }}
                              title={m.repaired > 0 ? t('storereq.stockOnHandTooltip', { defaultValue: 'New: {{fresh}} · Repaired: {{repaired}} · Total: {{total}}', fresh: m.onHand - m.repaired, repaired: m.repaired, total: m.onHand }) : undefined}>
                              {m.onHand}{m.repaired > 0 && <span aria-label={`includes ${m.repaired} repaired unit(s)`} style={{ color: '#7C3AED' }}>*</span>}
                            </td>
                            <td className="num" style={{ color: m.issued > 0 ? '#2563EB' : '#CBD5E1' }}>{m.issued || '—'}</td>
                            <td className="num" style={{ color: m.procured > 0 ? '#7C3AED' : '#CBD5E1' }}>{m.procured || '—'}</td>
                            <td><span className="badge" style={{ background: st.bg, color: st.color, fontWeight: 700 }}>{t(STATUS_LABEL_KEYS[st.key], st.label)}</span></td>
                            <td>{single ? <button onClick={e => { e.stopPropagation(); openEdit(m.stores[0].raw); }} className="text-xs" style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>{t('storereq.stockEdit', 'Edit')}</button> : <span className="text-xs text-slate-400">▾</span>}</td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={multiStore ? 9 : 8} style={{ background: '#F8FAFC', padding: '8px 12px' }}>
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
                                    <button onClick={e => { e.stopPropagation(); openEdit(s.raw); }} style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5 }}>{t('storereq.stockEdit', 'Edit')}</button>
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
                    {storeOptions.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                  </select>
                  {storeOptions.length === 0 ? (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px' }}>
                      {t('storereq.stockNoStoresConfigured', 'No stores configured yet. Refresh after admin seeds Rehla / Ganjam / Sikandrabad / Drum stores.')}
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#94A3B8' }}>
                      {t('storereq.stockStoreHint', 'Jharkhand workbook → Rehla Common Store. Ganjam, Sikandrabad and Drum Plant each have their own register.')}
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
