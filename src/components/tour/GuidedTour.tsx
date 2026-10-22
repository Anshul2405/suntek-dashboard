/**
 * Lightweight spotlight tour — no third-party dependency.
 * Highlights [data-tour="…"] targets; steps without a target show a centered card.
 * Supports controlled step index for cross-route hosts.
 */
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

export type GuidedTourStep = {
  id: string;
  /** Matches data-tour on the page. Omit for a centered explanation. */
  target?: string;
  /** When set, the tour host should navigate here before showing the step. */
  path?: string;
  /** When set, the Create-sheet wizard is moved to this stage (0-3) for the step. */
  wizardStep?: 0 | 1 | 2 | 3;
  titleKey: string;
  bodyKey: string;
  titleDefault: string;
  bodyDefault: string;
};

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 8;

function readTargetRect(target?: string): Rect | null {
  if (!target || typeof document === 'undefined') return null;
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 && r.height < 2) return null;
  return {
    top: Math.max(0, r.top - PAD),
    left: Math.max(0, r.left - PAD),
    width: Math.min(window.innerWidth - 16, r.width + PAD * 2),
    height: Math.min(window.innerHeight - 16, r.height + PAD * 2),
  };
}

interface GuidedTourProps {
  open: boolean;
  steps: GuidedTourStep[];
  onClose: () => void;
  /** i18n namespace prefix, e.g. batchSheetTour */
  i18nPrefix?: string;
  /** Controlled step index (required for multi-route hosts). */
  stepIndex?: number;
  onStepIndexChange?: (index: number) => void;
}

export function GuidedTour({
  open,
  steps,
  onClose,
  i18nPrefix = 'batchSheetTour',
  stepIndex: controlledIndex,
  onStepIndexChange,
}: GuidedTourProps) {
  const { t } = useTranslation();
  const [uncontrolledIndex, setUncontrolledIndex] = useState(0);
  const controlled = typeof controlledIndex === 'number' && !!onStepIndexChange;
  const index = controlled ? controlledIndex : uncontrolledIndex;
  const setIndex = useCallback(
    (next: number | ((prev: number) => number)) => {
      const value = typeof next === 'function' ? next(index) : next;
      if (controlled) onStepIndexChange!(value);
      else setUncontrolledIndex(value);
    },
    [controlled, index, onStepIndexChange],
  );

  const [rect, setRect] = useState<Rect | null>(null);

  const step = steps[index];
  const total = steps.length;
  const isLast = index >= total - 1;

  const measure = useCallback(() => {
    if (!open || !step) {
      setRect(null);
      return;
    }
    setRect(readTargetRect(step.target));
  }, [open, step]);

  useEffect(() => {
    if (!open) {
      if (!controlled) setUncontrolledIndex(0);
      return;
    }
    if (!controlled) setUncontrolledIndex(0);
  }, [open, controlled]);

  useLayoutEffect(() => {
    if (!open || !step) return;
    const el = step.target
      ? document.querySelector(`[data-tour="${step.target}"]`)
      : null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    measure();
    // After route changes, DOM mounts late — retry briefly.
    const timers = [120, 280, 500, 900, 1400].map((ms) => window.setTimeout(measure, ms));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [open, step, index, measure]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        if (isLast) onClose();
        else setIndex(Math.min(total - 1, index + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIndex(Math.max(0, index - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isLast, total, onClose, setIndex, index]);

  if (!open || !step) return null;

  const title = t(`${i18nPrefix}.${step.titleKey}`, step.titleDefault);
  const body = t(`${i18nPrefix}.${step.bodyKey}`, step.bodyDefault);

  let cardStyle: React.CSSProperties;
  if (rect) {
    const spaceBelow = window.innerHeight - (rect.top + rect.height);
    const placeAbove = spaceBelow < 220 && rect.top > 240;
    const top = placeAbove
      ? Math.max(12, rect.top - 12)
      : Math.min(window.innerHeight - 24, rect.top + rect.height + 12);
    const left = Math.min(
      Math.max(16, rect.left + rect.width / 2),
      window.innerWidth - 16,
    );
    cardStyle = {
      position: 'fixed',
      top,
      left,
      transform: placeAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      zIndex: 80,
    };
  } else {
    cardStyle = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 80,
    };
  }

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby="guided-tour-title">
      <div className="absolute inset-0 pointer-events-auto" onClick={onClose} aria-hidden>
        {rect ? (
          <div
            className="absolute rounded-xl transition-all duration-200 pointer-events-none"
            style={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.55)',
              outline: '2px solid #F59E0B',
              outlineOffset: 2,
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-slate-900/55" />
        )}
      </div>

      <div
        className="w-[min(420px,calc(100vw-2rem))] rounded-2xl bg-white shadow-xl border border-slate-200 pointer-events-auto"
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
              {t(`${i18nPrefix}.stepOf`, {
                defaultValue: 'Step {{current}} of {{total}}',
                current: index + 1,
                total,
              })}
            </div>
            <h2 id="guided-tour-title" className="mt-1 text-base font-bold text-slate-900 font-heading leading-snug">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label={t(`${i18nPrefix}.skip`, 'Skip')}
          >
            <X size={16} />
          </button>
        </div>
        <p className="px-4 text-sm text-slate-600 leading-relaxed whitespace-pre-line">{body}</p>
        <div className="flex items-center justify-between gap-2 px-4 py-4 mt-1 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-semibold text-slate-500 hover:text-slate-800 px-2 py-1.5"
          >
            {t(`${i18nPrefix}.skip`, 'Skip tour')}
          </button>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex(Math.max(0, index - 1))}
                className="text-xs font-bold px-3 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50"
              >
                {t(`${i18nPrefix}.back`, 'Back')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (isLast) onClose();
                else setIndex(Math.min(total - 1, index + 1));
              }}
              className="text-xs font-bold px-4 py-2 rounded-xl text-white bg-amber-600 hover:bg-amber-700"
            >
              {isLast
                ? t(`${i18nPrefix}.done`, 'Got it')
                : t(`${i18nPrefix}.next`, 'Next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const STORAGE_PREFIX = 'suntek.tour.';

export function tourWasSeen(id: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + id) === '1';
  } catch {
    return true;
  }
}

export function markTourSeen(id: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + id, '1');
  } catch {
    /* ignore */
  }
}
