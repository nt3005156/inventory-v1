/**
 * P2B — platform administration: operators, cross-tenant users, oversight.
 *
 * SCOPE DISCIPLINE
 * ----------------
 * Every query in this file crosses tenant boundaries by design, which is
 * exactly why each one has to justify itself. The rules applied throughout:
 *
 *   - a platform read is EXPLICITLY unscoped, and returns a hand-built
 *     projection so a schema addition cannot start leaking;
 *   - a platform write names its target by id, re-reads it, and audits the
 *     before/after under the TARGET's restaurant so the tenant's own hash
 *     chain records what the platform did to it;
 *   - a malformed id is 404, never 400 — the platform surface must not let a
 *     caller distinguish "no such record" from "not an id", which is the
 *     cheapest enumeration oracle there is;
 *   - nothing here ever touches a password, a hash, or a secret.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * No subscriptions, plans, billing, feature flags or usage metering. Those
 * are P2F/P2G. The dashboard reports what the schema already knows.
 */
import mongoose from 'mongoose';
import {Audit, User} from '../models/index.js';
import {Branch, Restaurant, TENANT_STATUSES} from '../models/operations.js';
import {
  PLATFORM_ROLES, PLATFORM_ROLE_KEYS, canAdministerPlatformUser, canGrantPlatformRole,
  hasPlatformPermission, platformPermissionsFor
} from './platformAccess.js';
import {revokeUserSessions} from './sessions.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Uniform refusal. Identical text for every unauthorized caller. */
function refusePlatform() {
  return httpError('Platform administration is not available to this account', 403);
}

/**
 * Re-assert a platform permission at the SERVICE layer.
 *
 * The route guard (`requirePlatformPermission`) already did this. Doing it
 * again here is not redundancy for its own sake: P2A's mutation run proved
 * that a check living only behind a route is a check no unit test exercises,
 * and three survivors came from exactly that. A service that can be called
 * from a script, a job or another service must carry its own authority.
 *
 * Reads STORAGE every time. A role revoked one second ago is gone now.
 */
export async function assertPlatform(user, permission) {
  const id = user?.id || user?._id;
  if (!id) throw httpError('Authentication required', 401);
  if (!mongoose.isValidObjectId(id)) throw httpError('Authentication required', 401);
  const actor = await User.findById(id).select('+platformRole name email active role').lean();
  if (!actor) throw httpError('Authentication required', 401);
  if (!hasPlatformPermission(actor, permission)) throw refusePlatform();
  return actor;
}

/** Escape a user-supplied search term: it is text, never a pattern. */
const escapeTerm = term => clean(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── projections ──────────────────────────────────────────────────────────────

/**
 * A user, as the PLATFORM sees them.
 *
 * Hand-built. No `password`, ever — the field is not even selected by the
 * queries below, so it cannot arrive here to be forgotten about.
 *
 * `platformRole` IS included, because an operator managing operators has to
 * see who holds what; it is only ever returned to a caller who has already
 * passed `platform.users.view`.
 */
function platformUserView(user, {restaurant = null, branch = null} = {}) {
  return {
    _id: user._id,
    name: user.name || null,
    email: user.email || null,
    role: user.role || null,
    roleKey: user.roleKey || null,
    platformRole: user.platformRole || null,
    active: user.active !== false,
    restaurant: restaurant
      ? {_id: restaurant._id, name: restaurant.name, slug: restaurant.slug || null, status: restaurant.status || 'active'}
      : null,
    branch: branch ? {_id: branch._id, name: branch.name, code: branch.code || null} : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

/**
 * Resolve restaurant and branch records for a page of users in two queries
 * rather than 2N.
 */
async function membershipFor(users) {
  const restaurantIds = [...new Set(users.map(u => u.restaurantId).filter(Boolean).map(String))];
  const branchIds = [...new Set(users.map(u => u.branch).filter(Boolean).map(String))];
  const [restaurants, branches] = await Promise.all([
    restaurantIds.length
      ? Restaurant.find({_id: {$in: restaurantIds}}).select('name slug status').lean()
      : [],
    branchIds.length
      ? Branch.find({_id: {$in: branchIds}}).select('name code restaurant').lean()
      : []
  ]);
  return {
    restaurants: new Map(restaurants.map(row => [String(row._id), row])),
    branches: new Map(branches.map(row => [String(row._id), row]))
  };
}

// ── cross-tenant user administration ─────────────────────────────────────────

/**
 * Find users across every tenant.
 *
 * The `restaurant` filter is what a support operator actually uses ("show me
 * everyone at Rival Momo"), and it is also the only way this endpoint is
 * scoped at all — by explicit request, never implicitly by the caller's own
 * tenant. A platform operator has no tenant for the purpose of this query,
 * and one who happens to be embedded in a restaurant must not silently see
 * only their own.
 */
export async function listPlatformUsers({
  user, q, restaurantId, role, platformRole, active, page = 1, limit = 25
}) {
  await assertPlatform(user, 'platform.users.view');

  const filter = {};
  if (clean(q)) {
    const term = escapeTerm(q);
    filter.$or = [{name: new RegExp(term, 'i')}, {email: new RegExp(term, 'i')}];
  }
  if (restaurantId !== undefined && clean(restaurantId)) {
    // A malformed tenant id yields an empty page, not an error: the caller
    // learns nothing about which ids are real.
    if (!mongoose.isValidObjectId(restaurantId)) {
      return {users: [], pagination: {page: 1, limit: 25, total: 0, pages: 1}};
    }
    filter.restaurantId = new mongoose.Types.ObjectId(String(restaurantId));
  }
  if (clean(role)) {
    filter.role = clean(role);
  }
  if (platformRole !== undefined && clean(platformRole)) {
    const wanted = clean(platformRole);
    if (wanted === 'any') filter.platformRole = {$nin: [null, '']};
    else if (!PLATFORM_ROLE_KEYS.includes(wanted)) throw httpError(`Unknown platform role: ${wanted}`, 400);
    else filter.platformRole = wanted;
  }
  if (active !== undefined && clean(active) !== '') {
    const wanted = clean(active);
    if (!['true', 'false'].includes(wanted)) throw httpError('Invalid active filter', 400);
    filter.active = wanted === 'true' ? {$ne: false} : false;
  }

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);

  const [rows, total] = await Promise.all([
    User.find(filter)
      // `+platformRole` is explicit: an operator administering operators must
      // see it. `password` is never selected on any path in this file.
      .select('name email role roleKey active restaurantId branch createdAt updatedAt +platformRole')
      .sort({createdAt: -1}).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    User.countDocuments(filter)
  ]);
  const {restaurants, branches} = await membershipFor(rows);

  return {
    users: rows.map(row => platformUserView(row, {
      restaurant: row.restaurantId ? restaurants.get(String(row.restaurantId)) || null : null,
      branch: row.branch ? branches.get(String(row.branch)) || null : null
    })),
    pagination: {
      page: safePage, limit: safeLimit, total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    }
  };
}

/** One user, by id, from any tenant. */
export async function getPlatformUser({user, targetId}) {
  await assertPlatform(user, 'platform.users.view');
  if (!mongoose.isValidObjectId(targetId)) throw httpError('User not found', 404);
  const row = await User.findById(targetId)
    .select('name email role roleKey active restaurantId branch createdAt updatedAt +platformRole')
    .lean();
  if (!row) throw httpError('User not found', 404);
  const {restaurants, branches} = await membershipFor([row]);
  return platformUserView(row, {
    restaurant: row.restaurantId ? restaurants.get(String(row.restaurantId)) || null : null,
    branch: row.branch ? branches.get(String(row.branch)) || null : null
  });
}

/**
 * Deactivate or reactivate any account on the platform.
 *
 * This is a genuine cross-tenant power: the tenant-side equivalent
 * (`setAccountActive`) refuses to touch an owner and is scoped to the
 * caller's own restaurant. The platform version can switch off an owner,
 * because "this restaurant's owner is abusing the service" is precisely the
 * situation the platform exists to handle.
 *
 * Two protections that are NOT relaxed:
 *   - an operator cannot switch OFF an account whose platform rank is at or
 *     above their own, which would otherwise be a lateral attack on a peer;
 *   - an operator cannot switch off themselves, which is how somebody locks
 *     the platform out of its own administration.
 *
 * Sessions are revoked on both edges. Deactivation without revocation leaves
 * the existing token live for up to 12 hours — the Phase 17 lesson. On
 * REACTIVATION the bump is equally deliberate: it permanently retires the
 * tokens that were live before the account was switched off.
 */
export async function setPlatformUserActive({user, targetId, active, reason}) {
  const actor = await assertPlatform(user, 'platform.users.manage');
  if (!mongoose.isValidObjectId(targetId)) throw httpError('User not found', 404);

  const note = clean(reason);
  if (!note || note.length < 3) {
    throw httpError('A reason is required to change an account status', 400);
  }

  const target = await User.findById(targetId).select('+platformRole');
  if (!target) throw httpError('User not found', 404);

  if (String(target._id) === String(actor._id)) {
    throw httpError('You cannot change your own account status', 409);
  }
  /**
   * Acting on a PEER's account is refused, using the strict comparison.
   *
   * Deliberately NOT `canGrantPlatformRole()`, which permits equal rank so a
   * super admin can create peers. Reusing it here was a real defect the suite
   * caught: it let one `platform_admin` deactivate another. Granting a role
   * and switching off somebody's account are different questions and now ask
   * different functions.
   */
  if (!canAdministerPlatformUser(actor.platformRole, target.platformRole)) {
    // Refused identically to any other unauthorized attempt.
    throw refusePlatform();
  }

  const wanted = Boolean(active);
  const previous = target.active !== false;
  if (previous === wanted) {
    return {user: platformUserView(target.toObject()), changed: false};
  }

  target.active = wanted;
  // A rider carries a second switch that dispatch honours independently.
  if (target.role === 'rider') {
    const profile = target.rider || {};
    profile.active = wanted;
    if (!wanted) profile.available = false;
    target.rider = profile;
    target.markModified('rider');
  }
  await target.save();

  await Audit.create({
    entity: 'user', entityId: target._id,
    // Stamped under the TARGET's restaurant so the tenant's own chain records
    // that the platform acted on one of its people.
    restaurant: target.restaurantId || undefined,
    branch: target.branch || undefined,
    action: wanted ? 'platform_user_reactivated' : 'platform_user_deactivated',
    before: {active: previous}, after: {active: wanted, email: target.email},
    reason: note,
    user: actor._id, userName: actor.name, userRole: `platform:${actor.platformRole}`
  });

  await revokeUserSessions({
    userId: target._id,
    reason: wanted ? 'admin' : 'deactivated',
    actor: {id: actor._id, name: actor.name},
    disconnectSockets: true
  });

  return {user: platformUserView(target.toObject()), changed: true};
}

// ── platform operator provisioning ───────────────────────────────────────────

/**
 * Grant or revoke a PLATFORM role on an existing account.
 *
 * THE MOST DANGEROUS OPERATION IN THE SYSTEM, and shaped accordingly.
 *
 * Why it grants a role to an EXISTING user rather than creating an account:
 * a create-and-promote endpoint has to accept a password, which drags
 * credential handling into the platform surface for no benefit. Every
 * platform operator is already a real person with a real login; this endpoint
 * only decides whether that login carries cross-tenant authority.
 *
 * The controls, each closing a specific escalation path:
 *
 *   `platform.admins.manage`  held ONLY by super_admin. A platform_admin —
 *                             who can suspend any restaurant on the platform
 *                             — still cannot recruit a second operator or
 *                             promote themselves.
 *   rank ceiling              nobody grants above their own rank, so a
 *                             super_admin cannot be manufactured from below.
 *   rank floor on revoke      nobody strips a peer or a superior.
 *   no self-service           an actor cannot change their own platform role
 *                             in either direction. Self-demotion looks
 *                             harmless but is how the last super_admin
 *                             disappears; self-promotion is the whole attack.
 *   target must be real       and must be an ACTIVE account: promoting a
 *                             deactivated user creates dormant authority
 *                             nobody is watching.
 *   audited, always           with before/after and a mandatory reason.
 *
 * There is no bootstrap path here on purpose. The first operator is created
 * by `scripts/platform-admin.js`, which requires shell access to the server.
 * A public or semi-public bootstrap route is a permanent hole: it is either
 * reachable and dangerous, or "disabled after first use" and one restore of
 * an empty database away from being reachable again.
 */
export async function setPlatformRole({user, targetId, platformRole, reason}) {
  const actor = await assertPlatform(user, 'platform.admins.manage');
  if (!mongoose.isValidObjectId(targetId)) throw httpError('User not found', 404);

  const note = clean(reason);
  if (!note || note.length < 3) {
    throw httpError('A reason is required to change platform authority', 400);
  }

  // `null` (or empty) means REVOKE.
  const wanted = platformRole === null || clean(platformRole) === ''
    ? null
    : clean(platformRole).toLowerCase();
  if (wanted !== null && !PLATFORM_ROLE_KEYS.includes(wanted)) {
    throw httpError(`Unknown platform role: ${wanted}`, 400);
  }
  if (wanted !== null && !canGrantPlatformRole(actor.platformRole, wanted)) {
    throw httpError('You cannot grant a platform role above your own authority', 403);
  }

  const target = await User.findById(targetId).select('+platformRole');
  if (!target) throw httpError('User not found', 404);

  if (String(target._id) === String(actor._id)) {
    throw httpError('You cannot change your own platform authority', 409);
  }
  if (target.active === false) {
    throw httpError('A deactivated account cannot hold platform authority', 409);
  }
  // Revoking or overwriting somebody at or above your rank is refused.
  if (target.platformRole && !canGrantPlatformRole(actor.platformRole, target.platformRole)) {
    throw httpError('You cannot change the platform authority of an equal or higher operator', 403);
  }

  const previous = target.platformRole || null;
  if (previous === wanted) {
    return {user: platformUserView(target.toObject()), changed: false};
  }

  /**
   * Never remove the last super administrator.
   *
   * Losing every account that holds `platform.admins.manage` means the
   * platform can only be repaired from a database shell. Counted with the
   * target excluded, and only among ACTIVE accounts — a deactivated super
   * admin cannot rescue anybody.
   */
  if (previous === 'super_admin' && wanted !== 'super_admin') {
    const remaining = await User.countDocuments({
      platformRole: 'super_admin', active: {$ne: false}, _id: {$ne: target._id}
    });
    if (remaining === 0) {
      throw httpError('The last platform super administrator cannot be demoted', 409);
    }
  }

  target.platformRole = wanted;
  await target.save();

  await Audit.create({
    entity: 'platform_user', entityId: target._id,
    // Platform authority is not a tenant fact, so this row is deliberately
    // written to the GLOBAL chain (restaurant: null) rather than into some
    // restaurant's history. It is the platform's own record.
    action: previous && wanted
      ? 'platform_admin_role_changed'
      : (wanted ? 'platform_admin_created' : 'platform_admin_revoked'),
    before: {platformRole: previous},
    after: {platformRole: wanted, email: target.email, name: target.name},
    reason: note,
    user: actor._id, userName: actor.name, userRole: `platform:${actor.platformRole}`
  });

  /**
   * Authority changed, so every existing session for that account is retired.
   * Platform permission is re-read from storage on every request, so this is
   * belt and braces rather than the control itself — but a person whose
   * powers just changed should be re-authenticating, and a REVOKED operator
   * should not keep a live websocket into rooms they may no longer enter.
   */
  await revokeUserSessions({
    userId: target._id, reason: 'admin',
    actor: {id: actor._id, name: actor.name}, disconnectSockets: true
  });

  return {user: platformUserView(target.toObject()), changed: true};
}

/** Every account holding platform authority. */
export async function listPlatformAdmins({user}) {
  await assertPlatform(user, 'platform.users.view');
  const rows = await User.find({platformRole: {$nin: [null, '']}})
    .select('name email role active restaurantId branch createdAt updatedAt +platformRole')
    .sort({createdAt: 1}).limit(200).lean();
  const {restaurants, branches} = await membershipFor(rows);
  return {
    admins: rows.map(row => platformUserView(row, {
      restaurant: row.restaurantId ? restaurants.get(String(row.restaurantId)) || null : null,
      branch: row.branch ? branches.get(String(row.branch)) || null : null
    })),
    roles: PLATFORM_ROLE_KEYS.map(key => ({
      key,
      name: PLATFORM_ROLES[key].name,
      description: PLATFORM_ROLES[key].description,
      rank: PLATFORM_ROLES[key].rank,
      permissions: [...PLATFORM_ROLES[key].permissions]
    }))
  };
}

// ── dashboard ────────────────────────────────────────────────────────────────

/**
 * Aggregate platform health.
 *
 * Counting rules:
 *   - restaurants are grouped by status in ONE aggregation, not five
 *     `countDocuments` calls;
 *   - a restaurant with no `status` is legacy and counts as `active`, which is
 *     what `tenantView()` already reports for it — the dashboard must agree
 *     with the list screen or somebody will chase a phantom discrepancy;
 *   - `users.total` counts every account including riders and platform
 *     operators, and `platformOperators` is reported separately so the two
 *     are never confused.
 *
 * DELIBERATELY ABSENT: revenue, order counts, payment totals, anything from a
 * tenant's books. The brief is explicit that the dashboard must not surface
 * individual tenant financial data, and an aggregate over money is one
 * `groupBy` away from being exactly that. Business metrics belong to P2G.
 */
export async function platformDashboard({user}) {
  await assertPlatform(user, 'platform.dashboard.view');

  const [statusRows, branchTotal, userRows, operatorCount, recentRows] = await Promise.all([
    Restaurant.aggregate([{$group: {_id: '$status', n: {$sum: 1}}}]),
    Branch.countDocuments({}),
    User.aggregate([{$group: {_id: {$ne: ['$active', false]}, n: {$sum: 1}}}]),
    User.countDocuments({platformRole: {$nin: [null, '']}}),
    Restaurant.find({}).select('name slug status createdAt').sort({createdAt: -1}).limit(5).lean()
  ]);

  const byStatus = Object.fromEntries(TENANT_STATUSES.map(status => [status, 0]));
  let restaurantTotal = 0;
  for (const row of statusRows) {
    // A missing status is legacy data and trades normally, so it is `active`.
    const key = TENANT_STATUSES.includes(row._id) ? row._id : 'active';
    byStatus[key] += row.n;
    restaurantTotal += row.n;
  }

  let usersActive = 0;
  let usersTotal = 0;
  for (const row of userRows) {
    usersTotal += row.n;
    if (row._id === true) usersActive += row.n;
  }

  return {
    restaurants: {
      total: restaurantTotal,
      ...byStatus,
      // The two that can actually trade, which is the number an operator
      // cares about. Kept consistent with `OPERATIONAL_TENANT_STATUSES`.
      operational: byStatus.trial + byStatus.active
    },
    branches: {total: branchTotal},
    users: {
      total: usersTotal,
      active: usersActive,
      inactive: usersTotal - usersActive,
      platformOperators: operatorCount
    },
    recentRestaurants: recentRows.map(row => ({
      _id: row._id, name: row.name, slug: row.slug || null,
      status: row.status || 'active', createdAt: row.createdAt
    })),
    generatedAt: new Date()
  };
}

// ── platform audit ───────────────────────────────────────────────────────────

/**
 * Actions this phase and P2A write. Used to offer a sane filter and, more
 * importantly, to DEFINE what "the platform audit trail" means: rows produced
 * by a platform operator acting as one.
 */
export const PLATFORM_AUDIT_ACTIONS = Object.freeze([
  'platform_admin_created',
  'platform_admin_revoked',
  'platform_admin_role_changed',
  'platform_restaurant_created',
  'platform_restaurant_updated',
  'platform_restaurant_activate',
  'platform_restaurant_trial',
  'platform_restaurant_suspend',
  'platform_restaurant_cancel',
  'platform_user_deactivated',
  'platform_user_reactivated'
]);

/**
 * Cross-tenant audit search, restricted to PLATFORM actions.
 *
 * This is not a second audit system — it reads the same append-only,
 * hash-chained `Audit` collection that `searchAudit()` reads. The difference
 * is scope: `searchAudit()` pins every query to the caller's own restaurant
 * (and branch, for non-owners), which is correct for a tenant and useless for
 * an operator investigating what the platform did to whom.
 *
 * The action filter is a WHITELIST, not a convenience. Without it this
 * endpoint would be a cross-tenant window onto every refund, price change and
 * failed login in every restaurant on the platform — the brief's "avoid
 * exposing operational restaurant data unnecessarily", violated in one query.
 * A platform operator investigating a tenant's internal operations has to ask
 * that tenant.
 */
export async function searchPlatformAudit({
  user, action, restaurantId, actorId, from, to, page = 1, limit = 50
}) {
  await assertPlatform(user, 'platform.audit.view');

  const match = {action: {$in: [...PLATFORM_AUDIT_ACTIONS]}};

  if (clean(action)) {
    const wanted = String(action).split(',').map(clean).filter(Boolean);
    for (const value of wanted) {
      if (!PLATFORM_AUDIT_ACTIONS.includes(value)) {
        throw httpError(`Unknown platform action: ${value}`, 400);
      }
    }
    if (wanted.length) match.action = {$in: wanted};
  }
  if (restaurantId !== undefined && clean(restaurantId)) {
    if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);
    match.restaurant = new mongoose.Types.ObjectId(String(restaurantId));
  }
  if (actorId !== undefined && clean(actorId)) {
    if (!mongoose.isValidObjectId(actorId)) throw httpError('User not found', 404);
    match.user = new mongoose.Types.ObjectId(String(actorId));
  }

  const fromDate = from ? new Date(String(from)) : null;
  const toDate = to ? new Date(String(to)) : null;
  if (fromDate && Number.isNaN(fromDate.getTime())) throw httpError('Invalid from date', 400);
  if (toDate && Number.isNaN(toDate.getTime())) throw httpError('Invalid to date', 400);
  const toExclusive = toDate ? new Date(toDate.getTime() + 86400000) : null;
  if (fromDate && toExclusive && fromDate >= toExclusive) {
    throw httpError('from must not be after to', 400);
  }
  if (fromDate || toExclusive) {
    match.at = {...(fromDate ? {$gte: fromDate} : {}), ...(toExclusive ? {$lt: toExclusive} : {})};
  }

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);

  const [rows, total] = await Promise.all([
    Audit.find(match).sort({at: -1, _id: -1})
      .skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    Audit.countDocuments(match)
  ]);

  const restaurantIds = [...new Set(rows.map(row => row.restaurant).filter(Boolean).map(String))];
  const restaurants = restaurantIds.length
    ? await Restaurant.find({_id: {$in: restaurantIds}}).select('name slug').lean()
    : [];
  const nameMap = new Map(restaurants.map(row => [String(row._id), row]));

  return {
    events: rows.map(row => ({
      _id: row._id,
      at: row.at,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId || null,
      restaurant: row.restaurant
        ? {
          _id: row.restaurant,
          name: nameMap.get(String(row.restaurant))?.name || null,
          slug: nameMap.get(String(row.restaurant))?.slug || null
        }
        : null,
      actor: {id: row.user || null, name: row.userName || null, role: row.userRole || null},
      reason: row.reason || null,
      before: row.before ?? null,
      after: row.after ?? null,
      ip: row.ip || null,
      sequence: row.sequence ?? null,
      hash: row.hash || null
    })),
    actions: [...PLATFORM_AUDIT_ACTIONS],
    pagination: {
      page: safePage, limit: safeLimit, total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    }
  };
}

/** The caller's own platform standing. Drives navigation; never a control. */
export async function describePlatformAccess({user}) {
  const id = user?.id || user?._id;
  if (!id || !mongoose.isValidObjectId(id)) throw httpError('Authentication required', 401);
  const actor = await User.findById(id).select('+platformRole name active').lean();
  if (!actor) throw httpError('Authentication required', 401);
  const permissions = platformPermissionsFor(actor);
  const role = permissions.length ? PLATFORM_ROLES[actor.platformRole] : null;
  return {
    platform: permissions.length > 0,
    platformRole: role ? role.key : null,
    platformRoleName: role ? role.name : null,
    permissions
  };
}
