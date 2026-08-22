import {Role, User} from '../models/index.js';
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

  const stored = await User.findById(tokenUser.id)
    .select('name email role roleKey branch restaurantId restaurant active rider')
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
      permissions: new Set(permissionsForBuiltin(stored.role))
    };
  }

  // A custom role. It is looked up inside the user's OWN restaurant, so a role
  // key cannot be borrowed across tenants.
  const role = await Role.findOne({restaurant: stored.restaurantId, key: roleKey})
    .session(session || null)
    .lean();

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
