import { describe, it, expect } from 'vitest';
import { profileCanAccess, roleToProfile, initialsFrom, canViewBatchOilRatio, canViewBatchFacet, canViewBatchRegister, canSelectBatchGrade, isAdminProfile, isManagementProfile, canSeeScheduleSetup, unionRoleAccess, profileHasCapability, type MockProfile, type RoleRow } from './profiles';

// Synthetic profiles (the role catalog is now DB-driven; tests use fixtures).
function mk(allowed: string[], overrides: Partial<MockProfile> = {}): MockProfile {
  return {
    id: 'test',
    name: 'Test User',
    role: 'L2',
    roleLabel: 'Test',
    roleDescription: '',
    initials: 'TU',
    avatarFrom: 'from-slate-300',
    avatarTo: 'to-slate-500',
    homeRoute: '/dashboard',
    allowedDashboardRoutes: allowed,
    standaloneOnly: false,
    capabilities: [],
    ...overrides,
  };
}

describe('profileCanAccess', () => {
  it('grants access to any route via the wildcard', () => {
    const admin = mk(['*']);
    expect(profileCanAccess(admin, '/dashboard')).toBe(true);
    expect(profileCanAccess(admin, '/dashboard/purchase/marine')).toBe(true);
    expect(profileCanAccess(admin, '/dashboard/anything-new')).toBe(true);
  });

  it('uses EXACT matching — a parent route does NOT grant child routes', () => {
    // Has '/dashboard' but must NOT reach the L1 entry terminals.
    const p = mk(['/dashboard', '/dashboard/stock']);
    expect(profileCanAccess(p, '/dashboard')).toBe(true);
    expect(profileCanAccess(p, '/dashboard/night-entry')).toBe(false);
    expect(profileCanAccess(p, '/dashboard/batch-entry')).toBe(false);
  });

  it('opens the purchase book for anyone who already sees purchase orders or marine', () => {
    expect(profileCanAccess(mk(['/dashboard/purchase/purchase']), '/dashboard/purchase/book')).toBe(true);
    expect(profileCanAccess(mk(['/dashboard/purchase/marine']), '/dashboard/purchase/book')).toBe(true);
    expect(profileCanAccess(mk(['/dashboard/purchase/maint']), '/dashboard/purchase/book')).toBe(false);
  });

  it('allows explicitly listed routes and denies unlisted ones', () => {
    const p = mk(['/dashboard/stock', '/dashboard/purchase/storereq']);
    expect(profileCanAccess(p, '/dashboard/stock')).toBe(true);
    expect(profileCanAccess(p, '/dashboard/sales')).toBe(false);
    expect(profileCanAccess(p, '/dashboard/purchase/marine')).toBe(false);
  });

  it('scopes a single-purpose role to just its entry route', () => {
    const night = mk(['/dashboard/night-entry']);
    expect(profileCanAccess(night, '/dashboard/night-entry')).toBe(true);
    expect(profileCanAccess(night, '/dashboard')).toBe(false);
    expect(profileCanAccess(night, '/dashboard/stock')).toBe(false);
  });
});

describe('initialsFrom', () => {
  it('takes first + last initial for multi-word names', () => {
    expect(initialsFrom('Sagar Nenwani')).toBe('SN');
    expect(initialsFrom('Anil Kumar Gupta')).toBe('AG');
  });
  it('takes the first two letters for single-word names', () => {
    expect(initialsFrom('Anshul')).toBe('AN');
  });
  it('handles empty input', () => {
    expect(initialsFrom('')).toBe('?');
  });
});

describe('roleToProfile', () => {
  const role: RoleRow = {
    id: 'unit_head',
    label: 'Unit Head',
    level: 'L2',
    description: 'Ops oversight',
    home_route: '/dashboard',
    allowed_routes: ['/dashboard', '/dashboard/stock'],
    standalone_only: false,
    is_admin: false,
    is_system: false,
    capabilities: [],
    avatar_from: 'from-blue-400',
    avatar_to: 'to-blue-600',
    sort_order: 2,
  };

  it('maps a role row to a MockProfile and derives initials from the overridden name', () => {
    const p = roleToProfile(role, { name: 'Vijay Ji', id: 'db_1', baseRoleId: 'unit_head' });
    expect(p.id).toBe('db_1');
    expect(p.role).toBe('L2');
    expect(p.roleLabel).toBe('Unit Head');
    expect(p.roleDescription).toBe('Ops oversight');
    expect(p.allowedDashboardRoutes).toEqual(['/dashboard', '/dashboard/stock']);
    expect(p.baseRoleId).toBe('unit_head');
    expect(p.initials).toBe('VJ');
    expect(profileCanAccess(p, '/dashboard/stock')).toBe(true);
    expect(profileCanAccess(p, '/dashboard/sales')).toBe(false);
  });

  it('does not grant Activity Log to Technical unless the role lists the route', () => {
    const tech = mk(['/dashboard/batch-entry'], {
      id: 'db_anand',
      baseRoleId: 'factory_operator',
    });
    expect(profileCanAccess(tech, '/dashboard/batches')).toBe(true);
    expect(profileCanAccess(tech, '/dashboard/batch-entry')).toBe(true);
    expect(profileCanAccess(tech, '/dashboard/purchase/activity')).toBe(false);
  });

  it('grants Batch Logger when only Batch Sheets is ticked in Manage Roles', () => {
    const tech = mk(['/dashboard/batches'], { id: 'db_nilesh', baseRoleId: 'factory_operator' });
    expect(profileCanAccess(tech, '/dashboard/batches')).toBe(true);
    expect(profileCanAccess(tech, '/dashboard/batch-entry')).toBe(true);
  });

  it('grants Batch Logger entry to any role with Batch Sheets route', () => {
    const p = mk(['/dashboard/batches']);
    expect(profileCanAccess(p, '/dashboard/batch-entry')).toBe(true);
  });

  it('grants Activity Log when the role includes the route', () => {
    const tech = mk(['/dashboard/purchase/activity'], {
      id: 'db_anand',
      baseRoleId: 'factory_operator',
    });
    expect(profileCanAccess(tech, '/dashboard/purchase/activity')).toBe(true);
  });

  it('maps factory_operator to Batch Sheet home and both batch routes', () => {
    const techRole: RoleRow = {
      id: 'factory_operator',
      label: 'Technical',
      level: 'L1',
      description: '',
      home_route: '/dashboard/batch-entry',
      allowed_routes: ['/dashboard/stock'],
      standalone_only: false,
      is_admin: false,
      is_system: false,
      capabilities: [],
      avatar_from: null,
      avatar_to: null,
      sort_order: 50,
    };
    const p = roleToProfile(techRole, { name: 'Nilesh Kumar', id: 'db_x', baseRoleId: 'factory_operator' });
    expect(p.homeRoute).toBe('/dashboard/batches');
    expect(p.allowedDashboardRoutes).toContain('/dashboard/batches');
    expect(p.allowedDashboardRoutes).toContain('/dashboard/batch-entry');
  });
});

describe('isAdminProfile', () => {
  it('treats provisioned owners (db_<uuid>) as admin via * routes', () => {
    expect(isAdminProfile(mk(['*'], { id: 'db_abc', baseRoleId: 'admin' }))).toBe(true);
    expect(isAdminProfile(mk(['/dashboard'], { id: 'db_x', baseRoleId: 'unit_head' }))).toBe(false);
  });
});

describe('canViewBatchFacet', () => {
  it('keeps full access when no batch caps are set', () => {
    const tech = mk(['/dashboard/batch-entry'], { id: 'db_nilesh', baseRoleId: 'factory_operator' });
    expect(canViewBatchFacet(tech, 'raw')).toBe(true);
    expect(canViewBatchFacet(tech, 'sheet')).toBe(true);
    expect(canViewBatchFacet(tech, 'mat')).toBe(true);
  });

  it('limits Technical to the granted Raw / Sheet / Mat toggle', () => {
    const tech = mk(['/dashboard/batch-entry'], {
      id: 'db_nilesh',
      baseRoleId: 'factory_operator',
      capabilities: ['batch_raw'],
    });
    expect(canViewBatchFacet(tech, 'raw')).toBe(true);
    expect(canViewBatchFacet(tech, 'sheet')).toBe(false);
    expect(canViewBatchFacet(tech, 'mat')).toBe(false);
  });
});

describe('canSelectBatchGrade', () => {
  it('is on for admin and off for Technical until granted', () => {
    expect(canSelectBatchGrade(mk(['*'], { id: 'admin' }))).toBe(true);
    expect(canSelectBatchGrade(mk(['/dashboard'], { id: 'db_sagar', baseRoleId: 'admin' }))).toBe(true);
    const tech = mk(['/dashboard/batch-entry'], { id: 'db_nilesh', baseRoleId: 'factory_operator' });
    expect(canSelectBatchGrade(tech)).toBe(false);
    expect(canSelectBatchGrade({ ...tech, capabilities: ['batch_grade'] })).toBe(true);
  });
});

describe('canViewBatchRegister', () => {
  it('hides the sheet register from a raw-only Technical user', () => {
    const raw = mk(['/dashboard/batch-entry'], {
      id: 'db_raw',
      baseRoleId: 'factory_operator',
      capabilities: ['batch_raw'],
    });
    expect(canViewBatchRegister(raw)).toBe(false);
    expect(profileCanAccess(raw, '/dashboard/batches')).toBe(false);
    expect(profileCanAccess(raw, '/dashboard/batch-entry')).toBe(true);
  });
});

describe('canSeeScheduleSetup', () => {
  it('hides Schedule Setup from a store manager until manage_schedules is granted', () => {
    const sanju = mk(['/dashboard/purchase/maint'], {
      id: 'db_sanju',
      baseRoleId: 'store_manager_maint',
      capabilities: [],
    });
    expect(canSeeScheduleSetup(sanju)).toBe(false);
    expect(profileHasCapability(sanju, 'manage_schedules')).toBe(false);
    expect(canSeeScheduleSetup({ ...sanju, capabilities: ['manage_schedules'] })).toBe(true);
  });

  it('still opens Schedule Setup for unit head and owner without an extra toggle', () => {
    expect(canSeeScheduleSetup(mk(['/dashboard/purchase/maint'], { id: 'unit_head' }))).toBe(true);
    expect(canSeeScheduleSetup(mk(['*'], { id: 'db_owner', baseRoleId: 'admin' }))).toBe(true);
  });
});

describe('unionRoleAccess', () => {
  it('unions capabilities across extra roles so preview matches login', () => {
    const store: RoleRow = {
      id: 'store_manager_maint',
      label: 'Store Manager · Maint',
      level: 'L2',
      description: null,
      home_route: '/dashboard/purchase/maint',
      allowed_routes: ['/dashboard/purchase/maint'],
      standalone_only: false,
      is_admin: false,
      is_system: false,
      capabilities: [],
      avatar_from: null,
      avatar_to: null,
      sort_order: 20,
    };
    const extra: RoleRow = { ...store, id: 'custom', capabilities: ['manage_schedules'] };
    expect(unionRoleAccess([store, extra]).capabilities).toContain('manage_schedules');
  });
});

describe('canViewBatchOilRatio', () => {
  it('allows management roles', () => {
    expect(isManagementProfile(mk(['*'], { id: 'admin' }))).toBe(true);
    expect(canViewBatchOilRatio(mk(['/dashboard'], { id: 'management' }), 'Someone Else')).toBe(true);
    expect(canViewBatchOilRatio(mk(['/dashboard'], { id: 'unit_head' }), null)).toBe(true);
  });

  it('allows the uploader by name match', () => {
    const tech = mk(['/dashboard/batch-entry'], { id: 'db_pankaj', name: 'Pankaj Kumar Pandey' });
    expect(canViewBatchOilRatio(tech, 'Pankaj Kumar Pandey')).toBe(true);
    expect(canViewBatchOilRatio(tech, 'Other Person')).toBe(false);
  });
});
