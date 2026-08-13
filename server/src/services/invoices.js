import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {PurchaseOrder, SupplierInvoice} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function vatOf(subtotal, rate = 13) {
  return money(Number(subtotal || 0) * rate / 100);
}

export function nextInvoiceAmounts(invoice, patch) {
  const subtotal = patch.subtotal !== undefined ? money(patch.subtotal) : money(invoice.subtotal);
  const vat = patch.vat !== undefined
    ? money(patch.vat)
    : (patch.subtotal !== undefined ? vatOf(subtotal) : money(invoice.vat));
  const total = patch.total !== undefined ? money(patch.total) : money(subtotal + vat);
  if (subtotal < 0 || vat < 0) throw httpError('Amounts cannot be negative', 400);
  if (!(total > 0)) throw httpError('Invoice total must be positive', 400);
  return {subtotal, vat, total};
}

export async function updateSupplierInvoice({invoiceId, user, patch = {}}) {
  if (!mongoose.isValidObjectId(invoiceId)) throw httpError('Invalid invoice', 400);
  const invoice = await SupplierInvoice.findById(invoiceId);
  if (!invoice) throw httpError('Invoice not found', 404);
  if (invoice.branch) assertBranchAccess(user, invoice.branch);
  if (invoice.status === 'void') throw httpError('Cannot edit a void invoice', 409);

  const before = {
    invoiceNo: invoice.invoiceNo,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    subtotal: invoice.subtotal,
    vat: invoice.vat,
    total: invoice.total,
    notes: invoice.notes,
    status: invoice.status,
    purchaseOrder: invoice.purchaseOrder
  };
  const paid = Number(invoice.paidAmount || 0);
  const amountTouched = patch.subtotal !== undefined || patch.vat !== undefined || patch.total !== undefined;

  if (patch.status === 'void') {
    if (paid > 0) throw httpError('Cannot void an invoice with payments', 409);
    invoice.status = 'void';
    if (patch.notes !== undefined) invoice.notes = patch.notes;
    await invoice.save();
    await Audit.create([{
      entity: 'supplier_invoice',
      entityId: invoice._id,
      action: 'void',
      before,
      after: {status: 'void', notes: invoice.notes},
      user: user.id
    }]);
    return invoice;
  }

  if (patch.invoiceNo !== undefined) {
    const invoiceNo = String(patch.invoiceNo || '').trim();
    if (!invoiceNo) throw httpError('Invoice number is required', 400);
    invoice.invoiceNo = invoiceNo;
  }
  if (patch.invoiceDate !== undefined) invoice.invoiceDate = patch.invoiceDate ? new Date(patch.invoiceDate) : invoice.invoiceDate;
  if (patch.dueDate !== undefined) invoice.dueDate = patch.dueDate ? new Date(patch.dueDate) : null;
  if (patch.notes !== undefined) invoice.notes = patch.notes;
  if (patch.attachmentUrl !== undefined) invoice.attachmentUrl = patch.attachmentUrl;
  if (patch.purchaseOrder !== undefined) {
    if (!patch.purchaseOrder) {
      invoice.purchaseOrder = undefined;
    } else {
      if (!mongoose.isValidObjectId(patch.purchaseOrder)) throw httpError('Invalid purchase order', 400);
      const po = await PurchaseOrder.findById(patch.purchaseOrder);
      if (!po) throw httpError('Purchase order not found', 404);
      if (invoice.branch && String(po.branch) !== String(invoice.branch)) {
        throw httpError('Purchase order belongs to another branch', 409);
      }
      invoice.purchaseOrder = po._id;
    }
  }

  if (amountTouched) {
    if (paid > 0) throw httpError('Cannot change amounts on an invoice with payments', 409);
    const next = nextInvoiceAmounts(invoice, patch);
    invoice.subtotal = next.subtotal;
    invoice.vat = next.vat;
    invoice.total = next.total;
  }

  await invoice.save();
  await Audit.create([{
    entity: 'supplier_invoice',
    entityId: invoice._id,
    action: 'update',
    before,
    after: {
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      subtotal: invoice.subtotal,
      vat: invoice.vat,
      total: invoice.total,
      notes: invoice.notes,
      status: invoice.status,
      purchaseOrder: invoice.purchaseOrder
    },
    user: user.id
  }]);
  return invoice;
}
