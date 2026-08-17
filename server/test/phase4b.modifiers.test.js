import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, MenuItem} from '../src/models/index.js';
import {InventoryBalance, InventoryTransaction} from '../src/models/operations.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {
  MODIFIER_KINDS,
  applyModifierPricing,
  modifierIngredientDeltas,
  normalizeInstructions,
  resolveModifiers
} from '../src/services/modifiers.js';
import {combineItems} from '../src/services/tables.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const token = () => tokenFor(world.owner);

// A momo with a size variant, a stock-backed extra, a price-only add-on and a removal.
async function buildMenu() {
  const cheese = await Ingredient.create({
    restaurant: world.restaurant._id, code: 'ING-CHZ', name: 'Cheese', unit: 'g', minimumStock: 100
  });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => moveStock({
      branch: world.branchA._id,
      ingredient: cheese._id,
      qty: 5000,
      unit: 'g',
      unitCost: 2,
      type: 'OPENING',
      reason: 'Phase 4B cheese fixture',
      referenceType: 'test_fixture',
      referenceId: cheese._id,
      user: world.owner._id,
      idempotencyKey: `p4b-cheese-${cheese._id}`
    }, session));
  } finally {
    await session.endSession();
  }
  const item = await MenuItem.create({
    restaurant: world.restaurant._id,
    name: 'Chicken Momo',
    price: 350,
    vatInclusive: false,
    recipe: [{ingredient: world.ingredient._id, qty: 200, unit: 'g'}],
    modifierGroups: [
      {
        key: 'size', name: 'Size', kind: 'variant', selection: 'single', required: true,
        options: [
          {key: 'regular', name: 'Regular', priceOverride: null, priceDelta: 0, isDefault: true},
          {key: 'large', name: 'Large', priceOverride: 450}
        ]
      },
      {
        key: 'extras', name: 'Extras', kind: 'extra', selection: 'multi', maxSelect: 2,
        options: [
          {key: 'cheese', name: 'Extra cheese', priceDelta: 60, ingredient: cheese._id, qty: 30, unit: 'g'},
          {key: 'spicy', name: 'Extra spicy', priceDelta: 20}
        ]
      },
      {
        key: 'addons', name: 'Add-ons', kind: 'addon', selection: 'multi',
        options: [{key: 'soup', name: 'Side soup', priceDelta: 80}]
      },
      {
        key: 'remove', name: 'Remove', kind: 'removal', selection: 'multi',
        options: [{key: 'no-rice', name: 'No rice', priceDelta: 0, ingredient: world.ingredient._id, qty: 50, unit: 'g'}]
      }
    ]
  });
  return {item, cheese};
}

function order(body) {
  return request('/api/orders', {method: 'POST', token: token(), body: {branch: String(world.branchA._id), type: 'counter', ...body}});
}

describe('Phase 4B — modifier resolution', () => {
  it('exposes the four modifier kinds', () => {
    assert.deepEqual(MODIFIER_KINDS, ['variant', 'extra', 'addon', 'removal']);
  });

  it('rejects unknown groups and options, and duplicates', async () => {
    const {item} = await buildMenu();
    assert.throws(() => resolveModifiers({menuItem: item, selections: [{group: 'nope', option: 'x'}]}), /Unknown modifier group/);
    assert.throws(() => resolveModifiers({menuItem: item, selections: [{group: 'size', option: 'ghost'}]}), /Unknown option/);
    assert.throws(() => resolveModifiers({
      menuItem: item,
      selections: [{group: 'size', option: 'large'}, {group: 'extras', option: 'cheese'}, {group: 'extras', option: 'cheese'}]
    }), /Duplicate option/);
  });

  it('enforces required, single-select and maxSelect cardinality', async () => {
    const {item} = await buildMenu();
    assert.throws(() => resolveModifiers({menuItem: item, selections: []}), /Size is required/);
    assert.throws(() => resolveModifiers({
      menuItem: item, selections: [{group: 'size', option: 'regular'}, {group: 'size', option: 'large'}]
    }), /only one choice/);
    // Exactly maxSelect (2 extras) is allowed...
    assert.equal(resolveModifiers({
      menuItem: item,
      selections: [
        {group: 'size', option: 'large'},
        {group: 'extras', option: 'cheese'},
        {group: 'extras', option: 'spicy'}
      ]
    }).length, 3);
    // ...but a third extra is not, so a tighter group rejects it.
    const tight = {
      ...item.toObject(),
      modifierGroups: [{
        key: 'extras', name: 'Extras', kind: 'extra', selection: 'multi', maxSelect: 1,
        options: [{key: 'cheese', name: 'Extra cheese'}, {key: 'spicy', name: 'Extra spicy'}]
      }]
    };
    assert.throws(() => resolveModifiers({
      menuItem: tight,
      selections: [{group: 'extras', option: 'cheese'}, {group: 'extras', option: 'spicy'}]
    }), /allows at most 1/);
  });

  it('overrides the price for a variant and adds deltas for everything else', async () => {
    const {item} = await buildMenu();
    const regular = resolveModifiers({menuItem: item, selections: [{group: 'size', option: 'regular'}]});
    assert.equal(applyModifierPricing({basePrice: 350, modifiers: regular}).unitPrice, 350);

    const large = resolveModifiers({menuItem: item, selections: [{group: 'size', option: 'large'}]});
    assert.equal(applyModifierPricing({basePrice: 350, modifiers: large}).unitPrice, 450);

    const loaded = resolveModifiers({
      menuItem: item,
      selections: [{group: 'size', option: 'large'}, {group: 'extras', option: 'cheese'}, {group: 'addons', option: 'soup'}]
    });
    const priced = applyModifierPricing({basePrice: 350, modifiers: loaded});
    assert.equal(priced.unitPrice, 590); // 450 override + 60 + 80
    assert.equal(priced.modifierTotal, 240);
  });

  it('maps extras to positive stock and removals to negative stock', async () => {
    const {item, cheese} = await buildMenu();
    const mods = resolveModifiers({
      menuItem: item,
      selections: [{group: 'size', option: 'large'}, {group: 'extras', option: 'cheese'}, {group: 'remove', option: 'no-rice'}]
    });
    const deltas = modifierIngredientDeltas(mods);
    assert.equal(deltas.length, 2);
    assert.equal(deltas.find(d => String(d.ingredient) === String(cheese._id)).qty, 30);
    assert.equal(deltas.find(d => String(d.ingredient) === String(world.ingredient._id)).qty, -50);
    // Price-only options never reach inventory.
    const priceOnly = resolveModifiers({menuItem: item, selections: [{group: 'size', option: 'large'}, {group: 'addons', option: 'soup'}]});
    assert.equal(modifierIngredientDeltas(priceOnly).length, 0);
  });

  it('trims and bounds special instructions', () => {
    assert.equal(normalizeInstructions('  less oil  '), 'less oil');
    assert.equal(normalizeInstructions(undefined), '');
    assert.throws(() => normalizeInstructions('x'.repeat(501)), /500 characters or fewer/);
  });
});

describe('Phase 4B — modifiers on POST /api/orders', () => {
  it('prices a variant, extra and add-on onto the line and the order total', async () => {
    const {item} = await buildMenu();
    const res = await order({
      items: [{
        menuItem: String(item._id),
        qty: 2,
        modifiers: [{group: 'size', option: 'large'}, {group: 'extras', option: 'cheese'}, {group: 'addons', option: 'soup'}],
        specialInstructions: 'Less oil, serve hot'
      }]
    });
    assert.equal(res.status, 201, res.body?.message);
    const line = res.body.items[0];
    assert.equal(line.basePrice, 350);
    assert.equal(line.unitPrice, 590);
    assert.equal(line.specialInstructions, 'Less oil, serve hot');
    assert.equal(line.modifiers.length, 3);
    assert.equal(line.modifiers.find(m => m.optionKey === 'large').kind, 'variant');
    assert.equal(line.modifiers.find(m => m.optionKey === 'cheese').price, 60);
    // 2 x 590 = 1180 net, +13% VAT
    assert.equal(res.body.subtotal, 1180);
    assert.equal(res.body.vat, 153.4);
    assert.equal(res.body.total, 1333.4);
  });

  it('deducts extra ingredient stock for an extra', async () => {
    const {item, cheese} = await buildMenu();
    const res = await order({
      items: [{menuItem: String(item._id), qty: 2, modifiers: [{group: 'size', option: 'regular'}, {group: 'extras', option: 'cheese'}]}]
    });
    assert.equal(res.status, 201, res.body?.message);
    const balance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: cheese._id});
    assert.equal(balance.quantity, 4940); // 5000 - (30 x 2)
    // Food cost carries the modifier's ingredient cost: 30g @ 2 = 60 per unit.
    assert.ok(res.body.items[0].foodCost > 60, `expected modifier cost folded in, got ${res.body.items[0].foodCost}`);
  });

  it('credits stock back when an ingredient is removed', async () => {
    const {item} = await buildMenu();
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    const res = await order({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'regular'}, {group: 'remove', option: 'no-rice'}]}]
    });
    assert.equal(res.status, 201, res.body?.message);
    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    // Recipe uses 200g, the removal gives 50g back, so only 150g leaves stock.
    assert.equal(before.quantity - after.quantity, 150);
    assert.equal(res.body.items[0].modifiers.find(m => m.optionKey === 'no-rice').removed, true);
  });

  it('refuses to remove more of an ingredient than the recipe uses', async () => {
    const greedy = await MenuItem.create({
      restaurant: world.restaurant._id,
      name: 'Greedy Removal',
      price: 200,
      vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 40, unit: 'g'}],
      modifierGroups: [{
        key: 'remove', name: 'Remove', kind: 'removal', selection: 'multi',
        options: [{key: 'no-rice', name: 'No rice', ingredient: world.ingredient._id, qty: 500, unit: 'g'}]
      }]
    });
    const res = await order({items: [{menuItem: String(greedy._id), qty: 1, modifiers: [{group: 'remove', option: 'no-rice'}]}]});
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Cannot remove more/);
  });

  it('writes no ledger movement when a removal cancels the recipe exactly', async () => {
    const neutral = await MenuItem.create({
      restaurant: world.restaurant._id,
      name: 'Neutral Plate',
      price: 100,
      vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 60, unit: 'g'}],
      modifierGroups: [{
        key: 'remove', name: 'Remove', kind: 'removal', selection: 'multi',
        options: [{key: 'no-rice', name: 'No rice', ingredient: world.ingredient._id, qty: 60, unit: 'g'}]
      }]
    });
    const res = await order({items: [{menuItem: String(neutral._id), qty: 1, modifiers: [{group: 'remove', option: 'no-rice'}]}]});
    assert.equal(res.status, 201, res.body?.message);
    const moves = await InventoryTransaction.countDocuments({referenceId: res.body._id});
    assert.equal(moves, 0);
  });

  it('rejects invalid modifier payloads at the API', async () => {
    const {item} = await buildMenu();
    // Missing the required Size group.
    assert.equal((await order({items: [{menuItem: String(item._id), qty: 1}]})).status, 400);
    // Unknown option.
    assert.equal((await order({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'gigantic'}]}]
    })).status, 400);
    // Two sizes on a single-select group.
    assert.equal((await order({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'regular'}, {group: 'size', option: 'large'}]}]
    })).status, 400);
    // Modifiers on an item that declares none.
    assert.equal((await order({
      items: [{menuItem: String(world.menu._id), qty: 1, modifiers: [{group: 'size', option: 'large'}]}]
    })).status, 400);
    // Over-long special instructions.
    assert.equal((await order({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'regular'}], specialInstructions: 'x'.repeat(501)}]
    })).status, 400);
  });

  it('keeps modifiers and instructions on a split check', async () => {
    const {item} = await buildMenu();
    const created = await request('/api/orders', {
      method: 'POST',
      token: token(),
      body: {
        branch: String(world.branchA._id),
        type: 'dine-in',
        table: String(world.table._id),
        items: [{
          menuItem: String(item._id), qty: 2,
          modifiers: [{group: 'size', option: 'large'}, {group: 'extras', option: 'cheese'}],
          specialInstructions: 'No coriander'
        }]
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    const line = created.body.items[0];
    const split = await request('/api/orders/' + created.body._id + '/split', {
      method: 'POST', token: token(), body: {items: [{itemId: String(line._id), qty: 1}]}
    });
    assert.equal(split.status, 201, split.body?.message);
    const child = split.body.splitOrder.items[0];
    assert.equal(child.unitPrice, 510); // 450 override + 60 cheese
    assert.equal(child.specialInstructions, 'No coriander');
    assert.equal(child.modifiers.length, 2);
  });

  it('does not merge lines that differ by modifier or instruction', () => {
    const base = {menuItem: 'm1', name: 'Momo', qty: 1, unitPrice: 350, inventoryRequirements: []};
    const plain = {...base, modifiers: [], specialInstructions: ''};
    const cheesy = {...base, unitPrice: 410, modifiers: [{groupKey: 'extras', optionKey: 'cheese', price: 60}], specialInstructions: ''};
    const noted = {...base, modifiers: [], specialInstructions: 'extra napkins'};

    assert.equal(combineItems([plain], [cheesy]).length, 2);
    assert.equal(combineItems([plain], [noted]).length, 2);
    // Identical lines still merge into one.
    const merged = combineItems([plain], [{...plain}]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].qty, 2);
  });
});

describe('Phase 4B — modifier catalog on menu items', () => {
  it('stores modifier groups through the menu API', async () => {
    const res = await request('/api/menu-items', {
      method: 'POST',
      token: token(),
      body: {
        name: 'Catalog Momo',
        code: 'CATMOMO',
        price: 300,
        recipe: [{ingredient: String(world.ingredient._id), qty: 100, unit: 'g'}],
        modifierGroups: [{
          key: 'size', name: 'Size', kind: 'variant', selection: 'single', required: true,
          options: [{key: 'sm', name: 'Small'}, {key: 'lg', name: 'Large', priceOverride: 400}]
        }]
      }
    });
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.modifierGroups.length, 1);
    assert.equal(res.body.modifierGroups[0].options.length, 2);
    assert.equal(res.body.modifierGroups[0].options[1].priceOverride, 400);

    const fetched = await request('/api/menu-items/' + res.body._id, {token: token()});
    assert.equal(fetched.body.modifierGroups[0].key, 'size');
  });

  it('rejects malformed modifier catalogs', async () => {
    const body = (groups) => ({
      name: 'Bad Momo ' + Math.random().toString(36).slice(2, 7),
      price: 300,
      recipe: [{ingredient: String(world.ingredient._id), qty: 100, unit: 'g'}],
      modifierGroups: groups
    });
    const post = g => request('/api/menu-items', {method: 'POST', token: token(), body: body(g)});

    // duplicate group keys
    assert.equal((await post([
      {key: 'size', name: 'Size', options: [{key: 'a', name: 'A'}]},
      {key: 'size', name: 'Size again', options: [{key: 'b', name: 'B'}]}
    ])).status, 400);
    // duplicate option keys
    assert.equal((await post([
      {key: 'size', name: 'Size', options: [{key: 'a', name: 'A'}, {key: 'a', name: 'A2'}]}
    ])).status, 400);
    // qty without an ingredient
    assert.equal((await post([
      {key: 'extras', name: 'Extras', options: [{key: 'x', name: 'X', qty: 20, unit: 'g'}]}
    ])).status, 400);
    // single-select that allows more than one
    assert.equal((await post([
      {key: 'size', name: 'Size', selection: 'single', maxSelect: 3, options: [{key: 'a', name: 'A'}]}
    ])).status, 400);
    // no options at all
    assert.equal((await post([{key: 'empty', name: 'Empty', options: []}])).status, 400);
  });
});
