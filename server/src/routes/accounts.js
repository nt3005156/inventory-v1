/**
 * Staff and rider account management (Phase 12).
 *
 * Owner-only. This is the administrative surface for provisioning the people
 * who use the system; the tenant always comes from the caller's token, never
 * from the request body.
 */
import {Router} from 'express';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {RIDER_VEHICLES} from '../models/index.js';
import {
  CREATABLE_ROLES,
  createStaffAccount,
  listStaffAccounts,
  resetAccountPassword,
  setAccountActive
} from '../services/staffAccounts.js';

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

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  password: z.string().min(1).max(200),
  role: z.enum(CREATABLE_ROLES),
  branch: z.string().optional(),
  phone: z.string().trim().max(30).optional(),
  vehicle: z.enum(RIDER_VEHICLES).optional(),
  licencePlate: z.string().trim().max(20).optional(),
  maxConcurrent: z.number().int().min(1).max(20).optional(),
  notes: z.string().trim().max(500).optional()
}).strict();

/** Managers may read the roster; only owners may change it. */
r.get('/accounts', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await listStaffAccounts({
      user: req.user,
      role: req.query.role,
      branchId: req.query.branch,
      includeInactive: req.query.includeInactive === 'true'
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/accounts', auth(['owner']), async (req, res) => {
  try {
    const body = createSchema.parse(req.body || {});
    res.status(201).json(await createStaffAccount({user: req.user, input: body}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/accounts/:id/password', auth(['owner']), async (req, res) => {
  try {
    const body = z.object({password: z.string().min(1).max(200)}).strict().parse(req.body || {});
    res.json(await resetAccountPassword({
      user: req.user, targetId: req.params.id, password: body.password
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/accounts/:id/active', auth(['owner']), async (req, res) => {
  try {
    const body = z.object({
      active: z.boolean(),
      reason: z.string().trim().max(300).optional()
    }).strict().parse(req.body || {});
    res.json(await setAccountActive({
      user: req.user, targetId: req.params.id, active: body.active, reason: body.reason
    }));
  } catch (e) {
    fail(res, e);
  }
});

export default r;
