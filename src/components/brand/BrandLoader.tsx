import React from 'react';
import { SuntekLogo } from '../brand/SuntekLogo';

type BrandLoaderProps = {
  /** Full viewport vs inline (route chunk) */
  fullScreen?: boolean;
  label?: string;
};

/**
 * Branded boot / route loader — official Suntek mark + orange ring.
 */
export function BrandLoader({
  fullScreen = true,
  label = 'Loading Suntek Operations…',
}: BrandLoaderProps) {
  return (
    <div
      className={`brand-loader ${fullScreen ? 'brand-loader--full' : 'brand-loader--inline'}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="brand-loader-card">
        <div className="brand-loader-mark">
          <SuntekLogo size={fullScreen ? 64 : 44} />
          <span className="brand-loader-ring" aria-hidden />
        </div>
        {fullScreen && (
          <>
            <div className="font-heading text-[1.15rem] font-semibold tracking-tight text-[var(--dark)] mt-5">
              Suntek
            </div>
            <p className="text-[12px] text-slate-500 mt-1 tracking-wide">{label}</p>
          </>
        )}
      </div>
    </div>
  );
}
