import { describe, expect, it } from 'vitest';
import { DEFAULT_OPS, type OpsSettings } from '../opsControls';
import type { MockProfile } from '../profiles';
import { BOOK_ROUTE, BOOK_TABS, allowedTabs, canDo } from './rights';
import { branchIds, buildRightsTree, setTick, tickState, type RightsSubject, type TreeNode } from './rightsTree';
import { remapPerson, remapRole, rightsChanged } from './rightsDraft';

const ops = (over: Partial<OpsSettings> = {}): OpsSettings => ({ ...DEFAULT_OPS, loaded: true, enforced: true, ...over });
const ROLES = [
  { id: 'admin', allowed_routes: ['*'], is_admin: true },
  { id: 'sales', allowed_routes: ['/dashboard', BOOK_ROUTE] },
  { id: 'unit_head', allowed_routes: ['/dashboard', BOOK_ROUTE, '/dashboard/purchase/maint'] },
  { id: 'tech', allowed_routes: ['/dashboard/purchase/maint'] },
];
const tree = buildRightsTree();
const find = (id: string, nodes: TreeNode[] = tree): TreeNode | undefined => {
  for (const n of nodes) { if (n.id === id) return n; const k = find(id, n.children); if (k) return k; }
  return undefined;
};
const book = find(`s:${BOOK_ROUTE}`)!;
const tab = (k: string) => find(`t:${BOOK_ROUTE}#${k}`)!;
const salesRole: RightsSubject = { kind: 'role', roleId: 'sales', routes: ['/dashboard', BOOK_ROUTE] };
const profile = (id: string, roleIds: string[], routes: string[]): MockProfile =>
  ({ id, name: id, role: 'L3', roleLabel: '', roleDescription: '', initials: 'X', allowedDashboardRoutes: routes, roleIds, baseRoleId: roleIds[0] } as unknown as MockProfile);
const roleRoutes = (id: string) => ROLES.find((r) => r.id === id)?.allowed_routes;

describe('Menu Rights tree (Busy shape)', () => {
  it('Purchase book’s children are exactly the 7 tabs; Payments and Dispatch carry Add; Maintenance Add / Modify / Delete', () => {
    expect(book.children.map((c) => c.tab)).toEqual([...BOOK_TABS]);
    expect(tab('payments').children.map((c) => c.verb)).toEqual(['add']);
    expect(tab('dispatch').children.map((c) => c.verb)).toEqual(['add']);
    expect(tab('purchases').children).toEqual([]);
    const maint = find('s:/dashboard/purchase/maint')!;
    expect(maint.children.map((c) => `${c.kind}:${c.verb}`)).toEqual(['verb:add', 'verb:edit', 'verb:delete']);
    // No invented Cancel / Modify on Payments.
    expect(JSON.stringify(tree)).not.toMatch(/cancel/i);
    expect(branchIds(tree)).toContain(`s:${BOOK_ROUTE}`);
  });

  it('an unconfigured role shows all 7 tabs ticked — and still sees all 7 in the book', () => {
    const s = ops();
    expect(BOOK_TABS.every((k) => tickState(s, ROLES, salesRole, tab(k)).on)).toBe(true);
    expect(allowedTabs(s, profile('db_x', ['sales'], salesRole.kind === 'role' ? salesRole.routes : []), 'db_x', BOOK_ROUTE, roleRoutes)).toEqual([...BOOK_TABS]);
  });

  it('first tab untick seeds all seven then removes that one; other roles are never written', () => {
    let s = ops();
    for (const k of ['requirements', 'dispatch', 'kolkata', 'shd']) s = setTick(s, ROLES, salesRole, tab(k), false).settings;
    const lists = s.tabs[BOOK_ROUTE];
    expect(BOOK_TABS.filter((k) => lists[k].includes('sales'))).toEqual(['purchases', 'payments', 'paraffin']);
    expect(s.tabRoles[BOOK_ROUTE]).toEqual(['sales']);
    expect(Object.values(lists).flat().filter((id) => id !== 'sales')).toEqual([]);
    // unit_head (never touched) still sees every tab.
    expect(allowedTabs(s, profile('db_u', ['unit_head'], ROLES[2].allowed_routes), 'db_u', BOOK_ROUTE, roleRoutes)).toHaveLength(7);
    expect(allowedTabs(s, profile('db_s', ['sales'], ROLES[1].allowed_routes), 'db_s', BOOK_ROUTE, roleRoutes)).toEqual(['purchases', 'payments', 'paraffin']);
  });

  it('ticking the Purchase book page does not grant its tabs', () => {
    let s = ops();
    s = setTick(s, ROLES, salesRole, tab('dispatch'), false).settings;
    const off: RightsSubject = { kind: 'role', roleId: 'sales', routes: ['/dashboard'] };
    const res = setTick(s, ROLES, off, book, true);
    expect(res.routes).toContain(BOOK_ROUTE);
    expect(res.settings).toBe(s);
    expect(tickState(res.settings, ROLES, { ...off, routes: res.routes! }, tab('dispatch')).on).toBe(false);
  });

  it('person: own yes / no beats the role, and clicking back to the role’s value drops the override', () => {
    const me: RightsSubject = { kind: 'person', personId: 'db_p', roleIds: ['sales'] };
    let s = ops();
    s = setTick(s, ROLES, me, tab('dispatch'), false).settings;
    expect(s.people.db_p.tabs).toEqual({ [`${BOOK_ROUTE}#dispatch`]: false });
    expect(tickState(s, ROLES, me, tab('dispatch'))).toEqual({ on: false, roleSays: true, own: true });
    expect(allowedTabs(s, profile('db_p', ['sales'], ROLES[1].allowed_routes), 'db_p', BOOK_ROUTE, roleRoutes)).not.toContain('dispatch');
    s = setTick(s, ROLES, me, tab('dispatch'), true).settings;
    expect(s.people.db_p.tabs).toEqual({});
    // Roles are never touched from a person.
    expect(s.tabs).toEqual({});
    expect(s.tabRoles).toEqual({});
  });

  it('first Add untick keeps every other role that could open the screen; untouched modules stay undefined', () => {
    const payAdd = find('v:payments.add')!;
    expect(tickState(ops(), ROLES, salesRole, payAdd).on).toBe(true); // today: Add follows View
    const s = setTick(ops(), ROLES, salesRole, payAdd, false).settings;
    expect(s.modules.payments.add).toEqual(expect.arrayContaining(['unit_head', 'admin']));
    expect(s.modules.payments.add).not.toContain('sales');
    expect(s.modules.dispatch.add).toBeUndefined();
    expect(canDo(s, profile('db_s', ['sales'], ROLES[1].allowed_routes), 'db_s', 'payments', 'add', roleRoutes)).toBe(false);
    expect(canDo(s, profile('db_u', ['unit_head'], ROLES[2].allowed_routes), 'db_u', 'payments', 'add', roleRoutes)).toBe(true);
  });

  it('Modify / Delete write the module lists for that role only', () => {
    const techRole: RightsSubject = { kind: 'role', roleId: 'tech', routes: ['/dashboard/purchase/maint'] };
    const s = setTick(ops(), ROLES, techRole, find('v:maintenance.edit')!, true).settings;
    expect(s.modules.maintenance.edit).toEqual(['tech']);
    expect(s.modules.maintenance.delete).toEqual([]);
  });

  it('fail-closed and Admin are unchanged: nothing before the settings load, Admin always', () => {
    const unloaded = { ...ops(), loaded: false };
    expect(allowedTabs(unloaded, profile('db_s', ['sales'], ROLES[1].allowed_routes), 'db_s', BOOK_ROUTE, roleRoutes)).toEqual([]);
    expect(allowedTabs(unloaded, profile('admin', ['admin'], ['*']), 'admin', BOOK_ROUTE, roleRoutes)).toHaveLength(7);
  });
});

describe('Modify user draft helpers', () => {
  it('a new person’s ticks move from the placeholder to the saved id', () => {
    const me: RightsSubject = { kind: 'person', personId: 'db_new', roleIds: ['sales'] };
    let s = setTick(ops(), ROLES, me, tab('shd'), false).settings;
    s = { ...s, photosHiddenFrom: { heat: ['db_new'], sheet: [], bucket: [] } };
    const r = remapPerson(s, 'db_new', 'db_123');
    expect(r.people.db_new).toBeUndefined();
    expect(r.people.db_123.tabs).toEqual({ [`${BOOK_ROUTE}#shd`]: false });
    expect(r.photosHiddenFrom.heat).toEqual(['db_123']);
  });

  it('a new role’s ticks move to the id it was saved under', () => {
    const tmp: RightsSubject = { kind: 'role', roleId: 'store_kee', routes: [BOOK_ROUTE] };
    const s = setTick(ops(), ROLES, tmp, tab('shd'), false).settings;
    const r = remapRole(s, 'store_kee', 'store_keeper');
    expect(r.tabRoles[BOOK_ROUTE]).toEqual(['store_keeper']);
    expect(r.tabs[BOOK_ROUTE].purchases).toEqual(['store_keeper']);
  });

  it('rightsChanged sees only what the screen saves', () => {
    const s = ops();
    expect(rightsChanged(s, { ...s })).toBe(false);
    expect(rightsChanged(s, { ...s, backDays: { payments: 30 } })).toBe(true);
    expect(rightsChanged(s, { ...s, bufferDays: 9 })).toBe(false);
  });
});
