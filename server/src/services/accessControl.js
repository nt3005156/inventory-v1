import {Role, User} from '../models/index.js';
import {invalidateRole, withRoleCache} from './principalCache.js';
import {assertSessionLive} from './sessions.js';
import {
  ALL_PERMISSIONS, BUILTIN_ROLES, grants, permissionsForBuiltin
} from './permissions.js';

/**
 * Phase 20 — principal resolution.
 *
 * This is the ONE place a request's effective permissions are decided, and it
 * reads the DATABASE, not the token.
 *
 * That distinction is the security fix in this phase. A JWT is a 12-hour
 * bearer credential and carries `role` as a claim. Before Phase 20 the guard
 * trusted that claim, which meant:
 *
 *   PROVEN DEFECT — a deactivated employee kept working. Reproduced against
 *   the running API: an owner set `active:false` on a manager, login was
 *   correctly refused (403), and the manager's EXISTING token then still
 *   posted an inventory adjustment (201) and created an order (201). A fired
 *   employee could move stock and take money for the remainder of the token's
 *   life. Demotion happened to be caught — `userRestaurantContext()` compares
 *   the token role against the stored role — but nothing anywhere checked
 *   `active`.
 *
 * Resolving from the database on every request costs one indexed `findById`
 * per call, which the request already pays several times over for tenancy
 * scoping. Correctness here is worth more than that lookup: the alternative is
 * revocation that does not revoke.
 */

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * Resolve the authenticated principal into live role, base role and permission
 * set. Throws 401 for anything that should end the session outright.
 */
export async function resolvePrincipal(tokenUser, {session} = {}) {
  if (!tokenUser?.id) throw httpError('Authentication required', 401);

  // The user row is read live on EVERY request -- never cached. It carries
  // `active`, `rider.active`, `role` and `sessionVersion`, the four facts that
  // decide whether this session is still valid. Caching them was tried and
  // proven unsafe (see principalCache.js).
  const resolved = await loadPrincipal(tokenUser, {session});

  /**
   * SESSION VERSION — checked on every request, against the CACHED snapshot.
   *
   * The token carries the version that was current when it was signed.
   * Incrementing `user.sessionVersion` therefore invalidates every token
   * issued before the bump. Compared here rather than inside the loader so
   * that a cached principal is still rejected the moment its version moves
   * on; the writer also invalidates the cache entry directly, so this is the
   * second of two independent mechanisms.
   *
   * Tokens minted before this field existed carry no `sv` claim and are
   * treated as version 0, which matches the schema default — so shipping this
   * does not log out every existing session.
   */
  const tokenVersion = Number(tokenUser.sv ?? 0);
  if (tokenVersion !== resolved.sessionVersion) {
    throw httpError('This session has been signed out. Sign in again.', 401);
  }

  /**
   * PER-DEVICE revocation.
   *
   * `sessionVersion` above ends every session at once. This checks the ONE
   * device: the token carries an opaque `sid` whose hash is stored, and a
   * revoked or expired row fails here while the user's other devices keep
   * working. A token minted before per-device sessions existed carries no
   * `sid` and is accepted — it stays covered by the version check — so
   * shipping this does not sign everybody out.
   */
  const {legacy, session: deviceSession} = await assertSessionLive(tokenUser.sid);
  if (!legacy && !deviceSession) {
    throw httpError('This session has been signed out. Sign in again.', 401);
  }
  resolved.sessionId = deviceSession ? String(deviceSession._id) : null;

  return resolved;
}

async function loadPrincipal(tokenUser, {session} = {}) {
  const stored = await User.findById(tokenUser.id)
    .select('name email role roleKey branch restaurantId restaurant active rider sessionVersion')
    .session(session || null)
    .lean();
  if (!stored) throw httpError('Authentication required', 401);

  // THE FIX. An account switched off must lose access immediately, not when
  // its token happens to expire. Riders carry a second switch on the embedded
  // profile, which dispatch already honours; it must end the session too.
  if (stored.active === false) {
    throw httpError('This account is deactivated. Contact your manager.', 401);
  }
  // A rider carries a second switch on the embedded profile. Standing a rider
  // down through the rider workspace sets only this one, so checking the
  // account-level flag alone would leave their token live.
  if (stored.role === 'rider' && stored.rider?.active === false) {
    throw httpError('This account is deactivated. Contact your manager.', 401);
  }

  // A token minted before a demotion must not survive it. This check already
  // existed inside userRestaurantContext(); it is hoisted to the guard so it
  // applies to every endpoint rather than only those that resolve a tenant.
  if (tokenUser.role !== stored.role) {
    throw httpError('User permissions changed; sign in again', 401);
  }

  const builtin = BUILTIN_ROLES[stored.role];
  const roleKey = stored.roleKey || null;

  // No custom role: the legacy bundle, unchanged.
  if (!roleKey) {
    if (!builtin) throw httpError('User permissions changed; sign in again', 401);
    return {
      userId: String(stored._id),
      name: stored.name,
      baseRole: stored.role,
      roleKey: stored.role,
      roleName: builtin.name,
      custom: false,
      branch: stored.branch ? String(stored.branch) : null,
      restaurantId: stored.restaurantId ? String(stored.restaurantId) : null,
      sessionVersion: Number(stored.sessionVersion || 0),
      permissions: new Set(permissionsForBuiltin(stored.role))
    };
  }

  // A custom role. It is looked up inside the user's OWN restaurant, so a role
  // key cannot be borrowed across tenants.
  // The role DEFINITION is cacheable: it changes rarely, only through
  // roles.js (which invalidates), and it cannot resurrect a dead session
  // because the live user row above already decided that.
  let role = session
    ? await Role.findOne({restaurant: stored.restaurantId, key: roleKey}).session(session).lean()
    : await withRoleCache(stored.restaurantId, roleKey, () =>
      Role.findOne({restaurant: stored.restaurantId, key: roleKey}).lean());

  /**
   * REVALIDATE A CACHE HIT BEFORE TRUSTING IT.
   *
   * The cache can only ever hold a role that was active when it was stored.
   * Deleting or disabling a role out of band -- another API instance, a
   * migration, an operator in the shell -- would otherwise keep its holders
   * authorised for up to one TTL, which is the same staleness that made
   * caching the user row unsafe. Withdrawal of access must be immediate, so a
   * hit is confirmed against storage and the stale entry dropped.
   *
   * This costs one extra read only on the path that is about to 401 in the
   * common case; a normal request with a live role still pays a single query.
   */
  if (role && !session) {
    const stillLive = await Role.exists({
      restaurant: stored.restaurantId, key: roleKey, active: {$ne: false}
    });
    if (!stillLive) {
      invalidateRole(stored.restaurantId, roleKey);
      role = null;
    }
  }

  // A role that has been deleted or switched off must not silently fall back
  // to the base role's full bundle — that would QUIETLY WIDEN access at the
  // exact moment an administrator was trying to withdraw it. Refuse instead.
  if (!role || role.active === false) {
    throw httpError('Your role is no longer available. Contact your manager.', 401);
  }

  // Defence in depth: the stored baseRole must agree with the user's legacy
  // role. If they diverge, something has rewritten one of them out of band.
  if (role.baseRole !== stored.role) {
    throw httpError('User permissions changed; sign in again', 401);
  }

  return {
    userId: String(stored._id),
    name: stored.name,
    baseRole: stored.role,
    roleKey: role.key,
    roleName: role.name,
    custom: true,
    branch: stored.branch ? String(stored.branch) : null,
    restaurantId: stored.restaurantId ? String(stored.restaurantId) : null,
    sessionVersion: Number(stored.sessionVersion || 0),
    // A custom role is an EXACT permission list. It does not inherit its base
    // role's bundle: a Cashier based on `staff` must not silently receive
    // every staff permission, or the whole point of a narrower role is lost.
    permissions: new Set(role.permissions || [])
  };
}

/** Effective permission list for display. Owners resolve to the full set. */
export function effectivePermissions(resolved) {
  if (!resolved) return [];
  if (resolved.baseRole === 'owner') return [...ALL_PERMISSIONS];
  return [...resolved.permissions].sort();
}

export function assertGrants(resolved, permission) {
  if (!grants(resolved, permission)) {
    throw httpError('Insufficient permission', 403);
  }
  return true;
}

export {grants};
