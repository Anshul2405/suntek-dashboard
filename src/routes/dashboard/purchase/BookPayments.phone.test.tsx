/**
 * Phone smoke (390px): Payments shows one card per payment with the full rupee
 * figure, the desktop one-line table is kept for ≥768px only, and New payment
 * is one column in the agreed order with the date box. Data is mocked; nothing
 * is saved.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import type { PaymentRow } from '../../../lib/payments';

const ADANI = {
  id: 'p1', pay_date: '2026-10-28', beneficiary: 'Adani Hazira Port Limited', account_no: '000000003903', ifsc: 'SBIN3432423', bank: 'SBI',
  amount: 678767, input_by: 'Sagar Nenwani', status: 'payment_pending', flow_version: 2, company_code: '0009', purpose: 'Monthly Rental',
  payee_source: 'busy', created_at: '2026-10-28T10:09:52Z', pending_at: '2026-10-28T10:10:16Z', pending_by: 'Sagar Nenwani', plant_id: null,
} as unknown as PaymentRow;

vi.mock('../../../lib/fetchAll', () => ({ fetchAllRows: async () => ({ data: [ADANI], error: null }) }));
vi.mock('../../../lib/supabase', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../../lib/db', () => ({ insertRows: vi.fn(), updateRows: vi.fn() }));
vi.mock('../../../lib/activityWrite', () => ({ logActivity: vi.fn() }));
vi.mock('../../../lib/opsControls', () => ({ ensureLateApproval: vi.fn(async () => true) }));
vi.mock('../../../components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('../../../contexts/RoleContext', () => ({
  useRoleContext: () => ({ activeProfile: { id: 'admin', name: 'Owner', role: 'L0', roleIds: ['admin'], allowedDashboardRoutes: ['*'], isAdmin: true } }),
}));
vi.mock('../../../lib/profiles', () => ({ isAdminProfile: () => true }));
vi.mock('../../../contexts/PlantScopeContext', () => ({
  usePlantScope: () => ({ allowedPlants: [], ready: true, isGlobal: true, inScope: () => true, plants: [] }),
}));
vi.mock('../../../lib/schemaProbe', () => ({ useColumnLive: () => true }));
vi.mock('../../../lib/useMyIdentity', () => ({ useMyIdentity: () => ({ authUserId: 'u1' }) }));
vi.mock('../../../lib/busyPayees', () => ({
  useBusyPayees: () => ({ data: [], isLoading: false }),
  useBusyMovementsByCompany: () => ({ data: {} }),
}));
vi.mock('../../../lib/access/useRights', () => ({
  useRights: () => ({ loaded: true, can: () => true, tabs: () => [], canSeeTab: () => true, backDays: () => 30 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: unknown) => (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue ?? _k) }) }));

const { BookPayments } = await import('./BookPayments');

describe('Payments on a phone (390px)', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    window.history.replaceState(null, '', '/dashboard/purchase/book?tab=payments');
  });

  it('a card per payment with the full amount (₹ 6,78,767, never "L"); the table is desktop-only', async () => {
    render(<BrowserRouter><BookPayments /></BrowserRouter>);
    const card = await screen.findByTestId('payment-card');
    expect(within(card).getByTestId('payment-card-amount').textContent).toBe('₹ 6,78,767');
    expect(card.textContent).not.toMatch(/\d\s*L\b/);
    expect(card.textContent).toContain('Adani Hazira Port Limited');
    expect(card.textContent).toContain('IFSC ✗');
    // Cards below 1024px, the one-line table from 1024px (desktop 1280/1440 unchanged).
    expect(screen.getByTestId('payment-cards').className).toMatch(/\blg:hidden\b/);
    const table = document.querySelector('table.dt2-tight')!;
    expect(table.parentElement!.className).toMatch(/\bmax-lg:hidden\b/);
    expect(within(table as HTMLElement).getByText('₹ 6,78,767')).toBeTruthy();
  });

  it('New payment: company → payee → amount → purpose → date → plant → bank, date box present, Save after the fields', async () => {
    render(<BrowserRouter><BookPayments /></BrowserRouter>);
    await screen.findAllByTestId('payment-card');
    fireEvent.click(screen.getAllByRole('button', { name: 'New payment' })[0]);
    const bar = await screen.findByTestId('payment-save-bar');
    const form = bar.parentElement!;
    const labels = [...form.querySelectorAll('label')].map(l => l.firstChild?.textContent?.trim()).filter(Boolean);
    expect(labels.slice(0, 9)).toEqual(['Busy company *', 'Payee *', 'Amount (₹)', 'Purpose *', 'Date', 'Plant', 'A/c number', 'IFSC', 'Bank']);
    // One column on a phone (grid-cols-1 below sm) and Save pinned on a phone.
    expect(form.querySelector('.grid')!.className).toMatch(/\bgrid-cols-1\b/);
    expect(bar.className).toMatch(/max-sm:sticky/);
    expect(bar.className).toMatch(/max-sm:bottom-0/);
    // The date box is the dd/mm/yyyy DateInput, after Purpose and before Plant.
    const date = within(form).getAllByPlaceholderText('dd/mm/yyyy')[0];
    expect(date.closest('label')!.firstChild!.textContent!.trim()).toBe('Date');
    expect(within(form).getByRole('button', { name: 'Open calendar' })).toBeTruthy();
    // Save comes after every field in the page order.
    const lastField = [...form.querySelectorAll('label')].pop()!;
    expect(lastField.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the amount preview while typing is the full figure', async () => {
    render(<BrowserRouter><BookPayments /></BrowserRouter>);
    await screen.findAllByTestId('payment-card');
    fireEvent.click(screen.getAllByRole('button', { name: 'New payment' })[0]);
    const amountLabel = (await screen.findByText(/Amount \(₹\)/)).closest('label')!;
    fireEvent.change(amountLabel.querySelector('input')!, { target: { value: '678767' } });
    expect(amountLabel.textContent).toContain('₹ 6,78,767');
  });
});
