import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { insertRows, updateRows } from '../../../lib/db';
import { useToast } from '../../../components/ui/toast';
import { useRoleContext } from '../../../contexts/RoleContext';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { isAdminProfile } from '../../../lib/profiles';
import { formatDate, istToday } from '../../../lib/utils/formatting';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination, ButtonV2 } from '../../../components/v2';
import { TableSearch, useTextFilter } from '../../../components/ui/TableSearch';
import { AddPurchaseModal } from './AddPurchaseModal';
import {
  HEAD_OFFICE, canReceive, groupInTransit, isInTransit, isStorePart, placesOrFilter, type DispatchRow,
} from '../../../lib/dispatch';

const input = 'block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm w-full';
const label = 'text-xs text-slate-600 min-w-0';

const BLANK = {
  kind: 'item' as 'item' | 'part',
  destination: '',
  date: '',
  item: '',
  document_ref: '',
  sender: '',
  from: '',
  vehicle_no: '',
  receiver: '',
  supplier: '',
  remarks: '',
};

/**
 * Live Dispatch — the plant-to-plant consignment log on dispatch_logs.
 * Sender fills the row (it is then in transit); the receiving place fills the
 * receive date. Store parts with no ticket ride along and go into the Stock
 * register through Add purchase on arrival.
 */
export function DispatchLog() {
  const { t } = useTranslation();
  const toast = useToast();
  const { activeProfile } = useRoleContext();
  const { plants, allowedPlants, ready, isGlobal } = usePlantScope();
  const admin = isAdminProfile(activeProfile);
  const role = activeProfile.baseRoleId || activeProfile.id;
  const atOffice = isGlobal || admin || role === 'management' || role === 'accountant_delhi';

  // Where this user stands: their plants (+ the head office for office staff).
  const myPlaces = useMemo(() => {
    const names = plantsForPicker(allowedPlants, ready).map(p => p.name);
    if (atOffice) names.push(HEAD_OFFICE);
    return names;
  }, [allowedPlants, ready, atOffice]);
  const myPlaceSet = useMemo(() => new Set(myPlaces), [myPlaces]);
  // A consignment can go to any place, so the destination is not the user's scope.
  const destinations = useMemo(
    () => [...plants.map(p => p.name).sort((a, b) => a.localeCompare(b)), HEAD_OFFICE],
    [plants],
  );

  const [rows, setRows] = useState<DispatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState<'all' | 'transit' | 'received'>('all');
  const [receiving, setReceiving] = useState<{ id: string; date: string; name: string } | null>(null);
  const [stockFor, setStockFor] = useState<DispatchRow | null>(null);

  // Not global and no plant: nothing to read (never fall back to every plant).
  const noPlaces = ready && !isGlobal && myPlaces.length === 0;
  useEffect(() => {
    if (!ready || noPlaces) return;
    let alive = true;
    let query = supabase.from('dispatch_logs').select('*');
    if (!isGlobal) query = query.or(placesOrFilter(myPlaces));
    void query
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(500)
      .returns<DispatchRow[]>()
      .then(({ data, error }) => {
        if (!alive) return;
        setLoadError(error ? error.message : null);
        setRows(data ?? []);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [ready, noPlaces, isGlobal, myPlaces]);
  const busyLoading = loading && !noPlaces;

  const openForm = () => {
    setForm({ ...BLANK, date: istToday(), sender: activeProfile.name, from: myPlaces[0] ?? '' });
    setSaveError(null);
    setShowForm(true);
  };

  const canSave = !!form.destination && !!form.date && !!form.item.trim() && !!form.sender.trim() && !!form.from
    && form.destination !== form.from && (form.kind === 'item' || !!form.supplier.trim());

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { data, error } = await insertRows('dispatch_logs', {
        destination: form.destination,
        date: form.date,
        item: form.item.trim(),
        document_ref: form.document_ref.trim() || null,
        vehicle_no: form.vehicle_no.trim().toUpperCase() || null,
        sender: form.sender.trim(),
        receiver: form.receiver.trim() || null,
        from_location: form.from,
        supplier: form.kind === 'part' ? form.supplier.trim() : null,
        receive_date: null,
        remarks: form.remarks.trim() || null,
      }).select('*').single();
      if (error) {
        setSaveError(error.message);
        return;
      }
      if (data) setRows(prev => [data as DispatchRow, ...prev]);
      setShowForm(false);
      toast.success(t('dispatch.savedInTransit', 'Saved. It shows as in transit until the receiving place fills the receive date.'));
    } finally {
      setSaving(false);
    }
  }

  async function markReceived(row: DispatchRow, date: string, name: string) {
    const patch = { receive_date: date, receiver: name.trim() || row.receiver };
    const { error } = await updateRows('dispatch_logs', patch).eq('id', row.id);
    if (error) { toast.error(error.message); return false; }
    setRows(prev => prev.map(r => (r.id === row.id ? { ...r, ...patch } : r)));
    setReceiving(null);
    toast.success(t('dispatch.receivedOk', 'Marked received.'));
    return true;
  }

  const groups = useMemo(() => groupInTransit(rows), [rows]);
  const prepared = useMemo(
    () => rows.filter(r => state === 'all' || (state === 'transit' ? isInTransit(r) : !isInTransit(r))),
    [rows, state],
  );
  const filtered = useTextFilter(prepared, q, r => [
    r.item, r.document_ref, r.vehicle_no, r.sender, r.receiver, r.from_location, r.destination, r.supplier, r.remarks,
    formatDate(r.date), r.receive_date ? formatDate(r.receive_date) : '',
  ]);
  const page = usePagination(filtered, { resetKey: `${q}|${state}` });
  const filtersOn = q.trim() !== '' || state !== 'all';
  const destPlantId = (row: DispatchRow) => plants.find(p => p.name === row.destination)?.id;

  const receiveAction = (row: DispatchRow) => {
    if (!canReceive(row, myPlaceSet, admin)) return null;
    if (isStorePart(row)) {
      return (
        <button type="button" className="text-xs font-bold text-emerald-700 whitespace-nowrap" onClick={() => setStockFor(row)}>
          {t('dispatch.receiveIntoStock', 'Receive into stock')}
        </button>
      );
    }
    if (receiving?.id === row.id) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" className="border border-slate-200 rounded-lg px-2 py-1 text-xs" value={receiving.date} max={istToday()}
            onChange={e => setReceiving({ ...receiving, date: e.target.value })} />
          <input className="border border-slate-200 rounded-lg px-2 py-1 text-xs w-28" value={receiving.name}
            placeholder={t('dispatch.receiverName', 'Receiver name')}
            onChange={e => setReceiving({ ...receiving, name: e.target.value })} />
          <button type="button" className="text-xs font-bold text-emerald-700" disabled={!receiving.date}
            onClick={() => void markReceived(row, receiving.date, receiving.name)}>{t('dispatch.saveReceived', 'Save')}</button>
          <button type="button" className="text-xs text-slate-500" onClick={() => setReceiving(null)}>{t('common.cancel', 'Cancel')}</button>
        </div>
      );
    }
    return (
      <button type="button" className="text-xs font-bold text-emerald-700 whitespace-nowrap"
        onClick={() => setReceiving({ id: row.id, date: istToday(), name: row.receiver || activeProfile.name })}>
        {t('dispatch.markReceived', 'Mark received')}
      </button>
    );
  };

  const kindBadge = (row: DispatchRow) => isStorePart(row)
    ? <span className="badge" style={{ background: '#DCFCE7', color: '#15803D' }}>{t('dispatch.kindPart', 'Store part')}</span>
    : <span className="badge" style={{ background: '#F1F5F9', color: '#475569' }}>{t('dispatch.kindItem', 'Dispatch')}</span>;

  return (
    <div className="card2 p-4 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="text-sm font-bold">{t('dispatch.title', 'Dispatch — live')}</div>
          <p className="text-xs text-slate-500 mt-0.5">{t('dispatch.hint', 'Anything sent from one place to another. The sender saves it and it is in transit; the receiving place fills the receive date. Parts for a maintenance ticket are followed on the ticket, not here.')}</p>
        </div>
        {myPlaces.length > 0 && !showForm && (
          <ButtonV2 variant="primary" onClick={openForm}>{t('dispatch.add', 'New dispatch')}</ButtonV2>
        )}
      </div>

      {showForm && (
        <div className="border border-slate-200 rounded-xl p-3 mb-4">
          <div className="flex flex-wrap gap-4 mb-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={form.kind === 'item'} onChange={() => setForm(f => ({ ...f, kind: 'item' }))} />
              {t('dispatch.kindItemLong', 'Document / item (file, computer, device, store stock…)')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={form.kind === 'part'} onChange={() => setForm(f => ({ ...f, kind: 'part' }))} />
              {t('dispatch.kindPartLong', 'Part bought for the store (no ticket)')}
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <label className={label}>{t('dispatch.from', 'From')}
              <select className={input} value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value }))}>
                {myPlaces.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className={label}>{t('dispatch.destination', 'Destination')}
              <select className={input} value={form.destination} onChange={e => setForm(f => ({ ...f, destination: e.target.value }))}>
                <option value="">{t('dispatch.pickDestination', 'Pick a place…')}</option>
                {destinations.filter(p => p !== form.from).map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className={label}>{t('dispatch.date', 'Date')}
              <input type="date" className={input} value={form.date} max={istToday()} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </label>
            <label className={`${label} sm:col-span-2`}>{form.kind === 'part' ? t('dispatch.partName', 'Part and quantity') : t('dispatch.item', 'Document / item description')}
              <input className={input} value={form.item} onChange={e => setForm(f => ({ ...f, item: e.target.value }))} />
            </label>
            {form.kind === 'part' ? (
              <label className={label}>{t('dispatch.supplier', 'Supplier')}
                <input className={input} value={form.supplier} onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} />
              </label>
            ) : (
              <label className={label}>{t('dispatch.documentRef', 'Document ref (optional)')}
                <input className={input} value={form.document_ref} onChange={e => setForm(f => ({ ...f, document_ref: e.target.value }))} />
              </label>
            )}
            <label className={label}>{t('dispatch.vehicle', 'Vehicle number')}
              <input className={input} value={form.vehicle_no} placeholder="UP13ET7451" onChange={e => setForm(f => ({ ...f, vehicle_no: e.target.value }))} />
            </label>
            <label className={label}>{t('dispatch.sender', 'Sender name')}
              <input className={input} value={form.sender} onChange={e => setForm(f => ({ ...f, sender: e.target.value }))} />
            </label>
            <label className={label}>{t('dispatch.receiverName', 'Receiver name')}
              <input className={input} value={form.receiver} onChange={e => setForm(f => ({ ...f, receiver: e.target.value }))} />
            </label>
            <label className={`${label} sm:col-span-2 lg:col-span-3`}>{t('dispatch.remarks', 'Remarks')}
              <input className={input} value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
            </label>
          </div>
          {form.kind === 'part' && (
            <p className="text-xs text-slate-500 mt-2">{t('dispatch.partHint', 'On arrival the receiving plant opens Receive into stock, which is the same Add purchase used in the Stock register.')}</p>
          )}
          {saveError && (
            <p className="text-xs text-red-600 mt-2">{t('dispatch.saveFailed', { defaultValue: 'Not saved: {{msg}}. If the table refuses every row it is waiting for SQL (migration 0038).', msg: saveError })}</p>
          )}
          <div className="flex gap-2 mt-3">
            <ButtonV2 variant="primary" disabled={!canSave || saving} onClick={() => void save()}>
              {saving ? t('common.saving', 'Saving…') : t('dispatch.saveInTransit', 'Save — in transit')}
            </ButtonV2>
            <ButtonV2 onClick={() => setShowForm(false)}>{t('common.cancel', 'Cancel')}</ButtonV2>
          </div>
        </div>
      )}

      {loadError && <p className="text-xs text-red-600 mb-3">{t('dispatch.loadFailed', { defaultValue: 'Could not read dispatch: {{msg}}', msg: loadError })}</p>}

      <div className="text-xs font-bold uppercase text-slate-500 mb-2">{t('dispatch.inTransitByVehicle', 'In transit · by vehicle')}</div>
      {busyLoading ? (
        <p className="text-sm text-slate-400 mb-4">…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-slate-400 mb-4">{t('dispatch.nothingInTransit', 'Nothing in transit.')}</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
          {groups.map(g => (
            <div key={g.key} className="border border-slate-200 rounded-xl p-3 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-sm font-bold">{g.vehicle || t('dispatch.noVehicle', 'No vehicle number')}</div>
                <div className="text-xs text-slate-500">{formatDate(g.date)}</div>
              </div>
              {g.rows.map(r => (
                <div key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-1.5 border-t border-slate-100">
                  <div className="min-w-0 text-sm">
                    <div className="flex flex-wrap items-center gap-2">{kindBadge(r)}<span className="font-semibold break-words">{r.item || '—'}</span></div>
                    <div className="text-xs text-slate-500 mt-0.5 break-words">
                      {r.from_location || '—'} → {r.destination || '—'} · {r.sender || '—'}{r.supplier ? ` · ${r.supplier}` : ''}
                    </div>
                  </div>
                  {receiveAction(r)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-full sm:w-72">
          <TableSearch value={q} onChange={setQ} placeholder={t('dispatch.search', 'Search item, vehicle, person…')} />
        </div>
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm" value={state} onChange={e => setState(e.target.value as typeof state)}>
          <option value="all">{t('dispatch.stateAll', 'All')}</option>
          <option value="transit">{t('dispatch.stateTransit', 'In transit')}</option>
          <option value="received">{t('dispatch.stateReceived', 'Received')}</option>
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="dt2 text-sm">
          <thead>
            <tr>
              <th>{t('dispatch.date', 'Date')}</th>
              <th>{t('dispatch.route', 'From → Destination')}</th>
              <th>{t('dispatch.itemShort', 'Item / document')}</th>
              <th>{t('dispatch.vehicleShort', 'Vehicle')}</th>
              <th>{t('dispatch.senderShort', 'Sender')}</th>
              <th>{t('dispatch.receiverShort', 'Receiver')}</th>
              <th>{t('dispatch.receiveDate', 'Receive date')}</th>
              <th>{t('dispatch.remarks', 'Remarks')}</th>
            </tr>
          </thead>
          <tbody>
            {page.pageRows.map(r => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{formatDate(r.date)}</td>
                <td>{r.from_location || '—'} → {r.destination || '—'}</td>
                <td><div className="flex flex-wrap items-center gap-2">{kindBadge(r)}<span>{r.item || '—'}</span></div>{r.document_ref ? <div className="text-xs text-slate-400">{r.document_ref}</div> : null}</td>
                <td className="whitespace-nowrap">{r.vehicle_no || '—'}</td>
                <td>{r.sender || '—'}</td>
                <td>{r.receiver || '—'}</td>
                <td className="whitespace-nowrap">
                  {r.receive_date ? formatDate(r.receive_date) : (
                    <div className="flex flex-col gap-1 items-start">
                      <span className="badge" style={{ background: '#FFEDD5', color: '#C2410C' }}>{t('dispatch.stateTransit', 'In transit')}</span>
                      {receiveAction(r)}
                    </div>
                  )}
                </td>
                <td>{r.remarks || '—'}</td>
              </tr>
            ))}
            {page.pageRows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-slate-400 py-4">
                  {busyLoading ? '…' : filtersOn ? t('dispatch.noMatch', 'No dispatch rows match these filters.') : t('dispatch.empty', 'No live dispatch yet. The workbook sheet below is the older log.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <TablePagination controls={page.controls} />

      {stockFor && (
        <AddPurchaseModal
          open
          initialPlantId={destPlantId(stockFor)}
          onClose={() => setStockFor(null)}
          // Stock is booked by Add purchase itself; this only closes the consignment.
          onApplied={() => { void markReceived(stockFor, istToday(), activeProfile.name); }}
        />
      )}
    </div>
  );
}
