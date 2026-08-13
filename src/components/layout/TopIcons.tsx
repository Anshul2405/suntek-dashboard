import React from 'react';

/** Shared props for top-bar glyphs — heavier than default Lucide wireframes. */
type IconProps = { size?: number; className?: string };

export function IconSearch({ size = 17, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconGlobe({ size = 17, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
      <ellipse cx="12" cy="12" rx="4.2" ry="9" fill="currentColor" opacity="0.12" stroke="none" />
    </svg>
  );
}

export function IconAlert({ size = 17, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 4.3 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" fill="currentColor" fillOpacity="0.14" />
      <path d="M10.3 4.3 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v5" />
      <path d="M12 17.5h.01" />
    </svg>
  );
}

export function IconChecklist({ size = 17, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="14" height="18" rx="2.5" fill="currentColor" fillOpacity="0.12" />
      <rect x="4" y="3" width="14" height="18" rx="2.5" />
      <path d="m8 11 2 2 4.5-4.5" />
      <path d="M8 16h6" opacity="0.55" />
    </svg>
  );
}

export function IconBell({ size = 17, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path
        d="M6.2 9.2a5.8 5.8 0 0 1 11.6 0c0 6.3 2.6 8.3 2.6 8.3H3.6S6.2 15.5 6.2 9.2Z"
        fill="currentColor"
        fillOpacity="0.14"
      />
      <path d="M6.2 9.2a5.8 5.8 0 0 1 11.6 0c0 6.3 2.6 8.3 2.6 8.3H3.6S6.2 15.5 6.2 9.2Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function IconSwap({ size = 17, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 8h12" />
      <path d="m15 4 4 4-4 4" />
      <path d="M17 16H5" />
      <path d="m9 20-4-4 4-4" />
    </svg>
  );
}

export function IconMenu({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h12" />
    </svg>
  );
}

/** Shared className for top-bar icon buttons */
export const TB_ICON_BTN =
  'tb-icon-btn w-9 h-9 max-[390px]:w-8 max-[390px]:h-8 shrink-0 flex items-center justify-center relative cursor-pointer';

export const TB_ICON_BTN_ACTIVE = 'tb-icon-btn--on';
