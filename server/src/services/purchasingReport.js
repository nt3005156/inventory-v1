import mongoose from 'mongoose';
import {Branch, PurchaseOrder, SupplierInvoice, SupplierPayment, InventoryTransaction} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../models/purchasing.js';
import {REPORTABLE_PO_STATUSES, purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dateMatch(from, to, toExclusive) {
  if (!from && !to && !toExclusive) return {};
  const createdAt = {};
  if (from) createdAt.$gte = new Date(from);
  if (toExclusive) createdAt.$lt = new Date(toExclusive);
  else if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    createdAt.$lte = end;
  }
  return {createdAt};
}

export function summarizePoLines(orders) {
  let orderedQty = 0;
  let receivedQty = 0;
  let damagedQty = 0;
  let returnedQty = 0;
  let outstandingQty = 0;
  let shortClosedQty = 0;
  let partialCount = 0;
  let shortClosedCount = 0;
  let orderedValue = 0;
  for (const po of orders) {
    orderedValue += Number(po.total || 0);
    if (po.status === 'partially_received') partialCount += 1;
    if (po.status === 'closed_short') shortClosedCount += 1;
    for (const line of po.items || []) {
      const ordered = Number(line.orderedQty || 0);
      const received = Number(line.receivedQty || 0);
      const remaining = Math.max(0, ordered - received);
      orderedQty += ordered;
      receivedQty += received;
      damagedQty += Number(line.damagedQty || 0);
      returnedQty += Number(line.returnedQty || 0);
      if (po.status === 'closed_short') shortClosedQty += remaining;
      else if (!['received', 'cancelled'].includes(po.status)) outstandingQty += remaining;
    }
  }
  const acceptedQty = receivedQty - damagedQty;
  return {
    orderedQty,
    receivedQty,
    damagedQty,
    acceptedQty,
    returnedQty,
    outstandingQty,
    shortClosedQty,
    partialCount,
    shortClosedCount,
    onHandFromPos: acceptedQty - returnedQty,
    orderedValue: money(orderedValue)
  };
}

export async function buildPurchasingReport({branchId, user, from, to, toExclusive}) {
  let context;
  let effectiveBranchId = branchId;
  if (branchId) {
    if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
    context = await purchaseBranchContext({user, branchId});
    effectiveBranchId = context.branch._id;
  } else {
    context = await userRestaurantContext(user);
    if (context.role !== 'owner') {
      if (!context.branchId) throw httpError('User is not assigned to a branch', 403);
      const branchContext = await purchaseBranchContext({user, branchId: context.branchId});
      context = branchContext;
      effectiveBranchId = branchContext.branch._id;
    }
  }

  const tenantBranches = effectiveBranchId
    ? [new mongoose.Types.ObjectId(effectiveBranchId)]
    : await Branch.find({restaurant: context.restaurantId}).distinct('_id');
  const dates = dateMatch(from, to, toExclusive);
  const branchMatch = {branch: effectiveBranchId
    ? new mongoose.Types.ObjectId(effectiveBranchId)
    : {$in: tenantBranches}};
  const match = {...branchMatch, ...dates};

  const [orders, receipts, returns, invoices, purchaseTx, returnTx] = await Promise.all([
    PurchaseOrder.find({restaurant: context.restaurantId, ...match, status: {$in: REPORTABLE_PO_STATUSES}}).populate('supplier', 'name'),
    GoodsReceipt.find({restaurant: context.restaurantId, ...match}),
    PurchaseReturn.find({restaurant: context.restaurantId, ...match}),
    SupplierInvoice.find({restaurant: context.restaurantId, ...match, status: {$ne: 'void'}}).populate('supplier', 'name'),
    InventoryTransaction.find({...branchMatch, type: 'PURCHASE', ...dates}),
    InventoryTransaction.find({...branchMatch, type: 'RETURN', referenceType: 'purchase_return', ...dates})
  ]);

  const scopedPayments = invoices.length
    ? await SupplierPayment.find({
      restaurant: context.restaurantId,
      ...branchMatch,
      ...dates,
      status: 'posted',
      invoice: {$in: invoices.map(invoice => invoice._id)}
    })
    : [];

  const poQty = summarizePoLines(orders);
  const receivedValue = money(receipts.reduce((s, r) => s + (r.items || []).reduce((a, i) => a + Number(i.acceptedQty || 0) * Number(i.unitPrice || 0), 0), 0));
  const damagedValue = money(receipts.reduce((s, r) => s + (r.items || []).reduce((a, i) => a + Number(i.damagedQty || 0) * Number(i.unitPrice || 0), 0), 0));
  const damageByReason = new Map();
  for (const receipt of receipts) {
    for (const item of receipt.items || []) {
      const qty = Number(item.damagedQty || 0);
      if (!(qty > 0)) continue;
      const reason = item.damageReason || 'legacy_unspecified';
      const current = damageByReason.get(reason) || {reason, qty: 0, value: 0};
      current.qty += qty;
      current.value = money(current.value + qty * Number(item.unitPrice || 0));
      damageByReason.set(reason, current);
    }
  }
  const returnedValue = money(returns.reduce((sum, purchaseReturn) => {
    if (purchaseReturn.subtotal !== undefined && purchaseReturn.subtotal !== null
      && Number.isFinite(Number(purchaseReturn.subtotal))) return sum + Number(purchaseReturn.subtotal);
    return sum + (purchaseReturn.items || []).reduce(
      (lineSum, item) => lineSum + Number(item.qty || 0) * Number(item.unitCost || 0),
      0
    );
  }, 0));
  const invoiced = money(invoices.reduce((s, i) => s + Number(i.total || 0), 0));
  const vat = money(invoices.reduce((s, i) => s + Number(i.vat || 0), 0));
  const paid = money(scopedPayments.reduce((s, p) => s + Number(p.amount || 0), 0));
  const ledgerPurchases = money(purchaseTx.reduce((s, t) => s + Number(t.totalCost || 0), 0));
  const ledgerReturns = money(returnTx.reduce((s, t) => s + Number(t.totalCost || 0), 0));

  const bySupplierMap = new Map();
  const touch = (id, name) => {
    const key = String(id || 'unknown');
    if (!bySupplierMap.has(key)) {
      bySupplierMap.set(key, {supplierId: id || null, name: name || 'Unknown', poCount: 0, orderedValue: 0, invoiced: 0, paid: 0, due: 0});
    }
    return bySupplierMap.get(key);
  };
  for (const po of orders) {
    const row = touch(po.supplier?._id || po.supplier, po.supplier?.name);
    row.poCount += 1;
    row.orderedValue = money(row.orderedValue + Number(po.total || 0));
  }
  for (const inv of invoices) {
    const row = touch(inv.supplier?._id || inv.supplier, inv.supplier?.name);
    row.invoiced = money(row.invoiced + Number(inv.total || 0));
    row.due = money(row.invoiced - row.paid);
  }
  for (const payment of scopedPayments) {
    const row = touch(payment.supplier);
    row.paid = money(row.paid + Number(payment.amount || 0));
    row.due = money(row.invoiced - row.paid);
  }

  return {
    branch: effectiveBranchId ? String(effectiveBranchId) : null,
    from: from || null,
    to: to || null,
    purchaseOrders: {
      count: orders.length,
      ...poQty
    },
    receipts: {
      count: receipts.length,
      acceptedValue: receivedValue,
      damagedValue,
      damageByReason: [...damageByReason.values()].sort((a, b) => b.value - a.value || b.qty - a.qty)
    },
    returns: {
      count: returns.length,
      value: returnedValue
    },
    invoices: {
      count: invoices.length,
      invoiced,
      vat,
      paid,
      due: money(invoiced - paid)
    },
    ledger: {
      purchaseValue: ledgerPurchases,
      returnValue: ledgerReturns,
      netStockValue: money(ledgerPurchases - ledgerReturns)
    },
    bySupplier: [...bySupplierMap.values()].sort((a, b) => b.invoiced - a.invoiced || b.orderedValue - a.orderedValue)
  };
}
