import crypto from 'node:crypto';
import {hasCapability} from './capabilities.js';
import mongoose from 'mongoose';
import {Audit, Ingredient, Supplier} from '../models/index.js';
import {InventoryBatch, PurchaseOrder} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn, PurchaseReturnCounter} from '../models/purchasing.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {acceptedQty} from './receiving.js';
import {moveStock} from './inventoryLedger.js';
import {expiryState, normalizeBatchNumber} from './inventoryBatches.js';
import {userRestaurantContext} from './supplierCatalog.js';

const EPSILON = 1e-9;
export const PURCHASE_RETURN_REASONS = Object.freeze(['quality', 'wrong_item', 'expired', 'overstock', 'damaged', 'other']);

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = value => String(value || '').trim();
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function returnableQty(line) {
  return Math.max(0, acceptedQty(line.receivedQty, line.damagedQty) - Number(line.returnedQty || 0));
}

function canonicalReturnRequest({poId, items, reason, notes}) {
  return {
    purchaseOrder: String(poId || ''),
    reason: clean(reason) || 'quality',
    notes: clean(notes),
    items: (items || []).map(row => ({
      itemId: String(row.itemId || ''),
      qty: Number(row.qty),
      batchId: String(row.batchId || ''),
      batchNumber: normalizeBatchNumber(row.batchNumber)
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  };
}

export function purchaseReturnRequestFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalReturnRequest(input))).digest('hex');
}

function populatedPurchaseOrder(poId, session) {
  return PurchaseOrder.findById(poId)
    .populate('branch', 'name code address phone')
    .populate('supplier', 'name contact address paymentTerms')
    .populate('items.ingredient', 'name code category unit')
    .populate('updatedBy', 'name role')
    .session(session || null);
}

function populatedPurchaseReturn(returnId, session) {
  return PurchaseReturn.findById(returnId)
    .populate('items.ingredient', 'name code category unit')
    .populate('items.goodsReceipt', 'receiptNo receivedAt')
    .populate('returnedBy', 'name role')
    .session(session || null);
}

async function returnContext({poId, user, principal, session, requireManager = false}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const identity = await userRestaurantContext(user, {session});
  if (requireManager && !hasCapability(user, principal, 'purchase.return')) {
    throw httpError('Only owners and managers can post purchase returns', 403);
  }
  const po = await PurchaseOrder.findOne({_id: poId, restaurant: identity.restaurantId}).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: po.branch, session, allowInactive: !requireManager});

  const ingredientIds = [...new Set((po.items || []).map(line => String(line.ingredient || '')).filter(Boolean))];
  const [supplierExists, ingredientCount] = await Promise.all([
    Supplier.exists({_id: po.supplier, restaurant: context.restaurantId}).session(session || null),
    Ingredient.countDocuments({_id: {$in: ingredientIds}, restaurant: context.restaurantId}).session(session || null)
  ]);
  if (!supplierExists) throw httpError('Purchase order supplier does not belong to the restaurant', 409);
  if (ingredientCount !== ingredientIds.length) throw httpError('Purchase order ingredient does not belong to the restaurant', 409);
  return {po, context};
}

function batchSort(left, right) {
  const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.POSITIVE_INFINITY;
  const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  const received = new Date(left.receivedAt || left.createdAt).getTime() - new Date(right.receivedAt || right.createdAt).getTime();
  return received || String(left._id).localeCompare(String(right._id));
}

function receiptLineForBatch(batch, receipt, po) {
  const receiptItems = receipt?.items || [];
  if (batch.sourceLine) {
    const line = po.items.id(batch.sourceLine);
    const receiptMatch = receiptItems.some(item =>
      String(item.poItem) === String(batch.sourceLine)
      && String(item.ingredient) === String(batch.ingredient)
    );
    if (line && String(line.ingredient) === String(batch.ingredient) && receiptMatch) return String(batch.sourceLine);
    return '';
  }
  const matches = receiptItems.filter(item => {
    const line = po.items.id(item.poItem);
    return line
      && String(item.ingredient) === String(batch.ingredient)
      && String(line.ingredient) === String(batch.ingredient);
  });
  return matches.length === 1 ? String(matches[0].poItem) : '';
}

async function loadReturnAllocationState({po, context, session}) {
  const receipts = await GoodsReceipt.find({
    restaurant: context.restaurantId,
    branch: po.branch,
    purchaseOrder: po._id
  }).session(session || null).lean();
  const receiptById = new Map(receipts.map(receipt => [String(receipt._id), receipt]));
  const receiptIds = receipts.map(receipt => receipt._id);
  const linkedBatches = receiptIds.length ? await InventoryBatch.find({
    restaurant: context.restaurantId,
    branch: po.branch,
    sourceType: 'goods_receipt',
    sourceId: {$in: receiptIds}
  }).session(session || null).lean() : [];

  const linkedByLine = new Map();
  for (const batch of linkedBatches) {
    const receipt = receiptById.get(String(batch.sourceId));
    const lineId = receiptLineForBatch(batch, receipt, po);
    if (!lineId) continue;
    if (!linkedByLine.has(lineId)) linkedByLine.set(lineId, []);
    linkedByLine.get(lineId).push({...batch, goodsReceipt: receipt?._id, receiptNo: receipt?.receiptNo});
  }

  const result = new Map();
  for (const line of po.items || []) {
    const lineId = String(line._id);
    const linked = linkedByLine.get(lineId) || [];
    const receiptRows = receipts.filter(receipt => (receipt.items || []).some(item => String(item.poItem) === lineId));
    const durableProvenance = linked.length > 0 || receiptRows.some(receipt => Number(receipt.numberVersion || 0) >= 2);
    let candidates;
    let allocationSource;
    if (durableProvenance) {
      candidates = linked;
      allocationSource = 'receipt_batch';
    } else {
      candidates = await InventoryBatch.find({
        restaurant: context.restaurantId,
        branch: po.branch,
        ingredient: line.ingredient
      }).session(session || null).lean();
      allocationSource = 'legacy_allocation';
    }
    const lineUnit = clean(line.unit).toLowerCase();
    candidates = candidates
      .filter(batch => Number(batch.quantity || 0) > EPSILON)
      .filter(batch => !clean(batch.unit) || clean(batch.unit).toLowerCase() === lineUnit)
      .map(batch => ({...batch, allocationSource}))
      .sort(batchSort);
    result.set(lineId, {
      line,
      candidates,
      allocationSource,
      returnable: returnableQty(line),
      durableProvenance
    });
  }
  return result;
}

export async function listPurchaseReturnOptions({poId, user, session}) {
  const {po, context} = await returnContext({poId, user, session});
  const state = await loadReturnAllocationState({po, context, session});
  const items = (po.items || []).map(line => {
    const row = state.get(String(line._id));
    const availableQty = row.candidates.reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
    return {
      poItem: line._id,
      ingredient: line.ingredient,
      acceptedQty: acceptedQty(line.receivedQty, line.damagedQty),
      returnedQty: Number(line.returnedQty || 0),
      returnableQty: row.returnable,
      availableQty,
      allocationSource: row.allocationSource,
      batches: row.candidates.map(batch => ({
        batchId: batch._id,
        goodsReceipt: batch.goodsReceipt || undefined,
        receiptNo: batch.receiptNo || undefined,
        batchNumber: batch.batchNumber || undefined,
        expiryDate: batch.expiryDate || undefined,
        expiryStatus: expiryState(batch.expiryDate, {quantity: batch.quantity}),
        receivedAt: batch.receivedAt,
        availableQty: Number(batch.quantity || 0),
        unitCost: Number(batch.unitCost || line.unitPrice || 0),
        unit: batch.unit || line.unit,
        allocationSource: row.allocationSource
      }))
    };
  });
  return {
    purchaseOrder: po._id,
    items,
    summary: {
      returnableQty: items.reduce((sum, item) => sum + item.returnableQty, 0),
      availableQty: items.reduce((sum, item) => sum + Math.min(item.returnableQty, item.availableQty), 0),
      legacyLines: items.filter(item => item.allocationSource === 'legacy_allocation' && item.returnableQty > 0).length
    }
  };
}

async function findReturnReplay({po, context, idempotencyKey, requestHash, session}) {
  const prior = await PurchaseReturn.findOne({restaurant: context.restaurantId, idempotencyKey})
    .select('+requestHash')
    .session(session || null);
  if (!prior) return null;
  if (String(prior.purchaseOrder) !== String(po._id) || !prior.requestHash || prior.requestHash !== requestHash) {
    throw httpError('Idempotency key was already used for a different purchase return', 409);
  }
  const [purchaseOrder, purchaseReturn] = await Promise.all([
    populatedPurchaseOrder(po._id, session),
    populatedPurchaseReturn(prior._id, session)
  ]);
  return {purchaseOrder, purchaseReturn, duplicate: true};
}

export async function replayPurchaseReturn({poId, items, reason, notes, user, principal, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  const {po, context} = await returnContext({poId, user, principal, session, requireManager: true});
  const requestHash = purchaseReturnRequestFingerprint({poId, items, reason, notes});
  const replay = await findReturnReplay({po, context, idempotencyKey: key, requestHash, session});
  if (!replay) throw httpError('Purchase return could not be replayed; retry with a new key', 409);
  return replay;
}

async function nextPurchaseReturnNumber({restaurantId, branch, returnedAt, session}) {
  const year = Number(new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'Asia/Kathmandu'}).format(returnedAt));
  const branchCode = clean(branch.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch._id).slice(-4).toUpperCase();
  const counter = await PurchaseReturnCounter.findOneAndUpdate(
    {restaurant: restaurantId, branchCode, year},
    {$inc: {value: 1}, $setOnInsert: {restaurant: restaurantId, branch: branch._id, branchCode, year}},
    {upsert: true, new: true, session, setDefaultsOnInsert: true}
  );
  return `PR-${branchCode}-${year}-${String(counter.value).padStart(6, '0')}`;
}

function prepareAllocations({po, items, state}) {
  const rows = items || [];
  if (!rows.length) throw httpError('Nothing to return', 400);
  const identities = new Set();
  const requestedByLine = new Map();
  for (const row of rows) {
    if (!mongoose.isValidObjectId(row.itemId)) throw httpError('Invalid PO item', 400);
    const line = po.items.id(row.itemId);
    if (!line) throw httpError('Invalid PO item', 400);
    const qty = Number(row.qty);
    if (!Number.isFinite(qty) || !(qty > EPSILON)) throw httpError('Return quantity must be positive', 400);
    if (row.batchId && !mongoose.isValidObjectId(row.batchId)) throw httpError('Invalid inventory batch', 400);
    const selector = row.batchId ? `id:${row.batchId}` : row.batchNumber ? `number:${normalizeBatchNumber(row.batchNumber)}` : 'auto';
    const identity = `${row.itemId}:${selector}`;
    if (identities.has(identity)) throw httpError('Each purchase order line and batch selection can appear only once per return', 400);
    identities.add(identity);
    requestedByLine.set(String(line._id), Number(requestedByLine.get(String(line._id)) || 0) + qty);
  }
  for (const [lineId, qty] of requestedByLine) {
    const available = state.get(lineId)?.returnable || 0;
    if (qty > available + EPSILON) throw httpError('Return quantity exceeds returnable accepted stock', 409);
  }

  const batchRemaining = new Map();
  for (const row of state.values()) {
    for (const batch of row.candidates) batchRemaining.set(String(batch._id), Number(batch.quantity || 0));
  }
  const allocations = [];
  for (const row of rows) {
    const lineState = state.get(String(row.itemId));
    let candidates = lineState.candidates;
    if (row.batchId) candidates = candidates.filter(batch => String(batch._id) === String(row.batchId));
    else if (row.batchNumber) {
      const normalized = normalizeBatchNumber(row.batchNumber);
      candidates = candidates.filter(batch => normalizeBatchNumber(batch.batchNumber) === normalized);
    }
    if (!candidates.length) {
      throw httpError(lineState.durableProvenance
        ? 'Selected stock is not available from this purchase order receipt'
        : 'Selected stock is not available for the legacy return allocation', 409);
    }

    let remaining = Number(row.qty);
    for (const batch of candidates) {
      if (!(remaining > EPSILON)) break;
      const available = Number(batchRemaining.get(String(batch._id)) || 0);
      const qty = Math.min(available, remaining);
      if (!(qty > EPSILON)) continue;
      batchRemaining.set(String(batch._id), available - qty);
      const supplierUnitCost = Number(lineState.line.unitPrice || 0);
      const inventoryUnitCost = Number(batch.unitCost ?? supplierUnitCost);
      const vatRate = Number(lineState.line.vatRate ?? 13);
      const subtotal = money(qty * supplierUnitCost);
      const vat = money(subtotal * vatRate / 100);
      allocations.push({
        line: lineState.line,
        batch,
        qty,
        goodsReceipt: batch.goodsReceipt,
        allocationSource: batch.allocationSource,
        unitCost: supplierUnitCost,
        inventoryUnitCost,
        stockValue: money(qty * inventoryUnitCost),
        vatRate,
        subtotal,
        vat,
        total: money(subtotal + vat)
      });
      remaining -= qty;
    }
    if (remaining > EPSILON) {
      throw httpError(lineState.durableProvenance
        ? 'Insufficient available stock from this purchase order receipt'
        : 'Insufficient inventory for the legacy return allocation', 409);
    }
  }
  return {allocations, requestedByLine};
}

export async function listPurchaseReturns({poId, user, session}) {
  const {po, context} = await returnContext({poId, user, session});
  return PurchaseReturn.find({
    restaurant: context.restaurantId,
    branch: po.branch,
    purchaseOrder: po._id
  })
    .sort({returnedAt: -1, _id: -1})
    .populate('items.ingredient', 'name code category unit')
    .populate('items.goodsReceipt', 'receiptNo receivedAt')
    .populate('returnedBy', 'name role')
    .session(session || null);
}

export async function returnPurchaseOrder({poId, items, reason, notes, expectedVersion, user, principal, session, idempotencyKey}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  if (key.length > 120) throw httpError('Idempotency-Key must be 120 characters or fewer', 400);
  const normalizedReason = clean(reason) || 'quality';
  if (!PURCHASE_RETURN_REASONS.includes(normalizedReason)) throw httpError('Invalid purchase return reason', 400);
  const normalizedNotes = clean(notes);
  if (normalizedReason === 'other' && normalizedNotes.length < 3) {
    throw httpError('Return notes of at least 3 characters are required when the reason is other', 400);
  }

  const {po, context} = await returnContext({poId, user, principal, session, requireManager: true});
  const requestHash = purchaseReturnRequestFingerprint({poId, items, reason: normalizedReason, notes: normalizedNotes});
  const replay = await findReturnReplay({po, context, idempotencyKey: key, requestHash, session});
  if (replay) return replay;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw httpError('A nonnegative integer expectedVersion is required', 400);
  }
  if (expectedVersion !== Number(po.__v)) {
    throw httpError('Purchase order changed; refresh before returning stock', 409);
  }
  if (po.status === 'cancelled') throw httpError('Cannot return against a cancelled purchase order', 409);

  const allocationState = await loadReturnAllocationState({po, context, session});
  const {allocations, requestedByLine} = prepareAllocations({po, items, state: allocationState});
  const returnedAt = new Date();
  const returnNo = await nextPurchaseReturnNumber({
    restaurantId: context.restaurantId,
    branch: context.branch,
    returnedAt,
    session
  });
  const subtotal = money(allocations.reduce((sum, item) => sum + item.subtotal, 0));
  const vat = money(allocations.reduce((sum, item) => sum + item.vat, 0));
  const total = money(subtotal + vat);

  const purchaseReturn = (await PurchaseReturn.create([{
    restaurant: context.restaurantId,
    returnNo,
    numberVersion: 2,
    purchaseOrder: po._id,
    branch: po.branch,
    supplier: po.supplier,
    returnedAt,
    reason: normalizedReason,
    notes: normalizedNotes || undefined,
    status: 'posted',
    idempotencyKey: key,
    requestHash,
    requestHashVersion: 2,
    returnedBy: context.userId,
    subtotal,
    vat,
    total,
    items: allocations.map(item => ({
      poItem: item.line._id,
      ingredient: item.line.ingredient,
      goodsReceipt: item.goodsReceipt,
      inventoryBatch: item.batch._id,
      allocationSource: item.allocationSource,
      qty: item.qty,
      unit: item.line.unit,
      unitCost: item.unitCost,
      inventoryUnitCost: item.inventoryUnitCost,
      stockValue: item.stockValue,
      vatRate: item.vatRate,
      subtotal: item.subtotal,
      vat: item.vat,
      total: item.total,
      batchNumber: item.batch.batchNumber,
      expiryDate: item.batch.expiryDate
    }))
  }], {session: session || undefined}))[0];

  const before = {
    status: po.status,
    version: po.__v,
    lines: [...requestedByLine.keys()].map(lineId => {
      const line = po.items.id(lineId);
      return {poItem: line._id, returnedQty: Number(line.returnedQty || 0), returnableQty: returnableQty(line)};
    }),
    batches: allocations.map(item => ({inventoryBatch: item.batch._id, quantity: Number(item.batch.quantity || 0)}))
  };

  const ledgerTransactions = [];
  for (let index = 0; index < allocations.length; index += 1) {
    const item = allocations[index];
    const returnLine = purchaseReturn.items[index];
    ledgerTransactions.push(await moveStock({
      branch: po.branch,
      ingredient: item.line.ingredient,
      qty: -item.qty,
      unit: item.line.unit,
      unitCost: item.inventoryUnitCost,
      type: 'RETURN',
      reason: `${purchaseReturn.returnNo} ${po.poNo}: ${normalizedReason}`,
      referenceType: 'purchase_return',
      referenceId: purchaseReturn._id,
      user: context.userId,
      idempotencyKey: `return:${purchaseReturn._id}:${returnLine._id}`,
      batchId: item.batch._id,
      allowExpired: true
    }, session));
  }

  for (const [lineId, qty] of requestedByLine) {
    const line = po.items.id(lineId);
    line.returnedQty = Number(line.returnedQty || 0) + qty;
  }
  po.updatedBy = context.userId;
  try {
    await po.save({session: session || undefined});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Purchase order changed; refresh before returning stock', 409);
    throw error;
  }

  await Audit.create([{
    entity: 'purchase_return',
    entityId: purchaseReturn._id,
    restaurant: context.restaurantId,
    branch: po.branch,
    action: 'post',
    before,
    after: {
      purchaseOrder: po._id,
      returnNo: purchaseReturn.returnNo,
      status: purchaseReturn.status,
      reason: normalizedReason,
      subtotal,
      vat,
      total,
      version: po.__v,
      lines: purchaseReturn.items.map(item => ({
        poItem: item.poItem,
        inventoryBatch: item.inventoryBatch,
        goodsReceipt: item.goodsReceipt,
        allocationSource: item.allocationSource,
        qty: item.qty,
        stockValue: item.stockValue
      })),
      inventoryTransactions: ledgerTransactions.map(transaction => transaction._id)
    },
    reason: normalizedNotes || normalizedReason,
    user: context.userId
  }], {session: session || undefined});

  const [freshPo, freshReturn] = await Promise.all([
    populatedPurchaseOrder(po._id, session),
    populatedPurchaseReturn(purchaseReturn._id, session)
  ]);
  return {purchaseOrder: freshPo, purchaseReturn: freshReturn, duplicate: false};
}
