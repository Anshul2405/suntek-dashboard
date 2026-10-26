import React, { useState, useEffect } from 'react';
import { formatDate } from '../../../lib/utils/formatting';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Download, ShoppingCart, Package, Truck, Hourglass, IndianRupee, ReceiptText } from 'lucide-react';
import { ImageLightbox, type LightboxImage } from '../../../components/ui/ImageLightbox';
import { supabase } from '../../../lib/supabase';
import { insertRows } from '../../../lib/db';
import { useMentionNotifier } from '../../../lib/mentions';
import { useBlacklistGuard } from '../../../lib/blacklist/guard';
import { exportToXlsx } from '../../../lib/utils/exportXlsx';
import { useRoleContext } from '../../../contexts/RoleContext';
import { profileHasCapability } from '../../../lib/profiles';
import { SlidePanel, PanelField, PanelInput, PanelSelect, PanelTextarea, PanelRow, PanelDivider, PanelSection, OcrUpload, PanelFooter } from '../../../components/SlidePanel';
import { KpiInfoButton } from '../../../components/KpiInfoButton';
import { useToast } from '../../../components/ui/toast';
import { SkeletonRows, ErrorState, EmptyState } from '../../../components/ui/states';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../../components/v2';
import { useTextFilter } from '../../../components/ui/TableSearch';
import { useSortable } from '../../../components/ui/useSortable';
import { ThV2 as Th, StatCard, SectionCard, FilterBar, ButtonV2, InfoBanner } from '../../../components/v2';
import { AddPurchaseModal } from './AddPurchaseModal';
import { BusyPurchasesCard } from '../../../components/BusyPurchasesCard';
import { fmtINR, useOverviewKPIs } from '../../../hooks/useBusyData';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import type { Database } from '../../../lib/database.types';

/** Operations → Purchase: Busy invoices only (read-only). Factory → Purchase Orders is a different screen. */
function BusyPurchaseOpsPage() {
  const { t } = useTranslation();
  const { data: overview } = useOverviewKPIs();
  return (
    <>
      <div className="grid grid-cols-12 gap-4 mb-4">
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<IndianRupee />} tone="blue"
          label={t('overview.purchasePaidMtd', 'Purchase paid · MTD')}
          value={overview ? fmtINR(overview.purchaseMTD) : '…'}
          caption={t('overview.busyReadOnly', 'From the last Busy read. Never written back.')} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<ReceiptText />} tone="purple"
          label={t('overview.busyInvoicesFy', 'Purchase invoices · FY')}
          value={overview ? String(overview.purchaseInvoiceCount) : '…'}
          caption={overview?.fyPurchase != null ? fmtINR(overview.fyPurchase) : undefined} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<Hourglass />} tone="amber"
          label={t('overview.busyPendingBills', 'Pending bills')}
          value={overview ? fmtINR(overview.pendingBills) : '…'} />
        <StatCard className="col-span-12 sm:col-span-6 lg:col-span-3" icon={<Package />} tone="green"
          label={t('overview.busyFyPurchase', 'FY purchase')}
          value={overview ? fmtINR(overview.fyPurchase) : '…'} />
      </div>
      <BusyPurchasesCard />
    </>
  );
}

type OrderRow = Database['public']['Tables']['oil_contracts']['Row'];
type MaintStoreReq = Database['public']['Tables']['maintenance_store_requests']['Row'];
type MaintTicket = Database['public']['Tables']['maintenance_tickets']['Row'] & { plants?: { name: string | null } | null };

const UNIT_LABELS: Record<string, string> = { chlorides: 'Suntek Chlorides', plasticiser: 'Suntek Plasticiser' };

/** An externally-bought maintenance part, DERIVED from a store request (single source). */
interface MaintPO {
  id: string; ticketRef: string; ticketId: string; part: string; equipment: string; store: string; supplier: string;
  qty: number; unitPrice: number | null; total: number | null;
  // Bulk supplier bill (per ticket) — used when a single bill covers several procured parts.
  billTotal: number | null; billItems: number | null; billUrl: string | null;
  date: string | null; busyRef: string | null;
}

function PicBadge({ has }: { has: boolean }) {
  const { t } = useTranslation();
  return (
    <span className={`pic-badge${has ? '' : ' missing'}`} title={has ? t('po.pic_on_file', 'Pic on file') : t('po.no_pic_yet', 'No pic yet')}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
    </span>
  );
}

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  approved:   { bg: '#FEF3C7', color: '#D97706', label: 'APPROVED'   },
  dispatched: { bg: '#DCFCE7', color: '#16A34A', label: 'DISPATCHED' },
  received:   { bg: '#DBEAFE', color: '#2563EB', label: 'RECEIVED'   },
  pending:    { bg: '#F1F5F9', color: '#475569', label: 'PENDING'    },
};

// Non-factory destinations. Factories come from the `plants` table via
// PlantScopeContext — never hard-coded, or a factory rename would leave this
// dropdown offering names that no longer exist.
const PORTS = ['Kandla', 'Mundra'];
const UNITS  = ['nos', 'Ft', 'kg', 'MT', 'L', 'sets', 'boxes'];

export function PurchaseOrders() {
  const [searchParams] = useSearchParams();
  if (searchParams.get('ctx') === 'ops') return <BusyPurchaseOpsPage />;
  return <PurchaseOrderRegister />;
}

function PurchaseOrderRegister() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [billLightbox, setBillLightbox] = useState<LightboxImage[] | null>(null);
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(false);
  const [showPurchase, setShowPurchase] = useState(false);
  const [saved, setSaved] = useState(false);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [maintPOs, setMaintPOs] = useState<MaintPO[]>([]); // derived from the maintenance flow
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { activeProfile } = useRoleContext();
  const { scopeQuery, allowedPlants } = usePlantScope();
  const [form, setForm] = useState({ material: '', type: 'PO', supplier: '', destination: '', qty: '', unit: 'nos', value: '', notes: '' });

  // Default the destination to the user's first factory once scope resolves.
  // Left blank until then rather than guessing a name.
  useEffect(() => {
    if (!form.destination && allowedPlants.length > 0) {
      setForm(f => (f.destination ? f : { ...f, destination: allowedPlants[0].name }));
    }
  }, [allowedPlants, form.destination]);

  async function load() {
    try {
      const { data, error } = await scopeQuery(supabase.from('oil_contracts').select('*'))
        .order('created_at', { ascending: false })
        .returns<OrderRow[]>();
      if (error) throw error;
      setOrders(data || []);

      // Derive externally-bought maintenance parts (store said "not available")
      // straight from the maintenance flow — single source, always in sync.
      const { data: tickets } = await supabase.from('maintenance_tickets')
        .select('*, plants(name)').eq('type', 'emergency').returns<MaintTicket[]>();
      const tIds = (tickets || []).map(t => t.id);
      let srs: MaintStoreReq[] = [];
      if (tIds.length) {
        const { data: srData } = await supabase.from('maintenance_store_requests').select('*').in('ticket_id', tIds).returns<MaintStoreReq[]>();
        srs = srData || [];
      }
      const tById = new Map((tickets || []).map(t => [t.id, t]));
      const mpos: MaintPO[] = srs
        .filter(s => s.store_decision === 'unavailable' && (s.busy_transaction_ref || s.supplier_name || s.total_price != null))
        .map(s => {
          const t = tById.get(s.ticket_id);
          const store = t?.unit ? (UNIT_LABELS[t.unit] || t.unit) : (t?.plants?.name || '—');
          return {
            id: s.id, ticketRef: s.ticket_id.slice(0, 8), ticketId: s.ticket_id, part: s.part_name, equipment: t?.equipment || '', store,
            supplier: s.supplier_name || '—', qty: Number(s.quantity ?? 0),
            unitPrice: s.unit_price != null ? Number(s.unit_price) : null,
            total: s.total_price != null ? Number(s.total_price) : null,
            billTotal: t?.pm_bill_total != null ? Number(t.pm_bill_total) : null,
            billItems: t?.pm_items_count != null ? Number(t.pm_items_count) : null,
            billUrl: t?.pm_bill_url ?? s.handover_invoice_url ?? null,
            date: t?.closed_at || t?.created_at || null, busyRef: s.busy_transaction_ref,
          };
        });
      setMaintPOs(mpos);
      setLoadError(false);
    } catch (err) {
      console.error('[PurchaseOrders] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    if (!form.material.trim() || !form.supplier.trim()) return;
    const { data, error } = await insertRows('oil_contracts', {
      oil_type: form.material,
      company: form.supplier,
      date: new Date().toISOString().split('T')[0],
      book_qty_mt: parseFloat(form.qty) || null,
      price: form.value ? parseFloat(form.value.replace(/[^0-9.]/g, '')) : null,
      port: form.destination,
    }).select('*').single();

    if (error) { toast.error(t('po.toast_save_failed', { msg: error.message })); return; }
    if (data) setOrders(prev => [data as OrderRow, ...prev]);
    await notifyMentions(form.notes, {
      entityType: 'oil_contract', entityId: (data as OrderRow | undefined)?.id,
      entityLabel: t('po.entity_label', { defaultValue: 'PO · {{name}}', name: form.material || form.supplier }),
      route: '/dashboard/purchase/purchase',
    });
    // Screen the supplier/material against the blacklist (vendor risk).
    const hits = await screenBlacklist(
      [{ value: form.supplier, label: t('po.ocr_f_supplier') }, { value: form.material, label: t('po.field_material_short', 'Material') }],
      { workflow: 'Purchase Orders', source: 'entry', entityLabel: t('po.entity_label', { defaultValue: 'PO · {{name}}', name: form.material || form.supplier }) },
    );
    if (hits.length) {
      const h = hits[0];
      toast.error(t('po.toast_blacklist_hit', { value: h.candidate.value, type: h.entry.type, name: h.entry.name, pct: Math.round(h.score * 100) }));
    }
    setSaved(true);
    setTimeout(() => { setOpen(false); setSaved(false); setForm({ material: '', type: 'PO', supplier: '', destination: allowedPlants[0]?.name ?? '', qty: '', unit: 'nos', value: '', notes: '' }); }, 1600);
  }

  function handleClose() { setOpen(false); setSaved(false); }

  function handleExport() {
    const rows = (filter === 'all' ? orders : orders.filter(r => r.status === filter));
    exportToXlsx(
      rows.map(r => ({ material: r.oil_type, supplier: r.company, destination: r.port, quantity: r.book_qty_mt, dispatched: r.dispatched_qty, pending: r.pending_qty, price: r.price })),
      [
        { header: 'Material / Oil Type', key: 'material' },
        { header: 'Supplier', key: 'supplier' },
        { header: 'Port / Destination', key: 'destination' },
        { header: 'Booked Qty (MT)', key: 'quantity' },
        { header: 'Dispatched (MT)', key: 'dispatched' },
        { header: 'Pending (MT)', key: 'pending' },
        { header: 'Price (₹)', key: 'price' },
      ],
      'purchase-orders',
      activeProfile,
      'Purchase Orders',
    );
  }

  const list = filter === 'all' ? orders : orders.filter(r => r.status === filter);
  const [poSearch, setPoSearch] = useState('');
  const filteredList = useTextFilter(list, poSearch, r => [r.oil_type, r.paraffin_type, r.company, r.port]);
  const ordersSort = useSortable(filteredList, {
    oil: r => r.oil_type, paraffin: r => r.paraffin_type, company: r => r.company, port: r => r.port,
    booked: r => r.book_qty_mt, dispatched: r => r.dispatched_qty, pending: r => r.pending_qty,
    price: r => r.price, date: r => r.date,
  });
  const ordersPg = usePagination(ordersSort.sorted, { resetKey: `${poSearch}|${filter}|${ordersSort.sort.key}|${ordersSort.sort.dir}` });
  const maintSort = useSortable(maintPOs, {
    ticket: r => r.ticketRef, part: r => r.part, equipment: r => r.equipment, store: r => r.store,
    supplier: r => r.supplier, qty: r => r.qty, unitPrice: r => r.unitPrice, total: r => r.total,
    busyRef: r => r.busyRef, date: r => (r.date ? new Date(r.date) : null),
  }, { key: 'date', dir: 'desc' }); // default: latest first
  const maintPg = usePagination(maintSort.sorted, { resetKey: `${maintSort.sort.key}|${maintSort.sort.dir}` });

  return (
    <>
      {/* Add purchased spares to the stock register (bill AI or manual) —
          capability-gated; the RPC re-enforces this server-side. */}
      {profileHasCapability(activeProfile, 'add_stock_purchase') && (
        <>
          <SectionCard
            className="mb-4"
            title={t('po.add_stock_title', 'Add purchase to stock register')}
            subtitle={t('po.add_stock_sub', 'Bought new spares? Upload the bill (image / PDF) to auto-read items & quantities, or enter them manually — matched items increment, new items are created.')}
            actions={
              <ButtonV2 variant="accent" icon={<Plus />} onClick={() => setShowPurchase(true)}>
                {t('po.btn_add_purchase', 'Add purchase')}
              </ButtonV2>
            }
          />
          <AddPurchaseModal open={showPurchase} onClose={() => setShowPurchase(false)} onApplied={() => {}} />
        </>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Total Orders', what: 'Total count of oil/material purchase contracts on record.', source: 'Supabase', tables: ['oil_contracts'] }} />
          <StatCard className="h-full" icon={<ShoppingCart />} tone="blue"
            label={t('po.kpi_total_orders')} value={orders.length + maintPOs.length}
            caption={t('po.kpi_total_sub', { a: orders.length, b: maintPOs.length })} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Total Booked Qty', what: 'Sum of all booked quantities (MT) across all purchase orders.', source: 'Supabase', tables: ['oil_contracts'] }} />
          <StatCard className="h-full" icon={<Package />} tone="purple"
            label={t('po.kpi_booked_qty')}
            value={orders.reduce((s, r) => s + (r.book_qty_mt || 0), 0).toFixed(0)}
            caption={t('po.kpi_across_all_pos')} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Dispatched', what: 'Total quantity already dispatched from suppliers.', source: 'Supabase', tables: ['oil_contracts'] }} />
          <StatCard className="h-full" icon={<Truck />} tone="green" valueTone="green"
            label={t('po.kpi_dispatched')}
            value={orders.reduce((s, r) => s + (r.dispatched_qty || 0), 0).toFixed(0)} />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3 relative">
          <KpiInfoButton info={{ title: 'Pending Qty', what: 'Total quantity still pending dispatch from suppliers.', source: 'Supabase', tables: ['oil_contracts'] }} />
          <StatCard className="h-full" icon={<Hourglass />} tone="amber" valueTone="amber"
            label={t('po.kpi_pending')}
            value={orders.reduce((s, r) => s + (r.pending_qty || 0), 0).toFixed(0)} />
        </div>
      </div>

      {/* Search / filters */}
      <FilterBar
        className="mb-4"
        search={poSearch} onSearch={setPoSearch}
        searchPlaceholder={t('po.search_ph', 'Search material, company, port…')}
        onReset={() => setPoSearch('')}
      />

      {/* Table — material / oil purchase orders */}
      <div className="relative">
        <KpiInfoButton info={{ title: 'Purchase Orders List', what: 'All oil/material purchase contracts. New entries via "+ New PO" form.', source: 'Supabase', tables: ['oil_contracts'] }} />
        <SectionCard
          flush
          title={
            <span className="inline-flex items-center gap-2 flex-wrap">
              {t('po.section_material_oil')}
              <span className="badge" style={{ background: '#E0E7FF', color: '#4338CA', fontWeight: 700, fontSize: 10 }}>⟳ BUSY API</span>
            </span>
          }
          subtitle={t('po.section_material_oil_sub')}
          actions={
            <>
              <ButtonV2 variant="outline" icon={<Download />} onClick={handleExport}>
                {t('po.btn_export')}
              </ButtonV2>
              <ButtonV2 variant="accent" icon={<Plus />} onClick={() => setOpen(true)}>
                {t('po.btn_new_po')}
              </ButtonV2>
            </>
          }
        >
          {/* BUSY integration status — these POs will auto-sync from BUSY; manual entry is the stopgap until then. */}
          <div className="px-5 pb-4">
            <InfoBanner><b>{t('po.busy_sync_title')}</b> {t('po.busy_sync_body')}</InfoBanner>
          </div>
          {loadError ? (
            <div className="px-5 pb-5">
              <ErrorState title={t('po.error_load_title')} message={t('po.error_load_msg')}
                onRetry={() => { setLoading(true); setLoadError(false); load(); }} />
            </div>
          ) : loading ? (
            <div className="px-5 pb-5"><SkeletonRows rows={6} /></div>
          ) : filteredList.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState title={t('po.empty_orders')} message={poSearch ? t('common.noMatches', 'No rows match your search.') : undefined} />
            </div>
          ) : (
          <>
          <div className="overflow-x-auto scroll-x">
            <table className="dt2">
              <thead>
                <tr>
                  <Th sortKey="oil" s={ordersSort}>{t('po.col_oil_material')}</Th><Th sortKey="paraffin" s={ordersSort}>{t('po.col_paraffin_type')}</Th><Th sortKey="company" s={ordersSort}>{t('po.col_company')}</Th>
                  <Th sortKey="port" s={ordersSort}>{t('po.col_port_dest')}</Th><Th sortKey="booked" s={ordersSort} firstDir="desc" className="num">{t('po.col_booked_mt')}</Th>
                  <Th sortKey="dispatched" s={ordersSort} firstDir="desc" className="num">{t('po.col_dispatched_mt')}</Th><Th sortKey="pending" s={ordersSort} firstDir="desc" className="num">{t('po.col_pending_mt')}</Th>
                  <Th sortKey="price" s={ordersSort} firstDir="desc" className="num">{t('po.col_price')}</Th><Th sortKey="date" s={ordersSort} firstDir="desc">{t('po.col_date')}</Th>
                </tr>
              </thead>
              <tbody>
                {ordersPg.pageRows.map(r => (
                  <tr key={r.id}>
                    <td className="font-semibold">{r.oil_type || '—'}</td>
                    <td className="text-slate-500">{r.paraffin_type || '—'}</td>
                    <td>{r.company || '—'}</td>
                    <td>{r.port || '—'}</td>
                    <td className="num">{r.book_qty_mt ?? '—'}</td>
                    <td className="num text-green-700">{r.dispatched_qty ?? '—'}</td>
                    <td className="num text-amber-700">{r.pending_qty ?? '—'}</td>
                    <td className="num font-semibold">{r.price ? `₹ ${Number(r.price).toLocaleString('en-IN')}` : '—'}</td>
                    <td className="text-slate-500 text-xs">{formatDate(r.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination controls={ordersPg.controls} />
          </>
          )}
        </SectionCard>
      </div>

      {/* ── Maintenance purchases (derived from the maintenance flow) ─────────── */}
      <SectionCard
        flush
        className="mt-4"
        title={
          <span className="inline-flex items-center gap-2 flex-wrap">
            {t('po.section_maint')}
            <span className="badge" style={{ background: '#DCFCE7', color: '#15803D', fontWeight: 700, fontSize: 10 }}>⚙ {t('po.badge_from_maint')}</span>
          </span>
        }
        subtitle={t('po.section_maint_sub')}
        actions={
          <span className="text-xs num font-bold text-slate-700">{t('po.total')} ₹ {maintPOs.reduce((s, m) => s + (m.total || 0), 0).toLocaleString('en-IN')}</span>
        }
      >
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead><tr><Th sortKey="ticket" s={maintSort}>{t('po.col_ticket')}</Th><Th sortKey="part" s={maintSort}>{t('po.col_part')}</Th><Th sortKey="equipment" s={maintSort}>{t('po.col_equipment')}</Th><Th sortKey="store" s={maintSort}>{t('po.col_store_unit')}</Th><Th sortKey="supplier" s={maintSort}>{t('po.col_supplier')}</Th><Th sortKey="qty" s={maintSort} firstDir="desc" className="num">{t('po.col_qty')}</Th><Th sortKey="unitPrice" s={maintSort} firstDir="desc" className="num">{t('po.col_unit_price')}</Th><Th sortKey="total" s={maintSort} firstDir="desc" className="num">{t('po.col_total')}</Th><Th sortKey="busyRef" s={maintSort}>{t('po.col_busy_ref')}</Th><th>{t('po.col_bill', 'Bill')}</th><Th sortKey="date" s={maintSort} firstDir="desc">{t('po.col_date')}</Th></tr></thead>
            <tbody>
              {maintPOs.length === 0 && (
                <tr><td colSpan={11} className="text-center text-slate-400 py-6 text-sm">{t('po.empty_maint')}</td></tr>
              )}
              {maintPg.pageRows.map(m => {
                const totalCost = m.total ?? m.billTotal;
                return (
                <tr key={m.id}>
                  <td><button type="button" onClick={() => navigate(`/dashboard/purchase/maint?ticket=${m.ticketId}`)} className="num text-xs" style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }} title={t('po.open_ticket', 'Open maintenance ticket')}>#{m.ticketRef}</button></td>
                  <td className="font-semibold">{m.part}</td>
                  <td className="text-slate-500 text-xs">{m.equipment}</td>
                  <td className="text-slate-500 text-xs">{m.store}</td>
                  <td>{m.supplier}</td>
                  <td className="num">{m.qty}</td>
                  {/* Bulk bills have no per-unit price → show the bill's line-item count instead. */}
                  <td className="num">{m.unitPrice != null ? `₹ ${m.unitPrice.toLocaleString('en-IN')}` : (m.billItems ? <span className="text-xs text-slate-400">{t('po.on_bill', { defaultValue: '{{n}} on bill', n: m.billItems })}</span> : '—')}</td>
                  <td className="num font-semibold">{totalCost != null ? `₹ ${Number(totalCost).toLocaleString('en-IN')}` : '—'}</td>
                  <td className="text-slate-500 text-xs">{m.busyRef || '—'}</td>
                  <td>{m.billUrl ? <button type="button" onClick={() => setBillLightbox([{ url: m.billUrl as string, label: t('po.bill_lightbox_label', { defaultValue: 'Supplier bill · #{{ref}}', ref: m.ticketRef }) }])} style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, textDecoration: 'underline' }}>{t('common.view', 'View')}</button> : <span className="text-slate-300 text-xs">—</span>}</td>
                  <td className="text-slate-500 text-xs">{m.date ? formatDate(m.date) : '—'}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <TablePagination controls={maintPg.controls} />
      </SectionCard>

      <ImageLightbox images={billLightbox || []} open={!!billLightbox} onClose={() => setBillLightbox(null)} />

      {/* Modal */}
      <SlidePanel open={open} onClose={handleClose} title={t('po.panel_title')} subtitle={t('po.panel_subtitle')}>
        <PanelSection title={t('po.panel_section_order')}>
          <PanelRow>
            <PanelField label={t('po.field_material')}>
              <PanelInput placeholder={t('po.ph_material')} value={form.material} onChange={e => set('material', e.target.value)} />
            </PanelField>
            <PanelField label={t('po.field_supplier')}>
              <PanelInput placeholder={t('po.ph_supplier')} value={form.supplier} onChange={e => set('supplier', e.target.value)} />
            </PanelField>
          </PanelRow>

          <PanelRow cols={3}>
            <PanelField label={t('po.field_destination')}>
              <PanelSelect value={form.destination} onChange={e => set('destination', e.target.value)}>
                {!form.destination && <option value="">{t('po.opt_select_destination', 'Select destination…')}</option>}
                {allowedPlants.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                {PORTS.map(p => <option key={p} value={p}>{p}</option>)}
                <option value="Port">{t('po.opt_port', 'Port')}</option>
              </PanelSelect>
            </PanelField>
            <PanelField label={t('po.field_unit')}>
              <PanelSelect value={form.unit} onChange={e => set('unit', e.target.value)}>
                {UNITS.map(u => <option key={u}>{u}</option>)}
              </PanelSelect>
            </PanelField>
          </PanelRow>

          <PanelRow>
            <PanelField label={t('po.field_quantity')}>
              <PanelInput type="number" placeholder={t('po.ph_quantity')} value={form.qty} onChange={e => set('qty', e.target.value)} />
            </PanelField>
            <PanelField label={t('po.field_price')}>
              <PanelInput placeholder={t('po.ph_price')} value={form.value} onChange={e => set('value', e.target.value)} />
            </PanelField>
          </PanelRow>

          <PanelField label={t('po.field_notes')}>
            <PanelTextarea placeholder={t('po.ph_notes')} value={form.notes} onChange={e => set('notes', e.target.value)} />
          </PanelField>
        </PanelSection>

        <PanelDivider />

        <OcrUpload
          label={t('po.ocr_label')}
          hint={t('po.ocr_hint')}
          fields={[
            { key: 'supplier',  label: t('po.ocr_f_supplier'),  value: 'Indo Gulf Fertilisers Ltd' },
            { key: 'material',  label: t('po.ocr_f_material'),   value: 'PP Granules H110MA' },
            { key: 'qty',       label: t('po.ocr_f_quantity'),   value: '500' },
            { key: 'unit',      label: t('po.ocr_f_unit'),       value: 'MT' },
            { key: 'value',     label: t('po.ocr_f_value'),      value: '42,00,000' },
          ]}
          onExtracted={data => {
            if (data.supplier) set('supplier', data.supplier);
            if (data.material) set('material', data.material);
            if (data.qty)      set('qty', data.qty);
            if (data.unit)     set('unit', data.unit);
            if (data.value)    set('value', data.value);
          }}
        />

        <PanelFooter
          saved={saved}
          onCancel={handleClose}
          onSave={handleSave}
          saveLabel={t('po.footer_save')}
          successLabel={t('po.footer_success')}
          successSub={t('po.footer_success_sub')}
          disabled={!form.material.trim() || !form.supplier.trim()}
          requiredHint={t('po.footer_required_hint')}
        />
      </SlidePanel>
    </>
  );
}
