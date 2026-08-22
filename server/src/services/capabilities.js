/**
 * Phase 17 — shared service-level capability check.
 *
 * Several services carried their own `['owner','manager'].includes(role)`
 * guard as defence in depth behind the route. Once the routes became
 * permission-based those lists turned into a SECOND, contradictory
 * authorisation system: a custom role holding the right permission passed the
 * route and was then refused inside the service, so custom roles could not
 * perform the capability at all.
 *
 * The defence-in-depth check is kept — a service must not assume its caller
 * guarded it — but it now speaks the same vocabulary as the route:
 *
 *   • a resolved principal decides by PERMISSION;
 *   • an owner always passes;
 *   • a resolved CUSTOM role is authoritative, so a missing permission is a
 *     real refusal rather than a reason to fall back;
 *   • with no principal (an internal call, a script, an older code path) the
 *     legacy role list applies exactly as before.
 */

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

export const LEGACY_MANAGEMENT_ROLES = Object.freeze(['owner', 'manager']);

export function hasCapability(user, principal, permission, {
  legacyRoles = LEGACY_MANAGEMENT_ROLES
} = {}) {
  if (principal) {
    if (principal.baseRole === 'owner') return true;
    if (principal.permissions?.has?.(permission)) return true;
    if (principal.custom) return false;
  }
  return legacyRoles.includes(String(user?.role || principal?.baseRole || ''));
}

export function assertCapability(user, principal, permission, message = 'Insufficient permission', options) {
  if (!hasCapability(user, principal, permission, options)) throw httpError(message, 403);
  return true;
}
