import {Audit} from '../models/index.js';
import {PurchaseOrder} from '../models/operations.js';
import {PurchaseReturn} from '../models/purchasing.js';
import {assertBranchAccess} from './kitchen.js';
import {acceptedQty} from './receiving.js';
import {moveStock} from './inventoryLedger.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function returnableQty(line) {
  return Math.max(0, acceptedQty(line.receivedQty, line.damagedQty) - Number(line.returnedQty || 0));
}

export async function returnPurchaseOrder({poId, items, reason, notes, user, session, idempotencyKey}) {
  if (idempotencyKey) {
    const prior = await PurchaseReturn.findOne({purchaseOrder: poId, idempotencyKey}).session(session || null);
    if (prior) {
      const po = await PurchaseOrder.findById(poId).populate('supplier items.ingredient').session(session || null);
      return {purchaseOrder: po, purchaseReturn: prior, duplicate: true};
    }
  }

  const po = await PurchaseOrder.findById(poId).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  assertBranchAccess(user, po.branch);
  if (po.status === 'cancelled') throw httpError('Cannot return against a cancelled purchase order', 409);

  const prepared = [];
  for (const row of items || []) {
    const line = po.items.id(row.itemId);
    if (!line) throw httpError('Invalid PO item', 400);
    const qty = Number(row.qty);
    if (!(qty > 0)) continue;
    const available = returnableQty(line);
    if (qty > available) throw httpError('Return quantity exceeds returnable accepted stock', 409);
    prepared.push({row, line, qty, available});
  }
  if (!prepared.length) throw httpError('Nothing to return', 400);

  const purchaseReturn = (await PurchaseReturn.create([{
    returnNo: `PR-${Date.now().toString().slice(-8)}`,
    purchaseOrder: po._id,
    branch: po.branch,
    supplier: po.supplier,
    reason: reason || 'quality',
    notes,
    idempotencyKey: idempotencyKey || undefined,
    returnedBy: user.id,
    items: prepared.map(p => ({
      poItem: p.line._id,
      ingredient: p.line.ingredient,
      qty: p.qty,
      unit: p.line.unit,
      unitCost: p.row.unitPrice ?? p.line.unitPrice,
      batchNumber: p.row.batchNumber
    }))
  }], {session: session || undefined}))[0];

  for (const p of prepared) {
    p.line.returnedQty = Number(p.line.returnedQty || 0) + p.qty;
    await moveStock({
      branch: po.branch,
      ingredient: p.line.ingredient,
      qty: -p.qty,
      unit: p.line.unit,
      unitCost: p.row.unitPrice ?? p.line.unitPrice,
      type: 'RETURN',
      reason: `${purchaseReturn.returnNo} ${po.poNo}: ${reason || 'quality'}`,
      referenceType: 'purchase_return',
      referenceId: purchaseReturn._id,
      user: user.id,
      idempotencyKey: `return:${purchaseReturn._id}:${p.line._id}`,
      batchNumber: p.row.batchNumber || undefined,
      allowExpired: true
    }, session);
  }

  await po.save({session: session || undefined});
  await Audit.create([{
    entity: 'purchase_order',
    entityId: po._id,
    action: 'return',
    before: {status: po.status},
    after: {return: purchaseReturn._id, returnNo: purchaseReturn.returnNo, reason: reason || 'quality', notes},
    user: user.id
  }], {session: session || undefined});

  const fresh = await PurchaseOrder.findById(po._id).populate('supplier items.ingredient').session(session || null);
  return {purchaseOrder: fresh, purchaseReturn, duplicate: false};
}
