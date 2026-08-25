/**
 * P2C — usage measurement.
 *
 * Answers "how many of X does this restaurant already have?" so the limit
 * checks have something to compare against.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * These run on the WRITE path — every branch, user, menu item and table
 * creation calls one. So each is a `countDocuments` against an indexed field,
 * not an aggregation over documents, and never a full collection scan.
 *
 * For ~100 tenants the totals are small (tens to low hundreds per tenant) and
 * a counted index is comfortably fast. A denormalised counter on `Restaurant`
 * would be faster still and is the obvious next step at 10,000 tenants, but it
 * introduces a drift class — counter says 4, reality says 5 — that has to be
 * reconciled. Correctness first; the query pattern here is simple enough to
 * swap later without touching any caller.
 *
 * TENANT SCOPING IS THE POINT
 * ---------------------------
 * Every count below is scoped to one restaurant. A count that accidentally
 * spanned tenants would let a large tenant's usage block a small one, and would
 * leak the platform's size through an error message. `RestaurantTable` has no
 * `restaurant` field — it hangs off `branch` — so its count resolves the
 * tenant's branches first rather than guessing.
 */
import mongoose from 'mongoose';
import {MenuItem, User} from '../models/index.js';
import {Branch, Customer, Order, RestaurantTable} from '../models/operations.js';

const asId = value => new mongoose.Types.ObjectId(String(value));

/** Branches belonging to a restaurant. Indexed on `Branch.restaurant`. */
export async function getBranchUsage(restaurantId) {
  return Branch.countDocuments({restaurant: asId(restaurantId)});
}

/**
 * User accounts in a restaurant.
 *
 * Counts EVERY account including deactivated ones, deliberately: a deactivated
 * employee still occupies a seat in the commercial sense, and the alternative
 * lets a tenant hold unlimited accounts by cycling `active`. `role` breakdowns
 * are returned alongside so the per-role limits do not need four more queries.
 */
export async function getUserUsage(restaurantId) {
  const rows = await User.aggregate([
    {$match: {restaurantId: asId(restaurantId)}},
    {$group: {_id: '$role', n: {$sum: 1}}}
  ]);
  const byRole = {owner: 0, manager: 0, staff: 0, rider: 0};
  let total = 0;
  for (const row of rows) {
    total += row.n;
    if (row._id in byRole) byRole[row._id] += row.n;
  }
  return {total, ...byRole};
}

/** Menu items. Indexed on `MenuItem.restaurant`. */
export async function getMenuItemUsage(restaurantId) {
  return MenuItem.countDocuments({restaurant: asId(restaurantId)});
}

/**
 * Tables across all of a restaurant's branches.
 *
 * `RestaurantTable` is branch-scoped with no tenant field, so this resolves
 * the branch ids first. Two queries rather than one, and it is honest about
 * the schema instead of assuming a field that is not there.
 */
export async function getTableUsage(restaurantId) {
  const branches = await Branch.find({restaurant: asId(restaurantId)}).select('_id').lean();
  if (!branches.length) return 0;
  return RestaurantTable.countDocuments({branch: {$in: branches.map(row => row._id)}});
}

/** Customers. P1 gave Customer a direct `restaurant`. */
export async function getCustomerUsage(restaurantId) {
  return Customer.countDocuments({restaurant: asId(restaurantId)});
}

/**
 * Orders in the CURRENT calendar month.
 *
 * Month boundaries are computed in the tenant's own timezone offset — Nepal is
 * UTC+05:45, so a naive UTC month boundary would count a 5:45am order on the
 * 1st into the previous month and make a monthly quota reset at the wrong
 * moment. `Order.restaurant` is direct since P1 and indexed, so this is a
 * two-field range count.
 */
export async function getOrderUsage(restaurantId, {now = new Date(), offsetMinutes = 345} = {}) {
  const {start, end} = monthWindow(now, offsetMinutes);
  return Order.countDocuments({
    restaurant: asId(restaurantId),
    createdAt: {$gte: start, $lt: end}
  });
}

/**
 * Online (storefront) orders this month, for the separate online quota.
 *
 * The discriminator is `Order.source`, which is an indexed enum of
 * `['pos','online']`. My first attempt filtered on a `channel` field that does
 * not exist — Mongoose `strict: true` STRIPS unknown query paths, so that
 * filter would have been silently dropped and this would have counted every
 * order as online. Checked against the schema rather than assumed.
 */
export async function getOnlineOrderUsage(restaurantId, {now = new Date(), offsetMinutes = 345} = {}) {
  const {start, end} = monthWindow(now, offsetMinutes);
  return Order.countDocuments({
    restaurant: asId(restaurantId),
    source: 'online',
    createdAt: {$gte: start, $lt: end}
  });
}

/**
 * The UTC instants bounding the local calendar month containing `now`.
 *
 * Exported for testing, because an off-by-one here silently mis-bills a whole
 * tenant for a whole month and is invisible until somebody complains.
 */
export function monthWindow(now = new Date(), offsetMinutes = 345) {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const startLocal = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  const endLocal = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1);
  return {
    start: new Date(startLocal - offsetMinutes * 60_000),
    end: new Date(endLocal - offsetMinutes * 60_000)
  };
}

/**
 * Everything at once, for the subscription screens.
 *
 * Issued in parallel — this is a read-path call for a dashboard, not the write
 * path, so the extra round trips are acceptable in exchange for one call site.
 */
export async function getUsageSummary(restaurantId) {
  const [branches, users, menuItems, tables, customers, orders, onlineOrders] = await Promise.all([
    getBranchUsage(restaurantId),
    getUserUsage(restaurantId),
    getMenuItemUsage(restaurantId),
    getTableUsage(restaurantId),
    getCustomerUsage(restaurantId),
    getOrderUsage(restaurantId),
    getOnlineOrderUsage(restaurantId)
  ]);
  return {
    maxBranches: branches,
    maxUsers: users.total,
    maxManagers: users.manager,
    maxStaff: users.staff,
    maxRiders: users.rider,
    maxMenuItems: menuItems,
    maxTables: tables,
    maxCustomers: customers,
    maxMonthlyOrders: orders,
    maxMonthlyOnlineOrders: onlineOrders,
    // Not yet metered. Reported as null rather than 0 so a screen does not
    // claim "0 of 5 used" for something nothing counts.
    maxStations: null
  };
}
