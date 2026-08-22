import crypto from 'node:crypto';
import {assertCapability} from './capabilities.js';
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
  // Phase 16: 'received' was terminal, so a fully delivered order could never
  // be marked commercially complete. The brief's graph ends
  // ... -> Received -> Closed. Closing is a separate, deliberate act: goods in
  // is not the same fact as invoiced, reconciled and done with.
  received: ['closed'],
  closed_short: ['closed'],
  closed: [],
  cancelled: []
};

/** Statuses from which a purchase order may be commercially closed. */
export const CLOSABLE_STATUSES = ['received', 'closed_short'];

export const RECEIVABLE_STATUSES = ['approved', 'sent', 'partially_received'];
export const REPORTABLE_PO_STATUSES = ['approved', 'sent', 'partially_received', 'received', 'closed_short', 'closed'];

export function canReceivePo(status) {
  return RECEIVABLE_STATUSES.includes(status);
}

export function canTransitionPo(from, to) {
  return (PO_TRANSITIONS[from] || []).includes(to);
}

const actorId = value => String(value?._id || value || '');

export function canDecidePurchaseOrder({role, userId, createdBy, submittedBy}) {
  if (role === 'owner') return {allowed: true, ownerOverride: actorId(createdBy) === actorId(userId) || actorId(submittedBy) === actorId(userId)};
  if (role !== 'manager') return {allowed: false, reason: 'Only owners and managers can approve purchase orders'};
  if ([createdBy, submittedBy].some(value => actorId(value) && actorId(value) === actorId(userId))) {
    return {allowed: false, reason: 'Managers cannot approve or reject a purchase order they created or submitted'};
  }
  return {allowed: true, ownerOverride: false};
}

function populatedPurchaseOrder(query) {
  return query
    .populate('branch', 'name code address phone')
    .populate('supplier', 'name contact address paymentTerms')
    .populate('items.ingredient', 'name code category unit')
    .populate('items.catalogItem', 'supplierSku purchaseUnit baseUnit')
    .populate('createdBy', 'name role')
    .populate('updatedBy', 'name role')
    .populate('submittedBy', 'name role')
    .populate('approvedBy', 'name role')
    .populate('rejectedBy', 'name role')
    .populate('shortClosedBy', 'name role');
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
  const scope = {restaurant: context.restaurantId, branch: context.branch._id};
  const match = {...scope};

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

  const [items, total, summary, pendingApprovals] = await Promise.all([
    populatedPurchaseOrder(PurchaseOrder.find(match)
      .sort({orderDate: -1, createdAt: -1, _id: -1})
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)),
    PurchaseOrder.countDocuments(match),
    PurchaseOrder.aggregate([
      {$match: match},
      {$group: {
        _id: null,
        subtotal: {$sum: '$subtotal'},
        vat: {$sum: '$vat'},
        total: {$sum: '$total'},
        open: {$sum: {$cond: [{$in: ['$status', ['draft', 'pending', 'approved', 'sent', 'partially_received']]}, 1, 0]}}
      }}
    ]),
    PurchaseOrder.countDocuments({...scope, status: 'pending'})
  ]);

  const totals = summary[0] || {subtotal: 0, vat: 0, total: 0, open: 0};
  return {
    items,
    pagination: {page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit))},
    summary: {
      subtotal: money(totals.subtotal),
      vat: money(totals.vat),
      total: money(totals.total),
      open: totals.open || 0,
      pendingApprovals
    }
  };
}

export async function getPurchaseOrder({poId, user, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const po = await PurchaseOrder.findById(poId).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  await purchaseBranchContext({user, branchId: po.branch, session, allowInactive: true});
  return populatedPurchaseOrder(PurchaseOrder.findById(po._id).session(session || null));
}

export async function getPurchaseOrderApprovalHistory({poId, user}) {
  const po = await getPurchaseOrder({poId, user});
  const rows = await Audit.find({
    entity: 'purchase_order',
    entityId: po._id,
    restaurant: po.restaurant,
    branch: po.branch?._id || po.branch,
    action: 'po_status',
    'after.status': {$in: ['pending', 'approved', 'rejected']}
  }).sort({at: 1, _id: 1}).populate('user', 'name role').lean();
  return rows.map(row => ({
    id: String(row._id),
    status: row.after?.status,
    previousStatus: row.before?.status,
    actor: row.user ? {_id: String(row.user._id), name: row.user.name, role: row.user.role} : null,
    at: row.at,
    note: row.after?.rejectionReason || row.after?.approvalNote || row.after?.submissionNote || row.reason || '',
    approvalRound: Number(row.after?.approvalRound || 0),
    version: row.after?.version
  }));
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


export async function createPurchaseOrder({input, user, principal, requestKey, session}) {
  const context = await purchaseBranchContext({user, branchId: input.branch, session});
  assertCapability(user, principal, 'purchase.create');
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

export async function updatePurchaseOrder({poId, input, expectedVersion, user, principal, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const current = await PurchaseOrder.findById(poId).session(session || null).lean();
  if (!current) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: current.branch, session, allowInactive: true});
  assertCapability(user, principal, 'purchase.create');
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

function approvalAuditView(po) {
  return {
    status: po.status,
    submittedBy: po.submittedBy,
    submittedAt: po.submittedAt,
    submissionNote: po.submissionNote,
    approvalRound: Number(po.approvalRound || 0),
    approvedBy: po.approvedBy,
    approvedAt: po.approvedAt,
    approvalNote: po.approvalNote,
    rejectedBy: po.rejectedBy,
    rejectedAt: po.rejectedAt,
    rejectionReason: po.rejectionReason,
    version: po.__v
  };
}

export async function transitionPurchaseOrder({poId, status, notes, expectedVersion, user, principal, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  if (!status) throw httpError('Status is required', 400);
  const po = await PurchaseOrder.findById(poId).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: po.branch, session, allowInactive: true});
  assertCapability(user, principal, 'purchase.approve');
  if (expectedVersion !== undefined && Number(expectedVersion) !== po.__v) {
    throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
  }
  if (!canTransitionPo(po.status, status)) {
    throw httpError(`Invalid purchase order transition from ${po.status} to ${status}`, 409);
  }
  const note = clean(notes);
  const isDecision = status === 'approved' || status === 'rejected';
  const decision = isDecision
    ? canDecidePurchaseOrder({role: context.role, userId: context.userId, createdBy: po.createdBy, submittedBy: po.submittedBy})
    : null;
  if (decision && !decision.allowed) throw httpError(decision.reason, 403);
  if (status === 'rejected' && note.length < 3) throw httpError('Rejection reason must be at least 3 characters', 400);
  if (status === 'cancelled') {
    const received = (po.items || []).some(item => Number(item.receivedQty || 0) > 0);
    if (received) throw httpError('Cannot cancel a purchase order that has receipts', 409);
  }
  // Phase 16: closing is a commercial act, not a receiving one. It is refused
  // while the supplier's invoice is still unpaid, so an order cannot be filed
  // away with money still owed against it.
  if (status === 'closed') {
    const {SupplierInvoice} = await import('../models/operations.js');
    const openInvoice = await SupplierInvoice.findOne({
      restaurant: context.restaurantId,
      purchaseOrder: po._id,
      status: {$in: ['unpaid', 'partially_paid', 'partial']}
    }).select('invoiceNo total paidAmount').session(session || null).lean();
    if (openInvoice) {
      throw httpError(
        `Invoice ${openInvoice.invoiceNo} is still outstanding on this order; settle or void it before closing`,
        409
      );
    }
  }

  const before = approvalAuditView(po);
  const now = new Date();
  po.status = status;
  po.updatedBy = context.userId;
  if (status === 'pending') {
    po.submittedBy = context.userId;
    po.submittedAt = now;
    po.submissionNote = note || undefined;
    po.approvalRound = Number(po.approvalRound || 0) + 1;
    po.approvedBy = undefined;
    po.approvedAt = undefined;
    po.approvalNote = undefined;
    po.rejectedBy = undefined;
    po.rejectedAt = undefined;
    po.rejectionReason = undefined;
  } else if (status === 'approved') {
    po.approvedBy = context.userId;
    po.approvedAt = now;
    po.approvalNote = note || undefined;
    po.rejectedBy = undefined;
    po.rejectedAt = undefined;
    po.rejectionReason = undefined;
  } else if (status === 'rejected') {
    po.approvedBy = undefined;
    po.approvedAt = undefined;
    po.approvalNote = undefined;
    po.rejectedBy = context.userId;
    po.rejectedAt = now;
    po.rejectionReason = note;
  } else if (status === 'closed') {
    po.closedBy = context.userId;
    po.closedAt = now;
    po.closeNote = note || undefined;
  }
  try {
    await po.save({session});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
    throw error;
  }
  const after = approvalAuditView(po);
  if (decision?.ownerOverride) after.ownerOverride = true;
  await Audit.create([{
    entity: 'purchase_order',
    entityId: po._id,
    restaurant: context.restaurantId,
    branch: context.branch._id,
    action: 'po_status',
    before,
    after,
    reason: (status === 'rejected' || status === 'cancelled') ? note : undefined,
    user: context.userId
  }], {session});
  return populatedPurchaseOrder(PurchaseOrder.findById(po._id).session(session || null));
}

function shortCloseFingerprint({poId, reason}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    purchaseOrder: String(poId),
    reason: clean(reason)
  })).digest('hex');
}

async function findShortCloseReplay({poId, reason, idempotencyKey, identity, session}) {
  const requestHash = shortCloseFingerprint({poId, reason});
  const prior = await PurchaseOrder.findOne({
    restaurant: identity.restaurantId,
    shortCloseIdempotencyKey: idempotencyKey
  }).select('+shortCloseRequestHash').session(session || null);
  if (!prior) return null;
  if (String(prior._id) !== String(poId) || prior.shortCloseRequestHash !== requestHash || prior.status !== 'closed_short') {
    throw httpError('Idempotency key was already used for a different short-close request', 409);
  }
  return populatedPurchaseOrder(PurchaseOrder.findById(prior._id).session(session || null));
}

export async function replayShortClosePurchaseOrder({poId, reason, user, principal, idempotencyKey, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  const identity = await userRestaurantContext(user, {session});
  assertCapability(user, principal, 'purchase.approve', 'Only owners and managers can close a partial purchase order');
  const target = await PurchaseOrder.findOne({_id: poId, restaurant: identity.restaurantId}).select('branch').session(session || null);
  if (!target) throw httpError('Purchase order not found', 404);
  await purchaseBranchContext({user, branchId: target.branch, session, allowInactive: true});
  const replay = await findShortCloseReplay({poId, reason, idempotencyKey: key, identity, session});
  if (!replay) throw httpError('Short-close request could not be replayed; retry with a new key', 409);
  return replay;
}

export async function closeShortPurchaseOrder({poId, reason, expectedVersion, user, principal, session, idempotencyKey}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  if (key.length > 120) throw httpError('Idempotency-Key must be 120 characters or fewer', 400);
  const identity = await userRestaurantContext(user, {session});
  assertCapability(user, principal, 'purchase.approve', 'Only owners and managers can close a partial purchase order');
  const po = await PurchaseOrder.findOne({_id: poId, restaurant: identity.restaurantId}).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: po.branch, session, allowInactive: true});
  const replay = await findShortCloseReplay({poId, reason, idempotencyKey: key, identity, session});
  if (replay) return {purchaseOrder: replay, duplicate: true};
  if (po.status !== 'partially_received') throw httpError('Only a partially received purchase order can be closed short', 409);
  if (Number(expectedVersion) !== Number(po.__v)) {
    throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
  }
  const explanation = clean(reason);
  if (explanation.length < 3) throw httpError('Short-close reason must be at least 3 characters', 400);

  const outstanding = (po.items || []).map(line => ({
    poItem: line._id,
    ingredient: line.ingredient,
    orderedQty: Number(line.orderedQty || 0),
    receivedQty: Number(line.receivedQty || 0),
    shortQty: Math.max(0, Number(line.orderedQty || 0) - Number(line.receivedQty || 0)),
    unit: line.unit
  })).filter(line => line.shortQty > 1e-9);
  if (!outstanding.length) throw httpError('Purchase order has no outstanding quantity to close', 409);
  if (!(po.items || []).some(line => Number(line.receivedQty || 0) > 0)) {
    throw httpError('A purchase order must have a receipt before it can be closed short', 409);
  }

  const before = {status: po.status, version: po.__v, outstanding};
  const closedAt = new Date();
  po.status = 'closed_short';
  po.shortClosedBy = context.userId;
  po.shortClosedAt = closedAt;
  po.shortCloseReason = explanation;
  po.shortCloseIdempotencyKey = key;
  po.shortCloseRequestHash = shortCloseFingerprint({poId, reason: explanation});
  po.updatedBy = context.userId;
  try {
    await po.save({session: session || undefined});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Purchase order changed since it was loaded; refresh and try again', 409);
    throw error;
  }

  await Audit.create([{
    entity: 'purchase_order',
    entityId: po._id,
    restaurant: context.restaurantId,
    branch: context.branch._id,
    action: 'po_short_close',
    before,
    after: {
      status: po.status,
      version: po.__v,
      shortClosedAt: closedAt,
      shortClosedBy: context.userId,
      shortCloseReason: explanation,
      outstanding
    },
    reason: explanation,
    user: context.userId
  }], {session: session || undefined});

  return {
    purchaseOrder: await populatedPurchaseOrder(PurchaseOrder.findById(po._id).session(session || null)),
    duplicate: false
  };
}
