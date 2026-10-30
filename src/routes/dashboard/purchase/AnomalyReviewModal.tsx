import React, { useEffect, useState } from 'react';
import { formatDateTime } from '../../../lib/utils/formatting';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
// Shared humanizer — a user should never be shown a raw error object.
import { humanizeError as errMsg } from '../../../lib/errors';
import { callRpc } from '../../../lib/db';
import { useRoleContext } from '../../../contexts/RoleContext';
import type { ReviewedAnomaly, AnomalyAction } from '../../../lib/store/anomalyKeys';
import { labelForPeriod, type RegisterSide } from '../../../lib/store/parseStockFile';
import { codeLabel } from '../../../lib/labels';

/**
 * "Jun 2026 Purchase Register" — where one side of a comparison came from.
 *
 * Falls back to the generic word when an anomaly predates the provenance
 * columns (migration 72), so an older stored row still renders rather than
 * showing a blank label.
 */
function sideLabel(period: string | undefined, register: RegisterSide | undefined, fallback: string): string {
  if (!period) return fallback;
  const book = register === 'purchase' ? 'Purchase Register'
             : register === 'sales' ? 'Sales Register'
             : '';
  return `${labelForPeriod(`${period}-01`)}${book ? ` ${book}` : ''}`;
}

interface EventRow {
  id: string;
  action: string;
  from_status: string | null;
  to_status: string;
  comment: string;
  corrected_value: number | null;
  actor_name: string | null;
  created_at: string;
}

const STATUS_TONE: Record<string, { bg: string; color: string }> = {
  open:           { bg: '#FFFBEB', color: '#B45309' },
  confirmed:      { bg: '#FEF2F2', color: '#DC2626' },
  false_positive: { bg: '#F1F5F9', color: '#64748B' },
  resolved:       { bg: '#F0FDF4', color: '#16A34A' },
  reopened:       { bg: '#FFFBEB', color: '#B45309' },
};

/** Review / resolve one Stock Register anomaly. All writes go through the
 *  resolve_stock_anomaly RPC (atomic; mandatory comment; optimistic version
 *  check; permission enforced server-side). */
export function AnomalyReviewModal({ item, onClose, onSaved }: {
  item: ReviewedAnomaly | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { activeProfile } = useRoleContext();
  const [action, setAction] = useState<AnomalyAction>('resolve');
  const [comment, setComment] = useState('');
  const [corrected, setCorrected] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<EventRow[]>([]);

  const res = item?.resolution ?? null;

  // Reset form + load history whenever a different anomaly opens.
  useEffect(() => {
    if (!item) return;
    setAction(res && !item.isOpen ? 'reopen' : 'resolve');
    setComment(''); setCorrected(''); setErr(null); setHistory([]);
    if (res) {
      supabase.from('store_stock_anomaly_events')
        .select('id, action, from_status, to_status, comment, corrected_value, actor_name, created_at')
        .eq('anomaly_id', res.id).order('created_at', { ascending: false }).limit(20)
        .returns<EventRow[]>()
        .then(({ data }) => setHistory(data || []), () => {});
    }
  }, [item?.plantId, item?.periodMonth, item?.anomaly.item, item?.anomaly.type, res?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;
  const a = item.anomaly;

  function friendly(raw: string): string {
    if (/version_conflict/i.test(raw)) return t('stockAnomaly.errConflict', 'Someone else updated this anomaly just now — close and reopen it to see the latest state.');
    if (/comment_required/i.test(raw)) return t('stockAnomaly.errComment', 'A comment is required for every anomaly action.');
    if (/PGRST202|Could not find the function|schema cache/i.test(raw)) return t('stockAnomaly.errMigration', 'The anomaly service is not installed yet — run migration 54_stock_anomaly_resolutions.sql in Supabase, then retry.');
    if (/forbidden: missing capability/i.test(raw)) return t('stockAnomaly.errForbidden', 'You do not have permission to resolve anomalies. Ask an admin for the "Resolve stock anomalies" allowance.');
    if (/forbidden: plant out of scope/i.test(raw)) return t('stockAnomaly.errScope', 'This plant is outside your data scope.');
    if (/not_authenticated/i.test(raw)) return t('stockAnomaly.errAuth', 'Your session has expired — sign in again.');
    return raw;
  }

  async function save() {
    if (!item) return;
    if (!comment.trim()) { setErr(t('stockAnomaly.errComment', 'A comment is required for every anomaly action.')); return; }
    const corrN = corrected.trim() === '' ? null : Number(corrected);
    if (corrN != null && (!Number.isFinite(corrN) || corrN < 0)) {
      setErr(t('stockAnomaly.errCorrected', 'Corrected value must be a number ≥ 0.')); return;
    }
    setSaving(true); setErr(null);
    try {
      const { error } = await callRpc('resolve_stock_anomaly', {
        payload: {
          // The register key is a STORE id (registerIdOf → store_id since
          // migration 60). It used to be sent as `plant_id`, which is a foreign
          // key to plants — so every review at a shared-store site was rejected
          // with a 23503 that surfaced as "This record is linked to other
          // records. Remove those links first." Nothing was ever linked; the
          // anomaly tables just had not been moved onto the store model.
          // Migration 72 adds store_id and keys on it.
          store_id: item.plantId,
          period_month: item.periodMonth,
          item_name: a.item,
          anomaly_type: a.type,
          action,
          comment: comment.trim(),
          corrected_value: corrN,
          expected_version: res?.version,
          actor_name: activeProfile.name,
          // Provenance travels with the review so the stored row records WHICH
          // two figures were compared, not just the numbers.
          detected: {
            severity: a.severity, detail: a.detail,
            prev: a.prev ?? null, curr: a.curr ?? null, delta: a.delta ?? null,
            suggestion: a.suggestion ?? null,
            prevPeriod: a.prevPeriod ? `${a.prevPeriod}-01` : null,
            currPeriod: a.currPeriod ? `${a.currPeriod}-01` : null,
            prevRegister: a.prevRegister ?? null,
            currRegister: a.currRegister ?? null,
          },
        },
      });
      if (error) throw new Error(friendly(error.message || ''));
      onSaved();
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  const status = res?.status ?? 'open';
  const tone = STATUS_TONE[status] ?? STATUS_TONE.open;
  const fmt = (n: number | null | undefined) => (n == null ? '—' : String(n));

  return (
    <div style={overlay} onClick={() => { if (!saving) onClose(); }}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{t('stockAnomaly.title', 'Review anomaly')}</div>
            <div style={{ fontSize: 12, color: '#94A3B8' }}>{a.item}</div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#94A3B8' }}>×</button>
        </div>

        {/* Detected summary — the ORIGINAL values, frozen in history on first action */}
        <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: 10, margin: '10px 0', fontSize: 12.5, color: '#475569' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span>{a.detail}</span>
            <span className="badge" style={{ background: tone.bg, color: tone.color, fontWeight: 700, whiteSpace: 'nowrap' }}>
              {t(`stockAnomaly.status.${status}`, status.replace('_', ' '))}
            </span>
          </div>
          {/* Each side names its MONTH and its REGISTER.
              "Previous month" / "Latest file" was the whole problem: a reviewer
              looking at July assumed those were June and July figures, when the
              anomaly was actually a May→June comparison — and concluded the
              engine had compared the wrong periods. The numbers were right; the
              labels never said what they belonged to. */}
          <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <span>
              {sideLabel(a.prevPeriod, a.prevRegister, t('stockAnomaly.prev', 'Previous'))}:{' '}
              <strong>{fmt(a.prev)}</strong>
            </span>
            <span>
              {sideLabel(a.currPeriod, a.currRegister, t('stockAnomaly.curr', 'Current'))}:{' '}
              <strong>{fmt(a.curr)}</strong>
            </span>
            <span>{t('stockAnomaly.delta', 'Difference')}: <strong>{a.delta != null && a.delta > 0 ? '+' : ''}{fmt(a.delta)}</strong></span>
          </div>
          {res?.resolution_comment && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: '#64748B' }}>
              {t('stockAnomaly.lastAction', 'Last action')}: <strong>{codeLabel(res.action)}</strong> · {res.resolved_by_name || '—'} · “{res.resolution_comment}”
              {res.corrected_value != null && <> · {t('stockAnomaly.correctedTo', 'corrected to')} <strong>{res.corrected_value}</strong></>}
            </div>
          )}
        </div>

        {/* Action */}
        <div style={label}>{t('stockAnomaly.action', 'Action')}</div>
        <select value={action} onChange={e => setAction(e.target.value as AnomalyAction)} style={{ ...inputStyle, width: '100%', marginBottom: 10 }}>
          <option value="resolve">{t('stockAnomaly.actResolve', 'Resolve — reviewed and handled')}</option>
          <option value="confirm">{t('stockAnomaly.actConfirm', 'Confirm — real discrepancy, keep flagged')}</option>
          <option value="false_positive">{t('stockAnomaly.actFalsePositive', 'False positive — detection is wrong')}</option>
          {res && <option value="reopen">{t('stockAnomaly.actReopen', 'Reopen — needs another look')}</option>}
        </select>

        {/* Corrected value — recorded on the anomaly; the live register is corrected
            via the existing Stock Register Edit flow (own audit trail). */}
        <div style={label}>{t('stockAnomaly.corrected', 'Corrected value (optional)')}</div>
        <input type="number" min="0" value={corrected} onChange={e => setCorrected(e.target.value)}
          placeholder={fmt(a.curr)} style={{ ...inputStyle, width: '100%', marginBottom: 4 }} />
        <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10 }}>
          {t('stockAnomaly.correctedHint', 'Recorded on the anomaly for the audit trail. To change live stock, use the register’s Edit action (it keeps its own justification log).')}
        </div>

        {/* Mandatory comment */}
        <div style={label}>{t('stockAnomaly.comment', 'Comment (required)')} *</div>
        <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3}
          placeholder={t('stockAnomaly.commentPh', 'why — e.g. verified against the physical count')}
          style={{ ...inputStyle, width: '100%', resize: 'vertical', marginBottom: 10 }} />

        {err && <div style={{ fontSize: 12.5, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={btnGhost}>{t('stockAnomaly.cancel', 'Cancel')}</button>
          <button onClick={save} disabled={saving} style={{ ...btnPrimary, flex: 1, opacity: saving ? 0.7 : 1 }}>
            {saving ? t('stockAnomaly.saving', 'Saving…') : t('stockAnomaly.save', 'Save')}
          </button>
        </div>

        {/* Append-only history */}
        {history.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={label}>{t('stockAnomaly.history', 'History')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto' }}>
              {history.map(h => (
                <div key={h.id} style={{ fontSize: 11.5, color: '#64748B', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: '6px 8px' }}>
                  <strong style={{ color: '#334155' }}>{codeLabel(h.action)}</strong> · {h.from_status ? codeLabel(h.from_status) : '—'} → {codeLabel(h.to_status)} · {h.actor_name || '—'} · {formatDateTime(h.created_at)}
                  {h.corrected_value != null && <> · {t('stockAnomaly.correctedTo', 'corrected to')} {h.corrected_value}</>}
                  <div>“{h.comment}”</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modal: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', maxHeight: '90vh', overflowY: 'auto', width: 'min(520px, 100%)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 };
const inputStyle: React.CSSProperties = { boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none' };
const btnPrimary: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#F47651', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
const btnGhost: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
