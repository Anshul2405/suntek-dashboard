import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import { findBusyPayment, maskAccount, parseFeedAmount } from './payments';
import type { Movement } from '../hooks/useBusyData';

const mv = (title: string, amt: string, type: Movement['type'] = 'purchase'): Movement =>
  ({ type, title, sub: 'PV/1', amt, col: '#DC2626', when: '27 Oct' });

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
});
