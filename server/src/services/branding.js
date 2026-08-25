/**
 * P2D — THE authoritative branding resolver.
 *
 * One place answers "what does this restaurant look like?". Every
 * customer-facing surface asks it; no page queries branding fields itself.
 * That is the difference between one product with 100 tenants and 100 forks.
 *
 * SAFE DEFAULTS, NEVER WRITTEN BACK
 * ---------------------------------
 * A tenant that has configured nothing must still render correctly. The
 * resolver fills every gap from `PRODUCT_DEFAULTS`, and does NOT persist what
 * it filled in: writing a default into the database turns "the owner never
 * chose" into "the owner chose this", which then survives a change to the
 * product default and cannot be told apart from a deliberate setting.
 *
 * ENTITLEMENT-AWARE
 * -----------------
 * `advancedBranding` and `whiteLabel` gate whole tiers of fields (P2D-N/O). A
 * tenant that stored advanced values and then downgraded keeps the values in
 * the database — they are not destroyed — but the resolver stops APPLYING
 * them. Downgrading must not vandalise data the tenant may pay for again next
 * month, and upgrading must not require re-entering everything.
 *
 * TIER FILTERING HAPPENS HERE, ONCE. If each surface checked entitlements
 * itself, one of them would eventually forget, and a Starter tenant would get
 * white-label output on a receipt but not the storefront.
 */
import mongoose from 'mongoose';
import {Restaurant} from '../models/operations.js';
import {
  BRANDING_FIELDS, BRANDING_KEYS, TIER_FEATURE, fontStackFor
} from './brandingSchema.js';
import {resolveEntitlement} from './entitlements.js';

/**
 * The product's own defaults.
 *
 * Deliberately neutral: a restaurant that sets nothing should look like a
 * competent generic product, not like the demo tenant. Frozen so a caller
 * cannot mutate the shared object and silently change every other tenant's
 * appearance in the same process.
 */
export const PRODUCT_DEFAULTS = Object.freeze({
  displayName: null,          // falls back to Restaurant.name — see below
  tagline: null,
  logoUrl: null,              // surfaces render initials instead
  faviconUrl: null,
  primaryColor: '#0f172a',
  secondaryColor: '#334155',
  accentColor: '#2563eb',
  backgroundColor: '#f8fafc',
  textColor: '#0f172a',
  fontFamily: 'system',
  receiptLogoEnabled: false,
  receiptFooter: null,
  storefrontTitle: null,      // falls back to the display name
  storefrontSubtitle: null,
  storefrontNotice: null,
  storefrontFooter: null,
  orderingInstructions: null,
  hideProductBranding: false,
  supportEmail: null,
  supportPhone: null,
  websiteUrl: null,
  facebookUrl: null,
  instagramUrl: null
});

/**
 * A short-lived per-process cache.
 *
 * Branding is read on the storefront, the POS shell and every receipt, so an
 * uncached resolver adds two queries to a lot of requests. But cached state
 * that governs what a customer sees must not be able to go stale
 * indefinitely — the Phase 20 lesson about caching authority applies in a
 * milder form here.
 *
 * So: explicit invalidation on every write that can change the answer, and a
 * 60-second TTL as the backstop for a path somebody forgets to hook.
 *
 * MULTI-INSTANCE BEHAVIOUR, STATED PLAINLY: this Map is per process. With
 * several API containers, a branding change invalidates only the instance that
 * served the write; the others keep serving the previous value until their own
 * entry expires. The worst case is therefore ONE MINUTE of stale colours or an
 * old logo on some instances — cosmetic, self-healing, and not a correctness
 * or security problem, which is why a shared cache (Redis) is not justified
 * here. Recorded in SAAS-ARCHITECTURE.md rather than pretended away.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map();

export function invalidateBranding(restaurantId) {
  if (!restaurantId) return cache.clear();
  cache.delete(String(restaurantId));
}

/** Test seam, so cache behaviour is assertable without waiting a minute. */
export function __brandingCacheSize() {
  return cache.size;
}

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

/**
 * Which branding tiers this restaurant may actually use.
 *
 * Reads the P2C entitlement resolver — the existing mechanism — rather than
 * inspecting a plan code. `hasFeature()` is not used directly because all
 * three answers are needed at once and one resolve is cheaper than three.
 */
export async function brandingTiers(restaurantId) {
  const entitlement = await resolveEntitlement(restaurantId);
  return {
    core: true,
    /**
     * Note the `operational` conjunct. A tenant whose subscription has lapsed
     * keeps `readOnly` access to their data (the P2C rule), but must not keep
     * receiving paid-tier PRESENTATION. Their storefront reverts to core
     * branding until they are operational again; nothing is deleted.
     */
    advanced: entitlement.operational && entitlement.features.advancedBranding === true,
    white: entitlement.operational && entitlement.features.whiteLabel === true,
    customDomain: entitlement.operational && entitlement.features.customDomain === true,
    planCode: entitlement.planCode,
    operational: entitlement.operational
  };
}

/**
 * Resolve the effective branding for a restaurant.
 *
 * Returns a complete object — every key present, no `undefined` — so a caller
 * never has to write `branding.primaryColor || '#something'`. That fallback,
 * repeated at 30 call sites, is precisely how per-page defaults drift apart.
 */
export async function getRestaurantBranding(restaurantId, {fresh = false} = {}) {
  if (!restaurantId || !mongoose.isValidObjectId(restaurantId)) {
    return {...PRODUCT_DEFAULTS, displayName: 'Restaurant', fontStack: fontStackFor('system'),
      restaurantId: null, tiers: {core: true, advanced: false, white: false, customDomain: false}};
  }
  const key = String(restaurantId);
  if (!fresh) {
    const hit = cached(key);
    if (hit) return hit;
  }

  const restaurant = await Restaurant.findById(restaurantId)
    .select('name legalName branding receiptFooter phone address pan currency timezone')
    .lean();
  if (!restaurant) {
    return {...PRODUCT_DEFAULTS, displayName: 'Restaurant', fontStack: fontStackFor('system'),
      restaurantId: null, tiers: {core: true, advanced: false, white: false, customDomain: false}};
  }

  const tiers = await brandingTiers(restaurantId);
  const stored = restaurant.branding || {};
  const resolved = {};

  for (const key2 of BRANDING_KEYS) {
    const tier = BRANDING_FIELDS[key2].tier;
    const feature = TIER_FEATURE[tier];
    // A tier the tenant is not entitled to falls back to the product default.
    // The stored value survives in the database untouched.
    const entitled = feature === null ? true : Boolean(tiers[tier]);
    const value = entitled ? stored[key2] : undefined;
    resolved[key2] = value === undefined || value === null ? PRODUCT_DEFAULTS[key2] : value;
  }

  /**
   * Sensible cascades, so a tenant who fills in one field gets a coherent
   * result rather than a half-branded page.
   */
  if (!resolved.displayName) resolved.displayName = restaurant.name || 'Restaurant';
  if (!resolved.storefrontTitle) resolved.storefrontTitle = resolved.displayName;
  /**
   * `receiptFooter` has lived on `Restaurant` since long before P2D and is
   * still editable through `PATCH /api/my/restaurant`. Branding wins when set,
   * so the newer, richer surface takes precedence, but the legacy value keeps
   * working for every tenant that never touches the branding screen.
   */
  if (!resolved.receiptFooter) resolved.receiptFooter = restaurant.receiptFooter || null;
  if (!resolved.supportPhone) resolved.supportPhone = restaurant.phone || null;

  const value = {
    ...resolved,
    // The CSS stack is resolved server-side from the allowlist, so a client
    // never receives — and can never inject — a raw font-family string.
    fontStack: fontStackFor(resolved.fontFamily),
    restaurantId: restaurant._id,
    legalName: restaurant.legalName || restaurant.name || null,
    currency: restaurant.currency || 'NPR',
    timezone: restaurant.timezone || 'Asia/Kathmandu',
    tiers: {
      core: true, advanced: tiers.advanced, white: tiers.white, customDomain: tiers.customDomain
    }
  };

  cache.set(key, {value, expires: Date.now() + CACHE_TTL_MS});
  return value;
}

/**
 * The PUBLIC projection — what an unauthenticated storefront visitor gets.
 *
 * Hand-built, and deliberately narrow. It carries no PAN, no legal name, no
 * address, no plan code and no internal ids beyond the restaurant's own. A
 * guest ordering a biryani has no business knowing the tenant's tax number or
 * which SaaS plan they bought.
 */
export function publicBrandingView(branding) {
  return {
    displayName: branding.displayName,
    tagline: branding.tagline,
    logoUrl: branding.logoUrl,
    faviconUrl: branding.faviconUrl,
    primaryColor: branding.primaryColor,
    secondaryColor: branding.secondaryColor,
    accentColor: branding.accentColor,
    backgroundColor: branding.backgroundColor,
    textColor: branding.textColor,
    fontStack: branding.fontStack,
    storefrontTitle: branding.storefrontTitle,
    storefrontSubtitle: branding.storefrontSubtitle,
    storefrontNotice: branding.storefrontNotice,
    storefrontFooter: branding.storefrontFooter,
    orderingInstructions: branding.orderingInstructions,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    websiteUrl: branding.websiteUrl,
    facebookUrl: branding.facebookUrl,
    instagramUrl: branding.instagramUrl,
    hideProductBranding: branding.hideProductBranding === true,
    currency: branding.currency
  };
}

/**
 * The STAFF projection — the authenticated workspace shell.
 *
 * Slightly wider than public (it may name the legal entity), still no tax
 * identity: the POS header does not need a PAN, and receipts get theirs from
 * the invoice snapshot rather than from here.
 */
export function staffBrandingView(branding) {
  return {
    displayName: branding.displayName,
    legalName: branding.legalName,
    tagline: branding.tagline,
    logoUrl: branding.logoUrl,
    faviconUrl: branding.faviconUrl,
    primaryColor: branding.primaryColor,
    secondaryColor: branding.secondaryColor,
    accentColor: branding.accentColor,
    backgroundColor: branding.backgroundColor,
    textColor: branding.textColor,
    fontStack: branding.fontStack,
    hideProductBranding: branding.hideProductBranding === true,
    currency: branding.currency,
    timezone: branding.timezone,
    tiers: branding.tiers
  };
}

/**
 * The identity block for a RECEIPT.
 *
 * Cosmetic only — logo toggle and footer. The legally significant fields
 * (legal name, PAN, address) come from the invoice snapshot written when the
 * invoice was issued, never from here. Keeping those two sources apart is the
 * whole point of P2D-K: branding is allowed to change, an issued invoice is
 * not.
 */
export function receiptBrandingView(branding) {
  return {
    displayName: branding.displayName,
    logoUrl: branding.receiptLogoEnabled ? branding.logoUrl : null,
    receiptLogoEnabled: branding.receiptLogoEnabled === true,
    footer: branding.receiptFooter
  };
}
