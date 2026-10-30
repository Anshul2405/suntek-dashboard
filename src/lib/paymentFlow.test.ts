import { describe, it, expect } from 'vitest';
import { busyUpdatesToSave, canMove, missingBank, nextMoves, normalizeStatus, stageCounts, type PaymentActor } from './paymentFlow';

const actor = (over: Partial<PaymentActor>): PaymentActor => ({ authId: 'me', name: 'Me', admin: false, accounts: false, manager: false, ...over });
const accounts = actor({ authId: 'acc', name: 'Shivanand', accounts: true });
const manager = actor({ authId: 'mgr', name: 'Vijay', manager: true });
const bank = { account_no: '123456789', ifsc: 'UTIB0000001' };

describe('payment stages', () => {
  it('maps the old four statuses onto the six', () => {
    expect(normalizeStatus('entered')).toBe('input_done');
    expect(normalizeStatus('input_done', true)).toBe('payment_processing'); // 0038: keyed into Axis
    expect(normalizeStatus('input_done')).toBe('input_done');
    expect(normalizeStatus('payment_done')).toBe('payment_completed');
    expect(normalizeStatus('busy_done')).toBe('busy_updated');
  });

  it('walks the six stages in order with the right people', () => {
    const row = { status: 'input_done', created_by: 'req', input_by: 'Requester', ...bank };
    expect(canMove(row, 'payment_pending', accounts)).toEqual({ ok: true });
    expect(canMove(row, 'payment_pending', manager)).toEqual({ ok: false, reason: 'role' });
    expect(canMove(row, 'payment_approved', manager)).toEqual({ ok: false, reason: 'order' });
    expect(canMove({ ...row, status: 'payment_pending' }, 'payment_approved', manager)).toEqual({ ok: true });
    expect(canMove({ ...row, status: 'payment_pending' }, 'payment_approved', accounts)).toEqual({ ok: false, reason: 'role' });
    expect(canMove({ ...row, status: 'payment_approved' }, 'payment_processing', accounts)).toEqual({ ok: true });
    expect(canMove({ ...row, status: 'payment_processing' }, 'payment_completed', accounts)).toEqual({ ok: true });
    expect(canMove({ ...row, status: 'payment_completed' }, 'busy_updated', manager)).toEqual({ ok: true });
    expect(nextMoves({ ...row, status: 'busy_updated' }, manager)).toEqual([]);
  });

  it('the person who entered a payment cannot approve it', () => {
    const own = { status: 'payment_pending', created_by: 'mgr', input_by: 'Vijay', ...bank };
    expect(canMove(own, 'payment_approved', manager)).toEqual({ ok: false, reason: 'own_row' });
    expect(canMove({ ...own, created_by: null }, 'rejected', manager)).toEqual({ ok: false, reason: 'own_row' });
  });

  it('no Axis processing without account number and IFSC', () => {
    const noBank = { status: 'payment_approved', account_no: '', ifsc: null };
    expect(missingBank(noBank)).toBe(true);
    expect(canMove(noBank, 'payment_processing', accounts)).toEqual({ ok: false, reason: 'missing_bank' });
  });

  it('counts rows per saved stage', () => {
    const c = stageCounts([{ status: 'entered' }, { status: 'payment_pending' }, { status: 'busy_done' }, { status: 'rejected' }]);
    expect(c.input_done).toBe(1);
    expect(c.payment_pending).toBe(1);
    expect(c.busy_updated).toBe(1);
    expect(c.rejected).toBe(1);
  });

  it('persists a Busy match from any open stage; never rejected or already updated', () => {
    const rows = [
      { id: 'pending', status: 'payment_pending' },
      { id: 'completed', status: 'payment_completed' },
      { id: 'input', status: 'input_done' },
      { id: 'approved', status: 'payment_approved' },
      { id: 'legacy', status: 'payment_done' },
      { id: 'done', status: 'busy_updated' },
      { id: 'rejected', status: 'rejected' },
      { id: 'nomatch', status: 'payment_pending' },
    ];
    const saved = busyUpdatesToSave(rows, r => (r.id === 'nomatch' ? null : `PV/${r.id}`));
    expect(saved.map(s => s.id)).toEqual(['pending', 'completed', 'input', 'approved', 'legacy']);
    expect(saved[0]).toEqual({ id: 'pending', voucher: 'PV/pending' });
  });
});
