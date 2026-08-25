/**
 * P2D — branding and settings administration.
 *
 * TWO AUDIENCES, KEPT APART
 * -------------------------
 *   TENANT      edits its OWN branding. The restaurant is taken from the
 *               authenticated principal — there is no id parameter anywhere in
 *               the tenant path, so it cannot be aimed at another restaurant.
 *   PLATFORM    may view any tenant's branding, and (admin and above) correct
 *               it. Authority comes from `platformRole`, never tenant RBAC.
 *
 * A platform operator editing a tenant's branding is a SUPPORT action, audited
 * with a distinct action name so the trail can distinguish "the restaurant
 * rebranded itself" from "the platform changed their logo". Those are different
 * events and a support conversation depends on telling them apart.
 *
 * ENTITLEMENTS ARE ENFORCED AT WRITE TIME AS WELL AS READ TIME
 * ------------------------------------------------------------
 * `getRestaurantBranding()` refuses to APPLY a tier the plan does not include.
 * That alone would let a Starter tenant store white-label values that silently
 * activate if they ever upgrade — surprising, and it means the database
 * contains settings nobody approved. So writes are refused too, at the service
 * layer, with a 402 that names the feature.
 *
 * Every mutation is audited: actor, restaurant, category, and a before/after
 * limited to the keys that actually changed. No secret is ever recorded —
 * branding contains none, and the settings catalogue cannot express one.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {Restaurant} from '../models/operations.js';
import {
  BRANDING_FIELDS, SETTINGS_CATALOG, SETTINGS_CATEGORIES, TIER_FEATURE,
  defaultSettings, normalizeDomain, validateBrandingPatch, validateSettingsPatch
} from './brandingSchema.js';
import {brandingTiers, getRestaurantBranding, invalidateBranding} from './branding.js';
import {assertPlatform} from './platformAdmin.js';
import {userRestaurantContext} from './supplierCatalog.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * Refuse a patch that touches a tier the tenant's plan does not include.
 *
 * 402 rather than 403, matching P2C: "your plan does not include this" is a
 * different problem from "your role does not allow this", and conflating them
 * sends an owner hunting a permission misconfiguration that does not exist.
 *
 * Platform operators are exempt. A support agent fixing a tenant's logo must
 * not be blocked by that tenant's plan — they are not the one being sold to.
 */
async function assertBrandingTiersAllowed(restaurantId, patch, {viaPlatform = false} = {}) {
  if (viaPlatform) return null;
  const tiers = await brandingTiers(restaurantId);
  for (const key of Object.keys(patch)) {
    const tier = BRANDING_FIELDS[key].tier;
    const feature = TIER_FEATURE[tier];
    if (feature === null) continue;
    if (!tiers[tier]) {
      throw Object.assign(
        httpError(
          `"${key}" is part of ${tier === 'white' ? 'white-label' : 'advanced'} branding, `
          + `which is not included in the ${tiers.planCode || 'current'} plan.`,
          402
        ),
        {billing: true, reason: 'feature_not_in_plan', feature}
      );
    }
  }
  return tiers;
}

/** Only the keys that actually changed, for a readable audit diff. */
function diffOf(before, after, keys) {
  const changedBefore = {};
  const changedAfter = {};
  for (const key of keys) {
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changedBefore[key] = from;
      changedAfter[key] = to;
    }
  }
  return {before: changedBefore, after: changedAfter, keys: Object.keys(changedAfter)};
}

// ── tenant surface ───────────────────────────────────────────────────────────

/**
 * The caller's own branding, plus what their plan permits them to edit.
 *
 * `editable` drives the UI. It is a convenience, never a control: the write
 * path re-checks the same entitlement server-side.
 */
export async function getOwnBranding({user}) {
  const {restaurantId} = await userRestaurantContext(user);
  const branding = await getRestaurantBranding(restaurantId, {fresh: true});
  const tiers = await brandingTiers(restaurantId);

  const restaurant = await Restaurant.findById(restaurantId)
    .select('name legalName pan phone address currency timezone customDomain customDomainVerified')
    .lean();

  const stored = (await Restaurant.findById(restaurantId).select('branding').lean())?.branding || {};

  return {
    // What the tenant has actually SET, so the form shows their own values
    // rather than the resolved defaults (which would make every empty field
    // look filled in and turn the first save into an accidental commitment).
    branding: stored,
    // What surfaces will actually render, defaults and tier filtering applied.
    resolved: branding,
    identity: {
      name: restaurant?.name || null,
      legalName: restaurant?.legalName || null,
      pan: restaurant?.pan || null,
      phone: restaurant?.phone || null,
      address: restaurant?.address || null,
      currency: restaurant?.currency || 'NPR',
      timezone: restaurant?.timezone || 'Asia/Kathmandu'
    },
    customDomain: {
      domain: restaurant?.customDomain || null,
      verified: Boolean(restaurant?.customDomainVerified),
      // Stated so nobody believes DNS/TLS is handled — see P2D-M.
      serving: false
    },
    tiers,
    editable: {
      core: true,
      advanced: tiers.advanced,
      white: tiers.white,
      customDomain: tiers.customDomain
    }
  };
}

/**
 * Update branding.
 *
 * `restaurantId` is resolved from the principal on the tenant path and is a
 * checked parameter on the platform path; it is NEVER read from the request
 * body. A `restaurant` field in the payload is rejected by the route's strict
 * schema and would be ignored here regardless.
 */
export async function updateBranding({user, patch, restaurantId = null, viaPlatform = false, reason}) {
  let targetId;
  let actor;

  if (viaPlatform) {
    actor = await assertPlatform(user, 'platform.restaurants.update');
    if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);
    targetId = restaurantId;
  } else {
    const identity = await userRestaurantContext(user);
    targetId = identity.restaurantId;
    actor = {_id: identity.userId, name: user?.name || null};
  }

  const validated = validateBrandingPatch(patch);
  if (!Object.keys(validated).length) throw httpError('No branding fields were supplied', 400);

  await assertBrandingTiersAllowed(targetId, validated, {viaPlatform});

  const restaurant = await Restaurant.findById(targetId);
  if (!restaurant) throw httpError('Restaurant not found', 404);

  const before = {...(restaurant.branding || {})};
  const next = {...before};
  for (const [key, value] of Object.entries(validated)) {
    // `null` clears a field rather than storing a null, so the resolver's
    // default applies and the document does not accumulate dead keys.
    if (value === null) delete next[key];
    else next[key] = value;
  }
  restaurant.branding = next;
  restaurant.markModified('branding');
  await restaurant.save();

  const diff = diffOf(before, next, Object.keys(validated));

  await Audit.create({
    entity: 'restaurant',
    entityId: restaurant._id,
    restaurant: restaurant._id,
    // Distinct actions: a tenant rebranding itself and the platform correcting
    // a tenant are different events, and support needs to tell them apart.
    action: viaPlatform ? 'platform_branding_updated' : 'branding_updated',
    before: diff.before,
    after: diff.after,
    reason: clean(reason) || undefined,
    user: actor._id,
    userName: actor.name || undefined,
    userRole: viaPlatform ? `platform:${actor.platformRole}` : undefined
  });

  // The rendered answer has changed, so the cached copy is now wrong.
  invalidateBranding(targetId);

  return {
    branding: next,
    resolved: await getRestaurantBranding(targetId, {fresh: true}),
    changed: diff.keys
  };
}

/** The caller's own operational settings, merged over the product defaults. */
export async function getOwnSettings({user}) {
  const {restaurantId} = await userRestaurantContext(user);
  const restaurant = await Restaurant.findById(restaurantId).select('settings').lean();
  const stored = restaurant?.settings || {};

  const defaults = defaultSettings();
  const effective = {};
  for (const category of SETTINGS_CATEGORIES) {
    effective[category] = {...defaults[category]};
    // Only keys the catalogue knows about are surfaced. `settings` is Mixed and
    // may contain legacy keys from before P2D; those are preserved in storage
    // (the migration must not destroy them) but not presented as settings.
    for (const key of Object.keys(SETTINGS_CATALOG[category])) {
      if (stored?.[category]?.[key] !== undefined) {
        effective[category][key] = stored[category][key];
      }
    }
  }
  return {settings: effective, defaults, categories: SETTINGS_CATEGORIES};
}

/**
 * Update operational settings.
 *
 * MERGED, not replaced. `settings` is a Mixed field that predates P2D and may
 * hold keys this catalogue does not know about; replacing the object wholesale
 * would silently delete them. Only the validated keys are written.
 */
export async function updateSettings({user, patch, reason}) {
  const {restaurantId, userId} = await userRestaurantContext(user);
  const validated = validateSettingsPatch(patch);
  if (!Object.keys(validated).length) throw httpError('No settings were supplied', 400);

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) throw httpError('Restaurant not found', 404);

  const current = restaurant.settings && typeof restaurant.settings === 'object'
    ? restaurant.settings
    : {};
  const before = {};
  const after = {};

  for (const [category, fields] of Object.entries(validated)) {
    const existing = current[category] && typeof current[category] === 'object'
      ? current[category]
      : {};
    const merged = {...existing};
    for (const [key, value] of Object.entries(fields)) {
      if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(value ?? null)) {
        before[`${category}.${key}`] = existing[key] ?? null;
        after[`${category}.${key}`] = value ?? null;
      }
      merged[key] = value;
    }
    current[category] = merged;
  }

  restaurant.settings = current;
  restaurant.markModified('settings');
  await restaurant.save();

  await Audit.create({
    entity: 'restaurant', entityId: restaurant._id, restaurant: restaurant._id,
    action: 'restaurant_settings_updated',
    before, after,
    reason: clean(reason) || undefined,
    user: userId
  });

  return getOwnSettings({user});
}

// ── platform surface ─────────────────────────────────────────────────────────

/** Any tenant's branding, for a platform operator. Read requires `view`. */
export async function getBrandingForPlatform({user, restaurantId}) {
  await assertPlatform(user, 'platform.restaurants.view');
  if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);

  const restaurant = await Restaurant.findById(restaurantId)
    .select('name legalName branding customDomain customDomainVerified customDomainVerifiedAt')
    .lean();
  if (!restaurant) throw httpError('Restaurant not found', 404);

  return {
    restaurant: {_id: restaurant._id, name: restaurant.name, legalName: restaurant.legalName || null},
    branding: restaurant.branding || {},
    resolved: await getRestaurantBranding(restaurantId, {fresh: true}),
    tiers: await brandingTiers(restaurantId),
    customDomain: {
      domain: restaurant.customDomain || null,
      verified: Boolean(restaurant.customDomainVerified),
      verifiedAt: restaurant.customDomainVerifiedAt || null,
      serving: false
    }
  };
}

// ── custom domain (P2D-M) ────────────────────────────────────────────────────

/**
 * Claim a custom domain.
 *
 * WHAT THIS DOES: normalises the hostname, refuses a duplicate, generates an
 * ownership token, stores the claim UNVERIFIED, and audits it.
 *
 * WHAT THIS DOES NOT DO: provision DNS, obtain a certificate, or route any
 * traffic. The deployment terminates TLS outside this stack and has no ACME
 * automation, so a `customDomain` value is a recorded intention, not a served
 * hostname. `serving: false` is returned everywhere so no screen can imply
 * otherwise. Documented in SAAS-ARCHITECTURE.md.
 *
 * Nothing in the request path trusts the `Host` header. Adding hostname-based
 * tenant resolution without that caveat would be the actual vulnerability
 * here: behind a reverse proxy, `Host` is caller-controlled unless the proxy
 * is configured to normalise it.
 */
export async function setCustomDomain({user, domain, reason, restaurantId = null, viaPlatform = false}) {
  let targetId;
  let actor;
  if (viaPlatform) {
    actor = await assertPlatform(user, 'platform.restaurants.update');
    if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);
    targetId = restaurantId;
  } else {
    const identity = await userRestaurantContext(user);
    targetId = identity.restaurantId;
    actor = {_id: identity.userId, name: user?.name || null};

    const tiers = await brandingTiers(targetId);
    if (!tiers.customDomain) {
      throw Object.assign(
        httpError(`A custom domain is not included in the ${tiers.planCode || 'current'} plan.`, 402),
        {billing: true, reason: 'feature_not_in_plan', feature: 'customDomain'}
      );
    }
  }

  const restaurant = await Restaurant.findById(targetId).select('+customDomainToken');
  if (!restaurant) throw httpError('Restaurant not found', 404);

  const previous = restaurant.customDomain || null;

  if (domain === null || clean(domain) === '') {
    restaurant.customDomain = null;
    restaurant.customDomainVerified = false;
    restaurant.customDomainToken = null;
    restaurant.customDomainVerifiedAt = null;
  } else {
    const normalized = normalizeDomain(domain);
    // Checked before the unique index so the message is useful; the index is
    // still the real guarantee against a concurrent claim.
    const clash = await Restaurant.findOne({customDomain: normalized, _id: {$ne: restaurant._id}})
      .select('_id').lean();
    if (clash) throw httpError('That domain is already claimed by another restaurant', 409);

    restaurant.customDomain = normalized;
    // Changing the domain always resets verification: proving ownership of
    // one hostname says nothing about another.
    restaurant.customDomainVerified = false;
    restaurant.customDomainVerifiedAt = null;
    restaurant.customDomainToken = `mittho-verify-${crypto.randomBytes(16).toString('hex')}`;
  }

  try {
    await restaurant.save();
  } catch (error) {
    if (error?.code === 11000) throw httpError('That domain is already claimed by another restaurant', 409);
    throw error;
  }

  await Audit.create({
    entity: 'restaurant', entityId: restaurant._id, restaurant: restaurant._id,
    action: viaPlatform ? 'platform_custom_domain_changed' : 'custom_domain_changed',
    before: {customDomain: previous},
    after: {customDomain: restaurant.customDomain, verified: false},
    reason: clean(reason) || undefined,
    user: actor._id, userName: actor.name || undefined,
    userRole: viaPlatform ? `platform:${actor.platformRole}` : undefined
  });

  invalidateBranding(targetId);

  return {
    domain: restaurant.customDomain,
    verified: false,
    // The token the tenant publishes as a DNS TXT record. Returned to the
    // claimant only.
    verificationToken: restaurant.customDomainToken,
    serving: false,
    note: 'DNS and TLS provisioning are not automated. The platform must route this hostname manually.'
  };
}

/**
 * Mark a domain verified. PLATFORM ONLY, and deliberately manual.
 *
 * Automated DNS verification would need outbound DNS from the API container,
 * which is not something to add speculatively. Until then an operator confirms
 * the TXT record out of band and records it here, which is honest about who
 * actually checked.
 */
export async function verifyCustomDomain({user, restaurantId, reason}) {
  const actor = await assertPlatform(user, 'platform.restaurants.update');
  if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);

  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) throw httpError('Restaurant not found', 404);
  if (!restaurant.customDomain) throw httpError('This restaurant has no custom domain claim', 409);

  restaurant.customDomainVerified = true;
  restaurant.customDomainVerifiedAt = new Date();
  await restaurant.save();

  await Audit.create({
    entity: 'restaurant', entityId: restaurant._id, restaurant: restaurant._id,
    action: 'platform_custom_domain_verified',
    after: {customDomain: restaurant.customDomain, verified: true},
    reason: clean(reason) || undefined,
    user: actor._id, userName: actor.name, userRole: `platform:${actor.platformRole}`
  });

  invalidateBranding(restaurantId);
  return {domain: restaurant.customDomain, verified: true, serving: false};
}
