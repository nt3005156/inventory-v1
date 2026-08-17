import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, Supplier, User} from '../src/models/index.js';
import {
  Branch,
  Restaurant,
  SupplierInvoice,
  SupplierPayment,
  SupplierPaymentCounter
} from '../src/models/operations.js';
import {ensureSupplierPaymentIndexes} from '../src/services/supplierPaymentMigration.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {daysAgo, daysAhead} from './dates.js';


// Anchored to the real clock: the API rejects future payment dates, so these
// stay relative rather than pinned to a calendar day.
const FUTURE_DATE = daysAhead(1);
const PAYMENT_DATE = daysAgo(1);
const INVOICE_DATE = daysAgo(2);
const BEFORE_INVOICE = daysAgo(3);

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
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Payment Test Supplier'});
  sequence = 0;
});

function createInvoice(overrides = {}, {user = world.manager, key} = {}) {
  sequence += 1;
  return request('/api/supplier-invoices', {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': key || `payment-invoice-${sequence}`},
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      invoiceNo: `PAY-INV-${sequence}`,
      invoiceDate: INVOICE_DATE,
      subtotal: 1000,
      ...overrides
    }
  });
}

function postPayment(invoice, body = {}, {user = world.manager, key = `payment-${++sequence}`} = {}) {
  return request(`/api/supplier-invoices/${invoice._id || invoice}/payments`, {
    method: 'POST',
    token: tokenFor(user),
    headers: key ? {'Idempotency-Key': key} : {},
    body: {amount: 100, method: 'cash', ...body}
  });
}

function reversePayment(payment, body = {}, {user = world.owner, key = `payment-reversal-${++sequence}`} = {}) {
  return request(`/api/supplier-payments/${payment._id || payment}/reverse`, {
    method: 'POST',
    token: tokenFor(user),
    headers: key ? {'Idempotency-Key': key} : {},
    body: {reason: 'Incorrect supplier payment', ...body}
  });
}

async function dropNonIdIndexes(model) {
  const indexes = await model.collection.indexes();
  for (const index of indexes) if (index.name !== '_id_') await model.collection.dropIndex(index.name);
}

describe('supplier payment migration and index repair', () => {
  it('backfills legacy ownership, numbers and aggregate-only balances with explicit evidence', async () => {
    await dropNonIdIndexes(SupplierPayment);
    await dropNonIdIndexes(SupplierPaymentCounter);
    await SupplierPayment.collection.createIndex({invoice: 1}, {name: 'invoice_1'});
    const created = await createInvoice({invoiceNo: 'LEGACY-PAY-1'});
    assert.equal(created.status, 201, created.body?.message);
    await SupplierInvoice.collection.updateOne(
      {_id: new mongoose.Types.ObjectId(created.body._id)},
      {$set: {paidAmount: 250, status: 'partial'}}
    );
    const legacyId = new mongoose.Types.ObjectId();
    await SupplierPayment.collection.insertOne({
      _id: legacyId,
      invoice: new mongoose.Types.ObjectId(created.body._id),
      supplier: supplier._id,
      amount: 100,
      method: 'bank',
      reference: 'OLD-BANK-1',
      paidAt: new Date(`${INVOICE_DATE}T00:00:00.000Z`),
      createdBy: world.manager._id,
      createdAt: new Date(`${INVOICE_DATE}T00:00:00.000Z`),
      updatedAt: new Date(`${INVOICE_DATE}T00:00:00.000Z`)
    });

    const result = await ensureSupplierPaymentIndexes();
    assert.equal(result.migrated, 2);
    assert.equal(result.synthesized, 1);
    assert.equal(result.droppedPaymentIndexes.includes('invoice_1'), true);
    const rows = await SupplierPayment.find({invoice: created.body._id})
      .select('+idempotencyKey +requestHash').sort({amount: 1}).lean();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.amount), [100, 150]);
    assert.deepEqual(rows.map(row => row.origin).sort(), ['legacy_invoice_balance', 'legacy_record']);
    assert.equal(rows.every(row => String(row.restaurant) === String(world.restaurant._id)), true);
    assert.equal(rows.every(row => String(row.branch) === String(world.branchA._id)), true);
    assert.equal(rows.every(row => row.idempotencyKey && /^[a-f0-9]{64}$/.test(row.requestHash)), true);
    assert.equal(rows.every(row => row.origin === 'recorded' || row.migrationSource), true);
    assert.equal(new Set(rows.map(row => row.paymentNo)).size, 2);
    const synthetic = rows.find(row => row.origin === 'legacy_invoice_balance');
    assert.equal(synthetic.method, 'legacy');
    assert.equal(synthetic.migrationSource, 'SupplierInvoice.paidAmount');
    assert.match(synthetic.idempotencyKey, /migration:supplier-payment:invoice-balance/);
    assert.ok(synthetic.requestHash);
    const invoice = await SupplierInvoice.findById(created.body._id).lean();
    assert.equal(invoice.paidAmount, 250);
    assert.equal(invoice.status, 'partial');
    const counter = await SupplierPaymentCounter.findOne({restaurant: world.restaurant._id, branchCode: 'KTM', year: 2026}).lean();
    assert.ok(counter.value >= 2);
    const indexNames = (await SupplierPayment.collection.indexes()).map(index => index.name);
    assert.equal(indexNames.includes('supplier_payment_restaurant_number'), true);
    assert.equal(indexNames.includes('supplier_payment_restaurant_idempotency'), true);
    assert.equal(indexNames.includes('supplier_payment_restaurant_branch_report_date'), true);
    assert.equal(indexNames.includes('supplier_payment_statement_scope_date'), true);
    assert.equal(indexNames.includes('supplier_payment_statement_branch_date'), true);

    await ensureSupplierPaymentIndexes();
    assert.equal(await SupplierPayment.countDocuments({invoice: created.body._id}), 2);
    assert.equal(await SupplierPayment.countDocuments({origin: 'legacy_invoice_balance'}), 1);

    const legacy = rows.find(row => row.origin === 'legacy_record');
    const reversed = await reversePayment(
      legacy._id,
      {reason: 'Correcting migrated supplier record'},
      {key: 'reverse-migrated-payment'}
    );
    assert.equal(reversed.status, 201, reversed.body?.message);
    assert.equal(reversed.body.payment.status, 'reversed');
    assert.equal(reversed.body.invoice.paidAmount, 150);
    assert.equal(reversed.body.invoice.status, 'partial');
  });

  it('rolls back payment and invoice migration writes when reconciliation persistence fails', async () => {
    await dropNonIdIndexes(SupplierPayment);
    const created = await createInvoice({invoiceNo: 'ROLLBACK-LEGACY-PAY'});
    assert.equal(created.status, 201, created.body?.message);
    const legacyId = new mongoose.Types.ObjectId();
    await SupplierPayment.collection.insertOne({
      _id: legacyId,
      invoice: new mongoose.Types.ObjectId(created.body._id),
      supplier: supplier._id,
      amount: 100,
      method: 'cash',
      paidAt: new Date(`${INVOICE_DATE}T00:00:00.000Z`),
      createdBy: world.manager._id
    });
    const originalBulkWrite = SupplierInvoice.collection.bulkWrite;
    SupplierInvoice.collection.bulkWrite = async () => { throw new Error('forced migration reconciliation failure'); };
    try {
      await assert.rejects(ensureSupplierPaymentIndexes(), /forced migration reconciliation failure/);
    } finally {
      SupplierInvoice.collection.bulkWrite = originalBulkWrite;
    }
    const payment = await SupplierPayment.collection.findOne({_id: legacyId});
    assert.equal(payment.restaurant, undefined);
    assert.equal(payment.paymentNo, undefined);
    const invoice = await SupplierInvoice.findById(created.body._id).lean();
    assert.equal(invoice.paidAmount, 0);
    assert.equal(invoice.status, 'unpaid');
    assert.equal(await SupplierPaymentCounter.countDocuments(), 0);
  });

  it('aborts before mutation for orphaned, cross-scope or overpaid legacy evidence', async () => {
    await dropNonIdIndexes(SupplierPayment);
    const created = await createInvoice({invoiceNo: 'BAD-LEGACY-PAY'});
    assert.equal(created.status, 201, created.body?.message);
    await SupplierPayment.collection.insertMany([
      {
        invoice: new mongoose.Types.ObjectId(created.body._id),
        supplier: supplier._id,
        branch: world.branchB._id,
        amount: 1200,
        method: 'cash',
        paidAt: new Date(`${INVOICE_DATE}T00:00:00.000Z`),
        createdBy: world.manager._id
      },
      {
        invoice: new mongoose.Types.ObjectId(),
        supplier: supplier._id,
        amount: 10,
        method: 'cash',
        paidAt: new Date(`${INVOICE_DATE}T00:00:00.000Z`),
        createdBy: world.manager._id
      }
    ]);
    await assert.rejects(ensureSupplierPaymentIndexes(), /cannot safely migrate ownership or financial data/);
    const rows = await SupplierPayment.collection.find({}).toArray();
    assert.equal(rows.length, 2);
    assert.equal(rows.every(row => row.restaurant === undefined), true);
    assert.equal(await SupplierPaymentCounter.countDocuments(), 0);
    const invoice = await SupplierInvoice.findById(created.body._id).lean();
    assert.equal(invoice.paidAmount, 0);
    assert.equal(invoice.status, 'unpaid');
  });
});

describe('POST /api/supplier-invoices/:id/payments', () => {
  it('validates money, method, reference, date and required idempotency identity', async () => {
    const created = await createInvoice();
    assert.equal(created.status, 201, created.body?.message);
    const invoice = created.body;
    assert.equal((await postPayment(invoice, {}, {key: null})).status, 400);
    assert.equal((await postPayment(invoice, {amount: 1.001}, {key: 'bad-decimal'})).status, 400);
    assert.equal((await postPayment(invoice, {method: 'bank'}, {key: 'missing-reference'})).status, 400);
    assert.equal((await postPayment(invoice, {method: 'cheque'}, {key: 'bad-method'})).status, 400);
    assert.equal((await postPayment(invoice, {paidAt: BEFORE_INVOICE}, {key: 'before-invoice'})).status, 400);
    assert.equal((await postPayment(invoice, {paidAt: FUTURE_DATE}, {key: 'future-payment'})).status, 400);

    const posted = await postPayment(invoice, {
      amount: 100.25,
      method: 'bank',
      reference: 'BANK-100',
      paidAt: PAYMENT_DATE,
      expectedInvoiceVersion: invoice.__v
    }, {key: 'valid-payment'});
    assert.equal(posted.status, 201, posted.body?.message);
    assert.equal(posted.body.duplicate, false);
    assert.equal(posted.body.payment.amount, 100.25);
    assert.equal(posted.body.payment.currency, 'NPR');
    assert.equal(posted.body.payment.status, 'posted');
    assert.equal(posted.body.payment.origin, 'recorded');
    assert.match(posted.body.payment.paymentNo, new RegExp(`^PAY-KTM-${INVOICE_DATE.slice(0, 4)}-\\d{6}$`));
    assert.equal(posted.body.invoice.paidAmount, 100.25);
    assert.equal(posted.body.invoice.status, 'partial');
    assert.equal(posted.body.payment.idempotencyKey, undefined);
    const durable = await SupplierPayment.findById(posted.body.payment._id).select('+idempotencyKey +requestHash').lean();
    assert.equal(durable.idempotencyKey, 'valid-payment');
    assert.ok(durable.requestHash);
    assert.equal(await Audit.countDocuments({entity: 'supplier_payment', action: 'post'}), 1);
  });

  it('replays the same payload, rejects key reuse, overpayment and stale invoice versions', async () => {
    const firstInvoice = (await createInvoice({invoiceNo: 'REPLAY-PAY-1'})).body;
    const first = await postPayment(firstInvoice, {amount: 300}, {key: 'stable-payment'});
    assert.equal(first.status, 201, first.body?.message);
    const replay = await postPayment(firstInvoice, {amount: 300}, {key: 'stable-payment'});
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.payment._id, first.body.payment._id);
    assert.equal(await SupplierPayment.countDocuments({invoice: firstInvoice._id}), 1);
    assert.equal(await Audit.countDocuments({entity: 'supplier_payment', action: 'post'}), 1);

    const changed = await postPayment(firstInvoice, {amount: 301}, {key: 'stable-payment'});
    assert.equal(changed.status, 409);
    assert.match(changed.body.message, /different supplier payment/);
    const secondInvoice = (await createInvoice({invoiceNo: 'REPLAY-PAY-2'})).body;
    assert.equal((await postPayment(secondInvoice, {amount: 10}, {key: 'stable-payment'})).status, 409);
    assert.equal((await postPayment(firstInvoice, {amount: 900}, {key: 'overpay'})).status, 409);
    assert.equal((await postPayment(firstInvoice, {
      amount: 10,
      expectedInvoiceVersion: firstInvoice.__v
    }, {key: 'stale-payment'})).status, 409);
  });

  it('serializes concurrent payments and never overstates the invoice balance', async () => {
    const invoice = (await createInvoice({invoiceNo: 'CONCURRENT-PAY'})).body;
    const results = await Promise.all([
      postPayment(invoice, {amount: 700}, {key: 'concurrent-payment-a'}),
      postPayment(invoice, {amount: 700}, {key: 'concurrent-payment-b'})
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    const durable = await SupplierInvoice.findById(invoice._id).lean();
    assert.equal(durable.paidAmount, 700);
    assert.equal(durable.status, 'partial');
    assert.equal(await SupplierPayment.countDocuments({invoice: invoice._id, status: 'posted'}), 1);
    assert.equal(await Audit.countDocuments({entity: 'supplier_payment', action: 'post'}), 1);
  });

  it('rolls back payment, invoice, counter and audit when the transaction fails', async () => {
    const invoice = (await createInvoice({invoiceNo: 'ROLLBACK-PAY'})).body;
    const originalCreate = Audit.create;
    Audit.create = async () => { throw new Error('forced payment audit failure'); };
    let response;
    try {
      response = await postPayment(invoice, {amount: 100}, {key: 'rollback-payment'});
    } finally {
      Audit.create = originalCreate;
    }
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.match(response.body.message, /forced payment audit failure/);
    assert.equal(await SupplierPayment.countDocuments({invoice: invoice._id}), 0);
    assert.equal(await SupplierPaymentCounter.countDocuments(), 0);
    assert.equal(await Audit.countDocuments({entity: 'supplier_payment'}), 0);
    const durable = await SupplierInvoice.findById(invoice._id).lean();
    assert.equal(durable.paidAmount, 0);
    assert.equal(durable.status, 'unpaid');
  });

  it('enforces role, branch and restaurant isolation for writes and payment history', async () => {
    const invoice = (await createInvoice({invoiceNo: 'ACL-PAY'})).body;
    const managerB = await User.create({
      name: 'Branch B Payment Manager', email: 'branch-b-payment@test.com', password: 'hashed', role: 'manager',
      restaurant: world.restaurant.name, restaurantId: world.restaurant._id, branch: world.branchB._id
    });
    assert.equal((await postPayment(invoice, {}, {user: world.staffA, key: 'staff-payment'})).status, 403);
    assert.equal((await postPayment(invoice, {}, {user: managerB, key: 'branch-payment'})).status, 403);
    assert.equal((await request(`/api/supplier-invoices/${invoice._id}/payments`, {token: tokenFor(managerB)})).status, 403);

    const otherRestaurant = await Restaurant.create({name: 'Other Payment Restaurant'});
    const otherBranch = await Branch.create({restaurant: otherRestaurant._id, name: 'Other Payment Branch', code: 'OPB'});
    const otherOwner = await User.create({
      name: 'Other Payment Owner', email: 'other-payment-owner@test.com', password: 'hashed', role: 'owner',
      restaurantId: otherRestaurant._id
    });
    const otherSupplier = await Supplier.create({restaurant: otherRestaurant._id, name: 'Other Payment Supplier'});
    const foreignInvoice = await request('/api/supplier-invoices', {
      method: 'POST', token: tokenFor(otherOwner), headers: {'Idempotency-Key': 'foreign-payment-invoice'},
      body: {branch: String(otherBranch._id), supplier: String(otherSupplier._id), invoiceNo: 'FOREIGN-PAY', subtotal: 100}
    });
    assert.equal(foreignInvoice.status, 201, foreignInvoice.body?.message);
    assert.equal((await postPayment(foreignInvoice.body, {}, {key: 'foreign-payment-attempt'})).status, 404);
    assert.equal((await request(`/api/supplier-invoices/${foreignInvoice.body._id}/payments`, {token: tokenFor(world.owner)})).status, 404);
    assert.equal(await SupplierPayment.countDocuments(), 0);
  });
});

describe('POST /api/supplier-payments/:id/reverse', () => {
  it('is owner-only, idempotent and restores invoice, statement and report balances while retaining history', async () => {
    const invoice = (await createInvoice({invoiceNo: 'REVERSE-PAY'})).body;
    const posted = await postPayment(invoice, {amount: 300, method: 'bank', reference: 'REV-BANK-1'}, {key: 'payment-to-reverse'});
    assert.equal(posted.status, 201, posted.body?.message);
    const payment = posted.body.payment;
    assert.equal((await reversePayment(payment, {}, {user: world.manager, key: 'manager-reversal'})).status, 403);
    assert.equal((await reversePayment(payment, {}, {key: null})).status, 400);

    const reversed = await reversePayment(payment, {
      reason: 'Duplicate payment entered by mistake',
      expectedInvoiceVersion: posted.body.invoice.__v
    }, {key: 'stable-payment-reversal'});
    assert.equal(reversed.status, 201, reversed.body?.message);
    assert.equal(reversed.body.duplicate, false);
    assert.equal(reversed.body.payment.status, 'reversed');
    assert.equal(reversed.body.invoice.paidAmount, 0);
    assert.equal(reversed.body.invoice.status, 'unpaid');
    assert.equal(String(reversed.body.payment.reversedBy._id), String(world.owner._id));
    assert.equal(reversed.body.payment.reversalReason, 'Duplicate payment entered by mistake');
    assert.equal(reversed.body.payment.reversalIdempotencyKey, undefined);
    assert.equal(await Audit.countDocuments({entity: 'supplier_payment', action: 'reverse'}), 1);

    const replay = await reversePayment(payment, {reason: 'Duplicate payment entered by mistake'}, {key: 'stable-payment-reversal'});
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.payment._id, payment._id);
    assert.equal(await Audit.countDocuments({entity: 'supplier_payment', action: 'reverse'}), 1);
    assert.equal((await reversePayment(payment, {reason: 'A different reversal reason'}, {key: 'stable-payment-reversal'})).status, 409);
    assert.equal((await reversePayment(payment, {}, {key: 'second-payment-reversal'})).status, 409);

    const history = await request(`/api/supplier-invoices/${invoice._id}/payments`, {token: tokenFor(world.manager)});
    assert.equal(history.status, 200, history.body?.message);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].status, 'reversed');
    const statement = await request(`/api/suppliers/${supplier._id}/statement?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(statement.status, 200, statement.body?.message);
    assert.equal(statement.body.invoiced, 1130);
    assert.equal(statement.body.paid, 0);
    assert.equal(statement.body.balance, 1130);
    assert.deepEqual(statement.body.lines.map(line => line.type), ['invoice', 'payment', 'payment_reversal']);
    assert.equal(statement.body.lines.at(-1).balance, 1130);
    assert.equal(statement.body.payments.length, 1);
    assert.equal(statement.body.payments[0].status, 'reversed');
    const report = await request(`/api/reports/purchasing?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(report.status, 200, report.body?.message);
    assert.equal(report.body.invoices.paid, 0);
    assert.equal(report.body.invoices.due, 1130);
    assert.equal(report.body.bySupplier[0].paid, 0);
    assert.equal(report.body.bySupplier[0].due, 1130);
  });

  it('rolls back reversal evidence and invoice restoration when audit persistence fails', async () => {
    const invoice = (await createInvoice({invoiceNo: 'ROLLBACK-REVERSAL'})).body;
    const posted = await postPayment(invoice, {amount: 200}, {key: 'rollback-reversal-payment'});
    assert.equal(posted.status, 201, posted.body?.message);
    const originalCreate = Audit.create;
    Audit.create = async () => { throw new Error('forced reversal audit failure'); };
    let response;
    try {
      response = await reversePayment(posted.body.payment, {}, {key: 'rollback-reversal'});
    } finally {
      Audit.create = originalCreate;
    }
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.match(response.body.message, /forced reversal audit failure/);
    const payment = await SupplierPayment.findById(posted.body.payment._id)
      .select('+reversalIdempotencyKey +reversalRequestHash').lean();
    assert.equal(payment.status, 'posted');
    assert.equal(payment.reversedAt, undefined);
    assert.equal(payment.reversalIdempotencyKey, undefined);
    const durableInvoice = await SupplierInvoice.findById(invoice._id).lean();
    assert.equal(durableInvoice.paidAmount, 200);
    assert.equal(durableInvoice.status, 'partial');
    assert.equal(await Audit.countDocuments({entity: 'supplier_payment', action: 'reverse'}), 0);
  });
});
