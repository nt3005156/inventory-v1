/**
 * Phase 11A — POS modifier catalog integrity.
 *
 * The modifier ENGINE shipped in Phase 4B and is not rebuilt here: selection
 * validation, cardinality, pricing and ingredient deltas already worked and
 * are covered by phase4b.modifiers.test.js.
 *
 * What this suite adds is CATALOG validation. An audit found five ways to
 * author a modifier catalog that the till would then choke on, or that would
 * deduct the wrong stock:
 *
 *   1. an ingredient belonging to ANOTHER restaurant
 *   2. a quantity with no unit (silently assumed the base unit)
 *   3. minSelect above the number of options (unorderable)
 *   4. single-select with minSelect > 1 (contradiction)
 *   5. a variant group where no option changes the price (does nothing)
 *
 * Each is now refused at authoring time, where an operator can fix it, rather
 * than surfacing as a broken menu item at the counter.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, MenuItem} from '../src/models/index.js';
import {InventoryBalance, Order, Restaurant} from '../src/models/operations.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let cheese;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  cheese = await Ingredient.create({
    restaurant: world.restaurant._id, code: 'CHZ', name: 'Cheese', unit: 'g', minimumStock: 0
  });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await moveStock({
        branch: world.branchA._id, ingredient: cheese._id, qty: 1000, unit: 'g', unitCost: 1,
        type: 'OPENING', reason: 'Modifier test opening stock', referenceType: 'test_fixture',
        referenceId: cheese._id, user: world.owner._id,
        idempotencyKey: `mod-open:${world.branchA._id}:${cheese._id}`
      }, session);
    });
  } finally {
    session.endSession();
  }
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);

const createItem = (body, token = owner()) =>
  request('/api/menu-items', {method: 'POST', token, body});

/** The catalog shape from the brief: Size (variant) + Extras (multi). */
const sizeGroup = {
  key: 'size', name: 'Size', kind: 'variant', selection: 'single', required: true,
  options: [
    {key: 'small', name: 'Small', priceOverride: 150},
    {key: 'medium', name: 'Medium', priceOverride: 200, isDefault: true},
    {key: 'large', name: 'Large', priceOverride: 260}
  ]
};

const extrasGroup = () => ({
  key: 'extras', name: 'Extras', kind: 'extra', selection: 'multi', maxSelect: 3,
  options: [
    {key: 'cheese', name: 'Cheese', priceDelta: 40, ingredient: String(cheese._id), qty: 20, unit: 'g'},
    {key: 'bacon', name: 'Bacon', priceDelta: 60},
    {key: 'sauce', name: 'Sauce', priceDelta: 15}
  ]
});

const buildBurger = async () => {
  const res = await createItem({
    name: 'Burger', price: 200, modifierGroups: [sizeGroup, extrasGroup()]
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const placeOrder = (menuItemId, modifiers, qty = 1) =>
  request('/api/orders', {
    method: 'POST', token: manager(),
    body: {
      branch: String(world.branchA._id), type: 'counter',
      items: [{menuItem: String(menuItemId), qty, modifiers}]
    }
  });

// ═══════════════════════════════════════════════════════════════════════════
// The brief's catalog, end to end
// ═══════════════════════════════════════════════════════════════════════════

describe('11A — Size and Extras catalog', () => {
  it('accepts the Size / Extras structure and stores it', async () => {
    const burger = await buildBurger();
    const stored = await MenuItem.findById(burger._id);
    assert.equal(stored.modifierGroups.length, 2);

    const size = stored.modifierGroups.find(g => g.key === 'size');
    assert.equal(size.kind, 'variant');
    assert.equal(size.selection, 'single');
    assert.equal(size.required, true);
    assert.deepEqual(size.options.map(o => o.name), ['Small', 'Medium', 'Large']);

    const extras = stored.modifierGroups.find(g => g.key === 'extras');
    assert.equal(extras.selection, 'multi');
    assert.equal(extras.maxSelect, 3);
    assert.deepEqual(extras.options.map(o => o.name), ['Cheese', 'Bacon', 'Sauce']);
  });

  it('prices a variant as a replacement and extras as deltas', async () => {
    const burger = await buildBurger();
    const res = await placeOrder(burger._id, [
      {group: 'size', option: 'large'},
      {group: 'extras', option: 'cheese'},
      {group: 'extras', option: 'bacon'}
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const line = res.body.items[0];
    // Large REPLACES the 200 base, then extras are added: 260 + 40 + 60.
    assert.equal(line.unitPrice, 360);
    assert.equal(line.basePrice, 200);
    assert.deepEqual(line.modifiers.map(m => m.name).sort(), ['Bacon', 'Cheese', 'Large']);

    // Persisted on the ticket, so a reprint or dispute shows what was chosen.
    const stored = await Order.findById(res.body._id);
    assert.equal(stored.items[0].modifiers.length, 3);
  });

  it('deducts modifier stock in proportion to line quantity', async () => {
    const burger = await buildBurger();
    const before = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: cheese._id
    })).quantity;

    const res = await placeOrder(burger._id, [
      {group: 'size', option: 'medium'}, {group: 'extras', option: 'cheese'}
    ], 2);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const after = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: cheese._id
    })).quantity;
    assert.equal(before - after, 40, '2 burgers x 20g of cheese');
  });

  it('enforces the catalog on every selection', async () => {
    const burger = await buildBurger();
    const cases = [
      ['a required group cannot be skipped', [{group: 'extras', option: 'cheese'}], /Size is required/],
      ['single-select takes one choice', [
        {group: 'size', option: 'small'}, {group: 'size', option: 'large'}
      ], /only one choice/],
      ['the same option cannot be picked twice', [
        {group: 'size', option: 'small'},
        {group: 'extras', option: 'cheese'}, {group: 'extras', option: 'cheese'}
      ], /Duplicate option/],
      ['an option must exist in the catalog', [
        {group: 'size', option: 'small'}, {group: 'extras', option: 'truffle'}
      ], /Unknown option/],
      ['a group must exist in the catalog', [
        {group: 'size', option: 'small'}, {group: 'toppings', option: 'anything'}
      ], /Unknown modifier group/]
    ];

    for (const [label, modifiers, pattern] of cases) {
      const res = await placeOrder(burger._id, modifiers);
      assert.equal(res.status, 400, `${label}: got ${res.status}`);
      assert.match(res.body.message, pattern, label);
    }
    assert.equal(await Order.countDocuments({}), 0, 'no invalid order may be written');
  });

  it('refuses more extras than the group permits', async () => {
    const item = await createItem({
      name: 'Capped', price: 100,
      modifierGroups: [{...extrasGroup(), maxSelect: 2}]
    });
    assert.equal(item.status, 201);
    const res = await placeOrder(item.body._id, [
      {group: 'extras', option: 'cheese'},
      {group: 'extras', option: 'bacon'},
      {group: 'extras', option: 'sauce'}
    ]);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /at most 2/);
  });

  it('does not let the till invent a price', async () => {
    const burger = await buildBurger();
    // A client attempting to set its own price on the line.
    const res = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: String(world.branchA._id), type: 'counter',
        items: [{
          menuItem: String(burger._id), qty: 1, unitPrice: 1,
          modifiers: [{group: 'size', option: 'large'}]
        }]
      }
    });
    // Either the field is rejected outright, or it is ignored and the catalog
    // price stands. Both are acceptable; silently honouring 1 is not.
    if (res.status === 201) {
      assert.equal(res.body.items[0].unitPrice, 260, 'the catalog price must win');
    } else {
      assert.equal(res.status, 400);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Catalog validation — the five gaps found by audit
// ═══════════════════════════════════════════════════════════════════════════

describe('11A — catalog validation', () => {
  it('refuses an ingredient belonging to another restaurant', async () => {
    // The order path already blocks this, so it is not a data leak — but
    // without this check the operator only discovers it when a guest orders.
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR', vatRate: 13});
    const foreign = await Ingredient.create({
      restaurant: rival._id, code: 'FGN', name: 'Foreign Cheese', unit: 'g'
    });

    const res = await createItem({
      name: 'Leaky', price: 100,
      modifierGroups: [{
        key: 'extras', name: 'Extras', kind: 'extra',
        options: [{key: 'ch', name: 'Cheese', ingredient: String(foreign._id), qty: 20, unit: 'g'}]
      }]
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /does not belong to this restaurant/);
    assert.equal(await MenuItem.countDocuments({name: 'Leaky'}), 0);
  });

  it('refuses a quantity with no unit', async () => {
    // The order path converts qty into the ingredient's base unit; with no
    // unit to convert from it assumed the base unit and deducted the wrong
    // amount rather than failing.
    const res = await createItem({
      name: 'Unitless', price: 100,
      modifierGroups: [{
        key: 'extras', name: 'Extras', kind: 'extra',
        options: [{key: 'ch', name: 'Cheese', ingredient: String(cheese._id), qty: 20}]
      }]
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /needs a unit/);
  });

  it('refuses a group that can never be satisfied', async () => {
    const res = await createItem({
      name: 'Impossible', price: 100,
      modifierGroups: [{
        key: 'extras', name: 'Extras', selection: 'multi', minSelect: 5,
        options: [{key: 'a', name: 'Only one'}]
      }]
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /requires 5 choices but only offers 1/);
  });

  it('refuses a single-select group that demands more than one', async () => {
    const res = await createItem({
      name: 'Contradiction', price: 100,
      modifierGroups: [{
        key: 'size', name: 'Size', selection: 'single', minSelect: 2,
        options: [{key: 's', name: 'S'}, {key: 'm', name: 'M'}]
      }]
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /single-select but requires 2/);
  });

  it('refuses a variant group where no option changes the price', async () => {
    const res = await createItem({
      name: 'Decorative', price: 100,
      modifierGroups: [{
        key: 'size', name: 'Size', kind: 'variant', selection: 'single',
        options: [{key: 's', name: 'Small'}, {key: 'l', name: 'Large'}]
      }]
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /no option changes the price/);

    // A variant priced by delta rather than override is still legitimate.
    const byDelta = await createItem({
      name: 'Delta Sized', price: 100,
      modifierGroups: [{
        key: 'size', name: 'Size', kind: 'variant', selection: 'single',
        options: [{key: 's', name: 'Small'}, {key: 'l', name: 'Large', priceDelta: 50}]
      }]
    });
    assert.equal(byDelta.status, 201);
  });

  it('keeps the Phase 4B structural rules intact', async () => {
    const cases = [
      ['duplicate group keys', [
        {key: 'size', name: 'Size', options: [{key: 's', name: 'S'}]},
        {key: 'size', name: 'Size again', options: [{key: 'm', name: 'M'}]}
      ], /Duplicate modifier group/],
      ['duplicate option keys', [
        {key: 'size', name: 'Size', options: [{key: 's', name: 'S'}, {key: 's', name: 'S2'}]}
      ], /Duplicate option/],
      ['min above max', [
        {key: 'e', name: 'Extras', selection: 'multi', minSelect: 3, maxSelect: 1,
          options: [{key: 'a', name: 'A'}, {key: 'b', name: 'B'}, {key: 'c', name: 'C'}]}
      ], /minimum above its maximum/],
      ['single-select allowing several', [
        {key: 'size', name: 'Size', selection: 'single', maxSelect: 3,
          options: [{key: 's', name: 'S'}, {key: 'm', name: 'M'}]}
      ], /single-select but allows 3/],
      ['two defaults in one single-select group', [
        {key: 'size', name: 'Size', selection: 'single',
          options: [{key: 's', name: 'S', isDefault: true}, {key: 'm', name: 'M', isDefault: true}]}
      ], /only have one default/],
      // Zod rejects an empty options array before the semantic validator is
      // reached, so the message is a schema error rather than a bespoke one.
      ['a group with no options', [
        {key: 'size', name: 'Size', options: []}
      ], /at least one option|Invalid|too_small/]
    ];

    for (const [label, groups, pattern] of cases) {
      const res = await createItem({name: `Bad ${label}`, price: 100, modifierGroups: groups});
      assert.equal(res.status, 400, `${label}: got ${res.status}`);
      assert.match(res.body.message, pattern, label);
    }
  });

  it('applies the same validation when a catalog is edited, not only created', async () => {
    const burger = await buildBurger();
    const rival = await Restaurant.create({name: 'Rival 2', currency: 'NPR', vatRate: 13});
    const foreign = await Ingredient.create({
      restaurant: rival._id, code: 'FG2', name: 'Foreign', unit: 'g'
    });

    const res = await request(`/api/menu-items/${burger._id}`, {
      method: 'PATCH', token: owner(),
      body: {
        modifierGroups: [{
          key: 'extras', name: 'Extras', kind: 'extra',
          options: [{key: 'ch', name: 'Cheese', ingredient: String(foreign._id), qty: 20, unit: 'g'}]
        }]
      }
    });
    assert.equal(res.status, 400, 'an edit must not be a way around creation validation');

    // The original catalog must be untouched.
    const stored = await MenuItem.findById(burger._id);
    assert.equal(stored.modifierGroups.length, 2);
  });

  it('reserves catalog authoring for owners and managers', async () => {
    const res = await createItem(
      {name: 'By Staff', price: 100, modifierGroups: [sizeGroup]},
      tokenFor(world.staffA)
    );
    assert.equal(res.status, 403);
    assert.equal(await MenuItem.countDocuments({name: 'By Staff'}), 0);
  });
});
