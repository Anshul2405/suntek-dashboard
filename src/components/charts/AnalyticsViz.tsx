import React from 'react';
import { useTranslation } from 'react-i18next';

// ── DSO Arc Gauge ─────────────────────────────────────────────────────────────
// Semicircle: left=0 days, right=90 days. Zones: green 0-30, amber 30-60, red 60+

function pt(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

export function DSOGauge({ value }: { value: number }) {
  const { t } = useTranslation();
  const cx = 70, cy = 80, r = 52, sw = 11;
  // angle mapping: 0 days→180°, 90 days→0°
  const angleDeg = (v: number) => 180 - (v / 90) * 180;
  const p0  = pt(cx, cy, r, 180);   // 0 days
  const p30 = pt(cx, cy, r, angleDeg(30));
  const p60 = pt(cx, cy, r, angleDeg(60));
  const p90 = pt(cx, cy, r, 0);     // 90 days
  const pVal = pt(cx, cy, r, angleDeg(Math.min(value, 90)));
  const color = value < 30 ? '#16A34A' : value < 60 ? '#D97706' : '#DC2626';

  const arc = (from: {x:number;y:number}, to: {x:number;y:number}, clr: string) =>
    `M ${from.x.toFixed(1)},${from.y.toFixed(1)} A ${r},${r} 0 0,1 ${to.x.toFixed(1)},${to.y.toFixed(1)}`;

  return (
    <svg width="140" height="90" viewBox="0 0 140 90">
      {/* Grey backdrop */}
      <path d={arc(p0, p90, '')} fill="none" stroke="#F1F5F9" strokeWidth={sw} strokeLinecap="round"/>
      {/* Green zone 0-30 */}
      <path d={arc(p0, p30, '')} fill="none" stroke="#DCFCE7" strokeWidth={sw}/>
      {/* Amber zone 30-60 */}
      <path d={arc(p30, p60, '')} fill="none" stroke="#FEF3C7" strokeWidth={sw}/>
      {/* Red zone 60-90 */}
      <path d={arc(p60, p90, '')} fill="none" stroke="#FEE2E2" strokeWidth={sw}/>
      {/* Value fill */}
      <path d={arc(p0, pVal, '')} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      {/* Indicator dot */}
      <circle cx={pVal.x.toFixed(1)} cy={pVal.y.toFixed(1)} r="5" fill={color}/>
      {/* Labels */}
      <text x="12" y="84" fontSize="8" fill="#94A3B8">0</text>
      <text x="60" y="20" fontSize="8" fill="#94A3B8" textAnchor="middle">45</text>
      <text x="126" y="84" fontSize="8" fill="#94A3B8">90</text>
      {/* Center value */}
      <text x={cx} y="64" textAnchor="middle" fontSize="18" fontWeight="800" fill={color}>{Number.isFinite(value) ? value.toFixed(1) : '—'}</text>
      <text x={cx} y="76" textAnchor="middle" fontSize="9" fill="#94A3B8">{t('common.days', 'days')}</text>
    </svg>
  );
}

// ── Thin Donut Ring ───────────────────────────────────────────────────────────

export function RingProgress({ pct, color = '#16A34A', label }: { pct: number; color?: string; label?: string }) {
  const r = 38, sw = 9, cx = 48, cy = 48;
  const circ = 2 * Math.PI * r;
  const fill = circ * (pct / 100);
  return (
    <svg width="96" height="96" viewBox="0 0 96 96">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#F1F5F9" strokeWidth={sw}/>
      <circle
        cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={`${fill.toFixed(1)} ${circ.toFixed(1)}`}
        transform="rotate(-90 48 48)"
      />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="16" fontWeight="800" fill="#161616">{pct.toFixed(1)}%</text>
      {label && <text x={cx} y={cy + 10} textAnchor="middle" fontSize="8" fill="#94A3B8">{label}</text>}
    </svg>
  );
}

// ── Mini Bar Sparkline ────────────────────────────────────────────────────────

export function MiniBarChart({ data, labels, color = '#F47651', height = 40 }: {
  data: number[];
  labels?: string[];
  color?: string;
  height?: number;
}) {
  if (!data.length) return null;
  const w = 200, h = height;
  const max = Math.max(...data);
  const bw = Math.floor(w / data.length) - 4;
  const gap = Math.floor(w / data.length);

  return (
    <svg width={w} height={h + 14} viewBox={`0 0 ${w} ${h + 14}`}>
      {data.map((v, i) => {
        const bh = max > 0 ? (v / max) * h : 0;
        const x = i * gap + 2;
        const y = h - bh;
        const isLast = i === data.length - 1;
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw} height={bh}
              rx="3" fill={isLast ? `${color}88` : color}
            />
            {labels && (
              <text x={x + bw / 2} y={h + 11} textAnchor="middle" fontSize="8" fill="#94A3B8">
                {labels[i]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Horizontal Concentration Bar ──────────────────────────────────────────────

const CONC_COLORS = ['#F47651', '#FB923C', '#FDBA74', '#FCD9C5', '#FEF3C7', '#E2E8F0'];

export function ConcentrationBar({ segments }: {
  segments: { name: string; sharePct: number }[];
}) {
  const { t } = useTranslation();
  const others = Math.max(0, 100 - segments.reduce((s, c) => s + c.sharePct, 0));
  const all = [...segments, { name: t('common.others', 'Others'), sharePct: +others.toFixed(1) }];
  let x = 0;
  return (
    <div>
      <svg width="100%" height="18" viewBox="0 0 400 18" preserveAspectRatio="none">
        {all.map((s, i) => {
          const w = (s.sharePct / 100) * 400;
          const rect = <rect key={i} x={x} y="0" width={w} height="18" rx={i === 0 ? 4 : i === all.length - 1 ? 4 : 0} fill={CONC_COLORS[i] || '#E2E8F0'}/>;
          x += w;
          return rect;
        })}
      </svg>
      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginTop: 8 }}>
        {all.slice(0, -1).map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: CONC_COLORS[i], flexShrink: 0 }}/>
            <span style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }}>
              {s.name} <strong>{s.sharePct}%</strong>
            </span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: '#E2E8F0', flexShrink: 0 }}/>
          <span style={{ fontSize: 10, color: '#94A3B8' }}>{t('common.others', 'Others')} {others.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

// ── Bullet Compare (two values side by side) ──────────────────────────────────

export function BulletCompare({ left, right, leftLabel, rightLabel, leftColor = '#EF6C00', rightColor = '#161616' }: {
  left: number; right: number;
  leftLabel: string; rightLabel: string;
  leftColor?: string; rightColor?: string;
}) {
  const total = left + right;
  const lPct = total > 0 ? (left / total) * 100 : 50;
  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ width: `${lPct}%`, background: leftColor, transition: 'width 0.4s' }}/>
        <div style={{ flex: 1, background: rightColor }}/>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748B' }}>
        <span style={{ color: leftColor, fontWeight: 600 }}>{leftLabel}</span>
        <span style={{ color: rightColor, fontWeight: 600 }}>{rightLabel}</span>
      </div>
    </div>
  );
}

// ── Overdue Aging Bar (4 age buckets) ────────────────────────────────────────
// Green → Amber → Orange → Red as debt gets older

interface AgingData {
  d1_30: number; d31_60: number; d61_90: number; d90plus: number;
  c1_30: number; c31_60: number; c61_90: number; c90plus: number;
}

const AGING_COLORS = ['#16A34A', '#D97706', '#EA580C', '#DC2626'];
const AGING_LABELS = ['1–30 d', '31–60 d', '61–90 d', '90+ d'];

export function OverdueAgingBar({ aging }: { aging: AgingData }) {
  const buckets = [aging.d1_30, aging.d31_60, aging.d61_90, aging.d90plus];
  const counts  = [aging.c1_30, aging.c31_60, aging.c61_90, aging.c90plus];
  const total   = buckets.reduce((s, v) => s + v, 0) || 1;

  function fmtL(n: number) {
    if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(1)}Cr`;
    if (n >= 100_000)   return `₹${(n / 100_000).toFixed(1)}L`;
    return `₹${Math.round(n).toLocaleString('en-IN')}`;
  }

  let x = 0;
  return (
    <div>
      <svg width="100%" height="14" viewBox="0 0 400 14" preserveAspectRatio="none">
        {buckets.map((v, i) => {
          const w = (v / total) * 400;
          const rect = (
            <rect key={i} x={x} y="0" width={Math.max(w, 0)} height="14"
              rx={i === 0 ? 4 : i === 3 ? 4 : 0}
              fill={v > 0 ? AGING_COLORS[i] : 'transparent'}
            />
          );
          x += w;
          return rect;
        })}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 10px', marginTop: 8 }}>
        {buckets.map((v, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: AGING_COLORS[i], flexShrink: 0 }}/>
            <span style={{ fontSize: 10, color: '#475569' }}>
              {AGING_LABELS[i]} <strong style={{ color: AGING_COLORS[i] }}>{fmtL(v)}</strong>
              <span style={{ color: '#94A3B8' }}> ({counts[i]})</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Delta Badge ───────────────────────────────────────────────────────────────

export function DeltaBadge({ value, unit = '%', invert = false }: { value: number; unit?: string; invert?: boolean }) {
  const good = invert ? value < 0 : value > 0;
  const color = good ? '#16A34A' : value === 0 ? '#64748B' : '#DC2626';
  const bg    = good ? '#F0FDF4' : value === 0 ? '#F1F5F9' : '#FEF2F2';
  const arrow = value > 0 ? '↑' : value < 0 ? '↓' : '→';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      padding: '2px 7px', borderRadius: 20,
      background: bg, color, fontSize: 11, fontWeight: 700,
    }}>
      {arrow} {Math.abs(value).toFixed(1)}{unit}
    </span>
  );
}
