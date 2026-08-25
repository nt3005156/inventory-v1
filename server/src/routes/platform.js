/**
 * P2B — the platform administration surface.
 *
 * EVERY route here is guarded by `requirePlatformPermission()`, the one
 * centralized platform authorization mechanism. No route in this file uses
 * `requirePermission()`: those are TENANT permissions and a restaurant owner
 * holds all 72 of them, so guarding a platform endpoint with one would open
 * it to every owner on the platform. That is the single most important fact
 * about this file.
 *
 * The service layer re-asserts the same permission independently. Two checks
 * for one decision is deliberate: P2A's mutation run proved that authority
 * living only in a route is authority no unit test covers, and that removing
 * it left tests green.
 *
 * Mounted under `/api`, so the paths below are `/api/platform/...`.
 */
import {Router} from 'express';
import {z} from 'zod';
import {fail as safeFail} from '../services/httpErrors.js';
import {authenticated, requirePlatformPermission} from '../middleware/auth.js';
import {PLATFORM_ROLE_KEYS} from '../services/platformAccess.js';
import {
  describePlatformAccess, getPlatformUser, listPlatformAdmins, listPlatformUsers,
  platformDashboard, searchPlatformAudit, setPlatformRole, setPlatformUserActive
} from '../services/platformAdmin.js';

const r = Router();
const fail = safeFail;

// ── self ─────────────────────────────────────────────────────────────────────

/**
 * "Am I a platform operator, and what may I do?"
 *
 * Guarded by `authenticated()` only, because every principal must be able to
 * ask this about THEMSELVES — the client needs it to decide whether to render
 * platform navigation. For a restaurant user the honest answer is
 * `{platform: false, permissions: []}`, which discloses nothing: they already
 * know they are not a platform operator.
 */
r.get('/platform/me', authenticated(), async (req, res) => {
  try {
    res.json(await describePlatformAccess({user: req.user}));
  } catch (e) { fail(res, e); }
});

// ── dashboard ────────────────────────────────────────────────────────────────

r.get('/platform/dashboard',
  requirePlatformPermission('platform.dashboard.view'),
  async (req, res) => {
    try {
      res.json(await platformDashboard({user: req.user}));
    } catch (e) { fail(res, e); }
  });

// ── cross-tenant users ───────────────────────────────────────────────────────

r.get('/platform/users',
  requirePlatformPermission('platform.users.view'),
  async (req, res) => {
    try {
      res.json(await listPlatformUsers({
        user: req.user, q: req.query.q, restaurantId: req.query.restaurant,
        role: req.query.role, platformRole: req.query.platformRole,
        active: req.query.active, page: req.query.page, limit: req.query.limit
      }));
    } catch (e) { fail(res, e); }
  });

/**
 * The operator roster. Requires only `platform.users.view` to READ — support
 * needs to know who to escalate to — while changing it requires
 * `platform.admins.manage`, which only a super admin holds.
 */
r.get('/platform/admins',
  requirePlatformPermission('platform.users.view'),
  async (req, res) => {
    try {
      res.json(await listPlatformAdmins({user: req.user}));
    } catch (e) { fail(res, e); }
  });

r.get('/platform/users/:id',
  requirePlatformPermission('platform.users.view'),
  async (req, res) => {
    try {
      res.json(await getPlatformUser({user: req.user, targetId: req.params.id}));
    } catch (e) { fail(res, e); }
  });

const activeSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(3).max(300)
}).strict();

r.patch('/platform/users/:id/active',
  requirePlatformPermission('platform.users.manage'),
  async (req, res) => {
    try {
      const body = activeSchema.parse(req.body ?? {});
      res.json(await setPlatformUserActive({
        user: req.user, targetId: req.params.id, active: body.active, reason: body.reason
      }));
    } catch (e) { fail(res, e); }
  });

/**
 * Grant or revoke PLATFORM authority.
 *
 * `platformRole: null` revokes. Guarded by `platform.admins.manage`, which
 * `platform_admin` deliberately does not hold — an administrator who can
 * suspend any restaurant still cannot recruit another administrator.
 *
 * There is no route that CREATES an account with platform authority. The
 * first operator comes from `server/scripts/platform-admin.js`, which needs
 * shell access; after that, authority is granted to accounts that already
 * exist. A public bootstrap route would be a permanent hole.
 */
const platformRoleSchema = z.object({
  platformRole: z.enum([...PLATFORM_ROLE_KEYS]).nullable(),
  reason: z.string().trim().min(3).max(300)
}).strict();

r.patch('/platform/users/:id/platform-role',
  requirePlatformPermission('platform.admins.manage'),
  async (req, res) => {
    try {
      const body = platformRoleSchema.parse(req.body ?? {});
      res.json(await setPlatformRole({
        user: req.user, targetId: req.params.id,
        platformRole: body.platformRole, reason: body.reason
      }));
    } catch (e) { fail(res, e); }
  });

// ── platform audit ───────────────────────────────────────────────────────────

/**
 * Cross-tenant audit, restricted to platform actions by whitelist.
 *
 * Not a window onto tenants' operational history: a platform operator can see
 * what the PLATFORM did, not what a restaurant did internally.
 */
r.get('/platform/audit',
  requirePlatformPermission('platform.audit.view'),
  async (req, res) => {
    try {
      res.json(await searchPlatformAudit({
        user: req.user, action: req.query.action, restaurantId: req.query.restaurant,
        actorId: req.query.actor, from: req.query.from, to: req.query.to,
        page: req.query.page, limit: req.query.limit
      }));
    } catch (e) { fail(res, e); }
  });

export default r;
