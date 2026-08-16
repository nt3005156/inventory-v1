import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Audit, Supplier} from '../models/index.js';
import {SupplierInvoice, SupplierPayment, SupplierPaymentCounter} from '../models/operations.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {getSupplierInvoice} from './invoices.js';
import {money} from './statements.js';

const EPSILON = 0.011;
const MAX_PAYMENT = 1_000_000_000;
export const SUPPLIER_PAYMENT_METHODS = Object.freeze(['cash', 'bank', 'esewa', 'khalti', 'card']);

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const clean = value => String(value || '').trim();
const sameId = (left, right) => String(left || '') === String(right || '');

function validMoney(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) throw httpError('Payment amount must be positive', 400);
  if (raw > MAX_PAYMENT) throw httpError('Payment amount is too large', 400);
  const normalized = money(raw);
  if (Math.abs(raw - normalized) > 1e-9) throw httpError('Payment amount cannot have more than two decimal places', 400);
  return normalized;
}

function parsePaymentDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError('Payment date must use YYYY-MM-DD', 400);
  const date = new Date(`${text}T00:00:00.000+05:45`);
  if (Number.isNaN(date.getTime())) throw httpError('Invalid payment date', 400);
  const local = new Date(date.getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (local !== text) throw httpError('Invalid payment date', 400);
  const today = new Date(Date.now() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (text > today) throw httpError('Payment date cannot be in the future', 400);
  return date;
}

function normalizedPaymentInput(input = {}, invoice) {
  const amount = validMoney(input.amount);
  const method = clean(input.method).toLowerCase();
  if (!SUPPLIER_PAYMENT_METHODS.includes(method)) throw httpError('Invalid supplier payment method', 400);
  const reference = clean(input.reference);
  if (reference.length > 200) throw httpError('Payment reference must be 200 characters or fewer', 400);
  if (method !== 'cash' && reference.length < 3) {
    throw httpError('A reference of at least 3 characters is required for non-cash payments', 400);
  }
  const requestedPaidAt = parsePaymentDate(input.paidAt);
  if (requestedPaidAt && invoice?.invoiceDate && requestedPaidAt < invoice.invoiceDate) {
    throw httpError('Payment date cannot be before the invoice date', 400);
  }
  return {amount, method, reference: reference || undefined, requestedPaidAt};
}

function canonicalPaymentRequest({invoiceId, amount, method, reference, requestedPaidAt}) {
  return {
    invoice: String(invoiceId || ''),
    amount: money(amount),
    method: clean(method).toLowerCase(),
    reference: clean(reference),
    paidAt: requestedPaidAt ? new Date(requestedPaidAt).toISOString() : ''
  };
}

export function supplierPaymentRequestFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalPaymentRequest(input))).digest('hex');
}

export function supplierPaymentReversalFingerprint({paymentId, reason}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    payment: String(paymentId || ''),
    reason: clean(reason)
  })).digest('hex');
}

function populatedPayment(paymentId, session) {
  return SupplierPayment.findById(paymentId)
    .populate('invoice', 'invoiceNo invoiceDate dueDate total paidAmount status')
    .populate('supplier', 'name contact paymentTerms')
    .populate('createdBy reversedBy', 'name role')
    .session(session || null);
}

async function invoicePaymentContext({invoiceId, user, session, write = false}) {
  if (!mongoose.isValidObjectId(invoiceId)) throw httpError('Invalid invoice', 400);
  const identity = await userRestaurantContext(user, {session});
  const invoice = await SupplierInvoice.findOne({_id: invoiceId, restaurant: identity.restaurantId})
    .session(session || null);
  if (!invoice) throw httpError('Invoice not found', 404);
  const context = await purchaseBranchContext({
    user,
    branchId: invoice.branch,
    session,
    allowInactive: !write
  });
  const supplier = await Supplier.findOne({_id: invoice.supplier, restaurant: context.restaurantId})
    .session(session || null);
  if (!supplier) throw httpError('Invoice supplier does not belong to this restaurant', 409);
  return {invoice, supplier, context, identity};
}

async function paymentDocumentContext({paymentId, user, session, write = false, ownerOnly = false}) {
  if (!mongoose.isValidObjectId(paymentId)) throw httpError('Invalid supplier payment', 400);
  const identity = await userRestaurantContext(user, {session});
  if (ownerOnly && identity.role !== 'owner') throw httpError('Only owners can reverse supplier payments', 403);
  const payment = await SupplierPayment.findOne({_id: paymentId, restaurant: identity.restaurantId})
    .select('+idempotencyKey +requestHash +requestHashVersion +reversalIdempotencyKey +reversalRequestHash')
    .session(session || null);
  if (!payment) throw httpError('Supplier payment not found', 404);
  const context = await purchaseBranchContext({
    user,
    branchId: payment.branch,
    session,
    allowInactive: !write
  });
  const invoice = await SupplierInvoice.findOne({
    _id: payment.invoice,
    restaurant: context.restaurantId,
    branch: payment.branch,
    supplier: payment.supplier
  }).session(session || null);
  if (!invoice) throw httpError('Supplier payment invoice relationship is invalid', 409);
  return {payment, invoice, context, identity};
}

async function activePaymentTotal({invoice, context, session}) {
  const aggregate = SupplierPayment.aggregate([
    {$match: {
      restaurant: new mongoose.Types.ObjectId(context.restaurantId),
      branch: new mongoose.Types.ObjectId(invoice.branch),
      invoice: new mongoose.Types.ObjectId(invoice._id),
      supplier: new mongoose.Types.ObjectId(invoice.supplier),
      status: 'posted'
    }},
    {$group: {_id: null, amount: {$sum: '$amount'}}}
  ]);
  if (session) aggregate.session(session);
  const rows = await aggregate;
  return money(rows[0]?.amount || 0);
}

function assertAggregateConsistent(invoice, activeTotal) {
  if (Math.abs(Number(invoice.paidAmount || 0) - Number(activeTotal || 0)) > EPSILON) {
    throw httpError('Invoice payment balance is inconsistent; reconcile payments before continuing', 409);
  }
}

function invoicePaymentStatus(invoice, paidAmount) {
  if (paidAmount <= EPSILON) return 'unpaid';
  if (paidAmount + EPSILON >= Number(invoice.total || 0)) return 'paid';
  return 'partial';
}

function branchCode(branch) {
  return clean(branch?.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch?._id || '').slice(-4).toUpperCase();
}

async function nextPaymentNumber({context, paidAt, session}) {
  const code = branchCode(context.branch);
  const year = Number(new Date(paidAt.getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 4));
  const counter = await SupplierPaymentCounter.findOneAndUpdate(
    {restaurant: context.restaurantId, branchCode: code, year},
    {
      $inc: {value: 1},
      $setOnInsert: {
        restaurant: context.restaurantId,
        branch: context.branch._id,
        branchCode: code,
        year
      }
    },
    {new: true, upsert: true, session: session || undefined, setDefaultsOnInsert: true}
  );
  return `PAY-${code}-${year}-${String(counter.value).padStart(6, '0')}`;
}

async function findPaymentReplay({context, invoice, idempotencyKey, requestHash, user, session}) {
  const prior = await SupplierPayment.findOne({restaurant: context.restaurantId, idempotencyKey})
    .select('+idempotencyKey +requestHash')
    .session(session || null);
  if (!prior) return null;
  if (!sameId(prior.invoice, invoice._id) || !prior.requestHash || prior.requestHash !== requestHash) {
    throw httpError('Idempotency key was already used for a different supplier payment', 409);
  }
  return {
    invoice: await getSupplierInvoice({invoiceId: invoice._id, user, session}),
    payment: await populatedPayment(prior._id, session),
    duplicate: true
  };
}

export async function replaySupplierPayment({invoiceId, input = {}, user, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  const {invoice, context} = await invoicePaymentContext({invoiceId, user, session});
  const normalized = normalizedPaymentInput(input, invoice);
  const requestHash = supplierPaymentRequestFingerprint({invoiceId: invoice._id, ...normalized});
  const replay = await findPaymentReplay({context, invoice, idempotencyKey: key, requestHash, user, session});
  if (!replay) throw httpError('Supplier payment could not be safely replayed', 409);
  return replay;
}

export async function createSupplierPayment({invoiceId, input = {}, user, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  if (key.length > 120) throw httpError('Idempotency-Key must be 120 characters or fewer', 400);
  const {invoice, context} = await invoicePaymentContext({invoiceId, user, session, write: true});
  const normalized = normalizedPaymentInput(input, invoice);
  const requestHash = supplierPaymentRequestFingerprint({invoiceId: invoice._id, ...normalized});
  const replay = await findPaymentReplay({context, invoice, idempotencyKey: key, requestHash, user, session});
  if (replay) return replay;

  if (input.expectedInvoiceVersion !== undefined) {
    if (!Number.isInteger(input.expectedInvoiceVersion) || input.expectedInvoiceVersion < 0) {
      throw httpError('expectedInvoiceVersion must be a nonnegative integer', 400);
    }
    if (Number(input.expectedInvoiceVersion) !== Number(invoice.__v)) {
      throw httpError('Invoice changed; refresh before recording payment', 409);
    }
  }
  if (invoice.status === 'void') throw httpError('Cannot pay a void invoice', 409);
  const activeTotal = await activePaymentTotal({invoice, context, session});
  assertAggregateConsistent(invoice, activeTotal);
  const remaining = money(Number(invoice.total || 0) - activeTotal);
  if (remaining <= EPSILON) throw httpError('Invoice is already fully paid', 409);
  if (normalized.amount > remaining + EPSILON) throw httpError('Payment exceeds invoice balance', 409);

  const paidAt = normalized.requestedPaidAt || new Date();
  const paymentNo = await nextPaymentNumber({context, paidAt, session});
  const payment = (await SupplierPayment.create([{
    restaurant: context.restaurantId,
    branch: invoice.branch,
    invoice: invoice._id,
    supplier: invoice.supplier,
    paymentNo,
    numberVersion: 2,
    amount: normalized.amount,
    currency: 'NPR',
    method: normalized.method,
    reference: normalized.reference,
    paidAt,
    status: 'posted',
    idempotencyKey: key,
    requestHash,
    requestHashVersion: 2,
    createdBy: context.userId
  }], {session: session || undefined}))[0];

  const before = {paidAmount: activeTotal, status: invoice.status, version: invoice.__v};
  invoice.paidAmount = money(activeTotal + normalized.amount);
  invoice.status = invoicePaymentStatus(invoice, invoice.paidAmount);
  invoice.updatedBy = context.userId;
  try {
    await invoice.save({session: session || undefined});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Invoice changed; refresh before recording payment', 409);
    throw error;
  }
  await Audit.create([{
    entity: 'supplier_payment',
    entityId: payment._id,
    restaurant: context.restaurantId,
    branch: invoice.branch,
    action: 'post',
    before,
    after: {
      paymentNo,
      invoice: invoice._id,
      supplier: invoice.supplier,
      amount: normalized.amount,
      method: normalized.method,
      reference: normalized.reference,
      paidAt,
      paidAmount: invoice.paidAmount,
      invoiceStatus: invoice.status,
      version: invoice.__v
    },
    user: context.userId
  }], {session: session || undefined});

  return {
    invoice: await getSupplierInvoice({invoiceId: invoice._id, user, session}),
    payment: await populatedPayment(payment._id, session),
    duplicate: false
  };
}

export async function listSupplierInvoicePayments({invoiceId, user, session}) {
  const {invoice, context} = await invoicePaymentContext({invoiceId, user, session});
  return SupplierPayment.find({
    restaurant: context.restaurantId,
    branch: invoice.branch,
    supplier: invoice.supplier,
    invoice: invoice._id
  })
    .sort({paidAt: 1, createdAt: 1, _id: 1})
    .populate('createdBy reversedBy', 'name role')
    .session(session || null);
}

async function findReversalReplay({context, payment, reversalKey, requestHash, user, session}) {
  const prior = await SupplierPayment.findOne({restaurant: context.restaurantId, reversalIdempotencyKey: reversalKey})
    .select('+reversalIdempotencyKey +reversalRequestHash')
    .session(session || null);
  if (!prior) return null;
  if (!sameId(prior._id, payment._id) || prior.reversalRequestHash !== requestHash || prior.status !== 'reversed') {
    throw httpError('Idempotency key was already used for a different supplier payment reversal', 409);
  }
  return {
    invoice: await getSupplierInvoice({invoiceId: payment.invoice, user, session}),
    payment: await populatedPayment(payment._id, session),
    duplicate: true
  };
}

export async function replaySupplierPaymentReversal({paymentId, reason, user, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  const {payment, context} = await paymentDocumentContext({paymentId, user, session, ownerOnly: true});
  const normalizedReason = clean(reason);
  if (normalizedReason.length < 3 || normalizedReason.length > 500) {
    throw httpError('Reversal reason must be between 3 and 500 characters', 400);
  }
  const requestHash = supplierPaymentReversalFingerprint({paymentId: payment._id, reason: normalizedReason});
  const replay = await findReversalReplay({context, payment, reversalKey: key, requestHash, user, session});
  if (!replay) throw httpError('Supplier payment reversal could not be safely replayed', 409);
  return replay;
}

export async function reverseSupplierPayment({paymentId, reason, expectedInvoiceVersion, user, idempotencyKey, session}) {
  const key = clean(idempotencyKey);
  if (!key) throw httpError('Idempotency-Key is required', 400);
  if (key.length > 120) throw httpError('Idempotency-Key must be 120 characters or fewer', 400);
  const normalizedReason = clean(reason);
  if (normalizedReason.length < 3 || normalizedReason.length > 500) {
    throw httpError('Reversal reason must be between 3 and 500 characters', 400);
  }
  const {payment, invoice, context} = await paymentDocumentContext({
    paymentId,
    user,
    session,
    write: true,
    ownerOnly: true
  });
  const requestHash = supplierPaymentReversalFingerprint({paymentId: payment._id, reason: normalizedReason});
  const replay = await findReversalReplay({context, payment, reversalKey: key, requestHash, user, session});
  if (replay) return replay;
  if (payment.status === 'reversed') throw httpError('Supplier payment is already reversed', 409);
  if (invoice.status === 'void') throw httpError('Cannot reverse a payment on a void invoice', 409);
  if (expectedInvoiceVersion !== undefined) {
    if (!Number.isInteger(expectedInvoiceVersion) || expectedInvoiceVersion < 0) {
      throw httpError('expectedInvoiceVersion must be a nonnegative integer', 400);
    }
    if (Number(expectedInvoiceVersion) !== Number(invoice.__v)) {
      throw httpError('Invoice changed; refresh before reversing payment', 409);
    }
  }

  const activeTotal = await activePaymentTotal({invoice, context, session});
  assertAggregateConsistent(invoice, activeTotal);
  if (Number(payment.amount) > activeTotal + EPSILON) {
    throw httpError('Payment reversal exceeds the active invoice payments', 409);
  }
  const before = {
    paymentStatus: payment.status,
    paidAmount: activeTotal,
    invoiceStatus: invoice.status,
    invoiceVersion: invoice.__v,
    paymentVersion: payment.__v
  };
  const reversedAt = new Date();
  payment.status = 'reversed';
  payment.reversedAt = reversedAt;
  payment.reversedBy = context.userId;
  payment.reversalReason = normalizedReason;
  payment.reversalIdempotencyKey = key;
  payment.reversalRequestHash = requestHash;
  try {
    await payment.save({session: session || undefined});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Supplier payment changed; refresh before reversing', 409);
    throw error;
  }

  invoice.paidAmount = money(Math.max(0, activeTotal - Number(payment.amount)));
  invoice.status = invoicePaymentStatus(invoice, invoice.paidAmount);
  invoice.updatedBy = context.userId;
  try {
    await invoice.save({session: session || undefined});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Invoice changed; refresh before reversing payment', 409);
    throw error;
  }
  await Audit.create([{
    entity: 'supplier_payment',
    entityId: payment._id,
    restaurant: context.restaurantId,
    branch: payment.branch,
    action: 'reverse',
    before,
    after: {
      paymentNo: payment.paymentNo,
      paymentStatus: payment.status,
      amount: payment.amount,
      paidAmount: invoice.paidAmount,
      invoiceStatus: invoice.status,
      reversedAt,
      invoiceVersion: invoice.__v,
      paymentVersion: payment.__v
    },
    reason: normalizedReason,
    user: context.userId
  }], {session: session || undefined});

  return {
    invoice: await getSupplierInvoice({invoiceId: invoice._id, user, session}),
    payment: await populatedPayment(payment._id, session),
    duplicate: false
  };
}
