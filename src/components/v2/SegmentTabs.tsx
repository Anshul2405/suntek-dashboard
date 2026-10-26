import React from 'react';
import { cn } from '../../lib/utils/cn';

export interface SegmentTabItem<K extends string = string> {
  key: K;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Role-gated tabs: render nothing for this item when true. */
  hidden?: boolean;
  /** Small count badge after the label. */
  count?: number;
}

/**
 * v2 page-level segment tabs — active = charcoal + saffron underline
 * (mockups: Periodic / Emergency / Schedule Setup, Requirements / Stock Register / Scrap).
 */
export function SegmentTabs<K extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: SegmentTabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 flex-nowrap overflow-x-auto scroll-x -mx-1 px-1 pb-1',
        'md:flex-wrap md:overflow-visible md:pb-0',
        className,
      )}
      role="tablist"
    >
      {items.filter(it => !it.hidden).map(it => {
        const active = it.key === value;
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.key)}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2.5 md:py-2 rounded-lg text-[13px] font-medium transition-colors whitespace-nowrap border shrink-0',
              'min-h-[44px] md:min-h-0 active:scale-[0.98]',
              active
                ? 'bg-[#161616] text-white border-[#161616] shadow-[inset_0_-2px_0_#EF6C00]'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300',
            )}
          >
            {it.icon && <span className="inline-flex shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5">{it.icon}</span>}
            {it.label}
            {it.count != null && it.count > 0 && (
              <span
                className={cn(
                  'inline-block px-1.5 py-px rounded-full text-[10px] font-bold',
                  active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500',
                )}
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
