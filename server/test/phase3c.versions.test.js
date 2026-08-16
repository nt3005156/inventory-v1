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

async function stock(ing, qty, cost, branch = world.branchA) {
  const s = await mongoose.startSession();
  try {
    await s.withTransaction(async () => {
      await moveStock({ branch: branch._id, ingredient: ing, qty, unit: 'g', unitCost: cost, type: 'OPENING', reason: 'stock', referenceType: 'test', referenceId: ing, user: world.owner._id, idempotencyKey: `stock-${ing}-${Date.now()}-${Math.random()}` }, s);
    });
  } finally { await s.endSession(); }
}

describe('Phase 3C — Recipe Versions', () => {
  it('Burger V1 → V2 preserves history and old orders retain old cost', async () => {
    // Create ingredients
    const bun = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Bun', code: 'BUN01', unit: 'pcs', category: 'bakery' } });
    const patty = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Patty', code: 'PAT01', unit: 'pcs', category: 'meat' } });
    const cheese = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Cheese', code: 'CHS01', unit: 'pcs', category: 'dairy' } });
    assert.equal(bun.status, 201);
    assert.equal(patty.status, 201);
    assert.equal(cheese.status, 201);

    // Stock them
    await stock(bun.body._id, 100, 0.5);
    await stock(patty.body._id, 100, 2);
    await stock(cheese.body._id, 100, 1);

    // Create Burger V1: bun 1 + patty 1 = cost 2.5, packaging 0.5 => foodCost 3.0
    const v1 = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        name: 'Burger',
        code: 'BURG01',
        category: 'main',
        price: 10,
        packagingCost: 0.5,
        recipe: [
          { ingredient: bun.body._id, qty: 1, unit: 'pcs' },
          { ingredient: patty.body._id, qty: 1, unit: 'pcs' }
        ]
      }
    });
    assert.equal(v1.status, 201, v1.body?.message);
    assert.equal(v1.body.recipeVersion, 1);
    assert.equal(v1.body.recipeCost, 2.5);
    assert.equal(v1.body.packagingCost, 0.5);
    assert.equal(v1.body.foodCost, 3);
    assert.equal(v1.body.recipeHistory.length, 0);

    // Create order with V1
    const orderV1 = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { branch: String(world.branchA._id), items: [{ menuItem: String(v1.body._id), qty: 1 }] }
    });
    assert.equal(orderV1.status, 201);
    assert.equal(orderV1.body.items[0].recipeVersion, 1);
    assert.equal(orderV1.body.items[0].foodCost, 3);
    assert.equal(orderV1.body.items[0].recipeCost, 2.5);
    assert.equal(orderV1.body.items[0].packagingCost, 0.5);

    // Change recipe to V2: add cheese, price 12, packaging 0.5 => cost 3.5, foodCost 4.0
    const v2 = await request(`/api/menu-items/${v1.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: {
        recipe: [
          { ingredient: bun.body._id, qty: 1, unit: 'pcs' },
          { ingredient: patty.body._id, qty: 1, unit: 'pcs' },
          { ingredient: cheese.body._id, qty: 1, unit: 'pcs' }
        ],
        packagingCost: 0.5,
        expectedVersion: v1.body.__v
      }
    });
    assert.equal(v2.status, 200, v2.body?.message);
    assert.equal(v2.body.recipeVersion, 2);
    assert.equal(v2.body.recipeCost, 3.5);
    assert.equal(v2.body.foodCost, 4);
    assert.equal(v2.body.recipeHistory.length, 1);
    assert.equal(v2.body.recipeHistory[0].version, 1);
    assert.equal(v2.body.recipeHistory[0].recipeCost, 2.5);

    // Verify versions endpoint
    const versions = await request(`/api/menu-items/${v1.body._id}/versions`, { token: tokenFor(world.owner) });
    assert.equal(versions.status, 200);
    assert.equal(versions.body.currentVersion, 2);
    assert.equal(versions.body.history.length, 1);
    assert.equal(versions.body.all.length, 2);

    // Old order should still have old cost
    const fetchedOrderV1 = await request(`/api/orders/${orderV1.body._id}`, { token: tokenFor(world.owner) });
    // Instead fetch via direct Order model: check via API list? We'll just check via direct DB
    const { Order } = await import('../src/models/operations.js');
    const storedOrder = await Order.findById(orderV1.body._id).lean();
    assert.equal(storedOrder.items[0].foodCost, 3);
    assert.equal(storedOrder.items[0].recipeVersion, 1);

    // New order with V2 should have new cost
    const orderV2 = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { branch: String(world.branchA._id), items: [{ menuItem: String(v1.body._id), qty: 1 }] }
    });
    assert.equal(orderV2.status, 201);
    assert.equal(orderV2.body.items[0].recipeVersion, 2);
    assert.equal(orderV2.body.items[0].foodCost, 4);

    // Ensure old order still unchanged after second order
    const storedOrder2 = await Order.findById(orderV1.body._id).lean();
    assert.equal(storedOrder2.items[0].foodCost, 3);
  });

  it('changing only packaging creates new version', async () => {
    const ing = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Pack Test Ing', code: 'PACK01', unit: 'g' } });
    await stock(ing.body._id, 1000, 1);
    const menu = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Pack Dish', code: 'PACKDISH', price: 100, packagingCost: 1, recipe: [{ ingredient: ing.body._id, qty: 10, unit: 'g' }] }
    });
    assert.equal(menu.body.foodCost, 11); // 10*1 +1
    const v2 = await request(`/api/menu-items/${menu.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: { packagingCost: 2, expectedVersion: menu.body.__v }
    });
    assert.equal(v2.body.recipeVersion, 2);
    assert.equal(v2.body.foodCost, 12);
    assert.equal(v2.body.recipeHistory[0].packagingCost, 1);
  });
});
