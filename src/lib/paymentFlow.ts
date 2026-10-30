/**
 * Axis payment machine (purchase_payments, migrations 0038 + 0040).
 *
 * Six saved stages, in order:
 *   input_done          a request was entered (company, payee, amount, purpose)
 *   payment_pending     Delhi accounts checked it and queued it for approval
 *   payment_approved    management / admin approved it (never the person who entered it)
 *   payment_processing  Delhi accounts keyed it into Axis Bank
 *   payment_completed   Axis paid it
 *   busy_updated        accounts posted it in Busy — saved when a read-only Busy
 *                       match is found, or confirmed by hand with the voucher no.
 * plus `rejected` (management turned it down at the approval step).
 *
 * Old 0038 rows used entered / input_done / payment_done / busy_done, where
 * input_done meant "keyed into Axis" (before any approval). normalizeStatus()
 * reads them in the new terms; 0040 documents the matching UPDATE (not run).
 * Nothing here ever writes to Busy.
 */
export const PAYMENT_STAGES = [
  'input_done', 'payment_pending', 'payment_approved', 'payment_processing', 'payment_completed', 'busy_updated',
] as const;
export type PaymentStage = (typeof PAYMENT_STAGES)[number] | 'rejected';
export type StoredStatus = PaymentStage | 'entered' | 'payment_done' | 'busy_done';

/** Old 0038 value → stage. `input_done` is ambiguous: see `legacy`. */
export function normalizeStatus(status: string | null | undefined, legacy = false): PaymentStage {
  switch (status) {
    case 'entered': return 'input_done';
    // 0038's input_done = keyed into Axis; a new row's input_done = just entered.
    case 'input_done': return legacy ? 'payment_processing' : 'input_done';
    case 'payment_done': return 'payment_completed';
    case 'busy_done': return 'busy_updated';
    case 'payment_pending': case 'payment_approved': case 'payment_processing':
    case 'payment_completed': case 'busy_updated': case 'rejected':
      return status;
    default: return 'input_done';
  }
}

export interface PaymentActor {
  /** auth user id, compared with created_by */
  authId: string | null;
  name: string;
  admin: boolean;
  /** Delhi / other accounts role */
  accounts: boolean;
  /** management (or admin) */
  manager: boolean;
}

export interface FlowRow {
  status: string;
  created_by?: string | null;
  input_by?: string | null;
  account_no?: string | null;
  ifsc?: string | null;
  company_code?: string | null;
}

export function missingBank(row: Pick<FlowRow, 'account_no' | 'ifsc'>): boolean {
  return !(row.account_no || '').trim() || !(row.ifsc || '').trim();
}

/** Did this actor enter the row? (auth id when saved, else the typed name). */
export function isOwnRow(row: FlowRow, actor: PaymentActor): boolean {
  if (row.created_by && actor.authId) return row.created_by === actor.authId;
  const a = (row.input_by || '').trim().toLowerCase();
  return !!a && a === actor.name.trim().toLowerCase();
}

export type MoveCheck = { ok: true } | { ok: false; reason: 'role' | 'own_row' | 'missing_bank' | 'order' };

const NEXT: Record<PaymentStage, PaymentStage[]> = {
  input_done: ['payment_pending'],
  payment_pending: ['payment_approved', 'rejected'],
  payment_approved: ['payment_processing'],
  payment_processing: ['payment_completed'],
  payment_completed: ['busy_updated'],
  busy_updated: [],
  rejected: [],
};

/** Can this actor move the row to `to`? Same rules as the 0040 trigger. */
export function canMove(row: FlowRow, to: PaymentStage, actor: PaymentActor, legacy = false): MoveCheck {
  const from = normalizeStatus(row.status, legacy);
  if (!NEXT[from].includes(to)) return { ok: false, reason: 'order' };
  const acc = actor.admin || actor.accounts;
  const mgr = actor.admin || actor.manager;
  switch (to) {
    case 'payment_pending':
      return acc ? { ok: true } : { ok: false, reason: 'role' };
    case 'payment_approved':
    case 'rejected':
      if (!mgr) return { ok: false, reason: 'role' };
      return isOwnRow(row, actor) ? { ok: false, reason: 'own_row' } : { ok: true };
    case 'payment_processing':
      if (!acc) return { ok: false, reason: 'role' };
      return missingBank(row) ? { ok: false, reason: 'missing_bank' } : { ok: true };
    case 'payment_completed':
    case 'busy_updated':
      return acc || mgr ? { ok: true } : { ok: false, reason: 'role' };
    default:
      return { ok: false, reason: 'order' };
  }
}

/** The next step(s) shown as buttons for this actor. */
export function nextMoves(row: FlowRow, actor: PaymentActor, legacy = false): { to: PaymentStage; check: MoveCheck }[] {
  const from = normalizeStatus(row.status, legacy);
  return NEXT[from].map(to => ({ to, check: canMove(row, to, actor, legacy) }));
}

/** Rows per stage (all six + rejected), from the saved status. */
export function stageCounts(rows: (FlowRow & { legacy?: boolean })[]): Record<PaymentStage, number> {
  const out = Object.fromEntries([...PAYMENT_STAGES, 'rejected'].map(s => [s, 0])) as Record<PaymentStage, number>;
  for (const r of rows) out[normalizeStatus(r.status, r.legacy)] += 1;
  return out;
}

/**
 * Saved statuses a payment can still be in before Busy shows it (all six
 * stages' open part + the 0038 names). "Updated in Busy" and "Rejected" are not.
 */
export const BUSY_OPEN_STATUSES = [
  'entered', 'input_done', 'payment_pending', 'payment_approved', 'payment_processing', 'payment_completed', 'payment_done',
] as const;

/**
 * Payments the read-only Busy feed already shows as paid, not saved as such
 * yet → persist busy_updated + voucher. From ANY open stage (Sidak, 29 Oct
 * 2026: Busy was paid before Axis was walked through). Never a rejected row,
 * never one already updated. The caller supplies the matcher (per company feed).
 */
export function busyUpdatesToSave<R extends FlowRow & { id: string }>(
  rows: R[],
  match: (row: R) => string | null,
): { id: string; voucher: string }[] {
  const out: { id: string; voucher: string }[] = [];
  for (const r of rows) {
    if (!(BUSY_OPEN_STATUSES as readonly string[]).includes(r.status ?? '')) continue;
    const voucher = match(r);
    if (voucher) out.push({ id: r.id, voucher });
  }
  return out;
}
