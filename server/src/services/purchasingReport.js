import mongoose from 'mongoose';
import {PurchaseOrder, SupplierInvoice, SupplierPayment, InventoryTransaction} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../models/purchasing.js';
import {assertBranchAccess} from './kitchen.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dateMatch(from, to) {
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

export function summarizePoLines(orders) {
  let orderedQty = 0;
  let receivedQty = 0;
  let damagedQty = 0;
  let returnedQty = 0;
  let orderedValue = 0;
  for (const po of orders) {
    orderedValue += Number(po.total || 0);
    for (const line of po.items || []) {
      orderedQty += Number(line.orderedQty || 0);
      receivedQty += Number(line.receivedQty || 0);
      damagedQty += Number(line.damagedQty || 0);
      returnedQty += Number(line.returnedQty || 0);
    }
  }
  const acceptedQty = receivedQty - damagedQty;
  return {
    orderedQty,
    receivedQty,
    damagedQty,
    acceptedQty,
    returnedQty,
    onHandFromPos: acceptedQty - returnedQty,
    orderedValue: money(orderedValue)
  };
}

export async function buildPurchasingReport({branchId, user, from, to}) {
  if (branchId) {
    if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branchId);
  }
  const dates = dateMatch(from, to);
  const branchMatch = branchId ? {branch: new mongoose.Types.ObjectId(branchId)} : {};
  const match = {...branchMatch, ...dates};

  const [orders, receipts, returns, invoices, payments, purchaseTx, returnTx] = await Promise.all([
    PurchaseOrder.find({...match, status: {$ne: 'cancelled'}}).populate('supplier', 'name'),
    GoodsReceipt.find(match),
    PurchaseReturn.find(match),
    SupplierInvoice.find({...match, status: {$ne: 'void'}}).populate('supplier', 'name'),
    SupplierPayment.find(dates),
    InventoryTransaction.find({...branchMatch, type: 'PURCHASE', ...dates}),
    InventoryTransaction.find({...branchMatch, type: 'RETURN', referenceType: 'purchase_return', ...dates})
  ]);

  const invoiceIds = new Set(invoices.map(i => String(i._id)));
  const scopedPayments = branchId
    ? payments.filter(p => invoiceIds.has(String(p.invoice)))
    : payments;

  const poQty = summarizePoLines(orders);
  const receivedValue = money(receipts.reduce((s, r) => s + (r.items || []).reduce((a, i) => a + Number(i.acceptedQty || 0) * Number(i.unitPrice || 0), 0), 0));
  const damagedValue = money(receipts.reduce((s, r) => s + (r.items || []).reduce((a, i) => a + Number(i.damagedQty || 0) * Number(i.unitPrice || 0), 0), 0));
  const returnedValue = money(returns.reduce((s, r) => s + (r.items || []).reduce((a, i) => a + Number(i.qty || 0) * Number(i.unitCost || 0), 0), 0));
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
    row.paid = money(row.paid + Number(inv.paidAmount || 0));
    row.due = money(row.invoiced - row.paid);
  }

  return {
    branch: branchId || null,
    from: from || null,
    to: to || null,
    purchaseOrders: {
      count: orders.length,
      ...poQty
    },
    receipts: {
      count: receipts.length,
      acceptedValue: receivedValue,
      damagedValue
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
