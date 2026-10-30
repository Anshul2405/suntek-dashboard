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
 * v2 page-level segment tabs — pill buttons; active = navy fill, white text
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
  // In the phone strip, bring the selected chip into view (e.g. Payments).
  const activeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const el = activeRef.current;
    const strip = el?.parentElement;
    if (!el || !strip || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = Math.max(0, el.offsetLeft - strip.offsetLeft - 16);
  }, [value]);
  return (
    // Phones: one strip that scrolls sideways by itself (never two broken rows
    // that clip a chip); desktop wraps as before.
    <div className={cn('flex items-center gap-2 flex-wrap max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} role="tablist">
      {items.filter(it => !it.hidden).map(it => {
        const active = it.key === value;
        return (
          <button
            key={it.key}
            ref={active ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.key)}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-[10px] text-[13px] font-medium transition-colors whitespace-nowrap border shrink-0 max-sm:min-h-[44px]',
              active
                ? 'bg-slate-900 text-white border-slate-900'
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
