import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Check, X, Plus, FlaskConical, Droplets, TestTube2, Package, BarChart3 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { upsertRows } from '../../lib/db';
import { useRoleContext } from '../../contexts/RoleContext';
import { isAdminProfile } from '../../lib/profiles';
import { SectionCard, SegmentTabs, ButtonV2, StatusPill } from '../../components/v2';

type Variant = 'suntek' | 'manav';

interface OilRatioRow {
  id?: string;
  brand: Variant;
  density: number;
  np: string;
  wx: string;
  cl: string;
  hcl: string;
  vr: number;
  ok: boolean;
  sort_order: number;
}

function varianceColor(vr: number): string {
  if (Math.abs(vr) > 1.5) return 'var(--red)';
  if (Math.abs(vr) > 1)   return 'var(--amber)';
  return 'var(--green)';
}

export function OilRatioTable() {
  const { t } = useTranslation();
  const { activeProfile } = useRoleContext();
  const isAdmin = isAdminProfile(activeProfile);

  const [rows, setRows] = useState<OilRatioRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [variant, setVariant] = useState<Variant>('suntek');
  const [selectedDensity, setSelectedDensity] = useState<number | null>(null);

  // Admin edit state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OilRatioRow[]>([]);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from('oil_ratios')
      .select('*')
      .order('brand', { ascending: true })
      .order('sort_order', { ascending: true });
    setRows((data as OilRatioRow[]) || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const data = rows.filter(r => r.brand === variant);
  const selectedRow = data.find(r => r.density === selectedDensity) ?? null;

  // ── Admin editing helpers ──────────────────────────────────────────────────
  function startEdit() {
    setDraft(data.map(r => ({ ...r })));
    setSelectedDensity(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft([]);
  }

  function updateDraft(idx: number, patch: Partial<OilRatioRow>) {
    setDraft(d => d.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function addDraftRow() {
    const maxSort = draft.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
    setDraft(d => [
      ...d,
      { brand: variant, density: 0, np: '', wx: '', cl: '', hcl: '', vr: 0, ok: true, sort_order: maxSort + 1 },
    ]);
  }

  async function saveEdit() {
    setSaving(true);
    const payload = draft.map(r => ({
      ...(r.id ? { id: r.id } : {}),
      brand: r.brand,
      density: Number(r.density) || 0,
      np: r.np,
      wx: r.wx,
      cl: r.cl,
      hcl: r.hcl,
      vr: Number(r.vr) || 0,
      ok: !!r.ok,
      sort_order: Number(r.sort_order) || 0,
    }));
    const { error } = await upsertRows('oil_ratios', payload);
    setSaving(false);
    if (error) {
      // eslint-disable-next-line no-alert
      alert('Could not save oil ratios: ' + error.message);
      return;
    }
    setEditing(false);
    setDraft([]);
    await load();
  }

  const editInputCls = 'px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-slate-400 transition-colors';

  return (
    <div>
      <div className="grid grid-cols-12 gap-5">
        {/* Main table card */}
        <SectionCard
          flush
          className={selectedRow ? 'col-span-12 lg:col-span-8' : 'col-span-12'}
          title={
            <span className="inline-flex items-center gap-2">
              {t('oilRatio.title')}
              <StatusPill tone="orange" label={t('oilRatio.theBrain')} />
            </span>
          }
          subtitle={t('oilRatio.subtitle')}
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              {/* Variant tabs (view switch) + admin edit controls */}
              <SegmentTabs<Variant>
                items={[
                  { key: 'suntek', label: t('oilRatio.suntekBaseline') },
                  { key: 'manav',  label: t('oilRatio.manavKgFeb') },
                ]}
                value={variant}
                onChange={v => {
                  if (editing) return; // variant locked while editing (matches old disabled chips)
                  setVariant(v);
                  setSelectedDensity(null);
                }}
              />

              {isAdmin && !editing && (
                <ButtonV2 variant="outline" icon={<Pencil />} onClick={startEdit}>
                  Edit
                </ButtonV2>
              )}
              {isAdmin && editing && (
                <>
                  <ButtonV2 variant="primary" icon={<Check />} onClick={saveEdit} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </ButtonV2>
                  <ButtonV2 variant="outline" icon={<X />} onClick={cancelEdit} disabled={saving}>
                    Cancel
                  </ButtonV2>
                </>
              )}
            </div>
          }
        >
          {/* Table */}
          {loading ? (
            <div className="py-10 text-center text-sm text-slate-400">Loading…</div>
          ) : editing ? (
            /* ── Admin edit grid ── */
            <>
              <div className="overflow-x-auto scroll-x">
                <table className="dt2">
                  <thead>
                    <tr>
                      <th>{t('oilRatio.colDensity')}</th>
                      <th>{t('oilRatio.colNp')}</th>
                      <th>{t('oilRatio.colWaxol')}</th>
                      <th>{t('oilRatio.colCl2')}</th>
                      <th>{t('oilRatio.colHcl')}</th>
                      <th>{t('oilRatio.colLastVariance')}</th>
                      <th>{t('oilRatio.colStatus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.map((row, idx) => (
                      <tr key={row.id ?? `new-${idx}`}>
                        <td>
                          <input
                            type="number"
                            className={`w-20 ${editInputCls}`}
                            value={row.density}
                            onChange={e => updateDraft(idx, { density: Number(e.target.value) })}
                          />
                        </td>
                        <td>
                          <input
                            className={`w-20 ${editInputCls}`}
                            value={row.np}
                            onChange={e => updateDraft(idx, { np: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className={`w-20 ${editInputCls}`}
                            value={row.wx}
                            onChange={e => updateDraft(idx, { wx: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className={`w-16 ${editInputCls}`}
                            value={row.cl}
                            onChange={e => updateDraft(idx, { cl: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className={`w-16 ${editInputCls}`}
                            value={row.hcl}
                            onChange={e => updateDraft(idx, { hcl: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            step="0.1"
                            className={`w-16 ${editInputCls}`}
                            value={row.vr}
                            onChange={e => updateDraft(idx, { vr: Number(e.target.value) })}
                          />
                        </td>
                        <td>
                          <label className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={row.ok}
                              onChange={e => updateDraft(idx, { ok: e.target.checked })}
                            />
                            {t('oilRatio.inTolerance')}
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-slate-100">
                <ButtonV2 variant="outline" size="sm" icon={<Plus />} onClick={addDraftRow}>
                  Add density row
                </ButtonV2>
              </div>
            </>
          ) : data.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">
              No oil-ratio data recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto scroll-x">
              <table className="dt2">
                <thead>
                  <tr>
                    <th>{t('oilRatio.colDensity')}</th>
                    <th className="text-right">{t('oilRatio.colNp')}</th>
                    <th className="text-right">{t('oilRatio.colWaxol')}</th>
                    <th className="text-right">{t('oilRatio.colCl2')}</th>
                    <th className="text-right">{t('oilRatio.colHcl')}</th>
                    <th className="text-right">{t('oilRatio.colLastVariance')}</th>
                    <th>{t('oilRatio.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map(row => {
                    const isSelected = selectedDensity === row.density;
                    return (
                      <tr
                        key={row.id ?? row.density}
                        className="cursor-pointer transition-colors"
                        style={{ background: isSelected ? 'rgba(244,118,81,0.08)' : undefined }}
                        onClick={() => setSelectedDensity(isSelected ? null : row.density)}
                      >
                        <td>
                          <span className="density-pill">{row.density}</span>
                        </td>
                        <td className="text-right font-medium">{row.np}</td>
                        <td className="text-right text-slate-500">{row.wx}</td>
                        <td className="text-right font-medium">{row.cl}</td>
                        <td className="text-right font-medium">{row.hcl} kg</td>
                        <td className="text-right">
                          <span style={{ color: varianceColor(row.vr), fontWeight: 700 }}>
                            {row.vr >= 0 ? '+' : ''}{row.vr.toFixed(1)}%
                          </span>
                        </td>
                        <td>
                          {row.ok ? (
                            <StatusPill tone="green" label={t('oilRatio.inTolerance')} />
                          ) : (
                            <StatusPill tone="red" label={t('oilRatio.flag')} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="text-[11px] text-slate-400 px-5 py-3 border-t border-slate-100">
            {t('oilRatio.clickRowHint')}
          </div>
        </SectionCard>

        {/* Inline detail panel — appears when a row is selected */}
        {selectedRow && !editing && (
          <div className="col-span-12 lg:col-span-4 card2 p-5">
            <div className="flex items-start justify-between mb-5">
              <div>
                <div className="text-[10px] font-bold tracking-[0.18em] text-slate-400 uppercase mb-1">
                  {variant === 'suntek' ? t('oilRatio.suntekBaseline') : t('oilRatio.manavKgFeb')}
                </div>
                <div className="flex items-center gap-2">
                  <span className="density-pill text-lg px-3 py-1">{selectedRow.density}</span>
                  {selectedRow.ok ? (
                    <StatusPill tone="green" label={t('oilRatio.inTolerance')} />
                  ) : (
                    <StatusPill tone="red" label={t('oilRatio.flagged')} />
                  )}
                </div>
              </div>
              <button
                className="w-7 h-7 rounded-[10px] bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors shrink-0"
                onClick={() => setSelectedDensity(null)}
              >
                <X size={13} strokeWidth={2.5} className="text-slate-500" />
              </button>
            </div>

            {/* Coefficient cards */}
            <div className="space-y-3">
              {[
                { label: t('oilRatio.npPerKgCp'), value: selectedRow.np, icon: <FlaskConical size={16} />, desc: t('oilRatio.npDesc') },
                { label: t('oilRatio.waxolPerKgCp'), value: selectedRow.wx, icon: <Droplets size={16} />, desc: t('oilRatio.waxolDesc') },
                { label: t('oilRatio.cl2PerKgCp'), value: selectedRow.cl, icon: <TestTube2 size={16} />, desc: t('oilRatio.cl2Desc') },
                { label: t('oilRatio.hclProduced'), value: `${selectedRow.hcl} kg`, icon: <Package size={16} />, desc: t('oilRatio.hclDesc') },
              ].map(item => (
                <div key={item.label} className="flex items-center gap-3 p-3 bg-slate-50 rounded-[10px]">
                  <div className="w-9 h-9 rounded-[10px] bg-white border border-slate-200 text-slate-500 flex items-center justify-center shrink-0">
                    {item.icon}
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-slate-500">{item.label}</div>
                    <div className="font-bold text-base num">{item.value}</div>
                    <div className="text-[10px] text-slate-400">{item.desc}</div>
                  </div>
                </div>
              ))}

              {/* Variance highlight */}
              <div
                className="flex items-center gap-3 p-3 rounded-[10px]"
                style={{ background: `${varianceColor(selectedRow.vr)}18`, border: `1px solid ${varianceColor(selectedRow.vr)}33` }}
              >
                <div className="w-9 h-9 rounded-[10px] bg-white/70 flex items-center justify-center shrink-0" style={{ color: varianceColor(selectedRow.vr) }}>
                  <BarChart3 size={16} />
                </div>
                <div className="flex-1">
                  <div className="text-xs text-slate-500">{t('oilRatio.lastBatchVariance')}</div>
                  <div className="font-bold text-xl num" style={{ color: varianceColor(selectedRow.vr) }}>
                    {selectedRow.vr >= 0 ? '+' : ''}{selectedRow.vr.toFixed(1)}%
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {Math.abs(selectedRow.vr) > 1.5
                      ? t('oilRatio.outsideTolerance')
                      : Math.abs(selectedRow.vr) > 1
                        ? t('oilRatio.nearTolerance')
                        : t('oilRatio.withinNormal')}
                  </div>
                </div>
              </div>
            </div>

            {/* Compare note */}
            <div className="mt-4 p-3 bg-orange-50 rounded-[10px] text-xs text-orange-700">
              <span className="font-semibold">{t('oilRatio.compareVariant')}</span>{' '}
              <button
                className="underline hover:text-orange-900"
                onClick={() => setVariant(v => v === 'suntek' ? 'manav' : 'suntek')}
              >
                {t('oilRatio.switchTo', { variant: variant === 'suntek' ? t('oilRatio.manavKg') : t('oilRatio.suntekBaseline') })}
              </button>{' '}
              {t('oilRatio.toSeeDiffs', { d: selectedRow.density })}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
