import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Audit, Ingredient, Supplier, User} from '../src/models/index.js';
import {Branch, PurchaseOrder, Restaurant} from '../src/models/operations.js';
import {SupplierIngredient, SupplierPriceHistory} from '../src/models/supplierCatalog.js';
import {ensureSupplierCatalogIndexes} from '../src/services/supplierCatalogMigration.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

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
  supplier = await Supplier.create({
    restaurant: world.restaurant._id,
    name: 'Kathmandu Food Supply',
    contact: '01-5550123',
    active: true
  });
});

function createEntry(overrides = {}, token = tokenFor(world.manager)) {
  return request('/api/supplier-catalog', {
    method: 'POST',
    token,
    body: {
      supplier: String(supplier._id),
      ingredient: String(world.ingredient._id),
      supplierSku: 'KFS-RICE-25',
      purchaseUnit: 'sack',
      conversionFactor: 25000,
      currentPrice: 1800,
      priceIncludesVat: false,
      vatRate: 13,
      minOrderQty: 1,
      leadDays: 2,
      reason: 'Opening supplier quotation',
      ...overrides
    }
  });
}

function patchEntry(id, expectedVersion, body = {}, token = tokenFor(world.manager)) {
  return request('/api/supplier-catalog/' + id, {
    method: 'PATCH',
    token,
    body: {expectedVersion, ...body}
  });
}

describe('supplier catalog migration', () => {
  it('backfills safe single-restaurant legacy records, opening history and required indexes', async () => {
    const legacySupplier = await Supplier.create({name: 'Legacy Mill'});
    const legacyIngredient = await Ingredient.create({code: 'LEGACY-RICE', name: 'Legacy Rice', unit: 'kg'});
    const inserted = await SupplierIngredient.collection.insertOne({
      supplier: legacySupplier._id,
      ingredient: legacyIngredient._id,
      supplierSku: 'LEG-1',
      unit: 'kg',
      currentPrice: 45,
      active: true,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z')
    });

    await ensureSupplierCatalogIndexes();

    const migrated = await SupplierIngredient.findById(inserted.insertedId).lean();
    assert.equal(String(migrated.restaurant), String(world.restaurant._id));
    assert.equal(migrated.purchaseUnit, 'kg');
    assert.equal(migrated.baseUnit, 'kg');
    assert.equal(migrated.conversionFactor, 1);
    assert.equal(migrated.minOrderQty, 1);
    assert.equal(String((await Supplier.findById(legacySupplier._id).lean()).restaurant), String(world.restaurant._id));
    assert.equal(String((await Ingredient.findById(legacyIngredient._id).lean()).restaurant), String(world.restaurant._id));

    const history = await SupplierPriceHistory.findOne({catalogItem: migrated._id}).lean();
    assert.equal(history.price, 45);
    assert.equal(history.reason, 'Migrated opening catalog price');
    assert.equal(history.effectiveAt.toISOString(), '2025-01-01T00:00:00.000Z');

    const indexNames = (await SupplierIngredient.collection.indexes()).map(index => index.name);
    assert.ok(indexNames.includes('catalog_restaurant_supplier_ingredient'));
    assert.ok(indexNames.includes('catalog_restaurant_supplier_sku'));
    assert.ok(indexNames.includes('catalog_restaurant_active_updated'));
    const ingredientIndexes = (await Ingredient.collection.indexes()).map(index => index.name);
    assert.ok(ingredientIndexes.includes('ingredient_restaurant_code'));
    assert.ok(!ingredientIndexes.includes('code_1'));
  });
});

describe('supplier catalog API', () => {
  it('creates a tenant-scoped mapping, opening history and audit record atomically', async () => {
    const response = await createEntry();
    assert.equal(response.status, 201, response.body?.message);
    assert.equal(response.body.supplier.name, supplier.name);
    assert.equal(response.body.ingredient.name, world.ingredient.name);
    assert.equal(response.body.supplierSku, 'KFS-RICE-25');
    assert.equal(response.body.purchaseUnit, 'sack');
    assert.equal(response.body.baseUnit, 'g');
    assert.equal(response.body.baseUnitPrice, 0.072);
    assert.equal(response.body.__v, 0);

    const history = await SupplierPriceHistory.find({catalogItem: response.body._id}).lean();
    assert.equal(history.length, 1);
    assert.equal(history[0].price, 1800);
    assert.equal(history[0].conversionFactor, 25000);
    assert.equal(history[0].reason, 'Opening supplier quotation');

    const audit = await Audit.findOne({entity: 'supplier_catalog', entityId: response.body._id}).lean();
    assert.ok(audit);
    assert.equal(audit.action, 'catalog_create');
    assert.equal(String(audit.restaurant), String(world.restaurant._id));
    assert.equal(String(audit.user), String(world.manager._id));
  });

  it('uses database-backed permissions and rejects unauthenticated, invalid-role and stale-role access', async () => {
    assert.equal((await request('/api/supplier-catalog')).status, 401);
    assert.equal((await request('/api/supplier-catalog', {token: tokenFor(world.owner, {role: 'guest'})})).status, 403);
    const stale = await createEntry({}, tokenFor(world.manager, {role: 'owner'}));
    assert.equal(stale.status, 401);
    assert.match(stale.body.message, /permissions changed/i);

    const wrongClaim = await request('/api/supplier-catalog', {
      token: tokenFor(world.owner, {restaurantId: '000000000000000000000001'})
    });
    assert.equal(wrongClaim.status, 200, wrongClaim.body?.message);
    assert.equal(wrongClaim.body.pagination.total, 0);
  });

  it('requires owner or manager mutations and rejects duplicate mappings without partial history', async () => {
    const forbidden = await createEntry({}, tokenFor(world.staffA));
    assert.equal(forbidden.status, 403);
    assert.equal(await SupplierIngredient.countDocuments(), 0);
    assert.equal(await SupplierPriceHistory.countDocuments(), 0);

    assert.equal((await createEntry()).status, 201);
    const duplicate = await createEntry({supplierSku: 'OTHER-SKU'});
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.message, /already exists/i);
    assert.equal(await SupplierIngredient.countDocuments(), 1);
    assert.equal(await SupplierPriceHistory.countDocuments(), 1);
  });

  it('updates terms with optimistic concurrency and appends only changed price-term history', async () => {
    const created = await createEntry();
    const updated = await patchEntry(created.body._id, created.body.__v, {
      currentPrice: 1900,
      leadDays: 3,
      reason: 'August supplier quotation'
    });
    assert.equal(updated.status, 200, updated.body?.message);
    assert.equal(updated.body.currentPrice, 1900);
    assert.equal(updated.body.previousPrice, 1800);
    assert.equal(updated.body.baseUnitPrice, 0.076);
    assert.equal(updated.body.__v, 1);

    const stale = await patchEntry(created.body._id, created.body.__v, {currentPrice: 2000, reason: 'Stale tab'});
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /changed since it was loaded/i);

    const leadOnly = await patchEntry(created.body._id, updated.body.__v, {leadDays: 4, reason: 'Lead time correction'});
    assert.equal(leadOnly.status, 200, leadOnly.body?.message);
    assert.equal(await SupplierPriceHistory.countDocuments({catalogItem: created.body._id}), 2);

    const history = await request('/api/supplier-catalog/' + created.body._id + '/price-history', {
      token: tokenFor(world.staffA)
    });
    assert.equal(history.status, 200, history.body?.message);
    assert.deepEqual(history.body.map(item => item.price), [1900, 1800]);
    assert.equal(history.body[0].changedBy.name, world.manager.name);
  });

  it('supports scoped options, search, filters and active status', async () => {
    const created = await createEntry();
    const secondIngredient = await Ingredient.create({
      restaurant: world.restaurant._id,
      code: 'ING-T2',
      name: 'Mustard Oil',
      category: 'Oils',
      unit: 'ml',
      averageCost: 0.25,
      active: true
    });
    await createEntry({ingredient: String(secondIngredient._id), supplierSku: 'KFS-OIL-5', purchaseUnit: 'jar', conversionFactor: 5000, currentPrice: 1250});
    const deactivated = await patchEntry(created.body._id, created.body.__v, {active: false, reason: 'Supplier discontinued item'});
    assert.equal(deactivated.status, 200, deactivated.body?.message);

    const search = await request('/api/supplier-catalog?q=oil&active=true&page=1&limit=10', {token: tokenFor(world.staffA)});
    assert.equal(search.status, 200, search.body?.message);
    assert.equal(search.body.pagination.total, 1);
    assert.equal(search.body.items[0].ingredient.name, 'Mustard Oil');

    const inactive = await request('/api/supplier-catalog?active=false', {token: tokenFor(world.owner)});
    assert.equal(inactive.status, 200, inactive.body?.message);
    assert.equal(inactive.body.pagination.total, 1);
    assert.equal(inactive.body.items[0].active, false);

    const options = await request('/api/supplier-catalog/options', {token: tokenFor(world.staffA)});
    assert.equal(options.status, 200, options.body?.message);
    assert.ok(options.body.suppliers.some(item => item._id === String(supplier._id)));
    assert.ok(options.body.ingredients.some(item => item._id === String(world.ingredient._id)));
  });

  it('prevents cross-restaurant supplier and ingredient mappings and hides their options', async () => {
    const otherRestaurant = await Restaurant.create({name: 'Other Restaurant', address: 'Lalitpur'});
    const otherSupplier = await Supplier.create({restaurant: otherRestaurant._id, name: 'Other Supplier'});
    const otherIngredient = await Ingredient.create({restaurant: otherRestaurant._id, code: world.ingredient.code, name: 'Other Rice', unit: 'g'});
    const otherBranch = await Branch.create({restaurant: otherRestaurant._id, name: 'Other Branch', code: 'OTH'});
    const otherManager = await User.create({
      name: 'Other Manager',
      email: 'other-manager@test.com',
      password: 'hashed',
      role: 'manager',
      restaurant: 'Other Restaurant',
      restaurantId: otherRestaurant._id,
      branch: otherBranch._id
    });

    const foreignSupplier = await createEntry({supplier: String(otherSupplier._id)});
    assert.equal(foreignSupplier.status, 403);
    const foreignIngredient = await createEntry({ingredient: String(otherIngredient._id)});
    assert.equal(foreignIngredient.status, 403);

    const otherCreated = await request('/api/supplier-catalog', {
      method: 'POST',
      token: tokenFor(otherManager),
      body: {
        supplier: String(otherSupplier._id),
        ingredient: String(otherIngredient._id),
        purchaseUnit: 'kg',
        conversionFactor: 1000,
        currentPrice: 100,
        minOrderQty: 1,
        leadDays: 1,
        reason: 'Other tenant quote'
      }
    });
    assert.equal(otherCreated.status, 201, otherCreated.body?.message);

    const crossTenantPo = await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        branch: String(otherBranch._id),
        supplier: String(otherSupplier._id),
        items: [{catalogItem: otherCreated.body._id, ingredient: String(otherIngredient._id), purchaseQty: 1}]
      }
    });
    assert.equal(crossTenantPo.status, 403);
    assert.match(crossTenantPo.body.message, /branch does not belong/i);

    const list = await request('/api/supplier-catalog', {token: tokenFor(world.owner)});
    assert.equal(list.body.pagination.total, 0);
    const options = await request('/api/supplier-catalog/options', {token: tokenFor(world.owner)});
    assert.ok(!options.body.suppliers.some(item => item._id === String(otherSupplier._id)));
    assert.ok(!options.body.ingredients.some(item => item._id === String(otherIngredient._id)));
  });
});

describe('catalog-authoritative purchase orders', () => {
  it('normalizes purchase quantity and snapshots current catalog terms instead of client pricing', async () => {
    const mapping = await createEntry();
    assert.equal(mapping.status, 201, mapping.body?.message);

    const created = await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {
        branch: String(world.branchA._id),
        supplier: String(supplier._id),
        items: [{
          catalogItem: mapping.body._id,
          ingredient: String(world.ingredient._id),
          purchaseQty: 2,
          orderedQty: 1,
          unitPrice: 0.000001,
          unit: 'kg'
        }],
        total: 0.01
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.total, 3600);
    assert.equal(created.body.items[0].orderedQty, 50000);
    assert.equal(created.body.items[0].purchaseQty, 2);
    assert.equal(created.body.items[0].unit, 'g');
    assert.equal(created.body.items[0].purchaseUnit, 'sack');
    assert.equal(created.body.items[0].conversionFactor, 25000);
    assert.equal(created.body.items[0].unitPrice, 0.072);
    assert.equal(created.body.items[0].catalogPrice, 1800);
    assert.equal(created.body.items[0].supplierSku, 'KFS-RICE-25');

    const repriced = await patchEntry(mapping.body._id, mapping.body.__v, {currentPrice: 2000, reason: 'New market price'});
    assert.equal(repriced.status, 200, repriced.body?.message);
    const historical = await PurchaseOrder.findById(created.body._id).lean();
    assert.equal(historical.total, 3600);
    assert.equal(historical.items[0].catalogPrice, 1800);
    assert.equal(historical.items[0].unitPrice, 0.072);
    await PurchaseOrder.updateOne({_id: created.body._id}, {$set: {
      'items.0.catalogPrice': 1,
      'items.0.unitPrice': 1,
      'items.0.conversionFactor': 1,
      'items.0.purchaseUnit': 'each'
    }});
    const immutable = await PurchaseOrder.findById(created.body._id).lean();
    assert.equal(immutable.items[0].catalogPrice, 1800);
    assert.equal(immutable.items[0].unitPrice, 0.072);
    assert.equal(immutable.items[0].conversionFactor, 25000);
    assert.equal(immutable.items[0].purchaseUnit, 'sack');

    const newPo = await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {
        branch: String(world.branchA._id),
        supplier: String(supplier._id),
        items: [{catalogItem: mapping.body._id, ingredient: String(world.ingredient._id), purchaseQty: 2}]
      }
    });
    assert.equal(newPo.status, 201, newPo.body?.message);
    assert.equal(newPo.body.total, 4000);
    assert.equal(newPo.body.items[0].catalogPrice, 2000);
    assert.equal(newPo.body.items[0].unitPrice, 0.08);
  });

  it('enforces MOQ, matching catalog identity, active state and catalogized supplier integrity', async () => {
    const mapping = await createEntry({minOrderQty: 2});
    assert.equal(mapping.status, 201, mapping.body?.message);
    const baseBody = {
      branch: String(world.branchA._id),
      supplier: String(supplier._id)
    };

    const belowMinimum = await request('/api/purchase-orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {...baseBody, items: [{catalogItem: mapping.body._id, ingredient: String(world.ingredient._id), purchaseQty: 1}]}
    });
    assert.equal(belowMinimum.status, 409);
    assert.match(belowMinimum.body.message, /minimum order/i);

    const otherIngredient = await Ingredient.create({restaurant: world.restaurant._id, code: 'ING-T3', name: 'Lentils', unit: 'g'});
    const mismatched = await request('/api/purchase-orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {...baseBody, items: [{catalogItem: mapping.body._id, ingredient: String(otherIngredient._id), purchaseQty: 2}]}
    });
    assert.equal(mismatched.status, 409);

    const deactivated = await patchEntry(mapping.body._id, mapping.body.__v, {active: false, reason: 'Discontinued'});
    assert.equal(deactivated.status, 200);
    const inactive = await request('/api/purchase-orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {...baseBody, items: [{ingredient: String(world.ingredient._id), orderedQty: 50000, unitPrice: 0.01}]}
    });
    assert.equal(inactive.status, 409);
    assert.match(inactive.body.message, /active supplier catalog mapping/i);
  });

  it('preserves manual base-unit ordering for suppliers with no catalog records', async () => {
    const legacySupplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Legacy Market'});
    const created = await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {
        branch: String(world.branchA._id),
        supplier: String(legacySupplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 400, unitPrice: 0.05, unit: 'g'}]
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.total, 20);
    assert.equal(created.body.items[0].catalogItem, undefined);
    assert.equal(created.body.items[0].orderedQty, 400);
    assert.equal(created.body.items[0].unitPrice, 0.05);
  });
});
