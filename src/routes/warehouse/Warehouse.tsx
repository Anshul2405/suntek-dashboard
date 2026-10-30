import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlantScope } from '../../contexts/PlantScopeContext';
import { useRoleContext } from '../../contexts/RoleContext';
import { plantsForPicker } from '../../lib/access/pickerPlants';
import { updateRows } from '../../lib/db';
import { useToast } from '../../components/ui/toast';
import { formatDate, formatDateTime } from '../../lib/utils/formatting';
import { useUrlTable } from '../../lib/urlTable';
import { useUrlFilters } from '../../lib/urlFilters';
import { usePagination } from '../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination } from '../../components/v2';
import { postMovement, useBatchLedger, type LedgerRow } from '../../lib/batch/useBatchLedger';
import { onHandFor, signedQty, type MovementType } from '../../lib/batch/ledger';

type Tab = 'stock' | 'req';

/** Movements a person posts here. Production is posted from Batch Sheet (once per sheet). */
const MANUAL_TYPES: MovementType[] = ['opening', 'dispatch', 'transfer_out', 'return', 'adjustment'];

const inputCls = 'block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm w-full';
const labelCls = 'text-xs text-slate-600 min-w-0';

const BLANK = { type: 'dispatch' as MovementType, plantId: '', batchNo: '', qty: '', kg: '', sign: 1 as 1 | -1, location: '', dispatchRef: '', toPlantId: '', note: '' };

/**
 * Warehouse console on the batch-wise stock ledger (batch_stock_movements).
 * On hand = sum of a batch's movements. Spares requisitions stay on Store
 * Requisition — this screen does not keep a second requisition list.
 */
function LedgerPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const { allowedPlants, plants, ready, inScope } = usePlantScope();
  const ledger = useBatchLedger();
  const pickerPlants = plantsForPicker(allowedPlants, ready);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const plantName = (id: string | null) => plants.find(p => p.id === id)?.name ?? '—';

  // On hand for the user's own plants (incoming-transfer rows of other plants are not stock here).
  const stockUrl = useUrlTable();
  const stock = useMemo(() => [...ledger.onHand.values()]
    .filter(o => o.plant_id && inScope(o.plant_id))
    .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')), [ledger.onHand, inScope]);

  // Drums by density (latest density seen for the batch) — the visual matrix, from the ledger.
  const byDensity = useMemo(() => {
    const densityOf = new Map<string, number>();
    for (const r of ledger.rows) {
      const k = `${r.batch_no.trim().toUpperCase()}|${r.plant_id ?? ''}`;
      if (r.density != null && !densityOf.has(k)) densityOf.set(k, Number(r.density));
    }
    const out = new Map<string, number>();
    for (const o of stock) {
      const d = densityOf.get(`${o.batch_no}|${o.plant_id ?? ''}`);
      const key = d != null ? String(d) : t('warehouse.densityUnknown', 'Density not recorded');
      out.set(key, (out.get(key) ?? 0) + o.drums);
    }
    return [...out.entries()];
  }, [ledger.rows, stock, t]);

  // Keyed on nothing that a save changes: posting a movement (a batch going to
  // zero drops a row) used to throw the user back to page 1. Page in the URL.
  const page = usePagination(stock, { resetKey: 'stock', ...stockUrl.paging, ready: ledger.loaded });
  const recent = ledger.rows.slice(0, 30);
  const batchOptions = stock.filter(o => !form.plantId || o.plant_id === form.plantId).map(o => o.batch_no);

  const qtyNum = Number(form.qty);
  const canPost = ledger.live && !!form.plantId && !!form.batchNo.trim() && Number.isFinite(qtyNum) && qtyNum > 0
    && (form.type !== 'transfer_out' || (!!form.toPlantId && form.toPlantId !== form.plantId));

  async function post() {
    if (!canPost) return;
    setBusy(true);
    try {
      const batchNo = form.batchNo.trim().toUpperCase();
      const qty = signedQty(form.type, qtyNum, form.sign);
      const kg = form.kg.trim() ? Math.sign(qty) * Math.abs(Number(form.kg)) : null;
      const res = await postMovement({
        batch_no: batchNo,
        plant_id: form.plantId,
        movement_type: form.type,
        qty,
        qty_kg: kg != null && Number.isFinite(kg) ? kg : null,
        location: form.location.trim() || null,
        dispatch_ref: form.type === 'dispatch' ? form.dispatchRef.trim() || null : null,
        to_plant_id: form.type === 'transfer_out' ? form.toPlantId : null,
        transfer_group: form.type === 'transfer_out' ? crypto.randomUUID() : null,
        actor_name: activeProfile.name,
        note: form.note.trim() || null,
      });
      if (!res.ok) { toast.error(res.error || 'error'); return; }
      if (res.already) { toast.info(t('warehouse.alreadyPosted', 'That movement was already posted.')); return; }
      // A batch dispatched down to nothing is marked dispatched on its sheet.
      if (form.type === 'dispatch') {
        const before = onHandFor(ledger.onHand, batchNo, form.plantId)?.drums ?? 0;
        if (before + qty <= 0) {
          await updateRows('production_batch_sheets', { stage: 'dispatched' })
            .eq('batch_no', batchNo).eq('plant_id', form.plantId).eq('stage', 'in_stock');
        }
      }
      toast.success(t('warehouse.posted', 'Saved to the batch ledger.'));
      setForm({ ...BLANK, plantId: form.plantId, type: form.type });
      ledger.reload();
    } finally {
      setBusy(false);
    }
  }

  async function receive(row: LedgerRow) {
    if (!row.to_plant_id || !row.transfer_group) return;
    setBusy(true);
    try {
      const res = await postMovement({
        batch_no: row.batch_no, plant_id: row.to_plant_id, movement_type: 'transfer_in',
        qty: Math.abs(Number(row.qty)), qty_kg: row.qty_kg != null ? Math.abs(Number(row.qty_kg)) : null,
        density: row.density, from_plant_id: row.plant_id, transfer_group: row.transfer_group,
        actor_name: activeProfile.name, note: null,
      });
      if (!res.ok) { toast.error(res.error || 'error'); return; }
      toast.success(res.already ? t('warehouse.alreadyReceived', 'Already received.') : t('warehouse.received', 'Transfer received into stock.'));
      ledger.reload();
    } finally {
      setBusy(false);
    }
  }

  const typeLabel = (ty: MovementType) => ({
    opening: t('warehouse.mvOpening', 'Opening balance'),
    production: t('warehouse.mvProduction', 'Production'),
    dispatch: t('warehouse.mvDispatch', 'Dispatch'),
    transfer_in: t('warehouse.mvTransferIn', 'Transfer in'),
    transfer_out: t('warehouse.mvTransferOut', 'Transfer out'),
    return: t('warehouse.mvReturn', 'Return'),
    adjustment: t('warehouse.mvAdjustment', 'Adjustment'),
  })[ty];

  if (!ledger.live) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {t('warehouse.ledgerNotApplied', 'The batch stock ledger is not switched on yet (migration 0041). Nothing on this screen is saved until it is.')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <div className="text-base font-bold mb-1">{t('warehouse.onHandTitle', 'Batch stock on hand')}</div>
        <p className="text-xs text-slate-500 mb-3">{t('warehouse.onHandHint', 'Each figure is the sum of that batch’s movements (production, dispatch, transfers, returns, adjustments). A batch with no movements is not counted as stock.')}</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {byDensity.length === 0
            ? <span className="text-sm text-slate-400">{t('warehouse.noMovementsYet', 'No movements yet.')}</span>
            : byDensity.map(([d, drums]) => (
              <span key={d} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"><strong>{d}</strong> · {drums} {t('warehouse.drumsUnit')}</span>
            ))}
        </div>
        <div className="overflow-x-auto">
          <table className="dt2 text-sm">
            <thead><tr>
              <th>{t('warehouse.colBatch', 'Batch')}</th><th>{t('warehouse.colPlant', 'Plant')}</th>
              <th className="num">{t('warehouse.colDrums', 'Drums')}</th><th className="num">{t('warehouse.colKg', 'Kg')}</th>
              <th>{t('warehouse.colLast', 'Last movement')}</th>
            </tr></thead>
            <tbody>
              {!ledger.loaded && <tr><td colSpan={5} className="text-center text-slate-400 py-4">…</td></tr>}
              {ledger.loaded && stock.length === 0 && <tr><td colSpan={5} className="text-center text-slate-400 py-4">{t('warehouse.noMovementsYet', 'No movements yet.')}</td></tr>}
              {page.pageRows.map(o => (
                <tr key={`${o.batch_no}|${o.plant_id}`}>
                  <td className="font-mono font-bold">{o.batch_no}</td>
                  <td>{plantName(o.plant_id)}</td>
                  <td className={`num tabular-nums ${o.drums < 0 ? 'text-red-600' : ''}`}>{o.drums}</td>
                  <td className="num tabular-nums">{o.kg ?? '—'}</td>
                  <td className="text-xs text-slate-500">{o.lastAt ? formatDate(o.lastAt) : '—'} · {o.movements}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {stock.length > 0 && <TablePagination controls={page.controls} />}
        <p className="text-[11px] text-slate-400 mt-2">{t('warehouse.tanksNote', 'Tank levels are not in the ledger yet, so no tank figures are shown here. Busy dispatch / sales batch numbers are not linked yet.')}</p>
      </div>

      {ledger.incoming.length > 0 && (
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <div className="text-base font-bold mb-2">{t('warehouse.incomingTitle', 'Transfers coming to your plant')}</div>
          {ledger.incoming.map(r => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 border-t border-slate-100 text-sm">
              <span><strong className="font-mono">{r.batch_no}</strong> · {Math.abs(Number(r.qty))} {t('warehouse.drumsUnit')} · {plantName(r.plant_id)} → {plantName(r.to_plant_id)} · {formatDate(r.at)}</span>
              {r.to_plant_id && inScope(r.to_plant_id) && (
                <button type="button" disabled={busy} className="text-xs font-bold text-emerald-700" onClick={() => void receive(r)}>{t('warehouse.receive', 'Receive')}</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <div className="text-base font-bold mb-3">{t('warehouse.postTitle', 'Post a movement')}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className={labelCls}>{t('warehouse.mvType', 'Movement')}
            <select className={inputCls} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as MovementType }))}>
              {MANUAL_TYPES.map(ty => <option key={ty} value={ty}>{typeLabel(ty)}</option>)}
            </select>
          </label>
          <label className={labelCls}>{t('warehouse.plant', 'Plant')}
            <select className={inputCls} value={form.plantId} onChange={e => setForm(f => ({ ...f, plantId: e.target.value }))}>
              <option value="">{t('warehouse.pickPlant', 'Pick a plant…')}</option>
              {pickerPlants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className={labelCls}>{t('warehouse.batchNo', 'Batch no')}
            <input className={inputCls} list="ledger-batches" value={form.batchNo} placeholder="P26-12" onChange={e => setForm(f => ({ ...f, batchNo: e.target.value }))} />
            <datalist id="ledger-batches">{batchOptions.map(b => <option key={b} value={b} />)}</datalist>
          </label>
          <label className={labelCls}>{t('warehouse.qtyDrums', 'Drums')}
            <input className={inputCls} inputMode="decimal" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} />
          </label>
          {form.type === 'adjustment' && (
            <label className={labelCls}>{t('warehouse.direction', 'Direction')}
              <select className={inputCls} value={form.sign} onChange={e => setForm(f => ({ ...f, sign: Number(e.target.value) as 1 | -1 }))}>
                <option value={1}>{t('warehouse.add', 'Add (+)')}</option>
                <option value={-1}>{t('warehouse.remove', 'Remove (−)')}</option>
              </select>
            </label>
          )}
          {form.type === 'transfer_out' && (
            <label className={labelCls}>{t('warehouse.toPlant', 'To plant')}
              <select className={inputCls} value={form.toPlantId} onChange={e => setForm(f => ({ ...f, toPlantId: e.target.value }))}>
                <option value="">{t('warehouse.pickPlant', 'Pick a plant…')}</option>
                {plants.filter(p => p.id !== form.plantId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          {form.type === 'dispatch' && (
            <label className={labelCls}>{t('warehouse.dispatchRef', 'Dispatch / invoice ref')}
              <input className={inputCls} value={form.dispatchRef} onChange={e => setForm(f => ({ ...f, dispatchRef: e.target.value }))} />
            </label>
          )}
          <label className={labelCls}>{t('warehouse.qtyKg', 'Kg (optional)')}
            <input className={inputCls} inputMode="decimal" value={form.kg} onChange={e => setForm(f => ({ ...f, kg: e.target.value }))} />
          </label>
          <label className={labelCls}>{t('warehouse.location', 'Location (optional)')}
            <input className={inputCls} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
          </label>
          <label className={`${labelCls} sm:col-span-2`}>{t('warehouse.note', 'Note')}
            <input className={inputCls} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </label>
        </div>
        <p className="text-[11px] text-slate-400 mt-2">{t('warehouse.postHint', 'Production is posted from Batch Sheet (once per sheet). Mistakes are corrected with an adjustment — movements are never edited or deleted.')}</p>
        <button type="button" disabled={!canPost || busy} onClick={() => void post()}
          className="mt-3 bg-slate-800 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-slate-700 disabled:opacity-40">
          {t('warehouse.postBtn', 'Save movement')}
        </button>
      </div>

      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <div className="text-base font-bold mb-2">{t('warehouse.recentTitle', 'Latest movements')}</div>
        <div className="overflow-x-auto">
          <table className="dt2 text-sm">
            <thead><tr>
              <th>{t('warehouse.colWhen', 'When')}</th><th>{t('warehouse.colBatch', 'Batch')}</th><th>{t('warehouse.mvType', 'Movement')}</th>
              <th className="num">{t('warehouse.colDrums', 'Drums')}</th><th>{t('warehouse.colPlant', 'Plant')}</th><th>{t('warehouse.colBy', 'By')}</th>
            </tr></thead>
            <tbody>
              {recent.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-4">{ledger.loaded ? t('warehouse.noMovementsYet', 'No movements yet.') : '…'}</td></tr>}
              {recent.map(r => (
                <tr key={r.id}>
                  <td className="text-xs whitespace-nowrap">{formatDateTime(r.at)}</td>
                  <td className="font-mono">{r.batch_no}</td>
                  <td>{typeLabel(r.movement_type)}{r.dispatch_ref ? <div className="text-xs text-slate-400">{r.dispatch_ref}</div> : null}{r.note ? <div className="text-xs text-slate-400">{r.note}</div> : null}</td>
                  <td className={`num tabular-nums ${Number(r.qty) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{Number(r.qty) > 0 ? '+' : ''}{Number(r.qty)}</td>
                  <td>{plantName(r.plant_id)}{r.to_plant_id ? ` → ${plantName(r.to_plant_id)}` : ''}</td>
                  <td className="text-xs">{r.actor_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Spares are requested on Store Requisition — one list, not a second queue here. */
function RequisitionPointer() {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl bg-white rounded-2xl p-8 shadow-sm border border-slate-100">
      <h2 className="text-xl font-bold mb-2">{t('warehouse.raiseStoreRequisition')}</h2>
      <p className="text-sm text-slate-500 mb-4">{t('warehouse.reqOnStoreReq', 'Spares and consumables are requested on Store Requisition, where the unit head, Vijay ji and the purchaser act on them.')}</p>
      <a href="/dashboard/purchase/storereq" className="inline-block bg-slate-800 text-white px-6 py-2.5 rounded-xl font-bold no-underline">{t('warehouse.openStoreReq', 'Open Store Requisition')}</a>
    </div>
  );
}

interface WarehouseProps {
  /** When true, hides the standalone header — renders inside DashboardLayout instead */
  embedded?: boolean;
}

export function Warehouse({ embedded = false }: WarehouseProps) {
  const { t } = useTranslation();
  // Tab in the URL (?wtab=req) so Back / refresh return to the same tab.
  const tabParam = useUrlFilters(['wtab', 'p'] as const);
  const tab: Tab = tabParam.values.wtab === 'req' ? 'req' : 'stock';
  const setTab = (tb: Tab) => tabParam.set({ wtab: tb === 'req' ? 'req' : '', p: '' });
  const tabs = (
    <div className="flex gap-1 mb-5">
      {(['stock', 'req'] as Tab[]).map(tb => (
        <button
          key={tb}
          onClick={() => setTab(tb)}
          className="px-4 py-2 rounded-full text-sm font-semibold transition-colors"
          style={tab === tb ? { background: '#0F172A', color: '#fff' } : { background: '#F1F5F9', color: '#64748B' }}
        >
          {tb === 'stock' ? t('warehouse.batchStockTab', 'Batch stock') : t('warehouse.raiseRequisition')}
        </button>
      ))}
    </div>
  );
  const content = tab === 'stock' ? <LedgerPanel /> : <RequisitionPointer />;

  if (embedded) {
    return <div style={{ fontFamily: 'inherit' }}>{tabs}{content}</div>;
  }
  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F1F5F9', fontFamily: 'inherit' }}>
      <header className="bg-white px-8 p-4 border-b flex items-center gap-4 shadow-sm shrink-0">
        <div className="w-10 h-10 bg-slate-800 text-white rounded-xl flex items-center justify-center font-bold text-xl">S</div>
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t('warehouse.consoleTitle')}</div>
      </header>
      <main className="p-6 max-w-6xl w-full mx-auto">{tabs}{content}</main>
    </div>
  );
}
