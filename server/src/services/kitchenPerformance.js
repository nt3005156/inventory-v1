import mongoose from 'mongoose';
import {Branch, Order} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {money} from './billing.js';
import {listStations} from './stations.js';
import {targetMinutes} from './kds.js';

// Phase 5D — kitchen performance.
//
// Every figure here is derived from the stage timestamps the KDS writes
// (acceptedAt / preparingAt / readyAt / completedAt), so the report measures
// what the kitchen actually did rather than re-deriving it from order status.
//
// The headline number is **prep time**: how long a ticket took from being
// placed to leaving the pass. That is the interval a guest experiences, and it
// is the one a kitchen can act on.

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

function createdAtRange(from, to) {
  if (!from && !to) return {};
  const createdAt = {};
  if (from) createdAt.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    createdAt.$lte = end;
  }
  return {createdAt};
}

/** Whole-minute difference, or null when either end is missing. */
export function minutesBetween(from, to) {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  // Clamp at zero: a clock skew must not produce negative prep time.
  return Math.max(0, Math.round(((end - start) / 60000) * 100) / 100);
}

/**
 * Per-ticket timings.
 *
 * `prepMinutes` is placed → ready, the guest-facing wait. `serviceMinutes`
 * runs to completion, which on a dine-in table includes the guest eating, so
 * the two are reported separately rather than conflated.
 */
export function ticketTimings(order) {
  const ready = order.readyAt || null;
  const completed = order.completedAt || null;
  return {
    waitMinutes: minutesBetween(order.createdAt, order.acceptedAt),
    cookMinutes: minutesBetween(order.preparingAt || order.acceptedAt, ready),
    prepMinutes: minutesBetween(order.createdAt, ready),
    serviceMinutes: minutesBetween(order.createdAt, completed)
  };
}

const round = value => (value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100);

function average(values) {
  const usable = values.filter(v => v !== null && v !== undefined && Number.isFinite(v));
  if (!usable.length) return null;
  return round(usable.reduce((sum, v) => sum + v, 0) / usable.length);
}

/** Nearest-rank percentile; more honest than an average for a long tail. */
export function percentile(values, p) {
  const usable = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!usable.length) return null;
  const index = Math.min(usable.length - 1, Math.max(0, Math.ceil((p / 100) * usable.length) - 1));
  return round(usable[index]);
}

/**
 * A ticket is delayed when its prep time exceeded the target it was cooked
 * against — the slowest item on it, or the channel default. Tickets still open
 * are judged against the clock so a stalled ticket counts as delayed now,
 * rather than only once someone finally closes it.
 */
export function delayOf(order, now = new Date()) {
  const target = targetMinutes(order);
  const reference = order.readyAt || (['completed', 'cancelled', 'refunded'].includes(order.status) ? order.completedAt : now);
  const elapsed = minutesBetween(order.createdAt, reference);
  if (elapsed === null) return {target, elapsed: null, delayed: false, overBy: 0};
  const overBy = round(Math.max(0, elapsed - target));
  return {target, elapsed, delayed: elapsed > target, overBy};
}

function summarise(rows, now) {
  const prep = rows.map(r => r.timings.prepMinutes);
  const delayed = rows.filter(r => r.delay.delayed);
  const completed = rows.filter(r => ['completed'].includes(r.status));
  return {
    orders: rows.length,
    completedOrders: completed.length,
    openOrders: rows.filter(r => !['completed', 'cancelled', 'refunded'].includes(r.status)).length,
    cancelledOrders: rows.filter(r => r.status === 'cancelled').length,
    averagePrepMinutes: average(prep),
    medianPrepMinutes: percentile(prep, 50),
    p90PrepMinutes: percentile(prep, 90),
    slowestPrepMinutes: prep.reduce((max, v) => (v !== null && v > (max ?? -1) ? v : max), null),
    averageWaitMinutes: average(rows.map(r => r.timings.waitMinutes)),
    averageCookMinutes: average(rows.map(r => r.timings.cookMinutes)),
    averageServiceMinutes: average(rows.map(r => r.timings.serviceMinutes)),
    delayedOrders: delayed.length,
    onTimeOrders: rows.length - delayed.length,
    onTimeRate: rows.length ? money((1 - delayed.length / rows.length) * 100) : null,
    averageDelayMinutes: average(delayed.map(r => r.delay.overBy)),
    worstDelayMinutes: delayed.reduce((max, r) => Math.max(max, r.delay.overBy), 0) || 0,
    rushOrders: rows.filter(r => r.rush).length,
    generatedAt: now
  };
}

/**
 * Station performance.
 *
 * A ticket is attributed to every station that worked on it, so the same
 * ticket contributes to both the grill and the bar. Station totals therefore
 * do not sum to the order count, which is the honest reading — one late ticket
 * can be late because of one section.
 */
function byStation(rows, stationCodes) {
  return stationCodes.map(code => {
    const scoped = rows.filter(r => r.stations.includes(code));
    const prep = scoped.map(r => r.timings.prepMinutes);
    const delayed = scoped.filter(r => r.delay.delayed);
    return {
      station: code,
      orders: scoped.length,
      completedOrders: scoped.filter(r => r.status === 'completed').length,
      items: scoped.reduce((sum, r) => sum + (r.itemsByStation[code] || 0), 0),
      averagePrepMinutes: average(prep),
      medianPrepMinutes: percentile(prep, 50),
      p90PrepMinutes: percentile(prep, 90),
      delayedOrders: delayed.length,
      onTimeRate: scoped.length ? money((1 - delayed.length / scoped.length) * 100) : null,
      averageDelayMinutes: average(delayed.map(r => r.delay.overBy))
    };
  }).sort((a, b) => b.orders - a.orders || a.station.localeCompare(b.station));
}

/**
 * Kitchen performance for a branch and period.
 *
 * Cancelled tickets are excluded from timing averages by default — a ticket
 * voided after two minutes would otherwise flatter the numbers — but they are
 * still counted so the volume is visible.
 */
export async function buildKitchenPerformance({
  branchId, user, from, to, station, includeCancelled = false, slowest = 5, now = new Date()
}) {
  if (!branchId) throw httpError('Branch is required', 400);
  if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  await assertTenantBranchAccess(user, branchId);
  const branch = await Branch.findById(branchId);
  if (!branch) throw httpError('Branch not found', 404);

  const configured = await listStations({restaurantId: branch.restaurant, includeInactive: true});
  const activeCodes = configured.filter(s => s.active !== false).map(s => s.code);
  const wanted = station ? String(station).trim().toLowerCase() : null;
  if (wanted && !activeCodes.includes(wanted)) {
    throw httpError(`Unknown station "${wanted}". Available: ${activeCodes.join(', ')}`, 400);
  }

  const orders = await Order.find({
    branch: branchId,
    status: {$nin: includeCancelled ? ['refunded'] : ['cancelled', 'refunded']},
    ...createdAtRange(from, to)
  }).sort({createdAt: 1}).lean();

  let rows = orders.map(order => {
    const itemsByStation = {};
    for (const item of order.items || []) {
      const code = String(item.station || 'kitchen').toLowerCase();
      itemsByStation[code] = (itemsByStation[code] || 0) + Number(item.qty || 0);
    }
    return {
      id: order._id,
      orderNo: order.orderNo,
      type: order.type,
      status: order.status,
      rush: order.priority === 'rush',
      createdAt: order.createdAt,
      stations: Object.keys(itemsByStation).sort(),
      itemsByStation,
      timings: ticketTimings(order),
      delay: delayOf(order, now)
    };
  });

  if (wanted) rows = rows.filter(r => r.stations.includes(wanted));

  const limit = Math.min(50, Math.max(1, Number(slowest) || 5));
  const slowestTickets = rows
    .filter(r => r.timings.prepMinutes !== null)
    .sort((a, b) => b.timings.prepMinutes - a.timings.prepMinutes)
    .slice(0, limit)
    .map(r => ({
      id: r.id, orderNo: r.orderNo, station: r.stations.join(', '),
      prepMinutes: r.timings.prepMinutes, targetMinutes: r.delay.target,
      overBy: r.delay.overBy, rush: r.rush
    }));

  return {
    branch: String(branchId),
    station: wanted,
    from: from || null,
    to: to || null,
    summary: summarise(rows, now),
    stations: byStation(rows, wanted ? [wanted] : activeCodes),
    delayed: rows.filter(r => r.delay.delayed)
      .sort((a, b) => b.delay.overBy - a.delay.overBy)
      .slice(0, limit)
      .map(r => ({
        id: r.id, orderNo: r.orderNo, status: r.status,
        prepMinutes: r.timings.prepMinutes, elapsedMinutes: r.delay.elapsed,
        targetMinutes: r.delay.target, overBy: r.delay.overBy, rush: r.rush
      })),
    slowestTickets
  };
}
