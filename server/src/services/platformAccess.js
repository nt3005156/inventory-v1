/**
 * P2A — the platform authority, deliberately SEPARATE from tenant RBAC.
 *
 * WHY THIS IS NOT PART OF `PERMISSION_CATALOG`
 * --------------------------------------------
 * A restaurant owner holds `'*'`, and `resolvePrincipal()` materialises that
 * into the ENTIRE catalogue — verified: `permissionsForBuiltin('owner').length`
 * equals `ALL_PERMISSIONS.length`. So adding `platform.restaurants.suspend` to
 * the tenant catalogue would silently hand every restaurant owner the ability
 * to suspend other restaurants. That is the exact failure the brief warns
 * about: "Do not simply give existing owner unlimited cross-tenant access."
 *
 * The tenant catalogue answers "what may this employee do INSIDE their
 * restaurant?". Platform authority answers "may this account act ACROSS
 * restaurants at all?". Those are different questions with different blast
 * radii, so they get different mechanisms. This is not a second authorization
 * system for the same question — it is one system for a question the existing
 * one cannot express.
 *
 * HOW A PLATFORM OPERATOR IS IDENTIFIED
 * -------------------------------------
 * `User.platformRole`, a field that is null for every existing account and can
 * only be set out-of-band (database or a future platform-admin screen, which
 * is P2B). It is deliberately NOT settable through any tenant-facing endpoint:
 * self-promotion to platform admin must be impossible from inside a tenant.
 *
 * P2A ships exactly ONE platform role and the permissions restaurant
 * administration needs. P2B widens it. Shipping the whole matrix now would be
 * inventing authority nothing enforces yet.
 */

/** Platform permission keys. Namespaced `platform.*` so they can never be
 *  confused with a tenant permission, and never collide with one. */
export const PLATFORM_PERMISSIONS = Object.freeze([
  'platform.restaurants.view',
  'platform.restaurants.create',
  'platform.restaurants.update',
  'platform.restaurants.suspend',
  'platform.restaurants.activate'
]);

/**
 * Platform roles.
 *
 * `platform_admin` is the only one for now. A read-only `platform_support`
 * role is an obvious future addition, but adding it before anything consumes
 * it would be unenforced decoration.
 */
export const PLATFORM_ROLES = Object.freeze({
  platform_admin: Object.freeze({
    key: 'platform_admin',
    name: 'Platform administrator',
    description: 'Administers restaurants across the platform. Not a restaurant employee.',
    permissions: Object.freeze([...PLATFORM_PERMISSIONS])
  })
});

export const PLATFORM_ROLE_KEYS = Object.freeze(Object.keys(PLATFORM_ROLES));

/**
 * The platform permissions an account holds. Empty for every tenant user.
 *
 * Takes the STORED user row, never a token claim: a forged `platformRole` in a
 * JWT must grant nothing.
 */
export function platformPermissionsFor(storedUser) {
  const key = String(storedUser?.platformRole || '').trim();
  if (!key) return [];
  const role = PLATFORM_ROLES[key];
  if (!role) return [];
  return [...role.permissions];
}

/** Does this stored user hold a given platform permission? */
export function hasPlatformPermission(storedUser, permission) {
  return platformPermissionsFor(storedUser).includes(permission);
}

/**
 * Is this account a platform operator at all?
 *
 * Used to decide whether the platform surface is even visible, separately from
 * which action is allowed.
 */
export function isPlatformOperator(storedUser) {
  return platformPermissionsFor(storedUser).length > 0;
}
