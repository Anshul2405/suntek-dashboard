/**
 * Smoke: the Purchase book page with real rights logic (lib/access/rights) and
 * the real workbook, Busy calls mocked. No login needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { allowedTabs, BOOK_ROUTE } from '../../../lib/access/rights';
import { DEFAULT_OPS, type OpsSettings } from '../../../lib/opsControls';
import type { MockProfile } from '../../../lib/profiles';

const state: { ops: OpsSettings; profile: MockProfile } = {
  ops: { ...DEFAULT_OPS, loaded: true, enforced: true },
  profile: { id: 'db_sp', name: 'SalesPoint', role: 'L3', roleLabel: 'Sales', roleDescription: '', initials: 'SP', allowedDashboardRoutes: [BOOK_ROUTE], roleIds: ['sales'] } as unknown as MockProfile,
};

vi.mock('../../../lib/access/useRights', () => ({
  useRights: () => ({
    loaded: state.ops.loaded,
    tabs: (route: string) => allowedTabs(state.ops, state.profile, state.profile.id, route),
    canSeeTab: () => true,
    can: () => false,
    backDays: () => 2,
  }),
}));
vi.mock('../../../hooks/useBusyData', () => ({ fmtINR: (n: number) => `₹${n}`, useOverviewKPIs: () => ({ data: null }) }));
vi.mock('../../../components/BusyPurchasesCard', () => ({ BusyPurchasesCard: () => null }));
vi.mock('./DispatchLog', () => ({ DispatchLog: () => <div>dispatch-live</div> }));
vi.mock('./BookPayments', () => ({ BookPayments: () => <div>payments-live</div> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: unknown) => (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue ?? _k) }) }));

const { PurchaseBookPage } = await import('./PurchaseBook');

const open = (url: string) => {
  window.history.replaceState(null, '', url);
  return render(<BrowserRouter><PurchaseBookPage /></BrowserRouter>);
};

describe('Purchase book page (smoke)', () => {
  beforeEach(() => { state.ops = { ...DEFAULT_OPS, loaded: true, enforced: true }; });

  it('an unconfigured role sees all seven chips — release does not blank the book', async () => {
    open('/dashboard/purchase/book');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(7));
    expect(screen.getByRole('tab', { name: /NKG · Kolkata/ })).toBeTruthy();
  });

  it('a saved Purchases + Payments + Paraffin list: three chips, ?tab=dispatch goes to Purchases', async () => {
    state.ops = { ...state.ops, tabs: { [BOOK_ROUTE]: { purchases: ['sales'], payments: ['sales'], paraffin: ['sales'] } } };
    open('/dashboard/purchase/book?tab=dispatch');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));
    await waitFor(() => expect(window.location.search).toContain('tab=purchases'));
    expect(screen.queryByText('dispatch-live')).toBeNull();
  });

  it('before the saved rights load: no tabs for a non-admin', () => {
    state.ops = { ...state.ops, loaded: false };
    open('/dashboard/purchase/book');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});
