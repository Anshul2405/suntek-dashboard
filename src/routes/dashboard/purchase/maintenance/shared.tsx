import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, ImageUp } from 'lucide-react';
import { shrinkPhoto } from '../../../../lib/cloudinary';
import { retainPhoto } from '../../../../lib/photoCheck';
import { CameraCapture } from '../../../../components/CameraCapture';
import { useToast } from '../../../../components/ui/toast';

/** Loose translator signature so callers can pass react-i18next's `t` without type friction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TFn = (key: string, defaultValueOrOpts?: any) => string;

// ── Constants ─────────────────────────────────────────────────────────────────

export const FREQ_OPTIONS = ['daily', 'weekly', 'fortnightly', 'monthly', 'bimonthly', 'quarterly', 'biannual', 'triannual', 'annual'];
export const FREQ_LABEL: Record<string, string> = {
  daily: 'Daily', weekly: 'Weekly (7d)', fortnightly: 'Fortnightly (15d)', monthly: 'Monthly',
  bimonthly: 'Bi-monthly (2-mo)', quarterly: 'Quarterly (3-mo)', biannual: 'Bi-annual (6-mo)', triannual: '9-monthly',
  annual: 'Yearly (12-mo)',
};
/** Days added per frequency (months use setMonth for calendar correctness). */
export const FREQ_DAYS: Record<string, number> = { daily: 1, weekly: 7, fortnightly: 15 };
export const FREQ_MONTHS: Record<string, number> = { monthly: 1, bimonthly: 2, quarterly: 3, biannual: 6, triannual: 9, annual: 12 };

/** Cadence rank for table sort — Daily first, not A–Z (which puts Weekly above Daily). */
export function freqSortRank(frequency: string): number {
  const i = FREQ_OPTIONS.indexOf(frequency);
  return i < 0 ? FREQ_OPTIONS.length : i;
}

export const STATUS_CFG: Record<string, { label: string; labelKey?: string; bg: string; color: string }> = {
  open:                     { label: 'Open',              labelKey: 'maint.statusOpen',             bg: '#F3EFE8', color: '#161616' },
  in_progress:              { label: 'In Progress',       labelKey: 'maint.statusInProgress',       bg: '#FEF3C7', color: '#D97706' },
  pending_store:            { label: 'Pending Store',     labelKey: 'maint.statusPendingStore',     bg: '#FEF3C7', color: '#D97706' },
  pending_unit_head:        { label: 'Pending Approval',  labelKey: 'maint.statusPendingApproval',  bg: '#FFF3E6', color: '#D84315' },
  pending_purchase:         { label: 'Purchasing',        labelKey: 'maint.statusPurchasing',       bg: '#FFF3E6', color: '#D84315' },
  pending_purchase_manager: { label: 'Bill & Dispatch',   labelKey: 'maint.statusBillDispatch',     bg: '#FFF3E6', color: '#B45309' },
  pending_handover:         { label: 'Handover',          labelKey: 'maint.statusHandover',         bg: '#F3EFE8', color: '#161616' },
  pending_defective_return: { label: 'Used or return',    labelKey: 'maint.statusDefectiveReturn',  bg: '#FEF3C7', color: '#D97706' },
  changes_requested:        { label: 'Changes Requested', labelKey: 'maint.statusChangesRequested', bg: '#FEF2F2', color: '#DC2626' },
  closed:                   { label: 'Closed',            labelKey: 'maint.statusClosed',           bg: '#DCFCE7', color: '#16A34A' },
};

// pending_purchase is shown in strip but may be skipped (available-in-store path)
export const EMERGENCY_STAGES = [
  'open', 'in_progress', 'pending_store', 'pending_unit_head',
  'pending_purchase', 'pending_purchase_manager', 'pending_handover', 'pending_defective_return', 'closed',
];

export const STAGE_LABELS: Record<string, string> = {
  open: 'Raised', in_progress: 'Assessed', pending_store: 'Store Check',
  pending_unit_head: 'Unit Head', pending_purchase: 'Purchase', pending_purchase_manager: 'Purchase Mgr',
  pending_handover: 'Handover', pending_defective_return: 'Used / Return', closed: 'Closed',
};

/** i18n keys for STAGE_LABELS — translate at render with t(key, STAGE_LABELS[stage]). */
export const STAGE_LABEL_KEYS: Record<string, string> = {
  open: 'maint.stageRaised', in_progress: 'maint.stageAssessed', pending_store: 'maint.stageStoreCheck',
  pending_unit_head: 'maint.stageUnitHead', pending_purchase: 'maint.stagePurchase', pending_purchase_manager: 'maint.stagePurchaseMgr',
  pending_handover: 'maint.stageHandover', pending_defective_return: 'maint.stageDefective', closed: 'maint.stageClosed',
};

// In-house repairs (no store part requested) never touch the procurement pipeline,
// so their timeline skips store/purchase entirely: raise → upload the completion
// photo → unit head verifies → close. The unit-head step is a *work* check, not a
// spend check — without it a technician could self-certify any repair, since no
// part request ever puts the ticket in front of a reviewer.
export const INHOUSE_STAGES = ['open', 'in_progress', 'pending_unit_head', 'closed'];
export const INHOUSE_STAGE_LABELS: Record<string, string> = {
  open: 'Raised', in_progress: 'Completion Photo', pending_unit_head: 'Unit Head', closed: 'Closed',
};
export const INHOUSE_STAGE_LABEL_KEYS: Record<string, string> = {
  open: 'maint.stageRaised', in_progress: 'maint.stageCompletionPhoto',
  pending_unit_head: 'maint.stageUnitHead', closed: 'maint.stageClosed',
};

// Part needed but AVAILABLE in store → no procurement, so the Purchase / Purchase Mgr
// stages are omitted entirely (not just greyed): Raised → Assessed → Store Check →
// Unit Head → Handover → Used / Return → Closed.
export const AVAILABLE_STAGES = [
  'open', 'in_progress', 'pending_store', 'pending_unit_head',
  'pending_handover', 'pending_defective_return', 'closed',
];

// ── Pure helpers ────────────────────────────────────────────────────────────────

/** Human label for how issued parts were settled after handover. */
export function partDecisionLabel(decision: string | null | undefined, t?: TFn): string {
  if (!decision) return '';
  const map: Record<string, { key: string; fallback: string }> = {
    consumed: { key: 'maint.decisionConsumed', fallback: 'Consumed' },
    repair: { key: 'maint.decisionRepair', fallback: 'Repair' },
    scrap: { key: 'maint.decisionScrap', fallback: 'Scrap' },
    mixed: { key: 'maint.decisionMixed', fallback: 'Repair & scrap' },
  };
  const hit = map[decision];
  if (!hit) return decision;
  return t ? t(hit.key, hit.fallback) : hit.fallback;
}

export function statusBadge(status: string, t?: TFn) {
  const cfg = STATUS_CFG[status] || { label: status, bg: '#F1F5F9', color: '#475569' };
  const label = t && cfg.labelKey ? t(cfg.labelKey, cfg.label) : cfg.label;
  return <span className="badge" style={{ background: cfg.bg, color: cfg.color, fontWeight: 700 }}>{label}</span>;
}

export function formatDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function daysFromNow(d: string | null | undefined): number | null {
  if (!d) return null;
  // Compare by calendar date, so a task due *today* (any time) reads as 0, not −1.
  const due = new Date(d); due.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - now.getTime()) / 86400000);
}

export function dueDateLabel(days: number | null, t?: TFn): { text: string; color: string } {
  if (days === null) return { text: '—', color: '#94A3B8' };
  if (days < 0) return { text: t ? t('maint.overdueDays', { defaultValue: '{{n}}d overdue', n: Math.abs(days) }) : `${Math.abs(days)}d overdue`, color: '#DC2626' };
  if (days === 0) return { text: t ? t('maint.dueToday', 'Due today') : 'Due today', color: '#D97706' };
  const inTxt = t ? t('maint.dueInDays', { defaultValue: 'In {{n}}d', n: days }) : `In ${days}d`;
  if (days <= 3) return { text: inTxt, color: '#D97706' };
  return { text: inTxt, color: '#16A34A' };
}

/** Next occurrence = `from` (or now) + the frequency interval. Pass the current
 *  due date as `from` for calendar-anchored recurrence. */
export function calculateNextDue(frequency: string, from?: string | Date | null): string {
  const d = from ? new Date(from) : new Date();
  if (FREQ_DAYS[frequency] != null) d.setDate(d.getDate() + FREQ_DAYS[frequency]);
  else if (FREQ_MONTHS[frequency] != null) d.setMonth(d.getMonth() + FREQ_MONTHS[frequency]);
  else d.setDate(d.getDate() + 7);
  return d.toISOString();
}

// ── Photos ────────────────────────────────────────────────────────────────────

const MAX_TICKET_PHOTOS = 8;

/** First-photo column plus any extra urls, with duplicates removed. */
export function listedPhotoUrls(single?: string | null, many?: readonly string[] | null): string[] {
  const out: string[] = [];
  const add = (u?: string | null) => {
    const v = (u || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  add(single);
  for (const u of many ?? []) add(u);
  return out;
}

export function PhotoUploader({ onBlobReady, onBlobsReady, label, hint }: {
  onBlobReady: (blob: Blob | null) => void;
  /** Every photo currently attached, in the order they were added. */
  onBlobsReady?: (blobs: Blob[]) => void;
  label?: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const labelTxt = label ?? t('maint.attachPhotoProof', 'Attach photo proof');
  const hintTxt = hint ?? t('maint.takeOrUploadPhoto', 'Take or upload a photo');
  const [items, setItems] = useState<{ url: string; blob: Blob }[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const galleryRef = useRef<HTMLInputElement>(null);

  function publish(next: { url: string; blob: Blob }[]) {
    setItems(next);
    const blobs = next.map(item => item.blob);
    onBlobsReady?.(blobs);
    onBlobReady(blobs[0] ?? null);
  }

  async function addBlobs(blobs: Blob[]) {
    const room = MAX_TICKET_PHOTOS - items.length;
    const picked = blobs.slice(0, Math.max(0, room));
    if (!picked.length) {
      toast.error(t('maint.photoLimit', { defaultValue: 'You can attach up to {{n}} photos.', n: MAX_TICKET_PHOTOS }));
      return;
    }
    if (blobs.length > picked.length) {
      toast.error(t('maint.photoLimit', { defaultValue: 'You can attach up to {{n}} photos.', n: MAX_TICKET_PHOTOS }));
    }
    const added: { url: string; blob: Blob }[] = [];
    for (const file of picked) {
      try {
        // Drop the raw camera file immediately. On a phone it is a temp file that
        // can vanish before submit, and the full-size upload dies with "Failed to fetch".
        const blob = await shrinkPhoto(file);
        added.push({ url: URL.createObjectURL(blob), blob });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('maint.photoPrepareFailed', 'This photo could not be prepared. Take it again.'));
      }
    }
    if (added.length) publish([...items, ...added]);
  }

  function onGallery(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    // Copy starts before the picker is cleared. Some phones blank the file otherwise.
    const pending = files.map((f) => retainPhoto(f, f.name));
    e.target.value = '';
    void (async () => {
      const blobs: Blob[] = [];
      for (const job of pending) {
        try {
          blobs.push(await job);
        } catch {
          toast.error(t('maint.photoPrepareFailed', 'This photo could not be prepared. Take it again.'));
        }
      }
      if (blobs.length) await addBlobs(blobs);
    })();
  }

  function removeAt(index: number) {
    const gone = items[index];
    if (gone) URL.revokeObjectURL(gone.url);
    publish(items.filter((_, i) => i !== index));
  }

  const pickBtn: React.CSSProperties = {
    flex: 1, padding: '10px 8px', borderRadius: 12, border: '1px solid #E2E8F0',
    background: '#fff', color: '#334155', fontWeight: 700, fontSize: 12,
    cursor: 'pointer', fontFamily: 'inherit',
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{labelTxt}</div>
      <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10 }}>{hintTxt}</div>
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {items.map((item, i) => (
            <div key={item.url} style={{ position: 'relative', width: 96 }}>
              <img src={item.url} alt="" style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 10, border: '1px solid #E2E8F0', display: 'block' }} />
              <button type="button" onClick={() => removeAt(i)} aria-label={t('common.remove', 'Remove')} style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}
      {items.length < MAX_TICKET_PHOTOS && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setCameraOpen(true)} style={{ ...pickBtn, background: '#0F172A', color: '#fff', borderColor: '#0F172A', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Camera size={14} /> {t('maint.takePhotoBtn', 'Live photo')}
          </button>
          <button type="button" onClick={() => galleryRef.current?.click()} style={{ ...pickBtn, background: '#F8FAFC', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <ImageUp size={14} /> {t('maint.chooseFromGallery', 'Upload from library')}
          </button>
        </div>
      )}
      <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>{t('maint.jpgPngCameraHint', 'Live photo opens the camera. Upload from library picks a saved picture.')}</div>
      <input ref={galleryRef} type="file" accept="image/*,.heic,.heif" multiple style={{ display: 'none' }} onChange={onGallery} />
      <CameraCapture
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        title={t('maint.takePhotoBtn', 'Live photo')}
        onCapture={(blob) => { void addBlobs([blob]); }}
      />
    </div>
  );
}

// ── Stage progress strip ──────────────────────────────────────────────────────

export function StageStrip({ status, skippedStages = [], onStageClick, activeStage, stages = EMERGENCY_STAGES, labels = STAGE_LABELS, statusNote }: {
  status: string;
  skippedStages?: string[];
  /** Click a reached stage to see what happened there (read-only). */
  onStageClick?: (stage: string) => void;
  activeStage?: string | null;
  /** Stage list to render — defaults to the full emergency pipeline; pass
   *  INHOUSE_STAGES for a simplified in-house repair timeline. */
  stages?: string[];
  labels?: Record<string, string>;
  /** Small markup under the strip (e.g. "Requested changes" while paused for revision). */
  statusNote?: string | null;
}) {
  const { t } = useTranslation();
  const idx = stages.indexOf(status);
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, overflowX: 'auto', paddingBottom: 2 }}>
        {stages.map((s, i) => {
          const isPast = i < idx;
          const isCurrent = i === idx;
          const isSkipped = skippedStages.includes(s);
          const isLast = i === stages.length - 1;
          // A stage is inspectable once reached (past or current) and not skipped.
          const clickable = !!onStageClick && i <= idx && !isSkipped;
          const isActive = activeStage === s;
          return (
            <React.Fragment key={s}>
              <div
                onClick={clickable ? () => onStageClick!(s) : undefined}
                title={clickable ? t('maint.viewStageDetails', { defaultValue: 'View {{stage}} details', stage: labels[s] }) : undefined}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, cursor: clickable ? 'pointer' : 'default' }}
              >
                <div style={{
                  width: 22, height: 22, borderRadius: '50%',
                  background: isSkipped ? '#E2E8F0' : isCurrent ? '#F47651' : isPast ? '#16A34A' : '#E2E8F0',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: isActive ? '2px solid #0F172A' : isCurrent ? '2px solid #F47651' : 'none',
                  boxShadow: isActive ? '0 0 0 3px rgba(15,23,42,0.12)' : 'none',
                  opacity: isSkipped ? 0.4 : 1,
                }}>
                  {isPast && !isSkipped && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6 9 17l-5-5"/></svg>}
                  {isSkipped && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="3"><path d="M5 12h14"/></svg>}
                  {isCurrent && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
                </div>
                <div style={{ fontSize: 8.5, fontWeight: isActive || isCurrent ? 700 : 500, color: isActive ? '#0F172A' : isSkipped ? '#CBD5E1' : isCurrent ? '#F47651' : isPast ? '#16A34A' : '#94A3B8', marginTop: 3, whiteSpace: 'nowrap', textDecoration: clickable ? 'underline dotted' : 'none', textUnderlineOffset: 2 }}>
                  {labels[s]}{isSkipped ? ` ${t('maint.skippedSuffix', '(skipped)')}` : ''}
                </div>
              </div>
              {!isLast && <div style={{ height: 2, flex: 1, minWidth: 12, background: (isPast && !isSkipped) ? '#16A34A' : '#E2E8F0', marginTop: 10, flexShrink: 0 }} />}
            </React.Fragment>
          );
        })}
      </div>
      {statusNote && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8,
          padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
          background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA',
        }}>
          <span aria-hidden>↩</span> {statusNote}
        </div>
      )}
    </div>
  );
}
