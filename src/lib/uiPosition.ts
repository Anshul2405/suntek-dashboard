import type React from 'react';

/**
 * Positioning for a top-bar dropdown panel.
 *
 * Desktop: classic absolute panel anchored under its trigger, right-aligned.
 * Mobile (<768px): the trigger can sit anywhere in a wrapped icon row, so we pin
 * the panel to the VIEWPORT's right edge — just below the trigger, a capped
 * width (not full-screen) with a comfortable left gutter — so it always fits,
 * stays on the right, and never gets cut off.
 */
export function dropdownStyle(btn: HTMLElement | null, width: number, maxHeight: number): React.CSSProperties {
  const bottom = Math.round(btn?.getBoundingClientRect().bottom ?? 56);
  const right = Math.round(window.innerWidth - (btn?.getBoundingClientRect().right ?? window.innerWidth - 16));
  const capped = window.innerWidth < 768 ? Math.min(width, 340) : width;
  return {
    position: 'fixed',
    top: bottom + 8,
    right: Math.max(8, right),
    width: window.innerWidth < 768 ? `min(${capped}px, calc(100vw - 24px))` : width,
    maxHeight: `min(${maxHeight}px, calc(100dvh - ${bottom + 24}px))`,
    zIndex: 400,
  };
}
