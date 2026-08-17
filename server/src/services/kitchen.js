import mongoose from 'mongoose';
/** Kitchen / order status rules. Inventory is never deducted here — only reversed on cancel/refund. */

export const KITCHEN_QUEUE_STATUSES = ['pending', 'confirmed', 'accepted', 'preparing', 'ready'];

/** Allowed next statuses from each current status. Skip-ahead and backwards moves are invalid. */
export const ALLOWED_TRANSITIONS = {
  draft: ['pending', 'held', 'cancelled'],
  held: ['pending', 'cancelled'],
  pending: ['confirmed', 'accepted', 'cancelled'],
  confirmed: ['accepted', 'preparing', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'out_for_delivery'],
  out_for_delivery: ['completed'],
  completed: ['refunded'],
  cancelled: [],
  refunded: []
};

export function canTransition(from, to) {
  if (!from || !to) return false;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

export function assertOrderTransition(from, to) {
  if (!to) {
    const err = new Error('Status is required');
    err.status = 400;
    throw err;
  }
  if (!canTransition(from, to)) {
    const err = new Error(`Invalid status transition from ${from} to ${to}`);
    err.status = 409;
    throw err;
  }
}

/**
 * Branch-level check ONLY. Does not verify the branch belongs to the caller's
 * restaurant, because it is synchronous and cannot query.
 *
 * Prefer assertTenantBranchAccess() for anything reachable from an HTTP
 * request. This remains exported for the pure branch comparison and is still
 * used as the first step inside the tenant-aware guard.
 */
export function assertBranchAccess(user, branchId) {
  if (!branchId) {
    const err = new Error('Branch is required');
    err.status = 400;
    throw err;
  }
  if (!user) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }
  if (user.role === 'owner') return;
  if (user.branch && String(user.branch) !== String(branchId)) {
    const err = new Error('Branch access denied');
    err.status = 403;
    throw err;
  }
}

export function kitchenActionFor(status) {
  if (status === 'pending' || status === 'confirmed') return {next: 'accepted', label: 'Accept'};
  if (status === 'accepted') return {next: 'preparing', label: 'Start preparing'};
  if (status === 'preparing') return {next: 'ready', label: 'Mark ready'};
  if (status === 'ready') return {next: 'completed', label: 'Complete'};
  return null;
}


/**
 * Tenant + branch authorization for branch-scoped resources.
 *
 * The rule enforced is: user -> restaurant -> branch -> resource must all be
 * compatible. An owner has broad access INSIDE their own restaurant but can
 * never cross the restaurant boundary; managers and staff remain pinned to
 * their assigned branch by assertBranchAccess().
 *
 * This mirrors the semantics purchaseBranchContext() already applies on the
 * purchasing/inventory side, so both halves of the system agree.
 */
export async function assertTenantBranchAccess(user, branchId, {session} = {}) {
  assertBranchAccess(user, branchId);
  const {Branch} = await import('../models/operations.js');
  const {userRestaurantContext} = await import('./supplierCatalog.js');

  if (!mongoose.isValidObjectId(branchId)) {
    const err = new Error('Invalid branch');
    err.status = 400;
    throw err;
  }
  const branch = await Branch.findById(branchId).select('restaurant').session(session || null).lean();
  if (!branch) {
    const err = new Error('Branch not found');
    err.status = 404;
    throw err;
  }
  const {restaurantId} = await userRestaurantContext(user, {session});
  if (!restaurantId || String(branch.restaurant) !== String(restaurantId)) {
    const err = new Error('Branch does not belong to the user restaurant');
    err.status = 403;
    throw err;
  }
  return branch;
}
