import React, { useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MentionTextarea } from './mentions/MentionTextarea';

// ── Slide-in drawer ───────────────────────────────────────────────────────────

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** When true, the panel cannot be dismissed (backdrop + close button disabled).
   *  Use during an in-flight upload so an accidental click can't cancel it. */
  locked?: boolean;
}

export function SlidePanel({ open, onClose, title, subtitle, children, locked = false }: SlidePanelProps) {
  const { t } = useTranslation();
  return (
    <>
      {/* Backdrop */}
      <div
        className="slide-backdrop"
        onClick={locked ? undefined : onClose}
        style={{
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      />

      <div
        className="slide-card"
        data-open={open ? 'true' : 'false'}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
      >
        {/* Header */}
        <div style={{
          padding: '18px 20px 14px',
          borderBottom: '1px solid #E4E9EF',
          flexShrink: 0,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        }}>
          <div>
            {subtitle && (
              <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                {subtitle}
              </div>
            )}
            <div className="font-heading" style={{ fontSize: 18, fontWeight: 600, color: '#0F172A' }}>{title}</div>
          </div>
          <button
            onClick={locked ? undefined : onClose}
            disabled={locked}
            title={locked ? t('common.uploadInProgress', 'Please wait — upload in progress') : undefined}
            style={{
              width: 36, height: 36, borderRadius: 8,
              background: '#F1F5F9', border: 'none', cursor: locked ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginLeft: 16, flexShrink: 0, marginTop: 2,
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { if (!locked) e.currentTarget.style.background = '#E2E8F0'; }}
            onMouseLeave={e => { if (!locked) e.currentTarget.style.background = '#F1F5F9'; }}
          >
            {locked ? (
              <span style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid #CBD5E1', borderTopColor: '#64748B', display: 'block', animation: 'sp-spin 0.7s linear infinite' }} />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth="2.5">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            )}
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 24px' }}>
          {children}
        </div>
      </div>
    </>
  );
}

// ── Shared field helpers ──────────────────────────────────────────────────────

export function PanelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', border: '1px solid #CDD5DE',
  borderRadius: 8, fontSize: 14, color: '#071422',
  background: '#fff', outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit',
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };
const textareaStyle: React.CSSProperties = { ...inputStyle, resize: 'vertical', minHeight: 72 };

export function PanelInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`panel-input ${props.className ?? ''}`.trim()} style={{ ...inputStyle, ...props.style }} />;
}

/** Password field with a show/hide eye toggle, styled to match panel inputs. Use
 *  wherever a panel collects a password so the affordance matches the login page. */
export function PanelPasswordInput(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input {...props} type={show ? 'text' : 'password'} style={{ ...inputStyle, paddingRight: 40 }} />
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        aria-label={show ? 'Hide password' : 'Show password'}
        tabIndex={-1}
        style={{ position: 'absolute', top: 0, right: 0, height: '100%', display: 'flex', alignItems: 'center', padding: '0 12px', border: 'none', background: 'none', color: '#94A3B8', cursor: 'pointer' }}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
export function PanelSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`panel-input ${props.className ?? ''}`.trim()} style={{ ...selectStyle, ...props.style }} />;
}
export function PanelTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { value, onChange, style, placeholder, rows } = props;
  // Upgrade controlled string textareas to @-mention aware (Teams-style
  // tagging) — so every panel form gets the same tagging behaviour for free.
  // The synthetic event keeps each form's existing `e.target.value` handler
  // working unchanged.
  if (typeof value === 'string' && onChange) {
    return (
      <MentionTextarea
        value={value}
        onChange={(v) =>
          onChange({ target: { value: v }, currentTarget: { value: v } } as unknown as React.ChangeEvent<HTMLTextAreaElement>)
        }
        placeholder={typeof placeholder === 'string' ? placeholder : undefined}
        rows={typeof rows === 'number' ? rows : undefined}
        style={{ ...textareaStyle, ...(style as React.CSSProperties | undefined) }}
      />
    );
  }
  return <textarea {...props} style={{ ...textareaStyle, ...(style as React.CSSProperties | undefined) }} />;
}

export function PanelRow({ children, cols = 2 }: { children: React.ReactNode; cols?: number }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 14, marginBottom: 16 }}>{children}</div>;
}

export function PanelDivider() {
  return <hr style={{ border: 'none', borderTop: '1px solid #F1F5F9', margin: '18px 0' }} />;
}

export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// ── OCR image upload ──────────────────────────────────────────────────────────

export interface OcrField {
  key: string;
  label: string;
  value: string;
}

interface OcrUploadProps {
  label: string;
  hint?: string;
  /** Kept so older forms still compile. This control no longer invents field values. */
  fields?: OcrField[];
  onExtracted?: (data: Record<string, string>) => void;
  onFile?: (file: File | null) => void;
}

export function OcrUpload({ label, hint, onFile }: OcrUploadProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    onFile?.(f);
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </label>

      {/* Drop zone */}
      <div
        onClick={() => ref.current?.click()}
        style={{
          border: `2px dashed ${file ? '#A3E635' : '#CBD5E1'}`, borderRadius: 12, padding: '14px 12px',
          textAlign: 'center', cursor: 'pointer', background: file ? '#F7FEE7' : '#F8FAFC',
          transition: 'all 0.15s',
        }}
      >
        {file ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#65A30D" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#365314' }}>{file.name}</span>
            <span style={{ fontSize: 11, color: '#84CC16' }}>· {t('common.tapToChange', 'tap to change')}</span>
          </div>
        ) : (
          <>
            <svg style={{ margin: '0 auto 6px', display: 'block', color: '#94A3B8' }} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
            <div style={{ fontSize: 12, color: '#64748B' }}>{t('common.clickToUploadImagePdf', 'Click to upload image or PDF')}</div>
            {hint && <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>{hint}</div>}
          </>
        )}
      </div>
      <input ref={ref} type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleFile} />
      {file && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#64748B' }}>
          {t('common.proofAttached', 'This file is kept with the entry. Type the fields yourself.')}
        </div>
      )}
    </div>
  );
}

// ── Submit / Success footer ───────────────────────────────────────────────────

interface PanelFooterProps {
  saved: boolean;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
  successLabel?: string;
  successSub?: string;
  disabled?: boolean;
  requiredHint?: string;
}

export function PanelFooter({
  saved, onCancel, onSave,
  saveLabel,
  successLabel,
  successSub,
  disabled = false,
  requiredHint,
}: PanelFooterProps) {
  const { t } = useTranslation();
  const saveText    = saveLabel    ?? t('common.submit', 'Submit');
  const successText = successLabel ?? t('common.submitted', 'Submitted');
  const successSubText = successSub ?? t('common.entrySavedSuccessfully', 'Entry saved successfully');
  // Universal double-submit guard: once Save is clicked, the button is locked
  // until onSave() settles — so rapid clicks can never fire duplicate writes.
  // Every panel form that uses PanelFooter inherits this for free.
  const [submitting, setSubmitting] = useState(false);
  const blocked = disabled || submitting;

  async function handleSave() {
    if (blocked) return;
    setSubmitting(true);
    try {
      await onSave();
    } finally {
      setSubmitting(false);
    }
  }

  if (saved) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <div style={{
          width: 52, height: 52, borderRadius: '50%',
          background: '#F0FDF4', margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </div>
        <div style={{ fontWeight: 700, color: '#15803D', marginBottom: 4 }}>{successText}</div>
        <div style={{ fontSize: 12, color: '#64748B' }}>{successSubText}</div>
      </div>
    );
  }

  return (
    <div>
      {disabled && requiredHint && (
        <div style={{ fontSize: 11, color: '#94A3B8', textAlign: 'center', marginBottom: 8 }}>
          {requiredHint}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={{
            flex: 1, padding: '11px 0', borderRadius: 24, border: '1px solid #E2E8F0',
            background: '#F8FAFC', fontSize: 13, fontWeight: 600, color: '#475569',
            cursor: submitting ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={blocked}
          style={{
            flex: 2, padding: '11px 0', borderRadius: 24, border: 'none',
            background: blocked ? '#CBD5E1' : '#F47651',
            fontSize: 13, fontWeight: 700, color: '#fff',
            cursor: blocked ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s',
          }}
        >
          {submitting ? t('common.saving', 'Saving…') : saveText}
        </button>
      </div>
    </div>
  );
}
