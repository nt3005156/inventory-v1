/**
 * P2D — branding and tenant-settings routes.
 *
 * THREE SURFACES, on different paths, with different authority:
 *
 *   /api/my/restaurant/branding|settings   a tenant editing ITSELF. No id
 *       parameter exists, so it cannot be aimed at another restaurant.
 *   /api/platform/restaurants/:id/branding  platform operators. Guarded by
 *       `requirePlatformPermission()` — never `requirePermission()`, because
 *       those are TENANT permissions and an owner holds all 72.
 *   /api/public/branding                    unauthenticated storefront.
 *
 * Every service re-asserts its own authority. Two checks for one decision, for
 * the reason P2B's mutation run demonstrated.
 *
 * PERMISSIONS ON THE TENANT PATH
 *   read  `branches.view`   — the same permission `/api/my/restaurant` uses for
 *                             "may see the shape of my own organisation". Staff
 *                             hold it, and the POS shell needs the colours.
 *   write `settings.manage` — owner-only in the built-in bundles. A manager
 *                             cannot rebrand the business.
 */
import {Router} from 'express';
import {z} from 'zod';
import {fail as safeFail} from '../services/httpErrors.js';
import {requirePermission, requirePlatformPermission} from '../middleware/auth.js';
import {
  BRANDING_KEYS, FONT_KEYS, SETTINGS_CATALOG, brandingKeysForTier
} from '../services/brandingSchema.js';
import {
  getBrandingForPlatform, getOwnBranding, getOwnSettings, setCustomDomain,
  updateBranding, updateSettings, verifyCustomDomain
} from '../services/brandingAdmin.js';
import {
  getRestaurantBranding, publicBrandingView, staffBrandingView
} from '../services/branding.js';
import {resolvePublicBranch} from '../services/storefront.js';
import {userRestaurantContext} from '../services/supplierCatalog.js';

const r = Router();
const fail = safeFail;

/**
 * A CLOSED key set.
 *
 * `z.record()` would accept any key and let Mongoose silently strip it, so a
 * typo would look accepted and never apply — the P1 finding. Every branding
 * field is declared, and anything else is a 400. Values are only
 * shape-checked here; the real validation (colour format, URL scheme, font
 * allowlist) is in `brandingSchema.js` so it applies to every caller, not just
 * this route.
 */
const brandingPatchSchema = z.object(
  Object.fromEntries(BRANDING_KEYS.map(key => [
    key,
    z.union([z.string().max(600), z.boolean(), z.null()]).optional()
  ]))
).strict();

const settingsPatchSchema = z.object(
  Object.fromEntries(Object.entries(SETTINGS_CATALOG).map(([category, fields]) => [
    category,
    z.object(
      Object.fromEntries(Object.keys(fields).map(key => [
        key, z.union([z.string().max(300), z.boolean(), z.number(), z.null()]).optional()
      ]))
    ).strict().optional()
  ]))
).strict();

// ── tenant ───────────────────────────────────────────────────────────────────

r.get('/my/restaurant/branding', requirePermission('branches.view'), async (req, res) => {
  try {
    res.json(await getOwnBranding({user: req.user}));
  } catch (e) { fail(res, e); }
});

r.patch('/my/restaurant/branding', requirePermission('settings.manage'), async (req, res) => {
  try {
    const {reason, ...patch} = req.body ?? {};
    res.json(await updateBranding({
      user: req.user, patch: brandingPatchSchema.parse(patch), reason
    }));
  } catch (e) { fail(res, e); }
});

r.get('/my/restaurant/settings', requirePermission('branches.view'), async (req, res) => {
  try {
    res.json(await getOwnSettings({user: req.user}));
  } catch (e) { fail(res, e); }
});

r.patch('/my/restaurant/settings', requirePermission('settings.manage'), async (req, res) => {
  try {
    const {reason, ...patch} = req.body ?? {};
    res.json(await updateSettings({
      user: req.user, patch: settingsPatchSchema.parse(patch), reason
    }));
  } catch (e) { fail(res, e); }
});

const domainSchema = z.object({
  domain: z.string().trim().max(253).nullable(),
  reason: z.string().trim().max(300).optional()
}).strict();

r.patch('/my/restaurant/domain', requirePermission('settings.manage'), async (req, res) => {
  try {
    const body = domainSchema.parse(req.body ?? {});
    res.json(await setCustomDomain({user: req.user, domain: body.domain, reason: body.reason}));
  } catch (e) { fail(res, e); }
});

/**
 * The branding the STAFF workspace renders with.
 *
 * Separate from the editing endpoint because every authenticated user needs it
 * on load — including staff who may not edit — and it returns the resolved,
 * defaulted values rather than the raw stored ones.
 */
r.get('/my/branding', requirePermission('branches.view'), async (req, res) => {
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    res.json(staffBrandingView(await getRestaurantBranding(restaurantId)));
  } catch (e) { fail(res, e); }
});

/** Reference data for the branding editor: which fields sit in which tier. */
r.get('/my/restaurant/branding/meta', requirePermission('branches.view'), async (req, res) => {
  res.json({
    fields: BRANDING_KEYS,
    tiers: {
      core: brandingKeysForTier('core'),
      advanced: brandingKeysForTier('advanced'),
      white: brandingKeysForTier('white')
    },
    fonts: FONT_KEYS,
    settings: Object.fromEntries(
      Object.entries(SETTINGS_CATALOG).map(([category, fields]) => [category, Object.keys(fields)])
    )
  });
});

// ── platform ─────────────────────────────────────────────────────────────────

r.get('/platform/restaurants/:id/branding',
  requirePlatformPermission('platform.restaurants.view'),
  async (req, res) => {
    try {
      res.json(await getBrandingForPlatform({user: req.user, restaurantId: req.params.id}));
    } catch (e) { fail(res, e); }
  });

r.patch('/platform/restaurants/:id/branding',
  requirePlatformPermission('platform.restaurants.update'),
  async (req, res) => {
    try {
      const {reason, ...patch} = req.body ?? {};
      res.json(await updateBranding({
        user: req.user, patch: brandingPatchSchema.parse(patch),
        restaurantId: req.params.id, viaPlatform: true, reason
      }));
    } catch (e) { fail(res, e); }
  });

r.patch('/platform/restaurants/:id/domain',
  requirePlatformPermission('platform.restaurants.update'),
  async (req, res) => {
    try {
      const body = domainSchema.parse(req.body ?? {});
      res.json(await setCustomDomain({
        user: req.user, domain: body.domain, reason: body.reason,
        restaurantId: req.params.id, viaPlatform: true
      }));
    } catch (e) { fail(res, e); }
  });

r.post('/platform/restaurants/:id/domain/verify',
  requirePlatformPermission('platform.restaurants.update'),
  async (req, res) => {
    try {
      const body = z.object({reason: z.string().trim().max(300).optional()})
        .strict().parse(req.body ?? {});
      res.json(await verifyCustomDomain({
        user: req.user, restaurantId: req.params.id, reason: body.reason
      }));
    } catch (e) { fail(res, e); }
  });

// ── public ───────────────────────────────────────────────────────────────────

/**
 * Storefront branding for one BRANCH.
 *
 * Keyed by branch id, reusing `resolvePublicBranch()` — the existing public
 * tenant-resolution mechanism, which the storefront already uses for menus and
 * quotes. A restaurant id is deliberately NOT accepted: the browser knows a
 * branch, the server derives the tenant, and the two can never disagree.
 *
 * `resolvePublicBranch()` also refuses an inactive branch, so a deactivated
 * location cannot be used as a side channel to read a tenant's branding.
 *
 * The response is `publicBrandingView()` — no PAN, no legal name, no address,
 * no plan. A guest choosing a biryani has no business with the tax number.
 */
r.get('/public/branding', async (req, res) => {
  try {
    const branch = await resolvePublicBranch(req.query.branch);
    const branding = await getRestaurantBranding(branch.restaurant);
    res.json({
      branch: {id: branch._id, name: branch.name, code: branch.code || null},
      branding: publicBrandingView(branding)
    });
  } catch (e) { fail(res, e); }
});

export default r;
