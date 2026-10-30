import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dayInRange, isoToDmy, parseDmy } from '../../lib/utils/dateInput';

/**
 * A date box that always reads dd/mm/yyyy, whatever the phone or PC is set to.
 *
 * The native <input type="date"> follows the browser locale (often mm/dd/yyyy):
 * "02/10/2026" typed on a US-order device was saved as 10 Feb. Here the visible
 * box is text in dd/mm/yyyy; the calendar button opens the native picker only
 * to choose a day. The value in and out is 'YYYY-MM-DD' (what the database keeps).
 *
 * Drop-in for <input type="date">: `onChange` gets `{ target: { value } }`.
 */
/** Day-first locale for the box and the native picker (dd/mm/yyyy, 24-hour time). */
const DAY_FIRST = 'en-GB';

export type DateInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max'> & {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  min?: string;
  max?: string;
  /** Wrapper display; defaults to block when the input is full width. */
  block?: boolean;
};

export function DateInput({ value, onChange, min, max, className, style, block, disabled, placeholder, ...rest }: DateInputProps) {
  const { t } = useTranslation();
  const picker = useRef<HTMLInputElement>(null);
  // The text follows `value` from outside (reset form, picker) — derived state.
  const [shown, setShown] = useState({ value, text: isoToDmy(value) });
  const [bad, setBad] = useState(false);
  if (shown.value !== value) setShown({ value, text: isoToDmy(value) });

  const emit = (iso: string) => onChange({ target: { value: iso } });
  const commit = (text: string) => {
    if (!text.trim()) { setBad(false); if (value) emit(''); return; }
    const iso = parseDmy(text);
    if (!iso || !dayInRange(iso, min, max)) {
      // Not a real day: keep what was typed (red), and clear the value so the
      // form cannot save the previous date behind a red box.
      setBad(true);
      setShown({ value: '', text });
      if (value) emit('');
      return;
    }
    setBad(false);
    if (iso !== value) emit(iso);
    else setShown({ value, text: isoToDmy(iso) });
  };

  const full = block ?? /\b(w-full|block)\b/.test(className || '') ?? false;
  const title = bad
    ? t('common.dateInvalid', { defaultValue: 'Not a valid day. Type dd/mm/yyyy{{range}}.', range: min || max ? ` (${[min && isoToDmy(min), max && isoToDmy(max)].filter(Boolean).join(' – ')})` : '' })
    : undefined;

  return (
    // lang="en-GB": the calendar popup reads day-first where the browser honours it.
    <span lang={DAY_FIRST} style={{ position: 'relative', display: full ? 'block' : 'inline-block' }}>
      <input
        {...rest}
        lang={DAY_FIRST}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder ?? 'dd/mm/yyyy'}
        disabled={disabled}
        value={shown.text}
        aria-invalid={bad || undefined}
        title={title}
        // Phones: a 44px box, 16px text (iOS does not zoom in), room for the calendar button.
        className={[className, '!pr-[30px] max-sm:!pr-[44px] max-sm:min-h-[44px] max-sm:!text-[16px]'].filter(Boolean).join(' ')}
        style={{ ...style, ...(bad ? { borderColor: '#DC2626' } : {}) }}
        onChange={e => {
          const text = e.target.value;
          setShown({ value, text });
          // A full year typed → take it now; shorter forms wait for blur / Enter.
          if (/\d{4}$/.test(text.trim())) {
            const iso = parseDmy(text);
            if (iso && dayInRange(iso, min, max)) { setBad(false); if (iso !== value) emit(iso); }
          }
        }}
        onBlur={e => { commit(shown.text); rest.onBlur?.(e); }}
        onKeyDown={e => { if (e.key === 'Enter') commit(shown.text); rest.onKeyDown?.(e); }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={t('common.openCalendar', 'Open calendar')}
        title={t('common.openCalendar', 'Open calendar')}
        // Phones: a ~40px hit area for the calendar (the icon stays 14px).
        className="right-1.5 p-0.5 max-sm:right-0.5 max-sm:p-[13px]"
        onClick={() => {
          const el = picker.current;
          if (!el) return;
          try { el.showPicker(); } catch { el.focus(); el.click(); }
        }}
        style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', color: '#64748B', lineHeight: 0 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
      </button>
      {/* The native picker only chooses a day; it is never shown as the field. */}
      <input
        ref={picker}
        type="date"
        lang={DAY_FIRST}
        tabIndex={-1}
        aria-hidden
        value={value || ''}
        min={min}
        max={max}
        disabled={disabled}
        onChange={e => { setBad(false); emit(e.target.value); }}
        style={{ position: 'absolute', right: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none', border: 0, padding: 0 }}
      />
    </span>
  );
}

/** Date-and-time box: dd/mm/yyyy day + a time box. Value 'YYYY-MM-DDTHH:MM' (datetime-local shape). */
export function DateTimeInput({ value, onChange, className, style, max, min }: {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  className?: string;
  style?: React.CSSProperties;
  min?: string;
  max?: string;
}) {
  const { t } = useTranslation();
  const day = (value || '').slice(0, 10);
  const time = (value || '').slice(11, 16);
  const emit = (d: string, tm: string) => onChange({ target: { value: d ? `${d}T${tm || '00:00'}` : '' } });
  return (
    <span lang={DAY_FIRST} style={{ display: 'flex', gap: 6 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <DateInput block value={day} min={min?.slice(0, 10)} max={max?.slice(0, 10)} className={className} style={style} onChange={e => emit(e.target.value, time)} />
      </span>
      <input type="time" lang={DAY_FIRST} aria-label={t('common.time', 'Time')} value={time} className={className}
        style={{ ...style, width: 120, flex: 'none' }} onChange={e => emit(day, e.target.value)} />
    </span>
  );
}
