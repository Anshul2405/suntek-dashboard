import React from 'react';
import { cn } from '../../lib/utils/cn';

type Variant = 'primary' | 'outline' | 'accent' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

/**
 * v2 button — 8px radius plant console.
 *  - primary: charcoal (logo black)
 *  - outline: steel border
 *  - accent:  Suntek orange
 *  - ghost / danger
 */
export function ButtonV2({
  variant = 'outline',
  size = 'md',
  icon,
  className,
  children,
  style,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold cursor-pointer',
        'transition-[background-color,border-color,color,transform] duration-150 ease-out',
        'enabled:active:scale-[0.98] min-h-[44px] md:min-h-0',
        'disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-[13px]',
        variant === 'primary' && 'bg-[#161616] text-white hover:bg-[#2A2A2A]',
        variant === 'outline' && 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300',
        variant === 'accent'  && 'bg-[#EF6C00] text-white hover:bg-[#D84315]',
        variant === 'ghost'   && 'bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700',
        variant === 'danger'  && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      style={{ fontFamily: 'inherit', ...style }}
      {...rest}
    >
      {icon && <span className="inline-flex shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5">{icon}</span>}
      {children}
    </button>
  );
}
