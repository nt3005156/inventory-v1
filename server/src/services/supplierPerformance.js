import mongoose from 'mongoose';
import {Supplier} from '../models/index.js';
import {PurchaseOrder} from '../models/operations.js';
import {GoodsReceipt} from '../models/purchasing.js';
import {userRestaurantContext} from './supplierCatalog.js';

/**
 * Phase 16A — supplier performance from real purchasing history.
 *
 * The reorder engine relied entirely on the catalog's DECLARED lead time, so a
 * chronically late supplier looked punctual and the reorder point was computed
 * against a fiction.
 *
 * Actual lead time is measured from the order being approved (the point the
 * supplier could act on it) to the first goods receipt against it. Both
 * timestamps already exist — `PurchaseOrder.approvedAt` and
 * `GoodsReceipt.receivedAt` — so nothing is invented.
 *
 * Where there is not enough history, this returns `null` with
 * `insufficientData: true` rather than manufacturing a number, and the caller
 * falls back to the catalog figure.
 */

const round1 = value => Math.round(Number(value || 0) * 10) / 10;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Minimum completed deliveries before an average means anything. */
export const MIN_SAMPLES_FOR_LEAD_TIME = 3;

export function medianOf(values = []) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Summarises delivery samples into performance metrics.
 *
 * Kept pure so the arithmetic can be tested against a deterministic dataset
 * without touching the database.
 */
export function summariseDeliveries(samples = [], {minSamples = MIN_SAMPLES_FOR_LEAD_TIME} = {}) {
  const complete = samples.filter(row => Number.isFinite(row.actualLeadDays) && row.actualLeadDays >= 0);
  if (complete.length < minSamples) {
    return {
      samples: complete.length,
      insufficientData: true,
      reason: `Only ${complete.length} completed deliveries; ${minSamples} are required before an average is meaningful`,
      averageLeadDays: null,
      medianLeadDays: null,
      onTimeRate: null,
      lateCount: null,
      minLeadDays: null,
      maxLeadDays: null
    };
  }

  const leadDays = complete.map(row => row.actualLeadDays);
  // "Late" is measured against the expected delivery date the buyer recorded,
  // or the supplier's promised lead time. A delivery with neither is not
  // counted as on-time OR late — there is nothing to be late against.
  const judged = complete.filter(row => Number.isFinite(row.promisedLeadDays));
  const late = judged.filter(row => row.actualLeadDays > row.promisedLeadDays);

  return {
    samples: complete.length,
    insufficientData: false,
    averageLeadDays: round1(leadDays.reduce((sum, value) => sum + value, 0) / leadDays.length),
    medianLeadDays: round1(medianOf(leadDays)),
    minLeadDays: round1(Math.min(...leadDays)),
    maxLeadDays: round1(Math.max(...leadDays)),
    judgedDeliveries: judged.length,
    lateCount: late.length,
    onTimeRate: judged.length ? round1(((judged.length - late.length) / judged.length) * 100) : null,
    onTimeBasis: judged.length
      ? 'Compared against the expected delivery date or the promised lead time'
      : 'No delivery carried a promised date, so punctuality cannot be judged'
  };
}

/**
 * Collects real delivery samples for a supplier.
 */
export async function collectDeliverySamples({restaurantId, supplierId, branchIds, limit = 200}) {
  const match = {restaurant: restaurantId, supplier: supplierId};
  if (branchIds?.length) match.branch = {$in: branchIds};

  const orders = await PurchaseOrder.find({
    ...match,
    approvedAt: {$ne: null},
    status: {$in: ['partially_received', 'received', 'closed_short', 'closed']}
  })
    .select('poNo approvedAt expectedDeliveryDate items branch')
    .sort({approvedAt: -1})
    .limit(Math.min(500, Math.max(1, Number(limit) || 200)))
    .lean();
  if (!orders.length) return [];

  const receipts = await GoodsReceipt.find({
    restaurant: restaurantId,
    purchaseOrder: {$in: orders.map(order => order._id)}
  }).select('purchaseOrder receivedAt receiptNo').sort({receivedAt: 1}).lean();

  const firstReceiptByOrder = new Map();
  for (const receipt of receipts) {
    const key = String(receipt.purchaseOrder);
    if (!firstReceiptByOrder.has(key)) firstReceiptByOrder.set(key, receipt);
  }

  const samples = [];
  for (const order of orders) {
    const receipt = firstReceiptByOrder.get(String(order._id));
    if (!receipt) continue;
    const approved = new Date(order.approvedAt).getTime();
    const received = new Date(receipt.receivedAt).getTime();
    if (!Number.isFinite(approved) || !Number.isFinite(received)) continue;

    const actualLeadDays = (received - approved) / 86400000;
    // A receipt recorded before approval is data corruption, not a zero-day
    // delivery; excluded rather than clamped so it cannot flatter the average.
    if (actualLeadDays < 0) continue;

    let promisedLeadDays = null;
    if (order.expectedDeliveryDate) {
      promisedLeadDays = (new Date(order.expectedDeliveryDate).getTime() - approved) / 86400000;
    } else {
      const declared = (order.items || [])
        .map(item => Number(item.leadDays))
        .filter(value => Number.isFinite(value) && value > 0);
      if (declared.length) promisedLeadDays = Math.max(...declared);
    }

    samples.push({
      purchaseOrder: order._id,
      poNo: order.poNo,
      branch: order.branch,
      approvedAt: order.approvedAt,
      receivedAt: receipt.receivedAt,
      receiptNo: receipt.receiptNo,
      actualLeadDays: Math.round(actualLeadDays * 10) / 10,
      promisedLeadDays: promisedLeadDays === null ? null : Math.round(promisedLeadDays * 10) / 10,
      late: promisedLeadDays !== null && actualLeadDays > promisedLeadDays
    });
  }
  return samples;
}

/**
 * Supplier performance report. Owner/manager only, tenant scoped by the caller.
 */
export async function getSupplierPerformance({supplierId, branchId, user, limit = 200}) {
  if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
  const identity = await userRestaurantContext(user);
  const supplier = await Supplier.findOne({_id: supplierId, restaurant: identity.restaurantId})
    .select('name status leadTimeDays').lean();
  if (!supplier) throw httpError('Supplier not found', 404);

  let branchIds = null;
  if (branchId) {
    const {purchaseBranchContext} = await import('./purchaseOrders.js');
    const context = await purchaseBranchContext({user, branchId, allowInactive: true});
    branchIds = [context.branch._id];
  } else if (identity.role !== 'owner' && identity.branchId) {
    branchIds = [identity.branchId];
  }

  const samples = await collectDeliverySamples({
    restaurantId: identity.restaurantId, supplierId: supplier._id, branchIds, limit
  });
  const metrics = summariseDeliveries(samples);

  return {
    supplier: {_id: supplier._id, name: supplier.name, status: supplier.status || 'active'},
    declaredLeadDays: Number(supplier.leadTimeDays || 0),
    ...metrics,
    // Stated explicitly so a caller cannot mistake a fallback for a measurement.
    leadTimeSource: metrics.insufficientData ? 'catalog_declared' : 'measured',
    effectiveLeadDays: metrics.insufficientData
      ? Number(supplier.leadTimeDays || 0) || null
      : metrics.averageLeadDays,
    deliveries: samples.slice(0, 50)
  };
}

/**
 * Measured lead time per supplier, for the reorder engine.
 *
 * Returns a Map of supplierId -> {leadDays, source}. Suppliers without enough
 * history are simply absent, so the caller keeps its catalog figure.
 */
export async function measuredLeadTimes({restaurantId, branchIds}) {
  const orders = await PurchaseOrder.find({
    restaurant: restaurantId,
    ...(branchIds?.length ? {branch: {$in: branchIds}} : {}),
    approvedAt: {$ne: null},
    status: {$in: ['partially_received', 'received', 'closed_short', 'closed']}
  }).select('supplier').lean();
  const supplierIds = [...new Set(orders.map(order => String(order.supplier)).filter(Boolean))];

  const result = new Map();
  for (const supplierId of supplierIds) {
    const samples = await collectDeliverySamples({
      restaurantId, supplierId: new mongoose.Types.ObjectId(supplierId), branchIds
    });
    const metrics = summariseDeliveries(samples);
    if (metrics.insufficientData) continue;
    result.set(supplierId, {
      leadDays: metrics.averageLeadDays,
      source: 'measured',
      samples: metrics.samples,
      onTimeRate: metrics.onTimeRate
    });
  }
  return result;
}
