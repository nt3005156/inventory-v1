import {Router} from 'express';
import {z} from 'zod';
import {fail as safeFail} from '../services/httpErrors.js';
import {authenticated, requirePermission} from '../middleware/auth.js';
import {
  createRestaurant, getOwnRestaurant, getRestaurantForPlatform, listRestaurants,
  setRestaurantStatus, updateRestaurant
} from '../services/tenantAdmin.js';

/**
 * P2A — restaurant administration.
 *
 * TWO SURFACES, deliberately on different paths:
 *
 *   /api/platform/restaurants   platform operators. Authority comes from
 *                               `User.platformRole`, checked in the service.
 *                               No tenant permission grants access here.
 *
 *   /api/my/restaurant          a restaurant reading/editing ITSELF. No id
 *                               parameter exists, so it cannot be aimed at
 *                               another tenant.
 *
 * Separate paths rather than one endpoint with a mode flag: a flag is one
 * refactor away from being widened by accident, and the audit trail should be
 * able to distinguish "the platform changed this tenant" from "the tenant
 * changed itself".
 *
 * The platform routes use `authenticated()` only — the platform permission is
 * enforced in the service layer, which is also where it is unit-testable.
 * Using `requirePermission()` here would be wrong: those are TENANT
 * permissions, and an owner holds all of them.
 */

const r = Router();
const fail = safeFail;

const profileSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  slug: z.string().trim().max(60).optional(),
  legalName: z.string().trim().max(200).optional(),
  timezone: z.string().trim().max(60).optional(),
  currency: z.string().trim().max(8).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  pan: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
  receiptFooter: z.string().trim().max(300).optional()
}).strict();

// ── platform surface ─────────────────────────────────────────────────────────

r.get('/platform/restaurants', authenticated(), async (req, res) => {
  try {
    res.json(await listRestaurants({
      user: req.user, status: req.query.status, q: req.query.q,
      page: req.query.page, limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

r.get('/platform/restaurants/:id', authenticated(), async (req, res) => {
  try {
    res.json(await getRestaurantForPlatform({user: req.user, restaurantId: req.params.id}));
  } catch (e) { fail(res, e); }
});

r.post('/platform/restaurants', authenticated(), async (req, res) => {
  try {
    const body = profileSchema.extend({
      name: z.string().trim().min(2).max(160),
      status: z.enum(['trial', 'active', 'suspended', 'cancelled']).optional()
    }).parse(req.body ?? {});
    res.status(201).json(await createRestaurant({user: req.user, input: body}));
  } catch (e) { fail(res, e); }
});

r.patch('/platform/restaurants/:id', authenticated(), async (req, res) => {
  try {
    const body = profileSchema.parse(req.body ?? {});
    res.json(await updateRestaurant({
      user: req.user, restaurantId: req.params.id, input: body, viaPlatform: true
    }));
  } catch (e) { fail(res, e); }
});

/**
 * Lifecycle. A separate endpoint from the profile update on purpose: changing
 * whether a business can trade is not the same kind of act as correcting its
 * phone number, and the two carry different permissions and audit actions.
 */
const lifecycleSchema = z.object({
  action: z.enum(['activate', 'trial', 'suspend', 'cancel']),
  reason: z.string().trim().max(300).optional()
}).strict();

r.post('/platform/restaurants/:id/status', authenticated(), async (req, res) => {
  try {
    const body = lifecycleSchema.parse(req.body ?? {});
    res.json(await setRestaurantStatus({
      user: req.user, restaurantId: req.params.id, action: body.action, reason: body.reason
    }));
  } catch (e) { fail(res, e); }
});

// ── tenant surface ───────────────────────────────────────────────────────────

/**
 * The caller's own restaurant. `branches.view` is the existing permission for
 * "may see the shape of my own organisation"; staff hold it, which is correct
 * — a cashier's receipt shows the restaurant name.
 */
r.get('/my/restaurant', requirePermission('branches.view'), async (req, res) => {
  try {
    res.json(await getOwnRestaurant({user: req.user}));
  } catch (e) { fail(res, e); }
});

/**
 * Edit my own restaurant's profile. `settings.manage` is the permission that
 * already governs restaurant settings, and is owner-only in the built-in
 * bundles — a manager cannot rename the business.
 */
r.patch('/my/restaurant', requirePermission('settings.manage'), async (req, res) => {
  try {
    const body = profileSchema.parse(req.body ?? {});
    res.json(await updateRestaurant({user: req.user, input: body, viaPlatform: false}));
  } catch (e) { fail(res, e); }
});

export default r;
