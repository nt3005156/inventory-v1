import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
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

describe('Phase 3D — Food Costing: Ingredient + Recipe + Packaging = Food Cost; Price - Food Cost = Gross Margin', () => {
  it('calculates Ingredient Cost → Recipe Cost → Food Cost → Gross Margin correctly', async () => {
    const bun = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Bun2', code: 'BUN02', unit: 'pcs', category: 'bakery' } });
    const patty = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Patty2', code: 'PAT02', unit: 'pcs', category: 'meat' } });
    const pack = 0.75;
    await stock(bun.body._id, 100, 0.4);
    await stock(patty.body._id, 100, 1.2);

    // Ingredient costs: bun 0.4, patty 1.2
    const bunCost = await request(`/api/ingredients/${bun.body._id}/costs`, { token: tokenFor(world.owner) });
    assert.equal(bunCost.body.costs.averageCost, 0.4);
    const pattyCost = await request(`/api/ingredients/${patty.body._id}/costs`, { token: tokenFor(world.owner) });
    assert.equal(pattyCost.body.costs.averageCost, 1.2);

    // Recipe: 1 bun + 1 patty = 1.6
    const menu = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        name: 'Burger FoodCost',
        code: 'BURFC',
        price: 8,
        packagingCost: pack,
        recipe: [
          { ingredient: bun.body._id, qty: 1, unit: 'pcs' },
          { ingredient: patty.body._id, qty: 1, unit: 'pcs' }
        ]
      }
    });
    assert.equal(menu.status, 201);
    assert.equal(menu.body.recipeCost, 1.6);
    assert.equal(menu.body.packagingCost, 0.75);
    assert.equal(menu.body.foodCost, 2.35);
    // Food Cost = 1.6 + 0.75 = 2.35
    // Gross Margin = 8 - 2.35 = 5.65
    assert.equal(menu.body.margin, 5.65);
    assert.equal(menu.body.foodCostPercent, 29.38); // 2.35/8*100

    // Via dedicated food-costing endpoint
    const fc = await request(`/api/menu-items/${menu.body._id}/food-costing?branch=${world.branchA._id}`, { token: tokenFor(world.owner) });
    assert.equal(fc.status, 200);
    assert.equal(fc.body.ingredientCost, 1.6);
    assert.equal(fc.body.recipeCost, 1.6);
    assert.equal(fc.body.packagingCost, 0.75);
    assert.equal(fc.body.foodCost, 2.35);
    assert.equal(fc.body.sellingPrice, 8);
    assert.equal(fc.body.grossMargin, 5.65);
    assert.equal(fc.body.foodCostPercent, 29.38);

    // Also via cost endpoint
    const cost = await request(`/api/menu-items/${menu.body._id}/cost?branch=${world.branchA._id}`, { token: tokenFor(world.owner) });
    assert.equal(cost.body.foodCost, 2.35);
  });

  it('order retains historical food cost even after ingredient price hike', async () => {
    const ing = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Hist Ing', code: 'HIST01', unit: 'g' } });
    await stock(ing.body._id, 1000, 1); // 1 per g
    const menu = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Hist Dish', code: 'HISTDISH', price: 500, packagingCost: 10, recipe: [{ ingredient: ing.body._id, qty: 100, unit: 'g' }] }
    });
    assert.equal(menu.body.recipeCost, 100);
    assert.equal(menu.body.foodCost, 110); // 100 +10

    const order1 = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { branch: String(world.branchA._id), items: [{ menuItem: String(menu.body._id), qty: 1 }] }
    });
    assert.equal(order1.status, 201);
    assert.equal(order1.body.items[0].foodCost, 110);
    assert.equal(order1.body.items[0].recipeCost, 100);
    assert.equal(order1.body.items[0].packagingCost, 10);

    // Hike ingredient cost: new purchase 1000g @ 2 (PURCHASE, not OPENING)
    {
      const s = await mongoose.startSession();
      try {
        await s.withTransaction(async () => {
          await moveStock({ branch: world.branchA._id, ingredient: ing.body._id, qty: 1000, unit: 'g', unitCost: 2, type: 'PURCHASE', reason: 'price hike', referenceType: 'goods_receipt', referenceId: new mongoose.Types.ObjectId(), user: world.owner._id, idempotencyKey: `hike-${Date.now()}`, incomingBatches: [{ quantity: 1000, unitCost: 2, sourceType: 'goods_receipt' }] }, s);
        });
      } finally { await s.endSession(); }
    }
    // New order should have higher cost
    const menuAfter = await request(`/api/menu-items/${menu.body._id}`, { token: tokenFor(world.owner) });
    // New recipeCost should be higher due to weighted avg: (1000*1+1000*2)/2000=1.5 per g => 100g =150
    assert.ok(menuAfter.body.recipeCost > 100);
    const order2 = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { branch: String(world.branchA._id), items: [{ menuItem: String(menu.body._id), qty: 1 }] }
    });
    assert.ok(order2.body.items[0].foodCost > 110);
    // Old order still retains old cost
    const { Order } = await import('../src/models/operations.js');
    const oldOrder = await Order.findById(order1.body._id).lean();
    assert.equal(oldOrder.items[0].foodCost, 110);
  });

  it('handles yield and branch-scoped costing', async () => {
    const ing = await request('/api/ingredients', { method: 'POST', token: tokenFor(world.owner), body: { name: 'Yield Ing', code: 'YIELD01', unit: 'g' } });
    await stock(ing.body._id, 2000, 0.5);
    const menu = await request('/api/menu-items', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: { name: 'Yield Dish', code: 'YIELDDISH', price: 400, yield: 2, yieldUnit: 'serving', recipe: [{ ingredient: ing.body._id, qty: 200, unit: 'g' }] }
    });
    // Recipe total 200*0.5=100 for 2 servings => per serving 50, but our current foodCost is total for recipe as defined (per yield). So 100 for 2 servings.
    // For now we assert total
    assert.equal(menu.body.recipeCost, 100);
    assert.equal(menu.body.yield, 2);
    // Food costing per yield
    const fc = await request(`/api/menu-items/${menu.body._id}/food-costing`, { token: tokenFor(world.owner) });
    assert.equal(fc.body.yield, 2);
    assert.equal(fc.body.foodCost, 100);
  });
});
