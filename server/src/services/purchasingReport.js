import mongoose from 'mongoose';
import {Branch, InventoryTransaction, PurchaseOrder, SupplierInvoice, SupplierPayment} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../models/purchasing.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {money, buildStatementEvents, statementPeriod} from './statements.js';
import {userRestaurantContext} from './supplierCatalog.js';

const REPORTABLE_PO_STATUSES = ['approved', 'sent', 'partially_received', 'received', 'closed_short'];
const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000;
const EPSILON = 0.011;

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const idOf = value => String(value?._id || value || '');
const cents = value => Math.round(Number(value || 0) * 100);
const fromCents = value => money(Number(value || 0) / 100);
const dateOf = value => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};
const kathmanduYmd = value => new Date(value.getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10);

function exactDate(value, label) {
  const date = dateOf(value);
  if (!date) throw httpError(`Invalid ${label}`, 400);
  return date;
}

/**
 * Public report dates are strict Kathmandu calendar days. Internal dashboard and
 * month-close callers may instead pass exact instants and an exclusive end.
 */
export function purchasingReportPeriod({from, to, toExclusive, now = new Date()} = {}) {
  if (toExclusive !== undefined && toExclusive !== null) {
    const end = exactDate(toExclusive, 'exclusive report end');
    const start = from === undefined || from === null || from === '' ? null : exactDate(from, 'report start');
    if (start && start >= end) throw httpError('Report start must be before report end', 400);
    return {
      from: start ? kathmanduYmd(start) : null,
      to: kathmanduYmd(new Date(end.getTime() - 1)),
      asOf: kathmanduYmd(new Date(end.getTime() - 1)),
      fromDate: start,
      toExclusive: end,
      timezone: 'Asia/Kathmandu',
      boundaryMode: 'instant'
    };
  }

  const fromIsCalendarDay = from === undefined || from === null || from === '' || (typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from));
  const toIsCalendarDay = to === undefined || to === null || to === '' || (typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to));
  if (fromIsCalendarDay && toIsCalendarDay) {
    return {...statementPeriod({from, to, now}), boundaryMode: 'kathmandu_day'};
  }

  // Exact timestamps are an internal compatibility path used by live dashboard
  // calculations. API report routes only accept YYYY-MM-DD values.
  const start = from === undefined || from === null || from === '' ? null : exactDate(from, 'report start');
  const end = to === undefined || to === null || to === ''
    ? statementPeriod({now}).toExclusive
    : exactDate(to, 'report end');
  if (start && start >= end) throw httpError('Report start must be before report end', 400);
  return {
    from: start ? kathmanduYmd(start) : null,
    to: kathmanduYmd(new Date(end.getTime() - 1)),
    asOf: kathmanduYmd(new Date(end.getTime() - 1)),
    fromDate: start,
    toExclusive: end,
    timezone: 'Asia/Kathmandu',
    boundaryMode: 'instant'
  };
}

async function reportContext({branchId, user}) {
  const identity = await userRestaurantContext(user);
  let effectiveBranchId = branchId;
  if (!effectiveBranchId && identity.role !== 'owner') effectiveBranchId = identity.branchId;
  if (!effectiveBranchId && identity.role !== 'owner') throw httpError('User is not assigned to a branch', 403);

  let branch = null;
  if (effectiveBranchId) {
    if (!mongoose.isValidObjectId(effectiveBranchId)) throw httpError('Invalid branch', 400);
    const scoped = await purchaseBranchContext({user, branchId: effectiveBranchId, allowInactive: true});
    branch = scoped.branch;
  }
  return {identity, branch};
}

function fieldRange(field, period) {
  return {
    [field]: {
      ...(period.fromDate ? {$gte: period.fromDate} : {}),
      $lt: period.toExclusive
    }
  };
}

function supplierIdentity(value) {
  const id = idOf(value);
  return id ? {id, name: value?.name || 'Unknown supplier'} : {id: '', name: 'Unknown supplier'};
}

function addSupplier(map, value) {
  const supplier = supplierIdentity(value);
  const key = supplier.id || `unknown:${supplier.name}`;
  if (!map.has(key)) {
    map.set(key, {
      supplierId: supplier.id || null,
      name: supplier.name,
      poCount: 0,
      orderedValue: 0,
      receiptCount: 0,
      acceptedValue: 0,
      damagedValue: 0,
      returnCount: 0,
      returnedValue: 0,
      grossInvoiced: 0,
      voided: 0,
      invoiced: 0,
      grossPaid: 0,
      reversed: 0,
      paid: 0,
      openingDue: 0,
      due: 0
    });
  } else if (map.get(key).name === 'Unknown supplier' && supplier.name !== 'Unknown supplier') {
    map.get(key).name = supplier.name;
  }
  return map.get(key);
}

function countBy(rows, value) {
  const result = {};
  for (const row of rows) {
    const key = value(row) || 'unknown';
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function periodEvent(event, period) {
  return event.date < period.toExclusive && (!period.fromDate || event.date >= period.fromDate);
}

function lineValues(invoice) {
  return {
    subtotal: cents(invoice?.subtotal),
    vat: cents(invoice?.vat),
    total: cents(invoice?.total)
  };
}

export async function buildPurchasingReport({branchId, user, from, to, toExclusive}) {
  const {identity, branch} = await reportContext({branchId, user});
  const period = purchasingReportPeriod({from, to, toExclusive});
  const branchIds = branch
    ? [branch._id]
    : await Branch.find({restaurant: identity.restaurantId}).distinct('_id');
  const scope = {
    restaurant: identity.restaurantId,
    branch: branch ? branch._id : {$in: branchIds}
  };

  const [purchaseOrders, receipts, returns, transactions, invoices, payments] = await Promise.all([
    PurchaseOrder.find({
      ...scope,
      status: {$in: REPORTABLE_PO_STATUSES},
      ...fieldRange('orderDate', period)
    }).populate('supplier', 'name').lean(),
    GoodsReceipt.find({...scope, ...fieldRange('receivedAt', period)})
      .populate('supplier', 'name').lean(),
    PurchaseReturn.find({...scope, status: 'posted', ...fieldRange('returnedAt', period)})
      .populate('supplier', 'name').lean(),
    InventoryTransaction.find({
      branch: {$in: branchIds},
      $or: [
        {type: 'PURCHASE', referenceType: 'goods_receipt'},
        {type: 'RETURN', referenceType: 'purchase_return'}
      ],
      ...fieldRange('createdAt', period)
    }).lean(),
    SupplierInvoice.find({...scope, invoiceDate: {$lt: period.toExclusive}})
      .populate('supplier', 'name').lean(),
    SupplierPayment.find({...scope, paidAt: {$lt: period.toExclusive}})
      .populate('supplier', 'name').lean()
  ]);

  const allEvents = buildStatementEvents(invoices, payments, {toExclusive: period.toExclusive})
    .filter(event => event.date < period.toExclusive);
  const periodEvents = allEvents.filter(event => periodEvent(event, period));
  const invoicesById = new Map(invoices.map(invoice => [idOf(invoice._id), invoice]));
  const paymentsById = new Map(payments.map(payment => [idOf(payment._id), payment]));

  let orderedValueCents = 0;
  let orderedQty = 0;
  let lifecycleReceivedQty = 0;
  let lifecycleDamagedQty = 0;
  let lifecycleReturnedQty = 0;
  let outstandingQty = 0;
  let shortClosedQty = 0;
  const bySupplier = new Map();

  for (const order of purchaseOrders) {
    const supplier = addSupplier(bySupplier, order.supplier);
    supplier.poCount += 1;
    supplier.orderedValue += Number(order.total || 0);
    orderedValueCents += cents(order.total);
    for (const item of order.items || []) {
      const ordered = Number(item.orderedQty || 0);
      const received = Number(item.receivedQty || 0);
      const damaged = Number(item.damagedQty || 0);
      const returned = Number(item.returnedQty || 0);
      const outstanding = Math.max(0, ordered - received);
      orderedQty += ordered;
      lifecycleReceivedQty += received;
      lifecycleDamagedQty += damaged;
      lifecycleReturnedQty += returned;
      if (order.status === 'closed_short') shortClosedQty += outstanding;
      else outstandingQty += outstanding;
    }
  }

  let receivedValueCents = 0;
  let acceptedValueCents = 0;
  let damagedValueCents = 0;
  let receivedQty = 0;
  let acceptedQty = 0;
  let damagedQty = 0;
  const damageReasons = new Map();
  for (const receipt of receipts) {
    const supplier = addSupplier(bySupplier, receipt.supplier);
    supplier.receiptCount += 1;
    supplier.acceptedValue += Number(receipt.acceptedValue || 0);
    supplier.damagedValue += Number(receipt.damagedValue || 0);
    receivedValueCents += cents(receipt.receivedValue);
    acceptedValueCents += cents(receipt.acceptedValue);
    damagedValueCents += cents(receipt.damagedValue);
    for (const item of receipt.items || []) {
      receivedQty += Number(item.receivedQty || 0);
      acceptedQty += Number(item.acceptedQty ?? (Number(item.receivedQty || 0) - Number(item.damagedQty || 0)));
      damagedQty += Number(item.damagedQty || 0);
      if (Number(item.damagedQty || 0) > 0) {
        const reason = item.damageReason || 'legacy_unspecified';
        const current = damageReasons.get(reason) || {reason, qty: 0, value: 0};
        current.qty += Number(item.damagedQty || 0);
        current.value += Number(item.damagedQty || 0) * Number(item.unitPrice || 0);
        damageReasons.set(reason, current);
      }
    }
  }

  let returnSubtotalCents = 0;
  let returnVatCents = 0;
  let returnTotalCents = 0;
  let returnStockValueCents = 0;
  let returnedQty = 0;
  for (const purchaseReturn of returns) {
    const supplier = addSupplier(bySupplier, purchaseReturn.supplier);
    supplier.returnCount += 1;
    supplier.returnedValue += Number(purchaseReturn.subtotal || 0);
    returnSubtotalCents += cents(purchaseReturn.subtotal);
    returnVatCents += cents(purchaseReturn.vat);
    returnTotalCents += cents(purchaseReturn.total);
    for (const item of purchaseReturn.items || []) {
      returnedQty += Number(item.qty || 0);
      returnStockValueCents += cents(item.stockValue);
    }
  }

  let grossInvoiceSubtotalCents = 0;
  let grossInvoiceVatCents = 0;
  let grossInvoiceTotalCents = 0;
  let voidSubtotalCents = 0;
  let voidVatCents = 0;
  let voidTotalCents = 0;
  let grossPaidCents = 0;
  let reversedCents = 0;
  const methods = new Map();

  for (const event of allEvents) {
    const source = event.type === 'payment' || event.type === 'payment_reversal'
      ? paymentsById.get(idOf(event.sourceId))
      : invoicesById.get(idOf(event.sourceId));
    const supplier = addSupplier(bySupplier, source?.supplier);
    const balanceChange = Number(event.debit || 0) - Number(event.credit || 0);
    supplier.due += balanceChange;
    if (period.fromDate && event.date < period.fromDate) supplier.openingDue += balanceChange;
    if (!periodEvent(event, period)) continue;

    if (event.type === 'invoice') {
      const values = lineValues(source);
      grossInvoiceSubtotalCents += values.subtotal;
      grossInvoiceVatCents += values.vat;
      grossInvoiceTotalCents += values.total;
      supplier.grossInvoiced += Number(event.debit || 0);
    } else if (event.type === 'invoice_void') {
      const values = lineValues(source);
      voidSubtotalCents += values.subtotal;
      voidVatCents += values.vat;
      voidTotalCents += values.total;
      supplier.voided += Number(event.credit || 0);
    } else if (event.type === 'payment' || event.type === 'payment_reversal') {
      const amountCents = cents(source?.amount || event.credit || event.debit);
      const method = source?.method || event.method || 'unknown';
      const methodRow = methods.get(method) || {method, count: 0, reversalCount: 0, grossPaid: 0, reversed: 0, netPaid: 0};
      if (event.type === 'payment') {
        grossPaidCents += amountCents;
        supplier.grossPaid += Number(event.credit || 0);
        methodRow.count += 1;
        methodRow.grossPaid += Number(event.credit || 0);
      } else {
        reversedCents += amountCents;
        supplier.reversed += Number(event.debit || 0);
        methodRow.reversalCount += 1;
        methodRow.reversed += Number(event.debit || 0);
      }
      methods.set(method, methodRow);
    }
  }

  let purchaseValueCents = 0;
  let returnLedgerValueCents = 0;
  let ledgerPurchaseQty = 0;
  let ledgerReturnQty = 0;
  for (const transaction of transactions) {
    if (transaction.type === 'PURCHASE') {
      purchaseValueCents += cents(Math.abs(Number(transaction.totalCost || 0)));
      ledgerPurchaseQty += Math.abs(Number(transaction.changeQty || 0));
    } else {
      returnLedgerValueCents += cents(Math.abs(Number(transaction.totalCost || 0)));
      ledgerReturnQty += Math.abs(Number(transaction.changeQty || 0));
    }
  }

  for (const row of bySupplier.values()) {
    row.orderedValue = money(row.orderedValue);
    row.acceptedValue = money(row.acceptedValue);
    row.damagedValue = money(row.damagedValue);
    row.returnedValue = money(row.returnedValue);
    row.grossInvoiced = money(row.grossInvoiced);
    row.voided = money(row.voided);
    row.invoiced = money(row.grossInvoiced - row.voided);
    row.grossPaid = money(row.grossPaid);
    row.reversed = money(row.reversed);
    row.paid = money(row.grossPaid - row.reversed);
    row.openingDue = money(row.openingDue);
    row.due = money(row.due);
  }

  const purchaseDifference = fromCents(acceptedValueCents - purchaseValueCents);
  const returnDifference = fromCents(returnStockValueCents - returnLedgerValueCents);
  const netReceiptStockCents = acceptedValueCents - returnStockValueCents;
  const netLedgerStockCents = purchaseValueCents - returnLedgerValueCents;
  const netDifference = fromCents(netReceiptStockCents - netLedgerStockCents);
  const openingBalanceCents = period.fromDate
    ? allEvents.filter(event => event.date < period.fromDate).reduce((sum, event) => sum + cents(event.debit) - cents(event.credit), 0)
    : 0;
  const closingBalanceCents = allEvents.reduce((sum, event) => sum + cents(event.debit) - cents(event.credit), 0);
  const invoicePeriodCount = periodEvents.filter(event => event.type === 'invoice').length;
  const voidPeriodCount = periodEvents.filter(event => event.type === 'invoice_void').length;
  const paymentPeriodCount = periodEvents.filter(event => event.type === 'payment').length;
  const reversalPeriodCount = periodEvents.filter(event => event.type === 'payment_reversal').length;
  const netInvoiceSubtotalCents = grossInvoiceSubtotalCents - voidSubtotalCents;
  const netInvoiceVatCents = grossInvoiceVatCents - voidVatCents;
  const netInvoiceTotalCents = grossInvoiceTotalCents - voidTotalCents;
  const netPaidCents = grossPaidCents - reversedCents;
  const matchingRows = periodEvents
    .filter(event => event.type === 'invoice')
    .map(event => invoicesById.get(idOf(event.sourceId)))
    .filter(Boolean);
  const matchingByStatus = countBy(matchingRows, invoice => invoice.matching?.status || 'unlinked');
  const matchingExceptions = Object.entries(matchingByStatus)
    .filter(([status]) => !['matched'].includes(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const legacyVoidWithoutTimestamp = invoices.filter(invoice => invoice.status === 'void' && !invoice.voidedAt).length;

  const responsePeriod = {
    from: period.from,
    to: period.to,
    asOf: period.asOf,
    timezone: period.timezone,
    dateFields: {
      purchaseOrders: 'orderDate',
      receipts: 'receivedAt',
      returns: 'returnedAt',
      invoices: 'invoiceDate/voidedAt',
      payments: 'paidAt/reversedAt',
      ledger: 'createdAt'
    }
  };

  return {
    generatedAt: new Date(),
    currency: 'NPR',
    vatConvention: 'Recorded line rates; restaurant default 13%',
    scope: branch ? 'branch' : 'restaurant',
    restaurant: String(identity.restaurantId),
    branch: branch ? {_id: String(branch._id), name: branch.name, code: branch.code, active: branch.active !== false} : null,
    period: responsePeriod,
    purchaseOrders: {
      count: purchaseOrders.length,
      statusCounts: countBy(purchaseOrders, order => order.status),
      orderedQty,
      orderedValue: fromCents(orderedValueCents),
      receivedQty: lifecycleReceivedQty,
      damagedQty: lifecycleDamagedQty,
      acceptedQty: lifecycleReceivedQty - lifecycleDamagedQty,
      returnedQty: lifecycleReturnedQty,
      outstandingQty,
      shortClosedQty,
      shortClosedCount: purchaseOrders.filter(order => order.status === 'closed_short').length,
      partialCount: purchaseOrders.filter(order => order.status === 'partially_received').length,
      lifecycle: {
        receivedQty: lifecycleReceivedQty,
        damagedQty: lifecycleDamagedQty,
        acceptedQty: lifecycleReceivedQty - lifecycleDamagedQty,
        returnedQty: lifecycleReturnedQty,
        netAcceptedQty: lifecycleReceivedQty - lifecycleDamagedQty - lifecycleReturnedQty
      }
    },
    receipts: {
      count: receipts.length,
      receivedQty,
      acceptedQty,
      damagedQty,
      receivedValue: fromCents(receivedValueCents),
      acceptedValue: fromCents(acceptedValueCents),
      damagedValue: fromCents(damagedValueCents),
      damageByReason: [...damageReasons.values()]
        .map(item => ({...item, value: money(item.value)}))
        .sort((left, right) => right.value - left.value || left.reason.localeCompare(right.reason))
    },
    returns: {
      count: returns.length,
      qty: returnedQty,
      subtotal: fromCents(returnSubtotalCents),
      vat: fromCents(returnVatCents),
      value: fromCents(returnSubtotalCents),
      total: fromCents(returnTotalCents),
      stockValue: fromCents(returnStockValueCents)
    },
    invoices: {
      count: invoicePeriodCount,
      voidedCount: voidPeriodCount,
      grossSubtotal: fromCents(grossInvoiceSubtotalCents),
      grossVat: fromCents(grossInvoiceVatCents),
      grossInvoiced: fromCents(grossInvoiceTotalCents),
      voidedSubtotal: fromCents(voidSubtotalCents),
      voidedVat: fromCents(voidVatCents),
      voided: fromCents(voidTotalCents),
      subtotal: fromCents(netInvoiceSubtotalCents),
      vat: fromCents(netInvoiceVatCents),
      invoiced: fromCents(netInvoiceTotalCents),
      paymentCount: paymentPeriodCount,
      reversalCount: reversalPeriodCount,
      grossPaid: fromCents(grossPaidCents),
      reversed: fromCents(reversedCents),
      paid: fromCents(netPaidCents),
      openingDue: fromCents(openingBalanceCents),
      activityChange: fromCents(netInvoiceTotalCents - netPaidCents),
      due: fromCents(closingBalanceCents),
      matching: {byStatus: matchingByStatus, exceptions: matchingExceptions},
      paymentMethods: [...methods.values()].map(item => ({
        ...item,
        grossPaid: money(item.grossPaid),
        reversed: money(item.reversed),
        netPaid: money(item.grossPaid - item.reversed)
      })).sort((left, right) => right.netPaid - left.netPaid || left.method.localeCompare(right.method))
    },
    ledger: {
      purchaseQty: ledgerPurchaseQty,
      returnQty: ledgerReturnQty,
      netQty: ledgerPurchaseQty - ledgerReturnQty,
      purchaseValue: fromCents(purchaseValueCents),
      returnValue: fromCents(returnLedgerValueCents),
      netStockValue: fromCents(netLedgerStockCents)
    },
    reconciliation: {
      receiptsToPurchaseLedger: {
        sourceValue: fromCents(acceptedValueCents),
        ledgerValue: fromCents(purchaseValueCents),
        difference: purchaseDifference,
        balanced: Math.abs(purchaseDifference) < EPSILON
      },
      returnsToReturnLedger: {
        sourceValue: fromCents(returnStockValueCents),
        ledgerValue: fromCents(returnLedgerValueCents),
        difference: returnDifference,
        balanced: Math.abs(returnDifference) < EPSILON
      },
      netStock: {
        sourceValue: fromCents(netReceiptStockCents),
        ledgerValue: fromCents(netLedgerStockCents),
        difference: netDifference,
        balanced: Math.abs(netDifference) < EPSILON
      },
      balanced: Math.abs(purchaseDifference) < EPSILON && Math.abs(returnDifference) < EPSILON
    },
    dataQuality: {
      invoiceMatchingExceptions: matchingExceptions,
      legacyVoidsWithoutTimestamp: legacyVoidWithoutTimestamp,
      warnings: [
        ...(matchingExceptions ? [`${matchingExceptions} period invoice(s) require matching review`] : []),
        ...(legacyVoidWithoutTimestamp ? [`${legacyVoidWithoutTimestamp} legacy void invoice(s) lack an effective timestamp and are excluded`] : []),
        ...(Math.abs(purchaseDifference) >= EPSILON ? ['Accepted receipt value does not match purchase ledger value for the period'] : []),
        ...(Math.abs(returnDifference) >= EPSILON ? ['Returned stock value does not match return ledger value for the period'] : [])
      ]
    },
    activity: {
      eventCount: purchaseOrders.length + receipts.length + returns.length + periodEvents.length + transactions.length,
      empty: purchaseOrders.length === 0 && receipts.length === 0 && returns.length === 0 && periodEvents.length === 0 && transactions.length === 0
    },
    bySupplier: [...bySupplier.values()].sort((left, right) =>
      right.due - left.due || right.orderedValue - left.orderedValue || left.name.localeCompare(right.name)
    )
  };
}
