import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ExtractedSalesSheet, ExtractedPurchaseSheet } from '../../lib/nvidiaOcr';
import { ProgressBar, useFakeProgress } from '../../components/ui/ProgressBar';
import { isValidVehicleNo } from '../../lib/validate/vehicleNo';

// Pure presentational panels for the BatchLogger Sales/Purchase OCR upload flow.
// All saving happens in the parent via the onSaved/onClose callbacks.

/** Determinate-looking progress for the OCR call (no real streamed %). Mounted only
 *  while extracting, so `active` is simply true for its lifetime. */
function OcrLoadingBar({ color }: { color: string }) {
  const p = useFakeProgress(true, { ceiling: 92 });
  return <div className="w-full max-w-xs"><ProgressBar pct={p.pct} color={color} /></div>;
}

export function UploadDropzone({ onFile, accentColor, label }: { onFile: (f: File) => void; accentColor: string; label: string }) {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
        className="cursor-pointer rounded-2xl border-2 border-dashed flex flex-col items-center gap-2 py-8 px-4 text-center transition-all"
        style={{ borderColor: dragging ? accentColor : '#cbd5e1', background: dragging ? `${accentColor}10` : '#f8fafc' }}
      >
        <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: `${accentColor}18` }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div className="text-sm font-bold font-heading text-slate-700">
          {dragging ? t('ocr.dropHere', 'Drop here') : t('ocr.uploadDoc', { defaultValue: 'Upload {{label}}', label })}
        </div>
        <div className="text-xs text-slate-400">{t('ocr.tapToSelect', 'Tap to select · JPG PNG HEIC')}</div>
      </div>
    </div>
  );
}

export function SalesUploadPanel({ state, onFileSelect, onReset }: {
  state: { stage: 'idle' | 'loading' | 'done' | 'error'; imageUrl?: string; error?: string };
  onFileSelect: (f: File) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  if (state.stage === 'loading') {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        {state.imageUrl && <img src={state.imageUrl} alt="" className="w-full rounded-xl max-h-40 object-cover border border-slate-200" />}
        <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#e2e8f0" strokeWidth="3" />
          <path d="M12 2 A10 10 0 0 1 22 12" stroke="#16a34a" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="text-sm font-bold font-heading text-slate-700">{t('ocr.analyzingSales', 'Analyzing sales sheet…')}</div>
        <OcrLoadingBar color="#16a34a" />
      </div>
    );
  }
  if (state.stage === 'error') {
    return (
      <div className="flex flex-col gap-3">
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600 break-words">{state.error}</div>
        <button onClick={onReset} className="py-2.5 rounded-xl border-2 border-slate-200 text-sm font-bold text-slate-600">↩ {t('common.tryAgain', 'Try again')}</button>
      </div>
    );
  }
  if (state.stage === 'done') {
    return (
      <div className="flex flex-col gap-2">
        {state.imageUrl && <img src={state.imageUrl} alt="" className="w-full rounded-xl max-h-32 object-cover border border-green-200" />}
        <div className="bg-green-50 border border-green-200 rounded-xl px-3 py-2.5 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
          <span className="text-xs font-bold text-green-700">{t('ocr.salesExtracted', 'Sales data extracted — review on the right')}</span>
        </div>
        <button onClick={onReset} className="py-2 rounded-xl border-2 border-slate-200 text-xs font-bold text-slate-500">↩ {t('ocr.uploadDifferentSheet', 'Upload different sheet')}</button>
      </div>
    );
  }
  return <UploadDropzone onFile={onFileSelect} accentColor="#16a34a" label={t('ocr.salesSheet', 'Sales Sheet')} />;
}

export function PurchaseUploadPanel({ state, onFileSelect, onReset }: {
  state: { stage: 'idle' | 'loading' | 'done' | 'error'; imageUrl?: string; error?: string };
  onFileSelect: (f: File) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  if (state.stage === 'loading') {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        {state.imageUrl && <img src={state.imageUrl} alt="" className="w-full rounded-xl max-h-40 object-cover border border-slate-200" />}
        <svg className="animate-spin" width="28" height="28" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#e2e8f0" strokeWidth="3" />
          <path d="M12 2 A10 10 0 0 1 22 12" stroke="#dc2626" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="text-sm font-bold font-heading text-slate-700">{t('ocr.analyzingPurchase', 'Analyzing purchase sheet…')}</div>
        <OcrLoadingBar color="#dc2626" />
        <div className="text-xs text-red-500 font-bold">{t('ocr.lockedAfterExtraction', 'Data will be locked after extraction')}</div>
      </div>
    );
  }
  if (state.stage === 'error') {
    return (
      <div className="flex flex-col gap-3">
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600 break-words">{state.error}</div>
        <button onClick={onReset} className="py-2.5 rounded-xl border-2 border-slate-200 text-sm font-bold text-slate-600">↩ {t('common.tryAgain', 'Try again')}</button>
      </div>
    );
  }
  if (state.stage === 'done') {
    return (
      <div className="flex flex-col gap-2">
        {state.imageUrl && <img src={state.imageUrl} alt="" className="w-full rounded-xl max-h-32 object-cover border border-red-200" />}
        <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span className="text-xs font-bold text-red-700">{t('ocr.purchaseExtractedLocked', 'Purchase data extracted — locked & read-only')}</span>
        </div>
        <button onClick={onReset} className="py-2 rounded-xl border-2 border-slate-200 text-xs font-bold text-slate-500">↩ {t('ocr.uploadDifferentSheet', 'Upload different sheet')}</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
        <span className="font-bold">{t('ocr.antiTamperingRule', 'Purchase Anti-Tampering Rule:')} </span>
        {t('ocr.antiTamperingBody', 'Data extracted from a Purchase Sheet is strictly locked after upload. No editing is permitted.')}
      </div>
      <UploadDropzone onFile={onFileSelect} accentColor="#dc2626" label={t('ocr.purchaseSheet', 'Purchase Sheet')} />
    </div>
  );
}

export function SalesReviewPanel({ data, imageUrl, onSaved, onCancel }: { data: ExtractedSalesSheet; imageUrl: string; onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [items, setItems] = React.useState(data.lineItems ?? []);
  const [dcNumber, setDcNumber] = React.useState(data.dcNumber ?? '');
  const [customer, setCustomer] = React.useState(data.customerName ?? '');
  const [date, setDate] = React.useState(data.date ?? '');
  const [vehicle, setVehicle] = React.useState(data.vehicleNumber ?? '');
  // The OCR read must still be an Indian number before the sheet is saved.
  const vehicleBad = !!vehicle.trim() && !isValidVehicleNo(vehicle);
  const inp = 'w-full p-2 border border-slate-200 rounded-lg text-xs font-medium focus:border-green-400 focus:outline-none bg-white';
  const headerFields: [string, string, string, (v: string) => void][] = [
    ['dc', t('ocr.dcNumber', 'DC Number'), dcNumber, setDcNumber],
    ['date', t('ocr.date', 'Date'), date, setDate],
    ['customer', t('ocr.customer', 'Customer'), customer, setCustomer],
    ['vehicle', t('ocr.vehicleNo', 'Vehicle No.'), vehicle, setVehicle],
  ];
  const cols: [string, string][] = [
    ['description', t('ocr.thDescription', 'Description')],
    ['density', t('ocr.thDensity', 'Density')],
    ['quantity', t('ocr.thQty', 'Qty')],
    ['ratePerUnit', t('ocr.thRate', 'Rate')],
    ['amount', t('ocr.thAmount', 'Amount')],
  ];
  return (
    <div className="flex h-full bg-white rounded-2xl shadow-sm overflow-hidden flex-col">
      <div className="flex items-center justify-between px-5 py-3 border-b bg-green-50 shrink-0">
        <div>
          <div className="text-sm font-bold font-heading text-slate-800">{t('ocr.salesReviewTitle', 'Sales Sheet — Review & Confirm')}</div>
          <div className="text-xs text-slate-400">{t('ocr.lineItemsEditHint', { defaultValue: '{{n}} line items · edit before saving', n: items.length })}</div>
        </div>
        <button onClick={onCancel} className="text-xs font-bold text-slate-400 hover:text-slate-600 px-2 py-1 rounded-lg hover:bg-white">✕ {t('common.cancel', 'Cancel')}</button>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="w-48 shrink-0 p-3 border-r bg-slate-50 overflow-auto">
          <div className="text-xs font-bold text-slate-400 mb-2 uppercase">{t('ocr.original', 'Original')}</div>
          <img src={imageUrl} alt="" className="w-full rounded-xl border border-slate-200 object-contain" />
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {headerFields.map(([key, label, val, set]) => (
              <div key={key}>
                <div className="text-xs font-bold text-slate-400 uppercase mb-1">{label}</div>
                <input value={val} onChange={e => set(e.target.value)} className={inp} />
                {key === 'vehicle' && vehicleBad && <div className="text-[11px] text-red-600 mt-1">{t('common.vehicleInvalid', 'Use an Indian vehicle number, like UP13ET7451, DL1CAB1234 or 22BH1234AB.')}</div>}
              </div>
            ))}
          </div>
          <div>
            <div className="text-xs font-bold text-slate-400 uppercase mb-2">{t('ocr.lineItems', 'Line Items')}</div>
            <table className="w-full text-xs border-collapse border border-slate-200 rounded-xl overflow-hidden">
              <thead className="bg-slate-50">
                <tr>{cols.map(([k, h]) => <th key={k} className="px-2 py-1.5 text-left font-bold text-slate-500 border-b">{h}</th>)}</tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {(['description', 'density', 'quantity', 'ratePerUnit', 'amount'] as const).map(f => (
                      <td key={f} className="px-1 py-1">
                        <input value={it[f] != null ? String(it[f]) : ''} onChange={e => setItems(prev => prev.map((r, ri) => ri === i ? { ...r, [f]: e.target.value } : r))}
                          className="w-full px-2 py-1 border border-transparent rounded text-xs hover:border-slate-200 focus:border-green-300 focus:outline-none" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-3 shrink-0">
        <button onClick={onCancel} className="py-2 px-4 rounded-xl border-2 border-slate-200 text-sm font-bold text-slate-500">↩ {t('ocr.reupload', 'Re-upload')}</button>
        <div className="flex-1" />
        <button onClick={onSaved} disabled={vehicleBad} className="py-2 px-6 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#16a34a' }}>
          {t('ocr.saveSalesToDb', 'Save Sales Sheet to DB')}
        </button>
      </div>
    </div>
  );
}

export function PurchaseReviewPanel({ data, imageUrl, onClose }: { data: ExtractedPurchaseSheet; imageUrl: string; onClose: () => void }) {
  const { t } = useTranslation();
  const inp = 'w-full p-2 border border-slate-100 rounded-lg text-xs font-medium bg-slate-50 text-slate-500 cursor-not-allowed';
  const fields: [string, string, string][] = [
    ['invoiceNo', t('ocr.invoiceNo', 'Invoice No.'), data.invoiceNumber ?? ''],
    ['date', t('ocr.date', 'Date'), data.invoiceDate ?? ''],
    ['supplier', t('ocr.supplier', 'Supplier'), data.supplierName ?? ''],
    ['buyer', t('ocr.buyer', 'Buyer'), data.buyerName ?? ''],
    ['total', t('ocr.totalAmount', 'Total Amount'), data.totalAmount != null ? String(data.totalAmount) : ''],
    ['terms', t('ocr.paymentTerms', 'Payment Terms'), data.paymentTerms ?? ''],
  ];
  const cols: [string, string][] = [
    ['description', t('ocr.thDescription', 'Description')],
    ['quantity', t('ocr.thQty', 'Qty')],
    ['ratePerUnit', t('ocr.thRate', 'Rate')],
    ['amount', t('ocr.thAmount', 'Amount')],
    ['hsnCode', t('ocr.thHsn', 'HSN')],
  ];
  return (
    <div className="flex h-full bg-white rounded-2xl shadow-sm overflow-hidden flex-col">
      <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ background: 'linear-gradient(to right,#fef2f2,#fff7ed)' }}>
        <div>
          <div className="text-sm font-bold font-heading text-slate-800">{t('ocr.purchaseLockedTitle', 'Purchase Sheet — Locked (Read-Only)')}</div>
          <div className="text-xs text-red-600 font-bold">{t('ocr.purchaseImmutable', 'Purchase data is strictly immutable after upload')}</div>
        </div>
        <button onClick={onClose} className="text-xs font-bold text-slate-400 hover:text-slate-600 px-2 py-1 rounded-lg hover:bg-white">✕ {t('common.close', 'Close')}</button>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="w-48 shrink-0 p-3 border-r bg-slate-50 overflow-auto">
          <div className="text-xs font-bold text-slate-400 mb-2 uppercase">{t('ocr.original', 'Original')}</div>
          <img src={imageUrl} alt="" className="w-full rounded-xl border border-slate-200 object-contain" />
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span className="text-xs font-bold text-red-700">{t('ocr.allFieldsLocked', 'All fields are locked — no editing permitted (anti-tampering)')}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {fields.map(([key, label, val]) => (
              <div key={key}>
                <div className="text-xs font-bold text-slate-400 uppercase mb-1">{label}</div>
                <input readOnly value={val ?? ''} className={inp} />
              </div>
            ))}
          </div>
          <div>
            <div className="text-xs font-bold text-slate-400 uppercase mb-2">
              {t('ocr.lineItems', 'Line Items')} <span className="font-normal normal-case text-red-500">{t('ocr.lockedParen', '(locked)')}</span>
            </div>
            <table className="w-full text-xs border-collapse border border-slate-200 rounded-xl overflow-hidden">
              <thead className="bg-slate-50">
                <tr>{cols.map(([k, h]) => <th key={k} className="px-2 py-1.5 text-left font-bold text-slate-500 border-b">{h}</th>)}</tr>
              </thead>
              <tbody>
                {(data.lineItems ?? []).map((it, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {(['description', 'quantity', 'ratePerUnit', 'amount', 'hsnCode'] as const).map(f => (
                      <td key={f} className="px-2 py-1 text-slate-500 cursor-not-allowed">{it[f] != null ? String(it[f]) : '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2 text-xs text-red-600 font-bold">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          {t('ocr.savedImmutable', 'Saved as immutable record')}
        </div>
        <div className="flex-1" />
        <button onClick={onClose} className="py-2 px-6 rounded-xl text-sm font-bold text-white bg-slate-700">{t('common.done', 'Done')}</button>
      </div>
    </div>
  );
}
