import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Ingredient, MenuItem, Supplier, User} from '../src/models/index.js';
import {
  Branch, Customer, Delivery, InventoryBalance, InventoryBatch, InventoryTransaction, Order,
  Payment, PurchaseOrder, Restaurant, RestaurantTable
} from '../src/models/operations.js';
import {CUSTOMERS, INGREDIENTS, MENU, SUPPLIERS, TABLES} from '../src/demo/catalogue.js';
import {ONBOARDING_STEPS, provisionRestaurant} from '../src/services/onboarding.js';
import {DEMO_ACCOUNTS, DEMO_PASSWORD, assertNotProduction, seedDemoData} from '../src/seed.js';

/**
 * Phase 24 — demo data and new-restaurant onboarding.
 *
 * Two things under test:
 *
 *   1. The demo dataset is REAL — not a pile of documents that merely exist,
 *      but data that reconciles: stock balances that match the ledger, orders
 *      whose totals match the pricing engine, recipes that resolve.
 *   2. The onboarding chain enforces its own order and its tenancy.
 */

let world;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

/**
 * The harness world is set up PER BLOCK rather than globally.
 *
 * A global `beforeEach` would re-seed the small test world before every test,
 * including the ones in the demo-seed block below — wiping the demo tenant
 * that block's `before` had just created. That is a fixture bug and it
 * presents exactly like a data-integrity failure ("balance 20000 != ledger 0"),
 * so it is worth naming.
 */
async function useTestWorld() {
  await clearDb();
  world = await seedWorld();
}

// ── the demo catalogue ───────────────────────────────────────────────────────

describe('Phase 24 · demo catalogue meets the brief', () => {
  it('carries the volumes the brief asks for', () => {
    assert.ok(INGREDIENTS.length >= 50, `50+ ingredients, got ${INGREDIENTS.length}`);
    assert.ok(MENU.length >= 50, `50+ menu items, got ${MENU.length}`);
    assert.ok(SUPPLIERS.length >= 15, `15+ suppliers, got ${SUPPLIERS.length}`);
    assert.ok(Object.keys(TABLES).length >= 2, 'multiple branches');
    assert.ok(CUSTOMERS.length >= 10, 'customers');
  });

  it('has no duplicate ingredient codes or menu names', () => {
    // A duplicate ingredient code breaks the unique-per-restaurant assumption
    // the onboarding importer relies on.
    const codes = INGREDIENTS.map(row => row[0]);
    assert.equal(new Set(codes).size, codes.length, 'duplicate ingredient code');
    const names = MENU.map(row => row[0]);
    assert.equal(new Set(names).size, names.length, 'duplicate menu item name');
    const supplierNames = SUPPLIERS.map(row => row[0]);
    assert.equal(new Set(supplierNames).size, supplierNames.length, 'duplicate supplier name');
  });

  it('has every recipe line pointing at a real ingredient', () => {
    // A dangling recipe reference produces a menu item that cannot be sold and
    // a food cost of zero — which silently reads as 100% margin.
    const codes = new Set(INGREDIENTS.map(row => row[0]));
    for (const [name, , , , , , , , recipe] of MENU) {
      assert.ok(recipe.length, `${name} has no recipe`);
      for (const [code, qty] of recipe) {
        assert.ok(codes.has(code), `${name} references unknown ingredient ${code}`);
        assert.ok(qty > 0, `${name} has a non-positive quantity for ${code}`);
      }
    }
  });

  it('prices every dish above its food cost, in a believable band', () => {
    /**
     * The point of realistic demo data. A dataset where dishes cost more than
     * they sell for, or show a 95% margin, teaches an operator nothing and
     * makes every analytics screen nonsense.
     */
    const cost = Object.fromEntries(INGREDIENTS.map(row => [row[0], row[4]]));
    for (const [name, , , price, , , , , recipe] of MENU) {
      const foodCost = recipe.reduce((sum, [code, qty]) => sum + cost[code] * qty, 0);
      assert.ok(foodCost > 0, `${name} has no food cost`);
      assert.ok(foodCost < price, `${name} costs ${foodCost.toFixed(2)} but sells for ${price}`);
      const ratio = (foodCost / price) * 100;
      assert.ok(ratio <= 45, `${name} food cost ${ratio.toFixed(1)}% is implausibly high`);
      assert.ok(ratio >= 5, `${name} food cost ${ratio.toFixed(1)}% is implausibly low`);
    }
  });
});

// ── the seeded dataset ───────────────────────────────────────────────────────

describe('Phase 24 · the demo seed produces consistent data', () => {
  let counts;

  // Seeded once for this block: it writes a whole tenant and is slow. No
  // `beforeEach` here on purpose — re-seeding between tests would triple the
  // runtime for no extra coverage, and the tests below are read-only.
  before(async () => {
    await clearDb();
    ({counts} = await seedDemoData({log: () => {}}));
  });

  it('creates everything the brief lists', () => {
    assert.ok(counts.ingredients >= 50, `ingredients ${counts.ingredients}`);
    assert.ok(counts.menuItems >= 50, `menu items ${counts.menuItems}`);
    assert.ok(counts.suppliers >= 15, `suppliers ${counts.suppliers}`);
    assert.ok(counts.branches >= 2, 'multiple branches');
    assert.ok(counts.customers > 0, 'customers');
    assert.ok(counts.orders > 0, 'orders');
    assert.ok(counts.payments > 0, 'payments');
    assert.ok(counts.purchaseOrders > 0, 'purchase orders');
    assert.ok(counts.inventoryBalances > 0, 'inventory');
    assert.ok(counts.batches > 0, 'batches');
    assert.ok(counts.tables > 0, 'tables');
    assert.ok(counts.deliveries > 0, 'deliveries');
  });

  it('keeps every stock balance reconciled with the ledger', async () => {
    /**
     * The real test of the seed. Balances written directly would look fine on
     * screen and be unreconcilable; because every movement goes through
     * `moveStock()`, the sum of ledger rows must equal the balance for every
     * branch/ingredient pair.
     */
    const balances = await InventoryBalance.find({}).lean();
    assert.ok(balances.length > 0);

    const ledger = await InventoryTransaction.aggregate([
      // The ledger's signed movement column is `changeQty`, not `qty`.
      {$group: {_id: {branch: '$branch', ingredient: '$ingredient'}, total: {$sum: '$changeQty'}}}
    ]);
    const ledgerTotals = new Map(
      ledger.map(row => [`${row._id.branch}:${row._id.ingredient}`, row.total])
    );

    let checked = 0;
    for (const balance of balances) {
      const key = `${balance.branch}:${balance.ingredient}`;
      const expected = ledgerTotals.get(key);
      assert.ok(expected !== undefined, `no ledger rows for ${key}`);
      assert.ok(
        Math.abs(Number(balance.quantity) - expected) < 0.01,
        `balance ${balance.quantity} != ledger ${expected} for ${key}`
      );
      checked += 1;
    }
    assert.ok(checked >= 100, `expected a substantial ledger, checked ${checked}`);
  });

  it('keeps batch quantities within the balance they belong to', async () => {
    // Batch totals must never exceed the balance; if they do, FEFO consumption
    // will hand out stock that does not exist.
    const batches = await InventoryBatch.aggregate([
      {$group: {_id: {branch: '$branch', ingredient: '$ingredient'}, total: {$sum: '$quantity'}}}
    ]);
    assert.ok(batches.length > 0, 'the demo has tracked batches');
    for (const row of batches) {
      const balance = await InventoryBalance.findOne({
        branch: row._id.branch, ingredient: row._id.ingredient
      }).lean();
      assert.ok(balance, 'a batch without a balance');
      assert.ok(
        row.total <= Number(balance.quantity) + 0.01,
        `batch total ${row.total} exceeds balance ${balance.quantity}`
      );
    }
  });

  it('totals every order the way the pricing engine does', async () => {
    const {priceOrder} = await import('../src/services/pos.js');
    const orders = await Order.find({}).lean();
    assert.ok(orders.length >= 50, `expected a substantial order history, got ${orders.length}`);

    for (const order of orders) {
      const pricing = priceOrder({
        type: order.type,
        table: order.table,
        customer: order.customer,
        deliveryAddress: order.deliveryAddress,
        items: order.items.map(line => ({
          unitPrice: line.unitPrice, qty: line.qty, vatInclusive: line.vatInclusive
        })),
        vatRate: order.vatRate,
        ...(order.deliveryFee ? {deliveryFee: order.deliveryFee} : {})
      });
      assert.ok(
        Math.abs(pricing.total - Number(order.total)) < 0.02,
        `${order.orderNo}: stored ${order.total} vs priced ${pricing.total}`
      );
      // Paid orders must have nothing outstanding, or the P&L is wrong.
      if (order.status === 'completed') {
        assert.equal(Number(order.dueAmount), 0, `${order.orderNo} is completed but has a balance`);
      }
    }
  });

  it('matches every payment to its order', async () => {
    const payments = await Payment.find({}).lean();
    assert.ok(payments.length > 0);
    for (const payment of payments) {
      const order = await Order.findById(payment.order).lean();
      assert.ok(order, 'a payment with no order');
      assert.ok(
        Math.abs(Number(payment.amount) - Number(order.total)) < 0.02,
        `payment ${payment.amount} != order total ${order.total}`
      );
    }
  });

  it('gives every menu item a resolvable recipe inside the tenant', async () => {
    const restaurant = await Restaurant.findOne({}).lean();
    const items = await MenuItem.find({}).lean();
    const ingredientIds = new Set(
      (await Ingredient.find({restaurant: restaurant._id}).select('_id').lean())
        .map(row => String(row._id))
    );
    for (const item of items) {
      assert.ok(item.recipe.length, `${item.name} has no recipe`);
      for (const line of item.recipe) {
        assert.ok(
          ingredientIds.has(String(line.ingredient)),
          `${item.name} references an ingredient outside the tenant`
        );
      }
    }
  });

  it('links deliveries to real delivery orders and riders', async () => {
    const deliveries = await Delivery.find({}).lean();
    assert.ok(deliveries.length > 0);
    for (const delivery of deliveries) {
      const order = await Order.findById(delivery.order).lean();
      assert.ok(order, 'a delivery with no order');
      assert.equal(order.type, 'delivery', 'only a delivery order can have a delivery');
      const rider = await User.findById(delivery.rider).lean();
      assert.ok(rider, 'a delivery with no rider');
      assert.equal(rider.role, 'rider');
      assert.ok(delivery.address && delivery.address.length > 4, 'a rider needs an address');
    }
  });

  it('places every seeded record inside one tenant', async () => {
    // A demo that quietly straddles two restaurants would make every tenancy
    // test downstream meaningless.
    const restaurants = await Restaurant.find({}).lean();
    assert.equal(restaurants.length, 1);
    const restaurantId = String(restaurants[0]._id);

    for (const [label, model] of [
      ['ingredients', Ingredient], ['menu', MenuItem], ['suppliers', Supplier], ['customers', Customer]
    ]) {
      const strays = await model.countDocuments({restaurant: {$ne: restaurants[0]._id}});
      assert.equal(strays, 0, `${label} outside the demo tenant`);
    }
    const users = await User.find({}).lean();
    for (const user of users) {
      assert.equal(String(user.restaurantId), restaurantId, `${user.email} is in another tenant`);
    }
    const branches = await Branch.find({}).lean();
    const branchIds = new Set(branches.map(b => String(b._id)));
    for (const table of await RestaurantTable.find({}).lean()) {
      assert.ok(branchIds.has(String(table.branch)), 'a table outside the demo branches');
    }
  });

  it('lets every demo account actually log in', async () => {
    // A documented credential that does not work is worse than none.
    for (const account of DEMO_ACCOUNTS) {
      const res = await request('/api/auth/login', {
        method: 'POST', body: {email: account.email, password: DEMO_PASSWORD}
      });
      assert.equal(res.status, 200, `${account.email}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.user.role, account.role);
      assert.ok(res.body.token, 'a token is issued');
      // The response must never carry the credential back.
      assert.ok(!JSON.stringify(res.body).includes(DEMO_PASSWORD));
      assert.ok(!JSON.stringify(res.body).includes('$2'), 'no bcrypt hash in the response');
    }
  });

  it('refuses the demo password on a wrong credential', async () => {
    const res = await request('/api/auth/login', {
      method: 'POST', body: {email: DEMO_ACCOUNTS[0].email, password: 'not-the-password'}
    });
    assert.equal(res.status, 401);
  });

  it('purchase orders reference suppliers and branches in the tenant', async () => {
    const restaurant = await Restaurant.findOne({}).lean();
    const orders = await PurchaseOrder.find({}).lean();
    assert.ok(orders.length > 0);
    for (const po of orders) {
      assert.equal(String(po.restaurant), String(restaurant._id));
      assert.ok(await Supplier.findOne({_id: po.supplier, restaurant: restaurant._id}).lean(),
        `${po.poNo} references a supplier outside the tenant`);
      assert.ok(await Branch.findOne({_id: po.branch, restaurant: restaurant._id}).lean(),
        `${po.poNo} references a branch outside the tenant`);
      assert.ok(po.items.length > 0, `${po.poNo} has no lines`);
      const subtotal = po.items.reduce((sum, line) => sum + Number(line.lineSubtotal || 0), 0);
      assert.ok(Math.abs(subtotal - Number(po.subtotal)) < 0.05,
        `${po.poNo} subtotal does not match its lines`);
    }
  });
});

// ── production safety ────────────────────────────────────────────────────────

describe('Phase 24 · the demo seed cannot run in production', () => {
  it('refuses NODE_ENV=production', () => {
    // The demo accounts use a published password and the script deletes data.
    assert.throws(
      () => assertNotProduction({NODE_ENV: 'production'}),
      /Refusing to seed demo data/
    );
    assert.throws(
      () => assertNotProduction({NODE_ENV: 'PRODUCTION'}),
      /Refusing to seed demo data/,
      'the check must not be case sensitive'
    );
  });

  it('honours an explicit ALLOW_DEMO_SEED=false', () => {
    assert.throws(
      () => assertNotProduction({NODE_ENV: 'development', ALLOW_DEMO_SEED: 'false'}),
      /disabled by ALLOW_DEMO_SEED/
    );
  });

  it('permits development and test', () => {
    assert.equal(assertNotProduction({NODE_ENV: 'development'}), true);
    assert.equal(assertNotProduction({NODE_ENV: 'test'}), true);
  });

  it('documents the credentials as development-only', async () => {
    const {readFile} = await import('node:fs/promises');
    const source = await readFile(new URL('../src/seed.js', import.meta.url), 'utf8');
    assert.match(source, /DEVELOPMENT ONLY|DEVELOPMENT-ONLY/,
      'the credentials must be marked development-only in the source');
  });
});

// ── onboarding ───────────────────────────────────────────────────────────────

describe('Phase 24 · onboarding chain', () => {
  beforeEach(useTestWorld);

  it('describes the brief\'s order', async () => {
    assert.deepEqual(
      ONBOARDING_STEPS.map(step => step.key),
      ['restaurant', 'branch', 'users', 'ingredients', 'suppliers', 'menu', 'tables']
    );
    const res = await request('/api/onboarding/steps', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.steps.length, 7);
    assert.equal(res.body.steps[0].key, 'restaurant');
    assert.equal(res.body.steps.at(-1).key, 'tables');
  });

  it('reports progress and the next step, derived from real counts', async () => {
    const res = await request('/api/onboarding/status', {token: owner()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byKey = Object.fromEntries(res.body.steps.map(step => [step.key, step]));
    // The harness world already has a restaurant, branches, users, an
    // ingredient and a menu item — but no suppliers or tables.
    assert.equal(byKey.restaurant.complete, true);
    assert.equal(byKey.branch.complete, true);
    assert.equal(byKey.ingredients.complete, true);
    assert.equal(byKey.suppliers.complete, false);
    assert.equal(res.body.complete, false);
    assert.ok(res.body.nextStep, 'names the next step to do');
  });

  it('walks the whole chain for a brand-new restaurant', async () => {
    /**
     * The end-to-end onboarding path, in the brief's order, driven through the
     * real API for every step that has an authenticated caller.
     */
    // 1. Restaurant + first owner. A bootstrap: there is no principal inside a
    // tenant that does not exist yet, so this is a service call, not a route.
    const {restaurant, owner: newOwner} = await provisionRestaurant({
      restaurant: {name: 'Newari Kitchen', address: 'Thamel, Kathmandu', pan: '987654321'},
      owner: {name: 'Newari Owner', email: 'owner@newari.test', password: 'NewariOwner2026'}
    });
    assert.ok(restaurant._id);
    assert.equal(newOwner.role, 'owner');
    // The credential must never come back out.
    assert.ok(!JSON.stringify(newOwner).includes('NewariOwner2026'));
    assert.ok(!('password' in newOwner));

    const ownerRow = await User.findById(newOwner._id).lean();
    const token = tokenFor(ownerRow);

    // Nothing but step 1 is done yet.
    const initial = await request('/api/onboarding/status', {token});
    assert.equal(initial.body.nextStep, 'branch');
    assert.equal(initial.body.steps.find(s => s.key === 'users').blocked, true,
      'users are blocked until a branch exists');

    // 2. Branch.
    const branch = await request('/api/onboarding/branch', {
      method: 'POST', token,
      body: {name: 'Thamel Branch', code: 'THM', address: 'Thamel, Kathmandu'}
    });
    assert.equal(branch.status, 201, JSON.stringify(branch.body));
    assert.equal(String(branch.body.restaurant), String(restaurant._id));

    // 3. Users.
    const team = await request('/api/onboarding/users', {
      method: 'POST', token,
      body: {members: [
        {name: 'Thamel Manager', email: 'manager@newari.test', password: 'ThamelPass2026', role: 'manager', branch: String(branch.body._id)},
        {name: 'Thamel Cashier', email: 'cashier@newari.test', password: 'ThamelPass2026', role: 'staff', branch: String(branch.body._id)}
      ]}
    });
    assert.equal(team.status, 201, JSON.stringify(team.body));
    assert.equal(team.body.length, 2);
    assert.ok(!JSON.stringify(team.body).includes('ThamelPass2026'), 'no credential echoed');

    // 4. Ingredients.
    const ingredients = await request('/api/onboarding/ingredients', {
      method: 'POST', token,
      body: {items: [
        {code: 'NW-001', name: 'Beaten Rice', category: 'Grains', unit: 'g', lastPurchasePrice: 0.085},
        {code: 'NW-002', name: 'Buff Mince', category: 'Meat', unit: 'g', lastPurchasePrice: 0.41}
      ]}
    });
    assert.equal(ingredients.status, 201, JSON.stringify(ingredients.body));
    assert.equal(ingredients.body.length, 2);

    // 5. Suppliers.
    const suppliers = await request('/api/onboarding/suppliers', {
      method: 'POST', token,
      body: {items: [{name: 'Thamel Wholesale', contact: '9801122334', paymentTerms: 'Net 15'}]}
    });
    assert.equal(suppliers.status, 201, JSON.stringify(suppliers.body));

    // 6. Menu, whose recipe resolves against the ingredients created at step 4.
    const menu = await request('/api/onboarding/menu', {
      method: 'POST', token,
      body: {items: [{
        name: 'Newari Khaja Set', category: 'Thali', price: 450, vatInclusive: false,
        recipe: [
          {ingredient: String(ingredients.body[0]._id), qty: 90},
          {ingredient: String(ingredients.body[1]._id), qty: 120}
        ]
      }]}
    });
    assert.equal(menu.status, 201, JSON.stringify(menu.body));
    assert.equal(menu.body[0].recipe.length, 2);

    // 7. Tables.
    const tables = await request('/api/onboarding/tables', {
      method: 'POST', token,
      body: {branch: String(branch.body._id), items: [
        {name: 'N1', area: 'Ground', seats: 4}, {name: 'N2', area: 'Ground', seats: 2}
      ]}
    });
    assert.equal(tables.status, 201, JSON.stringify(tables.body));

    // Chain complete, and reported so.
    const done = await request('/api/onboarding/status', {token});
    assert.equal(done.body.complete, true, JSON.stringify(done.body.steps));
    assert.equal(done.body.nextStep, null);

    // DATABASE: everything landed inside the new tenant and nowhere else.
    assert.equal(await Branch.countDocuments({restaurant: restaurant._id}), 1);
    assert.equal(await Ingredient.countDocuments({restaurant: restaurant._id}), 2);
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 1);
    assert.equal(await Supplier.countDocuments({restaurant: restaurant._id}), 1);
    assert.equal(await RestaurantTable.countDocuments({branch: branch.body._id}), 2);
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 3);
    // And the harness's original tenant is untouched.
    assert.equal(await Ingredient.countDocuments({restaurant: world.restaurant._id}), 1);
  });

  it('enforces the password policy on the bootstrap owner', async () => {
    // The first account in a tenant must not be the one weak credential.
    await assert.rejects(
      () => provisionRestaurant({
        restaurant: {name: 'Weak Co'}, owner: {email: 'weak@test.com', password: 'short'}
      }),
      /at least 10 characters/
    );
    await assert.rejects(
      () => provisionRestaurant({
        restaurant: {name: 'Weak Co'}, owner: {email: 'weak@test.com', password: 'password123'}
      }),
      /too common/
    );
    assert.equal(await Restaurant.countDocuments({name: 'Weak Co'}), 0,
      'a rejected bootstrap must not leave a restaurant behind');
  });

  it('refuses a duplicate owner email', async () => {
    await assert.rejects(
      () => provisionRestaurant({
        restaurant: {name: 'Clash Co'},
        owner: {email: 'owner@test.com', password: 'ClashOwner2026'}
      }),
      /already exists/
    );
    assert.equal(await Restaurant.countDocuments({name: 'Clash Co'}), 0);
  });
});

// ── onboarding security ──────────────────────────────────────────────────────

describe('Phase 24 · onboarding tenancy and authorization', () => {
  beforeEach(useTestWorld);

  it('cannot plant a branch in another restaurant', async () => {
    /**
     * FOUND AND FIXED. `POST /branches` took `restaurant` from the REQUEST
     * BODY, so an owner could create a branch inside another tenant. Probed
     * and reproduced (201, and the row landed in the rival restaurant) before
     * this was changed to take the tenant from the authenticated principal.
     */
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const res = await request('/api/branches', {
      method: 'POST', token: owner(),
      body: {restaurant: String(rival._id), name: 'Planted Branch', code: 'PLT'}
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(await Branch.countDocuments({restaurant: rival._id}), 0,
      'no branch may be planted in another tenant');

    // The onboarding route refuses the same thing.
    const viaOnboarding = await request('/api/onboarding/branch', {
      method: 'POST', token: owner(),
      body: {restaurant: String(rival._id), name: 'Planted Branch', code: 'PL2'}
    });
    assert.equal(viaOnboarding.status, 400, 'the schema is strict about unknown keys');
    assert.equal(await Branch.countDocuments({restaurant: rival._id}), 0);

    // CONTROL: the same call for the caller's OWN restaurant succeeds.
    const own = await request('/api/branches', {
      method: 'POST', token: owner(),
      body: {restaurant: String(world.restaurant._id), name: 'Own Branch', code: 'OWN'}
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));
  });

  it('separates a malformed restaurant id from a forbidden one', async () => {
    // A typo must not read as a permission failure, and a genuine cross-tenant
    // attempt must not read as a typo. Collapsing the two would hide a
    // permission regression behind a validation message.
    const malformed = await request('/api/branches', {
      method: 'POST', token: owner(),
      body: {restaurant: 'x', name: 'Typo Branch', code: 'TYP'}
    });
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));

    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const forbidden = await request('/api/branches', {
      method: 'POST', token: owner(),
      body: {restaurant: String(rival._id), name: 'Planted Branch', code: 'PL3'}
    });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));

    assert.equal(await Branch.countDocuments({name: 'Typo Branch'}), 0);
    assert.equal(await Branch.countDocuments({restaurant: rival._id}), 0);
  });

  it('does not list another restaurant\'s branches', async () => {
    /**
     * FOUND AND FIXED. `GET /branches` ran `Branch.find({active:true})` with no
     * tenant filter, so every tenant saw every other tenant's branch list.
     * Reproduced by probe before the fix.
     */
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    await Branch.create({restaurant: rival._id, name: 'RIVAL-SECRET-BRANCH', code: 'RVL'});

    const res = await request('/api/branches', {token: owner()});
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes('RIVAL-SECRET-BRANCH'),
      'another tenant\'s branch must not be listed');
    for (const branch of res.body) {
      assert.equal(String(branch.restaurant), String(world.restaurant._id));
    }

    // CONTROL: the rival's own owner does see it, so the row exists.
    const rivalOwner = await User.create({
      name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x',
      role: 'owner', restaurantId: rival._id
    });
    const rivalView = await request('/api/branches', {token: tokenFor(rivalOwner)});
    assert.ok(JSON.stringify(rivalView.body).includes('RIVAL-SECRET-BRANCH'));
  });

  it('guards the tenant at the SERVICE layer, not only in the route schema', async () => {
    /**
     * DEFENCE IN DEPTH, proven rather than assumed.
     *
     * Over HTTP a `restaurant` key is rejected by the route's `.strict()`
     * schema before `addBranch()` ever runs, so mutation testing showed the
     * service-level check could be deleted with every test still passing.
     * That makes the route schema the only thing standing between a caller and
     * another tenant's data — one relaxed schema away from a hole.
     *
     * Calling the service directly proves the second layer is real: the guard
     * refuses, and with it removed the branch lands in the rival tenant.
     */
    const {addBranch} = await import('../src/services/onboarding.js');
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});

    await assert.rejects(
      () => addBranch({
        user: {id: world.owner._id, role: 'owner'},
        input: {name: 'Planted', code: 'PLT', restaurant: String(rival._id)}
      }),
      error => {
        assert.equal(error.status, 403);
        assert.match(error.message, /your own restaurant/i);
        return true;
      }
    );
    assert.equal(await Branch.countDocuments({restaurant: rival._id}), 0,
      'nothing may be planted in the rival tenant');

    // CONTROL: the same call without the foreign tenant succeeds, so the
    // rejection above is the guard and not a broken fixture.
    const ok = await addBranch({
      user: {id: world.owner._id, role: 'owner'},
      input: {name: 'Legit Branch', code: 'LGT'}
    });
    assert.equal(String(ok.restaurant), String(world.restaurant._id));
  });

  it('keeps onboarding writes inside the caller\'s tenant', async () => {
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVB'});

    // Ingredients and menu land in the caller's restaurant, never the rival's.
    const ingredients = await request('/api/onboarding/ingredients', {
      method: 'POST', token: owner(),
      body: {items: [{code: 'X-1', name: 'Tenant Test Ingredient', unit: 'g'}]}
    });
    assert.equal(ingredients.status, 201);
    assert.equal(String(ingredients.body[0].restaurant), String(world.restaurant._id));
    assert.equal(await Ingredient.countDocuments({restaurant: rival._id}), 0);

    // Tables cannot be added to another tenant's branch.
    const tables = await request('/api/onboarding/tables', {
      method: 'POST', token: owner(),
      body: {branch: String(rivalBranch._id), items: [{name: 'X1', seats: 4}]}
    });
    assert.ok([403, 404].includes(tables.status), `-> ${tables.status}`);
    assert.equal(await RestaurantTable.countDocuments({branch: rivalBranch._id}), 0);
  });

  it('refuses a recipe that reaches into another tenant', async () => {
    // The menu step is where a cross-tenant reference would otherwise be
    // stored happily by the schema, because a ref does not validate ownership.
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalIngredient = await Ingredient.create({
      restaurant: rival._id, code: 'RV-1', name: 'Rival Secret Spice', unit: 'g'
    });
    const res = await request('/api/onboarding/menu', {
      method: 'POST', token: owner(),
      body: {items: [{
        name: 'Stolen Recipe', price: 300,
        recipe: [{ingredient: String(rivalIngredient._id), qty: 10}]
      }]}
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(await MenuItem.countDocuments({name: 'Stolen Recipe'}), 0);
  });

  it('requires the matching permission for each step', async () => {
    // Onboarding is a sequence over EXISTING capabilities; it must not be a
    // way around them. Staff hold none of these.
    for (const [path, body] of [
      ['/api/onboarding/branch', {name: 'Sneaky', code: 'SNK'}],
      ['/api/onboarding/users', {members: [{name: 'X', email: 'x@test.com', password: 'Password2026', role: 'staff', branch: String(world.branchA._id)}]}],
      ['/api/onboarding/suppliers', {items: [{name: 'Sneaky Supplier'}]}]
    ]) {
      const res = await request(path, {method: 'POST', token: staff(), body});
      assert.equal(res.status, 403, `${path} -> ${res.status}`);
    }
    assert.equal(await Branch.countDocuments({name: 'Sneaky'}), 0);
    assert.equal(await Supplier.countDocuments({name: 'Sneaky Supplier'}), 0);
    assert.equal(await User.countDocuments({email: 'x@test.com'}), 0);
  });

  it('rejects an anonymous caller on every onboarding route', async () => {
    for (const [method, path] of [
      ['GET', '/api/onboarding/status'],
      ['GET', '/api/onboarding/steps'],
      ['POST', '/api/onboarding/branch'],
      ['POST', '/api/onboarding/users'],
      ['POST', '/api/onboarding/ingredients'],
      ['POST', '/api/onboarding/suppliers'],
      ['POST', '/api/onboarding/menu'],
      ['POST', '/api/onboarding/tables']
    ]) {
      const res = await request(path, {method, ...(method === 'GET' ? {} : {body: {}})});
      assert.equal(res.status, 401, `${method} ${path} -> ${res.status}`);
    }
  });

  it('exposes no unauthenticated route that can mint a restaurant', async () => {
    // `provisionRestaurant()` is a bootstrap and is deliberately NOT mounted:
    // an open endpoint for it would let anybody create a tenant.
    for (const path of ['/api/onboarding/restaurant', '/api/restaurants', '/api/onboarding/provision']) {
      const res = await request(path, {
        method: 'POST', body: {restaurant: {name: 'Anon Co'}, owner: {email: 'a@b.test', password: 'AnonOwner2026'}}
      });
      assert.ok([401, 403, 404].includes(res.status), `${path} -> ${res.status}`);
    }
    assert.equal(await Restaurant.countDocuments({name: 'Anon Co'}), 0);
  });

  it('refuses a duplicate branch code inside one tenant', async () => {
    // Branch codes appear in PO and invoice numbers; a duplicate would make
    // two branches share a document sequence.
    const first = await request('/api/onboarding/branch', {
      method: 'POST', token: owner(), body: {name: 'Dup One', code: 'DUP'}
    });
    assert.equal(first.status, 201);
    const second = await request('/api/onboarding/branch', {
      method: 'POST', token: owner(), body: {name: 'Dup Two', code: 'DUP'}
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(await Branch.countDocuments({restaurant: world.restaurant._id, code: 'DUP'}), 1);
  });

  it('refuses a duplicate table name in one branch', async () => {
    const body = {branch: String(world.branchA._id), items: [{name: 'DUPT', seats: 4}]};
    assert.equal((await request('/api/onboarding/tables', {method: 'POST', token: manager(), body})).status, 201);
    const again = await request('/api/onboarding/tables', {method: 'POST', token: manager(), body});
    assert.equal(again.status, 409);
    assert.equal(await RestaurantTable.countDocuments({branch: world.branchA._id, name: 'DUPT'}), 1);
  });

  it('rejects a malformed ingredient id in a recipe', async () => {
    const res = await request('/api/onboarding/menu', {
      method: 'POST', token: owner(),
      body: {items: [{name: 'Bad Ref', price: 200, recipe: [{ingredient: 'not-an-id', qty: 5}]}]}
    });
    assert.equal(res.status, 400);
    assert.equal(await MenuItem.countDocuments({name: 'Bad Ref'}), 0);
  });
});
