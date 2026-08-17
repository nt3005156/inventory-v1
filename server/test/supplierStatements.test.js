import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {Supplier} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {buildStatementLines, statementPeriod} from '../src/services/statements.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {daysAgo, daysAhead, today} from './dates.js';


// Relative anchors. The API validates against the real Kathmandu clock and
// reconstructs state "as of" a date, so these must track today rather than a
// fixed calendar. Intervals are preserved exactly as the assertions expect.
const FUTURE_DATE = daysAhead(1);
const RANGE_LATE = daysAgo(1);
const RANGE_EARLY = daysAgo(10);
const SAME_DAY = daysAgo(2);

// Reversal/void happen now, so "before" must be strictly earlier than today.
const AFTER_EVENT = today();
const BEFORE_EVENT = daysAgo(1);
const HIST_INVOICE = daysAgo(7);
const HIST_DUE = daysAgo(5);
const HIST_PAYMENT = daysAgo(5);

// Aging window: OPENING sits one bucket older than the in-period invoice.
const PERIOD_TO = daysAgo(17);
const PERIOD_FROM = daysAgo(47);
const PERIOD_INVOICE = daysAgo(38);
const PERIOD_DUE = daysAgo(33);
const PERIOD_PAYMENT = daysAgo(28);
const OPENING_INVOICE = daysAgo(77);
const OPENING_DUE = daysAgo(63);

let world;
let supplier;
let sequence;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Statement Test Supplier'});
  sequence = 0;
});

function createInvoice(overrides = {}, {branch = world.branchA, user = world.manager} = {}) {
  sequence += 1;
  return request('/api/supplier-invoices', {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': `statement-invoice-${sequence}`},
    body: {
      branch: String(branch._id),
      supplier: String(supplier._id),
      invoiceNo: `STMT-${sequence}`,
      invoiceDate: SAME_DAY,
      subtotal: 100,
      ...overrides
    }
  });
}

function postPayment(invoice, overrides = {}, {user = world.manager} = {}) {
  sequence += 1;
  return request(`/api/supplier-invoices/${invoice._id || invoice}/payments`, {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': `statement-payment-${sequence}`},
    body: {amount: 10, method: 'cash', ...overrides}
  });
}

function statement(query = {}, user = world.owner) {
  const search = new URLSearchParams({branch: String(world.branchA._id), ...query});
  return request(`/api/suppliers/${supplier._id}/statement?${search}`, {token: tokenFor(user)});
}

describe('supplier statement period validation and deterministic ledger', () => {
  it('rejects malformed dates, reversed ranges, and unsafe pagination', async () => {
    for (const query of [
      {from: '2026/08/01'},
      {to: '2026-02-30'},
      {from: RANGE_LATE, to: RANGE_EARLY},
      {to: FUTURE_DATE},
      {page: '0'},
      {limit: '501'}
    ]) {
      const response = await statement(query);
      assert.equal(response.status, 400, `${JSON.stringify(query)}: ${response.body?.message}`);
    }
  });

  it('orders same-time invoices before payments and preserves balances across pages', async () => {
    const first = await createInvoice({invoiceNo: 'SAME-1', invoiceDate: SAME_DAY, subtotal: 100});
    const second = await createInvoice({invoiceNo: 'SAME-2', invoiceDate: SAME_DAY, subtotal: 200});
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(second.status, 201, second.body?.message);
    assert.equal((await postPayment(first.body, {amount: 13, paidAt: SAME_DAY})).status, 201);
    assert.equal((await postPayment(second.body, {amount: 26, paidAt: SAME_DAY})).status, 201);

    const firstPage = await statement({from: SAME_DAY, to: SAME_DAY, page: '1', limit: '2'});
    const secondPage = await statement({from: SAME_DAY, to: SAME_DAY, page: '2', limit: '2'});
    assert.equal(firstPage.status, 200, firstPage.body?.message);
    assert.deepEqual(firstPage.body.lines.map(line => line.type), ['invoice', 'invoice']);
    assert.deepEqual(firstPage.body.lines.map(line => line.ref), ['SAME-1', 'SAME-2']);
    assert.deepEqual(firstPage.body.linePagination, {page: 1, limit: 2, total: 4, pages: 2});
    assert.deepEqual(secondPage.body.lines.map(line => line.type), ['payment', 'payment']);
    assert.deepEqual(secondPage.body.lines.map(line => line.balance), [326, 300]);
    assert.equal(secondPage.body.summary.closingBalance, 300);
  });

  it('keeps the pure ledger builder deterministic without database state', () => {
    const invoices = [
      {_id: 'b', invoiceNo: 'B', invoiceDate: new Date(`${SAME_DAY}T00:00:00.000Z`), total: 20, status: 'unpaid', createdAt: new Date(`${SAME_DAY}T00:00:02Z`)},
      {_id: 'a', invoiceNo: 'A', invoiceDate: new Date(`${SAME_DAY}T00:00:00.000Z`), total: 10, status: 'unpaid', createdAt: new Date(`${SAME_DAY}T00:00:01Z`)}
    ];
    const payments = [{
      _id: 'p', paymentNo: 'PAY', invoice: {_id: 'a', invoiceNo: 'A'}, paidAt: new Date(`${SAME_DAY}T00:00:00.000Z`),
      amount: 5, method: 'cash', status: 'posted', createdAt: new Date(`${SAME_DAY}T00:00:00Z`)
    }];
    const result = buildStatementLines(invoices, payments, {period: statementPeriod({from: SAME_DAY, to: SAME_DAY})});
    assert.deepEqual(result.lines.map(line => line.ref), ['A', 'B', 'PAY']);
    assert.deepEqual(result.lines.map(line => line.balance), [10, 30, 25]);
  });
});

describe('supplier statement balances and aging', () => {
  it('separates opening balance, period activity, closing balance, and aging buckets', async () => {
    const opening = await createInvoice({invoiceNo: 'OPENING', invoiceDate: OPENING_INVOICE, dueDate: OPENING_DUE, subtotal: 100});
    const current = await createInvoice({invoiceNo: 'JULY', invoiceDate: PERIOD_INVOICE, dueDate: PERIOD_DUE, subtotal: 200});
    assert.equal(opening.status, 201, opening.body?.message);
    assert.equal(current.status, 201, current.body?.message);
    assert.equal((await postPayment(current.body, {amount: 50, paidAt: PERIOD_PAYMENT})).status, 201);

    const response = await statement({from: PERIOD_FROM, to: PERIOD_TO});
    assert.equal(response.status, 200, response.body?.message);
    assert.deepEqual(response.body.period, {from: PERIOD_FROM, to: PERIOD_TO, asOf: PERIOD_TO, timezone: 'Asia/Kathmandu'});
    assert.deepEqual(response.body.summary, {
      openingBalance: 113,
      periodInvoiced: 226,
      periodPayments: 50,
      periodReversals: 0,
      periodVoids: 0,
      periodDebits: 226,
      periodCredits: 50,
      closingBalance: 289
    });
    assert.equal(response.body.invoiced, 339);
    assert.equal(response.body.paid, 50);
    assert.equal(response.body.balance, 289);
    assert.deepEqual(response.body.lines.map(line => line.balance), [339, 289]);
    assert.equal(response.body.aging.totalDue, 289);
    assert.equal(response.body.aging.days1To30, 176);
    assert.equal(response.body.aging.days31To60, 113);
    assert.equal(response.body.aging.overdue, 289);
    assert.equal(response.body.aging.openInvoiceCount, 2);
    assert.deepEqual(response.body.reconciliation, {ledgerBalance: 289, agingBalance: 289, difference: 0, balanced: true});
    assert.equal(response.body.openInvoices.find(invoice => invoice.invoiceNo === 'OPENING').daysOverdue, 46);
  });

  it('reconstructs payment and reversal state at the requested as-of date', async () => {
    const invoice = await createInvoice({invoiceNo: 'HISTORICAL', invoiceDate: HIST_INVOICE, dueDate: HIST_DUE, subtotal: 100});
    const paid = await postPayment(invoice.body, {amount: 40, paidAt: HIST_PAYMENT});
    assert.equal(paid.status, 201, paid.body?.message);
    const reversed = await request(`/api/supplier-payments/${paid.body.payment._id}/reverse`, {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'statement-historical-reversal'},
      body: {reason: 'Historical statement reversal test'}
    });
    assert.equal(reversed.status, 201, reversed.body?.message);

    const beforeReversal = await statement({to: BEFORE_EVENT});
    assert.equal(beforeReversal.status, 200, beforeReversal.body?.message);
    assert.equal(beforeReversal.body.paid, 40);
    assert.equal(beforeReversal.body.balance, 73);
    assert.deepEqual(beforeReversal.body.lines.map(line => line.type), ['invoice', 'payment']);
    assert.equal(beforeReversal.body.aging.totalDue, 73);
    assert.equal(beforeReversal.body.payments[0].status, 'posted');
    assert.equal(beforeReversal.body.payments[0].currentStatus, 'reversed');
    assert.equal(beforeReversal.body.payments[0].reversalEffectiveAfterAsOf, true);

    const afterReversal = await statement({to: AFTER_EVENT});
    assert.equal(afterReversal.body.paid, 0);
    assert.equal(afterReversal.body.balance, 113);
    assert.equal(afterReversal.body.summary.periodReversals, 40);
    assert.deepEqual(afterReversal.body.lines.map(line => line.type), ['invoice', 'payment', 'payment_reversal']);
    assert.equal(afterReversal.body.aging.totalDue, 113);

    const balance = await request(`/api/suppliers/${supplier._id}/balance?branch=${world.branchA._id}&asOf=${BEFORE_EVENT}`, {token: tokenFor(world.owner)});
    assert.equal(balance.status, 200, balance.body?.message);
    assert.equal(balance.body.asOf, BEFORE_EVENT);
    assert.equal(balance.body.balance, 73);
    assert.equal(balance.body.aging.totalDue, 73);
  });

  it('includes an invoice before its void timestamp and excludes it afterward', async () => {
    const created = await createInvoice({invoiceNo: 'VOID-HISTORY', invoiceDate: HIST_INVOICE, subtotal: 100});
    assert.equal(created.status, 201, created.body?.message);
    const voided = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'void', expectedVersion: created.body.__v}
    });
    assert.equal(voided.status, 200, voided.body?.message);

    const historical = await statement({to: BEFORE_EVENT});
    assert.equal(historical.status, 200, historical.body?.message);
    assert.equal(historical.body.balance, 113);
    assert.deepEqual(historical.body.lines.map(line => line.ref), ['VOID-HISTORY']);
    assert.equal(historical.body.invoices[0].status, 'unpaid');
    assert.equal(historical.body.invoices[0].currentStatus, 'void');
    assert.equal(historical.body.invoices[0].voidEffectiveAfterAsOf, true);

    const current = await statement({to: AFTER_EVENT});
    assert.equal(current.status, 200, current.body?.message);
    assert.equal(current.body.balance, 0);
    assert.deepEqual(current.body.lines.map(line => line.type), ['invoice', 'invoice_void']);
    assert.deepEqual(current.body.lines.map(line => line.balance), [113, 0]);
    assert.equal(current.body.summary.periodVoids, 113);
    assert.equal(current.body.reconciliation.balanced, true);

    const voidPeriod = await statement({from: AFTER_EVENT, to: AFTER_EVENT});
    assert.equal(voidPeriod.status, 200, voidPeriod.body?.message);
    assert.equal(voidPeriod.body.summary.openingBalance, 113);
    assert.equal(voidPeriod.body.summary.periodCredits, 113);
    assert.equal(voidPeriod.body.summary.closingBalance, 0);
    assert.deepEqual(voidPeriod.body.lines.map(line => line.type), ['invoice_void']);
  });
});

describe('supplier statement authorization and scope', () => {
  it('enforces roles, restaurant ownership, and manager branch isolation', async () => {
    assert.equal((await createInvoice({invoiceNo: 'KTM', subtotal: 100})).status, 201);
    assert.equal((await createInvoice({invoiceNo: 'LTP', subtotal: 200}, {branch: world.branchB, user: world.owner})).status, 201);

    const ownerAll = await request(`/api/suppliers/${supplier._id}/statement`, {token: tokenFor(world.owner)});
    assert.equal(ownerAll.status, 200, ownerAll.body?.message);
    assert.equal(ownerAll.body.scope, 'restaurant');
    assert.equal(ownerAll.body.invoiced, 339);

    const managerOwn = await statement({}, world.manager);
    assert.equal(managerOwn.status, 200, managerOwn.body?.message);
    assert.equal(managerOwn.body.invoiced, 113);
    const managerOther = await request(`/api/suppliers/${supplier._id}/statement?branch=${world.branchB._id}`, {token: tokenFor(world.manager)});
    assert.equal(managerOther.status, 403);
    assert.equal((await statement({}, world.staffA)).status, 403);
    assert.equal((await request(`/api/suppliers/${supplier._id}/statement`)).status, 401);

    const foreignRestaurant = await Restaurant.create({name: 'Foreign Restaurant', currency: 'NPR', vatRate: 13});
    await Branch.create({restaurant: foreignRestaurant._id, name: 'Foreign Branch', code: 'FOR'});
    const foreignSupplier = await Supplier.create({restaurant: foreignRestaurant._id, name: 'Foreign Supplier'});
    const hidden = await request(`/api/suppliers/${foreignSupplier._id}/statement`, {token: tokenFor(world.owner)});
    assert.equal(hidden.status, 404);
  });
});
