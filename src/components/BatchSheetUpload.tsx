/**
 * BatchSheetUpload
 *
 * Upload + extract a batch sheet photo. The OCR job runs in the OcrJobsProvider
 * (above the router) under the given `channel`, so it survives navigating away
 * mid-extraction. The parent reads the same channel's job to show the review.
 */
import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { extractBatchSheet, type ExtractedBatchSheet } from '../lib/nvidiaOcr';
import { useOcrJobs } from '../contexts/OcrJobsContext';

interface BatchSheetUploadProps {
  /** OCR channel key (must match the parent reading the result). */
  channel?: string;
  /** Whether the parent is showing the review panel (compact state). */
  reviewing?: boolean;
  /** Reset callback so the user can re-upload while reviewing. */
  onReset?: () => void;
  /** Display label for the document type. */
  docLabel?: string;
  /** Accent color for the upload button. */
  accentColor?: string;
}

export function BatchSheetUpload({ channel = 'batch', reviewing, onReset, docLabel, accentColor = '#7c3aed' }: BatchSheetUploadProps) {
  const { t } = useTranslation();
  const label = docLabel ?? t('ocr.batchSheet', 'Batch Sheet');
  const ocr = useOcrJobs();
  const job = ocr.getJob<ExtractedBatchSheet>(channel);
  const previewUrl = job.previewUrl;
  const error = job.error;
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => { ocr.reset(channel); onReset?.(); }, [ocr, channel, onReset]);
  // 1200px keeps Edge OCR under memory limits (90B path OOMs on large sheets).
  const handleFile = useCallback((file: File) => { ocr.select(channel, file, 1200); }, [ocr, channel]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };
  const handleExtract = () => { ocr.extract(channel, extractBatchSheet); };

  // ── Parent is showing the review → compact "reviewing" state ──────────────
  if (reviewing) {
    return (
      <div className="flex flex-col gap-3">
        {previewUrl && (
          <img src={previewUrl} alt="Uploaded batch sheet" className="w-full rounded-xl object-cover border border-slate-200 shadow-sm max-h-48" style={{ objectPosition: 'top' }} />
        )}
        <div className="bg-violet-50 border border-violet-200 rounded-xl px-3 py-2.5 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="text-xs font-bold text-violet-700">{t('ocr.extractionComplete', 'Extraction complete — review on the right')}</span>
        </div>
        <button onClick={reset} className="w-full py-2 rounded-xl border-2 border-slate-200 text-xs font-bold text-slate-500 hover:bg-slate-50 transition">
          ↩ {t('ocr.uploadDifferentSheet', 'Upload different sheet')}
        </button>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (job.status === 'error') {
    return (
      <div className="flex flex-col gap-3">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <div className="text-xs font-bold text-red-700 mb-1">{t('ocr.extractionFailed', 'Extraction failed')}</div>
          <div className="text-xs text-red-600 leading-relaxed break-words whitespace-pre-wrap max-h-40 overflow-y-auto">{error}</div>
        </div>
        <button onClick={reset} className="w-full py-2.5 rounded-xl border-2 border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-50 transition">
          ↩ {t('common.tryAgain', 'Try again')}
        </button>
      </div>
    );
  }

  // ── Loading state (keeps running across navigation) ───────────────────────
  if (job.status === 'processing') {
    return (
      <div className="flex flex-col items-center gap-4 py-6">
        {previewUrl && (
          <img src={previewUrl} alt="Batch sheet" className="w-full rounded-xl object-cover shadow border border-slate-200 max-h-40" style={{ objectPosition: 'top' }} />
        )}
        <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#e2e8f0" strokeWidth="3" />
          <path d="M12 2 A10 10 0 0 1 22 12" stroke="#7c3aed" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="text-sm font-bold font-heading text-slate-700 text-center">{t('ocr.analyzingBatch', 'Analyzing batch sheet…')}</div>
        <div className="text-xs text-slate-400 text-center">{t('ocr.readingTableHint', 'Reading the table · safe to switch tabs')}</div>
      </div>
    );
  }

  // ── Idle / Ready state ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/heic,image/webp,.jpg,.jpeg,.png,.heic,.webp"
        onChange={handleInputChange}
        className="hidden"
      />

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className="cursor-pointer rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center gap-2 py-5 px-4 text-center"
        style={{ borderColor: isDragging ? '#7c3aed' : '#cbd5e1', background: isDragging ? '#f5f3ff' : '#f8fafc' }}
      >
        {previewUrl ? (
          <>
            <img src={previewUrl} alt="Batch sheet preview" className="w-full rounded-xl object-cover shadow max-h-44" style={{ objectPosition: 'top' }} />
            <div className="text-xs text-slate-400">{t('ocr.tapToChange', 'Tap to change')}</div>
          </>
        ) : (
          <>
            <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: `${accentColor}18` }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
            <div className="text-sm font-bold font-heading text-slate-700">
              {isDragging ? t('ocr.dropSheetHere', 'Drop sheet here') : t('ocr.uploadDoc', { defaultValue: 'Upload {{label}}', label })}
            </div>
            <div className="text-xs text-slate-400">{t('ocr.tapToSelect', 'Tap to select · JPG PNG HEIC')}</div>
          </>
        )}
      </div>

      {!previewUrl && (
        <div className="text-xs text-slate-400 leading-relaxed bg-slate-50 rounded-xl p-3 border border-slate-100">
          <span className="font-bold text-slate-500">{t('ocr.howItWorks', 'How it works:')} </span>
          {t('ocr.howItWorksBody', 'Photo the filled sheet → AI reads all rows → review on the right → save to DB.')}
        </div>
      )}

      {job.status === 'ready' && (
        <button
          onClick={handleExtract}
          className="w-full py-3.5 rounded-xl text-white font-bold text-sm transition-all flex items-center justify-center gap-2"
          style={{ background: accentColor, boxShadow: `0 6px 16px -4px ${accentColor}72` }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          {t('ocr.extractWithAi', 'Extract with AI')}
        </button>
      )}
    </div>
  );
}
