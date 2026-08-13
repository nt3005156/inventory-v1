import {Audit} from '../models/index.js';
import {InventoryBalance, PurchaseOrder} from '../models/operations.js';
import {GoodsReceipt} from '../models/purchasing.js';
import {assertBranchAccess} from './kitchen.js';
import {canReceivePo} from './purchaseOrders.js';
import {moveStock} from './inventoryLedger.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function remainingQty(line) {
  return Math.max(0, Number(line.orderedQty || 0) - Number(line.receivedQty || 0));
}

export function acceptedQty(received, damaged) {
  return Number(received || 0) - Number(damaged || 0);
}

function validateLine(line, row) {
  const received = Number(row.receivedQty);
  const damaged = Number(row.damagedQty || 0);
  if (!(received > 0)) return null;
  if (damaged < 0) throw httpError('Damaged quantity cannot be negative', 400);
  if (damaged > received) throw httpError('Damaged quantity cannot exceed received quantity', 409);
  const remaining = remainingQty(line);
  if (received > remaining) throw httpError('Received quantity exceeds remaining ordered quantity', 409);
  return {received, damaged, accepted: acceptedQty(received, damaged), remaining};
}

export async function receivePurchaseOrder({poId, items, notes, user, session, idempotencyKey}) {
  if (idempotencyKey) {
    const prior = await GoodsReceipt.findOne({purchaseOrder: poId, idempotencyKey}).session(session || null);
    if (prior) {
      const po = await PurchaseOrder.findById(poId).populate('supplier items.ingredient').session(session || null);
      return {purchaseOrder: po, receipt: prior, duplicate: true};
    }
  }

  const po = await PurchaseOrder.findById(poId).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  assertBranchAccess(user, po.branch);
  if (po.status === 'cancelled') throw httpError('Cannot receive a cancelled purchase order', 409);
  if (!canReceivePo(po.status)) throw httpError('Purchase order must be approved before receiving', 409);

  const prepared = [];
  for (const row of items || []) {
    const line = po.items.id(row.itemId);
    if (!line) throw httpError('Invalid PO item', 400);
    const checked = validateLine(line, row);
    if (!checked) continue;
    prepared.push({row, line, ...checked});
  }
  if (!prepared.length) throw httpError('Nothing to receive', 400);

  const receipt = (await GoodsReceipt.create([{
    receiptNo: `GR-${Date.now().toString().slice(-8)}`,
    purchaseOrder: po._id,
    branch: po.branch,
    supplier: po.supplier,
    notes,
    idempotencyKey: idempotencyKey || undefined,
    receivedBy: user.id,
    items: prepared.map(p => ({
      poItem: p.line._id,
      ingredient: p.line.ingredient,
      receivedQty: p.received,
      damagedQty: p.damaged,
      acceptedQty: p.accepted,
      unit: p.line.unit,
      unitPrice: p.row.unitPrice ?? p.line.unitPrice,
      batchNumber: p.row.batchNumber,
      expiryDate: p.row.expiryDate
    }))
  }], {session: session || undefined}))[0];

  for (const p of prepared) {
    p.line.receivedQty = Number(p.line.receivedQty || 0) + p.received;
    p.line.damagedQty = Number(p.line.damagedQty || 0) + p.damaged;
    if (p.accepted > 0) {
      await moveStock({
        branch: po.branch,
        ingredient: p.line.ingredient,
        qty: p.accepted,
        unit: p.line.unit,
        unitCost: p.row.unitPrice ?? p.line.unitPrice,
        type: 'PURCHASE',
        reason: `${receipt.receiptNo} ${po.poNo}`,
        referenceType: 'goods_receipt',
        referenceId: receipt._id,
        user: user.id,
        idempotencyKey: `receipt:${receipt._id}:${p.line._id}`
      }, session);
      if (p.row.batchNumber || p.row.expiryDate) {
        const bal = await InventoryBalance.findOne({branch: po.branch, ingredient: p.line.ingredient}).session(session || null);
        if (bal) {
          if (p.row.batchNumber) bal.batchNumber = p.row.batchNumber;
          if (p.row.expiryDate) bal.expiryDate = p.row.expiryDate;
          await bal.save({session: session || undefined});
        }
      }
    }
  }

  po.status = po.items.every(x => Number(x.receivedQty || 0) >= Number(x.orderedQty || 0)) ? 'received' : 'partially_received';
  await po.save({session: session || undefined});
  await Audit.create([{
    entity: 'purchase_order',
    entityId: po._id,
    action: 'receive',
    before: {status: po.status},
    after: {receipt: receipt._id, receiptNo: receipt.receiptNo, notes},
    user: user.id
  }], {session: session || undefined});

  const fresh = await PurchaseOrder.findById(po._id).populate('supplier items.ingredient').session(session || null);
  return {purchaseOrder: fresh, receipt, duplicate: false};
}
