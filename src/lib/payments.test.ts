import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import { findBusyPayment, fmtINRFull, inPayWindow, maskAccount, parseFeedAmount } from './payments';
import type { Movement } from '../hooks/useBusyData';

const mv = (title: string, amt: string, type: Movement['type'] = 'purchase', date?: string, sub = 'PV/1'): Movement =>
  ({ type, title, sub, amt, col: '#DC2626', when: '27 Oct', date });

describe('payments', () => {
  it('masks account numbers to the last four digits', () => {
    expect(maskAccount('9120 1000 4567 8812')).toBe('••••8812');
    expect(maskAccount('123')).toBe('123');
    expect(maskAccount(null)).toBe('');
  });

  it('reads the Busy feed amount with its rounding', () => {
    expect(parseFeedAmount('-₹56,124')).toEqual({ value: 56124, tolerance: 1 });
    expect(parseFeedAmount('-₹1.2 L')!.value).toBeCloseTo(120000);
    expect(parseFeedAmount('-₹2.15 Cr')!.value).toBeCloseTo(21500000);
    expect(parseFeedAmount('—')).toBeNull();
  });

  it('ticks a payment only from a matching Busy payment voucher', () => {
    const feed = [
      mv('Purchase Invoice · Ravi Kumar', '-₹56,124'),
      mv('Payment Voucher · Ravi Kumar Transport', '-₹56,124'),
    ];
    expect(findBusyPayment({ beneficiary: 'Ravi Kumar', amount: 56124 }, feed)?.title).toBe('Payment Voucher · Ravi Kumar Transport');
    expect(findBusyPayment({ beneficiary: 'Ravi Kumar', amount: 56000 }, feed)).toBeNull();
    expect(findBusyPayment({ beneficiary: 'Sunil Traders', amount: 56124 }, feed)).toBeNull();
    expect(findBusyPayment({ beneficiary: 'Kutch Chemical', amount: 118000 }, [mv('Payment Voucher · Kutch Chemical Industries Ltd', '-₹1.2 L')])).not.toBeNull();
  });

  it('Adani today: the live feed has only "Payment Voucher · Unknown" and no ₹6.8 L → no match (never green on a guess)', () => {
    // Live 0009 payment vouchers 27–30 Oct 2026, as the feed sends them.
    const feed0009 = [
      mv('Payment Voucher · Unknown', '-₹3,063', 'purchase', '2026-10-30', '1635'),
      mv('Payment Voucher · Unknown', '-₹71.7 L', 'purchase', '2026-10-30', '1491'),
      mv('Payment Voucher · Unknown', '-₹3,540', 'purchase', '2026-10-29', '1631'),
      mv('Payment Voucher · Unknown', '-₹59.6 L', 'purchase', '2026-10-28', '1629'),
      mv('Payment Voucher · Unknown', '-₹57,478', 'purchase', '2026-10-28', '1630'),
      mv('Payment Voucher · Unknown', '-₹8.0 L', 'purchase', '2026-10-27', '1620'),
    ];
    expect(findBusyPayment({ beneficiary: 'Adani Hazira Port Limited', amount: 678767, pay_date: '2026-10-28' }, feed0009)).toBeNull();
  });

  it('a named party + rounded lakh amount the next morning matches (when the PC sends names)', () => {
    const feed = [mv('Payment Voucher · Adani Hazira Port Limited', '-₹6.8 L', 'purchase', '2026-10-29', 'PV/1702')];
    expect(findBusyPayment({ beneficiary: 'Adani Hazira Port Limited', amount: 678767, pay_date: '2026-10-28' }, feed)?.sub).toBe('PV/1702');
    // Outside the window (a week later) → no.
    expect(findBusyPayment({ beneficiary: 'Adani Hazira Port Limited', amount: 678767, pay_date: '2026-10-20' }, feed)).toBeNull();
  });

  it('"Unknown" party: the only voucher in the window whose amount hits (exact or unique ₹6.8 L)', () => {
    const one = [mv('Payment Voucher · Unknown', '-₹57,478', 'purchase', '2026-10-28', '1630')];
    expect(findBusyPayment({ beneficiary: 'Any Party', amount: 57478, pay_date: '2026-10-28' }, one)?.sub).toBe('1630');
    const two = [...one, mv('Payment Voucher · Unknown', '-₹57,478', 'purchase', '2026-10-29', '1640')];
    expect(findBusyPayment({ beneficiary: 'Any Party', amount: 57478, pay_date: '2026-10-28' }, two)).toBeNull();
    // Rahul's Adani voucher: feed still says Unknown, amount ₹6.8 L / ₹6,80,000 vs dashboard ₹6,78,767.
    const rounded = [mv('Payment Voucher · Unknown', '-₹6.8 L', 'purchase', '2026-10-28', '1638')];
    expect(findBusyPayment({ beneficiary: 'Adani Hazira Port Limited', amount: 678767, pay_date: '2026-10-28' }, rounded)?.sub).toBe('1638');
    const exactBusy = [mv('Payment Voucher · Unknown', '-₹6,80,000', 'purchase', '2026-10-28', '1638')];
    expect(findBusyPayment({ beneficiary: 'Adani Hazira Port Limited', amount: 678767, pay_date: '2026-10-28' }, exactBusy)?.sub).toBe('1638');
    const twoLakhs = [
      mv('Payment Voucher · Unknown', '-₹6.8 L', 'purchase', '2026-10-28', '1638'),
      mv('Payment Voucher · Unknown', '-₹6.8 L', 'purchase', '2026-10-29', '1640'),
    ];
    expect(findBusyPayment({ beneficiary: 'Adani Hazira Port Limited', amount: 678767, pay_date: '2026-10-28' }, twoLakhs)).toBeNull();
    expect(findBusyPayment({ beneficiary: 'Any Party', amount: 55000, pay_date: '2026-10-28' }, one)).toBeNull();
  });

  it('a "payment" type from a newer reader is accepted too; receipts never', () => {
    expect(findBusyPayment({ beneficiary: 'Ravi Kumar', amount: 56124 }, [mv('Payment Voucher · Ravi Kumar', '-₹56,124', 'payment' as Movement['type'])])).not.toBeNull();
    expect(findBusyPayment({ beneficiary: 'Ravi Kumar', amount: 56124 }, [mv('Receipt Voucher · Ravi Kumar', '+₹56,124', 'sales')])).toBeNull();
  });

  it('pay-date window: day before to three days after', () => {
    expect(inPayWindow('2026-10-29', '2026-10-28')).toBe(true);
    expect(inPayWindow('2026-10-27', '2026-10-28')).toBe(true);
    expect(inPayWindow('2026-10-26', '2026-10-28')).toBe(false);
    expect(inPayWindow('2026-11-01', '2026-10-28')).toBe(false);
  });

  it('full Indian amount on the table: 680000 → ₹ 6,80,000 (not ₹ 6.8 L)', () => {
    expect(fmtINRFull(680000)).toBe('₹ 6,80,000');
    expect(fmtINRFull(678767)).toBe('₹ 6,78,767');
    expect(fmtINRFull('678767.50')).toBe('₹ 6,78,767.50');
    expect(fmtINRFull(null)).toBe('—');
  });
});
