import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
vi.mock('../hooks/useBusyData', () => ({ fetchBusy: vi.fn() }));

import { payeesFromFeeds } from './busyPayees';

describe('payees from the Busy feed', () => {
  it('merges suppliers, vendors and payment-voucher parties, one entry each', () => {
    const list = payeesFromFeeds(
      [{ supplier: 'Grasim Industries Ltd' }, { supplier: 'Kutch Chemical · Chlorides' }],
      [{ name: 'Grasim Industries Ltd' }],
      [
        { type: 'purchase', title: 'Payment Voucher · Ravi Kumar' },
        { type: 'purchase', title: 'Purchase Invoice · Sidhe Petrochemicals' },
        { type: 'sales', title: 'Payment Voucher · Not a payee' },
        { type: 'purchase', title: 'Payment Voucher · Unknown' },
      ],
    );
    expect(list.map(p => p.name)).toEqual(['Grasim Industries Ltd', 'Kutch Chemical', 'Ravi Kumar']);
    expect(list[0].sources).toEqual(['purchases', 'vendors']);
    expect(list[2].sources).toEqual(['payments']);
  });

  it('an empty feed gives an empty list (no invented payees)', () => {
    expect(payeesFromFeeds(null, undefined, [])).toEqual([]);
  });
});
