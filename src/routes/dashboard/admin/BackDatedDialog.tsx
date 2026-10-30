import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BACKDATE_MODULES } from '../../../lib/access/rights';
import { cleanEditWindowHours, MAX_EDIT_WINDOW_HOURS } from '../../../lib/editWindowHours';
import { formatDate, istToday } from '../../../lib/utils/formatting';

const validDays = (v: string) => v.trim() === '' || (/^\d{1,3}$/.test(v.trim()) && Number(v) <= 366);

/**
 * Busy's "Back Dated Entries Restriction", on the Modify user screen.
 * S.No | Screen / voucher | Back Day(s) Allowed, counted from the system date
 * (IST today). 0 = no back date, 30 = up to 30 days back, blank = the default
 * buffer. Future dates are never blocked here; a plant's own number still
 * applies on top (the tighter wins). OK puts it in the draft — the screen's one
 * Save writes it.
 */
export function BackDatedDialog({
  backDays, bufferDays, editWindowHours, onOk, onClose, readOnly,
}: {
  backDays: Record<string, number>;
  bufferDays: number;
  editWindowHours: number;
  onOk: (next: { backDays: Record<string, number>; editWindowHours: number }) => void;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Record<string, string>>(() =>
    Object.fromEntries(BACKDATE_MODULES.map((m) => [m.key, backDays[m.key] != null ? String(backDays[m.key]) : ''])));
  const [hours, setHours] = useState(String(editWindowHours));
  const bad = Object.values(rows).some((v) => !validDays(v));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  function ok() {
    if (bad) return;
    const next: Record<string, number> = { ...backDays };
    for (const m of BACKDATE_MODULES) {
      const v = rows[m.key]?.trim() ?? '';
      if (v === '') delete next[m.key]; else next[m.key] = Number(v);
    }
    onOk({ backDays: next, editWindowHours: cleanEditWindowHours(Number(hours)) });
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-3" style={{ background: 'rgba(15,23,42,0.45)' }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t('um.backTitle', 'Back Dated Entries Restriction')} className="bz bz-box w-full max-w-[560px] max-h-[92vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="bz-title">{t('um.backTitle', 'Back Dated Entries Restriction')}</div>
        <div className="bz-body">
          <div className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span>{t('um.countFrom', 'Back days count from')}: <b>{t('um.systemDate', 'System Date')}</b> ({t('um.istToday', 'IST today')} {formatDate(istToday())})</span>
            <span className="text-slate-400 text-[11.5px]">{t('um.noLastVoucher', 'Last Voucher Date is not used — always from today.')}</span>
          </div>
          <table className="bz-list mt-1" data-testid="backdated-table">
            <thead>
              <tr>
                <th style={{ width: 44 }}>{t('um.sno', 'S.No')}</th>
                <th>{t('um.screenVoucher', 'Screen / voucher')}</th>
                <th style={{ width: 150 }}>{t('rights.backDays', 'Back day(s) allowed')}</th>
              </tr>
            </thead>
            <tbody>
              {BACKDATE_MODULES.map((m, i) => (
                <tr key={m.key} style={{ cursor: 'default' }}>
                  <td className="text-right">{i + 1}.</td>
                  <td className="font-semibold" style={{ whiteSpace: 'normal' }}>{t(m.labelKey, m.label)}</td>
                  <td>
                    <input
                      className="bz-in"
                      inputMode="numeric"
                      aria-label={`${t(m.labelKey, m.label)} — ${t('rights.backDays', 'Back day(s) allowed')}`}
                      placeholder={t('um.defaultDays', { defaultValue: 'default {{days}}', days: bufferDays })}
                      value={rows[m.key] ?? ''}
                      disabled={readOnly}
                      style={!validDays(rows[m.key] ?? '') ? { borderColor: '#DC2626' } : undefined}
                      onChange={(e) => setRows((r) => ({ ...r, [m.key]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {bad && <p className="text-xs text-red-600 mt-1">{t('rights.backBad', 'Use a whole number of days from 0 to 366, or leave it blank.')}</p>}
          <p className="text-[11.5px] text-slate-500 mt-2">
            {t('um.backNote', { defaultValue: '0 = no back date. 30 = up to 30 days before today. Blank = default ({{days}} days). Further back needs Management’s approval (reason + history). Future dates (payments, dispatch) are never blocked. A plant’s own number still applies — the tighter one wins. These limits are per screen and apply to every user.', days: bufferDays })}
          </p>
          <div className="bz-field mt-2">
            <span>{t('um.modifyWindow', 'Modify window (hours)')}</span>
            <input
              className="bz-in" type="number" min={0.25} max={MAX_EDIT_WINDOW_HOURS} step={0.25} style={{ maxWidth: 120 }}
              aria-label={t('um.modifyWindow', 'Modify window (hours)')}
              value={hours} disabled={readOnly} onChange={(e) => setHours(e.target.value)}
            />
          </div>
          <p className="text-[11.5px] text-slate-500 mt-1">{t('um.modifyWindowNote', 'One window for every screen: inside it the person who made an entry can modify it (with the Modify tick); after it only Admin, Unit Head and management.')}</p>
        </div>
        <div className="flex justify-end gap-2 px-2 py-2 border-t border-slate-300 bg-slate-50">
          <button type="button" className="bz-btn bz-btn-primary" disabled={bad || readOnly} onClick={ok}>{t('um.ok', 'OK')}</button>
          <button type="button" className="bz-btn" onClick={onClose}>{t('um.cancel', 'Cancel')}</button>
        </div>
      </div>
    </div>
  );
}
