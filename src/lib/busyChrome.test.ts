import { describe, it, expect } from 'vitest';
import { busyChromeOn } from './busyChrome';

describe('Busy company picker + stamp placement', () => {
  it('shows on pages whose numbers come from the Busy feed', () => {
    for (const p of ['/dashboard', '/dashboard/', '/dashboard/owner', '/dashboard/working-capital', '/dashboard/sales', '/dashboard/customers', '/dashboard/anomalies']) {
      expect(busyChromeOn(p)).toEqual({ company: true, stamp: true });
    }
    expect(busyChromeOn('/dashboard/purchase/purchase', '?ctx=ops')).toEqual({ company: true, stamp: true });
  });

  it('hides where it filters nothing', () => {
    for (const p of ['/dashboard/purchase/far', '/dashboard/purchase/maint', '/dashboard/purchase/storereq', '/dashboard/purchase/activity',
      '/dashboard/batches', '/dashboard/night-manager', '/dashboard/access', '/dashboard/users', '/dashboard/todo', '/dashboard/stock',
      '/dashboard/anomaly-center', '/dashboard/cost-intelligence', '/dashboard/benchmarking']) {
      expect(busyChromeOn(p)).toEqual({ company: false, stamp: false });
    }
    expect(busyChromeOn('/dashboard/purchase/purchase')).toEqual({ company: false, stamp: false });
  });

  it('Purchase book: stamp on every tab, picker only on Purchases', () => {
    expect(busyChromeOn('/dashboard/purchase/book')).toEqual({ company: true, stamp: true });
    expect(busyChromeOn('/dashboard/purchase/book', '?tab=purchases')).toEqual({ company: true, stamp: true });
    for (const tab of ['kolkata', 'shd', 'payments', 'dispatch', 'paraffin', 'requirements']) {
      expect(busyChromeOn('/dashboard/purchase/book', `?tab=${tab}`)).toEqual({ company: false, stamp: true });
    }
  });
});
