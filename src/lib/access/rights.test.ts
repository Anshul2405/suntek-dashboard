import { describe, it, expect } from 'vitest';
import { GATED_TABS, pickTab, allowedTabs, applyPersonSections, backDaysFor, canDo, canSeeTab, rolesThatCanOpen, setRoleAdd, setRoleTab, BOOK_ROUTE, BOOK_TABS } from './rights';
import { DEFAULT_OPS, type OpsSettings } from '../opsControls';
import type { MockProfile } from '../profiles';
import { needsLateApproval } from '../datePolicy';

const person = (id: string, routes: string[], roleIds?: string[]) =>
  ({ id, name: id, role: 'L3', roleLabel: id, roleDescription: '', initials: 'X', allowedDashboardRoutes: routes, roleIds }) as unknown as MockProfile;

const salesPoint = person('db_salespoint', [BOOK_ROUTE], ['sales']);
const admin = person('admin', ['*']);
const loaded = (patch: Partial<OpsSettings> = {}): OpsSettings => ({ ...DEFAULT_OPS, loaded: true, enforced: true, ...patch });
const threeTabs = loaded({ tabs: { [BOOK_ROUTE]: { purchases: ['sales'], payments: ['sales'], paraffin: ['sales'] } } });

describe('Purchase book tabs (Menu rights)', () => {
  it('a SalesPoint-like user sees only Purchases + Payments + Paraffin', () => {
    expect(allowedTabs(threeTabs, salesPoint, 'db_salespoint', BOOK_ROUTE)).toEqual(['purchases', 'payments', 'paraffin']);
    expect(canSeeTab(threeTabs, salesPoint, 'db_salespoint', BOOK_ROUTE, 'dispatch')).toBe(false);
  });

  it('a role never configured that can open the book keeps all seven tabs (release does not blank it)', () => {
    expect(allowedTabs(loaded(), salesPoint, 'db_salespoint', BOOK_ROUTE)).toEqual([...BOOK_TABS]);
    // Purchase Orders / Marine still open the book for a role.
    const viaPo = person('db_po', ['/dashboard/purchase/purchase'], ['buyer']);
    const routes = (id: string) => (id === 'buyer' ? ['/dashboard/purchase/purchase'] : undefined);
    expect(allowedTabs(loaded(), viaPo, 'db_po', BOOK_ROUTE, routes)).toHaveLength(7);
  });

  it('once Admin saves a list for the role, that list is the truth (even one tab, even none)', () => {
    const one = setRoleTab(setRoleTab(setRoleTab(setRoleTab(loaded(), 'sales', BOOK_ROUTE, 'requirements', false), 'sales', BOOK_ROUTE, 'dispatch', false), 'sales', BOOK_ROUTE, 'kolkata', false), 'sales', BOOK_ROUTE, 'shd', false);
    expect(allowedTabs(one, salesPoint, 'db_salespoint', BOOK_ROUTE)).toEqual(['purchases', 'payments', 'paraffin']);
    const none = loaded({ tabRoles: { [BOOK_ROUTE]: ['sales'] } });
    expect(allowedTabs(none, salesPoint, 'db_salespoint', BOOK_ROUTE)).toEqual([]);
  });

  it('configuring one role never writes the others', () => {
    const s1 = setRoleTab(loaded(), 'sales', BOOK_ROUTE, 'dispatch', false);
    expect(s1.tabRoles[BOOK_ROUTE]).toEqual(['sales']);
    const other = person('db_o', [BOOK_ROUTE], ['accounts']);
    expect(allowedTabs(s1, other, 'db_o', BOOK_ROUTE)).toHaveLength(7);
  });

  it('a role that cannot open the book adds nothing for a multi-role person', () => {
    const multi = person('db_m', [BOOK_ROUTE], ['sales', 'night']);
    const routes = (id: string) => (id === 'sales' ? [BOOK_ROUTE] : ['/dashboard/night-manager']);
    expect(allowedTabs(threeTabs, multi, 'db_m', BOOK_ROUTE, routes)).toEqual(['purchases', 'payments', 'paraffin']);
  });

  it('fails closed before the settings load; Admin always sees every tab', () => {
    expect(allowedTabs({ ...threeTabs, loaded: false }, salesPoint, 'db_salespoint', BOOK_ROUTE)).toEqual([]);
    expect(allowedTabs(DEFAULT_OPS, admin, null, BOOK_ROUTE)).toHaveLength(7);
  });

  it('the person wins over the role, both ways', () => {
    const s = loaded({ ...threeTabs, people: { db_salespoint: { tabs: { [`${BOOK_ROUTE}#dispatch`]: true, [`${BOOK_ROUTE}#paraffin`]: false } } } });
    expect(allowedTabs(s, salesPoint, 'db_salespoint', BOOK_ROUTE)).toEqual(['purchases', 'payments', 'dispatch']);
  });

  it('a saved paraffin-only list shows just Paraffin', () => {
    const s = loaded({ tabs: { [BOOK_ROUTE]: { paraffin: ['sales'] } } });
    expect(allowedTabs(s, salesPoint, 'db_salespoint', BOOK_ROUTE)).toEqual(['paraffin']);
  });

  it('NKG · Kolkata is one tab, key still `kolkata` (rights and ?tab=kolkata unchanged)', () => {
    const tabs = GATED_TABS[BOOK_ROUTE];
    expect(tabs).toHaveLength(7);
    expect(tabs.filter((t) => t.key === 'kolkata')).toEqual([{ key: 'kolkata', label: 'NKG · Kolkata', labelKey: 'book.tabKolkata' }]);
    expect(tabs.some((t) => /nkg/i.test(t.key))).toBe(false);
  });

  it('?tab=dispatch snaps to the first granted tab', () => {
    const tabs = allowedTabs(threeTabs, salesPoint, 'db_salespoint', BOOK_ROUTE);
    expect(pickTab('dispatch', tabs)).toBe('purchases');
    expect(pickTab('payments', tabs)).toBe('payments');
    expect(pickTab('dispatch', [])).toBe(null);
  });

  it('no tab without the page', () => {
    expect(canSeeTab(threeTabs, person('db_x', ['/dashboard'], ['sales']), 'db_x', BOOK_ROUTE, 'purchases')).toBe(false);
  });
});

describe('Add / Edit / Delete', () => {
  it('a hidden tab with Add ticked is still no', () => {
    const s = loaded({ ...threeTabs, modules: { ...DEFAULT_OPS.modules, dispatch: { edit: [], delete: [], add: ['sales'] }, payments: { edit: [], delete: [], add: ['sales'] } } });
    expect(canDo(s, salesPoint, 'db_salespoint', 'dispatch', 'add')).toBe(false);
    expect(canDo(s, salesPoint, 'db_salespoint', 'payments', 'add')).toBe(true);
  });

  it('Add: undefined = today\'s rule, [] = Admin only, ids = those roles', () => {
    const tech = person('db_t', ['/dashboard/purchase/maint'], ['factory_operator']);
    const withAdd = (add: string[] | undefined) => loaded({ modules: { ...DEFAULT_OPS.modules, maintenance: { edit: [], delete: [], ...(add ? { add } : {}) } } });
    expect(canDo(withAdd(undefined), tech, 'db_t', 'maintenance', 'add')).toBe(true);
    expect(canDo(withAdd([]), tech, 'db_t', 'maintenance', 'add')).toBe(false);
    expect(canDo(withAdd(['factory_operator']), tech, 'db_t', 'maintenance', 'add')).toBe(true);
    expect(canDo(withAdd(['unit_head']), tech, 'db_t', 'maintenance', 'add')).toBe(false);
  });

  it('first Add untick keeps the rest of the floor; untouched modules stay undefined', () => {
    const roles = [
      { id: 'factory_operator', allowed_routes: ['/dashboard/purchase/maint'] },
      { id: 'unit_head', allowed_routes: ['/dashboard/purchase/maint', '/dashboard/purchase/storereq'] },
      { id: 'sales', allowed_routes: [BOOK_ROUTE] },
    ];
    expect(rolesThatCanOpen(roles, BOOK_ROUTE)).toEqual(['sales']);
    const s1 = setRoleAdd(loaded(), roles, 'maintenance', 'unit_head', false);
    expect(s1.modules.maintenance.add).toEqual(['factory_operator']);
    expect(s1.modules.store_req.add).toBeUndefined();
    expect(s1.modules.dispatch.add).toBeUndefined();
    // Serialised and read back, undefined stays undefined (not []).
    expect(JSON.parse(JSON.stringify(s1)).modules.store_req.add).toBeUndefined();
  });

  it('Add follows the screen until Admin saves the Add column; then blank = no', () => {
    const tech = person('db_t', ['/dashboard/purchase/maint'], ['factory_operator']);
    expect(canDo(loaded(), tech, 'db_t', 'maintenance', 'add')).toBe(true);
    const saved = loaded({ modules: { ...DEFAULT_OPS.modules, maintenance: { edit: [], delete: [], add: [] } } });
    expect(canDo(saved, tech, 'db_t', 'maintenance', 'add')).toBe(false);
    expect(canDo({ ...saved, people: { db_t: { verbs: { 'maintenance.add': true } } } }, tech, 'db_t', 'maintenance', 'add')).toBe(true);
  });

  it('Edit / Delete: role ticks, the person override, fail-closed before load', () => {
    const tech = person('db_t', ['/dashboard/purchase/storereq'], ['factory_operator']);
    const s = loaded({ modules: { ...DEFAULT_OPS.modules, stock: { edit: ['factory_operator'], delete: [] } } });
    expect(canDo(s, tech, 'db_t', 'stock', 'edit')).toBe(true);
    expect(canDo(s, tech, 'db_t', 'stock', 'delete')).toBe(false);
    expect(canDo({ ...s, people: { db_t: { verbs: { 'stock.edit': false } } } }, tech, 'db_t', 'stock', 'edit')).toBe(false);
    expect(canDo({ ...s, loaded: false }, tech, 'db_t', 'stock', 'edit')).toBe(false);
    expect(canDo(DEFAULT_OPS, admin, null, 'stock', 'delete')).toBe(true);
  });
});

describe('Back-date limits', () => {
  it('per module, else the default; a plant number is applied on top (tighter wins)', () => {
    const s = loaded({ bufferDays: 2, backDays: { payments: 30, dispatch: 0 }, bufferDaysByPlant: { jh: 1 } });
    expect(backDaysFor(s, 'payments')).toBe(30);
    expect(backDaysFor(s, 'dispatch')).toBe(0);
    expect(backDaysFor(s, 'activity')).toBe(2);
    expect(backDaysFor(s, 'payments', ['jh'])).toBe(1);
  });

  it('Payments 30 / Dispatch 0: a future day is never late; 40 days back goes to Management', () => {
    const s = loaded({ bufferDays: 2, backDays: { payments: 30, dispatch: 0 } });
    const now = new Date('2026-10-29T10:00:00+05:30');
    expect(needsLateApproval('2026-10-30', backDaysFor(s, 'dispatch'), now)).toBe(false);
    expect(needsLateApproval('2026-10-30', backDaysFor(s, 'payments'), now)).toBe(false);
    expect(needsLateApproval('2026-10-28', backDaysFor(s, 'dispatch'), now)).toBe(true);
    expect(needsLateApproval('2026-09-19', backDaysFor(s, 'payments'), now)).toBe(true);
    expect(needsLateApproval('2026-10-05', backDaysFor(s, 'payments'), now)).toBe(false);
  });
});

describe('Per-person sections', () => {
  it('a person yes adds a page once loaded; a no removes it even before', () => {
    const p = person('db_p', ['/dashboard', '/dashboard/sales']);
    const s = loaded({ people: { db_p: { sections: { '/dashboard/sales': false, '/dashboard/customers': true } } } });
    expect(applyPersonSections(p, s, 'db_p').allowedDashboardRoutes.sort()).toEqual(['/dashboard', '/dashboard/customers']);
    expect(applyPersonSections(p, { ...s, loaded: false }, 'db_p').allowedDashboardRoutes).toEqual(['/dashboard']);
    expect(applyPersonSections(admin, s, 'admin')).toBe(admin);
  });
});
