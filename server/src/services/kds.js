import mongoose from 'mongoose';
import {Branch, Order} from '../models/operations.js';
import {assertTenantBranchAccess, KITCHEN_QUEUE_STATUSES} from './kitchen.js';
import {BUILT_IN_STATION_CODES, listStations, stationCode} from './stations.js';

// Phase 5A — KDS core.
//
// The board presents the kitchen's four working stages. The underlying order
// statuses are unchanged (billing, tables and realtime all depend on them), so
// the five queue statuses are mapped onto the four columns the kitchen thinks
// in: a ticket is New until someone accepts it, Preparing while it is being
// cooked, Ready when it leaves the pass, and then Completed.
export const KDS_STAGES = Object.freeze(['new', 'preparing', 'ready', 'completed']);

export const STAGE_STATUSES = Object.freeze({
  new: ['pending', 'confirmed'],
  preparing: ['accepted', 'preparing'],
  ready: ['ready'],
  completed: ['completed']
});

/**
 * Built-in station codes. Phase 5C made stations definable per restaurant, so
 * this is the default seed rather than the authority — the board validates a
 * requested station against the restaurant's own list.
 */
export const KITCHEN_STATIONS = BUILT_IN_STATION_CODES;

// Age thresholds, in minutes, against a ticket's target prep time.
export const PRIORITY_LEVELS = Object.freeze(['normal', 'due', 'late', 'overdue']);
export const DEFAULT_TARGET_MINUTES = 15;
// Channel targets: a delivery ticket has travel time ahead of it, so it is
// pushed earlier than a guest sitting at a table.
export const TARGET_BY_TYPE = Object.freeze({
  'dine-in': 15,
  counter: 12,
  takeaway: 12,
  delivery: 10
});

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim().toLowerCase();

export function normalizeStation(value, allowed = KITCHEN_STATIONS) {
  const station = clean(value);
  if (!station) return null;
  if (!allowed.includes(station)) {
    throw httpError(`Station must be one of ${allowed.join(', ')}`, 400);
  }
  return station;
}

export function stageForStatus(status) {
  return Object.keys(STAGE_STATUSES).find(stage => STAGE_STATUSES[stage].includes(status)) || null;
}

/** Whole minutes a ticket has been alive. */
export function ageMinutes(order, now = new Date()) {
  const placed = new Date(order.createdAt).getTime();
  if (Number.isNaN(placed)) return 0;
  return Math.max(0, Math.floor((now.getTime() - placed) / 60000));
}

/**
 * Target prep time for a ticket: the slowest item on it (a grill steak paces
 * the ticket, not the salad beside it), falling back to the channel default.
 */
export function targetMinutes(order) {
  const itemMax = (order.items || []).reduce(
    (max, item) => Math.max(max, Number(item.prepMinutes || 0)),
    0
  );
  if (itemMax > 0) return itemMax;
  return TARGET_BY_TYPE[order.type] ?? DEFAULT_TARGET_MINUTES;
}

/**
 * Age-based escalation. A ticket is `due` as it approaches its target, `late`
 * once past it, and `overdue` at 1.5x. A manual rush flag always reports the
 * top level so an expediter's decision is never downgraded by the clock.
 */
export function priorityFor(order, now = new Date()) {
  if (order.priority === 'rush') return 'overdue';
  const target = targetMinutes(order);
  const age = ageMinutes(order, now);
  if (age >= target * 1.5) return 'overdue';
  if (age >= target) return 'late';
  if (age >= target * 0.75) return 'due';
  return 'normal';
}

const RANK = {overdue: 0, late: 1, due: 2, normal: 3};

/**
 * Board order: rush tickets first, then by escalation level, then oldest
 * first so nothing is starved behind a newer urgent ticket.
 */
export function sortQueue(rows) {
  return rows.slice().sort((a, b) => {
    if (a.rush !== b.rush) return a.rush ? -1 : 1;
    const rank = RANK[a.priority] - RANK[b.priority];
    if (rank !== 0) return rank;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

/** Lines belonging to a station, and whether the ticket touches it at all. */
export function stationLines(order, station) {
  const items = order.items || [];
  if (!station) return {lines: items, matches: true};
  const lines = items.filter(item => clean(item.station || 'kitchen') === station);
  return {lines, matches: lines.length > 0};
}

/** Distinct stations present on a ticket. */
export function stationsOf(order) {
  return [...new Set((order.items || []).map(item => clean(item.station || 'kitchen')))].sort();
}

function toTicket(order, {station, now}) {
  const {lines} = stationLines(order, station);
  const priority = priorityFor(order, now);
  const age = ageMinutes(order, now);
  const target = targetMinutes(order);
  return {
    id: order._id,
    orderNo: order.orderNo,
    branch: order.branch,
    stage: stageForStatus(order.status),
    status: order.status,
    type: order.type,
    table: order.table?.name || null,
    customer: order.customer?.name || null,
    createdAt: order.createdAt,
    ageMinutes: age,
    targetMinutes: target,
    overdueBy: Math.max(0, age - target),
    priority,
    rush: order.priority === 'rush',
    stations: stationsOf(order),
    // When filtering by station the ticket only shows that section's work.
    items: lines.map(item => ({
      name: item.name,
      qty: item.qty,
      station: clean(item.station || 'kitchen'),
      prepMinutes: Number(item.prepMinutes || 0),
      notes: item.notes || undefined,
      specialInstructions: item.specialInstructions || undefined,
      modifiers: (item.modifiers || []).map(m => ({
        name: m.name,
        removed: Boolean(m.removed)
      }))
    })),
    itemCount: lines.reduce((sum, item) => sum + Number(item.qty || 0), 0),
    acceptedAt: order.acceptedAt || null,
    preparingAt: order.preparingAt || null,
    readyAt: order.readyAt || null
  };
}

/**
 * Builds the kitchen board for a branch.
 *
 * Returns both a flat queue (for the existing list consumers) and tickets
 * grouped into the four stages the KDS renders as columns.
 */
export async function buildKitchenBoard({branchId, user, station, stage, priority, includeCompleted = false, now = new Date()}) {
  if (!branchId) throw httpError('Branch is required', 400);
  if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  await assertTenantBranchAccess(user, branchId);
  const branch = await Branch.findById(branchId);
  if (!branch) throw httpError('Branch not found', 404);

  const configured = await listStations({restaurantId: branch.restaurant, includeInactive: true});
  const activeCodes = configured.filter(s => s.active !== false).map(s => s.code);
  const wantedStation = station ? normalizeStation(station, activeCodes) : null;
  if (stage && !KDS_STAGES.includes(stage)) {
    throw httpError(`Stage must be one of ${KDS_STAGES.join(', ')}`, 400);
  }
  if (priority && !PRIORITY_LEVELS.includes(priority)) {
    throw httpError(`Priority must be one of ${PRIORITY_LEVELS.join(', ')}`, 400);
  }

  const statuses = stage
    ? STAGE_STATUSES[stage]
    : (includeCompleted ? [...KITCHEN_QUEUE_STATUSES, 'completed'] : KITCHEN_QUEUE_STATUSES);

  const orders = await Order.find({branch: branchId, status: {$in: statuses}})
    .sort({createdAt: 1})
    .populate('table', 'name area seats status')
    .populate('customer', 'name phone');

  let tickets = orders
    .filter(order => stationLines(order, wantedStation).matches)
    .map(order => toTicket(order, {station: wantedStation, now}));

  if (priority) tickets = tickets.filter(t => t.priority === priority);
  tickets = sortQueue(tickets);

  const columns = KDS_STAGES.map(key => ({
    stage: key,
    title: key === 'new' ? 'New' : key[0].toUpperCase() + key.slice(1),
    statuses: STAGE_STATUSES[key],
    tickets: tickets.filter(t => t.stage === key)
  }));

  return {
    branch: String(branchId),
    station: wantedStation,
    stations: activeCodes,
    stationDetail: configured.filter(s => s.active !== false)
      .map(s => ({code: s.code, name: s.name, isDefault: Boolean(s.isDefault)})),
    generatedAt: now,
    summary: {
      total: tickets.length,
      rush: tickets.filter(t => t.rush).length,
      overdue: tickets.filter(t => t.priority === 'overdue').length,
      late: tickets.filter(t => t.priority === 'late').length,
      oldestMinutes: tickets.reduce((max, t) => Math.max(max, t.ageMinutes), 0),
      byStage: Object.fromEntries(columns.map(c => [c.stage, c.tickets.length])),
      byStation: activeCodes.reduce((acc, code) => {
        acc[code] = tickets.filter(t => t.stations.includes(code)).length;
        return acc;
      }, {})
    },
    columns,
    tickets
  };
}

/** Flags or clears a rush ticket. */
export async function setOrderPriority({orderId, priority, user, session}) {
  if (!['normal', 'rush'].includes(priority)) throw httpError('Priority must be normal or rush', 400);
  const order = await Order.findById(orderId).session(session || null);
  if (!order) throw httpError('Order not found', 404);
  await assertTenantBranchAccess(user, order.branch, {session});
  if (!KITCHEN_QUEUE_STATUSES.includes(order.status)) {
    throw httpError('Only an open kitchen ticket can be prioritised', 409);
  }
  order.priority = priority;
  order.rushedAt = priority === 'rush' ? new Date() : undefined;
  order.rushedBy = priority === 'rush' ? user.id : undefined;
  await order.save({session: session || undefined});
  return order;
}

/** Stage timestamps, so time-in-stage is measurable rather than guessed. */
export function stampStage(order, status, at = new Date()) {
  if (status === 'accepted' && !order.acceptedAt) order.acceptedAt = at;
  if (status === 'preparing' && !order.preparingAt) order.preparingAt = at;
  if (status === 'ready' && !order.readyAt) order.readyAt = at;
  if (status === 'completed' && !order.completedAt) order.completedAt = at;
  return order;
}
