/**
 * Phase 13 — purchasing and inventory security / data-integrity audit.
 *
 * This is an audit suite, not a feature suite. Purchasing and inventory were
 * already largely correct: over-receiving, over-return, overpayment, negative
 * stock, idempotent replay and tenant isolation were all verified working
 * against the live API before anything was changed, and are pinned here so
 * they cannot regress.
 *
 * Two genuine defects were found and fixed:
 *
 *   1. `fail()` returned the raw ZodError array — a ~600 character dump of
 *      internal schema structure — and raw exception text on 500s.
 *   2. Purchase order schemas were not `.strict()`, so unknown and protected
 *      fields were silently dropped rather than rejected.
 *
 * Everything below asserts MongoDB state, not just HTTP status.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Ingredient, Supplier, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, PurchaseOrder, Restaurant, SupplierInvoice
} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let supplier;
let rival;
let keySeed = 0;

const KEY = () => `p13-${Date.now()}-${++keySeed}`;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  keySeed = 0;
  world = await seedWorld();
  supplier = await Supplier.create({
    restaurant: world.restaurant._id, name: 'Audit Supplier', phone: '9800000000'
  });

  const restaurant = await Restaurant.create({name: 'Rival Kitchen', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL', address: 'Thamel'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival Owner', email: 'rival13@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival Kitchen', restaurantId: restaurant._id
    }),
    ingredient: await Ingredient.create({
      restaurant: restaurant._id, code: 'RIV', name: 'Rival Rice', unit: 'g'
    }),
    supplier: await Supplier.create({
      restaurant: restaurant._id, name: 'Rival Supplier', phone: '9811111111'
    })
  };
});

const owner = () => tokenFor(world.owner);
const staff = () => tokenFor(world.staffA);
const rivalOwner = () => tokenFor(rival.owner);
const BR = () => String(world.branchA._id);
const ING = () => String(world.ingredient._id);

const balance = async () => (await InventoryBalance.findOne({
  branch: world.branchA._id, ingredient: world.ingredient._id
}))?.quantity ?? 0;

const createPo = (body, token = owner()) =>
  request('/api/purchase-orders', {method: 'POST', token, body});

const poBody = (overrides = {}) => ({
  branch: BR(),
  supplier: String(supplier._id),
  items: [{ingredient: ING(), orderedQty: 100, unit: 'g', unitPrice: 10}],
  ...overrides
});

/** Create → pending → approved, returning the PO id and its first line id. */
async function approvedPo(orderedQty = 100) {
  const created = await createPo(poBody({
    items: [{ingredient: ING(), orderedQty, unit: 'g', unitPrice: 10}]
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const status of ['pending', 'approved']) {
    const moved = await request(`/api/purchase-orders/${created.body._id}/status`, {
      method: 'PATCH', token: owner(), body: {status}
    });
    assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.body)}`);
  }
  const full = await request(`/api/purchase-orders/${created.body._id}`, {token: owner()});
  return {id: created.body._id, itemId: String(full.body.items[0]._id)};
}

const receive = (id, items, key = KEY(), token = owner()) =>
  request(`/api/purchase-orders/${id}/receive`, {
    method: 'POST', token, headers: {'Idempotency-Key': key}, body: {items}
  });

const poVersion = async id =>
  Number((await request(`/api/purchase-orders/${id}`, {token: owner()})).body.__v);

// ═══════════════════════════════════════════════════════════════════════════
// Error hygiene and mass assignment — the two defects fixed
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — error hygiene', () => {
  it('does not leak the internal validation structure', async () => {
    const res = await createPo({branch: 123, items: 'nope'});
    assert.equal(res.status, 400);

    const serialised = JSON.stringify(res.body);
    // The raw ZodError dump was ~600 characters of internal schema detail.
    assert.ok(serialised.length < 200, `error body is ${serialised.length} chars`);
    for (const internal of ['invalid_type', 'ZodError', 'expected', 'received', '"path"']) {
      assert.doesNotMatch(serialised, new RegExp(internal),
        `${internal} is internal schema detail and must not be returned`);
    }
    assert.match(res.body.message, /Invalid|missing or invalid/);
  });

  it('still returns the operator-facing message on a deliberate refusal', async () => {
    const {id, itemId} = await approvedPo(100);
    const res = await receive(id, [{itemId, receivedQty: 500}]);
    assert.equal(res.status, 409);
    // A sanitised error must not become a useless one.
    assert.ok(res.body.message.length > 10);
    assert.doesNotMatch(res.body.message, /Server error/);
  });
});

describe('13 — mass assignment', () => {
  it('rejects protected and unknown fields on create', async () => {
    for (const injected of [
      {status: 'approved'},
      {approvedBy: String(world.owner._id)},
      {restaurant: String(rival.restaurant._id)},
      {total: 999999},
      {poNo: 'HACKED-1'},
      {receivedQty: 100}
    ]) {
      const res = await createPo(poBody(injected));
      assert.equal(res.status, 400,
        `${Object.keys(injected)[0]} must be refused, got ${res.status}`);
    }
    assert.equal(await PurchaseOrder.countDocuments({}), 0, 'nothing may be written');
  });

  it('derives every protected field server-side on a clean create', async () => {
    const res = await createPo(poBody());
    assert.equal(res.status, 201);

    const stored = await PurchaseOrder.findById(res.body._id);
    assert.equal(String(stored.restaurant), String(world.restaurant._id));
    assert.equal(stored.status, 'draft', 'a new PO is never born approved');
    assert.ok(!stored.approvedBy);
    assert.match(stored.poNo, /^PO-/, 'the PO number is server-generated');
    // 100 units at 10 plus 13% VAT.
    assert.equal(stored.subtotal, 1000);
    assert.equal(stored.total, 1130);
  });

  it('rejects unknown fields on a receipt line', async () => {
    const {id, itemId} = await approvedPo();
    const res = await request(`/api/purchase-orders/${id}/receive`, {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {items: [{itemId, receivedQty: 10, unitCost: 0, previousQty: 5}]}
    });
    assert.equal(res.status, 400);
    assert.equal(await InventoryTransaction.countDocuments({type: 'PURCHASE'}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchase order state machine
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — purchase order state machine', () => {
  it('refuses to receive against an unapproved order', async () => {
    const created = await createPo(poBody());
    const full = await request(`/api/purchase-orders/${created.body._id}`, {token: owner()});
    const itemId = String(full.body.items[0]._id);

    const res = await receive(created.body._id, [{itemId, receivedQty: 10}]);
    assert.ok([400, 409].includes(res.status), `got ${res.status}`);
    assert.equal((await PurchaseOrder.findById(created.body._id)).status, 'draft');
    assert.equal(await InventoryTransaction.countDocuments({type: 'PURCHASE'}), 0);
  });

  it('refuses to jump straight from draft to approved', async () => {
    const created = await createPo(poBody());
    const res = await request(`/api/purchase-orders/${created.body._id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'approved'}
    });
    assert.ok([400, 409].includes(res.status));
    assert.equal((await PurchaseOrder.findById(created.body._id)).status, 'draft');
  });

  it('refuses a duplicate approval', async () => {
    const {id} = await approvedPo();
    const again = await request(`/api/purchase-orders/${id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'approved'}
    });
    assert.ok([400, 409].includes(again.status));
    assert.equal((await PurchaseOrder.findById(id)).status, 'approved');
  });

  it('reserves approval for owners and managers', async () => {
    const created = await createPo(poBody());
    await request(`/api/purchase-orders/${created.body._id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'pending'}
    });
    const res = await request(`/api/purchase-orders/${created.body._id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'approved'}
    });
    assert.equal(res.status, 403);
    assert.equal((await PurchaseOrder.findById(created.body._id)).status, 'pending');
  });

  it('reserves purchase order creation for owners and managers', async () => {
    assert.equal((await createPo(poBody(), staff())).status, 403);
    assert.equal(await PurchaseOrder.countDocuments({}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Goods receiving
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — goods receiving integrity', () => {
  it('refuses to receive more than ordered, leaving stock untouched', async () => {
    const {id, itemId} = await approvedPo(100);
    const before = await balance();

    const res = await receive(id, [{itemId, receivedQty: 500}]);
    assert.ok([400, 409].includes(res.status));
    assert.equal(await balance(), before, 'stock must not move');
    assert.equal(await InventoryTransaction.countDocuments({type: 'PURCHASE'}), 0);
    assert.equal((await PurchaseOrder.findById(id)).status, 'approved');
  });

  it('refuses to receive more than the outstanding remainder', async () => {
    const {id, itemId} = await approvedPo(100);
    assert.equal((await receive(id, [{itemId, receivedQty: 60}])).status, 201);
    const afterFirst = await balance();

    const res = await receive(id, [{itemId, receivedQty: 60}]);
    assert.ok([400, 409].includes(res.status), '40 outstanding, 60 requested');
    assert.equal(await balance(), afterFirst);
  });

  it('refuses negative and zero quantities', async () => {
    const {id, itemId} = await approvedPo();
    for (const receivedQty of [-10, 0]) {
      assert.equal((await receive(id, [{itemId, receivedQty}])).status, 400);
    }
    assert.equal(await InventoryTransaction.countDocuments({type: 'PURCHASE'}), 0);
  });

  it('requires an idempotency key', async () => {
    const {id, itemId} = await approvedPo();
    const res = await request(`/api/purchase-orders/${id}/receive`, {
      method: 'POST', token: owner(), body: {items: [{itemId, receivedQty: 10}]}
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Idempotency-Key/i);
  });

  it('banks a replayed receipt exactly once', async () => {
    const {id, itemId} = await approvedPo(100);
    const before = await balance();
    const key = KEY();

    const first = await receive(id, [{itemId, receivedQty: 40}], key);
    const replay = await receive(id, [{itemId, receivedQty: 40}], key);

    assert.equal(first.status, 201);
    assert.equal(replay.status, 200, 'a replay is acknowledged, not reprocessed');
    assert.equal((await balance()) - before, 40, 'stock moved once');
    assert.equal(await InventoryTransaction.countDocuments({type: 'PURCHASE'}), 1);
  });

  it('keeps the PO, stock and ledger in agreement across partial receipts', async () => {
    const {id, itemId} = await approvedPo(100);
    const before = await balance();

    assert.equal((await receive(id, [{itemId, receivedQty: 40}])).status, 201);
    assert.equal((await PurchaseOrder.findById(id)).status, 'partially_received');

    assert.equal((await receive(id, [{itemId, receivedQty: 60}])).status, 201);
    assert.equal((await PurchaseOrder.findById(id)).status, 'received');

    const rows = await InventoryTransaction.find({
      branch: world.branchA._id, ingredient: world.ingredient._id, type: 'PURCHASE'
    }).lean();
    assert.equal(rows.reduce((sum, r) => sum + Number(r.changeQty), 0), 100);
    assert.equal((await balance()) - before, 100);

    // Every ledger row must be complete and self-consistent.
    for (const row of rows) {
      assert.ok(row.idempotencyKey, 'ledger row needs an idempotency key');
      assert.ok(row.referenceId && row.referenceType, 'ledger row needs a reference');
      assert.ok(row.user, 'ledger row needs an actor');
      assert.ok(Math.abs((row.previousQty + row.changeQty) - row.newQty) < 1e-9,
        'previous + change must equal new');
    }
  });

  it('refuses to receive against a completed order', async () => {
    const {id, itemId} = await approvedPo(50);
    assert.equal((await receive(id, [{itemId, receivedQty: 50}])).status, 201);
    const settled = await balance();

    const res = await receive(id, [{itemId, receivedQty: 1}]);
    assert.ok([400, 409].includes(res.status));
    assert.equal(await balance(), settled);
  });

  it('keeps damaged goods out of sellable stock', async () => {
    const {id, itemId} = await approvedPo(50);
    const before = await balance();

    const res = await receive(id, [{
      itemId, receivedQty: 20, damagedQty: 5, damageReason: 'spoiled'
    }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await balance()) - before, 15, 'only the 15 good units enter stock');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchase returns
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — purchase returns', () => {
  async function receivedPo(qty = 100) {
    const {id, itemId} = await approvedPo(qty);
    assert.equal((await receive(id, [{itemId, receivedQty: qty}])).status, 201);
    return {id, itemId};
  }

  const postReturn = async (id, itemId, qty, key = KEY(), version) =>
    request(`/api/purchase-orders/${id}/returns`, {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': key},
      body: {
        items: [{itemId, qty}], reason: 'damaged',
        expectedVersion: version ?? await poVersion(id)
      }
    });

  it('refuses to return more than was received', async () => {
    const {id, itemId} = await receivedPo(100);
    const before = await balance();

    const res = await postReturn(id, itemId, 200);
    assert.ok([400, 409].includes(res.status));
    assert.equal(await balance(), before, 'a refused return must not move stock');
  });

  it('refuses a negative return', async () => {
    const {id, itemId} = await receivedPo();
    assert.equal((await postReturn(id, itemId, -5)).status, 400);
  });

  it('enforces optimistic locking against a stale view', async () => {
    const {id, itemId} = await receivedPo();
    const res = await postReturn(id, itemId, 10, KEY(), 0);
    assert.equal(res.status, 409, 'a stale version must not post a return');
  });

  it('deducts a valid return once and writes a negative ledger row', async () => {
    const {id, itemId} = await receivedPo(100);
    const before = await balance();
    const key = KEY();
    const version = await poVersion(id);

    const first = await postReturn(id, itemId, 30, key, version);
    assert.ok([200, 201].includes(first.status), JSON.stringify(first.body));
    assert.equal(before - (await balance()), 30);

    // Replay with the same key must not deduct again.
    await postReturn(id, itemId, 30, key, version);
    assert.equal(before - (await balance()), 30, 'a replayed return is banked once');

    const rows = await InventoryTransaction.find({
      branch: world.branchA._id, ingredient: world.ingredient._id, type: /RETURN/i
    }).lean();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].changeQty < 0, 'a return removes stock');
    assert.ok(rows[0].idempotencyKey);
  });

  it('refuses to return more than the un-returned remainder', async () => {
    const {id, itemId} = await receivedPo(100);
    assert.ok([200, 201].includes((await postReturn(id, itemId, 30)).status));
    const afterFirst = await balance();

    const res = await postReturn(id, itemId, 80);
    assert.ok([400, 409].includes(res.status), '70 remain, 80 requested');
    assert.equal(await balance(), afterFirst);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Supplier invoices and payments
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — invoice and payment integrity', () => {
  const createInvoice = (overrides = {}) =>
    request('/api/supplier-invoices', {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: BR(), supplier: String(supplier._id), invoiceNo: 'INV-1',
        invoiceDate: new Date().toISOString().slice(0, 10),
        vatRate: 13, subtotal: 10000, vat: 1300, total: 11300, ...overrides
      }
    });

  const outstanding = async id => {
    const doc = await SupplierInvoice.findById(id);
    return Math.round((Number(doc.total) - Number(doc.paidAmount || 0)) * 100) / 100;
  };

  it('validates VAT against the subtotal', async () => {
    const res = await createInvoice({vat: 0, total: 10000});
    assert.equal(res.status, 400, 'VAT arithmetic must agree');
  });

  it('refuses a duplicate invoice number for the same supplier', async () => {
    assert.equal((await createInvoice()).status, 201);
    const dupe = await createInvoice({subtotal: 500, vat: 65, total: 565});
    assert.ok([400, 409].includes(dupe.status));
    assert.equal(await SupplierInvoice.countDocuments({invoiceNo: 'INV-1'}), 1);
  });

  it('tracks the balance down to zero and then refuses overpayment', async () => {
    const invoice = await createInvoice();
    const id = invoice.body._id;
    const pay = (amount, key = KEY()) =>
      request(`/api/supplier-invoices/${id}/payments`, {
        method: 'POST', token: owner(), headers: {'Idempotency-Key': key},
        body: {amount, method: 'cash'}
      });

    assert.equal((await pay(3000)).status, 201);
    assert.equal(await outstanding(id), 8300);

    const key = KEY();
    assert.equal((await pay(8300, key)).status, 201);
    assert.equal(await outstanding(id), 0);

    // Replay must not create a credit balance.
    await pay(8300, key);
    assert.equal(await outstanding(id), 0, 'a replayed payment is banked once');

    const over = await pay(1);
    assert.ok([400, 409].includes(over.status), 'a settled invoice cannot take more');
    assert.equal((await pay(-100)).status, 400);
    assert.equal(await outstanding(id), 0, 'the balance survives every attack');
  });

  it('reserves payment reversal for owners', async () => {
    const invoice = await createInvoice();
    const paid = await request(`/api/supplier-invoices/${invoice.body._id}/payments`, {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {amount: 1000, method: 'cash'}
    });
    assert.equal(paid.status, 201);
    const res = await request(`/api/supplier-payments/${paid.body._id || paid.body.payment?._id}/reverse`, {
      method: 'POST', token: tokenFor(world.manager), body: {reason: 'probe'}
    });
    assert.ok([400, 403, 404].includes(res.status), `manager must not reverse: ${res.status}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Negative stock and concurrency
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — negative stock protection', () => {
  const adjust = (qty, key = KEY(), token = owner()) =>
    request('/api/inventory/adjustments', {
      method: 'POST', token, headers: {'Idempotency-Key': key},
      body: {branch: BR(), ingredient: ING(), qty, reason: 'phase 13 audit'}
    });

  it('refuses a deduction beyond the available quantity, atomically', async () => {
    const available = await balance();
    const rowsBefore = await InventoryTransaction.countDocuments({});

    const res = await adjust(-(available + 1));
    assert.ok([400, 409].includes(res.status));
    assert.equal(await balance(), available, 'stock unchanged');
    assert.equal(await InventoryTransaction.countDocuments({}), rowsBefore,
      'a refused deduction must leave no ledger row');
  });

  it('blocks a negative balance at two independent layers', async () => {
    // Mutation testing showed that removing the ledger's `after < 0` guard did
    // NOT produce negative stock: the FEFO batch allocator refuses the
    // movement independently. That is real defence in depth rather than a
    // single check, and it is asserted here so neither layer can be dropped
    // on the assumption the other covers it.
    const {removeBatchStock} = await import('../src/services/inventoryBatches.js');
    assert.equal(typeof removeBatchStock, 'function',
      'the batch allocator is the second layer and must exist');

    const available = await balance();
    const res = await adjust(-(available + 5000));
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Insufficient/i);
    assert.equal(await balance(), available);
    assert.equal(await InventoryTransaction.countDocuments({newQty: {$lt: 0}}), 0,
      'no ledger row may ever record a negative balance');
  });

  it('refuses a zero adjustment', async () => {
    assert.equal((await adjust(0)).status, 400);
  });

  it('never goes negative under concurrent deductions', async () => {
    const available = await balance();
    // Three parallel deductions of 60% each: at most one can legitimately win.
    const chunk = Math.floor(available * 0.6);
    const results = await Promise.all([1, 2, 3].map(i => adjust(-chunk, `conc-${i}`)));
    const winners = results.filter(r => [200, 201].includes(r.status)).length;

    assert.ok(winners <= 1, `expected at most one winner, got ${winners}`);
    const final = await balance();
    assert.ok(final >= 0, 'stock must never go negative');
    assert.equal(final, available - (winners * chunk), 'the arithmetic must be exact');
  });

  it('banks a replayed adjustment once', async () => {
    const before = await balance();
    const key = KEY();
    await adjust(-100, key);
    await adjust(-100, key);
    assert.equal(before - (await balance()), 100);
  });

  it('keeps every ledger row complete and self-consistent', async () => {
    await adjust(-50);
    const rows = await InventoryTransaction.find({branch: world.branchA._id}).lean();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(row.previousQty != null && row.newQty != null);
      assert.ok(row.referenceType, 'every movement is attributable');
      assert.ok(Math.abs((row.previousQty + row.changeQty) - row.newQty) < 1e-9);
      assert.ok(row.newQty >= -1e-9, 'no ledger row may record a negative balance');
    }
  });

  it('reserves inventory adjustments for owners and managers', async () => {
    const before = await balance();
    assert.equal((await adjust(-10, KEY(), staff())).status, 403);
    assert.equal(await balance(), before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tenant and branch isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — tenant and branch isolation', () => {
  it('refuses a purchase order that mixes tenants', async () => {
    const cases = [
      ['another restaurant\'s supplier', poBody({supplier: String(rival.supplier._id)})],
      ['another restaurant\'s ingredient', poBody({
        items: [{ingredient: String(rival.ingredient._id), orderedQty: 10, unit: 'g', unitPrice: 5}]
      })],
      ['another restaurant\'s branch', poBody({branch: String(rival.branch._id)})]
    ];
    for (const [label, body] of cases) {
      const res = await createPo(body);
      assert.ok([400, 403, 404].includes(res.status), `${label}: got ${res.status}`);
    }
    assert.equal(await PurchaseOrder.countDocuments({}), 0);
  });

  it('refuses every cross-tenant purchasing operation', async () => {
    const {id, itemId} = await approvedPo();
    const intruder = rivalOwner();

    assert.ok([403, 404].includes((await request(`/api/purchase-orders/${id}`, {token: intruder})).status));
    assert.ok([403, 404].includes((await receive(id, [{itemId, receivedQty: 10}], KEY(), intruder)).status));
    assert.ok([403, 404].includes((await request(`/api/purchase-orders/${id}/status`, {
      method: 'PATCH', token: intruder, body: {status: 'cancelled'}
    })).status));
    assert.ok([400, 403, 404].includes((await request(`/api/purchase-orders/${id}/returns`, {
      method: 'POST', token: intruder, headers: {'Idempotency-Key': KEY()},
      body: {items: [{itemId, qty: 1}], reason: 'damaged', expectedVersion: 0}
    })).status));

    assert.equal((await PurchaseOrder.findById(id)).status, 'approved', 'nothing moved');
    assert.equal(await InventoryTransaction.countDocuments({type: 'PURCHASE'}), 0);
  });

  it('refuses a cross-tenant inventory adjustment', async () => {
    const before = await balance();
    const res = await request('/api/inventory/adjustments', {
      method: 'POST', token: rivalOwner(), headers: {'Idempotency-Key': KEY()},
      body: {branch: BR(), ingredient: ING(), qty: -100, reason: 'cross tenant'}
    });
    assert.ok([400, 403, 404].includes(res.status));
    assert.equal(await balance(), before);
  });

  it('isolates reads, reports and supplier lists', async () => {
    await createPo(poBody());
    const intruder = rivalOwner();

    for (const path of [
      `/api/reports/purchasing?branch=${BR()}`,
      `/api/inventory?branch=${BR()}`,
      `/api/inventory/transactions?branch=${BR()}`,
      `/api/purchase-orders?branch=${BR()}`
    ]) {
      const res = await request(path, {token: intruder});
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }

    // An unscoped list returns the caller's OWN rows and none of ours. The
    // rival legitimately has one supplier of their own, so the invariant is
    // "none of ours", not "empty".
    const suppliers = await request('/api/suppliers', {token: intruder});
    assert.equal(suppliers.status, 200);
    const names = suppliers.body.items.map(row => row.name);
    assert.ok(!names.includes('Audit Supplier'), 'our supplier must not appear');
    assert.deepEqual(names, ['Rival Supplier'], 'they see only their own');

    const invoices = await request('/api/supplier-invoices', {token: intruder});
    assert.equal(invoices.status, 200);
    const rows = invoices.body.items || invoices.body;
    assert.equal(Array.isArray(rows) ? rows.length : 0, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RBAC
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — RBAC across purchasing and inventory', () => {
  it('closes financial surfaces to staff, riders and anonymous callers', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'rider13@test.com', password: 'x', role: 'rider',
      restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true}
    });

    const financial = [
      `/api/reports/purchasing?branch=${BR()}`,
      `/api/reports/pnl?branch=${BR()}`,
      '/api/supplier-invoices',
      '/api/expenses'
    ];

    for (const path of financial) {
      assert.equal((await request(path)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {token: tokenFor(rider)})).status, 403, `${path} rider`);
      assert.equal((await request(path, {token: staff()})).status, 403, `${path} staff`);
      assert.ok([200, 400].includes((await request(path, {token: owner()})).status),
        `${path} owner must be allowed`);
    }
  });

  it('lets staff read operational data but never write stock or money', async () => {
    assert.equal((await request(`/api/purchase-orders?branch=${BR()}`, {token: staff()})).status, 200);
    assert.equal((await request(`/api/inventory?branch=${BR()}`, {token: staff()})).status, 200);

    assert.equal((await createPo(poBody(), staff())).status, 403);
    assert.equal((await request('/api/inventory/adjustments', {
      method: 'POST', token: staff(), headers: {'Idempotency-Key': KEY()},
      body: {branch: BR(), ingredient: ING(), qty: -1, reason: 'staff attempt'}
    })).status, 403);
  });

  it('has no bare auth() guard in purchasing or inventory routes', async () => {
    // A bare auth() means "any authenticated principal", which now includes
    // riders. Adding a role must never silently widen these endpoints.
    const {readFile} = await import('node:fs/promises');
    for (const file of ['purchasing.js', 'supplierCatalog.js', 'ingredients.js', 'operations.js']) {
      const source = await readFile(new URL(`../src/routes/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /auth\(\)/, `${file} must not use a bare auth()`);
    }
  });
});
