import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {MenuItem, Sale} from '../src/models/index.js';
import {classifyAgainstMenu, classifyMenuItem, POPULARITY_RULE} from '../src/services/menuEngineering.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const REPORT = '/api/analytics/menu-engineering/report';

function order(menuItemId, qty, branch = world.branchA) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {branch: String(branch._id), type: 'counter', items: [{menuItem: String(menuItemId), qty}]}
  });
}

async function stock(ingredient, qty, unitCost, branch = world.branchA) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => moveStock({
      branch: branch._id,
      ingredient,
      qty,
      unit: 'g',
      unitCost,
      type: 'PURCHASE',
      reason: 'Phase 3E fixture',
      referenceType: 'test_fixture',
      referenceId: ingredient,
      user: world.owner._id,
      idempotencyKey: `p3e-${ingredient}-${branch._id}-${Math.random()}`
    }, session));
  } finally {
    await session.endSession();
  }
}

describe('Phase 3E — matrix classification helpers', () => {
  it('keeps the legacy Kasavan–Smith cutoffs intact', () => {
    assert.equal(classifyMenuItem(0.2, 120), 'Star');
    assert.equal(classifyMenuItem(0.2, 80), 'Plow-horse');
    assert.equal(classifyMenuItem(0.05, 120), 'Puzzle');
    assert.equal(classifyMenuItem(0.05, 80), 'Dog');
  });

  it('classifies against the menu average using the 70% popularity rule', () => {
    assert.equal(POPULARITY_RULE, 0.7);
    // popularityIndex >= 0.7 is popular; margin >= average is profitable
    assert.equal(classifyAgainstMenu(1.4, 200, 150), 'Star');
    assert.equal(classifyAgainstMenu(1.4, 100, 150), 'Plow-horse');
    assert.equal(classifyAgainstMenu(0.2, 200, 150), 'Puzzle');
    assert.equal(classifyAgainstMenu(0.2, 100, 150), 'Dog');
    // exactly on both boundaries counts as popular and profitable
    assert.equal(classifyAgainstMenu(0.7, 150, 150), 'Star');
  });
});

describe('Phase 3E — GET /api/analytics/menu-engineering/report', () => {
  it('analyzes popularity, food cost, margin, profitable and low-margin items', async () => {
    // Biryani: price 350, sold-line food cost 11.25/plate.
    const cheapDessert = await MenuItem.create({
      name: 'Puzzle Pudding',
      price: 400,
      packagingCost: 0,
      recipe: [{ingredient: world.ingredient._id, qty: 100, unit: 'g'}]
    });
    // A deliberately loss-making item: price barely above its recipe cost.
    const dog = await MenuItem.create({
      name: 'Dog Platter',
      price: 20,
      packagingCost: 5,
      recipe: [{ingredient: world.ingredient._id, qty: 500, unit: 'g'}]
    });

    const sold = await order(world.menu._id, 8);
    assert.equal(sold.status, 201, sold.body?.message);
    const dogSale = await order(dog._id, 1);
    assert.equal(dogSale.status, 201, dogSale.body?.message);

    // Cancelled tickets and legacy Sale rows must not move the numbers.
    const cancelled = await order(world.menu._id, 50);
    assert.equal((await request('/api/orders/' + cancelled.body._id + '/status', {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'cancelled'}
    })).status, 200);
    await Sale.create({
      items: [{menuItem: world.menu._id, name: 'Chicken Biryani', qty: 99, unitPrice: 350, foodCost: 11.25}],
      subtotal: 34650, vat: 0, total: 34650, cogs: 1113.75, grossProfit: 33536.25
    });

    const res = await request(`${REPORT}?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(res.status, 200, res.body?.message);
    const body = res.body;
    assert.equal(body.source, 'live');
    assert.equal(body.currency, 'NPR');
    assert.equal(body.items.length, 3);

    const biryani = body.items.find(x => x.name === 'Chicken Biryani');
    const pudding = body.items.find(x => x.name === 'Puzzle Pudding');
    const platter = body.items.find(x => x.name === 'Dog Platter');

    // --- popularity ---
    assert.equal(body.summary.plates, 9);
    assert.equal(biryani.soldQty, 8);
    assert.equal(biryani.popularity, 8 / 9);
    assert.equal(platter.soldQty, 1);
    assert.equal(pudding.soldQty, 0);
    assert.equal(pudding.popularity, 0);
    // expected equal share is 1/3, so index = share / (1/3)
    assert.equal(body.popularity.expectedSharePercent, 33.33);
    assert.equal(biryani.popularityIndex, 2.67);
    assert.equal(biryani.popular, true);
    assert.equal(pudding.popular, false);
    assert.equal(body.popularity.top[0].name, 'Chicken Biryani');

    // --- food cost (sold lines keep their captured cost, unsold price off live recipe) ---
    assert.equal(biryani.costSource, 'sold');
    assert.equal(biryani.recipeCost, 11.25);
    assert.equal(biryani.foodCost, 11.25);
    assert.equal(biryani.foodCostPercent, 3.21); // 11.25 / 350
    assert.equal(pudding.costSource, 'recipe');
    assert.equal(pudding.foodCost, 4.5); // 100g @ 0.045
    // packaging cost is included in food cost
    assert.equal(platter.packagingCost, 5);
    assert.equal(platter.foodCost, 27.5); // 500g @ 0.045 = 22.5, + 5 packaging

    // --- margin ---
    assert.equal(biryani.margin, 338.75);
    assert.equal(biryani.marginPercent, 96.79);
    assert.equal(biryani.totalMargin, 2710); // 338.75 x 8
    assert.equal(biryani.revenue, 2800);
    assert.equal(platter.margin, -7.5); // 20 - 27.5, sells at a loss
    assert.equal(body.summary.revenue, 2820); // 2800 + 20
    assert.equal(body.summary.foodCost, 117.5); // 11.25x8 + 27.5x1
    assert.equal(body.summary.grossMargin, 2702.5);

    // --- profitable items ---
    const profitableNames = body.profitableItems.map(x => x.name);
    assert.ok(profitableNames.includes('Chicken Biryani'));
    assert.ok(profitableNames.includes('Puzzle Pudding'));
    assert.ok(!profitableNames.includes('Dog Platter'));
    assert.equal(biryani.profitable, true);
    assert.equal(platter.profitable, false);
    assert.equal(body.summary.profitableItems, profitableNames.length);

    // --- low-margin items ---
    const lowNames = body.lowMarginItems.map(x => x.name);
    assert.deepEqual(lowNames, ['Dog Platter']);
    assert.equal(platter.lowMargin, true);
    assert.equal(biryani.lowMargin, false);
    assert.equal(body.summary.lowMarginItems, 1);
    assert.ok(body.lowMarginItems[0].recommendation.length > 0);

    // --- matrix mix ---
    assert.equal(biryani.matrixClass, 'Star');
    assert.equal(platter.matrixClass, 'Dog');
    assert.equal(pudding.matrixClass, 'Puzzle');
    assert.equal(body.summary.mix.Star + body.summary.mix['Plow-horse'] + body.summary.mix.Puzzle + body.summary.mix.Dog, 3);
  });

  it('flags a popular item over the food-cost target as a low-margin plow-horse', async () => {
    const costly = await MenuItem.create({
      name: 'Costly Thali',
      price: 100,
      recipe: [{ingredient: world.ingredient._id, qty: 1000, unit: 'g'}]
    });
    // Re-price the stock so the thali costs 60% of its menu price.
    await stock(world.ingredient._id, 20000, 0.075);
    const placed = await order(costly._id, 10);
    assert.equal(placed.status, 201, placed.body?.message);

    const res = await request(`${REPORT}?branch=${world.branchA._id}&targetFoodCostPercent=35`, {token: tokenFor(world.owner)});
    assert.equal(res.status, 200, res.body?.message);
    const thali = res.body.items.find(x => x.name === 'Costly Thali');
    assert.equal(res.body.summary.targetFoodCostPercent, 35);
    assert.ok(thali.foodCostPercent > 35, `expected over target, got ${thali.foodCostPercent}`);
    assert.equal(thali.lowMargin, true);
    assert.equal(thali.overTargetBy, Math.round((thali.foodCostPercent - 35) * 100) / 100);
    assert.equal(thali.popular, true);
    assert.ok(res.body.lowMarginItems.some(x => x.name === 'Costly Thali'));
  });

  it('honours a custom food-cost target', async () => {
    const placed = await order(world.menu._id, 3);
    assert.equal(placed.status, 201, placed.body?.message);
    // Biryani food cost is ~3.21% of price; a 1% target makes it low-margin.
    const strict = await request(`${REPORT}?branch=${world.branchA._id}&targetFoodCostPercent=1`, {token: tokenFor(world.owner)});
    assert.equal(strict.status, 200, strict.body?.message);
    assert.equal(strict.body.summary.targetFoodCostPercent, 1);
    assert.equal(strict.body.items.find(x => x.name === 'Chicken Biryani').lowMargin, true);

    const loose = await request(`${REPORT}?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(loose.body.summary.targetFoodCostPercent, 35);
    assert.equal(loose.body.items.find(x => x.name === 'Chicken Biryani').lowMargin, false);
  });

  it('returns an empty but well-formed report before any sales', async () => {
    const res = await request(`${REPORT}?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.summary.plates, 0);
    assert.equal(res.body.summary.revenue, 0);
    assert.equal(res.body.summary.grossMarginPercent, 0);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].soldQty, 0);
    assert.equal(res.body.items[0].costSource, 'recipe');
    assert.equal(res.body.popularity.top.length, 1);
  });

  it('scopes to the requested branch only', async () => {
    const a = await order(world.menu._id, 2, world.branchA);
    assert.equal(a.status, 201, a.body?.message);
    const b = await order(world.menu._id, 7, world.branchB);
    assert.equal(b.status, 201, b.body?.message);

    const branchA = await request(`${REPORT}?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(branchA.body.summary.plates, 2);
    const branchB = await request(`${REPORT}?branch=${world.branchB._id}`, {token: tokenFor(world.owner)});
    assert.equal(branchB.body.summary.plates, 7);
    // Owner with no branch filter sees the whole restaurant.
    const all = await request(REPORT, {token: tokenFor(world.owner)});
    assert.equal(all.body.summary.plates, 9);
    assert.equal(all.body.branch, null);
  });

  it('keeps the legacy array endpoint unchanged', async () => {
    const placed = await order(world.menu._id, 2);
    assert.equal(placed.status, 201, placed.body?.message);
    const legacy = await request(`/api/analytics/menu-engineering?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(legacy.status, 200, legacy.body?.message);
    assert.ok(Array.isArray(legacy.body));
    const biryani = legacy.body.find(x => x.name === 'Chicken Biryani');
    assert.equal(biryani.soldQty, 2);
    assert.equal(biryani.popularity, 1);
    assert.equal(biryani.margin, 338.75);
    assert.equal(biryani.classification, 'Star');
    assert.equal(biryani.costSource, 'sold');
  });

  it('rejects staff, guests, missing tokens and cross-branch managers', async () => {
    assert.equal((await request(`${REPORT}?branch=${world.branchA._id}`, {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request(`${REPORT}?branch=${world.branchA._id}`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request(`${REPORT}?branch=${world.branchA._id}`, {token: guest})).status, 403);
    assert.equal((await request(`${REPORT}?branch=${world.branchB._id}`, {token: tokenFor(world.manager)})).status, 403);
  });
});
