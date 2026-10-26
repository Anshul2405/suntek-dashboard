import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Layers, Package, Fuel, Plus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchActivePlants } from '../../lib/plants';
import { insertRows } from '../../lib/db';
import { useToast } from '../../components/ui/toast';
import { SkeletonRows, ErrorState } from '../../components/ui/states';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../lib/access/pickerPlants';
import { displayLocationName, locationInPlants } from '../../lib/plantLabels';
import { withEmbedFallback } from '../../lib/scopedList';
import { useSortable } from '../../components/ui/useSortable';
import { ThV2 as Th, StatCard, SectionCard, FilterBar, ButtonV2 } from '../../components/v2';
import type { Database } from '../../lib/database.types';

type StockRow = Database['public']['Tables']['stock_levels']['Row'] & { plants?: { name: string | null } | null };
type TankRow = Database['public']['Tables']['tanks']['Row'];
type DrumRow = Database['public']['Tables']['cpm_drum_stock']['Row'];

interface BulkRow {
  item: string;
  adjustment: string;
  direction: 'in' | 'out';
  note: string;
}

export function CPMStock() {
  const { t } = useTranslation();
  const toast = useToast();
  const { scopeQuery, isGlobal, allowedPlants, ready: scopeReady } = usePlantScope();
  const [storeSearch, setStoreSearch] = useState('');
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([
    { item: '', adjustment: '', direction: 'in', note: '' },
  ]);
  const [bulkSaved, setBulkSaved] = useState(false);
  const [stockItems, setStockItems] = useState<StockRow[]>([]);
  const [allTanks, setTanks] = useState<TankRow[]>([]);
  const [allDrumRows, setDrumRows] = useState<DrumRow[]>([]);
  // Tanks / drum stock carry a location name, not a plant id: plant-scoped
  // users see only their own plants' locations.
  const tanks = isGlobal ? allTanks : allTanks.filter(tk => locationInPlants(tk.location, allowedPlants));
  const drumRows = isGlobal ? allDrumRows : allDrumRows.filter(r => locationInPlants(r.location, allowedPlants));
  const [dbPlants, setDbPlants] = useState<{ id: string; name: string }[]>([]);
  const [bulkPlant, setBulkPlant] = useState('');
  // Bulk adjustments only into a plant the user holds (fail closed, never all plants).
  const activeIds = new Set(dbPlants.map(p => p.id));
  const pickerPlants = plantsForPicker(allowedPlants, scopeReady).filter(p => !dbPlants.length || activeIds.has(p.id));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  async function load() {
    try {
      const [plantsRes, stockRes, tanksRes, drumsRes] = await Promise.all([
        fetchActivePlants<{ id: string; name: string }>('id, name'),
        withEmbedFallback(
          scopeQuery(supabase.from('stock_levels').select('*, plants(name)')).order('updated_at', { ascending: false }).returns<StockRow[]>(),
          () => scopeQuery(supabase.from('stock_levels').select('*')).order('updated_at', { ascending: false }).returns<StockRow[]>(),
          'CPMStock.stock',
        ),
        supabase.from('tanks').select('*').order('sort_order', { ascending: true }).returns<TankRow[]>(),
        supabase.from('cpm_drum_stock').select('*').returns<DrumRow[]>(),
      ]);
      if (stockRes.error) throw stockRes.error;
      if (plantsRes.data && plantsRes.data.length > 0) setDbPlants(plantsRes.data);
      setStockItems(stockRes.data || []);
      setTanks(tanksRes.data || []);
      setDrumRows(drumsRes.data || []);
      setLoadError(false);
    } catch (err) {
      console.error('[CPMStock] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [scopeQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredItems = stockItems.filter(i =>
    !storeSearch || (i.product || '').toLowerCase().includes(storeSearch.toLowerCase())
  );
  const storeSort = useSortable(filteredItems, {
    product: i => i.product,
    plant: i => i.plants?.name,
    density: i => i.density,
    quantity: i => i.quantity,
    date: i => (i.date ? new Date(i.date) : null),
  }, { key: 'date', dir: 'desc' });

  // Pivot the normalised drum rows back into the density×location matrix.
  const densities = [...new Set(drumRows.map(r => r.density))].sort((a, b) => a - b);
  const locations = [...new Set(drumRows.map(r => r.location))];
  const drumLookup = new Map(drumRows.map(r => [`${r.location}|${r.density}`, r.drums]));
  const matrix: Record<string, number[]> = Object.fromEntries(
    locations.map(loc => [loc, densities.map(d => drumLookup.get(`${loc}|${d}`) ?? 0)]),
  );

  // Average tank fill — replaces the hardcoded 68% KPI.
  const avgTankLevel = tanks.length
    ? Math.round(tanks.reduce((s, tk) => s + tk.level_pct, 0) / tanks.length)
    : 0;

  function addBulkRow() {
    setBulkRows(r => [...r, { item: '', adjustment: '', direction: 'in', note: '' }]);
  }

  function removeBulkRow(idx: number) {
    setBulkRows(r => r.filter((_, i) => i !== idx));
  }

  function updateBulkRow(idx: number, field: keyof BulkRow, value: string) {
    setBulkRows(r => r.map((row, i) => i === idx ? { ...row, [field]: value } : row));
  }

  async function handleBulkSave() {
    const filled = bulkRows.filter(r => r.item.trim() && r.adjustment);
    if (filled.length === 0) return;
    const today = new Date().toISOString().split('T')[0];
    const plantId = bulkPlant || pickerPlants[0]?.id;
    if (!plantId) { toast.error(t('cpmStock.noPlantSelected')); return; }
    const inserts = filled.map(r => ({
      product: r.item,
      quantity: parseFloat(r.adjustment) * (r.direction === 'out' ? -1 : 1),
      density: 0,
      plant_id: plantId,
      date: today,
    }));
    const { error } = await insertRows('stock_levels', inserts);
    if (error) { toast.error(t('cpmStock.saveFailed', { message: error.message })); return; }
    const { data } = await withEmbedFallback(
      scopeQuery(supabase.from('stock_levels').select('*, plants(name)')).order('updated_at', { ascending: false }).returns<StockRow[]>(),
      () => scopeQuery(supabase.from('stock_levels').select('*')).order('updated_at', { ascending: false }).returns<StockRow[]>(),
      'CPMStock.stock.reload',
    );
    setStockItems(data || []);
    setBulkSaved(true);
    setTimeout(() => {
      setShowBulkModal(false);
      setBulkSaved(false);
      setBulkRows([{ item: '', adjustment: '', direction: 'in', note: '' }]);
    }, 1400);
  }

  function handleCloseBulkModal() {
    setShowBulkModal(false);
    setBulkSaved(false);
    setBulkRows([{ item: '', adjustment: '', direction: 'in', note: '' }]);
  }

  return (
    <>
      {/* KPIs */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <StatCard className="col-span-6 lg:col-span-3" icon={<Boxes />} tone="orange"
          label={t('cpmStock.totalStockRecords')} value={loading ? '…' : stockItems.length}
          caption={t('cpmStock.acrossAllPlants')} />
        <StatCard className="col-span-6 lg:col-span-3" icon={<Layers />} tone="blue"
          label={t('cpmStock.totalQuantity')}
          value={loading ? '…' : stockItems.reduce((s, i) => s + (i.quantity || 0), 0).toFixed(0)}
          caption={t('cpmStock.unitsOnRecord')} />
        <StatCard className="col-span-6 lg:col-span-3" icon={<Package />} tone="purple"
          label={t('cpmStock.productsTracked')} value={loading ? '…' : new Set(stockItems.map(i => i.product)).size}
          caption={t('cpmStock.uniqueProducts')} />
        <StatCard className="col-span-6 lg:col-span-3" icon={<Fuel />} tone="amber"
          label={t('cpmStock.tankCapacity')} value={loading ? '…' : tanks.length ? `${avgTankLevel}%` : '—'}
          caption={<div className="progress mt-1"><div style={{ width: `${avgTankLevel}%` }}></div></div>} />
      </div>

      {loadError && (
        <div className="card2 p-4 mb-5">
          <ErrorState
            title={t('cpmStock.loadErrorTitle')}
            message={t('cpmStock.loadErrorMessage')}
            onRetry={() => { setLoading(true); setLoadError(false); load(); }}
          />
        </div>
      )}

      {/* Matrix + Tanks */}
      <div className="grid grid-cols-12 gap-4 mb-4">
        <SectionCard
          flush
          className="col-span-12 lg:col-span-7"
          title={t('cpmStock.cpDensityLocation')}
          subtitle={t('cpmStock.drumsOnHandHint')}
        >
          <div className="overflow-x-auto scroll-x">
            <table className="dt2">
              <thead>
                <tr>
                  <th>{t('cpmStock.location')}</th>
                  {densities.map(d => <th key={d} className="num">{t('cpmStock.densityCol', { d })}</th>)}
                  <th className="num">{t('cpmStock.total')}</th>
                </tr>
              </thead>
              <tbody>
                {locations.map(loc => {
                  const row = matrix[loc];
                  const total = row.reduce((a, b) => a + b, 0);
                  return (
                    <tr key={loc}>
                      <td className="font-semibold">{loc}</td>
                      {row.map((v, i) => {
                        const intensity = Math.min(v / 400, 1);
                        return (
                          <td key={i} className="num">
                            <span style={{ background: `rgba(244,118,81,${intensity * 0.28})`, padding: '3px 10px', borderRadius: '8px' }}>
                              {v}
                            </span>
                          </td>
                        );
                      })}
                      <td className="num font-bold">{total}</td>
                    </tr>
                  );
                })}
                {!loading && locations.length === 0 && (
                  <tr>
                    <td colSpan={densities.length + 2} className="text-center text-slate-400 py-6 text-sm">
                      {t('cpmStock.noDrumStock')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard
          className="col-span-12 lg:col-span-5"
          title={t('cpmStock.tankLevels')}
          subtitle={t('cpmStock.tankLevelsHint')}
        >
          <div className="space-y-3">
            {tanks.map(tk => {
              const color = tk.alert ? '#DC2626' : tk.level_pct > 70 ? '#16A34A' : tk.level_pct > 30 ? '#F47651' : '#D97706';
              return (
                <div key={tk.id} className="p-3 rounded-2xl border border-slate-100 hover:bg-slate-50">
                  <div className="flex items-center justify-between mb-1.5">
                    <div>
                      <div className="font-semibold text-sm">{tk.name}</div>
                      <div className="text-[11px] text-slate-500">{tk.location} · {t('cpmStock.cap')} {tk.capacity} {tk.unit}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold num text-sm">{Math.round((tk.capacity ?? 0) * tk.level_pct / 100)} {tk.unit}</div>
                      <div className="text-[11px] font-semibold" style={{ color }}>
                        {tk.level_pct}%{tk.alert ? ' · ' + t('cpmStock.low') : ''}
                      </div>
                    </div>
                  </div>
                  <div className="progress" style={{ height: '6px' }}>
                    <div style={{ width: `${tk.level_pct}%`, background: color }} />
                  </div>
                </div>
              );
            })}
            {!loading && tanks.length === 0 && (
              <div className="text-center text-slate-400 py-6 text-sm">{t('cpmStock.noTanksConfigured')}</div>
            )}
          </div>
        </SectionCard>
      </div>

      {/* Store items */}
      <FilterBar
        className="mb-4"
        search={storeSearch} onSearch={setStoreSearch}
        searchPlaceholder={t('cpmStock.searchItemPlaceholder')}
        onReset={() => setStoreSearch('')}
      />

      <SectionCard
        flush
        title={t('cpmStock.storeItems')}
        subtitle={t('cpmStock.storeItemsHint')}
        actions={
          <ButtonV2 variant="accent" icon={<Plus />} onClick={() => setShowBulkModal(true)}>
            {t('cpmStock.bulkUpdate')}
          </ButtonV2>
        }
      >
        {loading ? (
          <div className="p-5"><SkeletonRows rows={6} /></div>
        ) : (
        <div className="overflow-x-auto scroll-x">
          <table className="dt2">
            <thead>
              <tr>
                <Th sortKey="product" s={storeSort}>{t('cpmStock.product')}</Th><Th sortKey="plant" s={storeSort}>{t('cpmStock.plant')}</Th><Th sortKey="density" s={storeSort} firstDir="desc" className="num">{t('cpmStock.density')}</Th>
                <Th sortKey="quantity" s={storeSort} firstDir="desc" className="num">{t('cpmStock.qty')}</Th><Th sortKey="date" s={storeSort} firstDir="desc">{t('cpmStock.date')}</Th>
              </tr>
            </thead>
            <tbody>
              {storeSort.sorted.map(i => (
                <tr key={i.id} style={{ cursor: 'pointer' }}>
                  <td className="font-semibold">{i.product}</td>
                  <td>{i.plants?.name || '—'}</td>
                  <td className="num">{i.density || '—'}</td>
                  <td className="num font-bold">{i.quantity}</td>
                  <td className="text-slate-500 text-xs">{i.date}</td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr><td colSpan={5} className="text-center text-slate-400 py-6 text-sm">{t('cpmStock.noStockRecords')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </SectionCard>

      {/* ── Bulk Update Modal ── */}
      {showBulkModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(4px)' }}
          onClick={e => { if (e.target === e.currentTarget) handleCloseBulkModal(); }}
        >
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-xl p-7 relative">
            {/* Header */}
            <div className="flex items-start justify-between mb-5">
              <div>
                <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">{t('cpmStock.modalEyebrow')}</div>
                <div className="text-xl font-bold">{t('cpmStock.bulkStockUpdate')}</div>
                <div className="text-xs text-slate-500 mt-1">{t('cpmStock.bulkStockUpdateHint')}</div>
              </div>
              <button
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center shrink-0 ml-4 transition-colors"
                onClick={handleCloseBulkModal}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {pickerPlants.length > 0 && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('cpmStock.plant')}</label>
                <select
                  value={bulkPlant}
                  onChange={e => setBulkPlant(e.target.value)}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 transition w-full"
                >
                  {pickerPlants.map(p => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
                </select>
              </div>
            )}

            {bulkSaved ? (
              <div className="text-center py-8">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
                    <path d="M20 6 9 17l-5-5"/>
                  </svg>
                </div>
                <div className="font-semibold text-green-700">{t('cpmStock.stockUpdated')}</div>
                <div className="text-xs text-slate-500 mt-1">{t('cpmStock.stockUpdatedHint')}</div>
              </div>
            ) : (
              <>
                {/* Column headers */}
                <div className="grid grid-cols-[2fr_1fr_80px_2fr_24px] gap-2 mb-2 px-1">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{t('cpmStock.itemName')}</div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{t('cpmStock.qty')}</div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{t('cpmStock.inOut')}</div>
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{t('cpmStock.note')}</div>
                  <div />
                </div>

                {/* Rows */}
                <div className="space-y-2 mb-4 max-h-[280px] overflow-y-auto pr-1">
                  {bulkRows.map((row, idx) => (
                    <div key={idx} className="grid grid-cols-[2fr_1fr_80px_2fr_24px] gap-2 items-center">
                      <input
                        value={row.item}
                        onChange={e => updateBulkRow(idx, 'item', e.target.value)}
                        placeholder="NC Thinner…"
                        className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 transition"
                      />
                      <input
                        type="number"
                        value={row.adjustment}
                        onChange={e => updateBulkRow(idx, 'adjustment', e.target.value)}
                        placeholder="5"
                        className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 transition"
                      />
                      <div className="flex rounded-xl overflow-hidden border border-slate-200 text-xs font-semibold">
                        <button
                          onClick={() => updateBulkRow(idx, 'direction', 'in')}
                          className={`flex-1 py-2 transition-colors ${row.direction === 'in' ? 'bg-green-500 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}
                        >
                          {t('cpmStock.in')}
                        </button>
                        <button
                          onClick={() => updateBulkRow(idx, 'direction', 'out')}
                          className={`flex-1 py-2 transition-colors ${row.direction === 'out' ? 'bg-red-500 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'}`}
                        >
                          {t('cpmStock.out')}
                        </button>
                      </div>
                      <input
                        value={row.note}
                        onChange={e => updateBulkRow(idx, 'note', e.target.value)}
                        placeholder={t('cpmStock.reasonPlaceholder')}
                        className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-200 transition"
                      />
                      <button
                        onClick={() => bulkRows.length > 1 ? removeBulkRow(idx) : undefined}
                        className="w-6 h-6 rounded-full bg-slate-100 hover:bg-red-100 hover:text-red-500 flex items-center justify-center transition-colors"
                        style={{ opacity: bulkRows.length === 1 ? 0.3 : 1, cursor: bulkRows.length === 1 ? 'default' : 'pointer' }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M18 6 6 18M6 6l12 12"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add row */}
                <button
                  className="text-orange-600 text-xs font-semibold flex items-center gap-1.5 hover:gap-2 transition-all mb-5"
                  onClick={addBulkRow}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                  {t('cpmStock.addAnotherItem')}
                </button>

                {/* Actions */}
                <div className="flex gap-3">
                  <button className="btn-ghost rounded-[10px] flex-1 py-3 font-semibold text-sm" onClick={handleCloseBulkModal}>
                    {t('cpmStock.cancel')}
                  </button>
                  <button
                    className="btn-accent rounded-[10px] flex-1 py-3 font-semibold text-sm"
                    disabled={!bulkRows.some(r => r.item.trim() && r.adjustment)}
                    onClick={handleBulkSave}
                    style={{ opacity: !bulkRows.some(r => r.item.trim() && r.adjustment) ? 0.5 : 1 }}
                  >
                    {t('cpmStock.saveUpdates', { count: bulkRows.filter(r => r.item.trim() && r.adjustment).length })}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
