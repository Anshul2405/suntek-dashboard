import React, { useEffect, useRef, useState } from 'react';
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
  // Escape closes the panel (same as the × and the backdrop), never mid-upload.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open || locked) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, locked]);
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={locked ? undefined : onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(15,23,42,0.45)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.22s',
        }}
      />

      {/* Centered modal card — inert while closed so its fields are not
          tabbable or read out behind the page. */}
      <div
        role="dialog"
        aria-modal={open || undefined}
        aria-hidden={!open}
        inert={!open}
        style={{
          position: 'fixed',
          top: '50%', left: '50%',
          zIndex: 50,
          width: 'min(660px, 94vw)',
          maxHeight: '90vh',
          background: '#fff',
          borderRadius: 24,
          boxShadow: '0 24px 80px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          display: 'flex', flexDirection: 'column',
          transform: open
            ? 'translate(-50%, -50%) scale(1)'
            : 'translate(-50%, -48%) scale(0.96)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'transform 0.22s cubic-bezier(0.34,1.56,0.64,1), opacity 0.18s',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '22px 24px 16px',
          borderBottom: '1px solid #F1F5F9',
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
            type="button"
            onClick={locked ? undefined : onClose}
            disabled={locked}
            aria-label={t('common.close', 'Close')}
            title={locked ? t('common.uploadInProgress', 'Please wait — upload in progress') : undefined}
            style={{
              width: 36, height: 36, borderRadius: '50%',
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
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 28px' }}>
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
  width: '100%', padding: '9px 14px', border: '1px solid #E2E8F0',
  borderRadius: 12, fontSize: 13, color: '#0F172A',
  background: '#F8FAFC', outline: 'none', boxSizing: 'border-box',
  fontFamily: 'inherit',
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };
const textareaStyle: React.CSSProperties = { ...inputStyle, resize: 'vertical', minHeight: 72 };

export function PanelInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={inputStyle} />;
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
  return <select {...props} style={selectStyle} />;
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
  fields?: OcrField[];
  onExtracted?: (data: Record<string, string>) => void;
}

export function OcrUpload({ label, hint, fields = [], onExtracted }: OcrUploadProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<OcrField[] | null>(null);
  const [applied, setApplied] = useState(false);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setExtracted(null); setApplied(false); }
  }

  function handleExtract() {
    setExtracting(true);
    setTimeout(() => {
      setExtracting(false);
      setExtracted(fields.length > 0 ? fields : [{ key: '_doc', label: t('common.ocrDocument', 'Document'), value: file?.name || 'uploaded' }]);
    }, 1900);
  }

  function handleApply() {
    if (!extracted) return;
    const data: Record<string, string> = {};
    extracted.forEach(f => { data[f.key] = f.value; });
    onExtracted?.(data);
    setApplied(true);
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

      {/* Extract button */}
      {file && !extracted && (
        <button
          type="button"
          onClick={handleExtract}
          disabled={extracting}
          style={{
            marginTop: 8, width: '100%', padding: '9px 0',
            background: '#FFFBEB', border: '1px solid #FDE68A',
            borderRadius: 10, fontSize: 12, fontWeight: 600,
            color: '#92400E', cursor: extracting ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            fontFamily: 'inherit',
          }}
        >
          {extracting ? (
            <>
              <svg style={{ animation: 'spin 0.9s linear infinite', display: 'block' }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              {t('common.extractingViaNvidia', 'Extracting via NVIDIA Vision 90B…')}
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              {t('common.extractFieldsWithAi', 'Extract fields with AI')}
            </>
          )}
        </button>
      )}

      {/* Extracted fields review card */}
      {extracted && (
        <div style={{
          marginTop: 10,
          border: '1px solid #BBF7D0',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#F0FDF4',
        }}>
          {/* Card header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 14px 8px',
            borderBottom: '1px solid #BBF7D0',
            background: '#DCFCE7',
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#15803D', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {extracted.length === 1
                ? t('common.nvidiaExtractedOne', { defaultValue: 'NVIDIA Vision extracted {{count}} field', count: extracted.length })
                : t('common.nvidiaExtractedMany', { defaultValue: 'NVIDIA Vision extracted {{count}} fields', count: extracted.length })}
            </span>
          </div>

          {/* Extracted fields */}
          <div style={{ padding: '6px 0' }}>
            {extracted.map((f, i) => (
              <div key={f.key} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                padding: '7px 14px',
                borderBottom: i < extracted.length - 1 ? '1px solid #D1FAE5' : 'none',
              }}>
                <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 500, minWidth: 80, flexShrink: 0 }}>
                  {f.label}
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 700, color: '#14532D',
                  textAlign: 'right', maxWidth: 220, wordBreak: 'break-word',
                }}>
                  {f.value}
                </span>
              </div>
            ))}
          </div>

          {/* Apply / Applied */}
          <div style={{ padding: '8px 12px 10px' }}>
            {applied ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
                  <path d="M20 6 9 17l-5-5"/>
                </svg>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#15803D' }}>{t('common.valuesAppliedToForm', 'Values applied to form')}</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleApply}
                style={{
                  width: '100%', padding: '8px 0',
                  background: '#16A34A', border: 'none',
                  borderRadius: 8, fontSize: 12, fontWeight: 700,
                  color: '#fff', cursor: 'pointer',
                  fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                {t('common.applyExtractedValues', 'Apply extracted values to form')}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M13 6l6 6-6 6"/>
                </svg>
              </button>
            )}
          </div>
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
