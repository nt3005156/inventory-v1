import {Router} from 'express';
import {z} from 'zod';
import {authenticated, requirePermission} from '../middleware/auth.js';
import {Audit} from '../models/index.js';
import {
  assignUserRole, createRole, deleteRole, describeSelf, listRoles, updateRole
} from '../services/roles.js';
import {PERMISSION_CATALOG, ROLE_TEMPLATES} from '../services/permissions.js';
import {userRestaurantContext} from '../services/supplierCatalog.js';

/**
 * Phase 20 — role and permission administration.
 *
 * Guarded by PERMISSION, not by role list: `roles.manage` and `users.manage`.
 * That is the point of the phase — an owner can now delegate user
 * administration to a custom role without also handing over the P&L.
 */

const r = Router();

function fail(res, error) {
  const status = error?.status || (error?.name === 'ZodError' ? 400 : 500);
  let message = error?.message || 'Server error';
  if (error?.name === 'ZodError') {
    const issue = Array.isArray(error.issues) ? error.issues[0] : null;
    const field = issue?.path?.length ? issue.path.join('.') : null;
    message = field ? `Invalid ${field}` : 'Some details are missing or invalid';
  } else if (status >= 500) {
    message = 'Server error';
  }
  return res.status(status).json({message: String(message).slice(0, 300)});
}

const parse = (schema, body) => schema.parse(body ?? {});

const roleCreateSchema = z.object({
  key: z.string().trim().max(40).optional(),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  baseRole: z.enum(['manager', 'staff', 'rider']).optional(),
  permissions: z.array(z.string().trim().max(60)).max(200).optional()
}).strict();

const roleUpdateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(300).optional(),
  baseRole: z.string().trim().max(20).optional(),
  permissions: z.array(z.string().trim().max(60)).max(200).optional(),
  active: z.boolean().optional()
}).strict();

const assignSchema = z.object({
  role: z.string().trim().max(40).optional(),
  branch: z.string().trim().max(40).nullable().optional()
}).strict();

/**
 * What the CALLER may do.
 *
 * Every authenticated principal may read their own permissions — it carries no
 * information they do not already possess by trying an endpoint, and the
 * client needs it to render a sensible menu. Hiding navigation is a courtesy;
 * the backend guards remain authoritative.
 */
r.get('/me/permissions', authenticated(), async (req, res) => {
  try {
    res.json(describeSelf(req.principal));
  } catch (e) { fail(res, e); }
});

/** The catalogue itself, for building a permission picker. */
r.get('/permissions', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.json({permissions: PERMISSION_CATALOG, templates: ROLE_TEMPLATES});
  } catch (e) { fail(res, e); }
});

r.get('/roles', requirePermission('roles.manage', 'users.manage'), async (req, res) => {
  try {
    res.json(await listRoles({
      user: req.user, includeInactive: req.query.includeInactive === 'true'
    }));
  } catch (e) { fail(res, e); }
});

r.post('/roles', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.status(201).json(await createRole({
      user: req.user, principal: req.principal, input: parse(roleCreateSchema, req.body)
    }));
  } catch (e) { fail(res, e); }
});

r.patch('/roles/:key', requirePermission('roles.manage'), async (req, res) => {
  try {
    res.json(await updateRole({
      user: req.user, principal: req.principal,
      key: req.params.key, input: parse(roleUpdateSchema, req.body)
    }));
  } catch (e) { fail(res, e); }
});

r.delete('/roles/:key', requirePermission('roles.manage'), async (req, res) => {
  try {
    // `reassignTo` opts into moving every holder in the same operation. Without
    // it a role still in use is refused, so nobody is ever left pointing at a
    // role that no longer resolves.
    res.json(await deleteRole({
      user: req.user, key: req.params.key,
      reassignTo: req.query.reassignTo || req.body?.reassignTo || null
    }));
  } catch (e) { fail(res, e); }
});

/** Assign a role and/or move a user to another branch. */
r.patch('/users/:id/role', requirePermission('users.manage'), async (req, res) => {
  try {
    const body = parse(assignSchema, req.body);
    res.json(await assignUserRole({
      user: req.user, principal: req.principal, targetId: req.params.id,
      roleKey: body.role, branchId: body.branch
    }));
  } catch (e) { fail(res, e); }
});

/**
 * The access-control audit trail: who changed which role or account, when.
 * Scoped to the caller's own restaurant.
 */
r.get('/rbac/audit', requirePermission('users.manage', 'roles.manage'), async (req, res) => {
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await Audit.find({
      entity: {$in: ['role', 'user']},
      action: {
        $in: [
          'role_created', 'role_updated', 'role_deleted', 'user_role_assigned',
          'account_created', 'account_deactivated', 'account_reactivated',
          'account_password_reset'
        ]
      },
      // Older account rows predate the restaurant stamp; match those by the
      // users that belong to this tenant rather than dropping them silently.
      $or: [{restaurant: restaurantId}, {restaurant: {$exists: false}}, {restaurant: null}]
    })
      .sort({at: -1})
      .limit(limit)
      .populate('user', 'name email role')
      .lean();
    res.json({events: rows, limit});
  } catch (e) { fail(res, e); }
});

export default r;
