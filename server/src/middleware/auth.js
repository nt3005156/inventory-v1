import jwt from 'jsonwebtoken';
import {resolvePrincipal} from '../services/accessControl.js';
import {BASE_ROLES, grants} from '../services/permissions.js';

/**
 * Phase 25 — how a bearer token is verified.
 *
 * `jwt.verify(token, secret)` on its own is too permissive in two ways that a
 * probe confirmed:
 *
 *   1. NO ALGORITHM ALLOWLIST. The library defaults to accepting whatever the
 *      token's own header asks for. `alg: none` happens to be refused when a
 *      secret is supplied, but an HS/RS confusion attack turns on exactly this
 *      behaviour, and relying on a library default for it is not a control.
 *      Pinning HS256 makes the intent explicit and version-proof.
 *
 *   2. `exp` WAS OPTIONAL. A token minted without an expiry verified happily
 *      and never stopped working — reproduced: a token with a one-year-old
 *      `iat` and no `exp` returned 200, and held a websocket open. Nothing
 *      legitimate lacks one (`signToken()` always sets 12h), but a token
 *      minted by any path that forgot to would have been a PERMANENT
 *      credential that session-version revocation is the only brake on.
 *
 * NOTE: jsonwebtoken has no `requireExp` option — passing one is silently
 * ignored, which is exactly how a "fix" can look applied and do nothing. The
 * first attempt here did that and the probe still returned 200. The claim is
 * therefore asserted explicitly below.
 *
 * Both rules live in ONE function so no call site (HTTP guard or Socket.IO
 * handshake) can forget them.
 */
export const JWT_VERIFY_OPTIONS = Object.freeze({algorithms: ['HS256']});

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
  if (typeof payload?.exp !== 'number') {
    // Same error type the library raises, so every existing catch that maps a
    // JsonWebTokenError to 401 keeps working unchanged.
    throw new jwt.JsonWebTokenError('Token must carry an expiry');
  }
  return payload;
}

/** Every role that is part of restaurant operations, excluding riders. */
export const STAFF_ROLES = Object.freeze(['owner', 'manager', 'staff']);

/**
 * Verify the bearer token and resolve the principal against the DATABASE.
 *
 * Phase 20 changed what happens after the signature checks out. The token is
 * now only proof of identity; role, activation state and permissions are read
 * live from storage by `resolvePrincipal()`. See accessControl.js for the
 * reproduced defect this closes — a deactivated employee's existing token
 * could still move stock and take money.
 *
 * `req.user` keeps its historical shape (`id`, `role`, `branch`,
 * `restaurantId`, `name`) because ~135 call sites and a dozen services read
 * those fields. `req.principal` is the new, richer object.
 */
/**
 * The token's own claims, or null if it is missing or unverifiable.
 *
 * Used ONLY to decide between a 401 and a 403 before the database lookup.
 * Never used to grant anything.
 */
function readClaim(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

async function authenticate(req) {
  const token = req.headers.authorization?.split(' ')[1];
  const payload = verifyAccessToken(token);
  const principal = await resolvePrincipal(payload);

  req.principal = principal;
  req.user = {
    ...payload,
    // Storage wins over the claim for everything that governs access. A token
    // is a 12-hour snapshot; the database is the truth.
    id: payload.id,
    role: principal.baseRole,
    roleKey: principal.roleKey,
    branch: principal.branch,
    restaurantId: principal.restaurantId
  };
  return principal;
}

function deny(res, error) {
  const status = error?.status === 403 ? 403 : 401;
  /**
   * A 403 is normally flattened to one message so the API does not disclose
   * WHICH permission was missing — that is an enumeration aid.
   *
   * P2A carves out one exception: a suspended or cancelled TENANT. That is not
   * a permission problem and the caller can act on it ("contact the platform
   * administrator"), whereas "Insufficient permission" would send a whole
   * restaurant's staff hunting a role misconfiguration that does not exist.
   * The message names no other tenant and discloses no permission, so it adds
   * no enumeration surface. Marked with an explicit flag rather than sniffed
   * from the text.
   */
  const message = status === 403
    ? (error?.tenantLifecycle && error.message ? error.message : 'Insufficient permission')
    : (error?.status === 401 && error.message ? error.message : 'Authentication required');
  return res.status(status).json({message});
}

/**
 * Authenticate, and optionally authorise against a role list.
 *
 * IMPORTANT (Phase 10): `auth()` with no roles means "any authenticated
 * principal", which now includes riders. A rider is the least-privileged
 * account in the system, so `auth()` must NOT be used to guard anything
 * operational. Use `requireStaff()` for endpoints that are staff-only but not
 * role-specific.
 *
 * Phase 20: the role list is matched against the BASE role, so an existing
 * `auth(['owner','manager'])` keeps behaving exactly as it did. A custom role
 * additionally has to hold the endpoint's permission — see `requirePermission`.
 */
export const auth = (roles = []) => async (req, res, next) => {
  try {
    /**
     * The role list is checked against the TOKEN's claim first, before the
     * database is consulted, purely to preserve the historical status code:
     * a role that is not permitted for this endpoint has always been 403,
     * while a token that disagrees with storage has always been 401.
     *
     * This ordering cannot admit anyone it should not. `authenticate()` runs
     * immediately afterwards and requires the claimed role to equal the stored
     * role, so checking the claim here is equivalent to checking storage — it
     * can only ever reject earlier, never grant.
     */
    const claimed = readClaim(req);
    if (roles.length && claimed && !roles.includes(claimed.role)) {
      return res.status(403).json({message: 'Insufficient permission'});
    }

    const principal = await authenticate(req);
    if (roles.length && !roles.includes(principal.baseRole)) {
      return res.status(403).json({message: 'Insufficient permission'});
    }
    /**
     * FAIL CLOSED for custom roles.
     *
     * A custom role must not inherit its base role's reach simply because the
     * legacy list admits that base. If a Cashier built on `staff` were let
     * through every `auth(['owner','manager','staff'])` endpoint, it would
     * hold refunds-adjacent surface, stock counts and goods receipt — the
     * entire point of a narrow role would be gone.
     *
     * So a custom role is admitted ONLY through `requirePermission()`, which
     * states exactly which permission an endpoint needs. An endpoint still
     * guarded by a bare role list has not been classified yet and therefore
     * refuses custom roles outright. That is deliberately conservative: the
     * failure mode is "a custom role cannot reach something it maybe should",
     * which an owner can see and report, rather than "a custom role silently
     * reaches something it must not".
     *
     * The four built-in roles are unaffected, so no existing deployment
     * changes behaviour.
     */
    if (principal.custom) {
      return res.status(403).json({
        message: 'Insufficient permission'
      });
    }
    next();
  } catch (error) {
    return deny(res, error);
  }
};

/**
 * Authenticate only — no role or permission requirement.
 *
 * Used by `/me/permissions`, which every principal (riders included) must be
 * able to read about THEMSELVES. Deliberately named so it can never be
 * confused with the historical bare `auth()`, which a test forbids.
 */
export const authenticated = () => async (req, res, next) => {
  try {
    await authenticate(req);
    next();
  } catch (error) {
    return deny(res, error);
  }
};

/**
 * Guard an endpoint by PERMISSION — the Phase 20 primitive.
 *
 * Authenticates, then requires the permission. An owner always passes. This is
 * the authoritative control: the client hiding a button is presentation only.
 */
export const requirePermission = (...permissions) => async (req, res, next) => {
  try {
    let principal;
    try {
      principal = await authenticate(req);
    } catch (error) {
      /**
       * Preserve the historical 401/403 split.
       *
       * A token whose claimed role is not a real role — the forged
       * `role: 'guest'` several suites use to prove an endpoint is closed —
       * must read as "you may not do this" (403), not "your session expired"
       * (401). `authenticate()` raises 401 for that case because storage and
       * claim disagree, so it is reclassified here.
       *
       * Only a role that does not exist at all is reclassified. A genuine
       * demotion or a deactivated account still ends the session with 401,
       * which is what the Phase 20 fix depends on.
       */
      const claimed = readClaim(req);
      if (claimed && !BASE_ROLES.includes(claimed.role)) {
        return res.status(403).json({message: 'Insufficient permission'});
      }
      throw error;
    }
    const allowed = permissions.some(permission => grants(principal, permission));
    if (!allowed) {
      return res.status(403).json({message: 'Insufficient permission'});
    }
    next();
  } catch (error) {
    return deny(res, error);
  }
};

/**
 * Guard a SELF-SCOPED endpoint: the permission must be EXPLICITLY held.
 *
 * `requirePermission()` lets an owner through everything, because an owner
 * implicitly holds `*`. That is right for administrative capability, and
 * wrong for an endpoint that operates on "my own" records.
 *
 * PROVEN before this was added: `GET /api/deliveries/mine/dashboard` returned
 * 200 to an owner with a synthesised rider profile built from their own user
 * document, and `/deliveries/mine` returned an empty list rather than a
 * refusal. No other rider's data leaked — the handlers scope by `user.id` —
 * but an owner was still transacting against a rider-private surface, and
 * `PATCH /deliveries/mine/availability` reached the service before failing
 * 404 "Rider not found". A principal who is not a rider has no business
 * inside the rider workspace at all.
 *
 * So this guard requires the permission to come from the principal's OWN
 * role bundle and refuses the owner's implicit grant. Checking the permission
 * Set alone is not sufficient: `resolvePrincipal()` materialises the full
 * catalogue into an owner's Set, so `.has('deliveries.ride')` is true for
 * them — verified. The owner is therefore excluded explicitly, and the base
 * role must be one the capability actually belongs to.
 *
 * `selfScopeRoles` names the base roles for which the endpoint is meaningful.
 * A custom role built on one of them, and explicitly granted the permission,
 * is admitted — so a tenant-defined "Courier" works exactly like a rider.
 */
export const requireSelfScopedPermission = (permission, {
  selfScopeRoles = ['rider']
} = {}) => async (req, res, next) => {
  try {
    const principal = await authenticate(req);
    const held = Boolean(principal.permissions?.has?.(permission));
    const inScope = selfScopeRoles.includes(principal.baseRole);
    if (!held || !inScope) {
      return res.status(403).json({message: 'Insufficient permission'});
    }
    next();
  } catch (error) {
    return deny(res, error);
  }
};

/**
 * Any restaurant employee, but never a rider.
 *
 * Introduced because adding the rider role would otherwise have silently
 * widened every bare `auth()` endpoint — the branch list, transfers and the
 * expense ledger among them — to delivery riders.
 */
export const requireStaff = () => auth(STAFF_ROLES);
