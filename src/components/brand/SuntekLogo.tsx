import React from 'react';

type SuntekLogoProps = {
  size?: number;
  className?: string;
  /** Show wordmark beside the mark */
  withWordmark?: boolean;
  /** Inverse for dark backgrounds */
  inverse?: boolean;
};

/**
 * Official Suntek mark from thesuntek.com (flame / S mark).
 * Asset: /brand/suntek-official.png
 */
export function SuntekLogo({
  size = 44,
  className = '',
  withWordmark = false,
  inverse = false,
}: SuntekLogoProps) {
  const titleColor = inverse ? '#FFFFFF' : '#161616';
  const subColor = inverse ? 'rgba(255,255,255,0.55)' : '#64748B';

  return (
    <div className={`inline-flex items-center gap-3 ${className}`}>
      <img
        src="/brand/suntek-official.png"
        alt="Suntek"
        width={size}
        height={size}
        className="shrink-0 object-contain"
        style={{
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.22),
          background: '#000',
        }}
        decoding="async"
      />
      {withWordmark && (
        <div className="text-left leading-tight min-w-0">
          <div
            className="font-heading font-semibold tracking-tight truncate"
            style={{ color: titleColor, fontSize: Math.max(15, size * 0.36) }}
          >
            Suntek
          </div>
          <div className="text-[11px] font-medium truncate" style={{ color: subColor }}>
            Operations
          </div>
        </div>
      )}
    </div>
  );
}
