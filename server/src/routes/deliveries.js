/**
 * Delivery and rider API (Phase 10).
 *
 * Route ordering matters: every `/deliveries/mine...` rider route is declared
 * before `/deliveries/:id`, or "mine" would be captured as an id.
 *
 * RBAC:
 *   rider            — only their own queue and their own shift state
 *   staff / manager  — dispatch, assign, advance, dashboard
 *   manager / owner  — rider profiles and employment state
 */
import {Router} from 'express';
import {z} from 'zod';
import {auth, requirePermission} from '../middleware/auth.js';
import {RIDER_VEHICLES} from '../models/index.js';
import {
  assignRider,
  createDelivery,
  deliveryDashboard,
  getDeliveryForRider,
  listDeliveries,
  listRiderDeliveries,
  listRiders,
  PROOF_TYPES,
  riderDashboard,
  riderHistory,
  setOwnAvailability,
  updateDeliveryStatus,
  updateRiderProfile
} from '../services/deliveries.js';

const r = Router();

const STAFF = ['owner', 'manager', 'staff'];
const SUPERVISOR = ['owner', 'manager'];

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

const DELIVERY_STATUSES = [
  'pending', 'assigned', 'picked_up', 'out_for_delivery', 'delivered', 'failed', 'cancelled'
];

// ── Rider self-service ───────────────────────────────────────────────────────
// Declared first so 'mine' is never swallowed by the ':id' routes below.

/** Rider home screen. Everything is derived from the token's own identity. */
/**
 * The rider's own workspace.
 *
 * Guarded by `deliveries.ride` so a custom rider-based role works. An OWNER
 * also passes, because an owner implicitly holds every permission — that is
 * harmless here: every one of these handlers resolves deliveries by
 * `user.id`, so an owner sees their own (empty) list rather than anybody
 * else's. The tenancy boundary is in the handler, not the guard.
 */
r.get('/deliveries/mine/dashboard', requirePermission('deliveries.ride'), async (req, res) => {
  try {
    res.json(await riderDashboard({user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/deliveries/mine', requirePermission('deliveries.ride'), async (req, res) => {
  try {
    res.json(await listRiderDeliveries({
      user: req.user, includeCompleted: req.query.includeCompleted === 'true'
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/deliveries/mine/availability', requirePermission('deliveries.ride'), async (req, res) => {
  try {
    const body = z.object({available: z.boolean()}).strict().parse(req.body || {});
    const rider = await setOwnAvailability({user: req.user, available: body.available});
    res.json({available: Boolean(rider.rider?.available), active: rider.rider?.active !== false});
  } catch (e) {
    fail(res, e);
  }
});

r.get('/deliveries/mine/:id', requirePermission('deliveries.ride'), async (req, res) => {
  try {
    res.json(await getDeliveryForRider({user: req.user, deliveryId: req.params.id}));
  } catch (e) {
    fail(res, e);
  }
});

// ── Riders ───────────────────────────────────────────────────────────────────

r.get('/riders', requirePermission('deliveries.dispatch'), async (req, res) => {
  try {
    res.json(await listRiders({
      user: req.user,
      branchId: req.query.branch,
      availableOnly: req.query.available === 'true',
      includeInactive: req.query.includeInactive === 'true'
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/riders/:id/history', requirePermission('riders.manage'), async (req, res) => {
  try {
    res.json(await riderHistory({user: req.user, riderId: req.params.id, limit: req.query.limit}));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/riders/:id', requirePermission('riders.manage'), async (req, res) => {
  try {
    const body = z.object({
      phone: z.string().trim().max(30).optional(),
      vehicle: z.enum(RIDER_VEHICLES).optional(),
      licencePlate: z.string().trim().max(20).optional(),
      maxConcurrent: z.number().int().min(1).max(20).optional(),
      notes: z.string().trim().max(500).optional(),
      branch: z.string().nullable().optional(),
      active: z.boolean().optional(),
      available: z.boolean().optional()
    }).strict().parse(req.body || {});
    res.json(await updateRiderProfile({user: req.user, riderId: req.params.id, input: body}));
  } catch (e) {
    fail(res, e);
  }
});

// ── Dispatch dashboard ───────────────────────────────────────────────────────

r.get('/deliveries/dashboard', requirePermission('deliveries.dispatch'), async (req, res) => {
  try {
    res.json(await deliveryDashboard({user: req.user, branchId: req.query.branch}));
  } catch (e) {
    fail(res, e);
  }
});

// ── Deliveries ───────────────────────────────────────────────────────────────

r.get('/deliveries', requirePermission('deliveries.dispatch'), async (req, res) => {
  try {
    res.json(await listDeliveries({
      user: req.user,
      branchId: req.query.branch,
      status: req.query.status,
      riderId: req.query.rider,
      limit: req.query.limit
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/deliveries', requirePermission('deliveries.dispatch'), async (req, res) => {
  try {
    const body = z.object({
      order: z.string(),
      rider: z.string().optional(),
      address: z.string().trim().max(500).optional(),
      phone: z.string().trim().max(30).optional(),
      instructions: z.string().trim().max(300).optional(),
      estimatedMinutes: z.number().min(0).max(600).optional()
    }).strict().parse(req.body || {});
    res.status(201).json(await createDelivery({user: req.user, input: body}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/deliveries/:id/assign', requirePermission('deliveries.dispatch'), async (req, res) => {
  try {
    const body = z.object({
      rider: z.string(),
      reason: z.string().trim().max(300).optional()
    }).strict().parse(req.body || {});
    res.json(await assignRider({
      user: req.user, deliveryId: req.params.id, riderId: body.rider, reason: body.reason
    }));
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Advance a delivery. Riders and staff share this route because they share the
 * same state machine; the service decides what each principal may set.
 */
r.patch('/deliveries/:id/status', requirePermission('deliveries.dispatch', 'deliveries.ride'), async (req, res) => {
  try {
    const body = z.object({
      status: z.enum(DELIVERY_STATUSES),
      reason: z.string().trim().max(300).optional(),
      // Proof of delivery. Required on 'delivered'; the service enforces it,
      // because the frontend is not an authorisation boundary.
      proofNote: z.string().trim().max(300).optional(),
      proofType: z.enum(PROOF_TYPES).optional(),
      receivedBy: z.string().trim().max(120).optional()
    }).strict().parse(req.body || {});
    res.json(await updateDeliveryStatus({
      user: req.user,
      deliveryId: req.params.id,
      status: body.status,
      reason: body.reason,
      proofNote: body.proofNote,
      proofType: body.proofType,
      receivedBy: body.receivedBy
    }));
  } catch (e) {
    fail(res, e);
  }
});

export default r;
