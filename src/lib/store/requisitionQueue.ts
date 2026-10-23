/**
 * "Waiting for approval" — ONE definition for every screen that counts or lists
 * store requisitions awaiting a decision: the Overview "Pending Approvals" tile,
 * the table under it, its "View all" link and Store Req's ?queue=pending view.
 * They must also share the plant scope (scopeQuery with unitCol 'unit_id'), so
 * an owner who sees 0 on Overview sees 0 rows behind "View all".
 *
 * Includes the stage-specific statuses some deployments use alongside the
 * plain 'pending' (store check, buyer, named approver).
 */
export const STORE_REQ_WAITING = ['pending', 'pending_store', 'pending_approval', 'pending_vijay', 'pending_buyer'] as const;

export const STORE_REQ_QUEUE_ROUTE = '/dashboard/purchase/storereq?queue=pending';

export function isWaitingReq(status: string | null | undefined): boolean {
  return !!status && (STORE_REQ_WAITING as readonly string[]).includes(status);
}

/** Scope options every requisition query uses (same as the Store Req list). */
export const STORE_REQ_SCOPE = { unitCol: 'unit_id' } as const;

/** Unit Head / Management / admin (or anyone allowed to manage users) decide requisitions. */
export function canDecideStoreReq(profile: { id: string; baseRoleId?: string | null; capabilities?: string[] | null }, isAdmin: boolean): boolean {
  return isAdmin
    || [profile.id, profile.baseRoleId].some(id => id === 'unit_head' || id === 'management')
    || (profile.capabilities || []).includes('manage_users');
}

/**
 * Owner/Admin can override-approve, but plant Unit Head / Store is the actual
 * queue. Do not dump every pending row into the owner's "My approvals".
 */
export function waitingCountsAsMyQueue(
  profile: { id: string; baseRoleId?: string | null; capabilities?: string[] | null },
  isAdmin: boolean,
): boolean {
  if (isAdmin) return false;
  return canDecideStoreReq(profile, false);
}

/**
 * "My approvals": requests I raised, plus (for a plant decider) what is waiting
 * on that role. Owner/admin pass waitingIsMine: false so they only see rows they
 * personally raised.
 */
export function isMyApproval(
  row: { status: string | null | undefined; raised_by?: string | null },
  me: { name: string; canDecide: boolean; waitingIsMine?: boolean },
): boolean {
  if ((row.raised_by || '') === me.name) return true;
  if (me.waitingIsMine === false) return false;
  return me.canDecide && isWaitingReq(row.status);
}
