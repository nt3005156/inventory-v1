import mongoose from 'mongoose';
import {Supplier} from '../models/index.js';
import {SupplierInvoice, SupplierPayment} from '../models/operations.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000;
const LINE_TYPES = Object.freeze({invoice: 0, payment: 1, payment_reversal: 2, invoice_void: 3});
const AGING_BUCKETS = Object.freeze(['current', 'days1To30', 'days31To60', 'days61To90', 'over90']);

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const cents = value => Math.round(Number(value || 0) * 100);
const fromCents = value => money(Number(value || 0) / 100);
const clean = value => String(value ?? '').trim();
const sameId = (left, right) => String(left || '') === String(right || '');

function kathmanduYmd(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10);
}

export function parseStatementDate(value, label = 'Statement date') {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(`${label} must use YYYY-MM-DD`, 400);
  const date = new Date(`${text}T00:00:00.000+05:45`);
  if (Number.isNaN(date.getTime()) || kathmanduYmd(date) !== text) throw httpError(`Invalid ${label.toLowerCase()}`, 400);
  return date;
}

export function statementPeriod({from, to, now = new Date()} = {}) {
  const today = kathmanduYmd(now);
  const fromText = clean(from);
  const toText = clean(to) || today;
  const fromDate = fromText ? parseStatementDate(fromText, 'From date') : null;
  const toDate = parseStatementDate(toText, 'To date');
  if (toText > today) throw httpError('To date cannot be in the future', 400);
  if (fromDate && fromDate > toDate) throw httpError('From date must not be after to date', 400);
  return {
    from: fromText || null,
    to: toText,
    asOf: toText,
    fromDate,
    toDate,
    toExclusive: new Date(toDate.getTime() + DAY_MS),
    timezone: 'Asia/Kathmandu'
  };
}

function eventDate(value, fallback) {
  const date = value ? new Date(value) : new Date(fallback || 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function compareEvents(left, right) {
  const byDate = left.date.getTime() - right.date.getTime();
  if (byDate) return byDate;
  const byType = (LINE_TYPES[left.type] ?? 99) - (LINE_TYPES[right.type] ?? 99);
  if (byType) return byType;
  const byCreated = left.createdAt.getTime() - right.createdAt.getTime();
  if (byCreated) return byCreated;
  return String(left.eventId).localeCompare(String(right.eventId));
}

function voidAtCutoff(invoice, toExclusive) {
  if (invoice.status !== 'void') return false;
  if (!invoice.voidedAt) return true;
  return eventDate(invoice.voidedAt, invoice.updatedAt) < toExclusive;
}

export function buildStatementEvents(invoices = [], payments = [], {toExclusive = new Date(8640000000000000)} = {}) {
  const events = [];
  for (const invoice of invoices) {
    // Older void rows without an effective timestamp cannot be reconstructed safely.
    // Timestamped voids remain visible as explicit credits so period opening and
    // closing balances retain a complete, auditable bridge.
    if (invoice.status === 'void' && !invoice.voidedAt) continue;
    const date = eventDate(invoice.invoiceDate, invoice.createdAt);
    events.push({
      eventId: `invoice:${invoice._id}`,
      sourceId: invoice._id,
      type: 'invoice',
      date,
      createdAt: eventDate(invoice.createdAt, date),
      ref: invoice.invoiceNo,
      invoiceNo: invoice.invoiceNo,
      invoiceId: invoice._id,
      purchaseOrder: invoice.purchaseOrder,
      dueDate: invoice.dueDate,
      debit: money(invoice.total),
      credit: 0
    });
    if (invoice.status === 'void' && invoice.voidedAt) {
      const voidedAt = eventDate(invoice.voidedAt, invoice.updatedAt);
      if (voidedAt < toExclusive) {
        events.push({
          eventId: `invoice-void:${invoice._id}`,
          sourceId: invoice._id,
          type: 'invoice_void',
          date: voidedAt,
          createdAt: eventDate(invoice.updatedAt, voidedAt),
          ref: invoice.invoiceNo,
          invoiceNo: invoice.invoiceNo,
          invoiceId: invoice._id,
          voidedBy: invoice.voidedBy,
          debit: 0,
          credit: money(invoice.total)
        });
      }
    }
  }
  for (const payment of payments) {
    const invoice = payment.invoice || {};
    const paidAt = eventDate(payment.paidAt, payment.createdAt);
    events.push({
      eventId: `payment:${payment._id}`,
      sourceId: payment._id,
      type: 'payment',
      date: paidAt,
      createdAt: eventDate(payment.createdAt, paidAt),
      ref: payment.paymentNo || payment.reference || 'Payment',
      paymentNo: payment.paymentNo,
      invoiceNo: invoice.invoiceNo,
      invoiceId: invoice._id || payment.invoice,
      method: payment.method,
      reference: payment.reference,
      origin: payment.origin,
      status: 'posted',
      currentStatus: payment.status || 'posted',
      debit: 0,
      credit: money(payment.amount)
    });
    if (payment.status === 'reversed' && payment.reversedAt) {
      const reversedAt = eventDate(payment.reversedAt, payment.updatedAt);
      events.push({
        eventId: `payment-reversal:${payment._id}`,
        sourceId: payment._id,
        type: 'payment_reversal',
        date: reversedAt,
        createdAt: eventDate(payment.updatedAt, reversedAt),
        ref: payment.paymentNo || payment.reference || 'Payment reversal',
        paymentNo: payment.paymentNo,
        invoiceNo: invoice.invoiceNo,
        invoiceId: invoice._id || payment.invoice,
        method: payment.method,
        reference: payment.reference,
        status: 'reversed',
        reversalReason: payment.reversalReason,
        reversedBy: payment.reversedBy,
        debit: money(payment.amount),
        credit: 0
      });
    }
  }
  return events.sort(compareEvents);
}

function lineWithBalance(event, balanceCents) {
  const {createdAt, ...line} = event;
  return {...line, date: event.date, balance: fromCents(balanceCents)};
}

export function buildStatementLines(invoices, payments, options = {}) {
  const period = options.period || statementPeriod(options);
  const allEvents = buildStatementEvents(invoices, payments, {toExclusive: period.toExclusive})
    .filter(event => event.date < period.toExclusive);
  const openingEvents = period.fromDate ? allEvents.filter(event => event.date < period.fromDate) : [];
  const periodEvents = allEvents.filter(event => !period.fromDate || event.date >= period.fromDate);
  let openingCents = openingEvents.reduce((sum, event) => sum + cents(event.debit) - cents(event.credit), 0);
  let runningCents = openingCents;
  const lines = periodEvents.map(event => {
    runningCents += cents(event.debit) - cents(event.credit);
    return lineWithBalance(event, runningCents);
  });
  return {
    allEvents,
    periodEvents,
    lines,
    openingBalance: fromCents(openingCents),
    closingBalance: fromCents(runningCents)
  };
}

function positiveInt(value, fallback, {max = Number.MAX_SAFE_INTEGER, label = 'Value'} = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw httpError(`${label} must be an integer from 1 to ${max}`, 400);
  return number;
}

function agingForInvoices(invoices, payments, period) {
  const paymentByInvoice = new Map();
  for (const payment of payments) {
    const invoiceId = String(payment.invoice?._id || payment.invoice || '');
    if (!invoiceId || eventDate(payment.paidAt, payment.createdAt) >= period.toExclusive) continue;
    const reversedBeforeCutoff = payment.status === 'reversed'
      && (!payment.reversedAt || eventDate(payment.reversedAt, payment.updatedAt) < period.toExclusive);
    if (!reversedBeforeCutoff) paymentByInvoice.set(invoiceId, (paymentByInvoice.get(invoiceId) || 0) + cents(payment.amount));
  }

  const buckets = Object.fromEntries(AGING_BUCKETS.map(bucket => [bucket, 0]));
  let totalDueCents = 0;
  let overdueCents = 0;
  const openInvoices = [];
  for (const invoice of invoices) {
    if (voidAtCutoff(invoice, period.toExclusive) || eventDate(invoice.invoiceDate, invoice.createdAt) >= period.toExclusive) continue;
    const paidCents = paymentByInvoice.get(String(invoice._id)) || 0;
    const dueCents = Math.max(0, cents(invoice.total) - paidCents);
    if (!dueCents) continue;
    const dueYmd = invoice.dueDate ? kathmanduYmd(invoice.dueDate) : null;
    const dueDate = dueYmd ? parseStatementDate(dueYmd, 'Due date') : null;
    const daysOverdue = dueDate && dueDate < period.toDate
      ? Math.max(0, Math.floor((period.toDate.getTime() - dueDate.getTime()) / DAY_MS))
      : 0;
    const bucket = daysOverdue === 0
      ? 'current'
      : daysOverdue <= 30
        ? 'days1To30'
        : daysOverdue <= 60
          ? 'days31To60'
          : daysOverdue <= 90 ? 'days61To90' : 'over90';
    buckets[bucket] += dueCents;
    totalDueCents += dueCents;
    if (daysOverdue > 0) overdueCents += dueCents;
    openInvoices.push({
      _id: invoice._id,
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      total: money(invoice.total),
      paid: fromCents(paidCents),
      balance: fromCents(dueCents),
      daysOverdue,
      agingBucket: bucket,
      branch: invoice.branch,
      purchaseOrder: invoice.purchaseOrder
    });
  }
  openInvoices.sort((left, right) => {
    if (right.daysOverdue !== left.daysOverdue) return right.daysOverdue - left.daysOverdue;
    return String(left.invoiceNo || '').localeCompare(String(right.invoiceNo || ''));
  });
  return {
    aging: {
      asOf: period.asOf,
      totalDue: fromCents(totalDueCents),
      overdue: fromCents(overdueCents),
      current: fromCents(buckets.current),
      days1To30: fromCents(buckets.days1To30),
      days31To60: fromCents(buckets.days31To60),
      days61To90: fromCents(buckets.days61To90),
      over90: fromCents(buckets.over90),
      openInvoiceCount: openInvoices.length,
      overdueInvoiceCount: openInvoices.filter(invoice => invoice.daysOverdue > 0).length
    },
    openInvoices
  };
}

export async function buildSupplierStatement({supplierId, branchId, user, from, to, page = 1, limit = 100}) {
  if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
  const identity = await userRestaurantContext(user);
  const supplier = await Supplier.findOne({_id: supplierId, restaurant: identity.restaurantId}).lean();
  if (!supplier) throw httpError('Supplier not found', 404);

  let effectiveBranch = branchId;
  let branch = null;
  if (!effectiveBranch && identity.role !== 'owner') effectiveBranch = identity.branchId;
  if (effectiveBranch) {
    const context = await purchaseBranchContext({user, branchId: effectiveBranch, allowInactive: true});
    if (!sameId(context.restaurantId, identity.restaurantId)) throw httpError('Branch access denied', 403);
    branch = context.branch;
  }

  const period = statementPeriod({from, to});
  const safePage = positiveInt(page, 1, {max: 1_000_000, label: 'Page'});
  const safeLimit = positiveInt(limit, 100, {max: 500, label: 'Limit'});
  const invoiceMatch = {
    restaurant: identity.restaurantId,
    supplier: supplier._id,
    invoiceDate: {$lt: period.toExclusive}
  };
  if (branch) invoiceMatch.branch = branch._id;

  const invoices = await SupplierInvoice.find(invoiceMatch)
    .sort({invoiceDate: 1, createdAt: 1, _id: 1})
    .populate('branch', 'name code active')
    .populate('purchaseOrder', 'poNo status')
    .lean();
  const invoiceIds = invoices.map(invoice => invoice._id);
  const paymentMatch = {
    restaurant: identity.restaurantId,
    supplier: supplier._id,
    invoice: {$in: invoiceIds},
    paidAt: {$lt: period.toExclusive}
  };
  if (branch) paymentMatch.branch = branch._id;
  const payments = invoiceIds.length ? await SupplierPayment.find(paymentMatch)
    .sort({paidAt: 1, createdAt: 1, _id: 1})
    .populate('invoice', 'invoiceNo total paidAmount status invoiceDate dueDate')
    .populate('branch', 'name code active')
    .populate('createdBy reversedBy', 'name role')
    .lean() : [];

  const ledger = buildStatementLines(invoices, payments, {period});
  const periodInvoiceCents = ledger.periodEvents
    .filter(event => event.type === 'invoice')
    .reduce((sum, event) => sum + cents(event.debit), 0);
  const periodPaymentCents = ledger.periodEvents
    .filter(event => event.type === 'payment')
    .reduce((sum, event) => sum + cents(event.credit), 0);
  const periodReversalCents = ledger.periodEvents
    .filter(event => event.type === 'payment_reversal')
    .reduce((sum, event) => sum + cents(event.debit), 0);
  const periodVoidCents = ledger.periodEvents
    .filter(event => event.type === 'invoice_void')
    .reduce((sum, event) => sum + cents(event.credit), 0);
  const invoicedCents = ledger.allEvents.reduce((sum, event) => {
    if (event.type === 'invoice') return sum + cents(event.debit);
    if (event.type === 'invoice_void') return sum - cents(event.credit);
    return sum;
  }, 0);
  const paymentCents = ledger.allEvents.reduce((sum, event) => {
    if (event.type === 'payment') return sum + cents(event.credit);
    if (event.type === 'payment_reversal') return sum - cents(event.debit);
    return sum;
  }, 0);
  const periodDebitCents = periodInvoiceCents + periodReversalCents;
  const periodCreditCents = periodPaymentCents + periodVoidCents;
  const totalLines = ledger.lines.length;
  const pages = Math.max(1, Math.ceil(totalLines / safeLimit));
  const offset = (safePage - 1) * safeLimit;
  const {aging, openInvoices} = agingForInvoices(invoices, payments, period);
  const invoiceEvidence = invoices.map(invoice => {
    const voidedAsOf = voidAtCutoff(invoice, period.toExclusive);
    return {
      ...invoice,
      status: voidedAsOf ? 'void' : invoice.status === 'void' ? 'unpaid' : invoice.status,
      currentStatus: invoice.status,
      voidEffectiveAfterAsOf: invoice.status === 'void' && !voidedAsOf
    };
  });
  const paymentEvidence = payments.map(payment => {
    const reversedAsOf = payment.status === 'reversed'
      && (!payment.reversedAt || eventDate(payment.reversedAt, payment.updatedAt) < period.toExclusive);
    return {
      ...payment,
      status: reversedAsOf ? 'reversed' : 'posted',
      currentStatus: payment.status || 'posted',
      reversalEffectiveAfterAsOf: payment.status === 'reversed' && !reversedAsOf
    };
  });
  const evidenceLimit = 500;

  return {
    supplier,
    branch,
    scope: branch ? 'branch' : 'restaurant',
    currency: 'NPR',
    vatRate: 13,
    vatPresentation: 'Amounts include invoice VAT',
    period: {
      from: period.from,
      to: period.to,
      asOf: period.asOf,
      timezone: period.timezone
    },
    summary: {
      openingBalance: ledger.openingBalance,
      periodInvoiced: fromCents(periodInvoiceCents),
      periodPayments: fromCents(periodPaymentCents),
      periodReversals: fromCents(periodReversalCents),
      periodVoids: fromCents(periodVoidCents),
      periodDebits: fromCents(periodDebitCents),
      periodCredits: fromCents(periodCreditCents),
      closingBalance: ledger.closingBalance
    },
    invoiced: fromCents(invoicedCents),
    paid: fromCents(paymentCents),
    balance: ledger.closingBalance,
    aging,
    reconciliation: {
      ledgerBalance: ledger.closingBalance,
      agingBalance: aging.totalDue,
      difference: money(ledger.closingBalance - aging.totalDue),
      balanced: Math.abs(money(ledger.closingBalance - aging.totalDue)) < 0.01
    },
    openInvoices: openInvoices.slice(0, evidenceLimit),
    lines: ledger.lines.slice(offset, offset + safeLimit),
    linePagination: {page: safePage, limit: safeLimit, total: totalLines, pages},
    evidence: {
      limit: evidenceLimit,
      invoiceTotal: invoiceEvidence.length,
      invoiceReturned: Math.min(invoiceEvidence.length, evidenceLimit),
      paymentTotal: paymentEvidence.length,
      paymentReturned: Math.min(paymentEvidence.length, evidenceLimit),
      openInvoiceTotal: openInvoices.length,
      openInvoiceReturned: Math.min(openInvoices.length, evidenceLimit)
    },
    invoices: invoiceEvidence.slice(-evidenceLimit),
    payments: paymentEvidence.slice(-evidenceLimit)
  };
}
