import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Audit, Supplier} from '../models/index.js';
import {Branch, PurchaseOrder, PurchaseOrderCounter} from '../models/operations.js';
import {prepareCatalogPurchaseOrder} from './catalogPurchasing.js';
import {userRestaurantContext} from './supplierCatalog.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = value => String(value || '').trim();
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const editableStatuses = ['draft', 'rejected'];

export const PO_TRANSITIONS = {
  draft: ['pending', 'cancelled'],
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['sent', 'cancelled'],
  rejected: ['pending', 'cancelled'],
  sent: ['cancelled'],
  partially_received: [],
  received: [],
  cancelled: []
};

export const RECEIVABLE_STATUSES = ['approved', 'sent', 'partially_received'];
export const REPORTABLE_PO_STATUSES = ['approved', 'sent', 'partially_received', 'received'];

export function canReceivePo(status) {
  return RECEIVABLE_STATUSES.includes(status);
}

export function canTransitionPo(from, to) {
  return (PO_TRANSITIONS[from] || []).includes(to);
}

function populatedPurchaseOrder(query) {
  return query
    .populate('branch', 'name code address phone')
    .populate('supplier', 'name contact address paymentTerms')
    .populate('items.ingredient', 'name code category unit')
    .populate('items.catalogItem', 'supplierSku purchaseUnit baseUnit')
    .populate('createdBy', 'name role')
    .populate('updatedBy', 'name role')
    .populate('approvedBy', 'name role');
}

export async function purchaseBranchContext({user, branchId, session, allowInactive = false}) {
  if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  const context = await userRestaurantContext(user, {session});
  const branch = await Branch.findById(branchId).select('restaurant name code address phone active').session(session || null).lean();
  if (!branch || (!allowInactive && branch.active === false)) throw httpError('Active branch not found', 404);
  if (String(branch.restaurant) !== String(context.restaurantId)) throw httpError('Branch does not belong to the user restaurant', 403);
  if (context.role !== 'owner') {
    if (!context.branchId || String(context.branchId) !== String(branch._id)) throw httpError('Branch access denied', 403);
  }
  return {...context, branch};
}

export async function listAccessibleBranches({user}) {
  const context = await userRestaurantContext(user);
  const match = {restaurant: context.restaurantId, active: {$ne: false}};
  if (context.role !== 'owner') {
    if (!context.branchId) throw httpError('User is not assigned to a branch', 403);
    match._id = context.branchId;
  }
  return Branch.find(match).select('restaurant name code address phone active').sort({name: 1}).lean();
}

function kathmanduBoundary(value, end = false) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw httpError('Dates must use YYYY-MM-DD', 400);
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}+05:45`);
  if (Number.isNaN(date.getTime())) throw httpError('Invalid date', 400);
  const kathmanduDate = new Date(date.getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (kathmanduDate !== value) throw httpError('Invalid date', 400);
  return date;
}

export async function listPurchaseOrders({user, branchId, q, supplier, status, from, to, page = 1, limit = 25}) {
  const context = await purchaseBranchContext({user, branchId});
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const match = {restaurant: context.restaurantId, branch: context.branch._id};

  if (supplier) {
    if (!mongoose.isValidObjectId(supplier)) throw httpError('Invalid supplier', 400);
    match.supplier = new mongoose.Types.ObjectId(supplier);
  }
  const statuses = Array.isArray(status) ? status : clean(status).split(',').map(value => value.trim()).filter(Boolean);
  const allowedStatuses = Object.keys(PO_TRANSITIONS);
  if (statuses.some(value => !allowedStatuses.includes(value))) throw httpError('Invalid purchase order status filter', 400);
  if (statuses.length) match.status = {$in: statuses};
  const start = kathmanduBoundary(from);
  const end = kathmanduBoundary(to, true);
  if (start || end) match.orderDate = {...(start ? {$gte: start} : {}), ...(end ? {$lte: end} : {})};
  if (start && end && start > end) throw httpError('From date must not be after to date', 400);

  const term = clean(q);
  if (term) {
    const regex = new RegExp(escapeRegex(term), 'i');
    const supplierIds = await Supplier.find({restaurant: context.restaurantId, name: regex}).distinct('_id');
    match.$or = [{poNo: regex}, {notes: regex}, {supplier: {$in: supplierIds}}];
  }

  const [items, total, summary] = await Promise.all([
    populatedPurchaseOrder(PurchaseOrder.find(match)
      .sort({orderDate: -1, createdAt: -1, _id: -1})
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)),
    PurchaseOrder.countDocuments(match),
    PurchaseOrder.aggregate([
      {$match: match},
      {$group: {_id: null, subtotal: {$sum: '$subtotal'}, vat: {$sum: '$vat'}, total: {$sum: '$total'}, open: {$sum: {$cond: [{$in: ['$status', ['draft', 'pending', 'approved', 'sent', 'partially_received']]}, 1, 0]}}}}
    ])
  ]);

  const totals = summary[0] || {subtotal: 0, vat: 0, total: 0, open: 0};
  return {
    items,
    pagination: {page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit))},
    summary: {subtotal: money(totals.subtotal), vat: money(totals.vat), total: money(totals.total), open: totals.open || 0}
  };
}

export async function getPurchaseOrder({poId, user, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const po = await PurchaseOrder.findById(poId).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  await purchaseBranchContext({user, branchId: po.branch, session, allowInactive: true});
  return populatedPurchaseOrder(PurchaseOrder.findById(po._id).session(session || null));
}

function parseOrderDate(value) {
  if (!value) return new Date();
  const date = kathmanduBoundary(value);
  return date;
}

function expectedDate(value, orderDate, leadDays) {
  if (value === null) return null;
  if (value) {
    const date = kathmanduBoundary(value);
    if (date < orderDate) throw httpError('Expected delivery date must not be before the order date', 400);
    return date;
  }
  if (!leadDays) return null;
  return new Date(orderDate.getTime() + Number(leadDays) * 86400000);
}

function requestFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function nextPurchaseOrderNumber({restaurantId, branch, orderDate, session}) {
  const year = Number(new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'Asia/Kathmandu'}).format(orderDate));
  const branchCode = clean(branch.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || String(branch._id).slice(-4).toUpperCase();
  // Counter scope follows the number's visible branch code, not only the branch id.
  // This preserves restaurant-wide number uniqueness even if two branches share a code.
  const counter = await PurchaseOrderCounter.findOneAndUpdate(
    {restaurant: restaurantId, branchCode, year},
    {$inc: {value: 1}, $setOnInsert: {restaurant: restaurantId, branch: branch._id, branchCode, year}},
    {upsert: true, new: true, session, setDefaultsOnInsert: true}
  );
  return `PO-${branchCode}-${year}-${String(counter.value).padStart(6, '0')}`;
}

function auditView(po) {
  return {
    poNo: po.poNo,
    status: po.status,
    supplier: po.supplier,
    orderDate: po.orderDate,
    expectedDeliveryDate: po.expectedDeliveryDate,
    itemCount: po.items?.length || 0,
    subtotal: po.subtotal,
    vat: po.vat,
    total: po.total,
    version: po.__v
  };
}

async function replayByKey({restaurantId, requestKey, requestHash, session}) {
  if (!requestKey) return null;
  const existing = await PurchaseOrder.findOne({restaurant: restaurantId, requestKey})
    .select('+requestHash')
    .session(session || null);
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw httpError('Idempotency key was already used for a different purchase order', 409);
  return populatedPurchaseOrder(PurchaseOrder.findById(existing._id).session(session || null));
}

export async function createPurchaseOrder({input, user, requestKey, session}) {
  const context = await purchaseBranchContext({user, branchId: input.branch, session});
  if (!['owner', 'manager'].includes(context.role)) throw httpError('Insufficient permission', 403);
  const key = clean(requestKey) || undefined;
  if (key && key.length > 120) throw httpError('Idempotency key is too long', 400);
  const fingerprint = requestFingerprint(input);
  const replay = await replayByKey({restaurantId: context.restaurantId, requestKey: key, requestHash: fingerprint, session});
  if (replay) return {purchaseOrder: replay, duplicate: true};

  const orderDate = parseOrderDate(input.orderDate);
  const prepared = await prepareCatalogPurchaseOrder({
    branchId: input.branch,
    supplierId: input.supplier,
    items: input.items,
    user,
    session
  });
  const deliveryDate = expectedDate(input.expectedDeliveryDate, orderDate, prepared.maxLeadDays);
  const poNo = await nextPurchaseOrderNumber({restaurantId: context.restaurantId, branch: context.branch, orderDate, session});
  const [saved] = await PurchaseOrder.create([{
    restaurant: context.restaurantId,
    poNo,
    numberVersion: 2,
    branch: context.branch._id,
    supplier: input.supplier,
    status: 'draft',
    orderDate,
    expectedDeliveryDate: deliveryDate || undefined,
    deliveryAddress: clean(input.deliveryAddress) || clean(context.branch.address) || undefined,
    items: prepared.items,
    subtotal: prepared.subtotal,
    vat: prepared.vat,
    total: prepared.total,
    notes: clean(input.notes) || undefined,
    requestKey: key,
    requestHash: key ? fingerprint : undefined,
    createdBy: context.userId,
    updatedBy: context.userId
  }], {session});
  await Audit.create([{
    entity: 'purchase_order',
    entityId: saved._id,
    restaurant: context.restaurantId,
    branch: context.branch._id,
    action: 'po_create',
    after: auditView(saved),
    user: context.userId
  }], {session});
  return {purchaseOrder: await populatedPurchaseOrder(PurchaseOrder.findById(saved._id).session(session || null)), duplicate: false};
}

export async function replayPurchaseOrderCreate({input, user, requestKey}) {
  const context = await purchaseBranchContext({user, branchId: input.branch});
  const po = await replayByKey({
    restaurantId: context.restaurantId,
    requestKey: clean(requestKey),
    requestHash: requestFingerprint(input)
  });
  if (!po) throw httpError('Purchase order could not be replayed', 409);
  return {purchaseOrder: po, duplicate: true};
}

export async function updatePurchaseOrder({poId, input, expectedVersion, user, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const current = await PurchaseOrder.findById(poId).session(session || null).lean();
  if (!current) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: current.branch, session, allowInactive: true});
  if (!['owner', 'manager'].includes(context.role)) throw httpError('Insufficient permission', 403);
  if (!editableStatuses.includes(current.status)) throw httpError('Only draft or rejected purchase orders can be edited', 409);
  if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) !== Number(current.__v || 0)) {
    throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
  }

  const prepared = await prepareCatalogPurchaseOrder({
    branchId: current.branch,
    supplierId: input.supplier,
    items: input.items,
    user,
    session
  });
  const orderDate = current.orderDate || current.createdAt;
  const deliveryDate = input.expectedDeliveryDate === undefined
    ? current.expectedDeliveryDate
    : expectedDate(input.expectedDeliveryDate, orderDate, prepared.maxLeadDays);
  const set = {
    supplier: new mongoose.Types.ObjectId(input.supplier),
    items: prepared.items.map(item => ({...item, _id: new mongoose.Types.ObjectId()})),
    subtotal: prepared.subtotal,
    vat: prepared.vat,
    total: prepared.total,
    deliveryAddress: input.deliveryAddress === undefined
      ? (current.deliveryAddress || null)
      : (clean(input.deliveryAddress) || null),
    notes: input.notes === undefined ? (current.notes || null) : (clean(input.notes) || null),
    updatedBy: context.userId,
    updatedAt: new Date()
  };
  if (deliveryDate) set.expectedDeliveryDate = deliveryDate;

  const update = {$set: set, $inc: {__v: 1}};
  if (!deliveryDate) update.$unset = {expectedDeliveryDate: ''};
  const updateResult = await PurchaseOrder.collection.findOneAndUpdate(
    {_id: current._id, __v: Number(current.__v || 0), status: {$in: editableStatuses}},
    update,
    {session, returnDocument: 'after', includeResultMetadata: false}
  );
  const updated = updateResult?.value === undefined ? updateResult : updateResult.value;
  if (!updated) throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
  const fresh = await PurchaseOrder.findById(current._id).session(session || null);
  await Audit.create([{
    entity: 'purchase_order',
    entityId: current._id,
    restaurant: context.restaurantId,
    branch: context.branch._id,
    action: 'po_update',
    before: auditView(current),
    after: auditView(fresh),
    user: context.userId
  }], {session});
  return populatedPurchaseOrder(PurchaseOrder.findById(current._id).session(session || null));
}

export async function transitionPurchaseOrder({poId, status, notes, expectedVersion, user, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  if (!status) throw httpError('Status is required', 400);
  const po = await PurchaseOrder.findById(poId).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: po.branch, session, allowInactive: true});
  if (!['owner', 'manager'].includes(context.role)) throw httpError('Insufficient permission', 403);
  if (expectedVersion !== undefined && Number(expectedVersion) !== po.__v) {
    throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
  }
  if (!canTransitionPo(po.status, status)) {
    throw httpError(`Invalid purchase order transition from ${po.status} to ${status}`, 409);
  }
  if (status === 'cancelled') {
    const received = (po.items || []).some(item => Number(item.receivedQty || 0) > 0);
    if (received) throw httpError('Cannot cancel a purchase order that has receipts', 409);
  }

  const before = {status: po.status, approvedBy: po.approvedBy, approvalNote: po.approvalNote, version: po.__v};
  po.status = status;
  po.updatedBy = context.userId;
  if (status === 'approved') {
    po.approvedBy = context.userId;
    po.approvalNote = clean(notes) || undefined;
  } else if (status === 'rejected') {
    po.approvedBy = undefined;
    po.approvalNote = clean(notes) || undefined;
  } else if (status === 'pending') {
    po.approvedBy = undefined;
    po.approvalNote = clean(notes) || undefined;
  } else if (status === 'cancelled' && clean(notes)) {
    po.approvalNote = clean(notes);
  }
  try {
    await po.save({session});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
    throw error;
  }
  await Audit.create([{
    entity: 'purchase_order',
    entityId: po._id,
    restaurant: context.restaurantId,
    branch: context.branch._id,
    action: 'po_status',
    before,
    after: {status: po.status, approvedBy: po.approvedBy, approvalNote: po.approvalNote, version: po.__v},
    user: context.userId
  }], {session});
  return populatedPurchaseOrder(PurchaseOrder.findById(po._id).session(session || null));
}
