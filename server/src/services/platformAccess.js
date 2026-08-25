/**
 * P2A/P2B — the platform authority, deliberately SEPARATE from tenant RBAC.
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
 * A second, mechanical reason: `phase20.rbac.test.js` requires every catalogue
 * key to match `/^[a-z]+\.[a-z]+$/`. Platform keys are three segments
 * (`platform.restaurants.view`), so they could not live there even if the
 * authority question were the same.
 *
 * HOW A PLATFORM OPERATOR IS IDENTIFIED
 * -------------------------------------
 * `User.platformRole`, a field that is null for every existing account,
 * `select: false`, and NEVER settable through a tenant-facing endpoint.
 * Authority is always read from STORAGE — a forged `platformRole` JWT claim
 * must grant nothing, which `authenticate()` enforces by stripping the claim
 * outright before it can reach a handler.
 *
 * P2B widens P2A's single role into a three-rung ladder and adds the
 * permissions the dashboard, user administration, audit and admin
 * provisioning surfaces need.
 */

/**
 * Platform permission keys.
 *
 * Namespaced `platform.*` so they can never be confused with, or collide
 * with, a tenant permission. Three segments (`platform.<resource>.<action>`)
 * both reads naturally and is structurally incompatible with the tenant
 * catalogue's two-segment shape.
 */
export const PLATFORM_PERMISSIONS = Object.freeze([
  // Tenant lifecycle and profile.
  'platform.restaurants.view',
  'platform.restaurants.create',
  'platform.restaurants.update',
  'platform.restaurants.suspend',
  'platform.restaurants.activate',
  // Cross-tenant user administration.
  'platform.users.view',
  'platform.users.manage',
  // Oversight.
  'platform.audit.view',
  'platform.dashboard.view',
  // The most dangerous capability on the platform: minting other operators.
  'platform.admins.manage'
]);

const PLATFORM_PERMISSION_SET = new Set(PLATFORM_PERMISSIONS);

/** Is this string a platform permission key at all? */
export function isPlatformPermission(key) {
  return PLATFORM_PERMISSION_SET.has(String(key || ''));
}

/**
 * Platform roles, as an authority LADDER.
 *
 * Three roles rather than one because there is a real authorization
 * difference at each rung, not because a matrix looks thorough:
 *
 *   platform_support  READ ONLY. Somebody answering a support ticket needs to
 *                     see that a restaurant is suspended and which branch a
 *                     user belongs to. They must not be able to suspend a
 *                     business or deactivate an account.
 *
 *   platform_admin    Day-to-day tenant operations: create, update, suspend,
 *                     activate restaurants; deactivate and reactivate users.
 *                     Deliberately CANNOT mint other platform operators —
 *                     that is the privilege-escalation path, and separating
 *                     it means a compromised admin account cannot quietly
 *                     grant itself permanence or recruit accomplices.
 *
 *   super_admin       Everything, including `platform.admins.manage`.
 *                     Expected to be a small number of accounts.
 *
 * `rank` exists solely to answer "may this actor grant that role?". It is not
 * used for permission checks — those are always explicit key lookups, so a
 * future role cannot inherit a capability by sitting high on the ladder.
 */
export const PLATFORM_ROLES = Object.freeze({
  platform_support: Object.freeze({
    key: 'platform_support',
    name: 'Platform support',
    description: 'Read-only visibility across the platform. Cannot change anything.',
    rank: 1,
    permissions: Object.freeze([
      'platform.restaurants.view',
      'platform.users.view',
      'platform.audit.view',
      'platform.dashboard.view'
    ])
  }),
  platform_admin: Object.freeze({
    key: 'platform_admin',
    name: 'Platform administrator',
    description: 'Administers restaurants and their users across the platform. Not a restaurant employee.',
    rank: 2,
    permissions: Object.freeze([
      'platform.restaurants.view',
      'platform.restaurants.create',
      'platform.restaurants.update',
      'platform.restaurants.suspend',
      'platform.restaurants.activate',
      'platform.users.view',
      'platform.users.manage',
      'platform.audit.view',
      'platform.dashboard.view'
    ])
  }),
  super_admin: Object.freeze({
    key: 'super_admin',
    name: 'Platform super administrator',
    description: 'Full platform authority, including granting and revoking platform roles.',
    rank: 3,
    permissions: Object.freeze([...PLATFORM_PERMISSIONS])
  })
});

export const PLATFORM_ROLE_KEYS = Object.freeze(Object.keys(PLATFORM_ROLES));

/** Rank of a platform role key; 0 for a tenant user or an unknown key. */
export function platformRank(roleKey) {
  return PLATFORM_ROLES[String(roleKey || '').trim()]?.rank || 0;
}

/**
 * The platform permissions an account holds. Empty for every tenant user.
 *
 * Takes the STORED user row, never a token claim: a forged `platformRole` in a
 * JWT must grant nothing. An unrecognised stored value also grants nothing —
 * fail closed, so a typo in the database is inert rather than interesting.
 */
export function platformPermissionsFor(storedUser) {
  const key = String(storedUser?.platformRole || '').trim();
  if (!key) return [];
  const role = PLATFORM_ROLES[key];
  if (!role) return [];
  /**
   * A DEACTIVATED account holds nothing, whatever its platform role says.
   *
   * Without this an operator who was switched off through the ordinary
   * account surface would keep full cross-tenant authority: `loadPrincipal()`
   * refuses a deactivated user, but this function is also called from
   * services and scripts that have their own read of the row. Enforcing it
   * at the single point where authority is computed means no caller can
   * forget. `active` is undefined on older rows, which is why the test is
   * `=== false` rather than falsy.
   */
  if (storedUser?.active === false) return [];
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

/**
 * May `actorRole` grant or revoke `targetRole`?
 *
 * Rule: never above your own rank. A super admin may create peers — with a
 * single super admin the platform has a bus factor of one, and there must be
 * a supported way to add a second. A platform_admin cannot grant anything at
 * all, because it does not hold `platform.admins.manage`; this function is
 * the second, independent check on the same decision.
 */
export function canGrantPlatformRole(actorRole, targetRole) {
  const actor = platformRank(actorRole);
  const target = platformRank(targetRole);
  if (!actor || !target) return false;
  return target <= actor;
}

/**
 * May `actorRole` act ON an account holding `targetRole`?
 *
 * A STRICTLY different question from `canGrantPlatformRole()`, and conflating
 * the two was a real defect caught by the P2B suite: a `platform_admin` was
 * able to deactivate a peer `platform_admin`, because granting deliberately
 * permits equal rank (a super admin must be able to create peers, or the
 * platform has a bus factor of one) while acting on somebody's ACCOUNT must
 * not (a lateral attack on a peer is exactly what an attacker with one
 * compromised operator account would attempt).
 *
 * So: grants are `<=`, administrative action on a peer is `<`.
 *
 * A target with no platform role at all is an ordinary tenant user, whom any
 * operator holding the relevant permission may administer.
 */
export function canAdministerPlatformUser(actorRole, targetRole) {
  const actor = platformRank(actorRole);
  if (!actor) return false;
  const target = platformRank(targetRole);
  if (!target) return true;
  return target < actor;
}

/**
 * A describe-yourself projection for the platform surface.
 *
 * The client uses it to decide whether to render platform navigation at all.
 * It is a convenience, never a control: every platform endpoint re-checks the
 * permission against storage.
 */
export function describePlatformSelf(storedUser) {
  const key = String(storedUser?.platformRole || '').trim();
  const role = PLATFORM_ROLES[key] || null;
  const permissions = platformPermissionsFor(storedUser);
  return {
    platform: permissions.length > 0,
    platformRole: permissions.length ? role.key : null,
    platformRoleName: permissions.length ? role.name : null,
    rank: permissions.length ? role.rank : 0,
    permissions
  };
}
