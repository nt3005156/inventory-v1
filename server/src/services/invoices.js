import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Audit, Supplier} from '../models/index.js';
import {PurchaseOrder, SupplierInvoice, SupplierPayment} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../models/purchasing.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {money} from './statements.js';
import {userRestaurantContext} from './supplierCatalog.js';

const EPSILON = 0.011;
const INVOICEABLE_PO_STATUSES = new Set(['approved', 'sent', 'partially_received', 'received', 'closed_short']);

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = value => String(value || '').trim();
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalizeInvoiceNumber(value) {
  return clean(value).normalize('NFKC').replace(/\s+/g, ' ').toUpperCase();
}

export function vatOf(subtotal, rate = 13) {
  return money(Number(subtotal || 0) * Number(rate || 0) / 100);
}

function amountsMatch(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) <= EPSILON;
}

export function invoiceAmounts(input = {}, current = null) {
  const priceIncludesVat = input.priceIncludesVat !== undefined
    ? Boolean(input.priceIncludesVat)
    : Boolean(current?.priceIncludesVat);
  const vatRate = input.vatRate !== undefined ? Number(input.vatRate) : Number(current?.vatRate ?? 13);
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) throw httpError('VAT rate must be between 0 and 100', 400);

  let subtotal;
  let vat;
  let total;
  if (priceIncludesVat) {
    total = input.total !== undefined ? money(input.total) : money(current?.total);
    if (!(total > 0)) throw httpError('VAT-inclusive invoice total must be positive', 400);
    subtotal = money(total / (1 + vatRate / 100));
    vat = money(total - subtotal);
    if (input.subtotal !== undefined && !amountsMatch(input.subtotal, subtotal)) {
      throw httpError('VAT-inclusive subtotal does not match the invoice total and VAT rate', 400);
    }
    if (input.vat !== undefined && !amountsMatch(input.vat, vat)) {
      throw httpError('VAT does not match the invoice total and VAT rate', 400);
    }
  } else {
    subtotal = input.subtotal !== undefined ? money(input.subtotal) : money(current?.subtotal);
    if (!Number.isFinite(subtotal) || subtotal < 0) throw httpError('Invoice subtotal cannot be negative', 400);
    vat = vatOf(subtotal, vatRate);
    total = money(subtotal + vat);
    if (input.vat !== undefined && !amountsMatch(input.vat, vat)) {
      throw httpError('VAT does not match the invoice subtotal and VAT rate', 400);
    }
    if (input.total !== undefined && !amountsMatch(input.total, total)) {
      throw httpError('Invoice total must equal subtotal plus VAT', 400);
    }
  }
  if (!(total > 0)) throw httpError('Invoice total must be positive', 400);
  return {priceIncludesVat, vatRate, subtotal, vat, total};
}

// Retained for expense and legacy callers that use the shared Nepal VAT helper.
export function nextInvoiceAmounts(invoice, patch) {
  const next = invoiceAmounts(patch, invoice);
  return {subtotal: next.subtotal, vat: next.vat, total: next.total};
}

function parseDate(value, label, {nullable = false} = {}) {
  if ((value === null || value === '') && nullable) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(`${label} must use YYYY-MM-DD`, 400);
  const date = new Date(`${text}T00:00:00.000+05:45`);
  if (Number.isNaN(date.getTime())) throw httpError(`Invalid ${label.toLowerCase()}`, 400);
  const local = new Date(date.getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (local !== text) throw httpError(`Invalid ${label.toLowerCase()}`, 400);
  return date;
}

function defaultInvoiceDate() {
  const local = new Date(Date.now() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return parseDate(local, 'Invoice date');
}

function validateDates(invoiceDate, dueDate) {
  if (dueDate && dueDate < invoiceDate) throw httpError('Due date cannot be before the invoice date', 400);
}

function validateAttachmentUrl(value) {
  const url = clean(value);
  if (!url) return undefined;
  if (url.length > 1000) throw httpError('Attachment URL must be 1000 characters or fewer', 400);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw httpError('Attachment URL must be a valid HTTPS URL', 400);
  }
  if (parsed.protocol !== 'https:') throw httpError('Attachment URL must use HTTPS', 400);
  return url;
}

function canonicalInvoiceRequest({branchId, supplierId, purchaseOrder, invoiceNo, invoiceDate, dueDate, amounts, notes, attachmentUrl}) {
  return {
    branch: String(branchId || ''),
    supplier: String(supplierId || ''),
    purchaseOrder: String(purchaseOrder || ''),
    invoiceNo: normalizeInvoiceNumber(invoiceNo),
    invoiceDate: new Date(invoiceDate).toISOString(),
    dueDate: dueDate ? new Date(dueDate).toISOString() : '',
    priceIncludesVat: amounts.priceIncludesVat,
    vatRate: amounts.vatRate,
    subtotal: amounts.subtotal,
    vat: amounts.vat,
    total: amounts.total,
    notes: clean(notes),
    attachmentUrl: clean(attachmentUrl)
  };
}

export function supplierInvoiceRequestFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalInvoiceRequest(input))).digest('hex');
}

function populatedInvoice(invoiceId, session) {
  return SupplierInvoice.findById(invoiceId)
    .populate('supplier', 'name contact address paymentTerms active')
    .populate('purchaseOrder', 'poNo status subtotal vat total')
    .populate('createdBy updatedBy voidedBy', 'name role')
    .populate('paymentCount')
    .session(session || null);
}

async function invoiceReferenceContext({user, branchId, supplierId, purchaseOrderId, session, allowInactive = false}) {
  if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
  const context = await purchaseBranchContext({user, branchId, session, allowInactive});
  const supplier = await Supplier.findOne({_id: supplierId, restaurant: context.restaurantId}).session(session || null);
  if (!supplier) throw httpError('Supplier not found for this restaurant', 404);

  let purchaseOrder = null;
  if (purchaseOrderId) {
    if (!mongoose.isValidObjectId(purchaseOrderId)) throw httpError('Invalid purchase order', 400);
    purchaseOrder = await PurchaseOrder.findOne({
      _id: purchaseOrderId,
      restaurant: context.restaurantId,
      branch: context.branch._id,
      supplier: supplier._id
    }).session(session || null);
    if (!purchaseOrder) throw httpError('Purchase order does not match the invoice restaurant, branch and supplier', 409);
    if (!INVOICEABLE_PO_STATUSES.has(purchaseOrder.status)) {
      throw httpError('Supplier invoices can only link to approved or completed purchase orders', 409);
    }
  }
  return {context, supplier, purchaseOrder};
}

async function invoiceDocumentContext({invoiceId, user, session, write = false}) {
  if (!mongoose.isValidObjectId(invoiceId)) throw httpError('Invalid invoice', 400);
  const identity = await userRestaurantContext(user, {session});
  const invoice = await SupplierInvoice.findOne({_id: invoiceId, restaurant: identity.restaurantId})
    .select('+idempotencyKey +requestHash +requestHashVersion')
    .session(session || null);
  if (!invoice) throw httpError('Invoice not found', 404);
  const context = await purchaseBranchContext({
    user,
    branchId: invoice.branch,
    session,
    allowInactive: !write
  });
  return {invoice, context};
}

function sumMoney(rows, field) {
  return money(rows.reduce((sum, row) => sum + Number(row[field] || 0), 0));
}

export async function buildInvoiceMatching({context, purchaseOrder, amounts, excludeInvoiceId, previousInvoiceIds, session}) {
  const matchedAt = new Date();
  if (!purchaseOrder) {
    return {
      status: 'unlinked',
      receivedSubtotal: 0, receivedVat: 0, receivedTotal: 0,
      returnedSubtotal: 0, returnedVat: 0, returnedTotal: 0,
      netReceivedSubtotal: 0, netReceivedVat: 0, netReceivedTotal: 0,
      previouslyInvoicedSubtotal: 0, previouslyInvoicedVat: 0, previouslyInvoicedTotal: 0,
      availableSubtotal: 0, availableVat: 0, availableTotal: 0,
      varianceSubtotal: 0, varianceVat: 0, varianceTotal: 0,
      receiptIds: [], returnIds: [], matchedAt
    };
  }

  const invoiceMatch = {
    restaurant: context.restaurantId,
    purchaseOrder: purchaseOrder._id,
    status: {$ne: 'void'}
  };
  if (previousInvoiceIds) invoiceMatch._id = {$in: previousInvoiceIds};
  else if (excludeInvoiceId) invoiceMatch._id = {$ne: excludeInvoiceId};
  const [receipts, returns, previousInvoices] = await Promise.all([
    GoodsReceipt.find({
      restaurant: context.restaurantId,
      branch: context.branch._id,
      purchaseOrder: purchaseOrder._id
    }).session(session || null).lean(),
    PurchaseReturn.find({
      restaurant: context.restaurantId,
      branch: context.branch._id,
      purchaseOrder: purchaseOrder._id,
      status: 'posted'
    }).session(session || null).lean(),
    SupplierInvoice.find(invoiceMatch).session(session || null).lean()
  ]);

  let receivedSubtotal = 0;
  let receivedVat = 0;
  for (const receipt of receipts) {
    for (const item of receipt.items || []) {
      const poLine = purchaseOrder.items.id(item.poItem);
      if (!poLine || String(poLine.ingredient) !== String(item.ingredient)) continue;
      const lineSubtotal = money(Number(item.acceptedQty || 0) * Number(poLine.unitPrice || item.unitPrice || 0));
      receivedSubtotal += lineSubtotal;
      receivedVat += money(lineSubtotal * Number(poLine.vatRate ?? 13) / 100);
    }
  }
  receivedSubtotal = money(receivedSubtotal);
  receivedVat = money(receivedVat);
  const receivedTotal = money(receivedSubtotal + receivedVat);
  const returnedSubtotal = sumMoney(returns, 'subtotal');
  const returnedVat = sumMoney(returns, 'vat');
  const returnedTotal = money(returnedSubtotal + returnedVat);
  const netReceivedSubtotal = money(Math.max(0, receivedSubtotal - returnedSubtotal));
  const netReceivedVat = money(Math.max(0, receivedVat - returnedVat));
  const netReceivedTotal = money(netReceivedSubtotal + netReceivedVat);
  const previouslyInvoicedSubtotal = sumMoney(previousInvoices, 'subtotal');
  const previouslyInvoicedVat = sumMoney(previousInvoices, 'vat');
  const previouslyInvoicedTotal = sumMoney(previousInvoices, 'total');
  const availableSubtotal = money(Math.max(0, netReceivedSubtotal - previouslyInvoicedSubtotal));
  const availableVat = money(Math.max(0, netReceivedVat - previouslyInvoicedVat));
  const availableTotal = money(Math.max(0, netReceivedTotal - previouslyInvoicedTotal));
  const varianceSubtotal = money(amounts.subtotal - availableSubtotal);
  const varianceVat = money(amounts.vat - availableVat);
  const varianceTotal = money(amounts.total - availableTotal);

  let status;
  if (netReceivedTotal <= EPSILON) status = 'awaiting_receipt';
  else if (varianceSubtotal > EPSILON || varianceVat > EPSILON || varianceTotal > EPSILON) status = 'over_billed';
  else if (Math.abs(varianceSubtotal) <= EPSILON && Math.abs(varianceVat) <= EPSILON && Math.abs(varianceTotal) <= EPSILON) status = 'matched';
  else status = 'partial';

  return {
    status,
    receivedSubtotal, receivedVat, receivedTotal,
    returnedSubtotal, returnedVat, returnedTotal,
    netReceivedSubtotal, netReceivedVat, netReceivedTotal,
    previouslyInvoicedSubtotal, previouslyInvoicedVat, previouslyInvoicedTotal,
    availableSubtotal, availableVat, availableTotal,
    varianceSubtotal, varianceVat, varianceTotal,
    receiptIds: receipts.map(receipt => receipt._id),
    returnIds: returns.map(row => row._id),
    matchedAt
  };
}

function matchingEvidence(value) {
  const row = value?.toObject ? value.toObject() : value || {};
  const {matchedAt, ...evidence} = row;
  return evidence;
}

export async function refreshSupplierInvoiceMatching({purchaseOrder, user, reason, session}) {
  const poId = purchaseOrder?._id || purchaseOrder;
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  // Reload without population so line-reference comparisons use canonical ObjectIds.
  const po = await PurchaseOrder.findById(poId).session(session || null);
  if (!po) throw httpError('Purchase order not found', 404);
  const context = await purchaseBranchContext({user, branchId: po.branch?._id || po.branch, session, allowInactive: true});
  if (String(po.restaurant?._id || po.restaurant) !== String(context.restaurantId)) {
    throw httpError('Purchase order not found', 404);
  }
  const invoices = await SupplierInvoice.find({
    restaurant: context.restaurantId,
    branch: context.branch._id,
    purchaseOrder: po._id,
    status: {$ne: 'void'}
  }).sort({createdAt: 1, _id: 1}).session(session || null);
  const previousInvoiceIds = [];
  const changed = [];
  for (const invoice of invoices) {
    const before = matchingEvidence(invoice.matching);
    const matching = await buildInvoiceMatching({
      context,
      purchaseOrder: po,
      amounts: {subtotal: invoice.subtotal, vat: invoice.vat, total: invoice.total},
      previousInvoiceIds,
      session
    });
    previousInvoiceIds.push(invoice._id);
    const after = matchingEvidence(matching);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    invoice.matching = matching;
    invoice.updatedBy = context.userId;
    try {
      await invoice.save({session: session || undefined});
    } catch (error) {
      if (error?.name === 'VersionError') throw httpError('Invoice matching changed; retry the operation', 409);
      throw error;
    }
    await Audit.create([{
      entity: 'supplier_invoice',
      entityId: invoice._id,
      restaurant: context.restaurantId,
      branch: context.branch._id,
      action: 'matching_refresh',
      before,
      after: {...after, version: invoice.__v},
      reason: clean(reason) || 'purchase_order_evidence_changed',
      user: context.userId
    }], {session: session || undefined});
    changed.push(invoice._id);
  }
  return changed;
}

async function assertUniqueInvoiceNumber({restaurantId, supplierId, normalized, excludeInvoiceId, session}) {
  const match = {
    restaurant: restaurantId,
    supplier: supplierId,
    invoiceNoNormalized: normalized
  };
  if (excludeInvoiceId) match._id = {$ne: excludeInvoiceId};
  if (await SupplierInvoice.exists(match).session(session || null)) {
    throw httpError('This supplier invoice number is already recorded', 409);
  }
}

async function findInvoiceReplay({context, idempotencyKey, requestHash, session}) {
  const prior = await SupplierInvoice.findOne({restaurant: context.restaurantId, idempotencyKey})
    .select('+requestHash')
    .session(session || null);
  if (!prior) return null;
  if (!prior.requestHash || prior.requestHash !== requestHash) {
    throw httpError('Idempotency key was already used for a different supplier invoice', 409);
  }
  return populatedInvoice(prior._id, session);
}

export async function replaySupplierInvoiceCreate({input, user, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  if (key.length > 120) throw httpError('Idempotency-Key must be 120 characters or fewer', 400);
  const invoiceDate = input.invoiceDate ? parseDate(input.invoiceDate, 'Invoice date') : defaultInvoiceDate();
  const dueDate = input.dueDate ? parseDate(input.dueDate, 'Due date') : null;
  validateDates(invoiceDate, dueDate);
  const amounts = invoiceAmounts(input);
  const attachmentUrl = validateAttachmentUrl(input.attachmentUrl);
  const {context, supplier, purchaseOrder} = await invoiceReferenceContext({
    user,
    branchId: input.branch,
    supplierId: input.supplier,
    purchaseOrderId: input.purchaseOrder,
    session,
    allowInactive: false
  });
  const requestHash = supplierInvoiceRequestFingerprint({
    branchId: context.branch._id,
    supplierId: supplier._id,
    purchaseOrder: purchaseOrder?._id,
    invoiceNo: input.invoiceNo,
    invoiceDate,
    dueDate,
    amounts,
    notes: input.notes,
    attachmentUrl
  });
  const invoice = await findInvoiceReplay({context, idempotencyKey: key, requestHash, session});
  if (!invoice) throw httpError('Supplier invoice could not be replayed; retry with a new key', 409);
  return {invoice, duplicate: true};
}

export async function createSupplierInvoice({input, user, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  if (key.length > 120) throw httpError('Idempotency-Key must be 120 characters or fewer', 400);
  const invoiceNo = clean(input.invoiceNo);
  const invoiceNoNormalized = normalizeInvoiceNumber(invoiceNo);
  if (!invoiceNoNormalized) throw httpError('Invoice number is required', 400);
  const invoiceDate = input.invoiceDate ? parseDate(input.invoiceDate, 'Invoice date') : defaultInvoiceDate();
  const dueDate = input.dueDate ? parseDate(input.dueDate, 'Due date') : null;
  validateDates(invoiceDate, dueDate);
  const amounts = invoiceAmounts(input);
  const attachmentUrl = validateAttachmentUrl(input.attachmentUrl);
  const {context, supplier, purchaseOrder} = await invoiceReferenceContext({
    user,
    branchId: input.branch,
    supplierId: input.supplier,
    purchaseOrderId: input.purchaseOrder,
    session,
    allowInactive: false
  });
  const requestHash = supplierInvoiceRequestFingerprint({
    branchId: context.branch._id,
    supplierId: supplier._id,
    purchaseOrder: purchaseOrder?._id,
    invoiceNo,
    invoiceDate,
    dueDate,
    amounts,
    notes: input.notes,
    attachmentUrl
  });
  const replay = await findInvoiceReplay({context, idempotencyKey: key, requestHash, session});
  if (replay) return {invoice: replay, duplicate: true};
  await assertUniqueInvoiceNumber({
    restaurantId: context.restaurantId,
    supplierId: supplier._id,
    normalized: invoiceNoNormalized,
    session
  });
  const matching = await buildInvoiceMatching({context, purchaseOrder, amounts, session});
  const invoice = (await SupplierInvoice.create([{
    restaurant: context.restaurantId,
    branch: context.branch._id,
    supplier: supplier._id,
    purchaseOrder: purchaseOrder?._id,
    invoiceNo,
    invoiceNoNormalized,
    identityVersion: 2,
    invoiceDate,
    dueDate: dueDate || undefined,
    currency: 'NPR',
    ...amounts,
    paidAmount: 0,
    status: 'unpaid',
    matching,
    attachmentUrl,
    notes: clean(input.notes) || undefined,
    idempotencyKey: key,
    requestHash,
    requestHashVersion: 2,
    createdBy: context.userId,
    updatedBy: context.userId
  }], {session: session || undefined}))[0];
  await Audit.create([{
    entity: 'supplier_invoice',
    entityId: invoice._id,
    restaurant: context.restaurantId,
    branch: context.branch._id,
    action: 'create',
    before: null,
    after: {
      invoiceNo: invoice.invoiceNo,
      supplier: supplier._id,
      purchaseOrder: purchaseOrder?._id,
      subtotal: invoice.subtotal,
      vat: invoice.vat,
      total: invoice.total,
      matchingStatus: matching.status
    },
    user: context.userId
  }], {session: session || undefined});
  return {invoice: await populatedInvoice(invoice._id, session), duplicate: false};
}

export async function getSupplierInvoice({invoiceId, user, session}) {
  const {invoice} = await invoiceDocumentContext({invoiceId, user, session});
  return populatedInvoice(invoice._id, session);
}

export async function listSupplierInvoices({user, branchId, supplierId, status, q, from, to, session}) {
  const identity = await userRestaurantContext(user, {session});
  let effectiveBranch = branchId;
  if (!effectiveBranch && identity.role !== 'owner') effectiveBranch = identity.branchId;
  const match = {restaurant: identity.restaurantId};
  if (effectiveBranch) {
    const context = await purchaseBranchContext({user, branchId: effectiveBranch, session, allowInactive: true});
    match.branch = context.branch._id;
  }
  if (supplierId) {
    if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
    if (!await Supplier.exists({_id: supplierId, restaurant: identity.restaurantId}).session(session || null)) {
      throw httpError('Supplier not found', 404);
    }
    match.supplier = supplierId;
  }
  if (status) match.status = status;
  if (q) {
    const regex = new RegExp(escapeRegex(clean(q).slice(0, 120)), 'i');
    match.$or = [{invoiceNo: regex}, {notes: regex}];
  }
  if (from || to) {
    match.invoiceDate = {};
    if (from) match.invoiceDate.$gte = parseDate(from, 'From date');
    if (to) {
      const end = parseDate(to, 'To date');
      end.setDate(end.getDate() + 1);
      match.invoiceDate.$lt = end;
    }
  }
  return SupplierInvoice.find(match)
    .sort({invoiceDate: -1, createdAt: -1, _id: -1})
    .limit(500)
    .populate('supplier', 'name contact paymentTerms active')
    .populate('purchaseOrder', 'poNo status subtotal vat total')
    .populate('createdBy updatedBy voidedBy', 'name role')
    .populate('paymentCount')
    .session(session || null);
}

export async function updateSupplierInvoice({invoiceId, user, patch = {}, expectedVersion, session}) {
  const {invoice, context} = await invoiceDocumentContext({invoiceId, user, session, write: true});
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw httpError('A nonnegative integer expectedVersion is required', 400);
  }
  if (expectedVersion !== Number(invoice.__v)) throw httpError('Invoice changed; refresh before saving', 409);
  if (invoice.status === 'void') throw httpError('Cannot edit a void invoice', 409);
  const previousPurchaseOrderId = invoice.purchaseOrder?._id || invoice.purchaseOrder || null;

  const before = {
    invoiceNo: invoice.invoiceNo,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    subtotal: invoice.subtotal,
    vat: invoice.vat,
    total: invoice.total,
    notes: invoice.notes,
    attachmentUrl: invoice.attachmentUrl,
    status: invoice.status,
    purchaseOrder: invoice.purchaseOrder,
    matching: invoice.matching,
    version: invoice.__v
  };
  const paid = Number(invoice.paidAmount || 0);
  const paymentQuery = SupplierPayment.exists({invoice: invoice._id});
  if (session) paymentQuery.session(session);
  const hasPayments = paid > EPSILON || Boolean(await paymentQuery);

  if (patch.status === 'void') {
    if (hasPayments) throw httpError('Cannot void an invoice with payments', 409);
    invoice.status = 'void';
    invoice.voidedBy = context.userId;
    invoice.voidedAt = new Date();
    invoice.updatedBy = context.userId;
    if (patch.notes !== undefined) invoice.notes = clean(patch.notes) || undefined;
    try {
      await invoice.save({session: session || undefined});
    } catch (error) {
      if (error?.name === 'VersionError') throw httpError('Invoice changed; refresh before saving', 409);
      throw error;
    }
    await Audit.create([{
      entity: 'supplier_invoice', entityId: invoice._id, restaurant: context.restaurantId, branch: invoice.branch,
      action: 'void', before, after: {status: 'void', notes: invoice.notes, version: invoice.__v}, user: context.userId
    }], {session: session || undefined});
    if (previousPurchaseOrderId) {
      await refreshSupplierInvoiceMatching({
        purchaseOrder: previousPurchaseOrderId,
        user,
        reason: 'supplier_invoice_void',
        session
      });
    }
    return populatedInvoice(invoice._id, session);
  }

  if (patch.invoiceNo !== undefined) {
    const invoiceNo = clean(patch.invoiceNo);
    const normalized = normalizeInvoiceNumber(invoiceNo);
    if (!normalized) throw httpError('Invoice number is required', 400);
    await assertUniqueInvoiceNumber({
      restaurantId: context.restaurantId,
      supplierId: invoice.supplier,
      normalized,
      excludeInvoiceId: invoice._id,
      session
    });
    invoice.invoiceNo = invoiceNo;
    invoice.invoiceNoNormalized = normalized;
  }

  const nextInvoiceDate = patch.invoiceDate !== undefined
    ? parseDate(patch.invoiceDate, 'Invoice date')
    : invoice.invoiceDate;
  const nextDueDate = patch.dueDate !== undefined
    ? parseDate(patch.dueDate, 'Due date', {nullable: true})
    : invoice.dueDate;
  validateDates(nextInvoiceDate, nextDueDate);
  invoice.invoiceDate = nextInvoiceDate;
  invoice.dueDate = nextDueDate;
  if (patch.notes !== undefined) invoice.notes = clean(patch.notes) || undefined;
  if (patch.attachmentUrl !== undefined) invoice.attachmentUrl = validateAttachmentUrl(patch.attachmentUrl);

  let purchaseOrder = null;
  const nextPoId = patch.purchaseOrder !== undefined ? patch.purchaseOrder : invoice.purchaseOrder;
  const purchaseOrderChanged = patch.purchaseOrder !== undefined
    && String(nextPoId || '') !== String(previousPurchaseOrderId || '');
  if (hasPayments && purchaseOrderChanged) {
    throw httpError('Cannot change the purchase order after payment', 409);
  }
  if (nextPoId) {
    const references = await invoiceReferenceContext({
      user,
      branchId: invoice.branch,
      supplierId: invoice.supplier,
      purchaseOrderId: nextPoId,
      session,
      allowInactive: false
    });
    purchaseOrder = references.purchaseOrder;
    invoice.purchaseOrder = purchaseOrder._id;
  } else {
    invoice.purchaseOrder = undefined;
  }

  const amountTouched = ['subtotal', 'vat', 'total', 'vatRate', 'priceIncludesVat']
    .some(field => patch[field] !== undefined);
  if (amountTouched) {
    if (hasPayments) throw httpError('Cannot change amounts on an invoice with payments', 409);
    const amounts = invoiceAmounts(patch, invoice);
    invoice.priceIncludesVat = amounts.priceIncludesVat;
    invoice.vatRate = amounts.vatRate;
    invoice.subtotal = amounts.subtotal;
    invoice.vat = amounts.vat;
    invoice.total = amounts.total;
  }
  const amounts = {
    priceIncludesVat: invoice.priceIncludesVat,
    vatRate: invoice.vatRate,
    subtotal: invoice.subtotal,
    vat: invoice.vat,
    total: invoice.total
  };
  let previousInvoiceIds;
  if (purchaseOrder) {
    const previousInvoices = await SupplierInvoice.find({
      restaurant: context.restaurantId,
      branch: invoice.branch,
      purchaseOrder: purchaseOrder._id,
      status: {$ne: 'void'},
      _id: {$ne: invoice._id},
      $or: [
        {createdAt: {$lt: invoice.createdAt}},
        {createdAt: invoice.createdAt, _id: {$lt: invoice._id}}
      ]
    }).select('_id').sort({createdAt: 1, _id: 1}).session(session || null).lean();
    previousInvoiceIds = previousInvoices.map(row => row._id);
  }
  invoice.matching = await buildInvoiceMatching({
    context,
    purchaseOrder,
    amounts,
    previousInvoiceIds,
    session
  });
  invoice.updatedBy = context.userId;
  try {
    await invoice.save({session: session || undefined});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Invoice changed; refresh before saving', 409);
    throw error;
  }
  await Audit.create([{
    entity: 'supplier_invoice',
    entityId: invoice._id,
    restaurant: context.restaurantId,
    branch: invoice.branch,
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
      attachmentUrl: invoice.attachmentUrl,
      status: invoice.status,
      purchaseOrder: invoice.purchaseOrder,
      matchingStatus: invoice.matching.status,
      version: invoice.__v
    },
    user: context.userId
  }], {session: session || undefined});

  if (amountTouched || patch.purchaseOrder !== undefined) {
    const affectedPurchaseOrders = [...new Set([
      previousPurchaseOrderId && String(previousPurchaseOrderId),
      purchaseOrder?._id && String(purchaseOrder._id)
    ].filter(Boolean))];
    for (const purchaseOrderId of affectedPurchaseOrders) {
      await refreshSupplierInvoiceMatching({
        purchaseOrder: purchaseOrderId,
        user,
        reason: 'supplier_invoice_update',
        session
      });
    }
  }
  return populatedInvoice(invoice._id, session);
}
