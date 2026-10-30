import { describe, it, expect } from 'vitest';
import { canDeleteModule, canEditModule, DEFAULT_OPS, type OpsSettings } from './opsControls';
import type { MockProfile } from './profiles';

const person = (id: string, routes: string[] = ['/dashboard']) =>
  ({ id, name: id, role: id, roleLabel: id, roleDescription: '', initials: 'X', allowedDashboardRoutes: routes }) as unknown as MockProfile;

const server = (patch: Partial<OpsSettings>): OpsSettings => ({ ...DEFAULT_OPS, loaded: true, ...patch });

describe('Access ticks are fail-closed', () => {
  const tech = person('factory_operator');
  const admin = person('admin', ['*']);

  it('before the saved ticks are read, only Admin may edit or delete', () => {
    expect(canEditModule(DEFAULT_OPS, tech, 'maintenance')).toBe(false);
    expect(canDeleteModule(DEFAULT_OPS, tech, 'maintenance')).toBe(false);
    expect(canEditModule(DEFAULT_OPS, admin, 'maintenance')).toBe(true);
  });

  it('restrictions on + a blank list = nobody but Admin', () => {
    const s = server({ enforced: true });
    expect(canEditModule(s, tech, 'far')).toBe(false);
    expect(canDeleteModule(s, tech, 'far')).toBe(false);
    expect(canDeleteModule(s, admin, 'far')).toBe(true);
  });

  it('a ticked role may edit / delete that module only', () => {
    const s = server({ enforced: true, modules: { ...DEFAULT_OPS.modules, stock: { edit: ['factory_operator'], delete: ['factory_operator'] } } });
    expect(canEditModule(s, tech, 'stock')).toBe(true);
    expect(canDeleteModule(s, tech, 'stock')).toBe(true);
    expect(canEditModule(s, tech, 'far')).toBe(false);
  });
});
