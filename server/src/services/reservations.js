import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {Branch, Customer, Reservation, ReservationCounter, RestaurantTable} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {findOpenTableOrder, occupyTable} from './tables.js';

// Phase 6C — reservations.
//
// A reservation holds a table for a window of time rather than blocking it
// outright: a table booked for 20:00 stays sellable all afternoon. Two bookings
// on the same table may not overlap, and the party must fit the table.

export const RESERVATION_STATUSES = Object.freeze([
  'booked', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'
]);

/** Statuses that still hold the table against other bookings. */
export const ACTIVE_STATUSES = Object.freeze(['booked', 'confirmed', 'seated']);
export const CLOSED_STATUSES = Object.freeze(['completed', 'cancelled', 'no_show']);

export const DEFAULT_DURATION_MINUTES = 90;
// Nepal local time; matches the receipt/report convention used elsewhere.
const KATHMANDU_OFFSET = '+05:45';

export const RESERVATION_TRANSITIONS = Object.freeze({
  booked: ['confirmed', 'seated', 'cancelled', 'no_show'],
  confirmed: ['seated', 'cancelled', 'no_show'],
  seated: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: []
});

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();

export function canTransitionReservation(from, to) {
  if (!from || !to) return false;
  return (RESERVATION_TRANSITIONS[from] || []).includes(to);
}

export function assertReservationTransition(from, to) {
  if (!RESERVATION_STATUSES.includes(to)) throw httpError(`Invalid reservation status ${to}`, 400);
  if (!canTransitionReservation(from, to)) {
    throw httpError(`Cannot move a reservation from ${from} to ${to}`, 409);
  }
}

/**
 * Resolves a local date + time into the absolute window the booking occupies.
 * Absolute instants make the overlap query timezone-proof.
 */
export function reservationWindow({date, time, durationMinutes = DEFAULT_DURATION_MINUTES}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(date))) throw httpError('Date must use YYYY-MM-DD', 400);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(time))) throw httpError('Time must use HH:MM (24-hour)', 400);
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 600) {
    throw httpError('Duration must be between 15 and 600 minutes', 400);
  }
  const startsAt = new Date(`${clean(date)}T${clean(time)}:00.000${KATHMANDU_OFFSET}`);
  if (Number.isNaN(startsAt.getTime())) throw httpError('Invalid reservation date or time', 400);
  // JavaScript rolls impossible dates forward: 2026-02-30 silently becomes
  // 2026-03-02, which would book a guest onto the wrong day entirely. Round
  // -tripping the local date back out catches that.
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(startsAt);
  if (localDate !== clean(date)) throw httpError(`Invalid reservation date ${clean(date)}`, 400);
  return {startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60000), durationMinutes: minutes};
}

/** Two windows clash when each starts before the other ends. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

async function nextReference({restaurantId, branch, startsAt, session}) {
  const year = Number(new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'Asia/Kathmandu'}).format(startsAt));
  const branchCode = clean(branch.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch._id).slice(-4).toUpperCase();
  const counter = await ReservationCounter.findOneAndUpdate(
    {restaurant: restaurantId, branchCode, year},
    {$inc: {value: 1}, $setOnInsert: {restaurant: restaurantId, branchCode, year}},
    {upsert: true, new: true, session, setDefaultsOnInsert: true}
  );
  return `RES-${branchCode}-${year}-${String(counter.value).padStart(5, '0')}`;
}

/**
 * Validates the table for a booking: same branch, in service, big enough, and
 * free for the requested window.
 */
async function assertTableAvailable({tableId, branchId, partySize, startsAt, endsAt, excludeId, session}) {
  const table = await RestaurantTable.findById(tableId).session(session || null);
  if (!table) throw httpError('Table not found', 404);
  if (String(table.branch) !== String(branchId)) throw httpError('Table is not at this branch', 409);
  if (table.active === false || table.status === 'disabled') throw httpError('Table is out of service', 409);
  if (Number(table.seats || 0) < Number(partySize)) {
    throw httpError(`Table ${table.name} seats ${table.seats}, too small for a party of ${partySize}`, 409);
  }

  // Only bookings that still hold the table can clash.
  const sameDay = await Reservation.find({
    table: table._id,
    status: {$in: ACTIVE_STATUSES},
    ...(excludeId ? {_id: {$ne: excludeId}} : {}),
    startsAt: {$lt: endsAt},
    endsAt: {$gt: startsAt}
  }).session(session || null).lean();

  if (sameDay.length) {
    const clash = sameDay[0];
    throw httpError(
      `Table ${table.name} is already reserved from ${clash.time} on ${clash.date} (${clash.reference})`,
      409
    );
  }
  return table;
}

function normalizeInput(input) {
  const partySize = Number(input.partySize);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 200) {
    throw httpError('Party size must be a whole number between 1 and 200', 400);
  }
  const name = clean(input.guestName);
  const phone = clean(input.guestPhone);
  return {partySize, name, phone};
}

/**
 * Creates a reservation.
 *
 * The guest may be an existing Customer or captured inline, so a phone booking
 * from someone not yet in the system does not force a customer record first.
 */
export async function createReservation({input, user, session}) {
  const branchId = input.branch;
  const branch = await assertTenantBranchAccess(user, branchId, {session});
  const {startsAt, endsAt, durationMinutes} = reservationWindow(input);
  const {partySize} = normalizeInput(input);

  let name = clean(input.guestName);
  let phone = clean(input.guestPhone);
  let customerId = null;

  if (input.customer) {
    if (!mongoose.isValidObjectId(input.customer)) throw httpError('Invalid customer', 400);
    const customer = await Customer.findById(input.customer).session(session || null);
    if (!customer) throw httpError('Customer not found', 404);
    // Phase 9: customers are restaurant-wide, so a guest first seen at one
    // branch may legitimately book at another. The tenant boundary is the
    // restaurant, which is checked here instead of the home branch.
    const bookingBranch = await Branch.findById(branchId).select('restaurant').session(session || null);
    if (customer.restaurant && bookingBranch
      && String(customer.restaurant) !== String(bookingBranch.restaurant)) {
      throw httpError('Customer belongs to another restaurant', 409);
    }
    customerId = customer._id;
    name = name || clean(customer.name);
    phone = phone || clean(customer.phone);
  }
  if (!name) throw httpError('A guest name is required', 400);
  if (!phone) throw httpError('A contact phone is required', 400);

  let table = null;
  if (input.table) {
    if (!mongoose.isValidObjectId(input.table)) throw httpError('Invalid table', 400);
    table = await assertTableAvailable({
      tableId: input.table, branchId, partySize, startsAt, endsAt, session
    });
  }

  const reference = await nextReference({
    restaurantId: branch.restaurant, branch, startsAt, session
  });

  const [reservation] = await Reservation.create([{
    restaurant: branch.restaurant,
    branch: branchId,
    reference,
    customer: customerId,
    guestName: name,
    guestPhone: phone,
    guestEmail: clean(input.guestEmail) || undefined,
    partySize,
    date: clean(input.date),
    time: clean(input.time),
    durationMinutes,
    startsAt,
    endsAt,
    table: table ? table._id : null,
    status: 'booked',
    notes: clean(input.notes) || undefined,
    createdBy: user.id
  }], {session: session || undefined});

  await Audit.create([{
    entity: 'reservation', entityId: reservation._id, restaurant: branch.restaurant, branch: branchId,
    action: 'reservation_created',
    after: {reference, date: reservation.date, time: reservation.time, partySize, table: table?.name || null},
    user: user.id
  }], {session: session || undefined});

  return reservation;
}

async function loadReservation({reservationId, user, session}) {
  if (!mongoose.isValidObjectId(reservationId)) throw httpError('Invalid reservation', 400);
  const reservation = await Reservation.findById(reservationId).session(session || null);
  if (!reservation) throw httpError('Reservation not found', 404);
  await assertTenantBranchAccess(user, reservation.branch, {session});
  return reservation;
}

/** Amends a booking. Re-validates the table whenever the slot or party moves. */
export async function updateReservation({reservationId, patch, user, session}) {
  const reservation = await loadReservation({reservationId, user, session});
  if (CLOSED_STATUSES.includes(reservation.status)) {
    throw httpError(`A ${reservation.status} reservation cannot be amended`, 409);
  }

  const before = {
    date: reservation.date, time: reservation.time,
    partySize: reservation.partySize, table: reservation.table
  };

  const date = patch.date !== undefined ? clean(patch.date) : reservation.date;
  const time = patch.time !== undefined ? clean(patch.time) : reservation.time;
  const durationMinutes = patch.durationMinutes !== undefined
    ? Number(patch.durationMinutes) : reservation.durationMinutes;
  const partySize = patch.partySize !== undefined ? Number(patch.partySize) : reservation.partySize;
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 200) {
    throw httpError('Party size must be a whole number between 1 and 200', 400);
  }

  const window = reservationWindow({date, time, durationMinutes});
  const tableId = patch.table !== undefined ? patch.table : reservation.table;

  if (tableId) {
    await assertTableAvailable({
      tableId, branchId: reservation.branch, partySize,
      startsAt: window.startsAt, endsAt: window.endsAt,
      excludeId: reservation._id, session
    });
  }

  reservation.date = date;
  reservation.time = time;
  reservation.durationMinutes = window.durationMinutes;
  reservation.startsAt = window.startsAt;
  reservation.endsAt = window.endsAt;
  reservation.partySize = partySize;
  reservation.table = tableId || null;
  if (patch.guestName !== undefined) reservation.guestName = clean(patch.guestName) || reservation.guestName;
  if (patch.guestPhone !== undefined) reservation.guestPhone = clean(patch.guestPhone) || reservation.guestPhone;
  if (patch.guestEmail !== undefined) reservation.guestEmail = clean(patch.guestEmail) || undefined;
  if (patch.notes !== undefined) reservation.notes = clean(patch.notes) || undefined;
  reservation.updatedBy = user.id;
  await reservation.save({session: session || undefined});

  await Audit.create([{
    entity: 'reservation', entityId: reservation._id, restaurant: reservation.restaurant,
    branch: reservation.branch, action: 'reservation_updated', before,
    after: {date: reservation.date, time: reservation.time, partySize, table: reservation.table},
    user: user.id
  }], {session: session || undefined});

  return reservation;
}

/**
 * Moves a reservation through its lifecycle.
 *
 * Seating claims the table and flips it to occupied, reusing the existing
 * table machinery rather than duplicating that logic.
 */
export async function setReservationStatus({reservationId, status, reason, user, session}) {
  const reservation = await loadReservation({reservationId, user, session});
  assertReservationTransition(reservation.status, status);
  const note = clean(reason);
  if (note.length > 300) throw httpError('Reason must be 300 characters or fewer', 400);

  const before = reservation.status;
  let table = null;

  if (status === 'seated') {
    if (!reservation.table) throw httpError('Assign a table before seating this reservation', 409);
    const existing = await findOpenTableOrder(reservation.table, session);
    if (existing) throw httpError('That table already has an open check', 409);
    // occupyTable accepts an available or reserved table and audits the change.
    table = await occupyTable({
      tableId: reservation.table, branchId: reservation.branch,
      orderId: reservation._id, userId: user.id, session
    });
    reservation.seatedAt = new Date();
  }

  if (status === 'completed') reservation.completedAt = new Date();

  if (status === 'cancelled' || status === 'no_show') {
    reservation.cancelledAt = new Date();
    reservation.cancelledBy = user.id;
    reservation.cancellationReason = note || undefined;
    // Release a table that was being held for an imminent arrival.
    if (reservation.table) {
      const held = await RestaurantTable.findById(reservation.table).session(session || null);
      if (held && held.status === 'reserved') {
        held.status = 'available';
        await held.save({session: session || undefined});
        await Audit.create([{
          entity: 'table', entityId: held._id, branch: held.branch, action: 'status',
          before: {status: 'reserved'}, after: {status: 'available', reason: `reservation ${status}`},
          user: user.id
        }], {session: session || undefined});
        table = held;
      }
    }
  }

  reservation.status = status;
  reservation.updatedBy = user.id;
  await reservation.save({session: session || undefined});

  await Audit.create([{
    entity: 'reservation', entityId: reservation._id, restaurant: reservation.restaurant,
    branch: reservation.branch, action: 'reservation_status',
    before: {status: before}, after: {status}, reason: note || undefined, user: user.id
  }], {session: session || undefined});

  return {reservation, table};
}

/** Marks the table reserved when an arrival is imminent. */
export async function holdTableForReservation({reservationId, user, session}) {
  const reservation = await loadReservation({reservationId, user, session});
  if (!ACTIVE_STATUSES.includes(reservation.status)) {
    throw httpError('Only an active reservation can hold a table', 409);
  }
  if (!reservation.table) throw httpError('This reservation has no table assigned', 409);
  const table = await RestaurantTable.findById(reservation.table).session(session || null);
  if (!table) throw httpError('Table not found', 404);
  if (table.status !== 'available') throw httpError(`Table is ${table.status}`, 409);
  const before = table.status;
  table.status = 'reserved';
  await table.save({session: session || undefined});
  await Audit.create([{
    entity: 'table', entityId: table._id, branch: table.branch, action: 'status',
    before: {status: before}, after: {status: 'reserved', reservation: reservation.reference},
    user: user.id
  }], {session: session || undefined});
  return {reservation, table};
}

/** The diary: bookings for a branch, optionally narrowed to a date or status. */
export async function listReservations({branchId, user, date, from, to, status, tableId, limit = 200}) {
  await assertTenantBranchAccess(user, branchId);
  const match = {branch: branchId};

  if (status) {
    if (!RESERVATION_STATUSES.includes(status)) throw httpError(`Invalid status ${status}`, 400);
    match.status = status;
  }
  if (tableId) {
    if (!mongoose.isValidObjectId(tableId)) throw httpError('Invalid table', 400);
    match.table = tableId;
  }
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(date))) throw httpError('Date must use YYYY-MM-DD', 400);
    match.date = clean(date);
  } else if (from || to) {
    match.date = {};
    if (from) match.date.$gte = clean(from);
    if (to) match.date.$lte = clean(to);
  }

  const cap = Math.min(500, Math.max(1, Number(limit) || 200));
  const rows = await Reservation.find(match)
    .sort({startsAt: 1})
    .limit(cap)
    .populate('table', 'name area seats status')
    .populate('customer', 'name phone')
    .lean();

  const active = rows.filter(r => ACTIVE_STATUSES.includes(r.status));
  return {
    branch: String(branchId),
    date: date || null,
    summary: {
      total: rows.length,
      covers: active.reduce((sum, r) => sum + Number(r.partySize || 0), 0),
      byStatus: RESERVATION_STATUSES.reduce((acc, key) => {
        acc[key] = rows.filter(r => r.status === key).length;
        return acc;
      }, {}),
      unassigned: active.filter(r => !r.table).length
    },
    reservations: rows
  };
}

/** Tables that can take a party for a window, with the clashes explained. */
export async function findAvailableTables({branchId, user, date, time, durationMinutes, partySize}) {
  await assertTenantBranchAccess(user, branchId);
  const {startsAt, endsAt} = reservationWindow({date, time, durationMinutes});
  const size = Number(partySize);
  if (!Number.isInteger(size) || size < 1) throw httpError('Party size must be a whole number', 400);

  const tables = await RestaurantTable.find({
    branch: branchId, active: {$ne: false}, status: {$ne: 'disabled'}, seats: {$gte: size}
  }).sort({seats: 1, name: 1}).lean();

  const booked = await Reservation.find({
    branch: branchId,
    status: {$in: ACTIVE_STATUSES},
    startsAt: {$lt: endsAt},
    endsAt: {$gt: startsAt}
  }).select('table reference time').lean();

  const takenBy = new Map(booked.filter(b => b.table).map(b => [String(b.table), b]));
  return {
    branch: String(branchId),
    window: {date, time, startsAt, endsAt, partySize: size},
    available: tables.filter(t => !takenBy.has(String(t._id)))
      .map(t => ({id: t._id, name: t.name, area: t.area, seats: t.seats, status: t.status})),
    unavailable: tables.filter(t => takenBy.has(String(t._id)))
      .map(t => ({
        id: t._id, name: t.name, seats: t.seats,
        reservedBy: takenBy.get(String(t._id)).reference,
        at: takenBy.get(String(t._id)).time
      }))
  };
}
