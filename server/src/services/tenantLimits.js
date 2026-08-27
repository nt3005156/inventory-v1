/**
 * P2C — limit guards for resources created inline in route handlers.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Users and menu items are created by services (`createStaffAccount`,
 * `createMenuItem`), so their limit checks live inside those services and every
 * caller is covered automatically.
 *
 * Branches and tables are created INLINE in their route handlers — there is no
 * service function to put the check in. Rather than leave the enforcement in
 * the route (where it is invisible to unit tests and easy to bypass by adding a
 * second caller), the decision is extracted here. The route calls a named guard
 * that is independently testable and states its own rule.
 *
 * That keeps the invariant the brief requires: **the decision is made in a
 * service, not in a route**, even for resources whose creation is not yet
 * service-wrapped.
 *
 * Each guard throws a 402 with `billing: true`. It never returns a boolean the
 * caller might forget to check — an ignored return value is how a limit stops
 * being a limit.
 */
import mongoose from 'mongoose';
import {Branch} from '../models/operations.js';
import {assertWithinLimit, billingEnforcementActive, getLimit} from './entitlements.js';
import {withQuota} from './quotaGuard.js';
import {getBranchUsage, getTableUsage} from './usage.js';

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * May this restaurant add another branch?
 *
 * `restaurantId` must already have been resolved from the authenticated
 * principal by the caller. This function does not authorize ownership — it
 * answers the commercial question only, and is called after the tenant check.
 */
export async function assertBranchCreationAllowed(restaurantId) {
  if (!restaurantId || !mongoose.isValidObjectId(restaurantId)) {
    throw httpError('Restaurant not found', 404);
  }
  const usage = await getBranchUsage(restaurantId);
  return assertWithinLimit(restaurantId, 'maxBranches', usage, {label: 'branches'});
}

/**
 * P2E — create a branch under an ATOMIC quota reservation.
 *
 * `assertBranchCreationAllowed()` above is check-then-act and was measured
 * letting 5 concurrent requests past a limit of 2. It is kept because other
 * callers use it as a pre-flight check, but the CREATE path now goes through
 * a conditional write that cannot be raced.
 *
 * Respects `billingEnforcementActive()` for the same reason P2C introduced
 * that gate: a deployment with no plan catalogue must behave exactly as it did
 * before, or upgrading bricks every tenant.
 */
export async function createBranchWithinQuota(restaurantId, create) {
  if (!restaurantId || !mongoose.isValidObjectId(restaurantId)) {
    throw httpError('Restaurant not found', 404);
  }
  if (!await billingEnforcementActive()) return create();

  return withQuota({
    restaurantId,
    resource: 'branches',
    limit: await getLimit(restaurantId, 'maxBranches'),
    countActual: () => getBranchUsage(restaurantId),
    label: 'branches'
  }, create);
}

/** The same protection for tables, resolved from the branch's tenant. */
export async function createTableWithinQuota(branchId, create) {
  if (!branchId || !mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  const branch = await Branch.findById(branchId).select('restaurant').lean();
  if (!branch?.restaurant) throw httpError('Branch not found', 404);
  if (!await billingEnforcementActive()) return create();

  return withQuota({
    restaurantId: branch.restaurant,
    resource: 'tables',
    limit: await getLimit(branch.restaurant, 'maxTables'),
    countActual: () => getTableUsage(branch.restaurant),
    label: 'tables'
  }, create);
}

/**
 * May this branch's restaurant add another table?
 *
 * Takes a BRANCH id because that is what the table route has, and resolves the
 * tenant from it. The caller has already proven the branch belongs to them via
 * `assertTableBranchAccess()`; resolving the tenant here rather than trusting a
 * passed-in restaurant id means this guard cannot be pointed at another
 * tenant's quota even if a future caller forgets that check.
 */
export async function assertTableCreationAllowed(branchId) {
  if (!branchId || !mongoose.isValidObjectId(branchId)) {
    throw httpError('Invalid branch', 400);
  }
  const branch = await Branch.findById(branchId).select('restaurant').lean();
  if (!branch?.restaurant) throw httpError('Branch not found', 404);

  const usage = await getTableUsage(branch.restaurant);
  return assertWithinLimit(branch.restaurant, 'maxTables', usage, {label: 'tables'});
}
