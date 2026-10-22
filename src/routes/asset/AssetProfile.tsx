import React, { useEffect, useMemo, useState, useRef } from 'react';
import { ticketNoLabel } from '../../lib/ticketNo';
import { formatDate, formatDateTime } from '../../lib/utils/formatting';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QRCodeCanvas } from 'qrcode.react';
import {
  ArrowLeft, Printer, Download, Pencil, Wrench, AlertTriangle, ShieldCheck, CalendarDays,
  Clock, PackageSearch, Hourglass, History, FileText, ScrollText, ChevronRight,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useRoleContext } from '../../contexts/RoleContext';
import { statusBadge } from '../dashboard/purchase/maintenance/shared';
import { matchAsset } from '../../lib/far/assets';
import { ButtonV2, StatusPill } from '../../components/v2';
import { ImageLightbox, type LightboxImage } from '../../components/ui/ImageLightbox';
import { assetQrUrl, downloadDataUrl, printQrLabel, safeFileName } from '../../lib/far/qr';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell,
} from 'recharts';
import type { Database } from '../../lib/database.types';

// ── Small presentational helpers (theme-matched) ───────────────────────────────

/** Section card title — bold, with a green accent tick (per v2 mockup). */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span style={{ width: 4, height: 15, borderRadius: 2, background: '#22C55E' }} />
      <h2 className="text-[15px] font-bold font-heading text-slate-900 font-heading">{children}</h2>
    </div>
  );
}

/** v2 KPI tile — big number left, small muted icon right, gray label below. */
function Stat({ label, value, color, icon, small }: { label: string; value: React.ReactNode; color?: string; icon?: React.ReactNode; small?: boolean }) {
  return (
    <div className="card2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="font-bold leading-none" style={{ color: color || '#0F172A', fontSize: small ? 15 : 24, paddingTop: small ? 5 : 0 }}>{value}</div>
        {icon && <span className="text-slate-300 inline-flex [&>svg]:w-4 [&>svg]:h-4">{icon}</span>}
      </div>
      <div className="text-[11px] text-slate-500 font-medium mt-2.5 leading-tight">{label}</div>
    </div>
  );
}

/** One field in the spec sheet — label over value, so it tiles into a grid. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="py-2.5 min-w-0" style={{ borderBottom: '1px solid var(--border-2)' }}>
      <div className="text-[10.5px] uppercase tracking-wide text-slate-400 font-semibold">{label}</div>
      <div className="text-[13.5px] font-semibold text-slate-800 mt-0.5 truncate" title={typeof value === 'string' ? value : undefined}>
        {value || '—'}
      </div>
    </div>
  );
}

type AssetRow = Database['public']['Tables']['fixed_assets']['Row'] & { plants?: { name: string | null } | null };
type TicketRow = Database['public']['Tables']['maintenance_tickets']['Row'] & { plants?: { name: string | null } | null };
type ScheduleRow = Database['public']['Tables']['maintenance_schedules']['Row'];
type PartRow = Database['public']['Tables']['maintenance_store_requests']['Row'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmtDate = (d: string | null | undefined) => formatDate(d);
const fmtDateTime = (d: string | null | undefined) => formatDateTime(d);

function Screen({ emoji, title, sub }: { emoji: string; title: string; sub: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)' }}>
      <div className="card2 p-8" style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>{emoji}</div>
        <div className="font-heading font-semibold" style={{ fontSize: 26, color: '#0F172A', lineHeight: 1.1 }}>{title}</div>
        <div style={{ fontSize: 13, color: '#64748B', marginTop: 8, lineHeight: 1.5 }}>{sub}</div>
      </div>
    </div>
  );
}

/**
 * Standalone, mobile-first Asset Profile — the QR landing page. Aggregates a
 * single fixed asset's details + full maintenance history + operational stats
 * from the existing tables (no duplicate storage). Reached by scanning the asset
 * QR (`/asset/:key` where key is the qr_token) or internally by asset id.
 * Behind RequireLogin (route) + the `view_asset_profile` capability.
 */
export function AssetProfile() {
  const { key = '' } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { can, authResolved } = useRoleContext();

  const [loading, setLoading] = useState(true);
  const qrCanvasRef = useRef<HTMLDivElement>(null);
  const [photoView, setPhotoView] = useState<LightboxImage[] | null>(null);
  const [asset, setAsset] = useState<AssetRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);

  const allowed = can('view_asset_profile');
  const showAnalytics = can('view_asset_analytics');

  useEffect(() => {
    if (!authResolved || !allowed) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setNotFound(false);
      // Resolve by qr_token first (what the QR encodes), then by id (internal links).
      let a: AssetRow | null = null;
      const { data: byToken } = await supabase.from('fixed_assets').select('*, plants(name)').eq('qr_token', key).limit(1).returns<AssetRow[]>();
      a = byToken?.[0] ?? null;
      if (!a && UUID_RE.test(key)) {
        const { data: byId } = await supabase.from('fixed_assets').select('*, plants(name)').eq('id', key).limit(1).returns<AssetRow[]>();
        a = byId?.[0] ?? null;
      }
      if (cancelled) return;
      if (!a) { setNotFound(true); setLoading(false); return; }
      setAsset(a);

      // ── Aggregate history ──────────────────────────────────────────────
      // 1) reliable FK link (all ticket types raised after the source-fix)
      const { data: fk } = await supabase.from('maintenance_tickets').select('*, plants(name)').eq('far_asset_id', a.id).returns<TicketRow[]>();
      // 2) periodic schedules for this asset → legacy periodic tickets + next-due
      const { data: scheds } = await supabase.from('maintenance_schedules').select('*').eq('far_asset_id', a.id).returns<ScheduleRow[]>();
      const schedIds = (scheds || []).map(s => s.id);
      let periodicLegacy: TicketRow[] = [];
      if (schedIds.length) {
        const { data } = await supabase.from('maintenance_tickets').select('*, plants(name)').in('schedule_id', schedIds).returns<TicketRow[]>();
        periodicLegacy = data || [];
      }
      // 3) legacy emergency tickets — no FK; match by normalized mark only (mark-exact,
      //    never fuzzy name, to avoid over-attributing same-type tickets), scoped by plant.
      let emergencyLegacy: TicketRow[] = [];
      if (a.identification_mark) {
        let q = supabase.from('maintenance_tickets').select('*, plants(name)').eq('type', 'emergency').is('far_asset_id', null);
        if (a.plant_id) q = q.eq('plant_id', a.plant_id);
        const { data } = await q.limit(1000).returns<TicketRow[]>();
        const one = [{ id: a.id, name: a.name, identification_mark: a.identification_mark }];
        emergencyLegacy = (data || []).filter(tk => {
          const m = matchAsset(tk.equipment || '', one);
          return !!m && m.via === 'mark' && m.asset.id === a!.id;
        });
      }
      if (cancelled) return;
      const map = new Map<string, TicketRow>();
      for (const tk of [...(fk || []), ...periodicLegacy, ...emergencyLegacy]) map.set(tk.id, tk);
      const merged = [...map.values()].sort((x, y) => (y.created_at || '').localeCompare(x.created_at || ''));
      setTickets(merged);
      setSchedules(scheds || []);

      const ticketIds = merged.map(tk => tk.id);
      if (ticketIds.length) {
        const { data: pr } = await supabase.from('maintenance_store_requests').select('*').in('ticket_id', ticketIds).returns<PartRow[]>();
        if (!cancelled) setParts(pr || []);
      } else { setParts([]); }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [key, authResolved, allowed]);

  // ── Derived stats ──────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const emergency = tickets.filter(tk => tk.type === 'emergency').length;
    const periodic = tickets.filter(tk => tk.type === 'periodic').length;
    const dates = tickets.map(tk => tk.closed_at || tk.created_at).filter(Boolean).map(d => new Date(d as string).getTime()).sort((a, b) => a - b);
    const last = dates.length ? new Date(dates[dates.length - 1]).toISOString() : null;
    let avgDays: number | null = null;
    if (dates.length >= 2) {
      let sum = 0; for (let i = 1; i < dates.length; i++) sum += (dates[i] - dates[i - 1]);
      avgDays = Math.round(sum / (dates.length - 1) / 86400000);
    }
    const nextDue = (schedules.filter(s => s.is_active && s.next_due_at).map(s => s.next_due_at as string).sort())[0] || null;
    const openCount = tickets.filter(tk => tk.status && tk.status !== 'closed').length;
    return { total: tickets.length, emergency, periodic, last, avgDays, nextDue, openCount };
  }, [tickets, schedules]);

  const perMonth = useMemo(() => {
    const m = new Map<string, number>();
    for (const tk of tickets) {
      const d = new Date(tk.created_at);
      if (isNaN(d.getTime())) continue;
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12).map(([k, count]) => {
      const [y, mo] = k.split('-');
      return { month: new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }), count };
    });
  }, [tickets]);

  const typeSplit = useMemo(() => [
    { name: t('far.apEmergency', 'Emergency'), value: stats.emergency, color: '#DC2626' },
    { name: t('far.apPreventive', 'Preventive'), value: stats.periodic, color: '#2563EB' },
  ].filter(d => d.value > 0), [stats, t]);

  // ── Guards ─────────────────────────────────────────────────────────────
  if (!authResolved) return <Screen emoji="⏳" title={t('far.apLoading', 'Loading…')} sub={t('far.apCheckingAccess', 'Checking your access.')} />;
  if (!allowed) return <Screen emoji="🔒" title={t('far.apAccessRestricted', 'Access restricted')} sub={t('far.apAccessRestrictedSub', "You don't have permission to view asset profiles. Ask an administrator to grant you the 'View asset profile' permission.")} />;
  if (loading) return <Screen emoji="⏳" title={t('far.qrLoadingAsset', 'Loading asset…')} sub={t('far.apFetchingProfile', 'Fetching the digital profile.')} />;
  if (notFound || !asset) return <Screen emoji="🏷️" title={t('far.apQrNotRecognised', 'QR not recognised')} sub={t('far.apQrNotRecognisedSub', "This QR code isn't valid or has been regenerated. Ask an administrator for a fresh code.")} />;

  const rupees = asset.value != null ? `₹ ${Number(asset.value).toLocaleString('en-IN')}` : '—';
  const heroLabel = `${asset.name}${asset.identification_mark ? ` (${asset.identification_mark})` : ''}`;

  function qrPng(): string | null {
    const canvas = qrCanvasRef.current?.querySelector('canvas');
    return canvas ? canvas.toDataURL('image/png') : null;
  }
  function downloadQr() {
    const png = qrPng();
    if (png) downloadDataUrl(png, `QR-${safeFileName(heroLabel)}.png`);
  }
  function printQr() {
    const png = qrPng();
    if (png && asset) printQrLabel({ pngDataUrl: png, title: heroLabel, subtitle: asset.plants?.name || '', footer: t('far.qrPrintFooter', { defaultValue: 'Asset #{{id}} · scan to open the digital profile', id: asset.id.slice(0, 8) }) });
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F8FAFC' }}>
      {/* Hidden hi-res QR canvas powering Print QR / Download QR */}
      {asset.qr_token && (
        <div ref={qrCanvasRef} style={{ position: 'absolute', left: -99999, top: -99999 }} aria-hidden>
          <QRCodeCanvas value={assetQrUrl(asset.qr_token)} size={512} level="M" marginSize={2} />
        </div>
      )}
      <div className="mx-auto px-4 sm:px-6 py-6 sm:py-8" style={{ maxWidth: 1120 }}>

        {/* ── Breadcrumb + back ─────────────────────────────────────────────── */}
        <div className="text-[12px] text-slate-400 flex items-center gap-1.5 flex-wrap mb-3">
          <span>{t('nav.factory', 'Factory')}</span><span className="text-slate-300">›</span>
          <span>{t('nav.far', 'FAR')}</span><span className="text-slate-300">›</span>
          <span>{t('nav.qrCode', 'QR Code')}</span><span className="text-slate-300">›</span>
          <span className="text-slate-600 font-medium">{t('far.apAssetProfile', 'Asset Profile')}</span>
        </div>
        <div className="mb-4">
          <ButtonV2 variant="outline" icon={<ArrowLeft />} onClick={() => navigate('/dashboard/purchase/far')}>
            {t('far.apBackToAssets', 'Back to Assets')}
          </ButtonV2>
        </div>

        {/* ── Header card ───────────────────────────────────────────────────── */}
        <div className="card2 p-5 sm:p-6 mb-4 sm:mb-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5 flex-wrap">
            {asset.photo_url
              ? (
                <button
                  type="button"
                  onClick={() => setPhotoView([{ url: asset.photo_url as string, label: heroLabel }])}
                  title={t('far.apViewFullPhoto', 'View full photo')}
                  className="shrink-0 rounded-xl overflow-hidden border border-slate-200 bg-slate-50 hover:ring-2 hover:ring-slate-300 transition"
                  style={{ padding: 0, lineHeight: 0, cursor: 'zoom-in' }}
                >
                  <img src={asset.photo_url} alt={heroLabel} className="w-20 h-20 object-cover block" />
                </button>
              )
              : <div className="w-20 h-20 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-[28px] shrink-0">🏭</div>}
            <div className="min-w-0 flex-1">
              <div className="font-heading font-semibold text-[26px] leading-tight">{asset.name}</div>
              <div className="text-[13.5px] text-slate-500 mt-0.5">
                {asset.identification_mark ? <strong className="text-slate-700">{asset.identification_mark}</strong> : null}
                {asset.plants?.name ? `${asset.identification_mark ? '  •  ' : ''}${asset.plants.name}` : ''}
              </div>
              <div className="flex gap-2 mt-2.5 flex-wrap">
                {stats.openCount
                  ? <StatusPill tone="amber" dot label={t('far.apUnderMaintenance', 'Under maintenance')} />
                  : <StatusPill tone="green" dot label={t('far.apOperational', 'Operational')} />}
                <StatusPill tone="slate" label={t('far.apAssetNo', { defaultValue: 'Asset #{{id}}', id: asset.id.slice(0, 8) })} />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {asset.qr_token && (
                <>
                  <ButtonV2 variant="outline" icon={<Printer />} onClick={printQr}>{t('far.apPrintQr', 'Print QR')}</ButtonV2>
                  <ButtonV2 variant="outline" icon={<Download />} onClick={downloadQr}>{t('far.apDownloadQr', 'Download QR')}</ButtonV2>
                </>
              )}
              <ButtonV2 variant="outline" icon={<Pencil />} onClick={() => navigate('/dashboard/purchase/far')}>{t('far.apEditAsset', 'Edit Asset')}</ButtonV2>
            </div>
          </div>
        </div>

        {/* ── KPI strip ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4 sm:mb-5">
          <Stat label={t('far.apTotalMaintenance', 'Total Maintenance')} value={stats.total} icon={<Wrench />} />
          <Stat label={t('far.apEmergency', 'Emergency')} value={stats.emergency} color={stats.emergency ? '#DC2626' : undefined} icon={<AlertTriangle />} />
          <Stat label={t('far.apPreventive', 'Preventive')} value={stats.periodic} color={stats.periodic ? '#2563EB' : undefined} icon={<ShieldCheck />} />
          <Stat label={t('far.apAvgGapDays', 'Avg Gap (Days)')} value={stats.avgDays ?? '—'} icon={<CalendarDays />} />
          <Stat label={t('far.qrLastMaintenance', 'Last Maintenance')} value={fmtDate(stats.last)} icon={<Clock />} small />
          <Stat label={t('far.apNextScheduled', 'Next Scheduled')} value={fmtDate(stats.nextDue)} icon={<CalendarDays />} small />
          <Stat label={t('far.apPartsRequested', 'Parts Requested')} value={parts.length} icon={<PackageSearch />} />
          <Stat label={t('far.apOpenTickets', 'Open Tickets')} value={stats.openCount} color={stats.openCount ? '#D97706' : undefined} icon={<Hourglass />} />
        </div>

        {/* ── Details + Maintenance overview (2-col on desktop, stacks on mobile) ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 mb-4 sm:mb-5">

          {/* Asset spec sheet */}
          <div className="card2 p-5 sm:p-6 lg:col-span-2">
            <SectionTitle>{t('far.qrAssetDetails', 'Asset Details')}</SectionTitle>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6">
              <Field label={t('far.apFldEquipmentType', 'Equipment type')} value={asset.name} />
              <Field label={t('far.thIdMark', 'Identification mark')} value={asset.identification_mark} />
              <Field label={t('far.apFldQuantity', 'Quantity')} value={asset.quantity != null ? String(asset.quantity) : null} />
              <Field label={t('far.apFldMakeManufacturer', 'Make / manufacturer')} value={asset.make} />
              <Field label={t('far.thModel', 'Model')} value={asset.model} />
              <Field label={t('far.apFldSerialNo', 'Serial no')} value={asset.serial_no} />
              <Field label={t('far.apFldCapacityLineSize', 'Capacity / line size')} value={asset.capacity} />
              <Field label={t('far.apFldCountryOfOrigin', 'Country of origin')} value={asset.origin} />
              <Field label={t('far.apFldYearOfManufacturing', 'Year of manufacturing')} value={asset.year} />
              <Field label={t('far.thTaxableValue', 'Taxable value')} value={rupees} />
              <Field label={t('far.thInvoiceNo', 'Invoice no')} value={asset.invoice_no} />
              <Field label={t('far.thDateOfPurchase', 'Date of purchase')} value={fmtDate(asset.purchase_date)} />
              <Field label={t('far.thAccountHead', 'Account head')} value={asset.account_head} />
              <Field label={t('common.plant', 'Plant')} value={asset.plants?.name} />
            </div>
          </div>

          {/* Maintenance overview + quick actions (right column, per mockup) */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <div className="card2 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[15px] font-bold font-heading text-slate-900 font-heading">{t('far.apMaintenanceOverview', 'Maintenance Overview')}</h2>
                <button
                  onClick={() => navigate(`/dashboard/purchase/maint`)}
                  className="text-[12px] font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                >
                  {t('common.viewAll', 'View all')} →
                </button>
              </div>
              <div className="text-[11.5px] text-slate-400 font-medium">{t('far.qrLastMaintenance', 'Last Maintenance')}</div>
              <div className="text-[13px] font-semibold text-slate-800 mt-0.5 mb-3 flex items-center gap-1.5">
                <CalendarDays size={13} className="text-slate-400" /> {fmtDate(stats.last)}
              </div>
              <div className="text-[11.5px] text-slate-400 font-medium">{t('far.qrNextMaintenance', 'Next Maintenance')}</div>
              <div className="text-[13px] font-semibold text-slate-800 mt-0.5 mb-4 flex items-center gap-1.5">
                <CalendarDays size={13} className="text-slate-400" /> {fmtDate(stats.nextDue)}
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                <span className="text-[12px] text-slate-500">{t('far.apMaintenanceStatus', 'Maintenance Status')}</span>
                {stats.openCount
                  ? <StatusPill tone="amber" label={t('far.apUnderMaintenance', 'Under maintenance')} />
                  : <StatusPill tone="slate" label={t('far.apOperational', 'Operational')} />}
              </div>

              <div className="mt-5">
                <div className="text-[13px] font-bold text-slate-900 mb-1 font-heading">{t('far.apQuickActions', 'Quick Actions')}</div>
                {[
                  { key: 'history', icon: <History size={14} />, label: t('far.apViewMaintenanceHistory', 'View Maintenance History'), to: `/dashboard/purchase/maint` },
                  { key: 'docs', icon: <FileText size={14} />, label: t('far.apViewDocuments', 'View Documents'), to: `/dashboard/purchase/far` },
                  { key: 'activity', icon: <ScrollText size={14} />, label: t('far.apViewActivityLog', 'View Activity Log'), to: `/dashboard/purchase/activity` },
                ].map(a => (
                  <button
                    key={a.key}
                    onClick={() => navigate(a.to)}
                    className="w-full flex items-center gap-2.5 py-2.5 text-left text-[13px] text-slate-700 hover:text-slate-900 border-b border-slate-100 last:border-0"
                    style={{ background: 'none', border: 'none', borderBottom: '1px solid #F1F5F9', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    <span className="text-slate-400">{a.icon}</span>
                    <span className="flex-1">{a.label}</span>
                    <ChevronRight size={14} className="text-slate-300" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── Analytics: type split donut ──────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 mb-0">
          {/* Type split donut (analytics) */}
          {showAnalytics && stats.total > 0 && typeSplit.length > 0 && (
            <div className="card2 p-5 sm:p-6 lg:col-span-1 mb-4 sm:mb-5">
              <SectionTitle>{t('far.apMaintenanceMix', 'Maintenance mix')}</SectionTitle>
              <div className="flex items-center justify-center" style={{ position: 'relative', height: 176 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={typeSplit} dataKey="value" nameKey="name" innerRadius={56} outerRadius={82} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                      {typeSplit.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: '1px solid #E2E8F0', boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }} />
                  </PieChart>
                </ResponsiveContainer>
                {/* Center total */}
                <div style={{ position: 'absolute', textAlign: 'center', pointerEvents: 'none' }}>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#0F172A', lineHeight: 1 }}>{stats.total}</div>
                  <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{t('far.apRepairsWord', 'repairs')}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-1.5">
                {typeSplit.map((d) => (
                  <div key={d.name} className="flex items-center gap-2 text-[12.5px] text-slate-600">
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flexShrink: 0 }} />
                    <span className="flex-1">{d.name}</span>
                    <strong className="text-slate-900">{d.value}</strong>
                    <span className="text-slate-400 text-[11px]">{Math.round((d.value / stats.total) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        {/* ── Maintenance-per-month bar chart (analytics) ────────────────────── */}
        {showAnalytics && stats.total > 0 && (
          <div className="card2 p-5 sm:p-6 mb-4 sm:mb-5 lg:col-span-2">
            <SectionTitle>{t('far.apMaintenanceOverTime', 'Maintenance over time')}</SectionTitle>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={perMonth} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="28%">
                  <defs>
                    <linearGradient id="assetBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#FF8A66" />
                      <stop offset="100%" stopColor="#F47651" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF2F6" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} width={28} tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgba(244,118,81,0.06)' }}
                    contentStyle={{ fontSize: 12, borderRadius: 12, border: '1px solid #E2E8F0', boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
                  />
                  <Bar dataKey="count" name={t('far.apMaintenanceEvents', 'Maintenance events')} fill="url(#assetBar)" radius={[6, 6, 0, 0]} maxBarSize={44} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        </div>

        {/* ── Maintenance history ────────────────────────────────────────────── */}
        <div className="card2 p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <SectionTitle>{t('far.apMaintenanceHistory', 'Maintenance history')}</SectionTitle>
            <span className="pill-count" style={{ background: 'var(--bg-soft)', color: '#64748B' }}>{tickets.length}</span>
          </div>
          {tickets.length === 0 ? (
            <div className="text-[13px] text-slate-400 py-2">{t('far.apNoMaintRecords', 'No maintenance records for this asset yet.')}</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {tickets.map((tk) => {
                const isEmergency = tk.type === 'emergency';
                return (
                  <div
                    key={tk.id}
                    className="rounded-2xl hover:bg-slate-50 transition-colors"
                    style={{ border: '1px solid var(--border)', padding: '12px 14px', borderLeft: `3px solid ${isEmergency ? '#DC2626' : '#2563EB'}` }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => navigate(`/dashboard/purchase/maint?ticket=${tk.id}`)}
                        className="text-[12.5px] font-bold hover:underline"
                        style={{ color: '#2563EB', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
                      >
                        {ticketNoLabel(tk)}
                      </button>
                      <span className="badge" style={{ background: isEmergency ? 'var(--red-soft)' : 'var(--blue-soft)', color: isEmergency ? '#DC2626' : '#2563EB', fontWeight: 700 }}>
                        {isEmergency ? t('far.apEmergency', 'Emergency') : t('far.apPreventive', 'Preventive')}
                      </span>
                      {statusBadge(tk.status)}
                      <span className="text-[11px] text-slate-400 ml-auto">{fmtDateTime(tk.created_at)}</span>
                    </div>
                    <div className="text-[13.5px] font-semibold text-slate-900 mt-2">{tk.title || tk.equipment}</div>
                    {tk.description && <div className="text-[12px] text-slate-500 mt-1 leading-relaxed">{tk.description}</div>}
                    {(tk.assigned_to || tk.raised_by || tk.closed_at) && (
                      <div className="text-[11px] text-slate-400 mt-1.5">
                        {tk.assigned_to || tk.raised_by ? t('far.apByName', { defaultValue: 'By {{name}}', name: tk.assigned_to || tk.raised_by }) : ''}
                        {tk.closed_at ? `${tk.assigned_to || tk.raised_by ? ' · ' : ''}${t('far.apClosedOn', { defaultValue: 'Closed {{date}}', date: fmtDate(tk.closed_at) })}` : ''}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="text-center text-[11px] text-slate-400 mt-6">{t('far.apAutoUpdatedNote', 'All asset information is automatically updated from the system.')}</div>
      </div>

      <ImageLightbox images={photoView || []} open={!!photoView} onClose={() => setPhotoView(null)} />
    </div>
  );
}
