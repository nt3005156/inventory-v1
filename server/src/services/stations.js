import mongoose from 'mongoose';
import {KitchenStation} from '../models/index.js';
import {billingEnforcementActive, getLimit} from './entitlements.js';
import {releaseQuota, withQuota} from './quotaGuard.js';
import {getStationUsage} from './usage.js';

// Phase 5C — kitchen stations.
//
// Stations are defined per restaurant so a kitchen can describe its own
// sections (a momo counter, a pizza oven) rather than being held to one global
// list. The built-in set below is what a restaurant starts with; it is a seed,
// not a limit.

export const DEFAULT_STATION_CODE = 'kitchen';

export const BUILT_IN_STATIONS = Object.freeze([
  {code: 'kitchen', name: 'Kitchen', sortOrder: 10, isDefault: true, categories: ['main', 'side', 'set', 'other']},
  {code: 'grill', name: 'Grill', sortOrder: 20, categories: ['grill', 'bbq', 'sekuwa']},
  {code: 'fry', name: 'Fry', sortOrder: 30, categories: ['fried', 'snacks']},
  {code: 'tandoor', name: 'Tandoor', sortOrder: 40, categories: ['tandoori', 'bread', 'roti', 'naan']},
  {code: 'curry', name: 'Curry', sortOrder: 50, categories: ['curry', 'biryani']},
  {code: 'cold', name: 'Cold / Salad', sortOrder: 60, categories: ['salad', 'appetizer', 'cold']},
  {code: 'bakery', name: 'Bakery', sortOrder: 70, categories: ['bakery', 'pastry', 'bread']},
  {code: 'dessert', name: 'Dessert', sortOrder: 80, categories: ['dessert', 'sweets', 'ice cream']},
  {code: 'beverage', name: 'Beverage', sortOrder: 90, categories: ['beverage', 'drinks', 'tea', 'coffee', 'juice']},
  {code: 'bar', name: 'Bar', sortOrder: 100, categories: ['bar', 'cocktail', 'alcohol', 'beer']},
  {code: 'expo', name: 'Expo / Pass', sortOrder: 110, categories: []}
]);

export const BUILT_IN_STATION_CODES = Object.freeze(BUILT_IN_STATIONS.map(s => s.code));

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();
export const stationCode = value => clean(value).toLowerCase();

/** A station code is a short slug: letters, numbers, hyphen, underscore. */
export function assertStationCode(code) {
  const value = stationCode(code);
  if (!value) throw httpError('Station code is required', 400);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) {
    throw httpError('Station code may use lowercase letters, numbers, hyphen and underscore', 400);
  }
  return value;
}

/**
 * Returns the restaurant's stations, seeding the built-in set on first use.
 *
 * Seeding lazily means existing restaurants gain stations without a migration
 * step, and a kitchen that never customises anything still gets a sensible
 * board out of the box.
 */
export async function listStations({restaurantId, includeInactive = false, session} = {}) {
  if (!restaurantId) throw httpError('Restaurant is required', 400);
  const existing = await KitchenStation.find({restaurant: restaurantId}).session(session || null).sort({sortOrder: 1, code: 1});
  if (existing.length) {
    return includeInactive ? existing : existing.filter(s => s.active !== false);
  }
  const seeded = await KitchenStation.insertMany(
    // P2G.3: `builtIn` marks these as free of `maxStations`. Persisted at seed
    // time because a built-in can later be renamed, after which nothing else
    // could tell it apart from a station the tenant created.
    BUILT_IN_STATIONS.map(s => ({
      ...s, restaurant: restaurantId, isDefault: Boolean(s.isDefault), builtIn: true
    })),
    {session: session || undefined}
  );
  return seeded.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Resolves a station code against the restaurant's own list. */
export async function resolveStation({restaurantId, code, session}) {
  const wanted = stationCode(code);
  if (!wanted) return null;
  const stations = await listStations({restaurantId, includeInactive: true, session});
  const found = stations.find(s => s.code === wanted);
  if (!found) {
    const available = stations.filter(s => s.active !== false).map(s => s.code).join(', ');
    throw httpError(`Unknown station "${wanted}". Available: ${available}`, 400);
  }
  if (found.active === false) throw httpError(`Station "${wanted}" is not active`, 409);
  return found.code;
}

export function defaultStationOf(stations = []) {
  const flagged = stations.find(s => s.isDefault && s.active !== false);
  if (flagged) return flagged.code;
  const fallback = stations.find(s => s.code === DEFAULT_STATION_CODE && s.active !== false);
  return fallback ? fallback.code : (stations.find(s => s.active !== false)?.code || DEFAULT_STATION_CODE);
}

/**
 * Routes a menu item to a station.
 *
 * Precedence, most specific first:
 *   1. an explicit station on the menu item — always wins
 *   2. a station whose category list claims the item's menu category
 *   3. the restaurant's default station
 *
 * The category tier means an existing menu routes sensibly the moment stations
 * are switched on, instead of every ticket landing on one board.
 */
export function routeItemToStation(menuItem, stations = []) {
  const active = stations.filter(s => s.active !== false);
  const explicit = stationCode(menuItem?.station);
  if (explicit && active.some(s => s.code === explicit)) return explicit;

  const category = stationCode(menuItem?.category);
  if (category) {
    const byCategory = active.find(s => (s.categories || []).some(c => stationCode(c) === category));
    if (byCategory) return byCategory.code;
  }
  return defaultStationOf(active);
}

/** Convenience wrapper that loads the restaurant's stations first. */
export async function stationForMenuItem({menuItem, restaurantId, session}) {
  const stations = await listStations({restaurantId, includeInactive: true, session});
  return routeItemToStation(menuItem, stations);
}

function normalizeInput(input = {}) {
  const code = assertStationCode(input.code);
  const name = clean(input.name) || code;
  if (name.length > 80) throw httpError('Station name must be 80 characters or fewer', 400);
  const categories = [...new Set((input.categories || []).map(stationCode).filter(Boolean))];
  if (categories.length > 50) throw httpError('A station may map at most 50 categories', 400);
  return {
    code,
    name,
    categories,
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
    active: input.active !== false
  };
}

/**
 * P2G.3 — create a station under an ATOMIC quota reservation.
 *
 * THE DEFECT THIS CLOSES, MEASURED. `maxStations` had no usage counter at all
 * and was enforced nowhere: with a ceiling of 2, four sequential creates all
 * returned 201, and six concurrent creates produced six stations on every one
 * of eight trials (6,6,6,6,6,6,6,6).
 *
 * THE RESERVATION JOINS THE CALLER'S TRANSACTION.
 * ----------------------------------------------
 * The route already wraps station creation in `session.withTransaction()`, and
 * the brief is explicit that this must not be weakened. So rather than
 * reserving outside the transaction, `reserveQuota` now accepts a `session`
 * and the counter increment becomes part of the same atomic unit as the insert
 * and its audit row. Two consequences, both wanted:
 *
 *   station insert fails  -> the transaction aborts and the increment is
 *                            rolled back WITH it. No leaked seat, and no
 *                            compensating release that would double-decrement
 *                            (see the `!session` guard in `withQuota`).
 *   reservation refused   -> a 402 is thrown before the insert, the
 *                            transaction never commits, no station is written.
 *
 * That is why the single-document conditional write still works here: it is
 * atomic on its own, and the transaction only decides whether it survives.
 *
 * `withQuota`, not `withCompoundQuota`: a station consumes exactly one
 * ceiling. Same reasoning as P2G.2.
 */
export async function createStation({restaurantId, input, user, session}) {
  const data = normalizeInput(input);
  // Seeds the built-ins on first use. Deliberately BEFORE the reservation:
  // the seeded rows are `builtIn` and free, so this cannot consume the seat
  // the tenant is about to reserve.
  await listStations({restaurantId, includeInactive: true, session});
  const clash = await KitchenStation.findOne({restaurant: restaurantId, code: data.code}).session(session || null);
  if (clash) throw httpError(`Station "${data.code}" already exists`, 409);

  const insert = async () => {
    const [created] = await KitchenStation.create([{
      ...data, restaurant: restaurantId, isDefault: false, builtIn: false, createdBy: user?.id
    }], {session: session || undefined});
    return created;
  };

  // Gated exactly as every other quota is: a deployment with no plan
  // catalogue must behave as it did before, or a restart refuses every
  // station on the platform.
  if (!await billingEnforcementActive()) return insert();

  return withQuota({
    restaurantId,
    resource: 'stations',
    limit: await getLimit(restaurantId, 'maxStations'),
    countActual: () => getStationUsage(restaurantId, {session}),
    label: 'kitchen stations',
    session: session || null
  }, insert);
}

export async function updateStation({restaurantId, stationId, patch, user, session}) {
  if (!mongoose.isValidObjectId(stationId)) throw httpError('Invalid station', 400);
  const station = await KitchenStation.findOne({_id: stationId, restaurant: restaurantId}).session(session || null);
  if (!station) throw httpError('Station not found', 404);

  if (patch.code !== undefined) {
    const code = assertStationCode(patch.code);
    if (code !== station.code) {
      const clash = await KitchenStation.findOne({restaurant: restaurantId, code}).session(session || null);
      if (clash) throw httpError(`Station "${code}" already exists`, 409);
      station.code = code;
    }
  }
  if (patch.name !== undefined) station.name = clean(patch.name) || station.code;
  if (patch.categories !== undefined) {
    station.categories = [...new Set((patch.categories || []).map(stationCode).filter(Boolean))];
  }
  if (patch.sortOrder !== undefined) station.sortOrder = Number(patch.sortOrder) || 0;
  /**
   * P2G.3 — toggling `active` moves a seat, so it goes through the quota.
   *
   * Deactivating frees the seat; REACTIVATING must therefore buy it back, or a
   * tenant on a ceiling of 2 could deactivate, create a replacement, reactivate
   * the old one and hold three. Reactivation is a create in disguise and is
   * gated like one.
   *
   * Built-ins are free in both directions, so they never touch the counter.
   */
  const wasActive = station.active !== false;
  let reactivating = false;
  if (patch.active !== undefined) {
    // The default station is where unrouted items land, so it must stay live.
    if (patch.active === false && station.isDefault) {
      throw httpError('The default station cannot be deactivated', 409);
    }
    station.active = Boolean(patch.active);
    reactivating = !wasActive && station.active === true;
  }
  station.updatedBy = user?.id;

  /**
   * `=== false`, not `!== true`. A pre-P2G.3 row carries no flag at all, and
   * `!== true` would treat it as billable — releasing a seat it never held
   * (driving the counter below reality) or charging for reactivating it. Only
   * a station explicitly written as `builtIn: false` by `createStation()`
   * participates in the quota. Same rule as `getStationUsage()`.
   */
  const countsAgainstQuota = station.builtIn === false && await billingEnforcementActive();
  const deactivating = wasActive && station.active === false;

  const persist = async () => {
    await station.save({session: session || undefined});
    return station;
  };

  if (countsAgainstQuota && reactivating) {
    // `getStationUsage` does not yet see this row (still inactive in the
    // database), so reserving one seat is exactly right.
    return withQuota({
      restaurantId,
      resource: 'stations',
      limit: await getLimit(restaurantId, 'maxStations'),
      countActual: () => getStationUsage(restaurantId, {session}),
      label: 'kitchen stations',
      session: session || null
    }, persist);
  }

  await persist();
  if (countsAgainstQuota && deactivating) {
    // AFTER the save, and inside the caller's transaction: if the save had
    // failed the seat was never surrendered, and if the transaction later
    // aborts this decrement is rolled back with it.
    await releaseQuota({restaurantId, resource: 'stations', session: session || null});
  }
  return station;
}

/** Moves the default flag, keeping exactly one default per restaurant. */
export async function setDefaultStation({restaurantId, stationId, user, session}) {
  if (!mongoose.isValidObjectId(stationId)) throw httpError('Invalid station', 400);
  const station = await KitchenStation.findOne({_id: stationId, restaurant: restaurantId}).session(session || null);
  if (!station) throw httpError('Station not found', 404);
  if (station.active === false) throw httpError('An inactive station cannot be the default', 409);
  await KitchenStation.updateMany(
    {restaurant: restaurantId, _id: {$ne: station._id}},
    {$set: {isDefault: false}},
    {session: session || undefined}
  );
  station.isDefault = true;
  station.updatedBy = user?.id;
  await station.save({session: session || undefined});
  return station;
}

export async function deleteStation({restaurantId, stationId, session}) {
  if (!mongoose.isValidObjectId(stationId)) throw httpError('Invalid station', 400);
  const station = await KitchenStation.findOne({_id: stationId, restaurant: restaurantId}).session(session || null);
  if (!station) throw httpError('Station not found', 404);
  if (station.isDefault) throw httpError('The default station cannot be removed', 409);
  // Deactivated rather than deleted: historical order lines still name it.
  const wasActive = station.active !== false;
  station.active = false;
  await station.save({session: session || undefined});

  /**
   * P2G.3 — retiring a station hands its seat back.
   *
   * Guarded on `wasActive` so deleting an already-inactive station twice
   * cannot release two seats for one row — that would drive the counter below
   * reality, and reconciliation only raises it (`$max`).
   *
   * A caveat this does NOT solve, and should not pretend to: the unique
   * `{restaurant, code}` index still holds the retired code, so the freed seat
   * can only be spent on a DIFFERENT code until a real delete or code-reuse
   * path exists. That is existing behaviour and out of scope here.
   */
  if (wasActive && station.builtIn === false && await billingEnforcementActive()) {
    await releaseQuota({restaurantId, resource: 'stations', session: session || null});
  }
  return station;
}
