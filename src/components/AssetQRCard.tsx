import React, { useRef, useState } from 'react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { updateRows } from '../lib/db';
import { useRoleContext } from '../contexts/RoleContext';
import { useToast } from './ui/toast';
import { assetQrUrl, downloadDataUrl, printQrLabel, makeQrToken, safeFileName } from '../lib/far/qr';
import { formatDate } from '../lib/utils/formatting';

export interface QrAsset {
  id: string;
  name: string;
  identification_mark: string | null;
  qr_token: string | null;
  qr_generated_at: string | null;
  qr_generated_by: string | null;
  plants?: { name: string | null } | null;
}

type QrPatch = { qr_token: string; qr_generated_at: string; qr_generated_by: string };

/**
 * Renders an asset's QR code with generate / regenerate / download / print.
 * Opt-in: an asset has no QR until generated; regenerate rotates the token so a
 * previously printed code stops resolving. Generation is gated by
 * `generate_asset_qr`; anyone who can see the card may still download/print an
 * already-generated code.
 */
export function AssetQRCard({ asset, onUpdated, compact = false }: {
  asset: QrAsset;
  onUpdated?: (patch: QrPatch) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { can, activeProfile } = useRoleContext();
  const toast = useToast();
  const canGenerate = can('generate_asset_qr');
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const label = `${asset.name}${asset.identification_mark ? ` (${asset.identification_mark})` : ''}`;
  const plantName = asset.plants?.name || '';

  function getPng(): string | null {
    const canvas = canvasWrapRef.current?.querySelector('canvas');
    return canvas ? canvas.toDataURL('image/png') : null;
  }

  async function generate(regenerate: boolean) {
    if (!canGenerate || busy) return;
    if (regenerate && !window.confirm(t('far.qrRegenConfirm', 'Regenerate this QR code?\n\nThe current printed code will STOP working and must be reprinted and re-attached.'))) return;
    setBusy(true);
    try {
      const patch: QrPatch = { qr_token: makeQrToken(), qr_generated_at: new Date().toISOString(), qr_generated_by: activeProfile.name };
      await updateRows('fixed_assets', patch).eq('id', asset.id);
      onUpdated?.(patch);
      toast.success(regenerate
        ? t('far.qrRegenSuccess', 'QR regenerated — reprint & reattach')
        : t('far.qrCodeGenerated', 'QR code generated'));
    } catch (e) {
      toast.error(t('far.qrFailed', { defaultValue: 'Failed: {{msg}}', msg: e instanceof Error ? e.message : String(e) }));
    } finally { setBusy(false); }
  }

  function download() {
    const png = getPng();
    if (!png) { toast.error(t('far.qrNotReady', 'QR not ready yet')); return; }
    downloadDataUrl(png, `QR-${safeFileName(label)}.png`);
  }

  function print() {
    const png = getPng();
    if (!png) { toast.error(t('far.qrNotReady', 'QR not ready yet')); return; }
    printQrLabel({ pngDataUrl: png, title: label, subtitle: plantName, footer: t('far.qrPrintFooter', { defaultValue: 'Asset #{{id}} · scan to open the digital profile', id: asset.id.slice(0, 8) }) });
  }

  // No QR yet → generate prompt.
  if (!asset.qr_token) {
    return (
      <div style={{ border: '1px dashed #CBD5E1', borderRadius: 14, padding: compact ? 14 : 20, textAlign: 'center', background: '#F8FAFC' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#475569', marginBottom: 4 }}>{t('far.qrNoQrYet', 'No QR code yet')}</div>
        <div style={{ fontSize: 11.5, color: '#94A3B8', marginBottom: canGenerate ? 12 : 0 }}>{t('far.qrGenerateHint', 'Generate a code, print it, and attach it to the equipment.')}</div>
        {canGenerate && (
          <button onClick={() => generate(false)} disabled={busy} className="btn-accent pill" style={{ padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? t('far.qrGenerating', 'Generating…') : `＋ ${t('far.qrGenerateQrCode', 'Generate QR Code')}`}
          </button>
        )}
      </div>
    );
  }

  const url = assetQrUrl(asset.qr_token);
  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 14, padding: compact ? 14 : 20, textAlign: 'center', background: '#fff' }}>
      {/* Off-screen high-res canvas used only for PNG export / print */}
      <div ref={canvasWrapRef} style={{ position: 'absolute', left: -99999, top: -99999 }} aria-hidden>
        <QRCodeCanvas value={url} size={512} level="M" marginSize={2} />
      </div>
      {/* Visible crisp SVG */}
      <div style={{ display: 'inline-flex', padding: 10, background: '#fff', borderRadius: 12, border: '1px solid #F1F5F9' }}>
        <QRCodeSVG value={url} size={compact ? 132 : 168} level="M" marginSize={2} />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 14 }}>
        <button onClick={download} className="chip" style={{ fontWeight: 600 }}>{`⬇ ${t('far.qrDownload', 'Download')}`}</button>
        <button onClick={print} className="chip" style={{ fontWeight: 600 }}>{`🖨 ${t('far.qrPrintLabel', 'Print label')}`}</button>
        {canGenerate && <button onClick={() => generate(true)} disabled={busy} className="chip" style={{ fontWeight: 600, color: '#DC2626' }}>{busy ? '…' : `↻ ${t('far.qrRegenerate', 'Regenerate')}`}</button>}
      </div>
      {asset.qr_generated_at && (
        <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 8 }}>
          {t('far.qrGeneratedOn', { defaultValue: 'Generated {{date}}', date: formatDate(asset.qr_generated_at) })}
          {asset.qr_generated_by ? t('far.qrGeneratedByName', { defaultValue: ' · by {{name}}', name: asset.qr_generated_by }) : ''}
        </div>
      )}
    </div>
  );
}
