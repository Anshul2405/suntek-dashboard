import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils/cn';

export type StatTone = 'default' | 'amber' | 'red' | 'orange' | 'green' | 'blue' | 'purple';

/** Soft icon-square background + icon color per tone. */
const ICON_TONES: Record<StatTone, string> = {
  default: 'bg-slate-100 text-slate-600',
  amber:   'bg-amber-50 text-amber-500',
  red:     'bg-red-50 text-red-500',
  orange:  'bg-orange-50 text-orange-500',
  green:   'bg-green-50 text-green-600',
  blue:    'bg-blue-50 text-blue-600',
  purple:  'bg-slate-100 text-slate-600',
};

const VALUE_TONES: Record<StatTone, string> = {
  default: 'text-slate-900',
  amber:   'text-amber-700',
  red:     'text-red-600',
  orange:  'text-orange-600',
  green:   'text-teal-700',
  blue:    'text-blue-700',
  purple:  'text-slate-700',
};

/**
 * v2 KPI stat card (mockups: "DUE TODAY 0", "OVERDUE 510", "On Duty Tonight 08").
 * `tone` colors the icon square; `valueTone` colors the big number independently
 * (mockup: Overdue has a red icon AND red number, Due Today amber icon, dark number).
 */
export function StatCard({
  icon,
  label,
  value,
  caption,
  tone = 'default',
  valueTone = 'default',
  onView,
  viewLabel,
  className,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  caption?: React.ReactNode;
  tone?: StatTone;
  valueTone?: StatTone;
  /** Renders a "View … →" link (mockup: Night Manager KPI cards). */
  onView?: () => void;
  viewLabel?: React.ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const clickable = !!onView;
  return (
    <div
      className={cn('card2 p-5', clickable && 'cursor-pointer hover:border-slate-300 hover:shadow-sm transition', className)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onView : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onView?.(); } } : undefined}
    >
      <div className="flex items-center gap-2.5 mb-3">
        {icon && (
          <span
            className={cn(
              'w-9 h-9 rounded-[10px] inline-flex items-center justify-center shrink-0 [&>svg]:w-4 [&>svg]:h-4',
              ICON_TONES[tone],
            )}
          >
            {icon}
          </span>
        )}
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          {label}
        </span>
      </div>
      <div className={cn('text-[30px] font-bold leading-none num', VALUE_TONES[valueTone])}>
        {value}
      </div>
      {caption && <div className="text-xs text-slate-500 mt-2">{caption}</div>}
      {onView && (
        <span className="text-[#D84315] text-xs font-semibold mt-2.5 hover:underline flex items-center gap-1">
          {viewLabel ?? t('common.view', 'View')} →
        </span>
      )}
    </div>
  );
}
