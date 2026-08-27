/**
 * P2E — THE feature enforcement guard.
 *
 * One mechanism, two entry points, because the codebase genuinely has two
 * kinds of protected surface and they resolve their tenant differently:
 *
 *   `requireFeature(key)`        authenticated staff routes. Tenant comes from
 *                                the authenticated principal.
 *   `assertPublicFeature(...)`   the public storefront. Tenant is derived from
 *                                a BRANCH id, using the existing
 *                                `resolvePublicBranch()` — the mechanism the
 *                                storefront already trusts for menus and
 *                                quotes.
 *
 * Both funnel into `assertFeature()`, P2C's resolver. There is deliberately no
 * second entitlement implementation: the audit found P2C had a perfectly good
 * one that nothing called, and the fix is to call it, not to write another.
 *
 * WHAT THE GUARD WILL NOT DO
 * --------------------------
 * It never reads a feature name, an entitlement, a plan or a restaurant id
 * from the request body, the query string or a JWT claim. Every one of those
 * is caller-controlled. The feature key is a literal supplied by the route at
 * mount time; the tenant is derived from authenticated state or from a branch
 * the database confirms exists.
 *
 * A client sending `{"feature":"onlineOrdering","enabled":true}` changes
 * nothing, because nothing in this path reads it.
 *
 * TENANT ENUMERATION
 * ------------------
 * A refusal must not reveal whether another restaurant exists or what it has
 * bought. The public guard therefore answers 404 for an unknown or inactive
 * branch (the same answer `resolvePublicBranch()` already gives) and 402 for a
 * real branch whose tenant lacks the feature — never a message naming another
 * tenant, its plan, or its subscription state.
 */
import {assertFeatureImplemented, BILLING_ERROR_CODES} from './featureCatalogue.js';
import {assertFeature, billingEnforcementActive, resolveEntitlement} from './entitlements.js';
import {userRestaurantContext} from './supplierCatalog.js';

function httpError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), {status, ...extra});
}

/**
 * Express middleware for an AUTHENTICATED route.
 *
 * Mounted after the permission guard, so the ordering of refusals is
 * deliberate: 401 (who are you) → 403 (may your role do this) → 402 (does your
 * plan include it). Answering 402 before 403 would tell an unauthorised caller
 * which features a tenant has bought.
 */
export function requireFeature(featureKey, {label} = {}) {
  // Fails at mount time, not per request, if the key is unknown or not yet
  // implemented — a wiring mistake should not look like a billing problem.
  const feature = assertFeatureImplemented(featureKey);

  return async function featureGuard(req, res, next) {
    try {
      // Tenant from the authenticated principal. Never from the request.
      const {restaurantId} = await userRestaurantContext(req.user);
      await assertFeature(restaurantId, feature.key, {label: label || feature.label});
      req.featureEntitlement = {feature: feature.key, restaurantId};
      return next();
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status === 402) {
        return res.status(402).json({
          message: error.message,
          code: error.code || BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED,
          feature: feature.key
        });
      }
      // Anything else (401/403/500) keeps its own contract.
      return res.status(status >= 400 && status < 600 ? status : 500)
        .json({message: status >= 500 ? 'Server error' : error.message});
    }
  };
}

/**
 * Assert a feature for a PUBLIC, unauthenticated request, given a branch.
 *
 * Returns the branch so the caller does not resolve it twice. Throws 404 for
 * an unknown or inactive branch and 402 when the tenant is not entitled.
 *
 * `resolvePublicBranch` is injected rather than imported at module scope to
 * avoid a cycle: `storefront.js` will import this module to guard its own
 * routes.
 */
export async function assertPublicFeature({branchId, feature: featureKey, resolveBranch, label}) {
  const feature = assertFeatureImplemented(featureKey);
  const branch = await resolveBranch(branchId);
  if (!branch?.restaurant) throw httpError('Branch not found', 404);

  await assertFeature(branch.restaurant, feature.key, {label: label || feature.label});
  return branch;
}

/**
 * Is a feature available, without throwing? For read paths that DEGRADE rather
 * than refuse — a storefront that shows branding but hides the order button.
 *
 * Deliberately mirrors the enforcement gate: when billing enforcement is off
 * this reports `true`, so a deployment that has not been provisioned for
 * billing behaves exactly as it did before P2E.
 */
export async function featureAvailable(restaurantId, featureKey) {
  const feature = assertFeatureImplemented(featureKey);
  if (!await billingEnforcementActive()) return true;
  const entitlement = await resolveEntitlement(restaurantId);
  return entitlement.operational && entitlement.features[feature.key] === true;
}

/**
 * The tenant's own view of which catalogued features it may use.
 *
 * Distinguishes the three states the UI must show differently:
 *   available            plan includes it and the subscription is healthy
 *   not_in_plan          upgrade required
 *   subscription_*       plan includes it but the subscription lapsed
 *
 * A UI that collapses those into "unavailable" sends an owner to the wrong
 * remedy, so the server names the distinction rather than leaving the client
 * to guess.
 */
export async function describeTenantFeatures(restaurantId) {
  const entitlement = await resolveEntitlement(restaurantId, {fresh: true});
  const enforcing = await billingEnforcementActive();
  const {CATALOGUED_FEATURES, describeFeature} = await import('./featureCatalogue.js');

  return CATALOGUED_FEATURES.map(key => {
    const feature = describeFeature(key);
    const inPlan = entitlement.features[key] === true;
    let state;
    if (!feature.implemented) state = 'not_implemented';
    else if (!enforcing) state = 'available';
    else if (!inPlan) state = 'not_in_plan';
    else if (!entitlement.operational) state = 'subscription_inactive';
    else state = 'available';

    return {
      key,
      label: feature.label,
      description: feature.description,
      implemented: feature.implemented,
      inPlan,
      state,
      available: state === 'available',
      // Only meaningful when the subscription is the blocker.
      reason: state === 'subscription_inactive' ? entitlement.reason : null
    };
  });
}
