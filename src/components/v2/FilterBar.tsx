import React from 'react';
import { Search, RotateCw, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils/cn';
import { ButtonV2 } from './Button';

/**
 * v2 filter bar — white card holding a search input, dropdown filters and Reset
 * (mockups: "Search task, equipment or plant… · All Plants · All Status · Reset").
 * Pair the search with the existing `useTextFilter` hook.
 */
export function FilterBar({
  search,
  onSearch,
  searchPlaceholder,
  onReset,
  children,
  className,
}: {
  search?: string;
  onSearch?: (q: string) => void;
  searchPlaceholder?: string;
  onReset?: () => void;
  /** `FilterSelect`s (or any extra controls). */
  children?: React.ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('card2 p-3 flex items-end gap-2.5 flex-wrap', className)}>
      {onSearch && (
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            value={search ?? ''}
            onChange={e => onSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-200 text-[13px] bg-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#EF6C00]/25 focus:border-[#EF6C00] transition-[border-color,box-shadow] duration-150"
          />
        </div>
      )}
      {children}
      {onReset && (
        <ButtonV2
          variant="outline" icon={<RotateCw />} onClick={onReset}
          title={t('common.resetHint', 'Clear the search box and set every filter back to "All"')}
        >
          {t('common.reset')}
        </ButtonV2>
      )}
    </div>
  );
}

/**
 * Labeled dropdown filter (native select for accessibility, styled as an
 * outlined button). `label` renders the small floating caption used on the
 * Asset mockup ("Plant", "QR Status"); omit it for inline bars.
 */
export function FilterSelect({
  label,
  icon,
  value,
  onChange,
  options,
  className,
}: {
  label?: React.ReactNode;
  icon?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && <span className="text-[11px] text-slate-500 font-medium px-0.5">{label}</span>}
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none inline-flex [&>svg]:w-3.5 [&>svg]:h-3.5">
            {icon}
          </span>
        )}
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className={cn(
            'appearance-none rounded-[10px] border border-slate-200 bg-white text-[13px] font-medium text-slate-700 py-2.5 pr-9 cursor-pointer',
            'hover:bg-slate-50 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-200 transition',
            icon ? 'pl-9' : 'pl-3.5',
          )}
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      </div>
    </div>
  );
}
