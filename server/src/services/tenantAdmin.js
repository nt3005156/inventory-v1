/**
 * P2A — restaurant (tenant) administration and lifecycle.
 *
 * Two audiences, deliberately kept apart:
 *
 *   PLATFORM OPERATORS  create, list and change the STATUS of any restaurant.
 *                       Authority comes from `User.platformRole`, never from
 *                       tenant RBAC — see services/platformAccess.js for why.
 *
 *   RESTAURANT OWNERS   read and edit their OWN restaurant's profile. They can
 *                       never list, read or modify another, and they can never
 *                       change their own lifecycle status: a tenant must not
 *                       be able to un-suspend itself.
 *
 * The status enum is the one P1 already defined (`TENANT_STATUSES`); nothing
 * new was invented. The brief's "inactive" maps to the existing `cancelled`,
 * which already means "no longer trading on the platform".
 */
import mongoose from 'mongoose';
import {Audit, User} from '../models/index.js';
import {Branch, Restaurant, TENANT_STATUSES} from '../models/operations.js';
import {hasPlatformPermission} from './platformAccess.js';
import {userRestaurantContext} from './supplierCatalog.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * Statuses that may still use the product.
 *
 * `trial` and `active` trade normally. `suspended` (non-payment, abuse) and
 * `cancelled` (left the platform) must not. Kept as data rather than scattered
 * `if` checks so the rule has exactly one definition.
 */
export const OPERATIONAL_TENANT_STATUSES = Object.freeze(['trial', 'active']);

export function isTenantOperational(status) {
  return OPERATIONAL_TENANT_STATUSES.includes(String(status || 'active'));
}

/**
 * Load the stored user WITH the platform role.
 *
 * `platformRole` is `select: false`, so a normal read omits it. Authority is
 * always read from storage, never from the token — a forged claim grants
 * nothing.
 */
async function platformActor(user) {
  if (!user?.id) throw httpError('Authentication required', 401);
  const stored = await User.findById(user.id).select('+platformRole name email active role').lean();
  if (!stored) throw httpError('Authentication required', 401);
  return stored;
}

/**
 * Refuse anyone without the given platform permission.
 *
 * The failure is 403 and identical whether the caller is a restaurant owner, a
 * cashier or a rider: the platform surface must not confirm its own existence
 * differently to different tenant roles.
 */
async function assertPlatform(user, permission) {
  const actor = await platformActor(user);
  if (!hasPlatformPermission(actor, permission)) {
    throw httpError('Platform administration is not available to this account', 403);
  }
  return actor;
}

/** Public projection. Built by hand so a schema addition cannot leak silently. */
function tenantView(restaurant, counts = {}) {
  return {
    _id: restaurant._id,
    name: restaurant.name,
    slug: restaurant.slug || null,
    legalName: restaurant.legalName || null,
    status: restaurant.status || 'active',
    timezone: restaurant.timezone || null,
    currency: restaurant.currency || null,
    vatRate: restaurant.vatRate,
    pan: restaurant.pan || null,
    phone: restaurant.phone || null,
    address: restaurant.address || null,
    createdAt: restaurant.createdAt,
    updatedAt: restaurant.updatedAt,
    ...(counts.branches !== undefined ? {branchCount: counts.branches} : {}),
    ...(counts.users !== undefined ? {userCount: counts.users} : {}),
    ...(counts.owner !== undefined ? {owner: counts.owner} : {})
  };
}

/** Branch and user counts for a set of tenants, in two queries rather than 2N. */
async function countsFor(restaurantIds) {
  const [branches, users, owners] = await Promise.all([
    Branch.aggregate([
      {$match: {restaurant: {$in: restaurantIds}}},
      {$group: {_id: '$restaurant', n: {$sum: 1}}}
    ]),
    User.aggregate([
      {$match: {restaurantId: {$in: restaurantIds}}},
      {$group: {_id: '$restaurantId', n: {$sum: 1}}}
    ]),
    User.find({restaurantId: {$in: restaurantIds}, role: 'owner'})
      .select('name email restaurantId').sort({createdAt: 1}).lean()
  ]);
  const branchMap = new Map(branches.map(row => [String(row._id), row.n]));
  const userMap = new Map(users.map(row => [String(row._id), row.n]));
  const ownerMap = new Map();
  for (const owner of owners) {
    // First owner by creation wins: the founding account.
    if (!ownerMap.has(String(owner.restaurantId))) {
      ownerMap.set(String(owner.restaurantId), {
        _id: owner._id, name: owner.name, email: owner.email
      });
    }
  }
  return {branchMap, userMap, ownerMap};
}

// ── platform-side operations ─────────────────────────────────────────────────

/** Every restaurant on the platform. Platform operators only. */
export async function listRestaurants({user, status, q, page = 1, limit = 25}) {
  await assertPlatform(user, 'platform.restaurants.view');

  const filter = {};
  if (status) {
    const wanted = String(status).split(',').map(clean).filter(Boolean);
    for (const value of wanted) {
      if (!TENANT_STATUSES.includes(value)) throw httpError(`Unknown status: ${value}`, 400);
    }
    if (wanted.length) filter.status = {$in: wanted};
  }
  if (clean(q)) {
    // Escaped: a search term is text, never a pattern.
    const term = clean(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{name: new RegExp(term, 'i')}, {slug: new RegExp(term, 'i')}];
  }

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);

  const [rows, total] = await Promise.all([
    Restaurant.find(filter).sort({createdAt: -1}).skip((safePage - 1) * safeLimit)
      .limit(safeLimit).lean(),
    Restaurant.countDocuments(filter)
  ]);
  const {branchMap, userMap, ownerMap} = await countsFor(rows.map(row => row._id));

  return {
    restaurants: rows.map(row => tenantView(row, {
      branches: branchMap.get(String(row._id)) || 0,
      users: userMap.get(String(row._id)) || 0,
      owner: ownerMap.get(String(row._id)) || null
    })),
    pagination: {
      page: safePage, limit: safeLimit, total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    }
  };
}

/** One restaurant, by id. Platform operators only. */
export async function getRestaurantForPlatform({user, restaurantId}) {
  await assertPlatform(user, 'platform.restaurants.view');
  if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);
  const row = await Restaurant.findById(restaurantId).lean();
  // 404 rather than 400 for a malformed id too: the platform surface must not
  // let a caller distinguish "no such tenant" from "not a valid id shape".
  if (!row) throw httpError('Restaurant not found', 404);
  const {branchMap, userMap, ownerMap} = await countsFor([row._id]);
  return tenantView(row, {
    branches: branchMap.get(String(row._id)) || 0,
    users: userMap.get(String(row._id)) || 0,
    owner: ownerMap.get(String(row._id)) || null
  });
}

/**
 * Create a restaurant.
 *
 * The tenant only — no owner account, no branch. Full onboarding is P2H; doing
 * it here would duplicate a workflow that phase will own.
 */
export async function createRestaurant({user, input}) {
  const actor = await assertPlatform(user, 'platform.restaurants.create');

  const name = clean(input?.name);
  if (name.length < 2) throw httpError('A restaurant name is required', 400);
  const slug = clean(input?.slug).toLowerCase() || undefined;
  if (slug && !/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug)) {
    throw httpError('A slug must be lowercase letters, numbers and hyphens', 400);
  }
  if (slug && await Restaurant.findOne({slug})) {
    throw httpError('That slug is already taken', 409);
  }
  const status = clean(input?.status) || 'trial';
  if (!TENANT_STATUSES.includes(status)) throw httpError(`Unknown status: ${status}`, 400);

  const created = await Restaurant.create({
    name,
    slug,
    legalName: clean(input?.legalName) || undefined,
    status,
    timezone: clean(input?.timezone) || undefined,
    currency: clean(input?.currency) || undefined,
    vatRate: input?.vatRate ?? undefined,
    pan: clean(input?.pan) || undefined,
    phone: clean(input?.phone) || undefined,
    address: clean(input?.address) || undefined
  });

  await Audit.create({
    entity: 'restaurant', entityId: created._id, restaurant: created._id,
    action: 'platform_restaurant_created',
    after: {name: created.name, slug: created.slug || null, status: created.status},
    // P2B: denormalised actor identity. Without it the platform audit screen
    // showed a null actor name — an audit row that cannot say who acted is
    // most of the way to no audit row at all.
    user: actor._id, userName: actor.name, userRole: `platform:${actor.platformRole}`
  });
  return tenantView(created.toObject(), {branches: 0, users: 0, owner: null});
}

/**
 * Change a restaurant's PROFILE (not its status).
 *
 * Two callers, one implementation, different scope:
 *   - a platform operator may edit any restaurant;
 *   - a restaurant owner may edit only their own, and only with
 *     `settings.manage`, which is the permission that already governs
 *     restaurant settings elsewhere.
 *
 * `status` is refused on this path for BOTH. Lifecycle is a separate,
 * separately-audited decision — a tenant editing its own profile must not be
 * able to un-suspend itself by including a field.
 */
export async function updateRestaurant({user, restaurantId, input, viaPlatform = false}) {
  if (input && 'status' in input) {
    throw httpError('Status is changed through the lifecycle endpoints, not the profile', 400);
  }

  let actorId;
  let targetId;
  let actorIdentity = {};
  if (viaPlatform) {
    const actor = await assertPlatform(user, 'platform.restaurants.update');
    actorId = actor._id;
    actorIdentity = {userName: actor.name, userRole: `platform:${actor.platformRole}`};
    if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);
    targetId = restaurantId;
  } else {
    // Tenant-side: the target is ALWAYS the caller's own restaurant, taken
    // from storage. A `restaurantId` in the request is ignored entirely.
    const identity = await userRestaurantContext(user);
    actorId = identity.userId;
    targetId = identity.restaurantId;
  }

  const restaurant = await Restaurant.findById(targetId);
  if (!restaurant) throw httpError('Restaurant not found', 404);

  const before = {
    name: restaurant.name, slug: restaurant.slug, legalName: restaurant.legalName,
    timezone: restaurant.timezone, currency: restaurant.currency, pan: restaurant.pan
  };

  if (input?.name !== undefined) {
    const name = clean(input.name);
    if (name.length < 2) throw httpError('A restaurant name is required', 400);
    restaurant.name = name;
  }
  if (input?.slug !== undefined) {
    const slug = clean(input.slug).toLowerCase();
    if (slug) {
      if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug)) {
        throw httpError('A slug must be lowercase letters, numbers and hyphens', 400);
      }
      const clash = await Restaurant.findOne({slug, _id: {$ne: restaurant._id}});
      if (clash) throw httpError('That slug is already taken', 409);
    }
    restaurant.slug = slug || undefined;
  }
  for (const field of ['legalName', 'timezone', 'currency', 'pan', 'phone', 'address', 'receiptFooter']) {
    if (input?.[field] !== undefined) restaurant[field] = clean(input[field]) || undefined;
  }
  if (input?.vatRate !== undefined) restaurant.vatRate = input.vatRate;

  await restaurant.save();
  await Audit.create({
    entity: 'restaurant', entityId: restaurant._id, restaurant: restaurant._id,
    action: viaPlatform ? 'platform_restaurant_updated' : 'restaurant_profile_updated',
    before, after: {
      name: restaurant.name, slug: restaurant.slug, legalName: restaurant.legalName,
      timezone: restaurant.timezone, currency: restaurant.currency, pan: restaurant.pan
    },
    user: actorId, ...actorIdentity
  });
  return tenantView(restaurant.toObject());
}

/**
 * Move a restaurant through its lifecycle.
 *
 * Platform-only, always audited, and each transition needs its own permission
 * so a future read-only or support role can be given some and not others.
 *
 * A reason is REQUIRED to suspend or cancel. Cutting off a paying business is
 * a decision somebody must be able to justify later.
 */
const LIFECYCLE = Object.freeze({
  activate: {status: 'active', permission: 'platform.restaurants.activate', reason: false},
  trial: {status: 'trial', permission: 'platform.restaurants.activate', reason: false},
  suspend: {status: 'suspended', permission: 'platform.restaurants.suspend', reason: true},
  cancel: {status: 'cancelled', permission: 'platform.restaurants.suspend', reason: true}
});

export const LIFECYCLE_ACTIONS = Object.freeze(Object.keys(LIFECYCLE));

export async function setRestaurantStatus({user, restaurantId, action, reason}) {
  const transition = LIFECYCLE[String(action)];
  if (!transition) throw httpError(`Unknown lifecycle action: ${action}`, 400);

  const actor = await assertPlatform(user, transition.permission);
  if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);

  const note = clean(reason);
  if (transition.reason && note.length < 3) {
    throw httpError(`A reason is required to ${action} a restaurant`, 400);
  }

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) throw httpError('Restaurant not found', 404);

  const previous = restaurant.status || 'active';
  if (previous === transition.status) {
    // Idempotent: re-suspending a suspended tenant is a no-op, not an error.
    return {restaurant: tenantView(restaurant.toObject()), changed: false, previous};
  }

  restaurant.status = transition.status;
  await restaurant.save();

  await Audit.create({
    entity: 'restaurant', entityId: restaurant._id, restaurant: restaurant._id,
    action: `platform_restaurant_${action}`,
    before: {status: previous}, after: {status: restaurant.status},
    reason: note || undefined,
    user: actor._id, userName: actor.name, userRole: `platform:${actor.platformRole}`
  });
  return {restaurant: tenantView(restaurant.toObject()), changed: true, previous};
}

// ── tenant-side ──────────────────────────────────────────────────────────────

/**
 * The caller's OWN restaurant.
 *
 * There is no id parameter by design: the tenant comes from the authenticated
 * principal, so this endpoint cannot be pointed at another restaurant.
 */
export async function getOwnRestaurant({user}) {
  const identity = await userRestaurantContext(user);
  const restaurant = await Restaurant.findById(identity.restaurantId).lean();
  if (!restaurant) throw httpError('Restaurant not found', 404);
  const {branchMap, userMap, ownerMap} = await countsFor([restaurant._id]);
  return tenantView(restaurant, {
    branches: branchMap.get(String(restaurant._id)) || 0,
    users: userMap.get(String(restaurant._id)) || 0,
    owner: ownerMap.get(String(restaurant._id)) || null
  });
}
