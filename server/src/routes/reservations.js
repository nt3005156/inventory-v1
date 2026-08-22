import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth, requirePermission} from '../middleware/auth.js';
import {Reservation} from '../models/operations.js';
import {assertTenantBranchAccess} from '../services/kitchen.js';
import {publishTableEvent} from '../services/realtime.js';
import {
  RESERVATION_STATUSES,
  createReservation,
  findAvailableTables,
  holdTableForReservation,
  listReservations,
  setReservationStatus,
  updateReservation
} from '../services/reservations.js';

const r = Router();
const roles = ['owner', 'manager', 'staff'];
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD');
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must use HH:MM (24-hour)');

const createSchema = z.object({
  branch: z.string(),
  customer: z.string().optional(),
  guestName: z.string().trim().max(120).optional(),
  guestPhone: z.string().trim().max(30).optional(),
  guestEmail: z.string().trim().max(160).optional(),
  partySize: z.number().int().min(1).max(200),
  date: DATE,
  time: TIME,
  durationMinutes: z.number().int().min(15).max(600).optional(),
  table: z.string().nullable().optional(),
  notes: z.string().trim().max(500).optional()
}).strict();

const updateSchema = z.object({
  guestName: z.string().trim().max(120).optional(),
  guestPhone: z.string().trim().max(30).optional(),
  guestEmail: z.string().trim().max(160).optional(),
  partySize: z.number().int().min(1).max(200).optional(),
  date: DATE.optional(),
  time: TIME.optional(),
  durationMinutes: z.number().int().min(15).max(600).optional(),
  table: z.string().nullable().optional(),
  notes: z.string().trim().max(500).optional()
}).strict();

// Front-of-house needs to read and take bookings; staff are included.
r.get('/reservations', requirePermission('tables.view'), async (req, res) => {
  try {
    const branchId = req.query.branch;
    if (!branchId) throw Object.assign(new Error('Branch is required'), {status: 400});
    if (!mongoose.isValidObjectId(branchId)) throw Object.assign(new Error('Invalid branch'), {status: 400});
    res.json(await listReservations({
      branchId, user: req.user,
      date: req.query.date, from: req.query.from, to: req.query.to,
      status: req.query.status, tableId: req.query.table, limit: req.query.limit
    }));
  } catch (e) {
    fail(res, e);
  }
});

// Declared before /reservations/:id so the literal path is not read as an id.
r.get('/reservations/availability', requirePermission('tables.view'), async (req, res) => {
  try {
    const branchId = req.query.branch;
    if (!branchId) throw Object.assign(new Error('Branch is required'), {status: 400});
    if (!mongoose.isValidObjectId(branchId)) throw Object.assign(new Error('Invalid branch'), {status: 400});
    res.json(await findAvailableTables({
      branchId, user: req.user,
      date: req.query.date, time: req.query.time,
      durationMinutes: req.query.durationMinutes ? Number(req.query.durationMinutes) : undefined,
      partySize: Number(req.query.partySize)
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/reservations/:id', requirePermission('tables.view'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid reservation'), {status: 400});
    const reservation = await Reservation.findById(req.params.id)
      .populate('table', 'name area seats status')
      .populate('customer', 'name phone email');
    if (!reservation) throw Object.assign(new Error('Reservation not found'), {status: 404});
    await assertTenantBranchAccess(req.user, reservation.branch);
    res.json(reservation);
  } catch (e) {
    fail(res, e);
  }
});

r.post('/reservations', requirePermission('reservations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const input = createSchema.parse(req.body);
    let reservation;
    await session.withTransaction(async () => {
      reservation = await createReservation({input, user: req.user, session});
    });
    if (reservation.table) {
      publishTableEvent(reservation.branch, {reason: 'reservation', tableIds: [String(reservation.table)]});
    }
    res.status(201).json(reservation);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.patch('/reservations/:id', requirePermission('reservations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const patch = updateSchema.parse(req.body);
    let reservation;
    await session.withTransaction(async () => {
      reservation = await updateReservation({reservationId: req.params.id, patch, user: req.user, session});
    });
    if (reservation.table) {
      publishTableEvent(reservation.branch, {reason: 'reservation', tableIds: [String(reservation.table)]});
    }
    res.json(reservation);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.patch('/reservations/:id/status', requirePermission('reservations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = z.object({
      status: z.enum(RESERVATION_STATUSES),
      reason: z.string().trim().max(300).optional()
    }).strict().parse(req.body);
    let result;
    await session.withTransaction(async () => {
      result = await setReservationStatus({
        reservationId: req.params.id, status: body.status, reason: body.reason, user: req.user, session
      });
    });
    if (result.table) {
      publishTableEvent(result.reservation.branch, {reason: 'reservation', tableIds: [String(result.table._id)]});
    }
    res.json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.post('/reservations/:id/hold', requirePermission('reservations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await holdTableForReservation({reservationId: req.params.id, user: req.user, session});
    });
    publishTableEvent(result.reservation.branch, {reason: 'reservation', tableIds: [String(result.table._id)]});
    res.json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

// Cancelling is a distinct verb from a generic status change so the reason is
// always captured; it delegates to the same guarded transition.
r.delete('/reservations/:id', requirePermission('reservations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    let result;
    await session.withTransaction(async () => {
      result = await setReservationStatus({
        reservationId: req.params.id, status: 'cancelled', reason, user: req.user, session
      });
    });
    if (result.table) {
      publishTableEvent(result.reservation.branch, {reason: 'reservation', tableIds: [String(result.table._id)]});
    }
    res.json({cancelled: true, reservation: result.reservation});
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

export default r;
