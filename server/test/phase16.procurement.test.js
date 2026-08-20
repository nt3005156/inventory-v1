/**
 * Phase 16 — procurement and supplier ERP.
 *
 * Much of this brief already shipped and was NOT rebuilt: purchase orders with
 * approval and receiving, goods receipts, purchase returns, supplier invoices,
 * supplier payments, the supplier catalog (with per-item lead days, price
 * history and conversion factors) and a running-balance supplier statement.
 *
 * Auditing that against the running API found five real gaps, each reproduced
 * before any code was written:
 *
 *   1. A POSTED RETURN DID NOT REDUCE THE SUPPLIER BALANCE. The brief states
 *      Invoice − Payments − Returns = Outstanding. The statement only ever
 *      queried invoices and payments, so returned goods were still owed for.
 *      Probe: invoice 1130 → balance 1130 → post a 50-unit return → balance
 *      still 1130. This is a real money defect, not a cosmetic one.
 *   2. The supplier master had no contacts, addresses, tax registration,
 *      credit limit, lead time or status. Probe: all ABSENT.
 *   3. 'received' was a terminal PO status, so a delivered order could never
 *      be commercially closed. The brief's graph ends ... → Received → Closed.
 *   4. No reorder suggestions, preferred supplier or price comparison.
 *      Probe: /purchasing/reorder-suggestions → 404, price-comparison → 404.
 *   5. No purchase-by-supplier, purchase-by-branch, ingredient-price or
 *      unpaid-invoice reports. Probe: all 404.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, Supplier, User} from '../src/models/index.js';
import {Branch, InventoryBalance, PurchaseOrder, Restaurant, SupplierInvoice} from '../src/models/operations.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {PurchaseReturn} from '../src/models/purchasing.js';
import {ensurePurchaseReturnIndexes} from '../src/services/purchaseReturnMigration.js';
import {PO_TRANSITIONS} from '../src/services/purchaseOrders.js';
import {rankCatalogOptions} from '../src/services/procurement.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {daysAhead} from './dates.js';

let world;
let supplier;
let rival;
let seq = 0;
const KEY = () => `p16-${Date.now()}-${++seq}`;

before(async () => {
  await startTestApp();
  await ensurePurchaseReturnIndexes();
});
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  seq = 0;
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Primary Supplier'});

  const restaurant = await Restaurant.create({name: 'Rival17', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival17 Branch', code: 'RV7', address: 'Chabahil'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival17 Owner', email: 'rival17@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival17', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

async function approvedPo({qty = 100, unitPrice = 10, ing = world.ingredient, sup = null} = {}) {
  const created = await request('/api/purchase-orders', {
    method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
    body: {
      branch: String(world.branchA._id), supplier: String((sup || supplier)._id),
      items: [{ingredient: String(ing._id), orderedQty: qty, unit: 'g', unitPrice, vatRate: 13}]
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: manager(), body: {status: 'pending', expectedVersion: created.body.__v}
  });
  const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: owner(), body: {status: 'approved', expectedVersion: pending.body.__v}
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body;
}

async function receiveAll(po, qty) {
  const res = await request(`/api/purchase-orders/${po._id}/receive`, {
    method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
    body: {
      expectedVersion: po.__v,
      items: [{
        itemId: String(po.items[0]._id), receivedQty: qty, damagedQty: 0,
        batchNumber: `B-${seq}`, expiryDate: daysAhead(200)
      }]
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.purchaseOrder;
}

const invoice = (body, token = manager()) => request('/api/supplier-invoices', {
  method: 'POST', token, headers: {'Idempotency-Key': KEY()},
  body: {
    branch: String(world.branchA._id), supplier: String(supplier._id),
    invoiceNo: `INV-${seq}`, invoiceDate: '2026-08-01', vatRate: 13, ...body
  }
});

const balance = (token = manager()) =>
  request(`/api/suppliers/${supplier._id}/balance`, {token});

const statement = (token = manager()) =>
  request(`/api/suppliers/${supplier._id}/statement?branch=${world.branchA._id}`, {token});

// ═══════════════════════════════════════════════════════════════════════════
// Supplier master data
// ═══════════════════════════════════════════════════════════════════════════

describe('16 — supplier master data', () => {
  it('stores contacts, addresses, tax, terms, credit limit and status', async () => {
    const res = await request('/api/suppliers', {
      method: 'POST', token: manager(),
      body: {
        name: 'Himalayan Wholesale',
        contacts: [
          {name: 'Ram Thapa', role: 'Sales', phone: '9800000001', primary: true},
          {name: 'Sita Rai', role: 'Accounts', email: 'AR@example.com'}
        ],
        addresses: [
          {label: 'HQ', line1: 'Balaju', city: 'Kathmandu', kind: 'billing'},
          {label: 'Depot', line1: 'Teku', city: 'Kathmandu', kind: 'delivery'}
        ],
        pan: '301234567', vatRegistered: true,
        paymentTermsDays: 30, creditLimit: 500000, leadTimeDays: 2,
        status: 'active'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const stored = await Supplier.findById(res.body._id);
    assert.equal(stored.contacts.length, 2);
    assert.equal(stored.contacts[0].primary, true);
    assert.equal(stored.contacts[1].email, 'ar@example.com', 'emails are normalised');
    assert.equal(stored.addresses.length, 2);
    assert.equal(stored.addresses[0].kind, 'billing');
    assert.equal(stored.pan, '301234567');
    assert.equal(stored.vatRegistered, true);
    assert.equal(stored.paymentTermsDays, 30);
    assert.equal(stored.creditLimit, 500000);
    assert.equal(stored.leadTimeDays, 2);
    assert.equal(stored.status, 'active');
  });

  it('validates the PAN and refuses VAT registration without one', async () => {
    const bad = await request('/api/suppliers', {
      method: 'POST', token: manager(), body: {name: 'Bad PAN Co', pan: '123'}
    });
    assert.equal(bad.status, 400);

    const noPan = await request('/api/suppliers', {
      method: 'POST', token: manager(), body: {name: 'No PAN Co', vatRegistered: true}
    });
    assert.equal(noPan.status, 400, 'a VAT-registered supplier must carry a PAN');
    assert.equal(await Supplier.countDocuments({name: {$in: ['Bad PAN Co', 'No PAN Co']}}), 0);
  });

  it('refuses two primary contacts', async () => {
    const res = await request('/api/suppliers', {
      method: 'POST', token: manager(),
      body: {
        name: 'Two Primaries Co',
        contacts: [{name: 'A', primary: true}, {name: 'B', primary: true}]
      }
    });
    assert.equal(res.status, 400);
  });

  it('keeps status and the legacy active flag in step', async () => {
    const created = await request('/api/suppliers', {
      method: 'POST', token: manager(), body: {name: 'Status Co'}
    });
    assert.equal(created.body.status, 'active');
    assert.equal(created.body.active, true);

    const held = await request(`/api/suppliers/${created.body._id}`, {
      method: 'PATCH', token: manager(),
      body: {expectedVersion: created.body.__v, status: 'blacklisted', statusReason: 'Repeated short deliveries'}
    });
    assert.equal(held.status, 200, JSON.stringify(held.body));

    const stored = await Supplier.findById(created.body._id);
    assert.equal(stored.status, 'blacklisted');
    assert.equal(stored.active, false, 'legacy active queries must agree with the richer status');
    assert.equal(stored.statusReason, 'Repeated short deliveries');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchase order lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('16 — purchase order lifecycle', () => {
  it('exposes the brief status graph including Closed', () => {
    assert.deepEqual(PO_TRANSITIONS.draft, ['pending', 'cancelled']);
    assert.ok(PO_TRANSITIONS.pending.includes('approved'));
    assert.deepEqual(PO_TRANSITIONS.received, ['closed'], 'a received order can now be closed');
    assert.deepEqual(PO_TRANSITIONS.closed_short, ['closed']);
    assert.deepEqual(PO_TRANSITIONS.closed, [], 'closed is terminal');
    assert.deepEqual(PO_TRANSITIONS.cancelled, []);
  });

  it('walks draft to partially received to received to closed', async () => {
    const po = await approvedPo({qty: 100});
    const partial = await receiveAll(po, 40);
    assert.equal(partial.status, 'partially_received');

    const full = await receiveAll(partial, 60);
    assert.equal(full.status, 'received');

    const closed = await request(`/api/purchase-orders/${po._id}/status`, {
      method: 'PATCH', token: manager(),
      body: {status: 'closed', expectedVersion: full.__v, notes: 'Invoiced and reconciled'}
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    const stored = await PurchaseOrder.findById(po._id);
    assert.equal(stored.status, 'closed');
    assert.ok(stored.closedAt, 'closing is stamped');
    assert.equal(String(stored.closedBy), String(world.manager._id));
    assert.equal(stored.closeNote, 'Invoiced and reconciled');
  });

  it('refuses to close while an invoice is still outstanding', async () => {
    const po = await approvedPo({qty: 100, unitPrice: 10});
    const received = await receiveAll(po, 100);

    const inv = await request('/api/supplier-invoices', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), supplier: String(supplier._id),
        purchaseOrder: String(po._id), invoiceNo: 'INV-OPEN', invoiceDate: '2026-08-01',
        vatRate: 13, subtotal: 1000, vat: 130, total: 1130
      }
    });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));

    const res = await request(`/api/purchase-orders/${po._id}/status`, {
      method: 'PATCH', token: manager(),
      body: {status: 'closed', expectedVersion: received.__v, notes: 'Trying to close early'}
    });
    assert.equal(res.status, 409, 'an order with money still owed must not be filed away');
    assert.match(res.body.message, /INV-OPEN/);
    assert.equal((await PurchaseOrder.findById(po._id)).status, 'received');
  });

  it('refuses an invalid transition', async () => {
    const po = await approvedPo();
    const res = await request(`/api/purchase-orders/${po._id}/status`, {
      method: 'PATCH', token: manager(),
      body: {status: 'closed', expectedVersion: po.__v}
    });
    assert.equal(res.status, 409, 'an approved order cannot skip straight to closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Supplier balance: Invoice − Payments − Returns
// ═══════════════════════════════════════════════════════════════════════════

describe('16 — supplier balance and statement', () => {
  it('credits a posted return against the balance', async () => {
    // The defect: this balance stayed at 1130 after a 500-value return.
    const po = await approvedPo({qty: 100, unitPrice: 10});
    const received = await receiveAll(po, 100);

    assert.equal((await invoice({subtotal: 1000, vat: 130, total: 1130})).status, 201);
    assert.equal((await balance()).body.balance, 1130);

    const ret = await request(`/api/purchase-orders/${po._id}/returns`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {items: [{itemId: String(received.items[0]._id), qty: 50}], reason: 'quality', expectedVersion: received.__v}
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    const returnTotal = (await PurchaseReturn.findOne({})).total;
    assert.ok(returnTotal > 0, 'the return must carry a value');

    const after = await balance();
    assert.equal(after.body.returned, returnTotal);
    assert.equal(after.body.balance, Math.round((1130 - returnTotal) * 100) / 100,
      'goods sent back are money no longer owed');
    assert.deepEqual(after.body.outstandingFormula, {
      invoiced: 1130, payments: 0, returns: returnTotal,
      outstanding: Math.round((1130 - returnTotal) * 100) / 100
    });
  });

  it('shows the return as its own credit line in the running balance', async () => {
    const po = await approvedPo({qty: 100, unitPrice: 10});
    const received = await receiveAll(po, 100);
    await invoice({subtotal: 1000, vat: 130, total: 1130});
    await request(`/api/purchase-orders/${po._id}/returns`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {items: [{itemId: String(received.items[0]._id), qty: 50}], reason: 'quality', expectedVersion: received.__v}
    });

    const res = await statement();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const credit = res.body.lines.find(line => line.type === 'purchase_return');
    assert.ok(credit, 'the return must be visible on the statement');
    assert.ok(credit.credit > 0);
    assert.equal(credit.debit, 0);
    assert.ok(credit.returnNo, 'traceable to the return document');
    // The running balance ends where the formula says it should.
    assert.equal(res.body.lines.at(-1).balance, res.body.balance);
  });

  it('only credits a return the statement can see as posted', async () => {
    // The model only admits 'posted' returns, so the guard is proven by
    // filtering on it rather than by inventing an unsupported status: a return
    // dated after the statement cut-off must not credit the balance early.
    const po = await approvedPo({qty: 100, unitPrice: 10});
    const received = await receiveAll(po, 100);
    await invoice({subtotal: 1000, vat: 130, total: 1130});
    await request(`/api/purchase-orders/${po._id}/returns`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {items: [{itemId: String(received.items[0]._id), qty: 50}], reason: 'quality', expectedVersion: received.__v}
    });
    const posted = await PurchaseReturn.findOne({});
    assert.equal(posted.status, 'posted');

    // As of a date before the return, it is not yet a credit.
    const asOfBefore = await request(
      `/api/suppliers/${supplier._id}/statement?branch=${world.branchA._id}&to=2026-07-31`,
      {token: manager()}
    );
    assert.equal(asOfBefore.status, 200, JSON.stringify(asOfBefore.body));
    assert.equal(asOfBefore.body.returned, 0, 'a later return must not back-date into an earlier period');
  });

  it('reports the credit limit and flags going over it', async () => {
    await Supplier.updateOne({_id: supplier._id}, {$set: {creditLimit: 1000}});
    await invoice({subtotal: 1000, vat: 130, total: 1130});

    const res = await balance();
    assert.equal(res.body.creditLimit, 1000);
    assert.equal(res.body.creditAvailable, -130);
    assert.equal(res.body.overCreditLimit, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Preferred supplier and price comparison
// ═══════════════════════════════════════════════════════════════════════════

describe('16 — preferred supplier and price comparison', () => {
  async function catalogEntry(sup, {price, factor = 1, unit = 'kg', vatInclusive = false, leadDays = 1, active = true}) {
    return SupplierIngredient.create({
      restaurant: world.restaurant._id, supplier: sup._id, ingredient: world.ingredient._id,
      purchaseUnit: unit, baseUnit: 'g', conversionFactor: factor,
      currentPrice: price, priceIncludesVat: vatInclusive, vatRate: 13,
      minOrderQty: 1, leadDays, active
    });
  }

  it('ranks by effective cost per base unit, not headline price', () => {
    const cheap = {_id: 'a', supplier: {_id: 's1', name: 'Bulk Co', status: 'active'},
      currentPrice: 1000, conversionFactor: 1000, purchaseUnit: 'kg', baseUnit: 'g', vatRate: 13, leadDays: 2};
    const dear = {_id: 'b', supplier: {_id: 's2', name: 'Small Co', status: 'active'},
      currentPrice: 600, conversionFactor: 500, purchaseUnit: 'g', baseUnit: 'g', vatRate: 13, leadDays: 1};

    const ranked = rankCatalogOptions([dear, cheap]);
    assert.equal(ranked.preferred.supplierName, 'Bulk Co', '1.00/g beats 1.20/g despite the bigger sticker price');
    assert.equal(ranked.preferred.effectiveUnitCost, 1);
    const other = ranked.options.find(o => o.supplierName === 'Small Co');
    assert.equal(other.effectiveUnitCost, 1.2);
    assert.equal(other.premiumPerUnit, 0.2);
  });

  it('strips VAT before comparing an inclusive quote', () => {
    const inclusive = {_id: 'a', supplier: {_id: 's1', name: 'Inc Co', status: 'active'},
      currentPrice: 113, conversionFactor: 100, baseUnit: 'g', priceIncludesVat: true, vatRate: 13};
    const exclusive = {_id: 'b', supplier: {_id: 's2', name: 'Exc Co', status: 'active'},
      currentPrice: 105, conversionFactor: 100, baseUnit: 'g', priceIncludesVat: false, vatRate: 13};

    const ranked = rankCatalogOptions([inclusive, exclusive]);
    assert.equal(ranked.preferred.supplierName, 'Inc Co', '113 incl VAT is 100 net, cheaper than 105 net');
  });

  it('never prefers a blacklisted supplier however cheap', async () => {
    // Defended at two independent layers: the sort demotes unorderable options,
    // and `preferred` picks the first ORDERABLE one regardless of sort order.
    // Removing either alone still passes; removing both fails. Verified by
    // mutation.
    const cheapBlocked = await Supplier.create({
      restaurant: world.restaurant._id, name: 'Blocked Co', status: 'blacklisted', active: false
    });
    await catalogEntry(cheapBlocked, {price: 1, factor: 1000});
    await catalogEntry(supplier, {price: 100, factor: 1000});

    const res = await request(`/api/purchasing/price-comparison/${world.ingredient._id}`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.preferredSupplier.supplierName, 'Primary Supplier');
    const blocked = res.body.options.find(o => o.supplierName === 'Blocked Co');
    assert.equal(blocked.orderable, false);
    assert.equal(blocked.preferred, false);
    assert.equal(res.body.orderableCount, 1);
  });

  it('breaks a price tie on the shorter lead time', async () => {
    const fast = await Supplier.create({restaurant: world.restaurant._id, name: 'Fast Co'});
    await catalogEntry(supplier, {price: 100, factor: 1000, leadDays: 5});
    await catalogEntry(fast, {price: 100, factor: 1000, leadDays: 1});

    const res = await request(`/api/purchasing/price-comparison/${world.ingredient._id}`, {token: manager()});
    assert.equal(res.body.preferredSupplier.supplierName, 'Fast Co');
    assert.equal(res.body.preferredSupplier.leadDays, 1);
  });

  it('is management only and tenant scoped', async () => {
    await catalogEntry(supplier, {price: 100, factor: 1000});
    assert.equal((await request(`/api/purchasing/price-comparison/${world.ingredient._id}`, {token: staff()})).status, 403);
    assert.equal((await request(`/api/purchasing/price-comparison/${world.ingredient._id}`)).status, 401);
    const intruder = await request(`/api/purchasing/price-comparison/${world.ingredient._id}`, {token: tokenFor(rival.owner)});
    assert.equal(intruder.status, 404, 'another tenant cannot read our ingredient prices');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reorder suggestions
// ═══════════════════════════════════════════════════════════════════════════

describe('16 — reorder suggestions', () => {
  beforeEach(async () => {
    await SupplierIngredient.create({
      restaurant: world.restaurant._id, supplier: supplier._id, ingredient: world.ingredient._id,
      purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: 1000, currentPrice: 100,
      minOrderQty: 0.5, leadDays: 3, active: true
    });
  });

  const suggest = (query = '', token = manager()) =>
    request(`/api/purchasing/reorder-suggestions?branch=${world.branchA._id}${query}`, {token});

  /**
   * Set on-hand stock the only legal way: through the ledger. The balance
   * document refuses a direct quantity write, which is correct — the ledger is
   * the single write path.
   */
  async function setStock(target) {
    const current = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    }))?.quantity ?? 0;
    const delta = target - current;
    if (Math.abs(delta) < 1e-9) return;
    const res = await request('/api/inventory/adjustments', {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: delta, reason: 'Set stock for reorder planning test'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  it('suggests nothing while stock is above the reorder level', async () => {
    await InventoryBalance.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {$set: {reorderLevel: 100}}
    );
    const res = await suggest();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.counts.total, 0, '20000 on hand against a level of 100 needs nothing');
  });

  it('suggests a quantity that restores the target', async () => {
    await Ingredient.updateOne({_id: world.ingredient._id}, {$set: {reorderQty: 5000}});
    await setStock(1000);
    await InventoryBalance.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {$set: {reorderLevel: 2000}}
    );

    const res = await suggest();
    const row = res.body.suggestions.find(s => String(s.ingredient) === String(world.ingredient._id));
    assert.ok(row, 'a low ingredient must be suggested');
    assert.equal(row.onHand, 1000);
    assert.equal(row.reorderLevel, 2000);
    assert.equal(row.target, 7000, 'level 2000 plus reorder quantity 5000');
    assert.equal(row.shortfall, 6000);
    assert.equal(row.suggestedQty, 6000, 'a whole multiple of the 500g (0.5kg) minimum order');
    assert.equal(row.urgency, 'reorder');
    assert.match(row.reason, /at or below the reorder level/);
    assert.equal(row.preferredSupplier.supplierName, 'Primary Supplier');
    assert.equal(row.leadDays, 3);
    assert.equal(row.actionable, true);
  });

  it('rounds up to the supplier minimum order quantity', async () => {
    await Ingredient.updateOne({_id: world.ingredient._id}, {$set: {reorderQty: 100}});
    await setStock(0);
    await InventoryBalance.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {$set: {reorderLevel: 600}}
    );
    const res = await suggest();
    const row = res.body.suggestions[0];
    assert.equal(row.shortfall, 700);
    assert.equal(row.suggestedQty, 1000, '700g rounds up to two lots of 500g');
    assert.equal(row.urgency, 'critical', 'nothing on hand is critical');
  });

  it('subtracts stock already on an open purchase order', async () => {
    await Ingredient.updateOne({_id: world.ingredient._id}, {$set: {reorderQty: 0}});
    await setStock(1000);
    await InventoryBalance.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {$set: {reorderLevel: 5000}}
    );
    const before = (await suggest()).body.suggestions[0];
    assert.equal(before.shortfall, 4000);

    // Order 4000g; the suggestion must stop asking for it.
    await approvedPo({qty: 4000, unitPrice: 1});

    const after = (await suggest()).body.suggestions[0];
    assert.equal(after.onOrder, 4000);
    assert.equal(after.shortfall, 0, 'a buyer must not be told to order the same stock twice');
    assert.equal(after.alreadyCovered, true);
    assert.equal(after.actionable, false);
  });

  it('flags a low ingredient with no orderable supplier rather than hiding it', async () => {
    const orphan = await Ingredient.create({
      restaurant: world.restaurant._id, code: 'ING-ORPH', name: 'Unsourced Spice',
      unit: 'g', reorderLevel: 100, reorderQty: 50
    });
    const res = await suggest();
    const row = res.body.suggestions.find(s => String(s.ingredient) === String(orphan._id));
    assert.ok(row, 'an ingredient with no supplier is still a purchasing problem');
    assert.equal(row.preferredSupplier, null);
    assert.equal(row.actionable, false);
    assert.ok(res.body.counts.blocked >= 1);
  });

  it('is management only and branch scoped', async () => {
    assert.equal((await suggest('', staff())).status, 403);
    assert.equal((await request(`/api/purchasing/reorder-suggestions?branch=${world.branchA._id}`)).status, 401);
    const cross = await request(`/api/purchasing/reorder-suggestions?branch=${world.branchB._id}`, {token: manager()});
    assert.equal(cross.status, 403, 'a branch manager cannot plan another branch');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchase history
// ═══════════════════════════════════════════════════════════════════════════

describe('16 — purchase history', () => {
  it('reports what was actually received, with supplier and price trend', async () => {
    const first = await approvedPo({qty: 100, unitPrice: 10});
    await receiveAll(first, 100);
    const second = await approvedPo({qty: 100, unitPrice: 12});
    await receiveAll(second, 100);

    const res = await request(
      `/api/purchasing/purchase-history/${world.ingredient._id}?branch=${world.branchA._id}`,
      {token: manager()}
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.count, 2);
    assert.equal(res.body.history[0].supplierName, 'Primary Supplier');
    assert.ok(res.body.history[0].poNo, 'traceable to the purchase order');
    assert.equal(res.body.priceTrend.latest, 12);
    assert.equal(res.body.priceTrend.previous, 10);
    assert.equal(res.body.priceTrend.delta, 2);
    assert.equal(res.body.priceTrend.deltaPercent, 20);
  });

  it('filters to one supplier', async () => {
    const other = await Supplier.create({restaurant: world.restaurant._id, name: 'Second Supplier'});
    const a = await approvedPo({qty: 50, unitPrice: 10});
    await receiveAll(a, 50);
    const b = await approvedPo({qty: 50, unitPrice: 20, sup: other});
    await receiveAll(b, 50);

    const res = await request(
      `/api/purchasing/purchase-history/${world.ingredient._id}?branch=${world.branchA._id}&supplier=${other._id}`,
      {token: manager()}
    );
    assert.equal(res.body.count, 1);
    assert.equal(res.body.history[0].supplierName, 'Second Supplier');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reports
// ═══════════════════════════════════════════════════════════════════════════

describe('16 — procurement reports', () => {
  it('groups purchases by supplier', async () => {
    const other = await Supplier.create({restaurant: world.restaurant._id, name: 'Second Supplier'});
    const a = await approvedPo({qty: 100, unitPrice: 10});
    await receiveAll(a, 100);
    await approvedPo({qty: 50, unitPrice: 20, sup: other});

    const res = await request(`/api/reports/purchase-by-supplier?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.groupBy, 'supplier');
    assert.equal(res.body.count, 2);
    const primary = res.body.rows.find(r => r.name === 'Primary Supplier');
    assert.equal(primary.orderCount, 1);
    assert.equal(primary.orderedQty, 100);
    assert.equal(primary.receivedQty, 100);
    assert.equal(primary.receivedValue, 1000);
    const second = res.body.rows.find(r => r.name === 'Second Supplier');
    assert.equal(second.receivedQty, 0, 'nothing received on that order yet');
  });

  it('groups purchases by branch for an owner', async () => {
    const a = await approvedPo({qty: 100, unitPrice: 10});
    await receiveAll(a, 100);

    const res = await request('/api/reports/purchase-by-branch', {token: owner()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.groupBy, 'branch');
    const ktm = res.body.rows.find(r => r.code === 'KTM');
    assert.ok(ktm, 'the ordering branch must appear');
    assert.equal(ktm.orderCount, 1);
  });

  it('reports ingredient purchase prices and their movement', async () => {
    const a = await approvedPo({qty: 100, unitPrice: 10});
    await receiveAll(a, 100);
    const b = await approvedPo({qty: 100, unitPrice: 15});
    await receiveAll(b, 100);

    const res = await request(`/api/reports/ingredient-purchase-prices?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.rows.find(r => String(r.ingredient) === String(world.ingredient._id));
    assert.equal(row.latestCost, 15);
    assert.equal(row.previousCost, 10);
    assert.equal(row.deltaPercent, 50);
    assert.equal(row.trend, 'up');
    assert.equal(row.lowest, 10);
    assert.equal(row.highest, 15);
    assert.equal(res.body.increases, 1);
  });

  it('lists unpaid invoices with aging', async () => {
    // A due date may not precede the invoice date, so the overdue one is dated
    // earlier and falls due in the past.
    const lateInvoice = await invoice({
      invoiceDate: '2026-01-01', dueDate: '2026-02-01', subtotal: 1000, vat: 130, total: 1130
    });
    assert.equal(lateInvoice.status, 201, JSON.stringify(lateInvoice.body));
    const current = await invoice({subtotal: 500, vat: 65, total: 565, dueDate: daysAhead(30)});
    assert.equal(current.status, 201, JSON.stringify(current.body));

    const res = await request(`/api/reports/unpaid-invoices?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.count, 2);
    assert.equal(res.body.totalOutstanding, 1695);
    assert.equal(res.body.overdueCount, 1, 'only the February invoice is past due');
    assert.equal(res.body.overdueOutstanding, 1130);
    const overdue = res.body.invoices.find(i => i.overdue);
    assert.ok(overdue.daysOverdue > 0);
    assert.ok(['days31To60', 'days61To90', 'over90', 'days1To30'].includes(overdue.bucket));
  });

  it('excludes a fully paid invoice', async () => {
    const created = await invoice({subtotal: 1000, vat: 130, total: 1130});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const paid = await request(`/api/supplier-invoices/${created.body._id}/payments`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {amount: 1130, method: 'bank', reference: 'PAID-FULL'}
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    const res = await request(`/api/reports/unpaid-invoices?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(res.body.count, 0, 'a settled invoice is not outstanding');
    assert.equal(res.body.totalOutstanding, 0);

    // The query itself must exclude paid invoices, not merely rely on the
    // zero-outstanding filter downstream: a paid invoice whose paidAmount was
    // mis-recorded must still not reappear as money owed.
    const stored = await SupplierInvoice.findById(created.body._id);
    assert.equal(stored.status, 'paid');
    await SupplierInvoice.collection.updateOne(
      {_id: stored._id}, {$set: {paidAmount: 0}}
    );
    const again = await request(`/api/reports/unpaid-invoices?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(again.body.count, 0, 'a paid invoice is never listed as unpaid');
  });

  it('restricts every report to management and to the tenant', async () => {
    const paths = [
      `/api/reports/purchase-by-supplier?branch=${world.branchA._id}`,
      `/api/reports/purchase-by-branch?branch=${world.branchA._id}`,
      `/api/reports/ingredient-purchase-prices?branch=${world.branchA._id}`,
      `/api/reports/unpaid-invoices?branch=${world.branchA._id}`,
      `/api/purchasing/reorder-suggestions?branch=${world.branchA._id}`
    ];
    for (const path of paths) {
      assert.equal((await request(path)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {token: 'not.a.jwt'})).status, 401, `${path} forged`);
      assert.equal((await request(path, {token: staff()})).status, 403, `${path} staff`);
      const cross = await request(path, {token: tokenFor(rival.owner)});
      assert.ok([403, 404].includes(cross.status), `${path} cross-tenant -> ${cross.status}`);
    }
  });

  it('never leaks another restaurant purchases into a report', async () => {
    const a = await approvedPo({qty: 100, unitPrice: 10});
    await receiveAll(a, 100);

    const theirs = await request('/api/reports/purchase-by-supplier', {token: tokenFor(rival.owner)});
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(theirs.body.count, 0, 'another tenant sees none of our purchasing');
    assert.equal(theirs.body.totals.orderedValue, 0);
  });
});
