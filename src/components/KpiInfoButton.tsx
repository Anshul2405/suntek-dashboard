import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface KpiMeta {
  title: string;
  what: string;
  source: 'BUSY DB' | 'Supabase' | 'Derived' | 'Form entry' | 'Mock data';
  tables?: string[];
  dbPath?: string;
  filter?: string;
  formula?: string;
  formPath?: string;
  formLabel?: string;
  note?: string;
}

const SRC_STYLE: Record<KpiMeta['source'], { bg: string; color: string; dot: string }> = {
  'BUSY DB':    { bg: '#1E3A5F', color: '#93C5FD', dot: '#3B82F6' },
  'Supabase':   { bg: '#1A3A2A', color: '#86EFAC', dot: '#22C55E' },
  'Derived':    { bg: '#3B1F5E', color: '#D8B4FE', dot: '#A855F7' },
  'Form entry': { bg: '#3B2A10', color: '#FCD34D', dot: '#F59E0B' },
  'Mock data':  { bg: '#1F2937', color: '#9CA3AF', dot: '#6B7280' },
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {children}
    </div>
  );
}

function codeStyle(bg: string, color: string): React.CSSProperties {
  return {
    fontSize: 10, padding: '2px 6px', borderRadius: 5,
    background: bg, color,
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
  };
}

export function KpiInfoButton({ info, style }: { info: KpiMeta; style?: React.CSSProperties }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  function openTooltip() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawLeft = rect.right - 284;
    setPos({ top: rect.bottom + 6, left: Math.max(8, rawLeft) });
    setShow(true);
  }

  const sc = SRC_STYLE[info.source] ?? SRC_STYLE['Mock data'];

  return (
    <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, ...style }}>
      <button
        ref={btnRef}
        onMouseEnter={e => {
          (e.currentTarget as HTMLElement).style.background = 'rgba(148,163,184,0.28)';
          (e.currentTarget as HTMLElement).style.borderColor = 'rgba(148,163,184,0.6)';
          openTooltip();
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLElement).style.background = 'rgba(148,163,184,0.15)';
          (e.currentTarget as HTMLElement).style.borderColor = 'rgba(148,163,184,0.35)';
          setShow(false);
        }}
        onClick={(e) => { e.stopPropagation(); if (show) setShow(false); else openTooltip(); }}
        // Phones: an invisible 44px tap area round the 18px dot.
        className="relative max-sm:before:absolute max-sm:before:-inset-[14px]"
        style={{
          width: 18, height: 18, borderRadius: '50%',
          background: 'rgba(148,163,184,0.15)',
          border: '1px solid rgba(148,163,184,0.35)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 800, color: '#94A3B8',
          fontFamily: 'serif', lineHeight: 1,
        }}
      >
        i
      </button>

      {show && createPortal(
        <div
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
          style={{
            position: 'fixed', top: pos.top, left: pos.left,
            zIndex: 99999, width: 284,
            background: '#0F172A',
            borderRadius: 12,
            boxShadow: '0 16px 48px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.07)',
            overflow: 'hidden',
            fontFamily: 'Inter, system-ui, sans-serif',
            pointerEvents: 'auto',
          }}
        >
          <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '2px 8px', borderRadius: 20, marginBottom: 7,
              background: sc.bg, color: sc.color,
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: sc.dot, display: 'inline-block', flexShrink: 0 }}/>
              {info.source}
            </span>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#F8FAFC', lineHeight: 1.3 }}>{info.title}</div>
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 5, lineHeight: 1.55 }}>{info.what}</div>
          </div>

          <div style={{ padding: '10px 14px 13px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            {info.tables && info.tables.length > 0 && (
              <div>
                <Label>DB Tables</Label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {info.tables.map(t => (
                    <code key={t} style={codeStyle('#1E3A5F', '#93C5FD')}>{t}</code>
                  ))}
                </div>
              </div>
            )}

            {info.dbPath && (
              <div>
                <Label>DBeaver Path</Label>
                <code style={{ ...codeStyle('#0C2340', '#7DD3FC'), display: 'block', marginTop: 4, padding: '4px 8px', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {info.dbPath}
                </code>
              </div>
            )}

            {info.filter && (
              <div>
                <Label>Filter / Scope</Label>
                <code style={{ ...codeStyle('#0A2218', '#86EFAC'), display: 'block', marginTop: 4, padding: '4px 8px' }}>
                  {info.filter}
                </code>
              </div>
            )}

            {info.formula && (
              <div>
                <Label>Formula</Label>
                <code style={{ ...codeStyle('#1E0A3B', '#D8B4FE'), display: 'block', marginTop: 4, padding: '4px 8px', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {info.formula}
                </code>
              </div>
            )}

            {info.formPath && (
              <div>
                <Label>Data Entry</Label>
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: '#FCD34D' }}>{info.formLabel ?? 'Form'}</span>
                  <span style={{ fontSize: 10, color: '#64748B' }}>→</span>
                  <code style={codeStyle('#2D1E07', '#FCD34D')}>{info.formPath}</code>
                </div>
              </div>
            )}

            {info.note && (
              <div style={{
                marginTop: 2, padding: '7px 9px', borderRadius: 7,
                background: 'rgba(255,255,255,0.04)',
                fontSize: 10, color: '#64748B', lineHeight: 1.55,
              }}>
                {info.note}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
