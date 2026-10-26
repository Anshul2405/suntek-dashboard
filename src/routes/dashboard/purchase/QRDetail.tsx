import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft, Download, Printer, Share2, RotateCw,
  Tag, CreditCard, LayoutGrid, MapPin, Clock, CalendarDays, Wrench,
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { displayLocationName } from '../../../lib/plantLabels';
import { useRoleContext } from '../../../contexts/RoleContext';
import { useToast } from '../../../components/ui/toast';
import { ErrorState } from '../../../components/ui/states';
import { AssetQRCard } from '../../../components/AssetQRCard';
import { ButtonV2, StatusPill, InfoBanner } from '../../../components/v2';
import { assetQrUrl, downloadDataUrl, printQrLabel, safeFileName, makeQrToken } from '../../../lib/far/qr';
import { updateRows } from '../../../lib/db';
import type { Database } from '../../../lib/database.types';

type AssetRow = Database['public']['Tables']['fixed_assets']['Row'] & { plants?: { name: string | null } | null };

function fmtDate(d: string | null | undefined) {
  return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

/** One "Asset Details" row — icon + gray label left, value right (per mockup). */
function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5 border-b border-slate-100 last:border-0">
      <span className="flex items-center gap-2.5 text-[13px] text-slate-500 shrink-0">
        <span className="text-slate-400 inline-flex [&>svg]:w-4 [&>svg]:h-4">{icon}</span>
        {label}
      </span>
      <span className="text-[13px] font-medium text-slate-800 text-right min-w-0 truncate">{value}</span>
    </div>
  );
}

/**
 * Full-page QR detail (/dashboard/purchase/qr/:qrKey) — replaces the old
 * in-page SlidePanel on the QR list. Resolves the asset by qr_token first,
 * then by id (so un-generated assets deep-link too). Generation stays gated
 * by `generate_asset_qr` (via AssetQRCard's prompt for token-less assets).
 */
export function QRDetail() {
  const { t } = useTranslation();
  const { qrKey } = useParams<{ qrKey: string }>();
  const navigate = useNavigate();
  const { can, activeProfile } = useRoleContext();
  const toast = useToast();
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  const [asset, setAsset] = useState<AssetRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [lastMaint, setLastMaint] = useState<string | null>(null);
  const [nextMaint, setNextMaint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!qrKey) { setNotFound(true); setLoading(false); return; }
      setLoading(true); setNotFound(false);
      // qr_token first, then id (mirrors AssetProfile resolution).
      let { data } = await supabase.from('fixed_assets').select('*, plants(name)')
        .eq('qr_token', qrKey).maybeSingle<AssetRow>();
      if (!data && /^[0-9a-f-]{36}$/i.test(qrKey)) {
        const byId = await supabase.from('fixed_assets').select('*, plants(name)')
          .eq('id', qrKey).maybeSingle<AssetRow>();
        data = byId.data;
      }
      if (cancelled) return;
      if (!data) { setNotFound(true); setLoading(false); return; }
      setAsset(data);
      setLoading(false);

      // Maintenance context (best-effort): last closed ticket + next schedule due.
      const tk = await supabase.from('maintenance_tickets').select('closed_at').eq('far_asset_id', data.id)
        .not('closed_at', 'is', null).order('closed_at', { ascending: false }).limit(1);
      if (cancelled) return;
      const tkRows = (tk.data ?? []) as unknown as { closed_at: string }[];
      setLastMaint(tkRows[0]?.closed_at ?? null);
      if (data.identification_mark) {
        const sc = await supabase.from('maintenance_schedules').select('next_due_at')
          .ilike('equipment', `%${data.identification_mark}%`).eq('is_active', true)
          .order('next_due_at', { ascending: true }).limit(1);
        if (cancelled) return;
        const scRows = (sc.data ?? []) as unknown as { next_due_at: string }[];
        setNextMaint(scRows[0]?.next_due_at ?? null);
      }
    })();
    return () => { cancelled = true; };
  }, [qrKey]);

  function getPng(): string | null {
    const canvas = canvasWrapRef.current?.querySelector('canvas');
    return canvas ? canvas.toDataURL('image/png') : null;
  }
  const label = asset ? `${asset.name}${asset.identification_mark ? ` (${asset.identification_mark})` : ''}` : '';

  function download() {
    const png = getPng();
    if (!png) { toast.error(t('far.qrNotReady', 'QR not ready yet')); return; }
    downloadDataUrl(png, `QR-${safeFileName(label)}.png`);
  }
  function print() {
    const png = getPng();
    if (!png) { toast.error(t('far.qrNotReady', 'QR not ready yet')); return; }
    printQrLabel({ pngDataUrl: png, title: label, subtitle: displayLocationName(asset?.plants?.name), footer: t('far.qrPrintFooter', { defaultValue: 'Asset #{{id}} · scan to open the digital profile', id: asset?.id.slice(0, 8) }) });
  }

  if (loading) {
    return <div className="card2 py-16 text-center text-slate-400 text-[13px]">{t('far.qrLoadingAsset', 'Loading asset…')}</div>;
  }
  if (notFound || !asset) {
    return (
      <div className="card2 p-6">
        <ErrorState title={t('far.qrAssetNotFound', 'Asset not found')} message={t('far.qrLinkNoMatch', "This QR link doesn't match any asset in the register.")} />
        <div className="flex justify-center mt-4">
          <ButtonV2 variant="outline" icon={<ArrowLeft />} onClick={() => navigate('/dashboard/purchase/qr')}>{t('far.qrBackToQrCodes', 'Back to QR Codes')}</ButtonV2>
        </div>
      </div>
    );
  }

  const url = asset.qr_token ? assetQrUrl(asset.qr_token) : null;

  return (
    <div className="card2 overflow-hidden">
      {/* Inner breadcrumb + back */}
      <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-4 border-b border-slate-100">
        <div className="text-[12.5px] text-slate-400 flex items-center gap-1.5 flex-wrap">
          <span>{t('nav.factory', 'Factory')}</span><span className="text-slate-300">›</span>
          <span>{t('far.qrCrumbAssets', 'Assets')}</span><span className="text-slate-300">›</span>
          <span>{t('far.fixedAssetRegister', 'Fixed Asset Register')}</span><span className="text-slate-300">›</span>
          <span className="text-slate-600 font-medium">{label}</span><span className="text-slate-300">›</span>
          <span className="text-slate-600 font-medium">{t('nav.qrCode', 'QR Code')}</span>
        </div>
        <ButtonV2 variant="outline" icon={<ArrowLeft />} onClick={() => navigate('/dashboard/purchase/qr')}>
          {t('far.qrBackToAsset', 'Back to asset')}
        </ButtonV2>
      </div>

      <div className="grid grid-cols-12 gap-8 p-6">
        {/* ── Left: the QR itself ── */}
        <div className="col-span-12 lg:col-span-7">
          <div className="font-heading font-semibold text-[18px]">{t('far.qrAssetQrCode', 'Asset QR Code')}</div>
          <div className="text-[13px] text-slate-500 mt-0.5 mb-4">{t('far.qrScanToView', 'Scan this QR code to view asset details.')}</div>

          {url ? (
            <>
              {/* Off-screen high-res canvas used only for PNG export / print */}
              <div ref={canvasWrapRef} style={{ position: 'absolute', left: -99999, top: -99999 }} aria-hidden>
                <QRCodeCanvas value={url} size={512} level="M" marginSize={2} />
              </div>
              <div className="border border-slate-200 rounded-[12px] p-8 flex items-center justify-center bg-white">
                <QRCodeSVG value={url} size={280} level="M" marginSize={2} />
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-4">
                <ButtonV2 variant="primary" icon={<Download />} onClick={download}>{t('far.qrDownload', 'Download')}</ButtonV2>
                <ButtonV2 variant="outline" icon={<Printer />} onClick={print}>{t('far.qrPrint', 'Print')}</ButtonV2>
                <ButtonV2 variant="outline" icon={<Share2 />} onClick={() => navigate(`/asset/${asset.qr_token}`)}>{t('far.qrOpenFullProfile', 'Open Full Profile')}</ButtonV2>
                {can('generate_asset_qr') && (
                  <ButtonV2
                    variant="outline" icon={<RotateCw />} disabled={busy}
                    className="text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300"
                    onClick={async () => {
                      if (!window.confirm(t('far.qrRegenConfirm', 'Regenerate this QR code?\n\nThe current printed code will STOP working and must be reprinted and re-attached.'))) return;
                      setBusy(true);
                      try {
                        const patch = { qr_token: makeQrToken(), qr_generated_at: new Date().toISOString(), qr_generated_by: activeProfile.name };
                        await updateRows('fixed_assets', patch).eq('id', asset.id);
                        setAsset(a => a ? { ...a, ...patch } : a);
                        navigate(`/dashboard/purchase/qr/${patch.qr_token}`, { replace: true });
                        toast.success(t('far.qrRegenSuccess', 'QR regenerated — reprint & reattach'));
                      } catch (e) {
                        toast.error(t('far.qrFailed', { defaultValue: 'Failed: {{msg}}', msg: e instanceof Error ? e.message : String(e) }));
                      } finally { setBusy(false); }
                    }}
                  >
                    {t('far.qrRegenerate', 'Regenerate')}
                  </ButtonV2>
                )}
              </div>
              <InfoBanner className="mt-4">{t('far.qrAnyoneCanScan', 'Anyone can scan this QR code to view asset basic information.')}</InfoBanner>
            </>
          ) : (
            // No QR yet — reuse the gated generate prompt; onUpdated patches in the new token.
            <AssetQRCard
              asset={asset}
              onUpdated={(patch) => {
                setAsset(a => a ? { ...a, ...patch } : a);
                navigate(`/dashboard/purchase/qr/${patch.qr_token}`, { replace: true });
              }}
            />
          )}
        </div>

        {/* ── Right: asset details ── */}
        <div className="col-span-12 lg:col-span-5">
          <div className="font-heading font-semibold text-[18px] mb-2">{t('far.qrAssetDetails', 'Asset Details')}</div>
          <DetailRow icon={<Tag />} label={t('far.qrThAssetName', 'Asset Name')} value={label} />
          <DetailRow icon={<CreditCard />} label={t('far.qrAssetId', 'Asset ID')} value={asset.identification_mark || `#${asset.id.slice(0, 8)}`} />
          <DetailRow icon={<LayoutGrid />} label={t('far.qrCategory', 'Category')} value={asset.account_head || asset.make || '—'} />
          <DetailRow icon={<MapPin />} label={t('far.qrLocation', 'Location')} value={displayLocationName(asset.plants?.name) || '—'} />
          <DetailRow icon={<Clock />} label={t('far.thStatus', 'Status')} value={<StatusPill tone="green" label={t('far.qrActive', 'Active')} />} />
          <DetailRow icon={<CalendarDays />} label={t('far.qrInstalledOn', 'Installed On')} value={asset.purchase_date ? fmtDate(asset.purchase_date) : (asset.year ?? '—')} />
          <DetailRow icon={<Wrench />} label={t('far.qrLastMaintenance', 'Last Maintenance')} value={fmtDate(lastMaint)} />
          <DetailRow icon={<CalendarDays />} label={t('far.qrNextMaintenance', 'Next Maintenance')} value={fmtDate(nextMaint)} />
        </div>
      </div>
    </div>
  );
}
