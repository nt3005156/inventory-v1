import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Audit, Ingredient, Supplier} from '../models/index.js';
import {InventoryBalance, PurchaseOrder} from '../models/operations.js';
import {GoodsReceipt, GoodsReceiptCounter} from '../models/purchasing.js';
import {canReceivePo, purchaseBranchContext} from './purchaseOrders.js';
import {moveStock} from './inventoryLedger.js';
import {userRestaurantContext} from './supplierCatalog.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = value => String(value || '').trim();
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const RECEIPT_DAMAGE_REASONS = Object.freeze([
  'transport_damage',
  'packaging_damage',
  'temperature_abuse',
  'spoiled',
  'expired',
  'quality',
  'wrong_item',
  'other'
]);
export const LEGACY_DAMAGE_REASON = 'legacy_unspecified';
export const DAMAGE_DISPOSITION = 'rejected_at_receiving';

export function remainingQty(line) {
  return Math.max(0, Number(line.orderedQty || 0) - Number(line.receivedQty || 0));
}

export function acceptedQty(received, damaged) {
  return Number(received || 0) - Number(damaged || 0);
}

function canonicalExpiryDate(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? clean(value) : date.toISOString().slice(0, 10);
}

function canonicalReceiptRequest({poId, items, notes}) {
  return {
    purchaseOrder: String(poId),
    notes: clean(notes),
    items: (items || []).map(row => {
      const damagedQty = Number(row.damagedQty || 0);
      return {
        itemId: String(row.itemId || ''),
        receivedQty: Number(row.receivedQty),
        damagedQty,
        damageReason: damagedQty > 0 ? (clean(row.damageReason) || LEGACY_DAMAGE_REASON) : clean(row.damageReason),
        damageDisposition: damagedQty > 0 ? DAMAGE_DISPOSITION : clean(row.damageDisposition),
        damageNotes: clean(row.damageNotes),
        batchNumber: clean(row.batchNumber),
        expiryDate: canonicalExpiryDate(row.expiryDate)
      };
    }).sort((a, b) => a.itemId.localeCompare(b.itemId))
  };
}

export function receiptRequestFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalReceiptRequest(input))).digest('hex');
}

function validateLine(line, row) {
  const received = Number(row.receivedQty);
  const damaged = Number(row.damagedQty || 0);
  const damageReason = clean(row.damageReason);
  const damageNotes = clean(row.damageNotes);
  if (!Number.isFinite(received) || !(received > 0)) throw httpError('Received quantity must be positive', 400);
  if (!Number.isFinite(damaged) || damaged < 0) throw httpError('Damaged quantity cannot be negative', 400);
  if (damaged > received) throw httpError('Damaged quantity cannot exceed received quantity', 409);
  if (damaged > 0 && !RECEIPT_DAMAGE_REASONS.includes(damageReason)) {
    throw httpError('A valid damage reason is required when damaged quantity is recorded', 400);
  }
  if (damaged > 0 && damageReason === 'other' && damageNotes.length < 3) {
    throw httpError('Damage notes of at least 3 characters are required when the reason is other', 400);
  }
  if (damaged === 0 && (damageReason || damageNotes || row.damageDisposition)) {
    throw httpError('Damage details require a damaged quantity', 400);
  }
  const remaining = remainingQty(line);
  if (received > remaining) throw httpError('Received quantity exceeds remaining ordered quantity', 409);
  const unitCost = Number(line.unitPrice);
  if (!Number.isFinite(unitCost) || unitCost < 0) throw httpError('Purchase order line has an invalid unit cost', 409);
  return {
    received,
    damaged,
    accepted: acceptedQty(received, damaged),
    remaining,
    unitCost,
    damageReason: damaged > 0 ? damageReason : undefined,
    damageDisposition: damaged > 0 ? DAMAGE_DISPOSITION : undefined,
    damageNotes: damaged > 0 && damageNotes ? damageNotes : undefined
  };
}

async function populatedPurchaseOrder(poId, session) {
  return PurchaseOrder.findById(poId)
    .populate('branch', 'name code address phone')
    .populate('supplier', 'name contact address paymentTerms')
    .populate('items.ingredient', 'name code category unit')
    .populate('shortClosedBy', 'name role')
    .session(session || null);
}

async function nextGoodsReceiptNumber({restaurantId, branch, receivedAt, session}) {
  const year = Number(new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'Asia/Kathmandu'}).format(receivedAt));
  const branchCode = clean(branch.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch._id).slice(-4).toUpperCase();
  const counter = await GoodsReceiptCounter.findOneAndUpdate(
    {restaurant: restaurantId, branchCode, year},
    {$inc: {value: 1}, $setOnInsert: {restaurant: restaurantId, branch: branch._id, branchCode, year}},
    {upsert: true, new: true, session, setDefaultsOnInsert: true}
  );
  return `GR-${branchCode}-${year}-${String(counter.value).padStart(6, '0')}`;
}

function beforeReceiptView(po, prepared) {
  return {
    status: po.status,
    version: po.__v,
    lines: prepared.map(item => ({
      poItem: item.line._id,
      receivedQty: Number(item.line.receivedQty || 0),
      damagedQty: Number(item.line.damagedQty || 0),
      remainingQty: item.remaining
    }))
  };
}

async function receiptContext({poId, user, session}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  const identity = await userRestaurantContext(user, {session});
  if (!['owner', 'manager'].includes(identity.role)) throw httpError('Only owners and managers can receive purchase orders', 403);
  const po = await PurchaseOrder.findOne({_id: poId, restaurant: identity.restaurantId}).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: po.branch, session});

  const ingredientIds = [...new Set((po.items || []).map(line => String(line.ingredient || '')).filter(Boolean))];
  const [supplierExists, ingredientCount] = await Promise.all([
    Supplier.exists({_id: po.supplier, restaurant: context.restaurantId}).session(session || null),
    Ingredient.countDocuments({_id: {$in: ingredientIds}, restaurant: context.restaurantId}).session(session || null)
  ]);
  if (!supplierExists) throw httpError('Purchase order supplier does not belong to the restaurant', 409);
  if (ingredientCount !== ingredientIds.length) throw httpError('Purchase order ingredient does not belong to the restaurant', 409);
  return {po, context};
}

async function findReceiptReplay({po, context, idempotencyKey, requestHash, session}) {
  const prior = await GoodsReceipt.findOne({restaurant: context.restaurantId, idempotencyKey})
    .select('+requestHash')
    .session(session || null);
  if (!prior) return null;
  if (String(prior.purchaseOrder) !== String(po._id) || !prior.requestHash || prior.requestHash !== requestHash) {
    throw httpError('Idempotency key was already used for a different receiving request', 409);
  }
  const purchaseOrder = await populatedPurchaseOrder(po._id, session);
  return {purchaseOrder, receipt: prior, duplicate: true};
}

export async function replayGoodsReceipt({poId, items, notes, user, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  const {po, context} = await receiptContext({poId, user, session});
  const requestHash = receiptRequestFingerprint({poId, items, notes});
  const replay = await findReceiptReplay({po, context, idempotencyKey: key, requestHash, session});
  if (!replay) throw httpError('Receiving request could not be replayed; retry with a new key', 409);
  return replay;
}

export async function receivePurchaseOrder({poId, items, notes, expectedVersion, user, session, idempotencyKey}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  if (key.length > 120) throw httpError('Idempotency-Key must be 120 characters or fewer', 400);

  const {po, context} = await receiptContext({poId, user, session});
  const requestHash = receiptRequestFingerprint({poId, items, notes});
  const replay = await findReceiptReplay({po, context, idempotencyKey: key, requestHash, session});
  if (replay) return replay;

  if (expectedVersion !== undefined && Number(expectedVersion) !== Number(po.__v)) {
    throw httpError('Purchase order changed; refresh before receiving', 409);
  }
  if (po.status === 'cancelled') throw httpError('Cannot receive a cancelled purchase order', 409);
  if (!canReceivePo(po.status)) throw httpError('Purchase order must be approved before receiving', 409);

  const rows = items || [];
  const identities = rows.map(row => String(row.itemId || ''));
  if (new Set(identities).size !== identities.length) throw httpError('Each purchase order line can be received only once per request', 400);

  const prepared = [];
  for (const row of rows) {
    if (!mongoose.isValidObjectId(row.itemId)) throw httpError('Invalid PO item', 400);
    const line = po.items.id(row.itemId);
    if (!line) throw httpError('Invalid PO item', 400);
    prepared.push({row, line, ...validateLine(line, row)});
  }
  if (!prepared.length) throw httpError('Nothing to receive', 400);

  const before = beforeReceiptView(po, prepared);
  const receivedAt = new Date();
  const receiptNo = await nextGoodsReceiptNumber({
    restaurantId: context.restaurantId,
    branch: context.branch,
    receivedAt,
    session
  });
  const receivedValue = money(prepared.reduce((sum, item) => sum + item.received * item.unitCost, 0));
  const acceptedValue = money(prepared.reduce((sum, item) => sum + item.accepted * item.unitCost, 0));
  const damagedValue = money(prepared.reduce((sum, item) => sum + item.damaged * item.unitCost, 0));

  const receipt = (await GoodsReceipt.create([{
    restaurant: context.restaurantId,
    branch: po.branch,
    supplier: po.supplier,
    purchaseOrder: po._id,
    receiptNo,
    numberVersion: 2,
    receivedAt,
    notes: clean(notes) || undefined,
    idempotencyKey: key,
    requestHash,
    requestHashVersion: 2,
    receivedBy: context.userId,
    receivedValue,
    acceptedValue,
    damagedValue,
    items: prepared.map(item => ({
      poItem: item.line._id,
      ingredient: item.line.ingredient,
      receivedQty: item.received,
      damagedQty: item.damaged,
      acceptedQty: item.accepted,
      damageReason: item.damageReason,
      damageDisposition: item.damageDisposition,
      damageNotes: item.damageNotes,
      unit: item.line.unit,
      unitPrice: item.unitCost,
      batchNumber: clean(item.row.batchNumber) || undefined,
      expiryDate: item.row.expiryDate || undefined
    }))
  }], {session: session || undefined}))[0];

  for (const item of prepared) {
    item.line.receivedQty = Number(item.line.receivedQty || 0) + item.received;
    item.line.damagedQty = Number(item.line.damagedQty || 0) + item.damaged;
    if (item.accepted > 0) {
      await moveStock({
        branch: po.branch,
        ingredient: item.line.ingredient,
        qty: item.accepted,
        unit: item.line.unit,
        unitCost: item.unitCost,
        type: 'PURCHASE',
        reason: `${receipt.receiptNo} ${po.poNo}`,
        referenceType: 'goods_receipt',
        referenceId: receipt._id,
        user: context.userId,
        idempotencyKey: `receipt:${receipt._id}:${item.line._id}`
      }, session);
      if (item.row.batchNumber || item.row.expiryDate) {
        const balance = await InventoryBalance.findOne({branch: po.branch, ingredient: item.line.ingredient}).session(session || null);
        if (balance) {
          if (item.row.batchNumber) balance.batchNumber = clean(item.row.batchNumber);
          if (item.row.expiryDate) balance.expiryDate = item.row.expiryDate;
          await balance.save({session: session || undefined});
        }
      }
    }
  }

  po.status = po.items.every(line => Number(line.receivedQty || 0) >= Number(line.orderedQty || 0))
    ? 'received'
    : 'partially_received';
  po.updatedBy = context.userId;
  try {
    await po.save({session: session || undefined});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Purchase order changed; refresh before receiving', 409);
    throw error;
  }

  await Audit.create([{
    entity: 'purchase_order',
    entityId: po._id,
    restaurant: context.restaurantId,
    branch: po.branch,
    action: 'receive',
    before,
    after: {
      status: po.status,
      version: po.__v,
      receipt: receipt._id,
      receiptNo: receipt.receiptNo,
      receivedValue,
      acceptedValue,
      damagedValue,
      lines: prepared.map(item => ({
        poItem: item.line._id,
        receivedNow: item.received,
        damagedNow: item.damaged,
        acceptedNow: item.accepted,
        damageReason: item.damageReason,
        damageDisposition: item.damageDisposition,
        damageNotes: item.damageNotes,
        receivedQty: Number(item.line.receivedQty || 0),
        damagedQty: Number(item.line.damagedQty || 0),
        remainingQty: remainingQty(item.line)
      }))
    },
    reason: clean(notes) || undefined,
    user: context.userId
  }], {session: session || undefined});

  const fresh = await populatedPurchaseOrder(po._id, session);
  return {purchaseOrder: fresh, receipt, duplicate: false};
}
