import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, Ingredient, Supplier, User} from '../src/models/index.js';
import {Branch, PurchaseOrder, PurchaseOrderCounter, Restaurant} from '../src/models/operations.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {ensurePurchaseOrderIndexes} from '../src/services/purchaseOrderMigration.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let supplier;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Valley Wholesale', active: true});
});

const manualBody = (overrides = {}) => ({
  branch: String(world.branchA._id),
  supplier: String(supplier._id),
  items: [{ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1}],
  orderDate: '2026-08-15',
  notes: 'Weekly replenishment',
  ...overrides
});

const createPo = (overrides = {}, options = {}) => request('/api/purchase-orders', {
  method: 'POST',
  token: options.token || tokenFor(world.manager),
  headers: options.key ? {'Idempotency-Key': options.key} : {},
  body: manualBody(overrides)
});

describe('purchase order migration', () => {
  it('conservatively scopes legacy orders, backfills financial snapshots and creates indexes', async () => {
    const createdAt = new Date('2025-04-13T07:15:00.000Z');
    const legacy = await PurchaseOrder.collection.insertOne({
      poNo: 'PO-LEGACY-1',
      branch: world.branchA._id,
      supplier: supplier._id,
      status: 'draft',
      items: [{
        _id: new mongoose.Types.ObjectId(),
        ingredient: world.ingredient._id,
        orderedQty: 10,
        unit: 'g',
        unitPrice: 5,
        receivedQty: 0
      }],
      total: 50,
      createdBy: world.owner._id,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    });

    const annex = await Branch.create({restaurant: world.restaurant._id, name: 'Legacy Annex', code: 'K-T-M'});
    try {
      await PurchaseOrderCounter.collection.dropIndex('po_counter_scope');
    } catch (error) {
      if (error?.code !== 27) throw error;
    }
    await PurchaseOrderCounter.collection.createIndex(
      {restaurant: 1, branch: 1, year: 1},
      {unique: true, name: 'po_counter_scope'}
    );
    await PurchaseOrderCounter.collection.insertMany([
      {restaurant: world.restaurant._id, branch: world.branchA._id, year: 2026, value: 4},
      {restaurant: world.restaurant._id, branch: annex._id, year: 2026, value: 2}
    ]);

    const result = await ensurePurchaseOrderIndexes();
    assert.equal(result.migrated, 1);
    assert.equal(result.counterMigrated, 2);
    const po = await PurchaseOrder.findById(legacy.insertedId).lean();
    assert.equal(String(po.restaurant), String(world.restaurant._id));
    assert.equal(po.orderDate.toISOString(), createdAt.toISOString());
    assert.equal(po.subtotal, 50);
    assert.equal(po.vat, 0);
    assert.equal(po.total, 50);
    assert.equal(po.items[0].lineSubtotal, 50);
    assert.equal(po.items[0].lineVat, 0);
    assert.equal(po.items[0].lineTotal, 50);

    const poIndexes = await PurchaseOrder.collection.indexes();
    const counterIndexes = await PurchaseOrderCounter.collection.indexes();
    assert.ok(poIndexes.some(index => index.name === 'po_restaurant_number_v2' && index.unique));
    assert.ok(poIndexes.some(index => index.name === 'po_restaurant_request_key' && index.unique));
    assert.ok(poIndexes.some(index => index.name === 'po_restaurant_branch_status_created'));
    assert.ok(counterIndexes.some(index => index.name === 'po_counter_scope' && index.unique
      && index.key.restaurant === 1 && index.key.branchCode === 1 && index.key.year === 1));
    const counter = await PurchaseOrderCounter.findOne({restaurant: world.restaurant._id, branchCode: 'KTM', year: 2026}).lean();
    assert.equal(counter.value, 4);
    assert.equal(await PurchaseOrderCounter.countDocuments({restaurant: world.restaurant._id, year: 2026}), 1);
  });
});

describe('purchase order creation', () => {
  it('persists net, 13% VAT and gross snapshots with a counter-backed Kathmandu-year number and audit', async () => {
    const created = await createPo({orderDate: '2026-08-15', expectedDeliveryDate: '2026-08-18'});
    assert.equal(created.status, 201, created.body?.message);
    assert.match(created.body.poNo, /^PO-KTM-2026-000001$/);
    assert.equal(created.body.status, 'draft');
    assert.equal(created.body.subtotal, 100);
    assert.equal(created.body.vat, 13);
    assert.equal(created.body.total, 113);
    assert.equal(created.body.deliveryAddress, 'Kalanki');
    assert.equal(created.body.items[0].lineSubtotal, 100);
    assert.equal(created.body.items[0].lineVat, 13);
    assert.equal(created.body.items[0].lineTotal, 113);

    const stored = await PurchaseOrder.findById(created.body._id).lean();
    assert.equal(String(stored.restaurant), String(world.restaurant._id));
    assert.equal(String(stored.updatedBy), String(world.manager._id));
    assert.equal((await Audit.countDocuments({entity: 'purchase_order', entityId: stored._id, action: 'po_create'})), 1);
    assert.equal((await PurchaseOrderCounter.findOne({branch: world.branchA._id}).lean()).value, 1);
  });

  it('creates a multi-line draft and rejects duplicate ingredient snapshots', async () => {
    const oil = await Ingredient.create({
      restaurant: world.restaurant._id,
      code: 'OIL-PO',
      name: 'Cooking Oil',
      unit: 'ml',
      active: true
    });
    const created = await createPo({
      items: [
        {ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1},
        {ingredient: String(oil._id), orderedQty: 10, unit: 'ml', unitPrice: 5}
      ]
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.items.length, 2);
    assert.equal(created.body.subtotal, 150);
    assert.equal(created.body.vat, 19.5);
    assert.equal(created.body.total, 169.5);

    const duplicate = await createPo({
      items: [
        {ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1},
        {ingredient: String(world.ingredient._id), orderedQty: 20, unit: 'g', unitPrice: 2}
      ]
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.message, /duplicate ingredient/i);
    assert.equal(await PurchaseOrder.countDocuments(), 1);
  });

  it('rejects impossible Kathmandu dates and delivery dates before the order date', async () => {
    const impossible = await createPo({orderDate: '2026-02-30'});
    const backwards = await createPo({orderDate: '2026-08-15', expectedDeliveryDate: '2026-08-14'});
    assert.equal(impossible.status, 400);
    assert.match(impossible.body.message, /invalid date/i);
    assert.equal(backwards.status, 400);
    assert.match(backwards.body.message, /before the order date/i);
    assert.equal(await PurchaseOrder.countDocuments(), 0);
  });

  it('normalizes VAT-inclusive catalog prices without trusting client price fields', async () => {
    const mapping = await SupplierIngredient.create({
      restaurant: world.restaurant._id,
      supplier: supplier._id,
      ingredient: world.ingredient._id,
      supplierSku: 'RICE-INC',
      purchaseUnit: 'kg',
      baseUnit: 'g',
      conversionFactor: 1000,
      currentPrice: 113,
      priceIncludesVat: true,
      vatRate: 13,
      minOrderQty: 1,
      leadDays: 2,
      active: true,
      createdBy: world.owner._id,
      updatedBy: world.owner._id
    });
    const created = await createPo({
      items: [{
        catalogItem: String(mapping._id),
        ingredient: String(world.ingredient._id),
        purchaseQty: 2,
        orderedQty: 1,
        unitPrice: 0.01,
        vatRate: 0
      }]
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.items[0].catalogPrice, 113);
    assert.equal(created.body.items[0].unitPrice, 0.1);
    assert.equal(created.body.items[0].orderedQty, 2000);
    assert.equal(created.body.items[0].lineSubtotal, 200);
    assert.equal(created.body.items[0].lineVat, 26);
    assert.equal(created.body.items[0].lineTotal, 226);
    assert.equal(created.body.total, 226);
    assert.equal(created.body.expectedDeliveryDate, '2026-08-16T18:15:00.000Z');
  });

  it('replays same-key requests and rejects key reuse with a different payload without duplicate writes', async () => {
    const first = await createPo({}, {key: 'po-week-33'});
    const replay = await createPo({}, {key: 'po-week-33'});
    const conflict = await createPo({notes: 'Different order'}, {key: 'po-week-33'});
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body._id, first.body._id);
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.message, /different purchase order/i);
    assert.equal(await PurchaseOrder.countDocuments(), 1);
    assert.equal(await Audit.countDocuments({entity: 'purchase_order', action: 'po_create'}), 1);
    assert.equal((await PurchaseOrderCounter.findOne({branch: world.branchA._id}).lean()).value, 1);
  });

  it('allocates unique sequential numbers during concurrent creation', async () => {
    const responses = await Promise.all(Array.from({length: 5}, (_, index) => createPo({notes: `Concurrent ${index}`})));
    assert.ok(responses.every(response => response.status === 201), JSON.stringify(responses.map(response => response.body?.message)));
    const numbers = responses.map(response => response.body.poNo).sort();
    assert.deepEqual(numbers, [1, 2, 3, 4, 5].map(value => `PO-KTM-2026-${String(value).padStart(6, '0')}`));
    assert.equal(new Set(numbers).size, 5);
  });

  it('shares a number sequence when branches have the same normalized code', async () => {
    const duplicateCodeBranch = await Branch.create({
      restaurant: world.restaurant._id,
      name: 'Kathmandu Annex',
      code: ' K-T-M ',
      address: 'Thamel'
    });
    const first = await createPo({}, {token: tokenFor(world.owner)});
    const second = await createPo(
      {branch: String(duplicateCodeBranch._id), notes: 'Annex replenishment'},
      {token: tokenFor(world.owner)}
    );
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(second.status, 201, second.body?.message);
    assert.equal(first.body.poNo, 'PO-KTM-2026-000001');
    assert.equal(second.body.poNo, 'PO-KTM-2026-000002');
    assert.equal(await PurchaseOrderCounter.countDocuments({restaurant: world.restaurant._id, branchCode: 'KTM', year: 2026}), 1);
  });
});

describe('purchase order tenant, branch and role boundaries', () => {
  it('limits branch options and operations using stored user permissions', async () => {
    const ownerBranches = await request('/api/purchase-order-branches', {token: tokenFor(world.owner)});
    const managerBranches = await request('/api/purchase-order-branches', {token: tokenFor(world.manager)});
    assert.equal(ownerBranches.status, 200);
    assert.deepEqual(new Set(ownerBranches.body.map(branch => branch.code)), new Set(['KTM', 'LTP']));
    assert.equal(managerBranches.status, 200);
    assert.deepEqual(managerBranches.body.map(branch => branch.code), ['KTM']);

    const deniedBranch = await createPo({branch: String(world.branchB._id)});
    assert.equal(deniedBranch.status, 403);
    const deniedStaff = await createPo({}, {token: tokenFor(world.staffA)});
    assert.equal(deniedStaff.status, 403);

    const staleManagerToken = tokenFor(world.manager);
    await User.updateOne({_id: world.manager._id}, {$set: {role: 'staff'}});
    const staleRole = await createPo({}, {token: staleManagerToken});
    assert.equal(staleRole.status, 401, JSON.stringify(staleRole.body));
    assert.match(staleRole.body.message, /permissions changed/i);
  });

  it('rejects cross-restaurant branch, supplier, detail and list access', async () => {
    const otherRestaurant = await Restaurant.create({name: 'Other Restaurant'});
    const otherBranch = await Branch.create({restaurant: otherRestaurant._id, name: 'Other Branch', code: 'OTH'});
    const otherOwner = await User.create({
      name: 'Other Owner', email: 'other-po@test.com', password: 'hashed', role: 'owner',
      restaurant: 'Other Restaurant', restaurantId: otherRestaurant._id
    });
    const otherIngredient = await Ingredient.create({restaurant: otherRestaurant._id, code: 'OTHER-I', name: 'Other Rice', unit: 'g'});
    const otherSupplier = await Supplier.create({restaurant: otherRestaurant._id, name: 'Other Supplier'});
    const foreign = await request('/api/purchase-orders', {
      method: 'POST', token: tokenFor(otherOwner),
      body: {
        branch: String(otherBranch._id), supplier: String(otherSupplier._id),
        items: [{ingredient: String(otherIngredient._id), orderedQty: 10, unit: 'g', unitPrice: 2}]
      }
    });
    assert.equal(foreign.status, 201, foreign.body?.message);

    assert.equal((await createPo({branch: String(otherBranch._id)})).status, 403);
    assert.equal((await createPo({supplier: String(otherSupplier._id)})).status, 403);
    const unscopedSupplier = await Supplier.create({name: 'Unscoped Legacy Supplier'});
    const unscopedIngredient = await Ingredient.create({code: 'UNSCOPED-PO', name: 'Unscoped Ingredient', unit: 'g'});
    assert.equal((await createPo({supplier: String(unscopedSupplier._id)})).status, 403);
    assert.equal((await createPo({items: [{ingredient: String(unscopedIngredient._id), orderedQty: 1, unit: 'g', unitPrice: 1}]})).status, 403);
    assert.equal((await request('/api/purchase-orders/' + foreign.body._id, {token: tokenFor(world.owner)})).status, 403);
    assert.equal((await request('/api/purchase-orders?branch=' + otherBranch._id, {token: tokenFor(world.owner)})).status, 403);
  });
});

describe('purchase order listing and draft concurrency', () => {
  it('filters and paginates branch-scoped operational results with financial summaries', async () => {
    const first = await createPo({notes: 'Rice emergency', orderDate: '2026-08-10'});
    const second = await createPo({notes: 'Routine stock', orderDate: '2026-08-11', items: [{ingredient: String(world.ingredient._id), orderedQty: 200, unit: 'g', unitPrice: 1}]});
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(second.status, 201, second.body?.message);
    const pending = await request('/api/purchase-orders/' + first.body._id + '/status', {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'pending', expectedVersion: first.body.__v}
    });
    assert.equal(pending.status, 200, pending.body?.message);

    const list = await request(`/api/purchase-orders?branch=${world.branchA._id}&status=draft&from=2026-08-11&to=2026-08-11&page=1&limit=1`, {token: tokenFor(world.owner)});
    assert.equal(list.status, 200, list.body?.message);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0]._id, second.body._id);
    assert.deepEqual(list.body.pagination, {page: 1, limit: 1, total: 1, pages: 1});
    assert.deepEqual(list.body.summary, {subtotal: 200, vat: 26, total: 226, open: 1});

    const search = await request(`/api/purchase-orders?branch=${world.branchA._id}&q=emergency`, {token: tokenFor(world.staffA)});
    assert.equal(search.status, 200);
    assert.deepEqual(search.body.items.map(po => po._id), [first.body._id]);
    assert.equal((await request(`/api/purchase-orders?branch=${world.branchA._id}&status=not-real`, {token: tokenFor(world.owner)})).status, 400);
    assert.equal((await request('/api/purchase-orders', {token: tokenFor(world.owner)})).status, 400);
  });

  it('replaces editable snapshots with an optimistic version guard and records the audit', async () => {
    const created = await createPo();
    const body = {
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty: 250, unit: 'g', unitPrice: 1}],
      notes: 'Revised quantity',
      expectedVersion: created.body.__v
    };
    const updated = await request('/api/purchase-orders/' + created.body._id, {
      method: 'PATCH', token: tokenFor(world.manager), body
    });
    assert.equal(updated.status, 200, updated.body?.message);
    assert.equal(updated.body.__v, created.body.__v + 1);
    assert.equal(updated.body.subtotal, 250);
    assert.equal(updated.body.vat, 32.5);
    assert.equal(updated.body.total, 282.5);
    assert.equal(updated.body.notes, 'Revised quantity');
    assert.equal(await Audit.countDocuments({entity: 'purchase_order', entityId: created.body._id, action: 'po_update'}), 1);

    const stale = await request('/api/purchase-orders/' + created.body._id, {
      method: 'PATCH', token: tokenFor(world.manager), body
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /changed since it was loaded/i);
    const stored = await PurchaseOrder.findById(created.body._id).lean();
    assert.equal(stored.items[0].orderedQty, 250);
    assert.equal(await Audit.countDocuments({entity: 'purchase_order', entityId: created.body._id, action: 'po_update'}), 1);
  });

  it('rejects editing submitted orders and stale status transitions', async () => {
    const created = await createPo();
    const pending = await request('/api/purchase-orders/' + created.body._id + '/status', {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'pending', expectedVersion: created.body.__v}
    });
    assert.equal(pending.status, 200, pending.body?.message);
    assert.equal((await request('/api/purchase-orders/' + created.body._id + '/status', {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'approved', expectedVersion: created.body.__v}
    })).status, 409);
    assert.equal((await request('/api/purchase-orders/' + created.body._id, {
      method: 'PATCH', token: tokenFor(world.manager),
      body: {
        supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 300, unit: 'g', unitPrice: 1}],
        expectedVersion: pending.body.__v
      }
    })).status, 409);
    assert.equal(await Audit.countDocuments({entity: 'purchase_order', entityId: created.body._id, action: 'po_status'}), 1);
  });
});
