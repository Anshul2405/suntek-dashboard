import { describe, it, expect } from 'vitest';
import { isWaitingReq, STORE_REQ_WAITING, isMyApproval, canDecideStoreReq, waitingCountsAsMyQueue } from './requisitionQueue';

describe('store requisition waiting set', () => {
  it('counts every awaiting stage, not just pending', () => {
    for (const s of STORE_REQ_WAITING) expect(isWaitingReq(s)).toBe(true);
  });
  it('excludes decided rows', () => {
    for (const s of ['approved', 'dispatched', 'received', 'rejected', null, '']) expect(isWaitingReq(s)).toBe(false);
  });
});

describe('isMyApproval', () => {
  it('gives a decider the requests waiting on them, not just their own', () => {
    const uh = { name: 'Unit Head Madan', canDecide: true };
    expect(isMyApproval({ status: 'pending', raised_by: 'Madan Tech' }, uh)).toBe(true);
    expect(isMyApproval({ status: 'pending_approval', raised_by: 'Madan Tech' }, uh)).toBe(true);
    expect(isMyApproval({ status: 'approved', raised_by: 'Madan Tech' }, uh)).toBe(false);
  });
  it('gives a requester only what they raised', () => {
    const tech = { name: 'Madan Tech', canDecide: false };
    expect(isMyApproval({ status: 'pending', raised_by: 'Madan Tech' }, tech)).toBe(true);
    expect(isMyApproval({ status: 'pending', raised_by: 'Sanju Pal' }, tech)).toBe(false);
  });
  it('does not put every pending row on the owner just because they can override', () => {
    const owner = { name: 'Owner', canDecide: true, waitingIsMine: false };
    expect(isMyApproval({ status: 'pending', raised_by: 'Madan Tech' }, owner)).toBe(false);
    expect(isMyApproval({ status: 'pending', raised_by: 'Owner' }, owner)).toBe(true);
  });
});

describe('canDecideStoreReq', () => {
  it('lets unit head and admin decide, not a technician', () => {
    expect(canDecideStoreReq({ id: 'db_x', baseRoleId: 'unit_head' }, false)).toBe(true);
    expect(canDecideStoreReq({ id: 'technician_shd' }, false)).toBe(false);
    expect(canDecideStoreReq({ id: 'db_owner' }, true)).toBe(true);
  });
  it('does not treat owner as the plant approval queue', () => {
    expect(waitingCountsAsMyQueue({ id: 'admin' }, true)).toBe(false);
    expect(waitingCountsAsMyQueue({ id: 'db_x', baseRoleId: 'unit_head' }, false)).toBe(true);
  });
});
