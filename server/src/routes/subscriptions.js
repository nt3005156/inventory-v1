/**
 * P2C — billing and subscription routes.
 *
 * TWO SURFACES, on different paths, with different authority — the P2A/P2B
 * pattern, restated because commercial data makes the distinction sharper:
 *
 *   /api/platform/plans, /api/platform/subscriptions*
 *       Platform operators. Guarded by `requirePlatformPermission()`, the one
 *       centralized platform guard. Never `requirePermission()`: those are
 *       TENANT permissions and an owner holds all 72 of them, so guarding a
 *       plan-assignment endpoint with one would let every restaurant owner on
 *       the platform move themselves to Enterprise.
 *
 *   /api/my/subscription, /api/my/entitlements
 *       A tenant reading ITSELF. No id parameter exists, so it cannot be
 *       aimed at another restaurant. READ ONLY — there is deliberately no
 *       tenant-side write anywhere in this file, because self-service billing
 *       is a commercial design that does not exist yet.
 *
 * Every service called below re-asserts its own authority. Two checks for one
 * decision, for the reason P2B's mutation run demonstrated.
 */
import {Router} from 'express';
import {z} from 'zod';
import {fail as safeFail} from '../services/httpErrors.js';
import {requirePermission, requirePlatformPermission} from '../middleware/auth.js';
import {FEATURE_KEYS, LIMIT_KEYS, SUBSCRIPTION_STATUSES} from '../models/billing.js';
import {
  assignPlan, cancelSubscription, createPlan, extendTrial, getOwnSubscription, getPlan,
  getSubscription, getSubscriptionHistory, listPlans, listSubscriptions, markPastDue,
  reactivateSubscription, updatePlan
} from '../services/subscriptions.js';
import {getUsageSummary} from '../services/usage.js';
import {resolveEntitlement} from '../services/entitlements.js';
import {describeTenantFeatures} from '../services/featureGuard.js';
import {publicFeatureCatalogue} from '../services/featureCatalogue.js';
import {userRestaurantContext} from '../services/supplierCatalog.js';

const r = Router();
const fail = safeFail;

/**
 * Limits and features are validated as CLOSED key sets.
 *
 * `z.record` with an open key space would accept `maxBranchs: 1`, which
 * Mongoose would then strip — leaving a plan that silently enforces no branch
 * limit at all. A typo must be a 400, not a missing control.
 */
const limitsSchema = z.object(
  Object.fromEntries(LIMIT_KEYS.map(key => [
    key, z.number().int().nonnegative().nullable().optional()
  ]))
).strict().optional();

const featuresSchema = z.object(
  Object.fromEntries(FEATURE_KEYS.map(key => [key, z.boolean().optional()]))
).strict().optional();

// Money is only ever accepted as an integer count of minor units.
const minorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const planCreateSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().optional(),
  monthlyPriceMinor: minorSchema.optional(),
  annualPriceMinor: minorSchema.optional(),
  currency: z.string().trim().max(8).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  limits: limitsSchema,
  features: featuresSchema
}).strict();

const planUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().optional(),
  monthlyPriceMinor: minorSchema.optional(),
  annualPriceMinor: minorSchema.optional(),
  currency: z.string().trim().max(8).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  limits: limitsSchema,
  features: featuresSchema
}).strict();

// ── platform: plan catalogue ─────────────────────────────────────────────────

r.get('/platform/plans',
  requirePlatformPermission('platform.billing.view'),
  async (req, res) => {
    try {
      res.json(await listPlans({
        user: req.user, includeInactive: req.query.includeInactive === 'true'
      }));
    } catch (e) { fail(res, e); }
  });

r.post('/platform/plans',
  requirePlatformPermission('platform.billing.manage'),
  async (req, res) => {
    try {
      res.status(201).json(await createPlan({user: req.user, input: planCreateSchema.parse(req.body ?? {})}));
    } catch (e) { fail(res, e); }
  });

r.get('/platform/plans/:id',
  requirePlatformPermission('platform.billing.view'),
  async (req, res) => {
    try {
      res.json(await getPlan({user: req.user, planId: req.params.id}));
    } catch (e) { fail(res, e); }
  });

r.patch('/platform/plans/:id',
  requirePlatformPermission('platform.billing.manage'),
  async (req, res) => {
    try {
      res.json(await updatePlan({
        user: req.user, planId: req.params.id, input: planUpdateSchema.parse(req.body ?? {})
      }));
    } catch (e) { fail(res, e); }
  });

// ── platform: subscriptions ──────────────────────────────────────────────────

r.get('/platform/subscriptions',
  requirePlatformPermission('platform.billing.view'),
  async (req, res) => {
    try {
      res.json(await listSubscriptions({
        user: req.user, status: req.query.status, planCode: req.query.plan,
        page: req.query.page, limit: req.query.limit
      }));
    } catch (e) { fail(res, e); }
  });

r.get('/platform/restaurants/:id/subscription',
  requirePlatformPermission('platform.billing.view'),
  async (req, res) => {
    try {
      res.json(await getSubscription({user: req.user, restaurantId: req.params.id}));
    } catch (e) { fail(res, e); }
  });

r.get('/platform/restaurants/:id/subscription/history',
  requirePlatformPermission('platform.billing.view'),
  async (req, res) => {
    try {
      res.json(await getSubscriptionHistory({
        user: req.user, restaurantId: req.params.id,
        page: req.query.page, limit: req.query.limit
      }));
    } catch (e) { fail(res, e); }
  });

/** Usage against limits, for one tenant, from the platform side. */
r.get('/platform/restaurants/:id/usage',
  requirePlatformPermission('platform.billing.view'),
  async (req, res) => {
    try {
      // Authority is asserted by the service; this endpoint only composes two
      // already-guarded reads.
      const {entitlement} = await getSubscription({user: req.user, restaurantId: req.params.id});
      const usage = await getUsageSummary(req.params.id);
      res.json({usage, limits: entitlement.limits, features: entitlement.features});
    } catch (e) { fail(res, e); }
  });

const assignSchema = z.object({
  plan: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(3).max(300),
  startTrial: z.boolean().optional()
}).strict();

r.post('/platform/restaurants/:id/subscription',
  requirePlatformPermission('platform.billing.manage'),
  async (req, res) => {
    try {
      const body = assignSchema.parse(req.body ?? {});
      res.json(await assignPlan({
        user: req.user, restaurantId: req.params.id, plan: body.plan,
        reason: body.reason, startTrial: body.startTrial === true
      }));
    } catch (e) { fail(res, e); }
  });

const trialSchema = z.object({
  days: z.number().int().min(1).max(365),
  reason: z.string().trim().min(3).max(300)
}).strict();

r.post('/platform/restaurants/:id/subscription/trial',
  requirePlatformPermission('platform.billing.manage'),
  async (req, res) => {
    try {
      const body = trialSchema.parse(req.body ?? {});
      res.json(await extendTrial({
        user: req.user, restaurantId: req.params.id, days: body.days, reason: body.reason
      }));
    } catch (e) { fail(res, e); }
  });

const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  atPeriodEnd: z.boolean().optional()
}).strict();

r.post('/platform/restaurants/:id/subscription/cancel',
  requirePlatformPermission('platform.billing.manage'),
  async (req, res) => {
    try {
      const body = cancelSchema.parse(req.body ?? {});
      res.json(await cancelSubscription({
        user: req.user, restaurantId: req.params.id, reason: body.reason,
        atPeriodEnd: body.atPeriodEnd !== false
      }));
    } catch (e) { fail(res, e); }
  });

const reasonSchema = z.object({reason: z.string().trim().min(3).max(300)}).strict();

r.post('/platform/restaurants/:id/subscription/reactivate',
  requirePlatformPermission('platform.billing.manage'),
  async (req, res) => {
    try {
      const body = reasonSchema.parse(req.body ?? {});
      res.json(await reactivateSubscription({
        user: req.user, restaurantId: req.params.id, reason: body.reason
      }));
    } catch (e) { fail(res, e); }
  });

/**
 * Mark past due. An EXPLICIT operator action only — nothing in P2C infers a
 * failed payment, because no gateway exists to report one.
 */
r.post('/platform/restaurants/:id/subscription/past-due',
  requirePlatformPermission('platform.billing.manage'),
  async (req, res) => {
    try {
      const body = reasonSchema.parse(req.body ?? {});
      res.json(await markPastDue({
        user: req.user, restaurantId: req.params.id, reason: body.reason
      }));
    } catch (e) { fail(res, e); }
  });

/** Reference data for the platform plan editor. */
r.get('/platform/billing/meta',
  requirePlatformPermission('platform.billing.view'),
  async (req, res) => {
    res.json({
      limitKeys: [...LIMIT_KEYS],
      featureKeys: [...FEATURE_KEYS],
      statuses: [...SUBSCRIPTION_STATUSES]
    });
  });

// ── tenant: read-only ────────────────────────────────────────────────────────

/**
 * The caller's OWN subscription.
 *
 * `branches.view` is the existing "may see the shape of my own organisation"
 * permission — the same one `/api/my/restaurant` uses. Deliberately not
 * `settings.manage`: seeing which plan you are on is not an administrative act,
 * and a manager needs it to understand why a limit refused them.
 */
r.get('/my/subscription', requirePermission('branches.view'), async (req, res) => {
  try {
    res.json(await getOwnSubscription({user: req.user}));
  } catch (e) { fail(res, e); }
});

/**
 * Entitlements plus current usage, for the tenant's own screens.
 *
 * The tenant is taken from the authenticated principal via
 * `userRestaurantContext()`. A `restaurant` field in the query or body is
 * ignored entirely.
 */
r.get('/my/entitlements', requirePermission('branches.view'), async (req, res) => {
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    const entitlement = await resolveEntitlement(restaurantId, {fresh: true});
    const usage = await getUsageSummary(restaurantId);
    res.json({
      planCode: entitlement.planCode,
      planName: entitlement.planName,
      status: entitlement.status,
      operational: entitlement.operational,
      readOnly: entitlement.readOnly,
      reason: entitlement.reason,
      trialEnd: entitlement.trialEnd || null,
      currentPeriodEnd: entitlement.currentPeriodEnd || null,
      features: entitlement.features,
      limits: entitlement.limits,
      usage
    });
  } catch (e) { fail(res, e); }
});

/**
 * P2E — which catalogued features this tenant may actually use.
 *
 * Distinguishes "not in your plan" from "your subscription lapsed", because
 * those need different remedies and a UI that conflates them sends the owner
 * to the wrong place. Presentation only: every one of these features is
 * re-checked server-side at its own enforcement point.
 */
r.get('/my/features', requirePermission('branches.view'), async (req, res) => {
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    res.json({
      features: await describeTenantFeatures(restaurantId),
      catalogue: publicFeatureCatalogue()
    });
  } catch (e) { fail(res, e); }
});

export default r;
