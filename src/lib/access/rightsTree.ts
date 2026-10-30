/**
 * Busy's Menu Rights tree on our screens (User Management → Modify user).
 *
 *   + Group (Factory, Operations…)
 *       ☐ Page                 = View / List (roles.allowed_routes, or a person's own yes / no)
 *           ☐ Tab              = that tab is visible (Purchase book: each tab its own tick)
 *               ☐ Add          = the tab's Add form (New payment, New dispatch)
 *           ☐ Add / Modify / Delete   (pages whose screen has those buttons)
 *
 * Only the shape lives here. Every value and every change goes through the
 * existing rules in rights.ts / opsControls (setRoleTab, setRoleAdd, roleSeesTab,
 * routesOpen, people overrides) — no second rights engine.
 */
import type { ModuleKey, OpsSettings, PersonRights, Verb } from '../opsControls';
import {
  ALL_SECTIONS, GATED_TABS, SECTION_GROUPS, VERB_MODULES,
  roleSeesTab, rolesThatCanOpen, routesOpen, setRoleAdd, setRoleTab,
  type SectionGroup,
} from './rights';

export type TreeKind = 'group' | 'section' | 'tab' | 'module' | 'verb';

export interface TreeNode {
  /** Unique id: "g:factory", "s:/route", "t:/route#tab", "m:module", "v:module.verb". */
  id: string;
  kind: TreeKind;
  label: string;
  labelKey: string;
  /** Short plant hint next to a verb ("New payment"). */
  hint?: string;
  hintKey?: string;
  route?: string;
  tab?: string;
  module?: ModuleKey;
  verb?: Verb;
  children: TreeNode[];
}

/** Busy's words for our verbs: edit is "Modify". */
export const VERB_LABEL: Record<Verb, { label: string; labelKey: string }> = {
  add: { label: 'Add', labelKey: 'rights.add' },
  edit: { label: 'Modify', labelKey: 'rights.modify' },
  delete: { label: 'Delete', labelKey: 'rights.delete' },
};

/** What Add / Modify / Delete means on that screen, in plant words. */
const VERB_HINT: Partial<Record<`${ModuleKey}.${Verb}`, { hint: string; hintKey: string }>> = {
  'maintenance.add': { hint: 'Raise ticket', hintKey: 'rights.hintRaiseTicket' },
  'maintenance.edit': { hint: 'change a ticket', hintKey: 'rights.hintEditTicket' },
  'maintenance.delete': { hint: 'remove a ticket', hintKey: 'rights.hintDeleteTicket' },
  'store_req.add': { hint: 'Raise request', hintKey: 'rights.hintRaiseRequest' },
  'stock.edit': { hint: 'change a stock item', hintKey: 'rights.hintEditStock' },
  'stock.delete': { hint: 'remove a stock item', hintKey: 'rights.hintDeleteStock' },
  'purchase.add': { hint: 'Add purchase', hintKey: 'rights.hintAddPurchase' },
  'batch.add': { hint: 'Create batch sheet', hintKey: 'rights.hintCreateBatch' },
  'batch.delete': { hint: 'remove a batch sheet', hintKey: 'rights.hintDeleteBatch' },
  'far.add': { hint: 'Add asset', hintKey: 'rights.hintAddAsset' },
  'far.edit': { hint: 'change an asset', hintKey: 'rights.hintEditAsset' },
  'activity.add': { hint: '+ Log activity', hintKey: 'rights.hintLogActivity' },
  'payments.add': { hint: 'Queue payment (New payment)', hintKey: 'rights.hintQueuePayment' },
  'dispatch.add': { hint: 'New dispatch', hintKey: 'rights.hintNewDispatch' },
};

function verbNode(module: ModuleKey, verb: Verb): TreeNode {
  const h = VERB_HINT[`${module}.${verb}`];
  return { id: `v:${module}.${verb}`, kind: 'verb', ...VERB_LABEL[verb], hint: h?.hint, hintKey: h?.hintKey, module, verb, children: [] };
}

/** The whole tree, in sidebar order. */
export function buildRightsTree(): TreeNode[] {
  return SECTION_GROUPS.map((g) => ({
    id: `g:${g.key}`,
    kind: 'group' as const,
    label: g.label,
    labelKey: g.labelKey,
    children: ALL_SECTIONS.filter((s) => s.group === g.key).map((s): TreeNode => {
      const tabs = (GATED_TABS[s.route] || []).map((tb): TreeNode => ({
        id: `t:${s.route}#${tb.key}`,
        kind: 'tab',
        label: tb.label,
        labelKey: tb.labelKey,
        route: s.route,
        tab: tb.key,
        children: VERB_MODULES.filter((m) => m.route === s.route && m.tab === tb.key).flatMap((m) => m.verbs.map((v) => verbNode(m.key, v))),
      }));
      const pageModules = VERB_MODULES.filter((m) => m.route === s.route && !m.tab);
      // One module on the page: its verbs sit right under the page (Supply Outward → Add, Modify…).
      // Several (Store Requisitions: requests, stock, add purchase): one branch each.
      const verbs = pageModules.length === 1
        ? pageModules[0].verbs.map((v) => verbNode(pageModules[0].key, v))
        : pageModules.map((m): TreeNode => ({
          id: `m:${m.key}`, kind: 'module', label: m.label, labelKey: m.labelKey, module: m.key,
          children: m.verbs.map((v) => verbNode(m.key, v)),
        }));
      return { id: `s:${s.route}`, kind: 'section', label: s.label, labelKey: s.labelKey, route: s.route, children: [...tabs, ...verbs] };
    }),
  }));
}

/** Every node id that has children (for Expand all). */
export function branchIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children.length ? [n.id, ...branchIds(n.children)] : []));
}

/** Group a route belongs to. */
export function groupOf(route: string): SectionGroup | undefined {
  return ALL_SECTIONS.find((s) => s.route === route)?.group;
}

// ── Whose rights ────────────────────────────────────────────────────────────

export interface RoleLite { id: string; allowed_routes?: string[] | null; is_admin?: boolean | null }

/**
 * The subject being edited.
 *  role:   the role's own routes (a draft until Save) and its id.
 *  person: the roles they hold (as picked on the left) and their db_<uuid>.
 */
export type RightsSubject =
  | { kind: 'role'; roleId: string; routes: string[] }
  | { kind: 'person'; personId: string; roleIds: string[] };

export interface TickState {
  /** What applies. */
  on: boolean;
  /** What the role(s) give (a person follows this unless they have their own). */
  roleSays: boolean;
  /** A person's own yes / no is set (beats the role). */
  own: boolean;
}

/** Routes the subject's roles open (person: union of their roles; role: its draft). */
function subjectRoutes(subject: RightsSubject, roles: RoleLite[]): string[] {
  if (subject.kind === 'role') return subject.routes;
  return roles.filter((r) => subject.roleIds.includes(r.id)).flatMap((r) => r.allowed_routes || []);
}

function roleIdsOfSubject(subject: RightsSubject): string[] {
  return subject.kind === 'role' ? [subject.roleId] : subject.roleIds;
}

/** The role's own answer for a leaf (no person override). */
export function roleAnswer(settings: OpsSettings, roles: RoleLite[], subject: RightsSubject, node: TreeNode): boolean {
  const routes = subjectRoutes(subject, roles);
  const ids = roleIdsOfSubject(subject);
  if (node.kind === 'section' && node.route) {
    return subject.kind === 'role' ? routes.includes(node.route) || routes.includes('*') : routesOpen(routes, node.route);
  }
  if (node.kind === 'tab' && node.route && node.tab) {
    return ids.some((id) => roleSeesTab(settings, id, node.route!, node.tab!));
  }
  if (node.kind === 'verb' && node.module && node.verb) {
    const g = settings.modules[node.module];
    const def = VERB_MODULES.find((m) => m.key === node.module);
    if (node.verb === 'add' && g?.add === undefined) {
      // Never configured: today's rule — whoever can open the screen.
      const mine = subject.kind === 'role'
        ? [{ id: subject.roleId, allowed_routes: routes }]
        : roles.filter((r) => ids.includes(r.id));
      return rolesThatCanOpen(mine, def?.route || '').length > 0;
    }
    const list = (node.verb === 'add' ? g?.add : node.verb === 'edit' ? g?.edit : g?.delete) || [];
    return ids.some((id) => list.includes(id));
  }
  return false;
}

function overrideSlot(node: TreeNode): { kind: keyof PersonRights; key: string } | null {
  if (node.kind === 'section' && node.route) return { kind: 'sections', key: node.route };
  if (node.kind === 'tab' && node.route && node.tab) return { kind: 'tabs', key: `${node.route}#${node.tab}` };
  if (node.kind === 'verb' && node.module && node.verb) return { kind: 'verbs', key: `${node.module}.${node.verb}` };
  return null;
}

/** On / off for a leaf, and whether it is a person's own setting. */
export function tickState(settings: OpsSettings, roles: RoleLite[], subject: RightsSubject, node: TreeNode): TickState {
  const roleSays = roleAnswer(settings, roles, subject, node);
  if (subject.kind === 'role') return { on: roleSays, roleSays, own: false };
  const slot = overrideSlot(node);
  const mine = slot ? settings.people?.[subject.personId]?.[slot.kind]?.[slot.key] : undefined;
  return { on: mine ?? roleSays, roleSays, own: mine !== undefined };
}

/**
 * Tick / untick one leaf.
 *  role:   page → its routes; tab → setRoleTab (first touch seeds every tab);
 *          Add → setRoleAdd (first touch keeps the other roles); Modify / Delete → the module lists.
 *  person: their own yes / no — and back to "follow the role" when it matches the role again,
 *          so a person only carries the differences.
 */
export function setTick(
  settings: OpsSettings,
  roles: RoleLite[],
  subject: RightsSubject,
  node: TreeNode,
  on: boolean,
): { settings: OpsSettings; routes?: string[] } {
  if (subject.kind === 'person') {
    const slot = overrideSlot(node);
    if (!slot) return { settings };
    const roleSays = roleAnswer(settings, roles, subject, node);
    const cur: PersonRights = { ...(settings.people?.[subject.personId] || {}) };
    const map = { ...(cur[slot.kind] || {}) };
    if (on === roleSays) delete map[slot.key]; else map[slot.key] = on;
    return { settings: { ...settings, people: { ...settings.people, [subject.personId]: { ...cur, [slot.kind]: map } } } };
  }
  if (node.kind === 'section' && node.route) {
    const routes = on ? [...new Set([...subject.routes, node.route])] : subject.routes.filter((r) => r !== node.route);
    return { settings, routes };
  }
  if (node.kind === 'tab' && node.route && node.tab) {
    return { settings: setRoleTab(settings, subject.roleId, node.route, node.tab, on) };
  }
  if (node.kind === 'verb' && node.module && node.verb) {
    if (node.verb === 'add') {
      // Seed from the catalogue, with this role's draft routes.
      const catalogue = roles.map((r) => (r.id === subject.roleId ? { ...r, allowed_routes: subject.routes } : r));
      if (!catalogue.some((r) => r.id === subject.roleId)) catalogue.push({ id: subject.roleId, allowed_routes: subject.routes });
      return { settings: setRoleAdd(settings, catalogue, node.module, subject.roleId, on) };
    }
    const g = settings.modules[node.module] || { edit: [], delete: [] };
    const list = g[node.verb];
    const next = on ? [...new Set([...list, subject.roleId])] : list.filter((x) => x !== subject.roleId);
    return { settings: { ...settings, modules: { ...settings.modules, [node.module]: { ...g, [node.verb]: next } } } };
  }
  return { settings };
}

/** Count of ticked leaves under a branch (shown as "3/7" on a collapsed branch). */
export function countOn(settings: OpsSettings, roles: RoleLite[], subject: RightsSubject, node: TreeNode): { on: number; total: number } {
  let on = 0, total = 0;
  const walk = (n: TreeNode) => {
    if (n.kind === 'section' || n.kind === 'tab' || n.kind === 'verb') {
      total++;
      if (tickState(settings, roles, subject, n).on) on++;
    }
    n.children.forEach(walk);
  };
  node.children.forEach(walk);
  return { on, total };
}
