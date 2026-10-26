import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MentionTextarea } from '../../components/mentions';
import { useMentionNotifier } from '../../lib/mentions';
import { useBlacklistGuard } from '../../lib/blacklist/guard';
import { insertRows, updateRows } from '../../lib/db';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../components/ui/toast';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { useRoleContext } from '../../contexts/RoleContext';

type Tab = 'stock' | 'req';

interface Tank {
  id: string;
  label: string;
  color: string;
  defaultPct: number;
}

interface DrumRow {
  id: string;
  density: number;
  location: string;
  opening: number;
}

const TANK_COLORS = ['#3B82F6', '#F59E0B', '#10B981', '#8B5CF6', '#0EA5E9', '#EF4444'];

async function resolvePlantId(preferred?: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const { data } = await supabase.from('plants').select('id').order('name').limit(1).returns<{ id: string }[]>();
  return data?.[0]?.id ?? null;
}

const URGENCY_OPTIONS = [
  { value: 'low',    label: 'Low (Routine)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High (Plant Stopper)' },
];

/* ─── Tank slider widget ─── */
function TankWidget({ tank, pct, onChange }: { tank: Tank; pct: number; onChange: (pct: number) => void }) {
  const { t } = useTranslation();
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
        onChange={e => onChange(Number(e.target.value))}
        className="w-full"
      />
      <div className="text-xs text-slate-400 mt-1">{t('warehouse.pctFilled', { pct })}</div>
    </div>
  );
}

/* ─── Drum row with editable physical count ─── */
function DrumRowInput({ row, count, onChange }: { row: DrumRow; count: number; onChange: (count: number) => void }) {
  const { t } = useTranslation();
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
          onChange={e => onChange(Number(e.target.value))}
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
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const { allowedPlants } = usePlantScope();
  const fileRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [item, setItem]           = useState('');
  const [qty, setQty]             = useState('');
  const [urgency, setUrgency]     = useState('low');
  const [remarks, setRemarks]     = useState('');
  const notifyMentions = useMentionNotifier();
  const screenBlacklist = useBlacklistGuard();
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const submittingRef = useRef(false);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      const plantId = await resolvePlantId(allowedPlants[0]?.id);
      const urgencyValue = urgency === 'high' ? 'plant_stopper' : urgency === 'medium' ? 'medium' : 'low';
      let photoUrl: string | null = null;
      if (photoFile) {
        try {
          const { shrinkPhoto, uploadWorkflowImage } = await import('../../lib/cloudinary');
          const blob = await shrinkPhoto(photoFile);
          const up = await uploadWorkflowImage(blob, { workflow: 'store-req', kind: 'proof', creator: activeProfile.name, plant: allowedPlants[0]?.name });
          photoUrl = up.secure_url;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t('warehouse.photoFailed', 'The photo could not be uploaded.'));
          return;
        }
      }
      const { error } = await insertRows('store_requisitions', {
        item: item.trim(),
        plant_id: plantId,
        qty: parseFloat(qty) || 0,
        urgency: urgencyValue,
        status: 'pending_store',
        remarks: remarks.trim() || null,
        photo_url: photoUrl,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      await notifyMentions(remarks, { entityLabel: `Warehouse requisition · ${item || 'item'}`, route: '/dashboard/purchase/storereq?queue=pending' });
      await screenBlacklist(
        [{ value: item, label: 'Item' }, { value: remarks, label: 'Remarks' }],
        { workflow: 'Warehouse Requisition', source: 'entry', entityLabel: `Warehouse requisition · ${item || 'item'}` },
      );
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
        <h3 className="text-xl font-extrabold mb-1">{t('warehouse.requisitionRaised')} ✓</h3>
        <p className="text-sm text-slate-500 mb-6">{t('warehouse.sentToApprovalQueue', 'It is on the store requisition list for approval.')}</p>
        <button
          onClick={() => { setItem(''); setQty(''); setRemarks(''); setPhotoFile(null); setSubmitted(false); }}
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
            className="hidden" onChange={e => { setPhotoFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
          />
          <input
            ref={galleryRef} type="file" accept="image/*"
            className="hidden" onChange={e => { setPhotoFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
          />
          {photoFile && (
            <div className="flex items-center gap-2 text-emerald-600 font-semibold text-sm mb-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 6 9 17l-5-5"/>
              </svg>
              {photoFile.name}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} className="flex-1 rounded-xl border border-slate-200 bg-white py-3 text-xs font-bold text-slate-700">{t('warehouse.takePhotoBtn')}</button>
            <button type="button" onClick={() => galleryRef.current?.click()} className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-3 text-xs font-bold text-slate-700">{t('warehouse.chooseFromGallery')}</button>
          </div>
        </div>
        <button
          type="submit"
          className="w-full text-white font-bold py-4 rounded-xl mt-2 shadow-lg hover:opacity-90 transition-opacity text-sm"
          style={{ background: '#2563EB', boxShadow: '0 8px 20px -4px rgba(37,99,235,0.35)' }}
        >
          {t('warehouse.submitToApprovalQueue', 'Submit to the store requisition list')}
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
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const { allowedPlants } = usePlantScope();
  const [tankList, setTankList] = useState<Tank[]>([]);
  const [drumList, setDrumList] = useState<DrumRow[]>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [drums, setDrums] = useState<Record<string, number>>({});
  const [stockReady, setStockReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [tanksRes, drumsRes] = await Promise.all([
        supabase.from('tanks').select('id, name, location, level_pct').order('sort_order').returns<{ id: string; name: string; location: string | null; level_pct: number }[]>(),
        supabase.from('cpm_drum_stock').select('id, location, density, drums').order('location').returns<{ id: string; location: string; density: number; drums: number }[]>(),
      ]);
      if (cancelled) return;
      const loadedTanks = (tanksRes.data || []).map((tk, i) => ({
        id: tk.id,
        label: tk.location ? `${tk.name} · ${tk.location}` : tk.name,
        color: TANK_COLORS[i % TANK_COLORS.length],
        defaultPct: Math.round(Number(tk.level_pct) || 0),
      }));
      const loadedDrums = (drumsRes.data || []).map(row => ({
        id: row.id,
        density: Number(row.density),
        location: row.location,
        opening: Number(row.drums) || 0,
      }));
      setTankList(loadedTanks);
      setDrumList(loadedDrums);
      setLevels(Object.fromEntries(loadedTanks.map(tk => [tk.id, tk.defaultPct])));
      setDrums(Object.fromEntries(loadedDrums.map(row => [row.id, row.opening])));
      setStockReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  async function submitStock() {
    if (saving) return;
    setSaving(true);
    try {
      const plantId = await resolvePlantId(allowedPlants[0]?.id);
      if (!plantId) {
        toast.error(t('warehouse.noPlant', 'No plant is available for this entry.'));
        return;
      }
      if (tankList.length === 0 && drumList.length === 0) {
        toast.error(t('warehouse.noStockRows', 'No tanks or drum rows are on the register yet.'));
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (tankList.length) {
        const tanks = await insertRows('daily_stock_entries', tankList.map(tk => ({
          plant_id: plantId,
          date: today,
          tank_name: tk.label,
          level_pct: levels[tk.id] ?? tk.defaultPct,
          submitted_by: activeProfile.name,
        })));
        if (tanks.error) {
          toast.error(tanks.error.message);
          return;
        }
        for (const tk of tankList) {
          const pct = levels[tk.id] ?? tk.defaultPct;
          await updateRows('tanks', { level_pct: pct, alert: pct < 30 }).eq('id', tk.id);
        }
      }
      const drumRows = drumList.length
        ? await insertRows('drum_inventory', drumList.map(row => ({
            plant_id: plantId,
            density: row.density,
            opening: row.opening,
            physical_count: drums[row.id] ?? row.opening,
            date: today,
            submitted_by: activeProfile.name,
          })))
        : { error: null };
      if (!drumRows.error) {
        for (const row of drumList) {
          await updateRows('cpm_drum_stock', { drums: drums[row.id] ?? row.opening }).eq('id', row.id);
        }
      }
      if (drumRows.error) {
        toast.error(drumRows.error.message);
        return;
      }
      setStockSubmitted(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {tab === 'stock' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold">{t('warehouse.physicalTankLevels')}</h2>
            <span className="text-sm text-slate-500">{t('warehouse.logVisuallyCheckedLevels')}</span>
          </div>
          {!stockReady ? (
            <p className="text-sm text-slate-500">{t('common.loading', 'Loading…')}</p>
          ) : tankList.length === 0 ? (
            <p className="text-sm text-slate-500">{t('warehouse.noTanks', 'No tanks are on the register yet. Add them on CPM Stock first.')}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
              {tankList.map(tk => (
                <TankWidget key={tk.id} tank={tk} pct={levels[tk.id] ?? tk.defaultPct} onChange={pct => setLevels(prev => ({ ...prev, [tk.id]: pct }))} />
              ))}
            </div>
          )}
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
                {drumList.map(r => (
                  <DrumRowInput key={r.id} row={r} count={drums[r.id] ?? r.opening} onChange={count => setDrums(prev => ({ ...prev, [r.id]: count }))} />
                ))}
                {stockReady && drumList.length === 0 && (
                  <tr><td colSpan={5} className="p-4 text-sm text-slate-500">{t('warehouse.noDrums', 'No drum rows are on the register yet.')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end mt-6">
            {stockSubmitted ? (
              <div className="flex items-center gap-2 text-emerald-600 font-bold">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6 9 17l-5-5"/>
                </svg>
                {t('warehouse.dailyRegisterSubmitted')} ✓
              </div>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => void submitStock()}
                className="bg-slate-800 text-white px-8 py-3 rounded-xl font-bold hover:bg-slate-700 shadow-lg transition-colors disabled:opacity-60"
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
  const { allowedPlants } = usePlantScope();
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
            <div className="text-lg font-bold">{allowedPlants[0]?.name || t('warehouse.consoleTitle')}</div>
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
