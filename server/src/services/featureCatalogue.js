/**
 * P2E — the authoritative feature catalogue.
 *
 * WHY THIS EXISTS
 * ---------------
 * P2C declared 18 feature KEYS in `models/billing.js` and built
 * `assertFeature()` to check them. It then never called it: the audit found
 * ZERO call sites. So a plan saying `onlineOrdering: false` gated nothing, and
 * online ordering worked perfectly on every plan.
 *
 * The keys alone were not enough to fix that, because they carry no
 * information about what enforcing them should MEAN. This file adds that:
 * what a feature protects, how it behaves when withheld, and which surfaces
 * stay reachable anyway. Enforcement then reads from one place instead of each
 * route inventing its own policy.
 *
 * THE KEYS THEMSELVES STAY IN `models/billing.js`. That is where plans
 * validate against them, and duplicating the list is how the two drift apart.
 * This module DESCRIBES those keys; it does not redefine them, and it asserts
 * at load time that it has not fallen out of step.
 *
 * UNKNOWN KEYS FAIL CLOSED. `describeFeature('anything')` returns null and
 * every guard treats that as "not entitled". A typo in a route is then a
 * refusal, not a silent hole — the opposite of the P1 lesson where Mongoose
 * silently stripped unknown fields.
 */
import {FEATURE_KEYS} from '../models/billing.js';

/**
 * Stable, machine-readable refusal codes.
 *
 * The client needs to distinguish "your plan does not include this" (sell them
 * an upgrade) from "your subscription lapsed" (take a payment) from "your
 * restaurant is suspended" (contact support). A single 402 with prose cannot
 * be branched on, and parsing English is not an interface.
 *
 * These sit ALONGSIDE the existing `reason` strings P2C already returns rather
 * than replacing them, so nothing that reads `reason` breaks.
 */
export const BILLING_ERROR_CODES = Object.freeze({
  FEATURE_NOT_ENTITLED: 'FEATURE_NOT_ENTITLED',
  FEATURE_UNKNOWN: 'FEATURE_UNKNOWN',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  SUBSCRIPTION_MISSING: 'SUBSCRIPTION_MISSING',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_CANCELLED: 'TENANT_CANCELLED',
  RESOURCE_LIMIT_REACHED: 'RESOURCE_LIMIT_REACHED'
});

/**
 * Map an entitlement `reason` (P2C's vocabulary) to a stable code.
 *
 * One translation point, so a new reason cannot quietly produce an
 * undocumented code.
 */
export function codeForReason(reason) {
  switch (reason) {
    case 'tenant_suspended': return BILLING_ERROR_CODES.TENANT_SUSPENDED;
    case 'tenant_cancelled': return BILLING_ERROR_CODES.TENANT_CANCELLED;
    case 'no_subscription':
    case 'no_restaurant':
    case 'invalid_restaurant':
    case 'plan_missing':
      return BILLING_ERROR_CODES.SUBSCRIPTION_MISSING;
    case 'trial_expired':
    case 'period_ended':
    case 'subscription_cancelled':
    case 'subscription_expired':
    case 'subscription_past_due':
      return BILLING_ERROR_CODES.SUBSCRIPTION_INACTIVE;
    case 'feature_not_in_plan':
      return BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED;
    case 'limit_reached':
      return BILLING_ERROR_CODES.RESOURCE_LIMIT_REACHED;
    default:
      return BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED;
  }
}

/**
 * How a feature behaves when it is NOT entitled.
 *
 *   block    the capability is refused outright (402).
 *   readonly existing data stays readable; only new activity is refused.
 *
 * `readonly` matters commercially and legally: a restaurant whose plan lapses
 * must still be able to serve the orders already in its kitchen and read its
 * own history. Deleting or hiding that would be punitive and, for a
 * VAT-registered business in Nepal, a compliance problem.
 */
export const ENFORCEMENT = Object.freeze({BLOCK: 'block', READONLY: 'readonly'});

/**
 * The catalogue.
 *
 * `implemented: false` is an honest marker, not a placeholder to be quietly
 * flipped. `apiAccess` has no API-key subsystem anywhere in this repository —
 * the audit grepped for it and found nothing — so it is declared, resolvable,
 * and explicitly NOT claimed to be enforced. Fabricating a key issuer to make
 * a flag pass would be exactly the fake integration the brief forbids.
 */
const CATALOGUE = Object.freeze({
  onlineOrdering: {
    key: 'onlineOrdering',
    label: 'Online ordering',
    description: 'Public storefront: menu browsing, quotes, order placement and online payment.',
    defaultEnabled: false,
    enforcement: ENFORCEMENT.READONLY,
    tenantScoped: true,
    platformOverride: true,
    implemented: true,
    /**
     * Surfaces that stay reachable when the feature is OFF.
     *
     * Branding and order tracking are deliberately excluded from the gate: a
     * guest holding an order number placed while the feature was live must
     * still be able to track it, and a restaurant's public identity is not the
     * paid capability. What is gated is the ability to TAKE new orders.
     */
    exemptSurfaces: ['branding', 'tracking', 'paymentReturn']
  },
  loyalty: {
    key: 'loyalty',
    label: 'Customer loyalty',
    description: 'Loyalty points balance and manual point adjustments on customer profiles.',
    defaultEnabled: false,
    enforcement: ENFORCEMENT.READONLY,
    tenantScoped: true,
    platformOverride: true,
    implemented: true,
    // Reading an existing balance is never gated — the points were earned
    // under a plan that allowed it, and hiding them looks like data loss.
    exemptSurfaces: ['balanceRead']
  },
  apiAccess: {
    key: 'apiAccess',
    label: 'API access',
    description: 'Programmatic API access with tenant-scoped API keys.',
    defaultEnabled: false,
    enforcement: ENFORCEMENT.BLOCK,
    tenantScoped: true,
    platformOverride: true,
    /**
     * NOT IMPLEMENTED, stated plainly.
     *
     * There is no API-key model, no key issuance, no key authentication
     * middleware and no `x-api-key` handling anywhere in the repository. The
     * entitlement is defined so plans can be modelled and so the boundary
     * exists for a later bounded phase; nothing pretends the capability is
     * shipped. `assertFeatureImplemented()` refuses to gate on it.
     */
    implemented: false,
    exemptSurfaces: []
  }
});

/** Feature keys P2E actively enforces. */
export const ENFORCED_FEATURES = Object.freeze(
  Object.values(CATALOGUE).filter(f => f.implemented).map(f => f.key)
);

/** Every key described here, implemented or not. */
export const CATALOGUED_FEATURES = Object.freeze(Object.keys(CATALOGUE));

/**
 * Load-time consistency check.
 *
 * A key described here that is not in the plan catalogue could never be
 * granted by any plan, so a guard on it would refuse everybody forever. Better
 * to fail at import than to ship a permanently closed door.
 */
for (const key of CATALOGUED_FEATURES) {
  if (!FEATURE_KEYS.includes(key)) {
    throw new Error(
      `featureCatalogue describes "${key}", which is not in FEATURE_KEYS. `
      + 'A feature no plan can grant would refuse every tenant.'
    );
  }
}

/**
 * Describe a feature. Returns `null` for anything not catalogued — the
 * fail-closed default every caller relies on.
 */
export function describeFeature(key) {
  if (typeof key !== 'string') return null;
  return CATALOGUE[key] || null;
}

/** Is this a key P2E knows how to enforce? */
export function isEnforceableFeature(key) {
  const feature = describeFeature(key);
  return Boolean(feature && feature.implemented);
}

/**
 * Guard against gating on a feature that does not exist yet.
 *
 * Called by the enforcement layer. Without it, someone wiring
 * `requireFeature('apiAccess')` onto a route would produce an endpoint that
 * refuses everybody with no way to satisfy it, and the failure would look like
 * a billing problem rather than a wiring mistake.
 */
export function assertFeatureImplemented(key) {
  const feature = describeFeature(key);
  if (!feature) {
    throw Object.assign(new Error(`Unknown feature: ${key}`), {
      status: 500, code: BILLING_ERROR_CODES.FEATURE_UNKNOWN
    });
  }
  if (!feature.implemented) {
    throw Object.assign(
      new Error(`Feature "${key}" is catalogued but not implemented; it cannot be enforced yet`),
      {status: 500, code: BILLING_ERROR_CODES.FEATURE_UNKNOWN}
    );
  }
  return feature;
}

/** Client-safe catalogue for the tenant's own settings screen. */
export function publicFeatureCatalogue() {
  return CATALOGUED_FEATURES.map(key => {
    const feature = CATALOGUE[key];
    return {
      key: feature.key,
      label: feature.label,
      description: feature.description,
      enforcement: feature.enforcement,
      implemented: feature.implemented
    };
  });
}
