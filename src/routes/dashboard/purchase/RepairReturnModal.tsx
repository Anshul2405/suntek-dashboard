import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../../lib/supabase';
// Shared humanizer — a user should never be shown a raw error object.
import { humanizeError as errMsg } from '../../../lib/errors';
import { usePlantScope } from '../../../contexts/PlantScopeContext';
import { callRpc } from '../../../lib/db';
import { uploadWorkflowFile } from '../../../lib/cloudinary';
import { useRoleContext } from '../../../contexts/RoleContext';
import { matchCandidates, type StockLite } from '../../../lib/store/purchaseParse';
import type { Database } from '../../../lib/database.types';
import { istToday } from '../../../lib/utils/formatting';

type TicketRow = Database['public']['Tables']['maintenance_tickets']['Row'] & { plants?: { name: string | null } | null };
type DefectivePartRow = Database['public']['Tables']['maintenance_defective_parts']['Row'];

/** Units of this part line still awaiting return from the vendor. */
function partPending(p: DefectivePartRow): number {
  return Math.max(0, Number(p.repair_qty) - Number(p.repair_returned_qty));
}

interface AllocDraft {
  part: DefectivePartRow;
  ticket: TicketRow | undefined;
  include: boolean;
  qty: string;
  itemName: string;
  choice: string;          // store_item id or 'new'
}

/**
 * Return repaired parts to inventory. One submission = ONE physical return
 * receipt (vendor + invoice + bill file) allocated across one or more open
 * repair tickets of the same plant — the "vendor returned both batches on a
 * single invoice" case. Applied atomically + idempotently by the
 * apply_repair_return RPC; repaired units land in the register's SEPARATE
 * repaired-stock bucket. Scrap tickets are rejected server-side.
 */
export function RepairReturnModal({ open, focusPart, parts, tickets, onClose, onSaved }: {
  open: boolean;
  /** The part line whose button opened the modal — preselected. */
  focusPart: DefectivePartRow | null;
  /** Every replaced part line; the modal filters to the focus plant + pending>0. */
  parts: DefectivePartRow[];
  /** Tickets, for showing each part's equipment + ticket reference. */
  tickets: TicketRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { storeIdFor } = usePlantScope();
  const { activeProfile } = useRoleContext();

  const ticketById = useMemo(() => new Map(tickets.map(tk => [tk.id, tk])), [tickets]);
  const plantId = focusPart?.plant_id ?? null;
  const plantName = ticketById.get(focusPart?.ticket_id ?? '')?.plants?.name ?? '';

  const [allocs, setAllocs] = useState<AllocDraft[]>([]);
  const [stock, setStock] = useState<(StockLite & { plant_id: string | null })[]>([]);
  const [vendor, setVendor] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [returnDate, setReturnDate] = useState(istToday());
  const [repairCost, setRepairCost] = useState('');
  const [conditionNote, setConditionNote] = useState('');
  const [comment, setComment] = useState('');
  const [billFile, setBillFile] = useState<File | null>(null);
  const [dupInvoice, setDupInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string>(() => crypto.randomUUID());
  const fileRef = useRef<HTMLInputElement>(null);

  // (Re)build the allocation drafts each time the modal opens on a part line.
  useEffect(() => {
    if (!open || !focusPart) return;
    // Every part line at this plant that still has repaired units outstanding —
    // so several batches can be settled on one vendor invoice.
    const eligible = parts.filter(p =>
      p.plant_id === focusPart.plant_id &&
      Number(p.repair_qty) > 0 &&
      partPending(p) > 0);
    setAllocs(eligible.map(p => ({
      part: p,
      ticket: ticketById.get(p.ticket_id),
      include: p.id === focusPart.id,
      qty: String(partPending(p)),
      itemName: (p.part_name || '').trim(),
      choice: 'new',
    })));
    setVendor(''); setInvoiceNo(''); setReturnDate(istToday());
    setRepairCost(''); setConditionNote(''); setComment('');
    setBillFile(null); setErr(null); setDupInvoice(false);
    setReceiptId(crypto.randomUUID());
    // Load the register this factory draws from, for fuzzy item matching.
    // Keyed on the STORE: a repaired part returns to the shared Rehla register,
    // so matching it against only its own factory's slice would miss the row
    // that actually holds the item and create a duplicate.
    (async () => {
      const storeId = storeIdFor(focusPart.plant_id as string);
      const q = supabase.from('store_items').select('id, item_name, on_hand, unit, plant_id, store_id');
      const { data: si } = await (storeId ? q.eq('store_id', storeId) : q.eq('plant_id', focusPart.plant_id as string))
        .returns<(StockLite & { plant_id: string | null })[]>();
      const rows = si || [];
      setStock(rows);
      // Auto-pick the best register match per part (user can override).
      setAllocs(prev => prev.map(a => {
        const c = matchCandidates(a.itemName, rows);
        return { ...a, choice: c[0] && c[0].score >= 0.6 ? c[0].id : 'new' };
      }));
    })();
  }, [open, focusPart?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Soft duplicate-invoice warning (same plant + invoice no) — never blocks.
  useEffect(() => {
    const inv = invoiceNo.trim();
    if (!open || !inv || !plantId) { setDupInvoice(false); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const { data } = await supabase.from('repair_return_receipts')
          .select('id').eq('plant_id', plantId).eq('invoice_no', inv).neq('id', receiptId).limit(1)
          .returns<{ id: string }[]>();
        if (alive) setDupInvoice(!!data?.length);
      } catch { if (alive) setDupInvoice(false); }
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [open, invoiceNo, plantId, receiptId]);

  const included = allocs.filter(a => a.include);
  const totalQty = included.reduce((s, a) => s + (Number(a.qty) || 0), 0);

  const canSubmit = useMemo(() =>
    included.length > 0 && comment.trim() !== '' &&
    included.every(a => {
      const q = Number(a.qty);
      return Number.isFinite(q) && q > 0 && q <= partPending(a.part) && a.itemName.trim() !== '';
    }), [included, comment]);

  if (!open || !focusPart) return null;

  function patchAlloc(id: string, patch: Partial<AllocDraft>) {
    setAllocs(prev => prev.map(a => a.part.id === id ? { ...a, ...patch } : a));
  }

  function friendly(raw: string): string {
    if (/over_return/i.test(raw)) return t('repairReturn.errOverReturn', 'Returned quantity exceeds what is still pending on one of the tickets — refresh and try again.');
    if (/not_repair/i.test(raw)) return t('repairReturn.errNotRepair', 'One of the selected tickets is not a repair ticket (scrap can never be returned to stock).');
    if (/comment_required/i.test(raw)) return t('repairReturn.errComment', 'A comment is required for every repair return.');
    if (/PGRST202|Could not find the function|schema cache/i.test(raw)) return t('repairReturn.errMigration', 'The repair-return service is not installed yet — run migration 55_repair_returns.sql in Supabase, then retry.');
    if (/forbidden: missing capability/i.test(raw)) return t('repairReturn.errForbidden', 'You do not have permission to return repaired items. Ask an admin for the "Return repaired items" allowance.');
    if (/forbidden: plant out of scope/i.test(raw)) return t('repairReturn.errScope', 'This plant is outside your data scope.');
    if (/not_authenticated/i.test(raw)) return t('repairReturn.errAuth', 'Your session has expired — sign in again.');
    return raw;
  }

  async function save() {
    if (!comment.trim()) { setErr(t('repairReturn.errComment', 'A comment is required for every repair return.')); return; }
    if (!included.length) { setErr(t('repairReturn.errNone', 'Select at least one repair batch to return.')); return; }
    for (const a of included) {
      const q = Number(a.qty);
      if (!Number.isFinite(q) || q <= 0) { setErr(t('repairReturn.errQtyPart', { defaultValue: '{{part}}: quantity must be greater than 0.', part: a.part.part_name })); return; }
      if (q > partPending(a.part)) { setErr(t('repairReturn.errPendingPart', { defaultValue: '{{part}}: only {{pending}} unit(s) still pending — cannot return {{q}}.', part: a.part.part_name, pending: partPending(a.part), q })); return; }
      if (!a.itemName.trim()) { setErr(t('repairReturn.errItemPart', { defaultValue: '{{part}}: pick the stock item these units belong to.', part: a.part.part_name })); return; }
    }
    const costN = repairCost.trim() === '' ? null : Number(repairCost);
    if (costN != null && (!Number.isFinite(costN) || costN < 0)) { setErr(t('repairReturn.errCost', 'Repair cost must be a number ≥ 0.')); return; }
    setSaving(true); setErr(null);
    try {
      // Bill upload is best-effort and OPTIONAL — but if a file was chosen and
      // the upload fails, stop rather than silently dropping the attachment.
      let invoiceUrl: string | null = null;
      if (billFile) {
        const up = await uploadWorkflowFile(billFile, { workflow: 'store-req', subfolder: 'repair-returns', kind: 'repair-bill', creator: activeProfile.name });
        invoiceUrl = up.secure_url;
      }
      const { error } = await callRpc('apply_repair_return', {
        payload: {
          id: receiptId,
          plant_id: plantId,
          vendor_name: vendor.trim() || null,
          invoice_no: invoiceNo.trim() || null,
          invoice_url: invoiceUrl,
          return_date: returnDate || null,
          comment: comment.trim(),
          repair_cost: costN,
          condition_note: conditionNote.trim() || null,
          actor_name: activeProfile.name,
          // Send BOTH keys so the payload works against either RPC version:
          // migration 55 settles by ticket_id, 56 by defective_part_id and
          // ignores the other. Without this the modal breaks on any database
          // where 56 hasn't been run yet. `legacy:` ids are the synthetic rows
          // the panel derives when the parts table is absent — never real uuids.
          allocations: included.map(a => ({
            ticket_id: a.part.ticket_id,
            defective_part_id: a.part.id.startsWith('legacy:') ? null : a.part.id,
            qty: Number(a.qty),
            item_name: a.itemName.trim(),
            store_item_id: a.choice !== 'new' ? a.choice : null,
          })),
        },
      });
      if (error) throw new Error(friendly(error.message || ''));
      onSaved();
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlay} onClick={() => { if (!saving) onClose(); }}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{t('repairReturn.title', 'Return repaired items to inventory')}</div>
            <div style={{ fontSize: 12, color: '#94A3B8' }}>{plantName} · {t('repairReturn.subtitle', 'one receipt can settle several repair batches (single invoice)')}</div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#94A3B8' }}>×</button>
        </div>

        {/* ── Batch allocation ──────────────────────────────────────────────── */}
        <div style={{ ...label, marginTop: 10 }}>{t('repairReturn.batches', 'Open repair batches at this plant')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 6 }}>
          {allocs.map(a => {
            const pending = partPending(a.part);
            const cands = matchCandidates(a.itemName, stock);
            const chosen = a.choice !== 'new' ? stock.find(s => s.id === a.choice) : null;
            const qtyN = Number(a.qty) || 0;
            const overQty = a.include && qtyN > pending;
            return (
              <div key={a.part.id} style={{ border: `1px solid ${a.include ? '#BBF7D0' : '#E2E8F0'}`, background: a.include ? '#F0FDF4' : '#fff', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', flex: 1, minWidth: 220 }}>
                    <input type="checkbox" checked={a.include} onChange={e => patchAlloc(a.part.id, { include: e.target.checked })} />
                    <span style={{ fontSize: 12.5 }}>
                      <strong style={{ color: '#334155' }}>{a.part.part_name}</strong>
                      <span style={{ color: '#64748B' }}> · {a.ticket?.equipment ?? ''}</span>
                      <span style={{ color: '#2563EB', fontWeight: 600 }}> #{a.part.ticket_id.slice(0, 8)}</span>
                      <span style={{ color: '#64748B' }}> · {t('repairReturn.sent', 'sent')} {Number(a.part.repair_qty)} · {t('repairReturn.returned', 'returned')} {Number(a.part.repair_returned_qty)} · <strong>{pending} {t('repairReturn.pending', 'pending')}</strong></span>
                    </span>
                  </label>
                  {a.include && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      {t('repairReturn.returnNow', 'return now')}
                      <input type="number" min="0.01" step="any" value={a.qty} onChange={e => patchAlloc(a.part.id, { qty: e.target.value })}
                        style={{ ...inputStyle, width: 72, ...(overQty ? { borderColor: '#DC2626' } : {}) }} />
                    </span>
                  )}
                </div>
                {a.include && overQty && (
                  <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 4 }}>{t('repairReturn.overWarn', { defaultValue: 'Only {{pending}} unit(s) pending on this batch.', pending })}</div>
                )}
                {a.include && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 10.5, color: '#94A3B8', textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap' }}>{t('repairReturn.stockItem', 'Stock item')}</span>
                      <input value={a.itemName} onChange={e => patchAlloc(a.part.id, { itemName: e.target.value, choice: (() => { const c = matchCandidates(e.target.value, stock); return c[0] && c[0].score >= 0.6 ? c[0].id : 'new'; })() })}
                        style={{ ...inputStyle, flex: 1 }} placeholder={t('repairReturn.itemPh', 'item name in the register')} />
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                      {cands.map(c => (
                        <button key={c.id} onClick={() => patchAlloc(a.part.id, { choice: c.id })}
                          style={{ ...pill, borderColor: a.choice === c.id ? '#16A34A' : '#E2E8F0', background: a.choice === c.id ? '#F0FDF4' : '#fff', color: a.choice === c.id ? '#16A34A' : '#475569' }}>
                          {c.item_name} · {c.on_hand}
                        </button>
                      ))}
                      <button onClick={() => patchAlloc(a.part.id, { choice: 'new' })}
                        style={{ ...pill, borderColor: a.choice === 'new' ? '#7C3AED' : '#E2E8F0', background: a.choice === 'new' ? '#FAF5FF' : '#fff', color: a.choice === 'new' ? '#7C3AED' : '#475569' }}>
                        ＋ {t('repairReturn.createNew', 'Create new')}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: '#64748B', marginTop: 4 }}>
                      {chosen
                        ? <>→ <strong>{chosen.item_name}</strong> {t('repairReturn.repairedPlus', 'repaired stock')} +{qtyN}</>
                        : <>→ {t('repairReturn.newItem', 'new register item')} <strong>{a.itemName || '—'}</strong> ({t('repairReturn.repairedPlus', 'repaired stock')} +{qtyN})</>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 12, color: '#334155', marginBottom: 12 }}>
          {t('repairReturn.totalNow', 'Total returning now')}: <strong>{totalQty}</strong> · {included.length} {t('repairReturn.batchesSel', 'batch(es)')}
        </div>

        {/* ── Receipt details ───────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 10 }}>
          <div>
            <div style={label}>{t('repairReturn.vendor', 'Repair vendor (optional)')}</div>
            <input value={vendor} onChange={e => setVendor(e.target.value)} placeholder={t('repairReturn.vendorPh', 'third-party workshop')} style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <div style={label}>{t('repairReturn.invoiceNo', 'Invoice no. (optional)')}</div>
            <input value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} placeholder="INV-000" style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <div style={label}>{t('repairReturn.date', 'Return date')}</div>
            <input type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <div style={label}>{t('repairReturn.cost', 'Repair cost ₹ (optional)')}</div>
            <input type="number" min="0" step="0.01" value={repairCost} onChange={e => setRepairCost(e.target.value)} placeholder="0.00" style={{ ...inputStyle, width: '100%' }} />
          </div>
        </div>
        {dupInvoice && (
          <div style={{ fontSize: 11.5, color: '#B45309', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '6px 8px', marginBottom: 10 }}>
            ⚠ {t('repairReturn.dupInvoice', 'A repair return with this invoice number already exists for this plant — double-check before saving (saving anyway is allowed).')}
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <div style={label}>{t('repairReturn.bill', 'Invoice / bill file (optional — PDF, JPG, PNG)')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => fileRef.current?.click()} style={{ ...btnGhost, padding: '7px 12px', fontSize: 12 }}>
              {billFile ? `📎 ${billFile.name}` : t('repairReturn.attach', 'Attach file')}
            </button>
            {billFile && <button onClick={() => setBillFile(null)} style={{ border: 'none', background: 'none', color: '#DC2626', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>{t('repairReturn.remove', 'remove')}</button>}
            <input ref={fileRef} type="file" accept="image/jpeg,image/jpg,image/png,application/pdf" style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0]; e.target.value = '';
                if (!f) return;
                if (f.size > 15 * 1024 * 1024) { setErr(t('repairReturn.errFileSize', 'File is too large — 15 MB max.')); return; }
                setErr(null); setBillFile(f);
              }} />
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={label}>{t('repairReturn.condition', 'Condition / quality note (optional)')}</div>
          <input value={conditionNote} onChange={e => setConditionNote(e.target.value)} placeholder={t('repairReturn.conditionPh', 'e.g. tested OK, minor wear')} style={{ ...inputStyle, width: '100%' }} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={label}>{t('repairReturn.comment', 'Comment (required)')} *</div>
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2}
            placeholder={t('repairReturn.commentPh', 'e.g. received from vendor, verified count at the store gate')}
            style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
        </div>

        {err && <div style={{ fontSize: 12.5, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={btnGhost}>{t('repairReturn.cancel', 'Cancel')}</button>
          <button onClick={save} disabled={saving || !canSubmit} style={{ ...btnPrimary, flex: 1, opacity: saving || !canSubmit ? 0.6 : 1 }}>
            {saving ? t('repairReturn.saving', 'Adding to inventory…') : t('repairReturn.save', { defaultValue: 'Add {{qty}} unit(s) to inventory', qty: totalQty })}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modal: React.CSSProperties = { background: '#fff', borderRadius: 16, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', maxHeight: '90vh', overflowY: 'auto', width: 'min(680px, 100%)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', marginBottom: 4 };
const inputStyle: React.CSSProperties = { boxSizing: 'border-box', border: '1px solid #E2E8F0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none' };
const pill: React.CSSProperties = { border: '1px solid #E2E8F0', borderRadius: 20, padding: '3px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
const btnPrimary: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#F47651', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
const btnGhost: React.CSSProperties = { padding: '10px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
