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
 * "My approvals": what is waiting on MY decision (for someone who decides) plus
 * the requests I raised. Filtering only on raised_by left a Unit Head's own
 * queue empty.
 */
export function isMyApproval(
  row: { status: string | null | undefined; raised_by?: string | null },
  me: { name: string; canDecide: boolean },
): boolean {
  if ((row.raised_by || '') === me.name) return true;
  return me.canDecide && row.status === 'pending';
}
