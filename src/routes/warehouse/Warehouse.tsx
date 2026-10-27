import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MentionTextarea } from '../../components/mentions';

type Tab = 'stock' | 'req';

interface Tank {
  id: string;
  label: string;
  color: string;
  defaultPct: number;
}

interface DrumRow {
  density: number;
  location: string;
  opening: number;
}

const TANKS: Tank[] = [
  { id: 'npg',  label: 'NPG Raw',        color: '#3B82F6', defaultPct: 60 },
  { id: 'cp12', label: 'CP 1200 Storage', color: '#F59E0B', defaultPct: 25 },
  { id: 'hcl',  label: 'HCL Byproduct',  color: '#10B981', defaultPct: 85 },
];

const DRUM_ROWS: DrumRow[] = [
  { density: 1200, location: 'SCPL', opening: 23 },
  { density: 1300, location: 'SCPL', opening: 197 },
  { density: 1400, location: 'SCPL', opening: 118 },
];

const URGENCY_OPTIONS = [
  { value: 'low',    label: 'Low (Routine)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High (Plant Stopper)' },
];

/* ─── Tank slider widget ─── */
function TankWidget({ tank }: { tank: Tank }) {
  const { t } = useTranslation();
  const [pct, setPct] = useState(tank.defaultPct);
  const low = pct < 30;

  return (
    <div className="bg-white rounded-2xl p-5 text-center shadow-sm border border-slate-100">
      <div className="font-bold text-slate-500 mb-4 text-sm">{tank.label}</div>
      <div
        className="relative w-24 h-48 bg-slate-100 rounded-t-lg mx-auto overflow-hidden mb-4"
        style={{ border: `2px solid ${low ? '#FCA5A5' : '#CBD5E1'}`, borderBottom: 'none' }}
      >
        <div
          className="absolute bottom-0 left-0 right-0 transition-all duration-500"
          style={{ height: `${pct}%`, background: low ? '#EF4444' : tank.color, opacity: 0.82 }}
        />
        <div
          className="absolute inset-0 flex items-center justify-center font-bold text-lg z-10"
          style={{ color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}
        >
          {pct}%
        </div>
      </div>
      {low && <div className="text-xs font-bold text-red-500 mb-2">⚠ {t('warehouse.lowLevel')}</div>}
      <input
        type="range" min={0} max={100} value={pct}
        onChange={e => setPct(Number(e.target.value))}
        className="w-full"
      />
      <div className="text-xs text-slate-400 mt-1">{t('warehouse.pctFilled', { pct })}</div>
    </div>
  );
}

/* ─── Drum row with editable physical count ─── */
function DrumRowInput({ row }: { row: DrumRow }) {
  const { t } = useTranslation();
  const [count, setCount] = useState(row.opening);
  const variance = count - row.opening;
  const hasVariance = count !== row.opening;

  return (
    <tr className="border-b last:border-0">
      <td className="p-4 font-bold">{row.density}</td>
      <td className="p-4 text-slate-500">{row.location}</td>
      <td className="p-4 text-slate-400 font-mono">{row.opening}</td>
      <td className="p-4">
        <input
          type="number"
          value={count}
          onChange={e => setCount(Number(e.target.value))}
          className="w-24 p-2 border rounded-lg text-sm font-mono font-bold focus:outline-none focus:ring-2 transition"
          style={{ borderColor: hasVariance ? '#FCA5A5' : '#E2E8F0' }}
        />
      </td>
      <td className="p-4">
        {hasVariance && (
          <span
            className="text-xs font-bold px-2 py-0.5 rounded-full"
            style={{
              background: variance < 0 ? '#FEE2E2' : '#DCFCE7',
              color:      variance < 0 ? '#DC2626' : '#16A34A',
            }}
          >
            {variance > 0 ? '+' : ''}{variance} {t('warehouse.drumsUnit')}
          </span>
        )}
      </td>
    </tr>
  );
}

/* ─── Requisition form ─── */
function RequisitionForm() {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [item, setItem]           = useState('');
  const [qty, setQty]             = useState('');
  const [urgency, setUrgency]     = useState('low');
  const [remarks, setRemarks]     = useState('');
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const submittingRef = useRef(false);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return; // double-submit guard
    submittingRef.current = true;
    try {
      // Demo screen: nothing is saved and nobody is notified. Real requisitions
      // are raised on Store Requisition (store_requisitions), which this form
      // used to imitate with a timer and a "sent to Vijay Ji" message.
      setSubmitted(true);
    } finally {
      submittingRef.current = false;
    }
  }

  if (submitted) {
    return (
      <div className="max-w-2xl bg-white rounded-2xl p-10 shadow-sm border border-slate-100 text-center">
        <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </div>
        <h3 className="text-xl font-extrabold mb-1">{t('warehouse.demoNotSaved', 'Demo — not saved')}</h3>
        <p className="text-sm text-slate-500 mb-6">{t('warehouse.demoReqHint', 'Nothing was sent to Vijay ji. Raise a real requisition on Store Requisition.')}{' '}
          <a href="/dashboard/purchase/storereq" className="font-bold text-[var(--accent-deep)]">{t('warehouse.openStoreReq', 'Open Store Requisition')}</a>
        </p>
        <button
          onClick={() => { setItem(''); setQty(''); setRemarks(''); setPhotoName(null); setSubmitted(false); }}
          className="bg-slate-800 text-white px-8 py-3 rounded-xl font-bold hover:bg-slate-700"
        >
          {t('warehouse.raiseAnother')}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl bg-white rounded-2xl p-8 shadow-sm border border-slate-100">
      <h2 className="text-xl font-bold mb-6">{t('warehouse.raiseStoreRequisition')}</h2>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-bold text-slate-600 mb-1">{t('warehouse.itemRequired')} *</label>
          <input
            required value={item} onChange={e => setItem(e.target.value)}
            type="text" placeholder={t('warehouse.itemPlaceholder')}
            className="w-full p-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300 text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-bold text-slate-600 mb-1">{t('warehouse.quantity')} *</label>
            <input
              required value={qty} onChange={e => setQty(e.target.value)}
              type="text" placeholder={t('warehouse.quantityPlaceholder')}
              className="w-full p-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-600 mb-1">{t('warehouse.urgency')} *</label>
            <select
              value={urgency} onChange={e => setUrgency(e.target.value)}
              className="w-full p-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white text-sm"
            >
              {URGENCY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}
                  style={o.value === 'high' ? { color: '#DC2626', fontWeight: 700 } : {}}
                >
                  {t(`warehouse.urgency_${o.value}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-bold text-slate-600 mb-1">{t('warehouse.reasonRemarks')}</label>
          <MentionTextarea
            value={remarks} onChange={setRemarks} rows={3}
            placeholder={t('warehouse.remarksPlaceholder')}
            className="w-full p-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-bold text-slate-600 mb-1">
            {t('warehouse.photoProof')} <span className="font-normal text-slate-400">{t('warehouse.optional')}</span>
          </label>
          <input
            ref={fileRef} type="file" accept="image/*" capture="environment"
            className="hidden" onChange={e => setPhotoName(e.target.files?.[0]?.name ?? null)}
          />
          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-slate-400 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors"
            style={{ borderColor: photoName ? '#6EE7B7' : '#CBD5E1' }}
          >
            {photoName ? (
              <div className="flex items-center gap-2 text-emerald-600 font-semibold text-sm">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6 9 17l-5-5"/>
                </svg>
                {photoName}
              </div>
            ) : (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mb-2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                </svg>
                <span className="text-sm font-medium">{t('warehouse.uploadPhotoHint')}</span>
              </>
            )}
          </div>
        </div>
        <button
          type="submit"
          className="w-full text-white font-bold py-4 rounded-xl mt-2 shadow-lg hover:opacity-90 transition-opacity text-sm"
          style={{ background: '#2563EB', boxShadow: '0 8px 20px -4px rgba(37,99,235,0.35)' }}
        >
          {t('warehouse.submitToApprovalQueue', { name: 'Vijay Ji' })}
        </button>
      </form>
    </div>
  );
}

/* ─── Shared content (used by both embedded and standalone) ─── */
function WarehouseContent({
  tab,
  stockSubmitted,
  setStockSubmitted,
}: {
  tab: Tab;
  stockSubmitted: boolean;
  setStockSubmitted: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* Not wired to the database: say so instead of pretending to save. */}
      <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>{t('warehouse.demoNotSaved', 'Demo — not saved')}.</strong>{' '}
        {t('warehouse.demoBanner', 'This console shows sample tanks and drums and saves nothing. Use Stock Register and Store Requisition for real entries.')}
      </div>
      {tab === 'stock' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold">{t('warehouse.physicalTankLevels')}</h2>
            <span className="text-sm text-slate-500">{t('warehouse.logVisuallyCheckedLevels')}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
            {TANKS.map(tk => <TankWidget key={tk.id} tank={tk} />)}
          </div>
          <div className="flex items-center justify-between mt-8 mb-2">
            <h2 className="text-xl font-bold">{t('warehouse.drumStockCp')}</h2>
          </div>
          <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-100">
            <table className="w-full text-left">
              <thead className="bg-slate-50 border-b">
                <tr>
                  <th className="p-4 text-sm text-slate-500">{t('warehouse.colDensity')}</th>
                  <th className="p-4 text-sm text-slate-500">{t('warehouse.colLocation')}</th>
                  <th className="p-4 text-sm text-slate-500">{t('warehouse.colOpeningDrums')}</th>
                  <th className="p-4 text-sm text-slate-500">{t('warehouse.colPhysicalCount')}</th>
                  <th className="p-4 text-sm text-slate-500">{t('warehouse.colVariance')}</th>
                </tr>
              </thead>
              <tbody>
                {DRUM_ROWS.map(r => <DrumRowInput key={r.density} row={r} />)}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end mt-6">
            {stockSubmitted ? (
              <div className="flex items-center gap-2 text-emerald-600 font-bold">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6 9 17l-5-5"/>
                </svg>
                {t('warehouse.demoNotSaved', 'Demo — not saved')}
              </div>
            ) : (
              <button
                onClick={() => setStockSubmitted(true)}
                className="bg-slate-800 text-white px-8 py-3 rounded-xl font-bold hover:bg-slate-700 shadow-lg transition-colors"
              >
                {t('warehouse.submitDailyRegister')}
              </button>
            )}
          </div>
        </div>
      )}
      {tab === 'req' && <RequisitionForm />}
    </>
  );
}

interface WarehouseProps {
  /** When true, hides the standalone header — renders inside DashboardLayout instead */
  embedded?: boolean;
}

/* ─── Main export ─── */
export function Warehouse({ embedded = false }: WarehouseProps) {
  const { t } = useTranslation();
  const [tab, setTab]                   = useState<Tab>('stock');
  const [stockSubmitted, setStockSubmitted] = useState(false);

  // ── Embedded mode: no standalone header, fits inside DashboardLayout ────────
  if (embedded) {
    return (
      <div style={{ fontFamily: 'inherit' }}>
        {/* Pill tab switcher matching dashboard style */}
        <div className="flex gap-1 mb-5">
          {(['stock', 'req'] as Tab[]).map(tb => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className="px-4 py-2 rounded-full text-sm font-semibold transition-colors"
              style={tab === tb
                ? { background: '#0F172A', color: '#fff' }
                : { background: '#F1F5F9', color: '#64748B' }
              }
            >
              {tb === 'stock' ? t('warehouse.dailyStockEntry') : t('warehouse.raiseRequisition')}
            </button>
          ))}
        </div>
        <WarehouseContent tab={tab} stockSubmitted={stockSubmitted} setStockSubmitted={setStockSubmitted} />
      </div>
    );
  }

  // ── Standalone mode: full-screen with own header ────────────────────────────
  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F1F5F9', fontFamily: 'inherit' }}>
      <header className="bg-white px-8 p-4 border-b flex items-center justify-between shadow-sm shrink-0 flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-slate-800 text-white rounded-xl flex items-center justify-center font-bold text-xl">S</div>
          <div>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t('warehouse.consoleTitle')}</div>
            <div className="text-lg font-bold">SCPL Plant</div>
          </div>
        </div>
        <div className="flex gap-6 items-center flex-wrap">
          <button
            onClick={() => setTab('stock')}
            className="pb-1 text-sm font-medium transition-colors"
            style={{
              borderBottom: tab === 'stock' ? '2px solid #3B82F6' : '2px solid transparent',
              color: tab === 'stock' ? '#2563EB' : '#64748B',
              fontWeight: tab === 'stock' ? 700 : 500,
            }}
          >
            {t('warehouse.dailyStockEntry')}
          </button>
          <button
            onClick={() => setTab('req')}
            className="pb-1 text-sm font-medium transition-colors"
            style={{
              borderBottom: tab === 'req' ? '2px solid #3B82F6' : '2px solid transparent',
              color: tab === 'req' ? '#2563EB' : '#64748B',
              fontWeight: tab === 'req' ? 700 : 500,
            }}
          >
            {t('warehouse.raiseRequisition')}
          </button>
        </div>
      </header>
      <main className="flex-1 p-8 max-w-7xl mx-auto w-full">
        <WarehouseContent tab={tab} stockSubmitted={stockSubmitted} setStockSubmitted={setStockSubmitted} />
      </main>
    </div>
  );
}
