import React, { useState, useEffect, useMemo, useRef } from 'react';
import { formatDateTime, istDayKey, istFyStartYear, istToday } from '../../../lib/utils/formatting';
import { canEditModule, useOpsSettings } from '../../../lib/opsControls';
import { displayLocationName } from '../../../lib/plantLabels';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { fetchActivePlants } from '../../../lib/plants';
// Shared humanizer — a user must never be shown a raw error object.
import { humanizeError as errMsg } from '../../../lib/errors';
import { insertRows, updateRows } from '../../../lib/db';
import { useRoleContext } from '../../../contexts/RoleContext';
import { ImageLightbox, type LightboxImage } from '../../../components/ui/ImageLightbox';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelRow, PanelDivider, OcrUpload, PanelFooter, PanelDateInput } from '../../../components/SlidePanel';
import { KpiInfoButton } from '../../../components/KpiInfoButton';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, ErrorState } from '../../../components/ui/states';
import { usePagination } from '../../../components/ui/usePagination';
import { useSortable } from '../../../components/ui/useSortable';
import { StatCard, SectionCard, ButtonV2, SegmentTabs, TablePaginationV2, ThV2 as Th, FilterBar, FilterSelect } from '../../../components/v2';
import { Boxes, Wrench, Camera, Download, Upload, Plus, Building2 } from 'lucide-react';
import { useUrlTable } from '../../../lib/urlTable';
import { hereNow } from '../../../lib/backLink';
import { useUrlFilters } from '../../../lib/urlFilters';
import { exportToCsv, type CsvColumn } from '../../../lib/utils/exportCsv';
import { uploadWorkflowFile, uploadWorkflowImage } from '../../../lib/cloudinary';
import * as XLSX from 'xlsx';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { withEmbedFallback } from '../../../lib/scopedList';
import { groupAssetsByType, expandFarUnits, normMark, matchAsset } from '../../../lib/far/assets';
import { assignSequentialJobNos, allocateNextJobNos, jobNoFar, nextJobNo } from '../../../lib/jobNo';
import { ticketNoLabel } from '../../../lib/ticketNo';
import { statusText } from './maintenance/statusText';
import { normalizeAssetDate } from '../../../lib/far/dates';
import { createImportBatch, setImportBatchRowCount } from '../../../lib/imports/batches';
import type { Database } from '../../../lib/database.types';
import { fetchAllRows, fetchByIds } from '../../../lib/fetchAll';
import { useRights } from '../../../lib/access/useRights';

// ── FAR bulk-import (CSV / Excel → verify → register) ─────────────────────────
interface FarImportRow {
  name: string; mark: string; make: string; serial: string; quantity: string;
  model: string; capacity: string; origin: string;
  year: string; value: string; invoice: string; purchaseDate: string; account: string;
}
const BLANK_FAR_ROW = (): FarImportRow => ({ name: '', mark: '', make: '', serial: '', quantity: '', model: '', capacity: '', origin: '', year: '', value: '', invoice: '', purchaseDate: '', account: '' });
// Order matters — more specific keys first so "Name Of Equipments" ≠ "Identification Mark".
const FAR_HEADER_MAP: { field: keyof FarImportRow; keys: string[] }[] = [
  { field: 'name',         keys: ['name of equip', 'equipment name', 'name of', 'equipment', 'asset name', 'particular', 'description', 'item'] },
  { field: 'mark',         keys: ['identification mark', 'identification', 'id mark', 'mark', 'tag no', 'tag'] },
  { field: 'make',         keys: ['make', 'manufacturer', 'brand'] },
  { field: 'serial',       keys: ['serial'] },
  { field: 'quantity',     keys: ['quantity', 'qty'] },
  { field: 'model',        keys: ['model'] },
  { field: 'capacity',     keys: ['capacity', 'line size', 'size', 'spec'] },
  { field: 'origin',       keys: ['origin', 'country'] },
  { field: 'year',         keys: ['year'] },
  { field: 'value',        keys: ['taxable value', 'value', 'amount', 'cost', 'wdv', 'gross'] },
  { field: 'invoice',      keys: ['invoice'] },
  { field: 'purchaseDate', keys: ['date of purchase', 'purchase date', 'dop'] },
  { field: 'account',      keys: ['account head', 'account', 'category', 'head', 'block'] },
];
function mapHeader(h: string): keyof FarImportRow | null {
  const k = (h || '').toLowerCase().trim();
  if (!k) return null;
  for (const m of FAR_HEADER_MAP) if (m.keys.some(x => k.includes(x))) return m.field;
  return null;
}
async function parseFarFile(file: File): Promise<FarImportRow[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // The client sheet has junk title rows above the real header, so detect the
  // header row (the one with an equipment-name / identification column) rather
  // than assuming row 1.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', blankrows: false });
  const hi = rows.findIndex(r => Array.isArray(r) && r.some(c => typeof c === 'string' && /name of equip|identification|equipment name|asset name|particular/i.test(c)));
  if (hi < 0) return [];
  const cols = (rows[hi] as unknown[]).map(c => mapHeader(c == null ? '' : String(c)));
  const out: FarImportRow[] = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] as unknown[];
    if (!Array.isArray(r)) continue;
    const row = BLANK_FAR_ROW();
    cols.forEach((f, ci) => { if (f && row[f] === '') { const v = r[ci]; row[f] = v == null ? '' : String(v).trim(); } });
    if (row.name || row.mark || row.value) out.push(row);
  }
  return out;
}
const IMPORT_CSV_COLUMNS: CsvColumn[] = [
  { header: 'Identification mark', key: 'mark' }, { header: 'Model', key: 'model' },
  { header: 'Capacity', key: 'capacity' }, { header: 'Origin', key: 'origin' },
  { header: 'Year', key: 'year' }, { header: 'Taxable value', key: 'value' },
  { header: 'Invoice no', key: 'invoice' }, { header: 'Date of purchase', key: 'purchaseDate' },
  { header: 'Account head', key: 'account' },
];

type AssetRow = Database['public']['Tables']['fixed_assets']['Row'] & { plants?: { name: string | null } | null };
type MaintTicketRow = Database['public']['Tables']['maintenance_tickets']['Row'] & { plants?: { name: string | null } | null };
type MaintStoreReqRow = Database['public']['Tables']['maintenance_store_requests']['Row'];
type MaintTicketLite = { ticket_no?: string | null } & Pick<MaintTicketRow, 'id' | 'plant_id' | 'equipment' | 'status' | 'created_at' | 'closed_at' | 'pm_bill_total' | 'pm_bill_url' | 'far_asset_id' | 'plants'>;
type MaintStoreReqLite = Pick<MaintStoreReqRow, 'ticket_id' | 'part_name' | 'quantity' | 'store_decision' | 'purchase_required' | 'total_price' | 'busy_transaction_ref'>;

/** A single repair/maintenance done — the unit of the annual FAR cost register. */
interface MaintEntry {
  id: string;
  equipment: string;
  plant: string;
  part: string;
  cost: number;
  procuredQty: number;
  billUrl: string | null;
  status: string;
  created_at: string;
  closed_at: string | null;
  busyRef: string | null;
  fy: string;
  /** FAR asset this repair was logged against, when the ticket was linked. */
  farAssetId: string | null;
  /** Human ticket number (STK0042) — never show the UUID. */
  ticketNo: string;
  plantId: string | null;
}

/** Indian financial year (Apr–Mar) label for a date, e.g. "FY2025-26". */
function fyOf(d: string | null | undefined): string {
  if (!d) return 'Unknown';
  // The IST day decides the year: a ticket closed at 01:00 IST on 1 April is
  // the new FY even though it is still 31 March in UTC.
  if (!istDayKey(d)) return 'Unknown';
  const start = istFyStartYear(d);
  return `FY${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function fmtDT(d: string | null | undefined): string {
  return d ? formatDateTime(d) : '—';
}
function inr(n: number): string { return `₹ ${Math.round(n).toLocaleString('en-IN')}`; }

const MAINT_CSV_COLUMNS: CsvColumn[] = [
  { header: 'Ticket #', key: 'ticket' },
  { header: 'Equipment', key: 'equipment' },
  { header: 'Plant', key: 'plant' },
  { header: 'Part / type', key: 'part' },
  { header: 'Status', key: 'status' },
  { header: 'Raised at', key: 'created' },
  { header: 'Closed at', key: 'closed' },
  { header: 'BUSY ref', key: 'busy' },
  { header: 'Cost (INR)', key: 'cost' },
];

/**
 * PIC cell — camera badge per asset. No photo yet (gray) → click opens the
 * file/camera picker and uploads the machine photo (Cloudinary → photo_url).
 * Photo on file (green) → click opens it in the lightbox. The same photo_url
 * feeds the Asset Profile header (QR landing), which shows the image instead
 * of the default 🏭 icon once one exists.
 */
function PicCell({ asset, onUpload, onView }: {
  asset: AssetRow;
  onUpload: (asset: AssetRow, file: File) => Promise<void>;
  onView: (asset: AssetRow) => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const has = !!asset.photo_url;

  return (
    <>
      <button
        type="button"
        className={`pic-badge${has ? '' : ' missing'}`}
        title={busy ? t('far.uploading', 'Uploading…') : has ? `${t('far.picOnFile')} — ${t('far.clickToView', 'click to view')}` : `${t('far.noPicYet')} — ${t('far.clickToAddPhoto', 'click to add a photo')}`}
        disabled={busy}
        onClick={() => (has ? onView(asset) : inputRef.current?.click())}
        style={{ cursor: busy ? 'wait' : 'pointer', border: 'none', padding: 0, opacity: busy ? 0.5 : 1 }}
      >
        {busy ? (
          <span className="inline-block w-3 h-3 rounded-full border-2 border-slate-300 border-t-slate-500 animate-spin" />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        )}
      </button>
      <input
        ref={inputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
        onChange={async e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          try { await onUpload(asset, f); } finally { setBusy(false); }
        }}
      />
    </>
  );
}

/** Per-group expanded asset list — extracted so it can own its own sort state
 *  (hooks can't run inside the group .map()). */
function AssetDetailTable({ assets, jobMap, showPlant, maintByAsset, onUploadPic, onViewPic, onOpenMaint, onRaise }: {
  assets: AssetRow[];
  jobMap: Map<string, string>;
  showPlant: boolean;
  maintByAsset: Map<string, MaintEntry[]>;
  onUploadPic: (asset: AssetRow, file: File) => Promise<void>;
  onViewPic: (asset: AssetRow) => void;
  onOpenMaint: (asset: AssetRow, entries: MaintEntry[]) => void;
  onRaise: (asset: AssetRow) => void;
}) {
  const { t } = useTranslation();
  const s = useSortable(assets, {
    job: a => jobMap.get(a.id) || jobNoFar(a.id, a.identification_mark, a.job_no),
    mark: a => a.identification_mark,
    make: a => a.make,
    serial: a => a.serial_no,
    model: a => a.model,
    capacity: a => a.capacity,
    year: a => a.year,
    value: a => (a.value == null ? null : Number(a.value)),
    plant: a => a.plants?.name ?? null,
    repairs: a => (maintByAsset.get(a.id)?.length ?? 0),
  });
  return (
    <div className="overflow-x-auto scroll-x">
      <table className="dt2" style={{ margin: 0 }}>
        <thead><tr><Th sortKey="job" s={s}>{t('far.thJobNo', 'Job No')}</Th><Th sortKey="mark" s={s}>{t('far.thMark', 'Mark')}</Th><Th sortKey="make" s={s}>{t('far.thMake', 'Make')}</Th><Th sortKey="serial" s={s}>{t('far.thSerial', 'Serial')}</Th><Th sortKey="model" s={s}>{t('far.thModel')}</Th><Th sortKey="capacity" s={s} className="num">{t('far.thCapacity')}</Th><Th sortKey="year" s={s} firstDir="desc" className="num">{t('far.thYear')}</Th><Th sortKey="value" s={s} firstDir="desc" className="num">{t('far.thValue', 'Value')}</Th>{showPlant && <Th sortKey="plant" s={s}>{t('far.rowPlant')}</Th>}<Th sortKey="repairs" s={s} firstDir="desc" className="num">{t('far.thRepairs', 'Repairs')}</Th><th>{t('far.thPic')}</th><th></th></tr></thead>
        <tbody>
          {s.sorted.map(a => {
            const repairs = maintByAsset.get(a.id) ?? [];
            const openRepairs = repairs.filter(e => e.status !== 'closed').length;
            return (
            <tr key={`${a.id}::${a.identification_mark || ''}`}>
              <td className="font-mono text-xs font-semibold text-slate-700">{jobMap.get(a.id) || jobNoFar(a.id, a.identification_mark, a.job_no)}</td>
              <td className="text-slate-500 text-xs">{a.identification_mark || '—'}</td>
              <td className="text-slate-500 text-xs">{a.make || '—'}</td>
              <td className="text-slate-500 text-xs">{a.serial_no || '—'}</td>
              <td className="text-slate-500 text-xs">{a.model || '—'}</td>
              <td className="num text-xs">{a.capacity || '—'}</td>
              <td className="num text-xs">{a.year || '—'}</td>
              <td className="num text-xs font-semibold">{a.value ? `₹ ${Number(a.value).toLocaleString('en-IN')}` : '—'}</td>
              {showPlant && <td className="text-slate-500 text-xs">{displayLocationName(a.plants?.name) || '—'}</td>}
              <td className="num">
                {repairs.length === 0 ? (
                  <span className="text-slate-300 text-xs">—</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenMaint(a, repairs)}
                    title={t('far.viewAssetMaint', 'View maintenance history for this asset')}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ border: 'none', cursor: 'pointer', background: openRepairs ? '#FEF3C7' : '#EEF2FF', color: openRepairs ? '#B45309' : '#4338CA' }}
                  >
                    <Wrench size={11} />
                    {repairs.length}{openRepairs ? ` · ${t('far.nOpen', { defaultValue: '{{n}} open', n: openRepairs })}` : ''}
                  </button>
                )}
              </td>
              <td><PicCell asset={a} onUpload={onUploadPic} onView={onViewPic} /></td>
              <td>
                <button
                  type="button"
                  onClick={() => onRaise(a)}
                  className="text-[11px] font-semibold text-blue-600"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
                >{t('far.raiseTicket', 'Raise ticket')}</button>
              </td>
            </tr>
          );
          })}
        </tbody>
      </table>
    </div>
  );
}

const ACCOUNT_HEADS = ['Plant & Machinery', 'Electrical Equipment', 'Vehicles', 'Furniture & Fixtures', 'Computer & Peripherals', 'Office Equipment'];

export function FAR() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  /** Return path for anything opened from FAR: Maintenance navigates here when its panel closes. */
  // Live URL: page / group / register state is written with replace.
  const backHere = () => `back=${encodeURIComponent(hereNow())}`;
  const statusLabel = (status: string) => statusText(status, t);
  const { activeProfile, activePersonId } = useRoleContext();
  // User Management → Add / Edit / Delete ticks.
  const rights = useRights();
  const { scopeQuery, allowedPlants, ready: scopeReady } = usePlantScope();
  // Machine-photo lightbox (PIC column → view).
  const [picView, setPicView] = useState<LightboxImage[] | null>(null);

  /** PIC column upload: Cloudinary → fixed_assets.photo_url → local state.
   *  The same photo then appears on the Asset Profile (QR landing) header. */
  // Access & backup → "Who can edit or delete" (FAR): once saved, only ticked
  // roles / people change an asset's photo. Admin always can.
  const opsTicks = useOpsSettings();
  const canEditFar = canEditModule(opsTicks, activeProfile, 'far', activePersonId);
  async function handleAssetPicUpload(asset: AssetRow, file: File) {
    if (!canEditFar) {
      toast.error(t('far.editForbidden', 'Your role is not allowed to edit FAR assets (Access & backup).'));
      return;
    }
    try {
      const up = await uploadWorkflowImage(file, {
        workflow: 'general', subfolder: 'far-assets', kind: 'asset-pic',
        entityId: asset.id, plant: asset.plants?.name ?? undefined, creator: activeProfile.name,
      });
      const { error } = await updateRows('fixed_assets', { photo_url: up.secure_url }).eq('id', asset.id);
      if (error) throw error;
      setAssets(prev => prev.map(x => x.id === asset.id ? { ...x, photo_url: up.secure_url } : x));
      toast.success(t('far.machinePhotoSaved', 'Machine photo saved'));
    } catch (e) {
      toast.error(t('far.photoUploadFailed', { defaultValue: 'Photo upload failed: {{message}}', message: e instanceof Error ? e.message : String(e) }));
    }
  }
  function handleAssetPicView(asset: AssetRow) {
    if (!asset.photo_url) return;
    setPicView([{ url: asset.photo_url, label: `${asset.name}${asset.identification_mark ? ` · ${asset.identification_mark}` : ''}` }]);
  }
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  // Which group is open and whether the register is shown also live in the URL
  // (?grp= ?reg=): raising / opening a ticket from an asset and closing it came
  // back to a hidden register on page 1.
  const viewState = useUrlFilters(['grp', 'reg'] as const);
  const expandedType = viewState.values.grp || null;
  const setExpandedType = (grp: string | null) => viewState.set({ grp: grp ?? '' });
  // Filters live in the URL (q, plant, pic, rstatus, fy) — refresh / back= keep them.
  const filters = useUrlFilters(['q', 'plant', 'pic', 'rstatus', 'fy'] as const);
  const { q: equipSearch, plant: farPlant, pic: picFilter, rstatus: repairStatus, fy: fyParam } = filters.values;
  const equipPlantFilter = useMemo(() => (farPlant ? [farPlant] : []), [farPlant]);
  // The big list is hidden until asked. null = automatic: a register filter
  // (search / photo) opens it — filtering a hidden list helps no one.
  const equipOpenTable = viewState.values.reg === '1' ? true : viewState.values.reg === '0' ? false : null;
  const setEquipOpenTable = (v: boolean | null | ((cur: boolean | null) => boolean | null)) => {
    const next = typeof v === 'function' ? v(equipOpenTable) : v;
    viewState.set({ reg: next == null ? '' : next ? '1' : '0' });
  };
  const registerOpen = equipOpenTable ?? (!!equipSearch || !!picFilter);
  // Plant filter options: only factories this user can access.
  const filterPlants = useMemo(
    () => [...plantsForPicker(allowedPlants, scopeReady)].sort((a, b) => a.name.localeCompare(b.name)),
    [allowedPlants, scopeReady],
  );
  const [dbPlants, setDbPlants] = useState<{ id: string; name: string }[]>([]);
  // The ONE factory this FAR belongs to. Formerly a multi-select that
  // flat-mapped every parsed row across each chosen factory — "sharing" a FAR
  // by physically copying it. That is how the live database ended up with the
  // same 324 assets under two plants, double-counting asset value and making
  // per-factory FAR reporting impossible. An asset sits in exactly one
  // register; the client's requirement is "FAR different for all 3".
  const [importPlantId, setImportPlantId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  // The first page paints the table; totals wait for every page (no 1000 / partial % shown as final).
  const [assetsComplete, setAssetsComplete] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Maintenance/repair cost register (annual, for insurance)
  const [maintEntries, setMaintEntries] = useState<MaintEntry[]>([]);
  const [maintLoading, setMaintLoading] = useState(true);
  const farMaintRef = useRef<HTMLDivElement>(null);
  const farRegisterRef = useRef<HTMLDivElement>(null);
  const [drillEntry, setDrillEntry] = useState<MaintEntry | null>(null);
  // Per-asset maintenance history panel (opened from the Repairs column).
  const [assetMaint, setAssetMaint] = useState<{ asset: AssetRow; entries: MaintEntry[] } | null>(null);
  // Bulk import accordion
  const [importOpen, setImportOpen] = useState(false);
  const [importStage, setImportStage] = useState<'idle' | 'uploading' | 'parsing' | 'review' | 'importing' | 'done' | 'error'>('idle');
  const [parsedRows, setParsedRows] = useState<FarImportRow[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const today = istToday();
  const [form, setForm] = useState({
    mark: '', model: '', capacity: '', origin: 'India',
    year: istToday().slice(0, 4),
    value: '', invoice: '', purchaseDate: today,
    account: 'Plant & Machinery', plant: '',
  });

  // Register columns the screen reads — not *; the QR audit / import-batch
  // fields stay off the wire. The fallback (no plants embed) keeps * as before.
  const ASSET_COLS = 'id, plant_id, name, identification_mark, job_no, make, serial_no, quantity, model, capacity, origin, year, value, invoice_no, purchase_date, account_head, photo_url, qr_token, created_at';

  async function load() {
    try {
      // The register paints as soon as its first page is in (all 1158+ rows still
      // arrive); repair costs load afterwards in loadMaintCosts() and never hold
      // the register back.
      const [{ data: plantsData }, { data, error }] = await Promise.all([
        fetchActivePlants<{ id: string; name: string }>('id, name'),
        withEmbedFallback(
          fetchAllRows<AssetRow>((from, to) =>
            scopeQuery(supabase.from('fixed_assets').select(`${ASSET_COLS}, plants(name)`)).order('created_at', { ascending: false }).order('id').range(from, to).returns<AssetRow[]>(),
            { onPartial: rows => { setAssets(rows); setLoading(false); setAssetsComplete(false); } }),
          () => fetchAllRows<AssetRow>((from, to) =>
            scopeQuery(supabase.from('fixed_assets').select('*')).order('created_at', { ascending: false }).order('id').range(from, to).returns<AssetRow[]>()),
          'FAR.assets',
        ),
      ]);
      if (plantsData && plantsData.length > 0) setDbPlants(plantsData);
      if (error) throw error;
      setAssets(data || []);
      setAssetsComplete(true);
      setLoadError(false);
      // Display codes come from assignSequentialJobNos / jobNoFar. Do not write
      // job_no just because the register opened — that used to RPC next_job_no
      // for every asset missing a code.
    } catch (err) {
      console.error('[FAR] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
    void loadMaintCosts();
  }

  /** Maintenance/repair cost register — emergency tickets + their part costs.
   *  Background: the KPI "Repair flagged" and the FY table show … until it lands. */
  async function loadMaintCosts() {
    try {
      const { data: tickets } = await supabase.from('maintenance_tickets')
        .select('id, ticket_no, plant_id, equipment, status, created_at, closed_at, pm_bill_total, pm_bill_url, far_asset_id, plants(name)')
        .eq('type', 'emergency')
        .order('created_at', { ascending: false }).returns<MaintTicketLite[]>();
      const ids = (tickets || []).map((tk) => tk.id);
      // Chunked: one GET with every emergency ticket id grows with the register.
      const { data: srs } = ids.length
        ? await fetchByIds<MaintStoreReqLite>(ids, c => supabase.from('maintenance_store_requests')
          .select('ticket_id, part_name, quantity, store_decision, purchase_required, total_price, busy_transaction_ref')
          .in('ticket_id', c).returns<MaintStoreReqLite[]>())
        : { data: [] as MaintStoreReqLite[] };
      const srByTicket = new Map<string, MaintStoreReqLite[]>();
      srs.forEach((s) => { if (!s.ticket_id) return; const arr = srByTicket.get(s.ticket_id); if (arr) arr.push(s); else srByTicket.set(s.ticket_id, [s]); });
      const entries: MaintEntry[] = (tickets || []).map((tk) => {
        const rows = srByTicket.get(tk.id) ?? [];
        const primary = rows[0];
        const procuredRows = rows.filter(r => r.store_decision === 'unavailable' || r.purchase_required);
        const procuredQty = procuredRows.reduce((n, r) => n + (Number(r.quantity) || 0), 0);
        // Cost = the Purchase Manager's aggregate bill for this ticket, else any per-row prices.
        const rowCost = rows.reduce((n, r) => n + (Number(r.total_price) || 0), 0);
        const cost = Number(tk.pm_bill_total) || rowCost || 0;
        const when = tk.closed_at || tk.created_at;
        return {
          id: tk.id,
          equipment: tk.equipment,
          plant: tk.plants?.name || '—',
          plantId: tk.plant_id ?? null,
          part: primary?.part_name || t('far.inHouseRepair', 'In-house repair'),
          cost,
          procuredQty,
          billUrl: tk.pm_bill_url ?? null,
          status: tk.status,
          created_at: tk.created_at,
          closed_at: tk.closed_at,
          busyRef: procuredRows[0]?.busy_transaction_ref ?? primary?.busy_transaction_ref ?? null,
          fy: fyOf(when),
          farAssetId: tk.far_asset_id ?? null,
          ticketNo: ticketNoLabel(tk),
        };
      });
      setMaintEntries(entries);
    } catch (err) {
      console.error('[FAR] repair costs failed', err);
    } finally {
      setMaintLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Factory options come from the DB — never a hard-coded list, which a rename
  // would leave stale. The form stores the plant ID, not the display name.
  const plantOptions = useMemo(
    () => {
      // The fallback to every factory is ONLY for the moment before scope has
      // resolved, so the picker isn't briefly blank. Once it HAS resolved, an
      // empty allowedPlants means the user genuinely has no factory access —
      // and offering them the full list would let them pick a factory they
      // cannot write to. The insert is then rejected by RLS (plant_in_scope)
      // and they get a database error instead of being told they lack access.
      const src = plantsForPicker(allowedPlants, scopeReady);
      return [...src].sort((a, b) => a.name.localeCompare(b.name));
    },
    [allowedPlants, scopeReady],
  );

  // Plants present in the FAR. Used ONLY for the "does this factory have any
  // assets yet" hint — never as the source of the selector, see plantChips.
  const plantsInFar = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of assets) if (a.plant_id) seen.set(a.plant_id, a.plants?.name || a.plant_id);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [assets]);

  /**
   * The factory selector.
   *
   * Sourced from the factories the user may SEE, not from the factories that
   * happen to have assets. Those are different sets, and keying the control on
   * the data is what produced the reported bug: with one factory's FAR uploaded
   * the control vanished entirely, so the screen never said whose assets these
   * were — and an empty register said nothing at all.
   *
   * Now it always renders. A factory with no assets yet is still listed, and
   * marked, which also tells an admin at a glance which registers are missing.
   */
  const plantChips = useMemo(() => {
    const withData = new Set(plantsInFar.map(p => p.id));
    return plantOptions.map(p => ({ id: p.id, name: p.name, hasData: withData.has(p.id) }));
  }, [plantOptions, plantsInFar]);

  /**
   * Rows whose Date of Purchase cell could not be read.
   *
   * Surfaced at the REVIEW step, before anything is written, because the
   * alternative is what actually happened to the client: one typo'd cell
   * ("03.07.20223") made Postgres reject the whole insert with
   * `22009 invalid_time_zone_displacement_value`, and all 210 assets were lost
   * behind an error nobody could act on. The import now proceeds with the date
   * left blank — one empty field beats losing the file — but it says exactly
   * which cells to fix and what they currently contain.
   */
  const unreadableDates = useMemo(
    () => parsedRows
      .map((r, i) => ({ row: i + 1, name: r.name || r.mark || r.model || '—', raw: r.purchaseDate.trim() }))
      .filter(x => x.raw !== '' && normalizeAssetDate(x.raw) === null),
    [parsedRows],
  );

  /** What the header says this register belongs to — one factory by name, or how
   *  many are combined. Never blank. */
  const activePlantLabel = useMemo(() => {
    if (equipPlantFilter.length === 1) {
      return plantChips.find(p => p.id === equipPlantFilter[0])?.name ?? null;
    }
    if (equipPlantFilter.length > 1) {
      return t('far.nPlantsSelected', {
        defaultValue: '{{sel}} of {{total}} factories',
        sel: equipPlantFilter.length, total: plantChips.length,
      });
    }
    if (plantChips.length === 1) return plantChips[0].name;
    if (plantChips.length > 1) {
      return t('far.nPlants', { defaultValue: '{{count}} plants', count: plantChips.length });
    }
    return null;
  }, [equipPlantFilter, plantChips, t]);

  const jobMap = useMemo(() => assignSequentialJobNos(assets, 'FAR'), [assets]);

  function raiseTicketForAsset(asset: AssetRow) {
    const mark = asset.identification_mark ? ` (${asset.identification_mark})` : '';
    navigate(`/dashboard/purchase/maint?raise=1&far=${asset.id}&equip=${encodeURIComponent(`${asset.name}${mark}`)}&plant=${asset.plant_id || ''}&${backHere()}`);
  }

  // Equipment List — a derived, grouped view of the FAR (the PM master).
  const equipGroups = useMemo(() => {
    const q = equipSearch.trim().toLowerCase();
    let filtered = expandFarUnits(assets);
    if (equipPlantFilter.length) filtered = filtered.filter(a => a.plant_id && equipPlantFilter.includes(a.plant_id));
    if (picFilter === 'missing') filtered = filtered.filter(a => !a.photo_url);
    if (picFilter === 'has') filtered = filtered.filter(a => !!a.photo_url);
    if (q) filtered = filtered.filter(a => (a.name || '').toLowerCase().includes(q) || normMark(a.identification_mark).includes(normMark(q)) || (jobMap.get(a.id) || jobNoFar(a.id, a.identification_mark, a.job_no)).toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
    return groupAssetsByType(filtered);
  }, [assets, equipSearch, equipPlantFilter, picFilter, jobMap]);
  // Page / size / sort of both lists in the URL (register: ?gp= ?gsort=, cost register: ?mp= ?msort=).
  const groupUrl = useUrlTable({ key: 'type', dir: 'asc' }, 'g');
  const fyUrl = useUrlTable({ key: 'closed', dir: 'desc' }, 'm');
  const groupSort = useSortable(equipGroups, {
    type: g => g.type,
    count: g => g.count,
    job: g => g.assets
      .map(a => jobMap.get(a.id) || jobNoFar(a.id, a.identification_mark, a.job_no))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] || '',
  }, groupUrl.sort, groupUrl.onSort);
  // Representative (most common non-empty) value for a group column.
  const repVal = (vals: (string | number | null)[]) => {
    const counts = new Map<string, number>();
    for (const v of vals) { const s = v == null ? '' : String(v).trim(); if (s) counts.set(s, (counts.get(s) || 0) + 1); }
    if (!counts.size) return { text: '—', mixed: false };
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return { text: sorted[0][0], mixed: counts.size > 1 };
  };

  // Maintenance grouped per FAR asset. Primary link is the ticket's far_asset_id;
  // legacy/manual tickets with no link fall back to an identification-mark / name
  // match so a repair on "Graphite Block (HCL AB10)" still lands on that asset.
  const maintByAsset = useMemo(() => {
    const byId = new Map<string, MaintEntry[]>();
    const assetsById = new Map(assets.map(a => [a.id, a]));
    const push = (assetId: string, e: MaintEntry) => {
      const arr = byId.get(assetId);
      if (arr) arr.push(e); else byId.set(assetId, [e]);
    };
    for (const e of maintEntries) {
      if (e.farAssetId && assetsById.has(e.farAssetId)) { push(e.farAssetId, e); continue; }
      const m = matchAsset(e.equipment, assets);
      if (m && m.score >= (m.via === 'mark' ? 1 : 0.72)) push(m.asset.id, e);
    }
    for (const arr of byId.values()) {
      arr.sort((a, b) => (b.closed_at || b.created_at).localeCompare(a.closed_at || a.created_at));
    }
    return byId;
  }, [maintEntries, assets]);

  // Only tickets linked to a FAR asset belong on this page. Name/mark matches
  // (e.g. "Graphite Block (HCL AB10)") count; free-text fire-line tickets do not.
  const farRelatedEntries = useMemo(() => {
    const ids = new Set(assets.map(a => a.id));
    return maintEntries.filter(e => {
      if (e.farAssetId && ids.has(e.farAssetId)) return true;
      const m = matchAsset(e.equipment, assets);
      return !!(m && m.score >= (m.via === 'mark' ? 1 : 0.72));
    });
  }, [maintEntries, assets]);
  // ── Maintenance cost register, grouped by financial year ──────────────────
  const fyList = useMemo(
    () => [...new Set(farRelatedEntries.map(e => e.fy))].filter(fy => fy !== 'Unknown').sort().reverse(),
    [farRelatedEntries],
  );
  // fy=all spans every year (the Repair flagged KPI counts across years).
  const activeFY = fyParam === 'all' ? 'all' : (fyParam && fyList.includes(fyParam) ? fyParam : fyList[0] || null);
  const fyLabel = activeFY === 'all' ? t('far.allYears', 'All years') : activeFY;
  const fyEntries = useMemo(() => {
    const q = equipSearch.trim().toLowerCase();
    return farRelatedEntries
      .filter(e => (activeFY === 'all' || e.fy === activeFY)
        && (!farPlant || e.plantId === farPlant)
        && (!repairStatus || (repairStatus === 'open' ? e.status !== 'closed' : e.status === 'closed'))
        && (!q || [e.equipment, e.part, e.ticketNo, e.plant].some(x => (x || '').toLowerCase().includes(q))))
      .sort((a, b) => (b.closed_at || b.created_at).localeCompare(a.closed_at || a.created_at));
  }, [farRelatedEntries, activeFY, farPlant, repairStatus, equipSearch]);
  const fyTotal = fyEntries.reduce((s, e) => s + e.cost, 0);
  const fyLastUpdated = fyEntries.reduce((mx, e) => { const d = e.closed_at || e.created_at; return d > mx ? d : mx; }, '');

  // Pagination (default 10/page) for the FAR register + the FY maintenance table.
  const fySort = useSortable(fyEntries, {
    ticket: e => e.id,
    equipment: e => e.equipment,
    part: e => e.part,
    status: e => e.status,
    closed: e => new Date(e.closed_at || e.created_at),
    cost: e => e.cost,
  }, fyUrl.sort, fyUrl.onSort);
  const groupPg = usePagination(groupSort.sorted, { resetKey: `${equipSearch}|${farPlant}|${picFilter}|${groupSort.sort.key}|${groupSort.sort.dir}`, ...groupUrl.paging, ready: !loading });
  const fyPg = usePagination(fySort.sorted, { resetKey: `${JSON.stringify(filters.values)}|${activeFY ?? ''}|${fySort.sort.key}|${fySort.sort.dir}`, ...fyUrl.paging, ready: !maintLoading });

  // ── Pic-proof coverage — % of registered assets with a photo on file ─────────
  const picCoverage = assets.length
    ? Math.round((assets.filter(a => !!a.photo_url).length / assets.length) * 100)
    : 0;

  function downloadMaintCsv() {
    if (!activeFY) return;
    const rows = fyEntries.map(e => ({
      ticket: e.ticketNo, equipment: e.equipment, plant: e.plant, part: e.part,
      status: e.status, created: fmtDT(e.created_at), closed: fmtDT(e.closed_at),
      busy: e.busyRef || '', cost: Math.round(e.cost),
    }));
    const preamble: (string | number)[][] = [
      ['Suntek — Maintenance & Repairs Register'],
      ['Financial year', activeFY],
      ['Total maintenance cost (insurance deduction)', inr(fyTotal)],
      ['Entries', fyEntries.length],
      ['Generated at', formatDateTime(new Date())],
    ];
    exportToCsv(`maintenance-register-${activeFY}`, MAINT_CSV_COLUMNS, rows, preamble);
  }

  // ── Bulk import: file → cloud copy → AI parse → verify → register ─────────
  function resetImport() {
    setImportStage('idle'); setParsedRows([]); setImportError(null);
    setImportedCount(0); setCloudUrl(null); setImportFileName(''); setImportPlantId('');
  }
  async function handleImportFile(file: File) {
    setImportError(null); setImportFileName(file.name); setParsedRows([]);
    setImportStage('uploading');
    try {
      // 1. Keep a copy of the original file in the cloud (reference).
      try {
        const up = await uploadWorkflowFile(file, { workflow: 'general', subfolder: 'far-imports', kind: 'far', creator: 'admin' });
        setCloudUrl(up.secure_url);
      } catch { /* cloud copy is best-effort */ }

      // 2. Extract the rows.
      setImportStage('parsing');
      const isSheet = /\.(csv|xlsx|xls)$/i.test(file.name);
      if (!isSheet) {
        throw new Error(t('far.errImagePdf'));
      }
      await new Promise((r) => setTimeout(r, 800)); // brief AI-reading step
      const rows = await parseFarFile(file);
      if (!rows.length) throw new Error(t('far.errNoRows'));
      setParsedRows(rows);
      // Pre-select the factory only when there's exactly one option; else force a choice.
      const opts = plantsForPicker(allowedPlants, scopeReady);
      setImportPlantId(opts.length === 1 ? opts[0].id : '');
      setImportStage('review');
    } catch (e) {
      // NOT String(e): Supabase/PostgREST rejections are plain objects, not
      // Error instances, so `instanceof Error` is false and String() renders
      // them as "[object Object]" — hiding the only thing that explains the
      // failure. humanizeError() is the shared path every other importer uses.
      setImportError(errMsg(e, { action: 'import this FAR file', context: 'FAR.import' }));
      setImportStage('error');
    }
  }
  async function confirmImport() {
    if (!importPlantId) { setImportError(t('far.selectFactoryError', 'Select the factory this FAR belongs to.')); setImportStage('error'); return; }
    // Fail with a sentence the user can act on, rather than letting RLS reject
    // the insert and surfacing a Postgres policy violation.
    if (scopeReady && !plantOptions.some(p => p.id === importPlantId)) {
      setImportError(t('far.noFactoryAccess', 'You do not have access to that factory, so its Fixed Asset Register cannot be imported. Ask an admin to add you to it under User Management.'));
      setImportStage('error'); return;
    }
    setImportStage('importing');
    try {
      // Register the upload BEFORE writing a single asset, so every row can be
      // stamped with its batch id. That stamp is what makes a wrong file
      // reversible from Admin → Upload History; without it these rows would be
      // indistinguishable from assets someone registered by hand, and therefore
      // permanent. If the insert below fails we are left with an empty batch,
      // which is visible and deletable in one click — a much better failure
      // mode than unattributed rows.
      const batchId = await createImportBatch({
        module: 'far',
        plantId: importPlantId,
        fileName: importFileName,
        fileUrl: cloudUrl,
        rowCount: parsedRows.length,
        uploadedByName: activeProfile.name,
      });
      // One row per asset, owned by exactly one factory. Sequential FAR-001…
      // Allocate globally so Ganjam cannot reuse a Rehla FAR-051.
      const allocated = await allocateNextJobNos('FAR', parsedRows.length);
      const usedJobs = [...assets.map(a => a.job_no), ...allocated];
      const payload = parsedRows.map((r, i) => {
        const job = allocated[i] || nextJobNo(usedJobs, 'FAR');
        if (!allocated[i]) usedJobs.push(job);
        return {
        plant_id: importPlantId,
        import_batch_id: batchId,
        name: r.name || r.mark || r.model || 'Unnamed asset',
        identification_mark: r.mark || null,
        job_no: job,
        make: r.make || null,
        serial_no: r.serial || null,
        quantity: r.quantity ? (parseFloat(String(r.quantity).replace(/[^0-9.]/g, '')) || null) : null,
        model: r.model || null,
        capacity: r.capacity || null,
        origin: r.origin || null,
        year: r.year ? (parseInt(r.year) || null) : null,
        value: r.value ? (parseFloat(String(r.value).replace(/[^0-9.]/g, '')) || null) : null,
        invoice_no: r.invoice || null,
        purchase_date: normalizeAssetDate(r.purchaseDate),
        account_head: r.account || null,
      };
      });
      let { error } = await insertRows('fixed_assets', payload);
      if (error && /job_no/i.test(error.message || '')) {
        ({ error } = await insertRows('fixed_assets', payload.map(({ job_no: _j, ...r }) => r)));
      }
      if (error) throw error;
      await setImportBatchRowCount(batchId, payload.length);
      setImportedCount(payload.length);
      setImportStage('done');
      await load();
    } catch (e) {
      // NOT String(e): Supabase/PostgREST rejections are plain objects, not
      // Error instances, so `instanceof Error` is false and String() renders
      // them as "[object Object]" — hiding the only thing that explains the
      // failure. humanizeError() is the shared path every other importer uses.
      setImportError(errMsg(e, { action: 'import this FAR file', context: 'FAR.import' }));
      setImportStage('error');
    }
  }
  function downloadImportCsv() {
    exportToCsv(`far-import-${today}`, IMPORT_CSV_COLUMNS, parsedRows as unknown as Record<string, unknown>[], [
      ['Suntek — FAR Import (AI-extracted)'],
      ['Source file', importFileName],
      ['Cloud copy', cloudUrl || '—'],
      ['Rows', parsedRows.length],
      ['Generated at', formatDateTime(new Date())],
    ]);
  }

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  function handleOcr(data: Record<string, string>) {
    setForm(f => ({
      ...f,
      ...(data.invoice  ? { invoice: data.invoice }     : {}),
      ...(data.value    ? { value: data.value }          : {}),
      ...(data.model    ? { model: data.model }          : {}),
      ...(data.capacity ? { capacity: data.capacity }    : {}),
      ...(data.purchaseDate ? { purchaseDate: data.purchaseDate } : {}),
      // Auto-fill identification mark from model if not already set
      ...(data.model && !f.mark ? { mark: data.model } : {}),
    }));
  }

  async function handleSave() {
    if (!form.mark.trim() || !form.model.trim()) return;
    const plantId = form.plant || plantOptions[0]?.id || null;
    // An asset with no factory matches no grant: nobody could raise a ticket on it.
    if (!plantId) { toast.error(t('far.pmNoFactories', 'No factories in your scope — ask an admin to assign a plant before importing PM.')); return; }
    const allocated = await allocateNextJobNos('FAR', 1);
    const jobNo = allocated[0] || nextJobNo(assets.map(a => a.job_no), 'FAR');
    const payload = {
      plant_id: plantId,
      name: form.mark,
      identification_mark: form.mark,
      job_no: jobNo,
      model: form.model || null,
      capacity: form.capacity || null,
      origin: form.origin || null,
      year: parseInt(form.year) || null,
      value: form.value ? parseFloat(form.value.replace(/[^0-9.]/g, '')) : null,
      invoice_no: form.invoice || null,
      purchase_date: form.purchaseDate || null,
      account_head: form.account || null,
    };
    let { data, error } = await insertRows('fixed_assets', payload).select('*, plants(name)').single();
    if (error && /job_no/i.test(error.message || '')) {
      const { job_no: _omit, ...withoutJob } = payload;
      ({ data, error } = await insertRows('fixed_assets', withoutJob).select('*, plants(name)').single());
    }

    if (error) {
      toast.error(`${t('far.saveFailed')}: ${error.message}`);
      return;
    }
    if (data) setAssets(prev => [data as AssetRow, ...prev]);
    setSaved(true);
    setTimeout(() => { setOpen(false); setSaved(false); setForm({ mark: '', model: '', capacity: '', origin: 'India', year: istToday().slice(0, 4), value: '', invoice: '', purchaseDate: today, account: 'Plant & Machinery', plant: plantOptions[0]?.id ?? '' }); }, 1600);
  }

  function handleClose() { setOpen(false); setSaved(false); }

  return (
    <>
      {/* KPI row */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 sm:col-span-6 lg:col-span-4 relative">
          {/* Factories are NOT enumerated here — the list is DB-driven and has
              changed twice (migration 58's rename, migration 69's Drum Plant).
              A hard-coded roster in help text goes stale silently. */}
          <KpiInfoButton info={{ title: 'Total Fixed Assets', what: 'Count of all capitalised fixed assets registered across the factories you have access to. Each asset is named and tracked in the FAR, and belongs to exactly one factory.', source: 'Form entry', formLabel: 'Add Asset form', formPath: '/dashboard/purchase/far', note: 'Live count from the Supabase fixed_assets table, scoped to your factories.' }} />
          <StatCard className="h-full" icon={<Boxes />} label={t('far.totalFixedAssets')} value={loading || !assetsComplete ? '…' : assets.length}
            onView={() => { filters.only({}); setEquipOpenTable(true); farRegisterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
            viewLabel={t('far.viewRegister', 'View register')}
            caption={loading ? '\u00a0' : plantsInFar.length === 0
              ? t('far.captionNoFactories', 'no assets registered yet')
              : plantsInFar.length === 1
                ? t('far.captionOneFactory', { defaultValue: 'in {{plant}}', plant: displayLocationName(plantsInFar[0].name) })
                : t('far.captionNFactories', { defaultValue: 'across {{count}} factories', count: plantsInFar.length })} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-4 relative">
          <KpiInfoButton info={{ title: 'Assets Flagged for Repair', what: 'Count of fixed assets that have been flagged as requiring repair or maintenance and are awaiting resolution. High count = production downtime risk.', source: 'Derived', note: 'Open (not yet closed) emergency maintenance tickets from the maintenance workflow.' }} />
          <StatCard className="h-full" icon={<Wrench />} tone="amber" valueTone="amber" label={t('far.repairFlagged')} value={maintLoading ? '…' : farRelatedEntries.filter(e => e.status !== 'closed').length} caption={<span className="text-amber-600">{t('far.awaitingClosure')}</span>}
            onView={() => { filters.only({ rstatus: 'open', fy: 'all' }); farMaintRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
            viewLabel={t('far.viewRepairs', 'View FAR repairs')} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-4 relative">
          <KpiInfoButton info={{ title: 'Pic-Proof Coverage', what: 'Percentage of registered assets that have a photo on file as proof of existence. Required for insurance claims and audits. Target 100%.', source: 'Derived', note: 'Assets with a photo on file ÷ total registered assets. 0% when the FAR is empty. Updates as photos are added or removed.' }} />
          <StatCard className="h-full" icon={<Camera />} tone="green" label={t('far.picProofCoverage')} value={loading || !assetsComplete ? '…' : `${picCoverage}%`}
            caption={<div className="progress mt-1"><div style={{ width: `${picCoverage}%` }}></div></div>}
            onView={() => { filters.only({ pic: 'missing' }); setEquipOpenTable(true); farRegisterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
            viewLabel={t('far.viewRegister', 'View register')} />
        </div>
      </div>

      {/* One bar for both lists: plant + search apply to repairs and the register;
          repair status to the repairs; photo to the register. */}
      <FilterBar
        className="mb-4"
        search={equipSearch} onSearch={(q) => filters.set({ q })}
        searchPlaceholder={t('far.searchEquipPh', 'Search equipment type, mark or job no…')}
        onReset={filters.reset}
      >
        {filterPlants.length > 1 && (
          <FilterSelect icon={<Building2 />} value={farPlant || 'all'} onChange={(v) => filters.set({ plant: v === 'all' ? '' : v })}
            options={[{ value: 'all', label: t('common.allPlants') }, ...filterPlants.map(p => ({ value: p.id, label: displayLocationName(p.name) }))]} />
        )}
        <FilterSelect icon={<Wrench />} value={repairStatus || 'all'} onChange={(v) => filters.set({ rstatus: v === 'all' ? '' : v })}
          options={[
            { value: 'all', label: t('far.allRepairs', 'All repairs') },
            { value: 'open', label: t('far.awaitingClosure') },
            { value: 'closed', label: t('far.repairsClosed', 'Closed repairs') },
          ]} />
        <FilterSelect icon={<Camera />} value={picFilter || 'all'} onChange={(v) => filters.set({ pic: v === 'all' ? '' : v })}
          options={[
            { value: 'all', label: t('far.allPhotos', 'Photo: all') },
            { value: 'missing', label: t('far.photoMissing', 'No photo') },
            { value: 'has', label: t('far.photoOnFile', 'Photo on file') },
          ]} />
      </FilterBar>

      {/* ── Maintenance & Repairs by Financial Year (FAR-linked only) ──────── */}
      <div ref={farMaintRef}>
      <SectionCard
        className="mb-4"
        title={t('far.maintRepairsTitle')}
        subtitle={t('far.maintRepairsFarOnly', 'Only tickets linked to a FAR asset. Raise a ticket from the register — lab / other jobs stay on Maintenance.')}
        actions={
          <ButtonV2 variant="outline" icon={<Download />} onClick={downloadMaintCsv} disabled={!fyEntries.length}>
            {t('far.downloadCsvReport')}
          </ButtonV2>
        }
      >

        {/* Financial-year tabs */}
        {maintLoading ? null : fyList.length === 0
          ? <span className="text-xs text-slate-400 block mb-4">{t('far.noMaintRecorded')}</span>
          : <SegmentTabs className="mb-4" items={[...fyList.map(fy => ({ key: fy, label: fy })), { key: 'all', label: t('far.allYears', 'All years') }]} value={activeFY ?? fyList[0]} onChange={(fy) => filters.set({ fy })} />}

        {activeFY && (
          <>
            {/* Aggregate row */}
            <div className="grid grid-cols-12 gap-4 mb-4">
              <div className="col-span-12 sm:col-span-4 rounded-xl border border-slate-100 p-4" style={{ background: '#F8FAFC' }}>
                <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('far.repairCost')} · {fyLabel}</div>
                <div className="text-[24px] font-extrabold mt-1 num text-slate-800">{maintLoading ? '…' : inr(fyTotal)}</div>
              </div>
              <div className="col-span-6 sm:col-span-4 rounded-xl border border-slate-100 p-4" style={{ background: '#F8FAFC' }}>
                <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('far.maintenanceEntries')}</div>
                <div className="text-[24px] font-extrabold mt-1 num">{maintLoading ? '…' : fyEntries.length}</div>
              </div>
              <div className="col-span-6 sm:col-span-4 rounded-xl border border-slate-100 p-4" style={{ background: '#F8FAFC' }}>
                <div className="text-[11px] text-slate-500 uppercase tracking-wider">{t('far.lastUpdated')}</div>
                <div className="text-sm font-semibold mt-2 text-slate-700">{fyLastUpdated ? fmtDT(fyLastUpdated) : '—'}</div>
              </div>
            </div>

            <div className="overflow-x-auto scroll-x">
              <table className="dt2">
                <thead>
                  <tr><Th sortKey="ticket" s={fySort}>{t('far.thTicket')}</Th><Th sortKey="equipment" s={fySort}>{t('far.thEquipment')}</Th><Th sortKey="part" s={fySort}>{t('far.thPartType')}</Th><Th sortKey="status" s={fySort}>{t('far.thStatus')}</Th><Th sortKey="closed" s={fySort} firstDir="desc">{t('far.thClosed')}</Th><Th sortKey="cost" s={fySort} firstDir="desc" className="num">{t('far.thCost')}</Th></tr>
                </thead>
                <tbody>
                  {fyEntries.length === 0 && (
                    <tr><td colSpan={6} className="text-center text-slate-400 py-6 text-sm">{(farPlant || repairStatus || equipSearch) ? t('common.noRowsMatchFilters', 'No rows match these filters') : t('far.noMaintInFy', { fy: fyLabel })}</td></tr>
                  )}
                  {fyPg.pageRows.map(e => (
                    <tr key={e.id} onClick={() => setDrillEntry(e)} style={{ cursor: 'pointer' }}>
                      <td className="num text-xs text-slate-500">#{e.ticketNo}</td>
                      <td className="font-semibold text-slate-700">{e.equipment}</td>
                      <td className="text-slate-500 text-xs">{e.part}</td>
                      <td className="text-slate-500 text-xs">{statusLabel(e.status)}</td>
                      <td className="text-slate-500 text-xs">{e.closed_at ? fmtDT(e.closed_at) : '—'}</td>
                      <td className="num font-semibold">{e.cost ? inr(e.cost) : '—'}</td>
                    </tr>
                  ))}
                  {fyEntries.length > 0 && (
                    <tr style={{ borderTop: '2px solid #E2E8F0' }}>
                      <td colSpan={5} className="font-bold text-right pr-4">{t('far.total')} · {fyLabel}</td>
                      <td className="num font-extrabold text-slate-800">{inr(fyTotal)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <TablePaginationV2 controls={fyPg.controls} label={t('far.nounEntries', 'entries')} />
          </>
        )}
      </SectionCard>
      </div>

      {/* FAR register */}
      <div className="relative" ref={farRegisterRef}>
        <KpiInfoButton info={{ title: 'Fixed Asset Register (FAR)', what: 'Complete list of capitalised fixed assets across your plants. Each asset must be individually named on the FAR to be covered by the marine/fire insurance policy. Photo proof required for audit. New assets are added with "Register asset" or a CSV / Excel import.', source: 'Form entry', formLabel: 'Register asset', formPath: '/dashboard/purchase/far', note: 'Live from the fixed asset register.' }} />
      <SectionCard
        title={t('far.fixedAssetRegister')}
        subtitle={t('far.equipMasterSubtitle', { defaultValue: 'Equipment master for Preventive Maintenance — grouped by type · {{types}} types · {{assets}} assets', types: loading ? '…' : equipGroups.length, assets: loading ? '…' : assets.length })}
        actions={
          <>
            <ButtonV2 variant="outline" icon={<Upload />} onClick={() => { setImportOpen(o => !o); if (importStage === 'done') resetImport(); }}>
              {t('far.importCsvExcel')}
            </ButtonV2>
            {rights.can('far', 'add') && (
              <ButtonV2 variant="accent" icon={<Plus />} onClick={() => setOpen(true)}>
                {t('far.registerAsset')}
              </ButtonV2>
            )}
          </>
        }
      >

        {/* Bulk-import accordion */}
        {importOpen && (
          <div style={{ border: '1px dashed #F59E0B', background: '#FFFBEB', borderRadius: 14, padding: 16, marginBottom: 16 }}>
            <input ref={importInputRef} type="file" accept=".csv,.xlsx,.xls,image/*,application/pdf" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />

            {(importStage === 'idle' || importStage === 'error') && (
              <>
                <div onClick={() => importInputRef.current?.click()}
                  style={{ cursor: 'pointer', border: '2px dashed #FCD34D', borderRadius: 12, padding: '20px', textAlign: 'center', background: '#FEFCE8' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#92400E' }}>⬆ {t('far.uploadPrevYearSheet')}</div>
                  <div style={{ fontSize: 12, color: '#A16207', marginTop: 4 }}>{t('far.uploadHint')}</div>
                </div>
                {importError && <div style={{ marginTop: 10, fontSize: 12, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 12px' }}>{importError}</div>}
              </>
            )}

            {(importStage === 'uploading' || importStage === 'parsing' || importStage === 'importing') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 4px' }}>
                <svg className="animate-spin" width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#FDE68A" strokeWidth="3" /><path d="M12 2 A10 10 0 0 1 22 12" stroke="#D97706" strokeWidth="3" strokeLinecap="round" /></svg>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#92400E' }}>
                  {importStage === 'uploading' ? `☁ ${t('far.savingToCloud')}`
                    : importStage === 'parsing' ? `🤖 ${t('far.aiReadingSheet')}`
                    : `🤖 ${t('far.registeringAssets', { count: parsedRows.length })}`}
                </div>
              </div>
            )}

            {importStage === 'review' && (
              <>
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <div style={{ fontSize: 12.5, color: '#92400E', fontWeight: 700 }}>
                    🤖 {t('far.assetsExtractedFrom', { count: parsedRows.length })} <strong>{importFileName}</strong> — {t('far.verifyEditRegister')}
                  </div>
                  <button onClick={downloadImportCsv} className="chip">⬇ {t('far.downloadExtractedCsv')}</button>
                </div>
                {/* Which factory/factories does this FAR belong to? (multi-select — a shared FAR can cover several) */}
                <div style={{ border: '1px solid #FDE68A', background: '#FFFDF5', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#92400E', textTransform: 'uppercase', marginBottom: 6 }}>{t('far.factoryBelongsTo', 'Factory this FAR belongs to *')}</div>
                  <div className="flex gap-2 flex-wrap">
                    {plantsForPicker(allowedPlants, scopeReady).map(p => {
                      const on = importPlantId === p.id;
                      return (
                        <button key={p.id} onClick={() => setImportPlantId(p.id)}
                          className={`chip${on ? ' active' : ''}`}>{on ? '✓ ' : ''}{p.name}</button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: '#A16207', marginTop: 6 }}>
                    {t('far.selectFactoryHint', 'Each asset belongs to exactly one factory. Factories that share a store still keep separate registers — import each factory\u2019s FAR separately.')}
                  </div>
                </div>
                {unreadableDates.length > 0 && (
                  <div style={{ background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#B45309' }}>
                      {t('far.badDatesTitle', { defaultValue: '⚠ {{n}} row(s) have a Date of Purchase we cannot read', n: unreadableDates.length })}
                    </div>
                    <div style={{ fontSize: 11.5, color: '#92400E', marginTop: 4 }}>
                      {t('far.badDatesBody', 'These assets will import with the date left blank. Fix the cells in the sheet and re-upload if you need the dates. Expected format: DD.MM.YYYY (e.g. 29.07.2017).')}
                    </div>
                    <div style={{ maxHeight: 110, overflowY: 'auto', marginTop: 8 }}>
                      {unreadableDates.slice(0, 25).map(x => (
                        <div key={x.row} style={{ fontSize: 11.5, color: '#7C2D12', display: 'flex', gap: 8 }}>
                          <span style={{ opacity: 0.7, minWidth: 52 }}>{t('far.badDatesRow', { defaultValue: 'Row {{n}}', n: x.row })}</span>
                          <span style={{ flex: 1 }}>{x.name}</span>
                          <strong>{x.raw}</strong>
                        </div>
                      ))}
                      {unreadableDates.length > 25 && (
                        <div style={{ fontSize: 11, color: '#92400E', marginTop: 4 }}>
                          {t('far.badDatesMore', { defaultValue: '…and {{n}} more', n: unreadableDates.length - 25 })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="overflow-x-auto scroll-x" style={{ maxHeight: 280 }}>
                  <table className="dt2">
                    <thead><tr><th>{t('far.thEquipment')}</th><th>{t('far.thIdMark')}</th><th>{t('far.thMake', 'Make')}</th><th>{t('far.thSerial', 'Serial')}</th><th>{t('far.thQty', 'Qty')}</th><th>{t('far.thModel')}</th><th>{t('far.thYear')}</th><th>{t('far.thTaxableValue')}</th><th>{t('far.thInvoice')}</th><th>{t('far.thPurchaseDate')}</th><th>{t('far.thAccountHead')}</th></tr></thead>
                    <tbody>
                      {parsedRows.map((r, i) => {
                        const upd = (k: keyof FarImportRow, v: string) => setParsedRows(prev => prev.map((x, j) => j === i ? { ...x, [k]: v } : x));
                        const cell = (k: keyof FarImportRow, min = 90) => <td><input value={r[k]} onChange={e => upd(k, e.target.value)} style={{ width: '100%', minWidth: min, padding: '4px 6px', border: '1px solid #FDE68A', borderRadius: 6, fontSize: 12, background: '#fff' }} /></td>;
                        return <tr key={i}>{cell('name', 140)}{cell('mark', 70)}{cell('make')}{cell('serial')}{cell('quantity', 50)}{cell('model')}{cell('year', 60)}{cell('value')}{cell('invoice')}{cell('purchaseDate')}{cell('account')}</tr>;
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => resetImport()} className="chip">{t('far.cancel')}</button>
                  <button onClick={confirmImport} disabled={!importPlantId} className="btn-accent rounded-[10px] px-4 py-2 font-semibold text-sm" style={{ background: importPlantId ? '#16A34A' : '#94A3B8', opacity: importPlantId ? 1 : 0.6 }}>
                    ✓ {t('far.registerNAssets', { count: parsedRows.length })}
                  </button>
                </div>
              </>
            )}

            {importStage === 'done' && (
              <div style={{ textAlign: 'center', padding: '8px 0' }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#15803D' }}>✓ {t('far.assetsImported', { count: importedCount })}</div>
                {cloudUrl && <a href={cloudUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#2563EB', display: 'inline-block', marginTop: 6 }}>{t('far.viewSavedFile')} ↗</a>}
                <div><button onClick={() => { resetImport(); setImportOpen(false); }} className="chip" style={{ marginTop: 10 }}>{t('far.done')}</button></div>
              </div>
            )}
          </div>
        )}
        {loadError ? (
          <ErrorState title={t('far.errLoadTitle')} message={t('far.errLoadMessage')} onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
        ) : loading ? (
          <SkeletonRows rows={6} />
        ) : (
          <>
            {/* Summary strip + expand toggle — the big list stays collapsed */}
            <div className="flex items-center justify-between flex-wrap gap-2 bg-slate-50 border border-slate-200 rounded-[10px] px-3.5 py-2.5">
              <div className="text-[13px] text-slate-600">
                <strong>{assets.length}</strong> {assets.length === 1 ? t('far.assetWord', 'asset') : t('far.assetsWord', 'assets')} · <strong>{equipGroups.length}</strong> {equipGroups.length === 1 ? t('far.equipTypeWord', 'equipment type') : t('far.equipTypesWord', 'equipment types')}
                {/* Always say WHICH factory this register belongs to — including
                    when there is only one, and when it is still empty. Hiding it
                    means someone returning months after an import cannot tell
                    whose assets they are looking at. */}
                {activePlantLabel && <span> · <strong>{activePlantLabel}</strong></span>}
              </div>
              <button onClick={() => setEquipOpenTable(!registerOpen)} className="text-sm font-semibold text-slate-700 hover:text-slate-900" style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {registerOpen ? `${t('far.hideRegister', 'Hide register')} ▴` : `${t('far.showRegister', 'Show register')} ▾`}
              </button>
            </div>

            {registerOpen && (
              <div style={{ marginTop: 14 }}>
                {/* The factory control is ALWAYS present — never hidden because
                    only one option exists. With a single factory it is a plain
                    label ("Plant: …") rather than a button, since there is
                    nothing to switch to but everything to identify. */}
                {plantChips.length === 1 && (
                  <div className="flex gap-2 mb-3 flex-wrap items-center">
                    <span className="chip active" style={{ cursor: 'default' }}>
                      {t('far.plantPrefix', 'Plant')}: {plantChips[0].name}
                    </span>
                    {!plantChips[0].hasData && (
                      <span style={{ fontSize: 11, color: '#94A3B8' }}>{t('far.plantNoAssets', 'no assets imported yet')}</span>
                    )}
                  </div>
                )}
                {/* Plant + search for the register are in the filter bar above. */}
                <div className="overflow-x-auto scroll-x" style={{ maxHeight: 460 }}>
                  <table className="dt2">
                    <thead>
                      <tr>
                        <Th sortKey="type" s={groupSort}>{t('far.thEquipmentType', 'Equipment Type')}</Th>
                        <Th sortKey="count" s={groupSort} firstDir="desc" className="num">{t('far.thCount', 'Count')}</Th>
                        <Th sortKey="job" s={groupSort}>{t('far.thJobNo', 'Job No')}</Th>
                        <th>{t('far.thMake', 'Make')}</th><th>{t('far.thModel')}</th><th>{t('far.thCapacity')}</th><th>{t('far.thYear')}</th><th>{t('far.thIdMarks', 'Identification Marks')}</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupSort.sorted.length === 0 && <tr><td colSpan={9} className="text-center text-slate-400 py-6 text-sm">{assets.length === 0 ? t('far.noAssetsYet') : t('common.noRowsMatchFilters', 'No rows match these filters')}</td></tr>}
                      {groupPg.pageRows.map(g => {
                        const open = expandedType === g.type;
                        const make = repVal(g.assets.map(a => a.make));
                        const model = repVal(g.assets.map(a => a.model));
                        const cap = repVal(g.assets.map(a => a.capacity));
                        const years = g.assets.map(a => a.year).filter((y): y is number => y != null);
                        const yr = years.length ? (Math.min(...years) === Math.max(...years) ? String(Math.min(...years)) : `${Math.min(...years)}–${Math.max(...years)}`) : '—';
                        const marks = g.assets.map(a => a.identification_mark).filter(Boolean);
                        const jobs = g.assets
                          .map(a => jobMap.get(a.id) || jobNoFar(a.id, a.identification_mark, a.job_no))
                          .filter(Boolean)
                          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                        return (
                          <React.Fragment key={g.type}>
                            <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedType(open ? null : g.type)}>
                              <td className="font-semibold text-slate-700">{open ? '▾ ' : '▸ '}{g.type}</td>
                              <td className="num font-bold">{g.count}</td>
                              <td className="font-mono text-xs font-semibold text-slate-700">{jobs.slice(0, 3).join(', ')}{jobs.length > 3 ? ` ${t('far.nMore', { defaultValue: '+{{count}} more', count: jobs.length - 3 })}` : ''}</td>
                              <td className="text-slate-500 text-xs">{make.text}{make.mixed ? ' …' : ''}</td>
                              <td className="text-slate-500 text-xs">{model.text}{model.mixed ? ' …' : ''}</td>
                              <td className="text-slate-500 text-xs">{cap.text}{cap.mixed ? ' …' : ''}</td>
                              <td className="text-slate-500 text-xs">{yr}</td>
                              <td className="text-slate-500 text-xs">{marks.slice(0, 3).join(', ')}{marks.length > 3 ? ` ${t('far.nMore', { defaultValue: '+{{count}} more', count: marks.length - 3 })}` : ''}</td>
                              <td><span className="text-xs text-slate-400">{open ? '▴' : '▾'}</span></td>
                            </tr>
                            {open && (
                              <tr>
                                <td colSpan={9} style={{ background: '#F8FAFC', padding: 0 }}>
                                  <AssetDetailTable assets={g.assets} jobMap={jobMap} showPlant={plantsInFar.length >= 1} maintByAsset={maintByAsset} onUploadPic={handleAssetPicUpload} onViewPic={handleAssetPicView} onOpenMaint={(asset, entries) => setAssetMaint({ asset, entries })} onRaise={raiseTicketForAsset} />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <TablePaginationV2 controls={groupPg.controls} label={t('far.nounTypes', 'types')} />
              </div>
            )}
          </>
        )}
      </SectionCard>
      </div>

      {/* Slide panel */}
      <SlidePanel open={open} onClose={handleClose} title={t('far.panelTitle')} subtitle={t('far.panelSubtitle', 'FAR · Purchase')}>
        <PanelField label={t('far.fldIdMark')}>
          <PanelInput placeholder={t('far.phIdMark', 'e.g. SCPL-PM-047, SHD-Compressor-3')} value={form.mark} onChange={e => set('mark', e.target.value)} />
        </PanelField>

        <PanelRow>
          <PanelField label={t('far.fldModel')}>
            <PanelInput placeholder={t('far.phModel', 'e.g. Atlas Copco GA-22')} value={form.model} onChange={e => set('model', e.target.value)} />
          </PanelField>
          <PanelField label={t('far.fldCapacity')}>
            <PanelInput placeholder={t('far.phCapacity', 'e.g. 5 MT, 22 kW')} value={form.capacity} onChange={e => set('capacity', e.target.value)} />
          </PanelField>
        </PanelRow>

        <PanelRow>
          <PanelField label={t('far.fldOrigin')}>
            <PanelSelect value={form.origin} onChange={e => set('origin', e.target.value)}>
              <option value="India">{t('far.originIndia', 'India')}</option>
              <option value="Import">{t('far.originImport', 'Import')}</option>
            </PanelSelect>
          </PanelField>
          <PanelField label={t('far.fldYearOfPurchase')}>
            <PanelInput type="number" value={form.year} onChange={e => set('year', e.target.value)} />
          </PanelField>
        </PanelRow>

        <PanelRow>
          <PanelField label={t('far.fldTaxableValue')}>
            <PanelInput placeholder={t('far.phTaxableValue', 'e.g. ₹ 4,20,000')} value={form.value} onChange={e => set('value', e.target.value)} />
          </PanelField>
          <PanelField label={t('far.fldInvoiceNo')}>
            <PanelInput placeholder={t('far.phInvoiceNo', 'e.g. INV-2024-1234')} value={form.invoice} onChange={e => set('invoice', e.target.value)} />
          </PanelField>
        </PanelRow>

        <PanelRow>
          <PanelField label={t('far.fldDateOfPurchase')}>
            <PanelDateInput value={form.purchaseDate} onChange={e => set('purchaseDate', e.target.value)} />
          </PanelField>
          <PanelField label={t('far.fldPlant')}>
            <PanelSelect value={form.plant} onChange={e => set('plant', e.target.value)}>
              {!form.plant && <option value="">{t('far.selectFactory', 'Select factory…')}</option>}
              {plantOptions.map(p => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
            </PanelSelect>
          </PanelField>
        </PanelRow>

        <PanelField label={t('far.fldAccountHead')}>
          <PanelSelect value={form.account} onChange={e => set('account', e.target.value)}>
            {ACCOUNT_HEADS.map(a => <option key={a}>{a}</option>)}
          </PanelSelect>
        </PanelField>

        <PanelDivider />

        <OcrUpload
          label={t('far.ocrLabel')}
          hint={t('far.ocrHint')}
          fields={[
            { key: 'invoice',      label: t('far.ocrFldInvoiceNo'),     value: 'INV-2026-7234' },
            { key: 'model',        label: t('far.ocrFldModelMake'),     value: 'Atlas Copco GA18' },
            { key: 'capacity',     label: t('far.ocrFldCapacitySpecs'), value: '18 kW / 10 bar' },
            { key: 'value',        label: t('far.ocrFldTaxableValue'),  value: '3,85,000' },
            { key: 'purchaseDate', label: t('far.ocrFldInvoiceDate'),   value: istToday() },
          ]}
          onExtracted={handleOcr}
        />

        <PanelFooter
          saved={saved}
          onCancel={handleClose}
          onSave={handleSave}
          saveLabel={t('far.registerAsset')}
          successLabel={t('far.assetRegistered')}
          successSub={t('far.assetRegisteredSub')}
          disabled={!form.mark.trim() || !form.model.trim()}
          requiredHint={t('far.requiredHint')}
        />
      </SlidePanel>

      {/* Per-asset maintenance history */}
      <SlidePanel
        open={!!assetMaint}
        onClose={() => setAssetMaint(null)}
        title={assetMaint ? `${assetMaint.asset.name}${assetMaint.asset.identification_mark ? ` · ${assetMaint.asset.identification_mark}` : ''}` : t('far.maintenance')}
        subtitle={t('far.assetMaintSub', 'Maintenance history for this asset')}
      >
        {assetMaint && (() => {
          const entries = assetMaint.entries;
          const total = entries.reduce((s, e) => s + e.cost, 0);
          const open = entries.filter(e => e.status !== 'closed').length;
          return (
            <div>
              {/* 2-up on a phone (cost spans) — three ₹ values don't fit a 390px panel. */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                <div className="rounded-xl border border-slate-100 p-3" style={{ background: '#F8FAFC' }}>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">{t('far.repairsWord', 'Repairs')}</div>
                  <div className="text-lg font-extrabold num text-slate-800">{entries.length}</div>
                </div>
                <div className="rounded-xl border border-slate-100 p-3" style={{ background: '#F8FAFC' }}>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">{t('far.openWord', 'Open')}</div>
                  <div className="text-lg font-extrabold num" style={{ color: open ? '#B45309' : '#0F172A' }}>{open}</div>
                </div>
                <div className="col-span-2 sm:col-span-1 rounded-xl border border-slate-100 p-3" style={{ background: '#F0FDF4' }}>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">{t('far.totalCost', 'Total cost')}</div>
                  <div className="text-lg font-extrabold num" style={{ color: '#15803D' }}>{total ? inr(total) : '—'}</div>
                </div>
              </div>
              {entries.length === 0 ? (
                <div className="text-center text-slate-400 py-6 text-sm">{t('far.noAssetMaint', 'No maintenance recorded for this asset yet.')}</div>
              ) : (
                entries.map(e => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => { setAssetMaint(null); setDrillEntry(e); }}
                    className="w-full text-left rounded-xl border border-slate-100 p-3 mb-2 hover:border-slate-300"
                    style={{ background: '#fff', cursor: 'pointer' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-slate-700">{e.part}</span>
                      <span className="num text-[13px] font-bold" style={{ color: e.cost ? '#15803D' : '#94A3B8' }}>{e.cost ? inr(e.cost) : t('far.inHouseNoPart')}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <span className="text-[11px] text-slate-500">#{e.ticketNo} · {statusLabel(e.status)} · {e.fy}</span>
                      <span className="text-[11px] text-slate-400">{e.closed_at ? fmtDT(e.closed_at) : fmtDT(e.created_at)}</span>
                    </div>
                  </button>
                ))
              )}
              <button
                type="button"
                onClick={() => { const a = assetMaint.asset; setAssetMaint(null); raiseTicketForAsset(a); }}
                style={{ display: 'block', width: '100%', marginTop: 8, fontSize: 13, fontWeight: 700, color: '#fff', background: '#0A1628', border: 'none', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit' }}
              >{t('far.raiseTicket', 'Raise ticket')}</button>
              {/* Emergency list filtered to this asset. back= returns to FAR on close. */}
              <button type="button" onClick={() => navigate(`/dashboard/purchase/maint?tab=emergency&q=${encodeURIComponent(assetMaint.asset.identification_mark || assetMaint.asset.name)}&${backHere()}`)} style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: 10, fontSize: 12, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>{t('far.openInMaintenance')} →</button>
            </div>
          );
        })()}
      </SlidePanel>

      {/* Maintenance entry drill-down */}
      <SlidePanel open={!!drillEntry} onClose={() => setDrillEntry(null)} title={drillEntry?.equipment || t('far.maintenance')} subtitle={t('far.maintenanceDetail')}>
        {drillEntry && (() => {
          const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid #F1F5F9' }}>
              <span style={{ fontSize: 12, color: '#94A3B8' }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', textAlign: 'right' }}>{v}</span>
            </div>
          );
          return (
            <div>
              <Row k={t('far.rowTicketNo')} v={drillEntry.ticketNo} />
              <Row k={t('far.rowEquipment')} v={drillEntry.equipment} />
              <Row k={t('far.rowPlant')} v={drillEntry.plant} />
              <Row k={t('far.rowPartType')} v={drillEntry.part} />
              <Row k={t('far.rowStatus')} v={statusLabel(drillEntry.status)} />
              <Row k={t('far.rowFinancialYear')} v={drillEntry.fy} />
              <Row k={t('far.rowRaisedAt')} v={fmtDT(drillEntry.created_at)} />
              <Row k={t('far.rowClosedAt')} v={drillEntry.closed_at ? fmtDT(drillEntry.closed_at) : t('far.openDash')} />
              {drillEntry.procuredQty > 0 && <Row k={t('far.rowQtyProcured', 'Qty procured')} v={String(drillEntry.procuredQty)} />}
              {drillEntry.busyRef && <Row k={t('far.rowBusyRef')} v={drillEntry.busyRef} />}
              <div style={{ marginTop: 14, padding: '14px 16px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#15803D' }}>{drillEntry.procuredQty > 0 ? t('far.procurementCost', 'Procurement cost') : t('far.cost')}</span>
                <span style={{ fontSize: 18, fontWeight: 800, color: '#15803D' }}>{drillEntry.cost ? inr(drillEntry.cost) : t('far.inHouseNoPart')}</span>
              </div>
              {drillEntry.billUrl && (
                <a href={drillEntry.billUrl} target="_blank" rel="noreferrer" style={{ display: 'block', textAlign: 'center', marginTop: 10, fontSize: 12, color: '#2563EB' }}>{t('far.viewSupplierBill', 'View supplier bill')} ↗</a>
              )}
              <button type="button" onClick={() => navigate(`/dashboard/purchase/maint?ticket=${drillEntry.id}&${backHere()}`)} style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: 14, fontSize: 12, color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>{t('far.openInMaintenance')} →</button>
            </div>
          );
        })()}
      </SlidePanel>

      {/* Machine-photo viewer (PIC column) */}
      <ImageLightbox images={picView || []} open={!!picView} onClose={() => setPicView(null)} />
    </>
  );
}
