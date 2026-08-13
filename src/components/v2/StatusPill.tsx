import React from 'react';
import { cn } from '../../lib/utils/cn';

export type PillTone = 'green' | 'amber' | 'orange' | 'red' | 'blue' | 'purple' | 'slate';

const TONES: Record<PillTone, string> = {
  green:  'bg-green-50 text-green-700',
  amber:  'bg-amber-50 text-amber-700',
  orange: 'bg-orange-50 text-orange-600',
  red:    'bg-red-50 text-red-700',
  blue:   'bg-blue-50 text-blue-700',
  purple: 'bg-slate-100 text-slate-700',
  slate:  'bg-slate-100 text-slate-600',
};

const DOTS: Record<PillTone, string> = {
  green:  'bg-teal-600',
  amber:  'bg-amber-500',
  orange: 'bg-orange-500',
  red:    'bg-red-500',
  blue:   'bg-blue-500',
  purple: 'bg-slate-500',
  slate:  'bg-slate-400',
};

/** v2 soft status pill — "Generated", "Not Generated" (dot), "Open", "Approved"… */
export function StatusPill({
  tone = 'slate',
  label,
  dot = false,
  icon,
  className,
}: {
  tone?: PillTone;
  label: React.ReactNode;
  /** Leading colored dot (mockup: "Not Generated"). */
  dot?: boolean;
  /** Leading icon (mockup: "✓ Generated"). Overrides `dot`. */
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {icon
        ? <span className="inline-flex shrink-0 [&>svg]:w-3 [&>svg]:h-3">{icon}</span>
        : dot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', DOTS[tone])} />}
      {label}
    </span>
  );
}
