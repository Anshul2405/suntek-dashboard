import React from 'react';
import { cn } from '../../lib/utils/cn';

/**
 * v2 section card — white card w/ title + subtitle header and right-aligned
 * actions (mockups: "Periodic maintenance schedule · Export", "Open Requirements ·
 * + Create requirement"). Use `flush` when the body is a full-bleed table.
 */
export function SectionCard({
  title,
  subtitle,
  actions,
  flush = false,
  className,
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Body renders full-bleed (tables); header keeps its own padding. */
  flush?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const hasHeader = title != null || subtitle != null || actions != null;
  return (
    <div className={cn('card2 overflow-hidden', className)}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 flex-wrap px-5 pt-5 pb-4">
          <div>
            {title && <div className="font-heading font-semibold text-[18px] leading-tight tracking-tight text-[#161616]">{title}</div>}
            {subtitle && <div className="text-[12.5px] text-slate-500 mt-0.5">{subtitle}</div>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </div>
      )}
      <div className={flush ? undefined : cn('px-5 pb-5', !hasHeader && 'pt-5')}>{children}</div>
    </div>
  );
}
