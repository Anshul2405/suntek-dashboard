/**
 * Draft helpers for the Modify user screen (one Save for everything on it).
 */
import type { OpsSettings } from '../opsControls';

/** The parts of ops_settings the Modify user screen edits. */
const EDITED = ['tabs', 'tabRoles', 'people', 'modules', 'backDays', 'editWindowHours', 'photos', 'photosHiddenFrom', 'photosEnforced'] as const;

/** Has the draft changed anything Save would write? */
export function rightsChanged(saved: OpsSettings, draft: OpsSettings): boolean {
  return EDITED.some((k) => JSON.stringify(saved[k] ?? null) !== JSON.stringify(draft[k] ?? null));
}

/** A new person's ticks were kept under a placeholder id until the account existed. */
export function remapPerson(s: OpsSettings, from: string, to: string): OpsSettings {
  const people = { ...s.people };
  const mine = people[from];
  delete people[from];
  if (mine && (Object.keys(mine.sections || {}).length || Object.keys(mine.tabs || {}).length || Object.keys(mine.verbs || {}).length)) people[to] = mine;
  const hide = s.photosHiddenFrom;
  const photosHiddenFrom = hide && {
    heat: hide.heat.map((h) => (h === from ? to : h)),
    sheet: hide.sheet.map((h) => (h === from ? to : h)),
    bucket: hide.bucket.map((h) => (h === from ? to : h)),
  };
  return { ...s, people, photosHiddenFrom };
}

/** A new role's ticks were made under the id its name gave at that moment; move them to the saved id. */
export function remapRole(s: OpsSettings, from: string, to: string): OpsSettings {
  if (from === to) return s;
  const swap = (list: string[]) => [...new Set(list.map((x) => (x === from ? to : x)))];
  const tabs = Object.fromEntries(Object.entries(s.tabs || {}).map(([route, m]) => [route, Object.fromEntries(Object.entries(m).map(([tab, ids]) => [tab, swap(ids)]))]));
  const tabRoles = Object.fromEntries(Object.entries(s.tabRoles || {}).map(([route, ids]) => [route, swap(ids)]));
  const modules = Object.fromEntries(Object.entries(s.modules).map(([k, g]) => [k, { ...g, edit: swap(g.edit), delete: swap(g.delete), ...(g.add ? { add: swap(g.add) } : {}) }])) as OpsSettings['modules'];
  const photos = { heat: swap(s.photos.heat), sheet: swap(s.photos.sheet), bucket: swap(s.photos.bucket) };
  return { ...s, tabs, tabRoles, modules, photos };
}
