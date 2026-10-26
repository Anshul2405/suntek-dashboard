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
            <div className="font-heading text-[1.25rem] font-semibold tracking-tight mt-5">
              Suntek
            </div>
            <p className="text-[12px] mt-1 tracking-[0.12em] uppercase">{label}</p>
            <div className="brand-loader-rail" aria-hidden><span /></div>
          </>
        )}
      </div>
    </div>
  );
}
