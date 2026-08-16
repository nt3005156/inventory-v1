import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Ingredient } from '../src/models/index.js';
import { SupplierIngredient } from '../src/models/supplierCatalog.js';
import { startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor } from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

describe('Phase 3A — Ingredients master', () => {
  it('creates ingredient master with units, conversions, categories and validates', async () => {
    // list units and categories
    const units = await request('/api/ingredients/units', { token: tokenFor(world.owner) });
    assert.equal(units.status, 200);
    assert.ok(units.body.units.includes('g'));
    assert.ok(units.body.units.includes('kg'));

    const cats = await request('/api/ingredients/categories', { token: tokenFor(world.owner) });
    assert.equal(cats.status, 200);
    assert.ok(cats.body.categories.includes('vegetable'));

    // create with valid conversions
    const created = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        name: 'Potato',
        code: 'POT01',
        category: 'vegetable',
        unit: 'g',
        conversions: [{ unit: 'kg', factor: 1000 }, { unit: 'bag', factor: 5000 }],
        minimumStock: 2000,
        reorderQty: 5000,
        shelfLifeDays: 14,
        storage: 'Cool dry place',
        description: 'Fresh potatoes'
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.name, 'Potato');
    assert.equal(created.body.code, 'POT01');
    assert.equal(created.body.category, 'vegetable');
    assert.equal(created.body.unit, 'g');
    assert.equal(created.body.conversions.length, 2);
    assert.equal(created.body.baseUnit, 'g');
  });

  it('validates units, categories, conversions and code uniqueness', async () => {
    const dup = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Dup', code: 'ING-T1', unit: 'g' } // ING-T1 already exists from seed
    });
    assert.equal(dup.status, 409);

    const badUnit = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Bad Unit', unit: 'invalid' }
    });
    assert.equal(badUnit.status, 400);

    const badCat = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Bad Cat', unit: 'g', category: 'invalidcat' }
    });
    assert.equal(badCat.status, 400);

    const badConvDup = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Bad Conv', unit: 'g', conversions: [{ unit: 'kg', factor: 1000 }, { unit: 'kg', factor: 2000 }] }
    });
    assert.equal(badConvDup.status, 400);
  });

  it('lists, filters, sorts and paginates ingredient master', async () => {
    await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Carrot', code: 'CAR01', category: 'vegetable', unit: 'g' } });
    await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Chicken Breast', code: 'CHK01', category: 'meat', unit: 'kg' } });
    await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Milk', code: 'MLK01', category: 'dairy', unit: 'l' } });

    const veg = await request('/api/ingredients?category=vegetable', { token: tokenFor(world.owner) });
    assert.ok(veg.body.items.some(i => i.name === 'Carrot'));

    const kg = await request('/api/ingredients?unit=kg', { token: tokenFor(world.owner) });
    assert.ok(kg.body.items.some(i => i.unit === 'kg'));

    const search = await request('/api/ingredients?q=Chicken', { token: tokenFor(world.owner) });
    assert.equal(search.body.items.length, 1);
    assert.equal(search.body.items[0].name, 'Chicken Breast');
  });

  it('links suppliers and exposes costs (average, stock, supplier prices)', async () => {
    const supplier = await request('/api/suppliers', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Fresh Farms', contact: '01-123' } });
    assert.equal(supplier.status, 201);

    const ing = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Onion', code: 'ONI01', category: 'vegetable', unit: 'g', supplier: supplier.body._id }
    });
    assert.equal(ing.status, 201);
    assert.equal(String(ing.body.primarySupplier), String(supplier.body._id));

    // Create supplier catalog mapping for costs
    const catalog = await request('/api/supplier-catalog', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        supplier: supplier.body._id,
        ingredient: ing.body._id,
        supplierSku: 'FF-ONI-1KG',
        purchaseUnit: 'kg',
        conversionFactor: 1000,
        currentPrice: 80,
        priceIncludesVat: false,
        vatRate: 13,
        minOrderQty: 1,
        leadDays: 2,
        reason: 'Onion catalog'
      }
    });
    assert.equal(catalog.status, 201);
    assert.equal(catalog.body.baseUnitPrice, 0.08);

    const detail = await request(`/api/ingredients/${ing.body._id}`, { token: tokenFor(world.owner) });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.suppliers.length, 1);
    assert.equal(detail.body.suppliers[0].supplierSku, 'FF-ONI-1KG');
    assert.equal(detail.body.costs.supplierPrices.length, 1);
    assert.equal(detail.body.costs.supplierPrices[0].price, 80);
    assert.ok('averageCost' in detail.body.costs);

    const suppliers = await request(`/api/ingredients/${ing.body._id}/suppliers`, { token: tokenFor(world.owner) });
    assert.equal(suppliers.body.count, 1);

    const costs = await request(`/api/ingredients/${ing.body._id}/costs`, { token: tokenFor(world.owner) });
    assert.ok(costs.body.costs);
    assert.equal(costs.body.unit, 'g');
  });

  it('prevents unit change while stock exists and allows after zero', async () => {
    const ing = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'UnitTest', code: 'UNIT01', unit: 'g' }
    });
    assert.equal(ing.status, 201);
    // seedWorld ingredient has stock, try to change its unit -> 409
    const blocked = await request(`/api/ingredients/${world.ingredient._id}`, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: { unit: 'kg' }
    });
    assert.equal(blocked.status, 409);
    // New ingredient has no stock, change should succeed
    const ok = await request(`/api/ingredients/${ing.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: { unit: 'kg' }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.unit, 'kg');
  });

  it('enforces role, branch and restaurant isolation', async () => {
    // staff can list but not create
    const listStaff = await request('/api/ingredients', { token: tokenFor(world.staffA) });
    assert.equal(listStaff.status, 200);
    const createStaff = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: { name: 'Staff Create', unit: 'g' }
    });
    assert.equal(createStaff.status, 403);
    // manager can create
    const createMan = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: { name: 'Manager Create', unit: 'g' }
    });
    assert.equal(createMan.status, 201);
  });

  it('blocks inventory fields and delete, allows deactivate', async () => {
    const blocked = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Bad Stock', unit: 'g', quantity: 999 }
    });
    assert.equal(blocked.status, 400);

    const ing = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'ToDeactivate', unit: 'g' }
    });
    const deact = await request(`/api/ingredients/${ing.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: { active: false }
    });
    assert.equal(deact.status, 200);
    assert.equal(deact.body.active, false);

    const del = await request(`/api/ingredients/${ing.body._id}`, { method: 'DELETE', token: tokenFor(world.owner) });
    assert.equal(del.status, 409);
  });
});
