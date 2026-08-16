import mongoose from 'mongoose';
import {Supplier} from '../models/index.js';
import {SupplierInvoice, SupplierPayment} from '../models/operations.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function buildStatementLines(invoices, payments) {
  const events = [];
  for (const inv of invoices) {
    events.push({
      date: inv.invoiceDate || inv.createdAt,
      type: 'invoice',
      ref: inv.invoiceNo,
      invoiceId: inv._id,
      debit: money(inv.total),
      credit: 0
    });
  }
  for (const p of payments) {
    const invoice = p.invoice && p.invoice.invoiceNo ? p.invoice : null;
    events.push({
      date: p.paidAt || p.createdAt,
      type: 'payment',
      ref: p.reference || invoice?.invoiceNo || 'Payment',
      invoiceId: invoice?._id || p.invoice,
      method: p.method,
      debit: 0,
      credit: money(p.amount)
    });
  }
  events.sort((a, b) => {
    const d = new Date(a.date) - new Date(b.date);
    if (d) return d;
    if (a.type === b.type) return 0;
    return a.type === 'invoice' ? -1 : 1;
  });
  let running = 0;
  return events.map(e => {
    running = money(running + e.debit - e.credit);
    return {...e, balance: running};
  });
}

export async function buildSupplierStatement({supplierId, branchId, user}) {
  if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
  const identity = await userRestaurantContext(user);
  const supplier = await Supplier.findOne({_id: supplierId, restaurant: identity.restaurantId});
  if (!supplier) throw httpError('Supplier not found', 404);
  let effectiveBranch = branchId;
  if (!effectiveBranch && identity.role !== 'owner') effectiveBranch = identity.branchId;
  if (effectiveBranch) {
    if (!mongoose.isValidObjectId(effectiveBranch)) throw httpError('Invalid branch', 400);
    const context = await purchaseBranchContext({user, branchId: effectiveBranch, allowInactive: true});
    effectiveBranch = context.branch._id;
  }

  const invMatch = {restaurant: identity.restaurantId, supplier: supplier._id, status: {$ne: 'void'}};
  if (effectiveBranch) invMatch.branch = effectiveBranch;
  const invoices = await SupplierInvoice.find(invMatch).populate('purchaseOrder', 'poNo').sort({invoiceDate: 1, createdAt: 1});
  const payMatch = {supplier: supplier._id, invoice: {$in: invoices.map(i => i._id)}};
  const payments = await SupplierPayment.find(payMatch).populate('invoice', 'invoiceNo total').sort({paidAt: 1, createdAt: 1});

  const lines = buildStatementLines(invoices, payments);
  const invoiced = money(invoices.reduce((s, i) => s + Number(i.total || 0), 0));
  const paid = money(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
  return {
    supplier: {_id: supplier._id, name: supplier.name, contact: supplier.contact},
    branch: effectiveBranch || null,
    invoiced,
    paid,
    balance: money(invoiced - paid),
    lines,
    invoices,
    payments
  };
}
