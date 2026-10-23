import React, { useEffect, useMemo, useRef, useState } from 'react';
import { displayLocationName } from '../../../lib/plantLabels';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
// Shared humanizer — a user should never be shown a raw error object.
import { humanizeError as errMsg } from '../../../lib/errors';
import { fetchActivePlants } from '../../../lib/plants';
import { callRpc } from '../../../lib/db';
import { uploadWorkflowFile } from '../../../lib/cloudinary';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { plantsForPicker } from '../../../lib/access/pickerPlants';
import { ensureLateApproval, useOpsSettings, loadMyLateRequests, type LateRequest } from '../../../lib/opsControls';
import { billBufferDays } from '../../../lib/datePolicy';
import { useRoleContext } from '../../../contexts/RoleContext';
import { normalizeUnit, UNIT_OPTIONS } from '../../../lib/store/parseStockFile';
import { parseBill, matchCandidates, type ParsedBill, type StockLite } from '../../../lib/store/purchaseParse';
import { reconcileBillAmount } from '../../../lib/nvidiaOcr';
import { normalizeGstin, isValidGstin } from '../../../lib/utils/gst';
import { ProgressBar, useFakeProgress } from '../../../components/ui/ProgressBar';

type StockItem = StockLite & { plant_id: string | null };
type Plant = { id: string; name: string };

interface Line {
  key: string;
  name: string;
  qty: string;
  unit: string;
  amount: number | null;
  choice: string;              // store_item id, or 'new'
}

let seq = 0;
const nextKey = () => `l${++seq}`;

/** Local calendar date as YYYY-MM-DD (never toISOString — that shifts IST past midnight). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Self-contained purchase → stock modal. Drops into any tab; loads its own
 *  plants + stock (plant-scoped) so callers only wire open/onClose/onApplied.
 *  Submission is a single atomic, idempotent RPC (apply_stock_purchase): the
 *  receipt (vendor, amount, GST, invoice, bill) is persisted and the register
 *  increments happen server-side in one transaction. */
export function AddPurchaseModal({ open, onClose, onApplied }: {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const { activeProfile } = useRoleContext();
  const { storeQuery, allowedPlants, ready: scopeReady } = usePlantScope();
  const ops = useOpsSettings();
  const actorName = activeProfile.name;

  const [plants, setPlants] = useState<Plant[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [mode, setMode] = useState<'choose' | 'manual' | 'bill'>('choose');
  const [stage, setStage] = useState<'choose' | 'parsing' | 'edit' | 'saving' | 'done' | 'error'>('choose');
  const [plantId, setPlantId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [bill, setBill] = useState<ParsedBill | null>(null);
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  const [parseProg, setParseProg] = useState<{ page: number; pages: number }>({ page: 0, pages: 0 });
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Purchase header fields (persisted onto the receipt) ────────────────────
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');           // total bill amount (₹)
  const [gstNo, setGstNo] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(localToday());
  const [notes, setNotes] = useState('');
  const [knownVendors, setKnownVendors] = useState<string[]>([]);
  const [dupInvoice, setDupInvoice] = useState(false);
  const [myLate, setMyLate] = useState<LateRequest[]>([]);
  // Idempotency key: generated once per editing session, reused across retries,
  // so a network retry can never double-apply the same purchase.
  const [receiptId, setReceiptId] = useState<string>(() => crypto.randomUUID());

  // Reading a bill is a single vision-model call with no streamed %; ease a bar
  // toward 85% while it runs and let per-page progress pull it forward.
  const parseFloor = parseProg.pages > 0 ? Math.round(((parseProg.page - 1) / parseProg.pages) * 85) : 0;
  const billProgress = useFakeProgress(stage === 'parsing', { floor: parseFloor });

  // Load plants + current stock (plant-scoped) whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const { data: pl } = await fetchActivePlants<Plant>('id, name');
      const base = plantsForPicker(allowedPlants as Plant[], scopeReady);
      // store_id comes along so the item list can be narrowed to the register
      // the selected factory actually draws from — at Rehla that is the one
      // shared store, not a per-factory slice.
      const { data: si } = await storeQuery(supabase.from('store_items').select('id, item_name, on_hand, unit, plant_id, store_id')).returns<StockItem[]>();
      if (!alive) return;
      setPlants(base);
      setPlantId(prev => prev || base[0]?.id || '');
      try {
        const late = await loadMyLateRequests('purchase', actorName);
        if (alive) setMyLate(late);
      } catch { /* banner only */ }
      setStock(si || []);
      // Vendor suggestions from past receipts (best-effort — table may predate migration 53).
      try {
        const { data: vs } = await supabase.from('stock_purchase_receipts')
          .select('vendor_name').order('created_at', { ascending: false }).limit(200)
          .returns<{ vendor_name: string }[]>();
        if (alive && vs) setKnownVendors([...new Set(vs.map(v => v.vendor_name).filter(Boolean))]);
      } catch { /* suggestions only */ }
    })();
    return () => { alive = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const stockForPlant = useMemo(() => stock.filter(s => s.plant_id === plantId), [stock, plantId]);

  // Soft duplicate-invoice warning (never blocks): same plant + invoice number.
  useEffect(() => {
    const inv = invoiceNo.trim();
    if (!inv || !plantId) { setDupInvoice(false); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const { data } = await supabase.from('stock_purchase_receipts')
          .select('id').eq('plant_id', plantId).eq('invoice_no', inv).neq('id', receiptId).limit(1)
          .returns<{ id: string }[]>();
        if (alive) setDupInvoice(!!data?.length);
      } catch { if (alive) setDupInvoice(false); }
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [invoiceNo, plantId, receiptId]);

  function reset() {
    setMode('choose'); setStage('choose'); setLines([]); setBill(null);
    setCloudUrl(null); setFileName(''); setErr(null); setFieldErr(null); setAppliedCount(0);
    setVendor(''); setAmount(''); setGstNo(''); setInvoiceNo(''); setNotes('');
    setPurchaseDate(localToday()); setDupInvoice(false);
    setReceiptId(crypto.randomUUID());
  }
  function close() { reset(); onClose(); }

  if (!open) return null;

  const candidatesFor = (name: string) => matchCandidates(name, stockForPlant);
  const bestChoice = (name: string) => { const c = candidatesFor(name); return c[0] && c[0].score >= 0.6 ? c[0].id : 'new'; };

  /** Units to offer for a line: the canonical set, plus whatever the bill said
   *  (an OCR'd "Drum" must stay selectable instead of silently becoming Pcs). */
  const unitOptionsFor = (unit: string) => {
    const u = unit.trim();
    return u && !UNIT_OPTIONS.includes(u) ? [...UNIT_OPTIONS, u] : UNIT_OPTIONS;
  };

  async function handleBill(file: File) {
    setFileName(file.name); setErr(null); setParseProg({ page: 0, pages: 0 }); billProgress.reset(); setStage('parsing');
    try {
      try {
        const up = await uploadWorkflowFile(file, { workflow: 'store-req', subfolder: 'purchase-bills', kind: 'bill', creator: actorName });
        setCloudUrl(up.secure_url);
      } catch { /* archive is best-effort */ }
      const parsed = await parseBill(file, info => setParseProg(info));
      if (!parsed.lineItems.length) throw new Error(t('addPurchase.errNoLines', 'No line items could be read from this bill. Try a clearer scan, or add them manually.'));
      setBill(parsed);
      setLines(parsed.lineItems.map(li => {
        const name = (li.description || '').trim();
        const choice = bestChoice(name);
        const matchedUnit = choice !== 'new' ? stockForPlant.find(s => s.id === choice)?.unit : null;
        return {
          key: nextKey(),
          name,
          qty: li.quantity != null ? String(li.quantity) : '',
          unit: normalizeUnit(li.unit || matchedUnit),
          amount: li.amount ?? null,
          choice,
        };
      }));
      // Prefill the purchase header from the OCR'd bill (all editable).
      if (parsed.supplierName) setVendor(parsed.supplierName);
      if (parsed.supplierGstin) setGstNo(normalizeGstin(parsed.supplierGstin));
      if (parsed.invoiceNumber) setInvoiceNo(parsed.invoiceNumber);
      const total = parsed.totalAmount ?? parsed.subTotal;
      if (total != null && total > 0) setAmount(String(total));
      setStage('edit');
    } catch (e) { setErr(errMsg(e)); setStage('error'); }
  }

  function startManual() { setMode('manual'); setLines([{ key: nextKey(), name: '', qty: '', unit: 'Pcs', amount: null, choice: 'new' }]); setStage('edit'); }

  function updateLine(key: string, patch: Partial<Line>) {
    setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));
  }
  function setName(key: string, name: string) {
    updateLine(key, { name, choice: bestChoice(name) });
  }
  /** Picking an existing item adopts its unit — the register must not end up
   *  holding the same item in two units. */
  function chooseItem(key: string, choice: string) {
    const itemUnit = choice !== 'new' ? stockForPlant.find(s => s.id === choice)?.unit : null;
    updateLine(key, itemUnit ? { choice, unit: normalizeUnit(itemUnit) } : { choice });
  }

  /** Map RPC error strings to friendly, translated messages. */
  function friendlyRpcError(raw: string): string {
    if (/PGRST202|Could not find the function|schema cache/i.test(raw))
      return t('addPurchase.errMigration', 'The purchase service is not installed yet — run migration 53_stock_purchases.sql in Supabase, then retry.');
    if (/forbidden: missing capability/i.test(raw))
      return t('addPurchase.errForbidden', 'You do not have permission to add purchases. Ask an admin for the "Add purchases to stock" allowance.');
    if (/forbidden: plant out of scope/i.test(raw))
      return t('addPurchase.errScope', 'This plant is outside your data scope.');
    if (/not_authenticated/i.test(raw))
      return t('addPurchase.errAuth', 'Your session has expired — sign in again.');
    return raw;
  }

  async function apply() {
    const valid = lines.filter(l => l.name.trim() && (Number(l.qty) || 0) > 0);
    if (!valid.length) { setFieldErr(t('addPurchase.errNoItems', 'Add at least one item with a quantity.')); return; }
    if (!vendor.trim()) { setFieldErr(t('addPurchase.errVendor', 'Vendor name is required.')); return; }
    const amountN = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(amountN) || amountN < 0) {
      setFieldErr(t('addPurchase.errAmount', 'Enter the total bill amount (₹) — 0 or more.')); return;
    }
    const gstNorm = normalizeGstin(gstNo);
    if (gstNorm && !isValidGstin(gstNorm)) {
      setFieldErr(t('addPurchase.errGst', 'That GST number does not look valid (expected 15 characters like 22AAAAA0000A1Z5).')); return;
    }
    setFieldErr(null);
    const allowed = await ensureLateApproval({
      module: 'purchase',
      entryDate: purchaseDate,
      profile: activeProfile,
      bufferDays: billBufferDays([plantId], ops.bufferDaysByPlant, ops.bufferDays),
    });
    if (!allowed) {
      setFieldErr(t('addPurchase.lateBlocked', 'Not saved. This bill date is older than allowed. A request has gone to Management; once approved, open Add purchase again and use the same date.'));
      return;
    }
    setStage('saving');
    try {
      const payload = {
        id: receiptId,
        plant_id: plantId,
        vendor_name: vendor.trim(),
        amount: amountN,
        gst_no: gstNorm || null,
        invoice_no: invoiceNo.trim() || null,
        purchase_date: purchaseDate || null,
        bill_url: cloudUrl,
        notes: notes.trim() || null,
        source: mode === 'bill' ? 'bill' : 'manual',
        actor_name: actorName,
        lines: valid.map(ln => {
          const qty = Number(ln.qty) || 0;
          return {
            item_name: ln.name.trim(),
            qty,
            unit: normalizeUnit(ln.unit) || null,
            unit_price: ln.amount != null && qty > 0 ? ln.amount / qty : null,
            amount: ln.amount,
            store_item_id: ln.choice !== 'new' ? ln.choice : null,
          };
        }),
      };
      const { data: result, error } = await callRpc<{ already_applied?: boolean; lines_applied?: number }>('apply_stock_purchase', { payload });
      if (error) throw new Error(friendlyRpcError(error.message || ''));
      setAppliedCount(result?.lines_applied ?? valid.length);
      setStage('done');
      onApplied();
    } catch (e) { setErr(errMsg(e)); setStage('error'); }
  }

  // Validation banner (bill only): reconcile the sum of line amounts against the
  // bill's totals in a TAX-AWARE way. Line amounts are pre-tax, so they add up to
  // the sub-total, not the GST-inclusive grand total — comparing against the grand
  // total alone flags every taxed bill falsely. reconcileBillAmount accepts any
  // plausible base (sub-total / total−tax / tax-inclusive total).
  const amountSum = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const recon = reconcileBillAmount(amountSum, { subTotal: bill?.subTotal, taxAmount: bill?.taxAmount, totalAmount: bill?.totalAmount });
  const totalMismatch = bill != null && !recon.ok;

  return (
    <div style={overlay} onClick={() => { if (stage !== 'parsing' && stage !== 'saving') close(); }}>
      <div style={{ ...modal, width: stage === 'edit' ? 'min(760px, 100%)' : 'min(460px, 100%)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{t('addPurchase.title', 'Add purchase to stock')}</div>
          <button onClick={close} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#94A3B8' }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 14 }}>{t('addPurchase.subtitle', 'New stock bought is added to the register — matched items increment, new items are created.')}</div>

        {/* Plant picker — ALWAYS shown while choosing, even with one option.
            This purchase is charged to a factory and lands in that factory's
            store; hiding the destination because there is only one choice is how
            a user ends up unsure which register they just added stock to. */}
        {stage === 'choose' && plants.length === 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={label}>{t('addPurchase.plant', 'Plant')}</div>
            <span className="chip active" style={{ cursor: 'default', display: 'inline-block' }}>{displayLocationName(plants[0].name)}</span>
          </div>
        )}
        {stage === 'choose' && plants.length > 1 && (
          <div style={{ marginBottom: 14 }}>
            <div style={label}>{t('addPurchase.plant', 'Plant')}</div>
            <select value={plantId} onChange={e => setPlantId(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
              {plants.map(p => <option key={p.id} value={p.id}>{displayLocationName(p.name)}</option>)}
            </select>
          </div>
        )}

        {myLate.length > 0 && (stage === 'choose' || stage === 'edit') && (
          <div style={{ fontSize: 12, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '8px 10px', marginBottom: 12, color: '#166534' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('addPurchase.lateTitle', 'Your late bill dates')}</div>
            {myLate.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '3px 0' }}>
                <span>
                  {fmtLateDate(r.entry_date)} · {r.status === 'approved'
                    ? t('addPurchase.lateApproved', { defaultValue: 'approved by {{who}}', who: r.reviewed_by || 'Management' })
                    : t('addPurchase.latePending', 'waiting for Management')}
                </span>
                {r.status === 'approved' && r.entry_date && (
                  <button
                    type="button"
                    onClick={() => { setPurchaseDate(r.entry_date!.slice(0, 10)); if (stage === 'choose') startManual(); }}
                    style={{ ...btnGhost, padding: '4px 10px', fontSize: 12, borderColor: '#86EFAC', color: '#166534' }}
                  >
                    {stage === 'edit' && purchaseDate === r.entry_date.slice(0, 10)
                      ? t('addPurchase.lateInUse', 'Date set')
                      : t('addPurchase.lateUse', 'Use this date')}
                  </button>
                )}
              </div>
            ))}
            <div style={{ color: '#15803D', marginTop: 4 }}>{t('addPurchase.lateHint', 'Upload the bill or enter it manually, then keep this purchase date and save.')}</div>
          </div>
        )}

        {stage === 'choose' && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => { setMode('bill'); fileRef.current?.click(); }} style={{ ...btnGhost, flex: 1, padding: '18px 12px', borderColor: '#C7D2FE' }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#4338CA' }}>📄 {t('addPurchase.uploadBill', 'Upload bill (AI)')}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 3 }}>{t('addPurchase.uploadBillSub', 'Image or PDF — auto-reads items & quantities')}</div>
            </button>
            <button onClick={startManual} style={{ ...btnGhost, flex: 1, padding: '18px 12px' }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#334155' }}>✎ {t('addPurchase.enterManually', 'Enter manually')}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 3 }}>{t('addPurchase.enterManuallySub', 'Type item + quantity')}</div>
            </button>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleBill(f); e.target.value = ''; }} />
          </div>
        )}

        {stage === 'parsing' && (
          <div style={{ padding: '16px 0 8px' }}>
            <ProgressBar
              pct={billProgress.pct}
              label={parseProg.pages > 1
                ? t('addPurchase.readingPage', { defaultValue: 'Reading the bill… page {{page}} of {{pages}}', page: parseProg.page, pages: parseProg.pages })
                : t('addPurchase.reading', { defaultValue: 'Reading the bill… ({{file}})', file: fileName })}
            />
            <div style={{ fontSize: 11, color: '#94A3B8' }}>{t('addPurchase.readingSub', 'AI is extracting items & quantities — this can take a few seconds.')}</div>
          </div>
        )}

        {stage === 'edit' && (
          <div>
            {mode === 'bill' && bill && (
              <div style={{ fontSize: 12, color: '#475569', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
                {bill.invoiceNumber ? <>{t('addPurchase.invoice', 'Invoice')} <strong>{bill.invoiceNumber}</strong>{bill.supplierName ? ` · ${bill.supplierName}` : ''} · </> : null}
                <strong>{lines.length}</strong> {t('addPurchase.itemsReadFrom', { defaultValue: 'item(s) read from {{pages}} page(s).', pages: bill.pages })}
                {totalMismatch && <span style={{ color: '#B45309' }}> ⚠ {t('addPurchase.reconWarn', { defaultValue: "line amounts (₹{{sum}}) don't reconcile with the bill's pre-tax total (₹{{expected}}) — verify quantities.", sum: Math.round(amountSum).toLocaleString('en-IN'), expected: recon.expected != null ? Math.round(recon.expected).toLocaleString('en-IN') : '?' })}</span>}
              </div>
            )}

            {/* ── Purchase details (persisted onto the receipt) ─────────────── */}
            <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: 10, marginBottom: 10, background: '#FAFBFC' }}>
              <div style={{ ...label, marginBottom: 8 }}>{t('addPurchase.detailsHeader', 'Purchase details')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                <div>
                  <div style={label}>{t('addPurchase.vendor', 'Vendor name')} *</div>
                  <input value={vendor} onChange={e => setVendor(e.target.value)} list="ap-vendors"
                    placeholder={t('addPurchase.vendorPh', 'e.g. Sharma Traders')} style={{ ...inputStyle, width: '100%' }} />
                  <datalist id="ap-vendors">{knownVendors.map(v => <option key={v} value={v} />)}</datalist>
                </div>
                <div>
                  <div style={label}>{t('addPurchase.amount', 'Total bill amount (₹)')} *</div>
                  <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                    placeholder="0.00" style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <div style={label}>{t('addPurchase.gst', 'GST no. (optional)')}</div>
                  <input value={gstNo} onChange={e => setGstNo(e.target.value.toUpperCase())}
                    placeholder="22AAAAA0000A1Z5" style={{ ...inputStyle, width: '100%', ...(gstNo && !isValidGstin(gstNo) ? { borderColor: '#F59E0B' } : {}) }} />
                </div>
                <div>
                  <div style={label}>{t('addPurchase.invoiceNo', 'Invoice no. (optional)')}</div>
                  <input value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)}
                    placeholder="INV-000" style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <div style={label}>{t('addPurchase.date', 'Purchase date')}</div>
                  <input type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <div style={label}>{t('addPurchase.notes', 'Notes (optional)')}</div>
                  <input value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder={t('addPurchase.notesPh', 'anything worth remembering')} style={{ ...inputStyle, width: '100%' }} />
                </div>
              </div>
              {dupInvoice && (
                <div style={{ fontSize: 11.5, color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '6px 8px', marginTop: 8 }}>
                  ⚠ {t('addPurchase.dupInvoice', 'A purchase with this invoice number already exists for this plant — double-check before saving (saving anyway is allowed).')}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {lines.map(ln => {
                const cands = candidatesFor(ln.name);
                const chosen = ln.choice !== 'new' ? stockForPlant.find(s => s.id === ln.choice) : null;
                const qtyN = Number(ln.qty) || 0;
                return (
                  <div key={ln.key} style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: 10 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <input value={ln.name} onChange={e => setName(ln.key, e.target.value)} placeholder={t('addPurchase.itemName', 'Item name')} style={{ ...inputStyle, flex: 1 }} />
                      <input type="number" value={ln.qty} onChange={e => updateLine(ln.key, { qty: e.target.value })} placeholder={t('addPurchase.qty', 'Qty')} style={{ ...inputStyle, width: 80 }} />
                      <select
                        value={normalizeUnit(ln.unit)}
                        onChange={e => updateLine(ln.key, { unit: e.target.value })}
                        disabled={!!chosen?.unit}
                        title={chosen?.unit
                          ? t('addPurchase.unitLocked', { defaultValue: 'Unit comes from {{item}} in the register.', item: chosen.item_name })
                          : t('addPurchase.unit', 'Unit')}
                        style={{ ...inputStyle, width: 92, background: chosen?.unit ? '#F8FAFC' : '#fff', color: chosen?.unit ? '#64748B' : 'inherit' }}
                      >
                        {unitOptionsFor(ln.unit).map(u => <option key={u} value={u}>{u === 'Ft' ? t('addPurchase.unitFeet', 'Feet') : u}</option>)}
                      </select>
                      {lines.length > 1 && <button onClick={() => setLines(ls => ls.filter(l => l.key !== ln.key))} style={{ border: 'none', background: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>}
                    </div>
                    {/* Match confirmation: top-3 candidates + create-new */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 10.5, color: '#94A3B8', textTransform: 'uppercase', fontWeight: 600 }}>{cands.length ? t('addPurchase.sameAs', 'Same as?') : t('addPurchase.noMatch', 'No match —')}</span>
                      {cands.map(c => (
                        <button key={c.id} onClick={() => chooseItem(ln.key, c.id)}
                          style={{ ...pill, borderColor: ln.choice === c.id ? '#16A34A' : '#E2E8F0', background: ln.choice === c.id ? '#F0FDF4' : '#fff', color: ln.choice === c.id ? '#16A34A' : '#475569' }}>
                          {c.item_name} · {c.on_hand}{c.unit ? ` ${c.unit}` : ''}
                        </button>
                      ))}
                      <button onClick={() => updateLine(ln.key, { choice: 'new' })}
                        style={{ ...pill, borderColor: ln.choice === 'new' ? '#7C3AED' : '#E2E8F0', background: ln.choice === 'new' ? '#FAF5FF' : '#fff', color: ln.choice === 'new' ? '#7C3AED' : '#475569' }}>
                        ＋ {t('addPurchase.createNew', 'Create new')}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: '#64748B', marginTop: 6 }}>
                      {chosen ? <>→ <strong>{chosen.item_name}</strong>: {chosen.on_hand} + {qtyN} = <strong style={{ color: '#16A34A' }}>{chosen.on_hand + qtyN}</strong> {normalizeUnit(ln.unit)}</>
                        : <>→ {t('addPurchase.newItemWith', 'new item')} <strong>{ln.name || '—'}</strong> {t('addPurchase.withQty', 'with qty')} <strong style={{ color: '#7C3AED' }}>{qtyN}</strong> {normalizeUnit(ln.unit)}</>}
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={() => setLines(ls => [...ls, { key: nextKey(), name: '', qty: '', unit: 'Pcs', amount: null, choice: 'new' }])}
              style={{ width: '100%', padding: '8px', borderRadius: 10, border: '1.5px dashed #CBD5E1', background: '#fff', color: '#475569', cursor: 'pointer', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit', margin: '10px 0' }}>+ {t('addPurchase.addLine', 'Add line')}</button>
            {fieldErr && (
              <div style={{ fontSize: 12.5, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>{fieldErr}</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={close} style={btnGhost}>{t('addPurchase.cancel', 'Cancel')}</button>
              <button onClick={apply} style={{ ...btnPrimary, flex: 1 }}>{t('addPurchase.addToStock', 'Add to stock')}</button>
            </div>
          </div>
        )}

        {stage === 'saving' && <div style={{ fontSize: 13, color: '#475569', padding: '20px 0' }}>{t('addPurchase.saving', 'Updating the register…')}</div>}

        {stage === 'done' && (
          <div>
            <div style={{ fontSize: 13, color: '#16A34A', marginBottom: 14 }}>✓ {t('addPurchase.done', { defaultValue: 'Added {{count}} item(s) to the stock register.', count: appliedCount })}</div>
            <button onClick={close} style={{ ...btnPrimary, width: '100%' }}>{t('addPurchase.doneBtn', 'Done')}</button>
          </div>
        )}

        {stage === 'error' && (
          <div>
            <div style={{ fontSize: 13, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: 10, marginBottom: 12 }}>{err}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setErr(null); setStage(lines.length ? 'edit' : 'choose'); }} style={{ ...btnGhost, flex: 1 }}>{t('addPurchase.back', 'Back')}</button>
              <button onClick={close} style={{ ...btnPrimary, flex: 1 }}>{t('addPurchase.close', 'Close')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modal: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', maxHeight: '90vh', overflowY: 'auto' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 };
const inputStyle: React.CSSProperties = { boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none' };
const pill: React.CSSProperties = { border: '1px solid #E2E8F0', borderRadius: 20, padding: '3px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
const btnPrimary: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#F47651', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
const btnGhost: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };

function fmtLateDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
