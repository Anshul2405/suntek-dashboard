import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
import { insertRows, updateRows } from '../../../lib/db';
import { useToast } from '../../../components/ui/toast';
import { useRoleContext } from '../../../contexts/RoleContext';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { isAdminProfile, profileHasCapability } from '../../../lib/profiles';
import { formatDate, istToday } from '../../../lib/utils/formatting';
import { usePagination } from '../../../components/ui/usePagination';
import { TablePaginationV2 as TablePagination, ButtonV2 } from '../../../components/v2';
import { TableSearch, useTextFilter } from '../../../components/ui/TableSearch';
import { AddPurchaseModal } from './AddPurchaseModal';
import { PhotoUploader } from './maintenance/shared';
import { uploadWorkflowImage } from '../../../lib/cloudinary';
import { DateInput } from '../../../components/ui/DateInput';
import { vehicleNoForSave } from '../../../lib/validate/vehicleNo';
import { BUSY_COMPANIES } from '../../../lib/busyCompanies';
import { useBusyPayees, type BusyCompany } from '../../../lib/busyPayees';
import { useColumnLive } from '../../../lib/schemaProbe';
import { useUrlFilters } from '../../../lib/urlFilters';
import { missingBank } from '../../../lib/paymentFlow';
import { isValidIfsc, normalizeIfsc } from '../../../lib/validate/ifsc';
import { logActivity } from '../../../lib/activityWrite';
import { useRights } from '../../../lib/access/useRights';
import { ensureLateApproval } from '../../../lib/opsControls';
import {
  HEAD_OFFICE, billUrlFromRemarks, canReceive, dispatchSaveProblems, groupInTransit, isInTransit, isStorePart, placesOrFilter, withBillRemark, type DispatchRow,
} from '../../../lib/dispatch';

const input = 'block mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm w-full max-sm:min-h-[44px] max-sm:text-[16px]';
const label = 'text-xs text-slate-600 min-w-0';
/** Receive / Save on a row: a plain link on desktop, a 44px button on phones. */
const RECEIVE_BTN = 'text-xs font-bold text-emerald-700 whitespace-nowrap max-sm:min-h-[44px] max-sm:px-3 max-sm:rounded-lg max-sm:border max-sm:border-emerald-200 max-sm:bg-emerald-50 max-sm:text-[13px]';

const BLANK = {
  kind: 'item' as 'item' | 'part',
  company: '' as BusyCompany | '',
  payee: '',
  manual: false,
  exceptionReason: '',
  account_no: '',
  ifsc: '',
  bank: '',
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
  // User Management → Add / Edit / Delete ticks (and Purchase-book tabs).
  const rights = useRights();
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
  const [billBlob, setBillBlob] = useState<Blob | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState<'all' | 'transit' | 'received'>('all');
  const [receiving, setReceiving] = useState<{ id: string; date: string; name: string } | null>(null);
  const [stockFor, setStockFor] = useState<DispatchRow | null>(null);
  // Company + payee need migration 0042. Until it is applied the form stays as
  // it was (no company / payee) and says so.
  const payeeLive = useColumnLive('dispatch_logs', 'company_code');
  // Payees of the picked company, from its Busy feed (read only).
  const { data: payees, isLoading: payeesLoading } = useBusyPayees(payeeLive ? form.company : '');

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
    setBillBlob(null);
    setSaveError(null);
    setShowForm(true);
  };

  // A typed vehicle number must be an Indian one; the box may stay empty.
  const vehicleSave = vehicleNoForSave(form.vehicle_no);
  const ifscBad = !!form.ifsc.trim() && !isValidIfsc(form.ifsc);
  const formMissingBank = payeeLive && !!form.payee.trim() && missingBank({ account_no: form.account_no, ifsc: form.ifsc });
  // Same rules the tests check (lib/dispatch.ts): company / payee / IFSC only with 0042.
  const canSave = dispatchSaveProblems(form, { payeeLive, hasBill: !!billBlob }).length === 0;

  async function save() {
    if (!canSave) return;
    // Back-date limit (User Management → Back-date limits). A future date is fine.
    const allowedDate = await ensureLateApproval({
      module: 'dispatch', entryDate: form.date, profile: activeProfile,
      bufferDays: rights.backDays('dispatch', [plants.find(p => p.name === form.from)?.id]),
    });
    if (!allowedDate) { setSaveError(t('common.lateBlocked', 'Not saved: this date is further back than allowed. A request has gone to Management; once approved, save again with the same date.')); return; }
    setSaving(true);
    setSaveError(null);
    try {
      let remarks = form.remarks.trim();
      if (form.kind === 'part' && billBlob) {
        const uploaded = await uploadWorkflowImage(billBlob, {
          workflow: 'store-req', kind: 'bill', creator: activeProfile.name, entityId: form.item.trim().slice(0, 40),
        });
        remarks = withBillRemark(remarks, uploaded.secure_url);
      }
      const { data, error } = await insertRows('dispatch_logs', {
        destination: form.destination,
        date: form.date,
        item: form.item.trim(),
        document_ref: form.document_ref.trim() || null,
        vehicle_no: vehicleSave || null,
        sender: form.sender.trim(),
        receiver: form.receiver.trim() || null,
        from_location: form.from,
        supplier: form.kind === 'part' ? form.supplier.trim() : null,
        receive_date: null,
        remarks: remarks || null,
        ...(payeeLive ? {
          company_code: form.company || null,
          payee: form.payee.trim(),
          payee_source: form.manual ? 'manual' : 'busy',
          exception_reason: form.manual ? form.exceptionReason.trim() : null,
          account_no: form.account_no.replace(/\s+/g, '') || null,
          ifsc: normalizeIfsc(form.ifsc) || null,
          bank: form.bank.trim() || null,
        } : {}),
      }).select('*').single();
      if (error) {
        setSaveError(error.message);
        return;
      }
      if (data) {
        const row = data as DispatchRow;
        setRows(prev => [row, ...prev]);
        // A line in the Activity Log that opens this dispatch (needs 0042).
        void logActivity({
          type: 'dispatch', date: row.date, done_by: row.sender, verified_by: null, photo_url: null,
          equipment: `Dispatch: ${row.item || ''}`.trim(),
          plant_id: plants.find(p => p.name === row.from_location)?.id ?? null,
          note: `${row.from_location || '—'} → ${row.destination || '—'}${row.vehicle_no ? ` · ${row.vehicle_no}` : ''}`,
        }, { type: 'dispatch', id: row.id }, { onlyIfLinked: true });
      }
      setBillBlob(null);
      setShowForm(false);
      toast.success(t('dispatch.savedInTransit', 'Saved. It shows as in transit until the receiving place fills the receive date.'));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function markReceived(row: DispatchRow, date: string, name: string) {
    const patch = { receive_date: date, receiver: name.trim() || row.receiver };
    const { error } = await updateRows('dispatch_logs', patch).eq('id', row.id);
    if (error) { toast.error(error.message); return false; }
    setRows(prev => prev.map(r => (r.id === row.id ? { ...r, ...patch } : r)));
    // A store requisition bought and sent on this row is now received too.
    if (isStorePart(row)) {
      await updateRows('store_requisitions', { status: 'received' }).eq('dispatch_id', row.id).eq('status', 'in_transit');
    }
    setReceiving(null);
    toast.success(t('dispatch.receivedOk', 'Marked received.'));
    return true;
  }

  const groups = useMemo(() => groupInTransit(rows), [rows]);
  // Opened from Activity Log (?dispatch=<id>): that one row, "Show all" clears it.
  const focus = useUrlFilters(['dispatch'] as const);
  const focusId = focus.values.dispatch;
  const prepared = useMemo(
    () => (focusId ? rows.filter(r => r.id === focusId)
      : rows.filter(r => state === 'all' || (state === 'transit' ? isInTransit(r) : !isInTransit(r)))),
    [rows, state, focusId],
  );
  const filtered = useTextFilter(prepared, q, r => [
    r.payee, BUSY_COMPANIES.find(c => c.code === r.company_code)?.short,
    r.item, r.document_ref, r.vehicle_no, r.sender, r.receiver, r.from_location, r.destination, r.supplier, r.remarks,
    formatDate(r.date), r.receive_date ? formatDate(r.receive_date) : '',
  ]);
  const page = usePagination(filtered, { resetKey: `${q}|${state}` });
  const filtersOn = q.trim() !== '' || state !== 'all';
  const destPlantId = (row: DispatchRow) => plants.find(p => p.name === row.destination)?.id;

  const receiveAction = (row: DispatchRow) => {
    if (!canReceive(row, myPlaceSet, admin)) return null;
    if (isStorePart(row)) {
      // Receiving a bought part books stock through Add purchase — same permission.
      if (!admin && !profileHasCapability(activeProfile, 'add_stock_purchase')) return null;
      return (
        <button type="button" className={RECEIVE_BTN} onClick={() => setStockFor(row)}>
          {t('dispatch.receiveIntoStock', 'Receive into stock')}
        </button>
      );
    }
    if (receiving?.id === row.id) {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <DateInput className="border border-slate-200 rounded-lg px-2 py-1 text-xs w-32 max-sm:w-40" value={receiving.date}
            onChange={e => setReceiving({ ...receiving, date: e.target.value })} />
          <input className="border border-slate-200 rounded-lg px-2 py-1 text-xs w-28 max-sm:w-40 max-sm:min-h-[44px] max-sm:text-[16px]" value={receiving.name}
            placeholder={t('dispatch.receiverName', 'Receiver name')}
            onChange={e => setReceiving({ ...receiving, name: e.target.value })} />
          <button type="button" className={RECEIVE_BTN} disabled={!receiving.date}
            onClick={() => void markReceived(row, receiving.date, receiving.name)}>{t('dispatch.saveReceived', 'Save')}</button>
          <button type="button" className="text-xs text-slate-500 max-sm:min-h-[44px] max-sm:px-3" onClick={() => setReceiving(null)}>{t('common.cancel', 'Cancel')}</button>
        </div>
      );
    }
    return (
      <button type="button" className={RECEIVE_BTN}
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
        {myPlaces.length > 0 && !showForm && rights.can('dispatch', 'add') && (
          <ButtonV2 variant="primary" className="max-sm:w-full" onClick={openForm}>{t('dispatch.add', 'New dispatch')}</ButtonV2>
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
          {!payeeLive && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              {t('dispatch.needs0042', 'Busy company and payee are saved once migration 0042 is applied. Until then a dispatch is saved without them.')}
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {payeeLive && (
              <label className={label}>{t('dispatch.company', 'Busy company *')}
                <select className={input} value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value as BusyCompany | '', payee: '', account_no: '', ifsc: '', bank: '' }))}>
                  <option value="">{t('payments.pickCompany', 'Pick the company first…')}</option>
                  {BUSY_COMPANIES.map(c => <option key={c.code} value={c.code}>{c.short} ({c.code})</option>)}
                </select>
              </label>
            )}
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
            {payeeLive && (
              <>
                <label className={`${label} sm:col-span-2 lg:col-span-3`}>{t('dispatch.payee', 'Payee *')}
                  {form.manual ? (
                    <input className={input} value={form.payee} disabled={!form.company} onChange={e => setForm(f => ({ ...f, payee: e.target.value }))} />
                  ) : (
                    <select className={input} value={form.payee} disabled={!form.company} onChange={e => {
                      const p = (payees ?? []).find(x => x.name === e.target.value);
                      // Bank details only from Busy — never made up. Blank stays blank.
                      setForm(f => ({ ...f, payee: e.target.value, account_no: p?.accountNo || '', ifsc: p?.ifsc || '', bank: p?.bank || '' }));
                    }}>
                      <option value="">{!form.company ? t('payments.pickCompanyFirst', 'Pick the company first') : payeesLoading ? '…' : (payees?.length ? t('payments.pickPayee', 'Pick a payee from Busy…') : t('payments.noBusyPayees', 'No payees in this company’s Busy feed'))}</option>
                      {(payees ?? []).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                  )}
                  <span className="flex items-center gap-2 mt-1">
                    <input type="checkbox" checked={form.manual} disabled={!form.company} onChange={e => setForm(f => ({ ...f, manual: e.target.checked, payee: '', account_no: '', ifsc: '', bank: '' }))} />
                    {t('payments.notInBusy', 'Payee not in Busy (exception)')}
                  </span>
                </label>
                {form.manual && (
                  <label className={`${label} sm:col-span-2 lg:col-span-3`}>{t('payments.exceptionReason', 'Why is this payee not in Busy? *')}
                    <input className={input} value={form.exceptionReason} onChange={e => setForm(f => ({ ...f, exceptionReason: e.target.value }))} />
                  </label>
                )}
                <label className={label}>{t('payments.account', 'A/c number')}
                  <input className={input} inputMode="numeric" autoComplete="off" value={form.account_no} onChange={e => setForm(f => ({ ...f, account_no: e.target.value }))} />
                </label>
                <label className={label}>{t('payments.ifsc', 'IFSC')}
                  <input className={input} autoComplete="off" value={form.ifsc} aria-invalid={ifscBad || undefined}
                    style={ifscBad ? { borderColor: '#DC2626' } : undefined}
                    onChange={e => setForm(f => ({ ...f, ifsc: e.target.value }))} />
                  {ifscBad && <span className="block text-[11px] text-red-600 mt-1">{t('common.ifscInvalid', 'IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. UTIB0000123).')}</span>}
                </label>
                <label className={label}>{t('payments.bank', 'Bank')}
                  <input className={input} value={form.bank} onChange={e => setForm(f => ({ ...f, bank: e.target.value }))} />
                </label>
                {formMissingBank && (
                  <p className="text-xs text-amber-700 sm:col-span-2 lg:col-span-3">{t('dispatch.missingBankHint', 'Busy has no account no / IFSC for this payee. Leave them blank or type them from the bill — never guess.')}</p>
                )}
              </>
            )}
            <label className={label}>{t('dispatch.date', 'Date')}
              <DateInput className={input} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
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
              <input className={input} value={form.vehicle_no} placeholder="UP13ET7451" aria-invalid={vehicleSave === null || undefined}
                style={vehicleSave === null ? { borderColor: '#DC2626' } : undefined}
                onChange={e => setForm(f => ({ ...f, vehicle_no: e.target.value }))} />
              {vehicleSave === null && <span className="block text-[11px] text-red-600 mt-1">{t('common.vehicleInvalid', 'Use an Indian vehicle number, like UP13ET7451, DL1CAB1234 or 22BH1234AB.')}</span>}
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
            <>
              <PhotoUploader onBlobReady={setBillBlob} label={t('dispatch.bill', 'Supplier bill *')} hint={t('dispatch.billHint', 'The purchaser has the bill — attach it with the vehicle number.')} />
              <p className="text-xs text-slate-500 mt-2">{t('dispatch.partHint', 'On arrival the receiving plant opens Receive into stock, which is the same Add purchase used in the Stock register.')}</p>
            </>
          )}
          {saveError && (
            <p className="text-xs text-red-600 mt-2">{t('dispatch.saveFailed', { defaultValue: 'Not saved: {{msg}}. If the table refuses every row it is waiting for SQL (migration 0038).', msg: saveError })}</p>
          )}
          {/* Phones: Save stays under the thumb (pinned above the home indicator). */}
          <div className="flex gap-2 mt-3 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-3 max-sm:px-3 max-sm:pt-2 max-sm:pb-[max(8px,env(safe-area-inset-bottom))] max-sm:bg-white max-sm:border-t max-sm:border-slate-200" data-testid="dispatch-save-bar">
            <ButtonV2 variant="primary" className="max-sm:flex-1" disabled={!canSave || saving} onClick={() => void save()}>
              {saving ? t('common.saving', 'Saving…') : t('dispatch.saveInTransit', 'Save — in transit')}
            </ButtonV2>
            <ButtonV2 className="max-sm:flex-1" onClick={() => setShowForm(false)}>{t('common.cancel', 'Cancel')}</ButtonV2>
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
                      {billUrlFromRemarks(r.remarks) ? <> · <a className="text-emerald-700 font-semibold" href={billUrlFromRemarks(r.remarks)!} target="_blank" rel="noreferrer">{t('dispatch.billLink', 'Bill')}</a></> : null}
                    </div>
                  </div>
                  {receiveAction(r)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {focusId && (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 flex flex-wrap items-center gap-2">
          {busyLoading ? '…' : prepared.length ? t('dispatch.focusOne', 'The dispatch from the Activity Log.') : t('dispatch.focusGone', 'That dispatch is not in your list — deleted, or not for your places.')}
          <button type="button" className="font-semibold underline" onClick={() => focus.set({ dispatch: '' })}>{t('storereq.linkShowAll', 'Show all')}</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-full sm:w-72">
          <TableSearch value={q} onChange={setQ} placeholder={t('dispatch.search', 'Search item, vehicle, person…')} />
        </div>
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm max-sm:w-full max-sm:min-h-[44px] max-sm:text-[16px]" value={state} onChange={e => setState(e.target.value as typeof state)}>
          <option value="all">{t('dispatch.stateAll', 'All')}</option>
          <option value="transit">{t('dispatch.stateTransit', 'In transit')}</option>
          <option value="received">{t('dispatch.stateReceived', 'Received')}</option>
        </select>
      </div>
      {/* Phones and tablets (below 1024px, where the sidebar leaves no room for the one-line table): one card per dispatch. */}
      <div className="lg:hidden flex flex-col gap-2" data-testid="dispatch-cards">
        {page.pageRows.map(r => (
          <div key={r.id} className="rounded-xl border border-slate-200 p-3 text-sm">
            <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
              <span className="whitespace-nowrap">{formatDate(r.date)}</span>
              <span className="font-semibold text-slate-700 whitespace-nowrap">{r.vehicle_no || '—'}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1">{kindBadge(r)}<span className="font-semibold break-words">{r.item || '—'}</span></div>
            {r.document_ref ? <div className="text-xs text-slate-400">{r.document_ref}</div> : null}
            <div className="text-xs text-slate-600 mt-1 break-words">{r.from_location || '—'} → {r.destination || '—'}</div>
            {(r.company_code || r.payee) && (
              <div className="text-xs text-slate-400 break-words">
                {[BUSY_COMPANIES.find(c => c.code === r.company_code)?.short, r.payee, r.payee_source === 'manual' ? t('dispatch.manualPayee', 'not in Busy') : null].filter(Boolean).join(' · ')}
              </div>
            )}
            <div className="text-xs text-slate-500 mt-1 break-words">
              {t('dispatch.senderShort', 'Sender')}: {r.sender || '—'} · {t('dispatch.receiverShort', 'Receiver')}: {r.receiver || '—'}
            </div>
            {(r.remarks) && (
              <div className="text-xs text-slate-500 mt-0.5 break-words">{billUrlFromRemarks(r.remarks)
                ? <a className="text-emerald-700 font-semibold" href={billUrlFromRemarks(r.remarks)!} target="_blank" rel="noreferrer">{t('dispatch.billLink', 'Bill')}</a>
                : r.remarks}</div>
            )}
            <div className="mt-2">
              {r.receive_date
                ? <span className="text-xs text-slate-500">{t('dispatch.receiveDate', 'Receive date')}: {formatDate(r.receive_date)}</span>
                : <div className="flex flex-wrap items-center gap-2">
                    <span className="badge" style={{ background: '#FFEDD5', color: '#C2410C' }}>{t('dispatch.stateTransit', 'In transit')}</span>
                    {receiveAction(r)}
                  </div>}
            </div>
          </div>
        ))}
        {page.pageRows.length === 0 && (
          <div className="text-center text-slate-400 py-4 text-sm">
            {busyLoading ? '…' : filtersOn ? t('dispatch.noMatch', 'No dispatch rows match these filters.') : t('dispatch.empty', 'No live dispatch yet. The workbook sheet below is the older log.')}
          </div>
        )}
      </div>
      <div className="overflow-x-auto max-lg:hidden">
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
                <td>
                  {r.from_location || '—'} → {r.destination || '—'}
                  {(r.company_code || r.payee) && (
                    <div className="text-xs text-slate-400">
                      {[BUSY_COMPANIES.find(c => c.code === r.company_code)?.short, r.payee, r.payee_source === 'manual' ? t('dispatch.manualPayee', 'not in Busy') : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
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
                <td>{billUrlFromRemarks(r.remarks)
                  ? <a className="text-emerald-700 font-semibold" href={billUrlFromRemarks(r.remarks)!} target="_blank" rel="noreferrer">{t('dispatch.billLink', 'Bill')}</a>
                  : (r.remarks || '—')}</td>
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
