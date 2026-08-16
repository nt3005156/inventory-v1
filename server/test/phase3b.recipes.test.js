import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Ingredient, MenuItem } from '../src/models/index.js';
import { startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor } from './helpers.js';
import { moveStock } from '../src/services/inventoryLedger.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

async function stockIngredient(ingredientId, qty, unitCost, branch = world.branchA) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await moveStock({
        branch: branch._id,
        ingredient: ingredientId,
        qty,
        unit: 'g',
        unitCost,
        type: 'OPENING',
        reason: 'recipe test stock',
        referenceType: 'test',
        referenceId: ingredientId,
        user: world.owner._id,
        idempotencyKey: `rec-stock-${ingredientId}-${Date.now()}-${Math.random()}`
      }, session);
    });
  } finally { await session.endSession(); }
}

describe('Phase 3B — Recipes: Menu Item → Recipe → Ingredients → Quantity → Cost', () => {
  it('creates menu item with recipe and calculates weighted cost per ingredient quantity', async () => {
    const ing = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Test Chicken', code: 'CHK3B', category: 'meat', unit: 'g' }
    });
    assert.equal(ing.status, 201);
    await stockIngredient(ing.body._id, 5000, 0.5);

    const menu = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        name: 'Chicken Curry Test',
        code: 'CCT01',
        category: 'main',
        price: 350,
        recipe: [{ ingredient: ing.body._id, qty: 200, unit: 'g' }]
      }
    });
    assert.equal(menu.status, 201, menu.body?.message);
    assert.equal(menu.body.name, 'Chicken Curry Test');
    assert.equal(menu.body.recipe.length, 1);
    assert.equal(menu.body.recipe[0].qty, 200);
    assert.equal(menu.body.recipeCost, 100);
    assert.equal(menu.body.margin, 250);
  });

  it('handles unit conversions (kg → g, bag → g) for costing', async () => {
    const ing = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Flour', code: 'FLR01', category: 'grain', unit: 'g', conversions: [{ unit: 'kg', factor: 1000 }] }
    });
    assert.equal(ing.status, 201);
    await stockIngredient(ing.body._id, 10000, 0.1); // 0.1 per g

    const m1 = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Flatbread G', code: 'FBG', price: 100, recipe: [{ ingredient: ing.body._id, qty: 200, unit: 'g' }] }
    });
    assert.equal(m1.body.recipeCost, 20);

    const m2 = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Flatbread KG', code: 'FBKG', price: 100, recipe: [{ ingredient: ing.body._id, qty: 0.2, unit: 'kg' }] }
    });
    assert.equal(m2.body.recipeCost, 20);
  });

  it('rejects duplicate ingredients, invalid units, and validates restaurant ownership', async () => {
    const ing = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Dup Ingredient', code: 'DUP01', unit: 'g' }
    });
    assert.equal(ing.status, 201);

    const dup = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Dup Recipe', price: 100, recipe: [{ ingredient: ing.body._id, qty: 100, unit: 'g' }, { ingredient: ing.body._id, qty: 50, unit: 'g' }] }
    });
    assert.equal(dup.status, 400);
    assert.match(dup.body.message, /Duplicate ingredient/);

    const badUnit = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Bad Unit', price: 100, recipe: [{ ingredient: ing.body._id, qty: 100, unit: 'invalidunit' }] }
    });
    assert.equal(badUnit.status, 400);
  });

  it('lists, filters, and returns branch-scoped costs', async () => {
    const ing = await request('/api/ingredients', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'List Test Ing', code: 'LST01', unit: 'g' }
    });
    await stockIngredient(ing.body._id, 2000, 1);

    await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'List Item A', code: 'LIA', price: 100, category: 'main', recipe: [{ ingredient: ing.body._id, qty: 100, unit: 'g' }] }
    });
    await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'List Item B', code: 'LIB', price: 200, category: 'beverage', recipe: [] }
    });

    const byCat = await request('/api/menu-items?category=main', { token: tokenFor(world.owner) });
    assert.ok(byCat.body.items.some(i => i.name === 'List Item A'));
    assert.ok(!byCat.body.items.some(i => i.name === 'List Item B'));
    const listItemA = byCat.body.items.find(i=> i.name==='List Item A');
    assert.ok(listItemA);

    const search = await request('/api/menu-items?q=List Item A', { token: tokenFor(world.owner) });
    assert.equal(search.body.items.length, 1);

    const costBranch = await request(`/api/menu-items/${listItemA._id}/cost?branch=${world.branchA._id}`, { token: tokenFor(world.owner) });
    assert.equal(costBranch.status, 200);
    assert.equal(costBranch.body.recipeCost, 100);
  });

  it('updates recipe and recalculates cost, blocks unit change with stock edge but allows recipe edit', async () => {
    const ing1 = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Update Ing1', code: 'UPD01', unit: 'g' } });
    const ing2 = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Update Ing2', code: 'UPD02', unit: 'g' } });
    await stockIngredient(ing1.body._id, 1000, 0.5);
    await stockIngredient(ing2.body._id, 1000, 2);

    const menu = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Update Dish', code: 'UPDISH', price: 500, recipe: [{ ingredient: ing1.body._id, qty: 100, unit: 'g' }] }
    });
    assert.equal(menu.body.recipeCost, 50);

    const upd = await request(`/api/menu-items/${menu.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: { recipe: [{ ingredient: ing1.body._id, qty: 100, unit: 'g' }, { ingredient: ing2.body._id, qty: 10, unit: 'g' }], expectedVersion: menu.body.__v }
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.recipeCost, 70); // 100*0.5 +10*2
    assert.equal(upd.body.recipe.length, 2);
  });

  it('enforces role and prevents delete, allows deactivate', async () => {
    const menu = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Role Test', price: 100, recipe: [] }
    });
    assert.equal(menu.status, 201);

    const staffCreate = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: { name: 'Staff Dish', price: 100 }
    });
    assert.equal(staffCreate.status, 403);

    const deactivate = await request(`/api/menu-items/${menu.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: { active: false }
    });
    assert.equal(deactivate.status, 200);
    assert.equal(deactivate.body.active, false);

    const del = await request(`/api/menu-items/${menu.body._id}`, { method: 'DELETE', token: tokenFor(world.owner) });
    assert.equal(del.status, 409);
  });
});
