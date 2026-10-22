import { describe, it, expect } from 'vitest';
import { isWaitingReq, STORE_REQ_WAITING } from './requisitionQueue';

describe('store requisition waiting set', () => {
  it('counts every awaiting stage, not just pending', () => {
    for (const s of STORE_REQ_WAITING) expect(isWaitingReq(s)).toBe(true);
  });
  it('excludes decided rows', () => {
    for (const s of ['approved', 'dispatched', 'received', 'rejected', null, '']) expect(isWaitingReq(s)).toBe(false);
  });
});
