import { describe, expect, it } from 'vitest';
import {
  canEditRaisedTicket, cleanEditWindowHours, editAccess, editWindowMs, editWindowText,
  ticketEditMinutesLeft, ticketIsApprovedOrClosed, TICKET_EDIT_WINDOW_MS,
} from './ticketEditWindow';
import { DEFAULT_OPS, type OpsSettings } from './opsControls';
import type { MockProfile } from './profiles';

const person = (id: string, routes: string[] = ['/dashboard']) =>
  ({ id, name: id, role: id, roleLabel: id, roleDescription: '', initials: 'X', allowedDashboardRoutes: routes }) as unknown as MockProfile;
const tech = person('factory_operator');
const uh = person('unit_head');
const vijay = person('management');
const admin = person('admin', ['*']);

const raised = '2026-10-22T08:00:00.000Z';
const t0 = Date.parse(raised);
const ticked: OpsSettings = {
  ...DEFAULT_OPS, loaded: true, enforced: true,
  modules: { ...DEFAULT_OPS.modules, maintenance: { edit: ['factory_operator', 'unit_head', 'management'], delete: [] } },
};
const access = (profile: MockProfile, o: Partial<{ settings: OpsSettings; locked: boolean; isCreator: boolean; now: number }> = {}) =>
  editAccess({ profile, settings: o.settings ?? ticked, module: 'maintenance', createdAt: raised, locked: o.locked ?? false, isCreator: o.isCreator ?? true, now: o.now ?? t0 + 10 * 60_000 });

describe('edit window (default 1 hour, Admin may change it)', () => {
  it('defaults to 1 hour and follows a saved value', () => {
    expect(TICKET_EDIT_WINDOW_MS).toBe(3_600_000);
    expect(cleanEditWindowHours(undefined)).toBe(1);
    expect(cleanEditWindowHours(2)).toBe(2);
    expect(cleanEditWindowHours(-1)).toBe(1);
    expect(cleanEditWindowHours(9999)).toBe(1);
    expect(canEditRaisedTicket(raised, t0 + 90 * 60_000, editWindowMs(2))).toBe(true);
    expect(ticketEditMinutesLeft(raised, t0 + 90 * 60_000, editWindowMs(2))).toBe(30);
    expect(editWindowText(2)).toEqual({ n: 2, unit: 'hours' });
    expect(editWindowText(0.5)).toEqual({ n: 30, unit: 'min' });
  });

  it('inside the window: the creator with the Edit tick may edit', () => {
    expect(access(tech)).toBe('creator');
    expect(access(tech, { isCreator: false })).toBe(null);
    expect(access(tech, { settings: { ...ticked, modules: DEFAULT_OPS.modules } })).toBe(null);
  });

  it('after the window: Unit Head and management may, a technician may not', () => {
    const late = { now: t0 + 2 * 3_600_000 };
    expect(access(tech, late)).toBe(null);
    expect(access(uh, late)).toBe('senior');
    expect(access(vijay, late)).toBe('senior');
    // A 3-hour window keeps the creator in.
    expect(access(tech, { ...late, settings: { ...ticked, editWindowHours: 3 } })).toBe('creator');
  });

  it('once approved or closed: only Admin, Unit Head, management', () => {
    expect(ticketIsApprovedOrClosed('pending_vijay')).toBe(true);
    expect(ticketIsApprovedOrClosed('closed')).toBe(true);
    expect(ticketIsApprovedOrClosed('pending_unit_head')).toBe(false);
    expect(access(tech, { locked: true })).toBe(null);
    expect(access(uh, { locked: true })).toBe('senior');
    expect(access(admin, { locked: true })).toBe('admin');
  });

  it('Unit Head / management still need the Edit tick; Admin does not', () => {
    const none = { ...ticked, modules: DEFAULT_OPS.modules };
    expect(access(uh, { settings: none, locked: true })).toBe(null);
    expect(access(admin, { settings: none, locked: true })).toBe('admin');
  });

  it('before the saved settings load, only Admin', () => {
    const notLoaded = { ...ticked, loaded: false };
    expect(access(tech, { settings: notLoaded })).toBe(null);
    expect(access(uh, { settings: notLoaded, locked: true })).toBe(null);
    expect(access(admin, { settings: notLoaded, locked: true })).toBe('admin');
  });

  it('rejects a missing raise time', () => {
    expect(canEditRaisedTicket(null)).toBe(false);
    expect(canEditRaisedTicket('')).toBe(false);
  });
});
