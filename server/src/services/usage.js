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
import {KitchenStation, MenuItem, User} from '../models/index.js';
import {Branch, Customer, Order, Restaurant, RestaurantTable} from '../models/operations.js';

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

/**
 * P2G.3 — kitchen stations a tenant CREATED, which is what `maxStations` sells.
 *
 * TWO EXCLUSIONS, both deliberate.
 *
 * `builtIn: false` — eleven built-in stations are auto-seeded per restaurant
 * on first read. Starter allows 2 and professional 8, so counting the seeded
 * set would put every tenant on those plans permanently over quota without
 * them doing anything. The flag is persisted, not derived from the code,
 * because a built-in can be renamed into an arbitrary code (measured).
 *
 * MATCHING `false` EXPLICITLY, NOT `{$ne: true}`. My first version used
 * `{$ne: true}` and its own comment claimed that read pre-P2G.3 rows (which
 * carry no flag) as built-in. It does the OPPOSITE: in MongoDB a missing field
 * satisfies `$ne: true`, so every legacy station was counted as billable —
 * exactly the "existing tenants instantly over quota" outcome this exclusion
 * exists to prevent. The test caught it. Requiring `false` means a row must
 * have been explicitly written by `createStation()` to cost anything.
 *
 * `active: {$ne: false}` — deactivating a station (what DELETE actually does;
 * the row is kept because historical order lines still name it) hands the seat
 * back, so a kitchen that retires a station can create a replacement.
 *
 * NOTE the asymmetry with `getUserUsage()`, which counts deactivated accounts
 * on purpose. That is not an inconsistency: a disabled user still holds a
 * login and cycling `active` would otherwise mint unlimited accounts, whereas
 * a disabled station is inert and its code cannot be reused anyway (the unique
 * `{restaurant, code}` index still holds it).
 */
export async function getStationUsage(restaurantId, {session} = {}) {
  return KitchenStation.countDocuments({
    restaurant: asId(restaurantId),
    builtIn: false,
    active: {$ne: false}
  }).session(session || null);
}

/** Customers. P1 gave Customer a direct `restaurant`. */
export async function getCustomerUsage(restaurantId) {
  return Customer.countDocuments({restaurant: asId(restaurantId)});
}

/**
 * P2G.4 — WHICH ORDER STATUSES CONSUME MONTHLY QUOTA.
 *
 * The full enum on `Order.status` is:
 *
 *   draft, held, pending, confirmed, accepted, preparing, ready,
 *   out_for_delivery, completed, cancelled, refunded
 *
 * No status is invented here; this is exactly that list, partitioned.
 *
 * EXCLUDED — `cancelled`. P2F measured cancelled orders counting against the
 * monthly quota, which bills a tenant for work they did not do and, worse,
 * lets a mis-keyed and immediately voided ticket eat a paid order slot. A
 * cancelled order produced no revenue and reversed its inventory.
 *
 * INCLUDED — everything else, `refunded` deliberately among them. A refund is
 * a completed transaction that was later reversed for the customer: the
 * kitchen cooked it, the POS printed it, the platform carried it. Unlike a
 * cancellation it reached `completed` first (`ALLOWED_TRANSITIONS.completed`
 * is `['refunded']`, so `refunded` is only ever reachable from `completed`).
 * Excluding it would also hand every tenant an unlimited-orders loophole:
 * complete, refund, repeat.
 *
 * `draft` and `held` are counted too. They are real orders occupying real
 * capacity, and a tenant that parked every ticket in `held` would otherwise
 * pay for nothing. If that proves commercially wrong it is a pricing decision,
 * not a counting bug, and it belongs in a later phase with its own evidence.
 *
 * Frozen and exported so the enforcement phase (P2G.5) cannot drift to a
 * different definition of "countable" than the one metered here.
 */
export const QUOTA_EXCLUDED_ORDER_STATUSES = Object.freeze(['cancelled']);

export const QUOTA_COUNTABLE_ORDER_STATUSES = Object.freeze([
  'draft', 'held', 'pending', 'confirmed', 'accepted', 'preparing',
  'ready', 'out_for_delivery', 'completed', 'refunded'
]);

/**
 * The status predicate used by every monthly count.
 *
 * `$nin` rather than `$in`, deliberately. A status added to the enum in a
 * later phase then counts by DEFAULT — the safe direction commercially, and it
 * fails visibly (a tenant reports being over) rather than silently under-
 * billing forever. It also keeps the index prefix usable.
 */
const countableStatusFilter = {status: {$nin: QUOTA_EXCLUDED_ORDER_STATUSES}};

/**
 * Orders in the CURRENT calendar month, in the TENANT'S OWN timezone.
 *
 * Two defects from the P2F audit are fixed here, both measured:
 *
 *   1. the month boundary was hardcoded to `offsetMinutes = 345` (Kathmandu)
 *      while `Restaurant.timezone` already existed and was ignored. A tenant
 *      in `America/New_York` had their billing month roll over at 20:15 the
 *      previous day, local.
 *   2. cancelled orders counted. A dataset of two live and two cancelled
 *      orders reported 4.
 *
 * `now` and `timezone` stay injectable so the boundary can be tested without
 * waiting for a month to turn over.
 */
export async function getOrderUsage(restaurantId, {now = new Date(), timezone, session} = {}) {
  const zone = timezone || await restaurantTimezone(restaurantId);
  const {start, end} = monthWindow(now, zone);
  /**
   * P2G.8 — `session` is optional and defaults to no session, so every
   * existing caller is unchanged.
   *
   * It exists so cancellation reconciliation can count INSIDE the transaction
   * that is cancelling the order. Verified that a session-scoped count sees
   * the uncommitted status change (3 orders, one cancelled in-transaction:
   * inside the session the count is 2, outside it is still 3). Without the
   * session the reconciliation would read the pre-cancellation figure and
   * correct the counter to the wrong number.
   */
  return Order.countDocuments({
    restaurant: asId(restaurantId),
    createdAt: {$gte: start, $lt: end},
    ...countableStatusFilter
  }).session(session || null);
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
export async function getOnlineOrderUsage(
  restaurantId, {now = new Date(), timezone, session} = {}
) {
  const zone = timezone || await restaurantTimezone(restaurantId);
  const {start, end} = monthWindow(now, zone);
  return Order.countDocuments({
    restaurant: asId(restaurantId),
    source: 'online',
    createdAt: {$gte: start, $lt: end},
    // P2G.4 — the same exclusion as the overall count. A cancelled storefront
    // order must not consume the online allowance either.
    ...countableStatusFilter
    // P2G.8 — optional session, so a cancellation can count its own
    // uncommitted change. See `getOrderUsage`.
  }).session(session || null);
}

export const DEFAULT_TIMEZONE = 'Asia/Kathmandu';

/**
 * The tenant's IANA timezone, falling back to Kathmandu.
 *
 * The fallback is the schema default, so a restaurant that predates the field
 * or carries a blank keeps exactly the behaviour it had before P2G.4 rather
 * than silently jumping to UTC and shifting its billing month by 5h45m.
 */
export async function restaurantTimezone(restaurantId) {
  if (!restaurantId || !mongoose.isValidObjectId(String(restaurantId))) return DEFAULT_TIMEZONE;
  const row = await Restaurant.findById(asId(restaurantId)).select('timezone').lean();
  return normalizeTimezone(row?.timezone);
}

/**
 * A timezone this runtime can actually resolve.
 *
 * An unusable value must not throw on the billing path — that would take the
 * subscription screen down over a typo in a tenant record — so it degrades to
 * the default. Verified that `Intl.DateTimeFormat` throws `RangeError` for an
 * unknown zone rather than silently returning UTC.
 */
export function normalizeTimezone(timezone) {
  const wanted = String(timezone || '').trim();
  if (!wanted) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: wanted});
    return wanted;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * The offset, in minutes east of UTC, that `timezone` was at the instant
 * `date`.
 *
 * Computed from `Intl` rather than a stored number because the offset is NOT a
 * property of a zone — it is a property of a zone AT A MOMENT.
 * `America/New_York` is -300 in January and -240 in August. The old
 * `offsetMinutes = 345` constant could not express that at all.
 *
 * `formatToParts` with `timeZone` gives the wall-clock reading in that zone;
 * treating those fields as if they were UTC and differencing against the true
 * instant yields the offset. This is the standard technique and it needs no
 * timezone database of our own — Node ships full ICU (verified: Kathmandu
 * +5:45, Chatham +12:45, New York -4 in August).
 */
function offsetMinutesAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});

  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second
  );
  // Whole minutes: every real zone offset is a multiple of a minute, and the
  // seconds field is carried above only so the arithmetic cannot drift.
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** The wall-clock calendar date in `timeZone` at instant `date`. */
function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});
  return {year: parts.year, month: parts.month};
}

/**
 * The UTC instant at which local midnight begins the given month in `timeZone`.
 *
 * TWO PASSES, and the second is not decoration. The offset that applies at a
 * boundary can differ from the offset applying now — a tenant counting in
 * August must use August's offset for the start of August, not today's. So the
 * first pass guesses using the current offset, then the offset is re-read AT
 * that guess and the instant recomputed. A third pass would only matter if a
 * zone changed offset within the few hours around its own month boundary,
 * which no real zone does (DST shifts happen mid-month or on a Sunday, never
 * at 00:00 on the 1st in a way that is not already resolved by pass two).
 */
function startOfMonthUtc(year, month, timeZone) {
  const naive = Date.UTC(year, month - 1, 1, 0, 0, 0);
  const firstGuess = new Date(naive - offsetMinutesAt(new Date(naive), timeZone) * 60_000);
  const settled = new Date(naive - offsetMinutesAt(firstGuess, timeZone) * 60_000);
  return settled;
}

/**
 * The UTC instants bounding the local calendar month containing `now`.
 *
 * Exported for testing, because an off-by-one here silently mis-bills a whole
 * tenant for a whole month and is invisible until somebody complains.
 *
 * P2G.4: the second argument is now an IANA TIMEZONE NAME, not a fixed offset
 * in minutes. The old signature `monthWindow(now, 345)` could only ever
 * describe Kathmandu and was applied to every tenant regardless of
 * `Restaurant.timezone`.
 */
/**
 * P2G.5 — a stable `YYYY-MM` label for the tenant's CURRENT local month.
 *
 * The monthly quota counter is scoped by this, so the counter for September is
 * a different document from August's and the allowance resets by construction
 * rather than by a sweep job that has to run on time in every timezone.
 *
 * Derived from the same `localParts()` the window uses, so a label and a
 * window can never disagree about which month it is.
 */
export function monthKey(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const {year, month} = localParts(now, normalizeTimezone(timezone));
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function monthWindow(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const zone = normalizeTimezone(timezone);
  const {year, month} = localParts(now, zone);
  const start = startOfMonthUtc(year, month, zone);
  /**
   * The December branch is REDUNDANT and kept only for readability.
   * `Date.UTC(2026, 12, 1)` already normalises to 2027-01-01, so
   * `startOfMonthUtc(year, 13)` and `startOfMonthUtc(year + 1, 1)` are the
   * same instant — proven, and the reason a mutant collapsing this to the
   * single-expression form survives the suite. It is an equivalent mutant, not
   * a coverage gap: no observable behaviour distinguishes them.
   */
  const end = month === 12
    ? startOfMonthUtc(year + 1, 1, zone)
    : startOfMonthUtc(year, month + 1, zone);
  return {start, end};
}

/**
 * Everything at once, for the subscription screens.
 *
 * Issued in parallel — this is a read-path call for a dashboard, not the write
 * path, so the extra round trips are acceptable in exchange for one call site.
 */
export async function getUsageSummary(restaurantId) {
  // P2G.4 — resolved ONCE and passed down. Both monthly counts need the
  // tenant's zone, and letting each fetch it would issue the same lookup twice
  // and could, across a month boundary, use two different answers in one
  // summary.
  const timezone = await restaurantTimezone(restaurantId);
  const [branches, users, menuItems, tables, customers, orders, onlineOrders, stations]
    = await Promise.all([
      getBranchUsage(restaurantId),
      getUserUsage(restaurantId),
      getMenuItemUsage(restaurantId),
      getTableUsage(restaurantId),
      getCustomerUsage(restaurantId),
      getOrderUsage(restaurantId, {timezone}),
      getOnlineOrderUsage(restaurantId, {timezone}),
      getStationUsage(restaurantId)
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
    // P2G.3 — now metered. Counts tenant-created, active stations only; the
    // auto-seeded built-ins are free and do not appear here.
    maxStations: stations
  };
}
