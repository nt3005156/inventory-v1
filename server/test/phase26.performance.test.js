import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {clearDb, request, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Ingredient, MenuItem, Supplier, User} from '../src/models/index.js';
import {
  Branch, Customer, InventoryBalance, InventoryTransaction, Order, Payment, Restaurant,
  RestaurantTable
} from '../src/models/operations.js';
import {mongoConnectionOptions} from '../src/services/dbConnection.js';

/**
 * Phase 26 — performance and database behaviour at production scale.
 *
 * These are CORRECTNESS tests about performance characteristics, not a
 * benchmark. Wall-clock numbers on CI hardware are noise, so almost nothing
 * here asserts a millisecond figure. What it asserts instead is the shape of
 * the work:
 *
 *   • hot queries use an index rather than scanning the collection,
 *   • list endpoints are bounded and paginated rather than returning the table,
 *   • per-row database calls (N+1) do not reappear as the catalogue grows,
 *   • response payloads stay proportionate to a page.
 *
 * Those properties survive a slow CI box; a 200ms threshold does not.
 *
 * Scale: 120 ingredients, 120 menu items, 1,200 orders, 6,000 inventory
 * transactions, 1,200 customers, 1,160 payments, 360 balances.
 */

let ctx;

before(async () => {
  await startTestApp();
  ctx = await seedScale();
});
after(async () => { await stopTestApp(); });

const owner = () => tokenFor(ctx.owner);
const branch = () => ctx.branches[0]._id;

/**
 * Count the database operations a block of work issues.
 *
 * Uses `mongoose.set('debug')`, which fires once per Mongoose operation.
 *
 * NOTE: the obvious approach -- subscribing to the driver's `commandStarted`
 * event on `connection.getClient()` -- silently reports ZERO here. I wrote it
 * that way first and it "passed" every N+1 test by measuring nothing, which is
 * worse than no test at all. Verified with a probe against a known-good
 * endpoint before being trusted: 9 operations, itemised by collection.
 */
async function countQueries(fn) {
  const mongoose = (await import('mongoose')).default;
  let count = 0;
  mongoose.set('debug', () => { count += 1; });
  try {
    await fn();
  } finally {
    mongoose.set('debug', false);
  }
  return count;
}

/**
 * Self-check: the counter must actually observe operations.
 *
 * Mutation testing flags the body of this helper as an EQUIVALENT MUTANT --
 * replacing `observed` with a constant still passes, because this assertion is
 * a convenience, not the safety net. Proven by breaking the counter itself
 * (`mongoose.set('debug', false)` inside `countQueries`) and re-running: the
 * suite fails on "has a working query counter" AND on the N+1 tests, which
 * then observe 0 operations and cannot distinguish a batched call from a
 * per-row one. The real protection is that a dead counter makes those tests
 * fail, not that this one does.
 */
async function assertCounterWorks() {
  const observed = await countQueries(() => MenuItem.countDocuments());
  assert.ok(observed > 0, 'the query counter is not observing anything');
}

async function seedScale() {
  await clearDb();
  const restaurant = await Restaurant.create({name: 'Perf Co', currency: 'NPR', vatRate: 13});
  const branches = await Branch.create([
    {restaurant: restaurant._id, name: 'B1', code: 'B01'},
    {restaurant: restaurant._id, name: 'B2', code: 'B02'},
    {restaurant: restaurant._id, name: 'B3', code: 'B03'}
  ]);
  const ownerUser = await User.create({
    name: 'Perf Owner', email: 'perf@test.com', password: 'x', role: 'owner',
    restaurant: 'Perf Co', restaurantId: restaurant._id
  });

  const suppliers = await Supplier.insertMany(
    Array.from({length: 20}, (_, i) => ({restaurant: restaurant._id, name: `Supplier ${i}`}))
  );
  const ingredients = await Ingredient.insertMany(
    Array.from({length: 120}, (_, i) => ({
      restaurant: restaurant._id, code: `ING-${String(i).padStart(4, '0')}`,
      name: `Ingredient ${i}`, unit: 'g', lastPurchasePrice: 0.1 + (i % 20) / 100,
      minimumStock: 1000, reorderLevel: 2000, supplier: suppliers[i % suppliers.length]._id
    }))
  );
  const menu = await MenuItem.insertMany(
    Array.from({length: 120}, (_, i) => ({
      restaurant: restaurant._id, name: `Dish ${i}`, category: `cat ${i % 10}`,
      price: 150 + (i % 40) * 10, vatInclusive: false,
      station: ['hot', 'fry', 'grill', 'cold'][i % 4],
      recipe: [
        {ingredient: ingredients[i % ingredients.length]._id, qty: 100, unit: 'g'},
        {ingredient: ingredients[(i + 7) % ingredients.length]._id, qty: 50, unit: 'g'}
      ]
    }))
  );
  const tables = await RestaurantTable.insertMany(
    branches.flatMap(b => Array.from({length: 15}, (_, i) => ({
      branch: b._id, name: `T${i}`, area: 'Main', seats: 4
    })))
  );
  const customers = await Customer.insertMany(
    Array.from({length: 1200}, (_, i) => ({
      restaurant: restaurant._id, branch: branches[i % branches.length]._id,
      name: `Customer ${i}`, phone: `98${String(10000000 + i)}`,
      phoneKey: `98${String(10000000 + i)}`,
      stats: {totalOrders: i % 12, completedOrders: i % 10, lifetimeValue: (i % 50) * 100}
    }))
  );

  // Production builds every index through OPERATIONAL_MIGRATIONS at startup.
  // The harness runs only three, so without this the suite would measure an
  // index-less database and report COLLSCANs that do not exist in production.
  const {ensureOperationalIndexes} = await import('../src/services/startup.js');
  await ensureOperationalIndexes();

  // Balances and ledger rows are written through the raw collection: both
  // models refuse bulk writes from anything but the ledger service, and that
  // guarantee stays intact.
  await InventoryBalance.collection.insertMany(
    branches.flatMap(b => ingredients.map(ing => ({
      branch: b._id, ingredient: ing._id, quantity: 50000, averageCost: 0.12,
      minLevel: 1000, reorderLevel: 2000, reserved: 0, ledgerVersion: 0,
      createdAt: new Date(), updatedAt: new Date()
    })))
  );

  const now = Date.now();
  const orderDocs = [];
  for (let i = 0; i < 1200; i += 1) {
    const b = branches[i % branches.length];
    const createdAt = new Date(now - (i % 90) * 86400000 - (i % 12) * 3600000);
    const lines = [0, 1, 2].map(n => {
      const item = menu[(i + n * 13) % menu.length];
      return {
        menuItem: item._id, name: item.name, qty: 1 + (n % 2), unitPrice: item.price,
        vatInclusive: false, station: item.station, foodCost: item.price * 0.3,
        lineNet: item.price, lineVat: item.price * 0.13, lineTotal: item.price * 1.13
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
    const live = i < 40;
    orderDocs.push({
      orderNo: `PERF-${String(i).padStart(6, '0')}`,
      branch: b._id, customer: customers[i % customers.length]._id,
      table: tables[i % tables.length]._id, type: 'dine-in',
      status: live ? ['pending', 'preparing', 'ready'][i % 3] : 'completed',
      items: lines, subtotal, vatRate: 13, vat: subtotal * 0.13, total: subtotal * 1.13,
      paidAmount: live ? 0 : subtotal * 1.13, dueAmount: live ? subtotal * 1.13 : 0,
      inventoryDeducted: true, createdBy: ownerUser._id, createdAt, updatedAt: createdAt,
      ...(live ? {} : {completedAt: createdAt, paymentSettledAt: createdAt})
    });
  }
  await Order.insertMany(orderDocs, {ordered: false});
  const orders = await Order.find({}).select('_id total createdAt').lean();

  await Payment.insertMany(orders.slice(40).map((o, i) => ({
    order: o._id, amount: o.total, method: ['cash', 'card', 'esewa'][i % 3], status: 'paid',
    cashier: ownerUser._id, createdAt: o.createdAt, updatedAt: o.createdAt
  })));

  const txDocs = [];
  for (let i = 0; i < 6000; i += 1) {
    const b = branches[i % branches.length];
    const ing = ingredients[i % ingredients.length];
    const createdAt = new Date(now - (i % 90) * 86400000);
    txDocs.push({
      restaurant: restaurant._id, branch: b._id, ingredient: ing._id,
      type: i % 5 === 0 ? 'PURCHASE' : 'RECIPE_DEDUCTION',
      previousQty: 50000, changeQty: i % 5 === 0 ? 100 : -50, newQty: 50000,
      unit: 'g', unitCost: 0.12, totalCost: 12, reason: 'perf fixture movement',
      referenceType: 'perf_fixture', referenceId: ing._id, user: ownerUser._id,
      idempotencyKey: `perf-tx-${i}`, createdAt, updatedAt: createdAt
    });
  }
  await InventoryTransaction.collection.insertMany(txDocs, {ordered: false});

  return {restaurant, branches, owner: ownerUser, ingredients, menu, customers, tables};
}

// ── the dataset ──────────────────────────────────────────────────────────────

describe('Phase 26 · realistic scale', () => {
  it('holds the volumes the brief asks for', async () => {
    assert.ok(await Ingredient.countDocuments() >= 100, '100+ ingredients');
    assert.ok(await MenuItem.countDocuments() >= 100, '100+ menu items');
    assert.ok(await Order.countDocuments() >= 1000, '1,000+ orders');
    assert.ok(await InventoryTransaction.countDocuments() >= 5000, '5,000+ inventory transactions');
    assert.ok(await Customer.countDocuments() >= 1000, '1,000+ customers');
  });
});

// ── indexes ──────────────────────────────────────────────────────────────────

describe('Phase 26 · hot queries use an index', () => {
  const usesIndex = plan => JSON.stringify(plan.queryPlanner?.winningPlan || {}).includes('IXSCAN');

  it('never collection-scans a hot path', async () => {
    const cases = [
      ['KDS queue (branch + status)',
        () => Order.find({branch: branch(), status: {$in: ['pending', 'preparing', 'ready']}}).explain('executionStats')],
      ['order list (branch, newest first)',
        () => Order.find({branch: branch()}).sort({createdAt: -1}).limit(25).explain('executionStats')],
      ['order by number',
        () => Order.findOne({orderNo: 'PERF-000500'}).explain('executionStats')],
      ['customer order history',
        () => Order.find({customer: ctx.customers[3]._id}).explain('executionStats')],
      ['report date range',
        () => Order.find({branch: branch(), createdAt: {$gte: new Date(Date.now() - 30 * 86400000)}}).explain('executionStats')],
      ['ledger branch timeline',
        () => InventoryTransaction.find({restaurant: ctx.restaurant._id, branch: branch()})
          .sort({createdAt: -1}).limit(50).explain('executionStats')],
      ['balances by branch',
        () => InventoryBalance.find({branch: branch()}).explain('executionStats')],
      ['menu by tenant',
        () => MenuItem.find({restaurant: ctx.restaurant._id}).explain('executionStats')],
      ['customers by tenant',
        () => Customer.find({restaurant: ctx.restaurant._id}).limit(50).explain('executionStats')]
    ];

    const scans = [];
    for (const [label, run] of cases) {
      const plan = await run();
      if (!usesIndex(plan)) {
        scans.push(`${label}: examined ${plan.executionStats?.totalDocsExamined} to return ${plan.executionStats?.nReturned}`);
      }
    }
    assert.deepEqual(scans, [], 'these queries scan the whole collection');
  });

  it('reads a customer\'s orders without scanning every order', async () => {
    /**
     * FOUND AND FIXED. `Order.find({customer})` had no index: measured at
     * 1,200 orders it examined all 1,200 to return one. It is not a rare
     * query -- `recalculateCustomerStats()` runs it on every settlement and
     * every refund, so the cost grew with the order table on the hot write
     * path.
     */
    const plan = await Order.find({customer: ctx.customers[3]._id}).explain('executionStats');
    const stats = plan.executionStats;
    const total = await Order.countDocuments();
    assert.ok(
      stats.totalDocsExamined <= stats.nReturned + 5,
      `examined ${stats.totalDocsExamined} to return ${stats.nReturned} of ${total}`
    );
  });
});

// ── pagination and payload size ──────────────────────────────────────────────

describe('Phase 26 · list endpoints are bounded', () => {
  it('honours limit and page on the order list', async () => {
    /**
     * FOUND AND FIXED. The order list was `.limit(300)` with no pagination and
     * no projection: `?limit=25` returned the same 921 KB body as no limit at
     * all, because the parameter was never read.
     */
    const first = await request(`/api/orders?branch=${branch()}&limit=10&page=1`, {token: owner()});
    assert.equal(first.status, 200);
    assert.equal(first.body.orders.length, 10, 'limit must be honoured');
    assert.equal(first.body.pagination.limit, 10);
    // 1,200 orders spread over three branches, so one branch holds ~400.
    // The point is that `total` counts the whole matching set, not the page.
    const branchTotal = await Order.countDocuments({branch: branch()});
    assert.equal(first.body.pagination.total, branchTotal, 'total must count the whole set, not the page');
    assert.ok(branchTotal > 100, `expected a substantial branch history, got ${branchTotal}`);
    assert.ok(first.body.pagination.pages > 1);

    const second = await request(`/api/orders?branch=${branch()}&limit=10&page=2`, {token: owner()});
    assert.equal(second.body.orders.length, 10);
    const ids = new Set([...first.body.orders, ...second.body.orders].map(o => String(o._id)));
    assert.equal(ids.size, 20, 'pages must not overlap');

    // The ceiling holds even when a caller asks for everything.
    const greedy = await request(`/api/orders?branch=${branch()}&limit=100000`, {token: owner()});
    assert.ok(greedy.body.orders.length <= 200, 'a hard ceiling must apply');
  });

  it('keeps the order list payload proportionate to the page', async () => {
    const page = await request(`/api/orders?branch=${branch()}&limit=25`, {token: owner()});
    const bytes = JSON.stringify(page.body).length;
    // Was 921 KB regardless of limit. A 25-row page has no business being big.
    assert.ok(bytes < 80_000, `a 25-order page returned ${bytes} bytes`);
    // The projection must still carry what a list view renders.
    const row = page.body.orders[0];
    for (const field of ['orderNo', 'status', 'type', 'total', 'dueAmount', 'createdAt', 'itemCount']) {
      assert.ok(row[field] !== undefined, `${field} is needed by the list`);
    }
    // ...and must NOT ship the full line detail a list never shows.
    assert.ok(!row.items?.[0]?.modifiers, 'modifiers must not be in the list payload');
    assert.ok(!row.items?.[0]?.inventoryRequirements, 'recipe requirements must not be shipped');
  });

  it('paginates the customer list', async () => {
    const res = await request(`/api/customers?branch=${branch()}&limit=20`, {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.customers.length, 20);
    assert.ok(res.body.pagination.total >= 300);
    const bytes = JSON.stringify(res.body).length;
    assert.ok(bytes < 40_000, `a 20-customer page returned ${bytes} bytes`);
  });

  it('paginates the inventory ledger', async () => {
    const first = await request(`/api/inventory/transactions?branch=${branch()}&limit=25&page=1`, {token: owner()});
    const second = await request(`/api/inventory/transactions?branch=${branch()}&limit=25&page=2`, {token: owner()});
    assert.equal(first.status, 200);
    assert.equal(first.body.length, 25);
    assert.equal(second.body.length, 25);
    const ids = new Set([...first.body, ...second.body].map(r => String(r._id)));
    assert.equal(ids.size, 50, 'ledger pages must not overlap');
  });

  it('keeps the legacy array shape available for older clients', async () => {
    // The envelope is a breaking change for anything that expected an array,
    // so the old shape stays reachable rather than silently disappearing.
    const legacy = await request(`/api/orders?branch=${branch()}&limit=5&legacy=true`, {token: owner()});
    assert.ok(Array.isArray(legacy.body), 'legacy=true must return a bare array');
    assert.equal(legacy.body.length, 5);
  });
});

// ── N+1 ──────────────────────────────────────────────────────────────────────

describe('Phase 26 · no per-row database calls', () => {
  it('has a working query counter', async () => {
    // Guards the three tests below: a counter that measures nothing would let
    // every N+1 assertion pass vacuously.
    await assertCounterWorks();
  });

  it('costs a whole page of menu items in a constant number of queries', async () => {
    /**
     * FOUND AND FIXED. `listMenuItems()` called `calculateRecipeCost()` per
     * row inside `Promise.all(rows.map(...))`, and that helper issues three
     * queries of its own -- so a 100-item page cost several hundred round
     * trips (measured ~300ms). It now builds one costing context per page.
     *
     * The assertion is that query count does NOT grow with page size, which
     * is the property that matters and is stable on any hardware.
     */
    const small = await countQueries(() => request('/api/menu-items?limit=5', {token: owner()}));
    const large = await countQueries(() => request('/api/menu-items?limit=100', {token: owner()}));
    assert.ok(
      large <= small + 2,
      `queries grew with page size: ${small} for 5 rows, ${large} for 100`
    );
    assert.ok(large < 30, `a menu page should not issue ${large} queries`);
  });

  it('still returns correct costing for every row', async () => {
    // Batching must not change the numbers. This is the control on the fix.
    const res = await request('/api/menu-items?limit=20', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 20);
    for (const item of res.body.items) {
      assert.ok(Number.isFinite(item.recipeCost), `${item.name} has no recipe cost`);
      assert.ok(item.recipeCost > 0, `${item.name} costed to zero`);
      assert.ok(Number.isFinite(item.foodCostPercent));
      assert.equal(item.foodCost, Math.round((item.recipeCost + item.packagingCost) * 100) / 100);
    }
  });

  it('agrees with the single-item costing path', async () => {
    /**
     * The batched context and `calculateRecipeCost()` are two implementations
     * of one rule, so they must produce the same figure — otherwise the list
     * and the detail screen would quietly disagree about margin.
     */
    const list = await request('/api/menu-items?limit=10', {token: owner()});
    for (const row of list.body.items.slice(0, 5)) {
      const single = await request(`/api/menu-items/${row._id}`, {token: owner()});
      assert.equal(single.status, 200);
      assert.equal(
        single.body.recipeCost, row.recipeCost,
        `${row.name}: list says ${row.recipeCost}, detail says ${single.body.recipeCost}`
      );
    }
  });

  it('builds the menu engineering report without a query per dish', async () => {
    /**
     * Was `await recipeCost(item)` inside a loop, and that helper does a
     * populate plus a balance query, so an UNSOLD catalogue cost ~2 round
     * trips per dish.
     *
     * Two things this test had to get right, both caught by mutation testing:
     *
     * 1. The per-dish loop only runs for dishes with NO sold line. Every dish
     *    in the main fixture has been sold, so the branch under test never
     *    executed and the assertion was vacuous. A second tenant is created
     *    here with a full catalogue and zero orders, which is exactly the
     *    shape that used to be slow.
     *
     * 2. The ceiling is a fixed number, not a fraction of the catalogue. An
     *    earlier `queries < dishes / 2` still passed with the N+1 restored,
     *    because 120 dishes made the bar 60. Measured baseline is 9
     *    operations; the bar is 12 and does not move with catalogue size.
     */
    const cold = await Restaurant.create({name: 'Cold Menu Co', currency: 'NPR', vatRate: 13});
    const coldBranch = await Branch.create({restaurant: cold._id, name: 'CB', code: 'CB1'});
    const coldOwner = await User.create({
      name: 'Cold Owner', email: 'cold@test.com', password: 'x', role: 'owner',
      restaurantId: cold._id
    });
    const coldIngredients = await Ingredient.insertMany(
      Array.from({length: 40}, (_, i) => ({
        restaurant: cold._id, code: `CLD-${i}`, name: `Cold ${i}`, unit: 'g', lastPurchasePrice: 0.2
      }))
    );
    await MenuItem.insertMany(Array.from({length: 120}, (_, i) => ({
      restaurant: cold._id, name: `Cold Dish ${i}`, price: 300,
      recipe: [{ingredient: coldIngredients[i % 40]._id, qty: 100, unit: 'g'}]
    })));
    await InventoryBalance.collection.insertMany(coldIngredients.map(ing => ({
      branch: coldBranch._id, ingredient: ing._id, quantity: 1000, averageCost: 0.2,
      reserved: 0, ledgerVersion: 0, createdAt: new Date(), updatedAt: new Date()
    })));

    // Nothing has ever been sold here, so every dish takes the live-costing path.
    assert.equal(await Order.countDocuments({branch: coldBranch._id}), 0);

    const queries = await countQueries(
      () => request(`/api/analytics/menu-engineering?branch=${coldBranch._id}`, {token: tokenFor(coldOwner)})
    );
    const dishes = await MenuItem.countDocuments({restaurant: cold._id});
    assert.equal(dishes, 120, 'the catalogue really is large');
    assert.ok(
      queries <= 12,
      `${queries} operations for ${dishes} unsold dishes suggests a per-row lookup`
    );

    // CONTROL: the report is still correct, not merely cheap. This endpoint
    // returns the row array; every unsold dish must still be costed from live
    // inventory rather than silently coming back as zero.
    const report = await request(
      `/api/analytics/menu-engineering?branch=${coldBranch._id}`, {token: tokenFor(coldOwner)}
    );
    assert.equal(report.status, 200);
    assert.equal(report.body.length, 120, 'every dish appears in the report');
    for (const row of report.body.slice(0, 10)) {
      assert.ok(row.recipeCost > 0, `${row.name} costed to zero`);
    }
  });
});

// ── connection pool ──────────────────────────────────────────────────────────

describe('Phase 26 · connection settings are explicit', () => {
  it('does not rely on driver defaults', () => {
    /**
     * `mongoose.connect(uri)` was called with no options, so the pool size,
     * every timeout and the write concern were inherited defaults rather than
     * decisions. maxPoolSize defaulted to 100 per instance — far more than one
     * event loop uses, and a good way to exhaust connection slots on the
     * server once several instances start.
     */
    const options = mongoConnectionOptions({});
    assert.ok(options.maxPoolSize > 0 && options.maxPoolSize <= 25,
      `maxPoolSize ${options.maxPoolSize} is not sized for one event loop`);
    assert.ok(options.minPoolSize >= 1, 'keep sockets warm');
    assert.ok(options.serverSelectionTimeoutMS <= 10_000,
      'a request API must fail fast when there is no primary');
    assert.ok(options.socketTimeoutMS > 0);
    assert.ok(options.maxIdleTimeMS > 0, 'idle sockets must be recycled');
    // Stock and money: an acknowledged write must survive a failover.
    assert.equal(options.writeConcern.w, 'majority');
    assert.equal(options.retryWrites, true);
  });

  it('is tunable without a code change', () => {
    const options = mongoConnectionOptions({
      MONGO_MAX_POOL_SIZE: '20', MONGO_MIN_POOL_SIZE: '5',
      MONGO_SERVER_SELECTION_TIMEOUT_MS: '3000'
    });
    assert.equal(options.maxPoolSize, 20);
    assert.equal(options.minPoolSize, 5);
    assert.equal(options.serverSelectionTimeoutMS, 3000);
    // Garbage falls back to the default rather than producing a broken pool.
    assert.equal(mongoConnectionOptions({MONGO_MAX_POOL_SIZE: 'abc'}).maxPoolSize, 10);
    assert.equal(mongoConnectionOptions({MONGO_MAX_POOL_SIZE: '-4'}).maxPoolSize, 10);
  });
});

// ── the reporting and operational surface still works at scale ───────────────

describe('Phase 26 · the API is correct at scale', () => {
  it('serves every hot screen', async () => {
    const endpoints = [
      ['orders', `/api/orders?branch=${branch()}`],
      ['KDS queue', `/api/kitchen/orders?branch=${branch()}`],
      ['KDS board', `/api/kitchen/board?branch=${branch()}`],
      ['dashboard', `/api/dashboard?branch=${branch()}`],
      ['P&L', `/api/reports/pnl?branch=${branch()}`],
      ['sales report', `/api/reports/sales?branch=${branch()}`],
      ['operations report', `/api/reports/operations?branch=${branch()}`],
      ['menu engineering', `/api/analytics/menu-engineering?branch=${branch()}`],
      ['inventory balances', `/api/inventory/balances?branch=${branch()}`],
      ['inventory ledger', `/api/inventory/transactions?branch=${branch()}`],
      ['inventory valuation', `/api/inventory/valuation?branch=${branch()}`],
      ['POS menu', '/api/menu-items?limit=100'],
      ['customers', `/api/customers?branch=${branch()}`],
      ['customer search', `/api/customers/search?q=Customer%201&branch=${branch()}`],
      ['floor plan', `/api/tables/floor?branch=${branch()}`]
    ];
    const failures = [];
    for (const [label, path] of endpoints) {
      const res = await request(path, {token: owner()});
      if (res.status !== 200) failures.push(`${label} -> ${res.status}`);
    }
    assert.deepEqual(failures, [], 'an endpoint broke at scale');
  });

  it('returns no oversized payload from a default page', async () => {
    // A response measured in hundreds of KB is a mobile POS on a Kathmandu
    // 3G connection waiting seconds for a screen.
    const oversized = [];
    for (const [label, path] of [
      ['orders', `/api/orders?branch=${branch()}`],
      ['customers', `/api/customers?branch=${branch()}`],
      ['inventory ledger', `/api/inventory/transactions?branch=${branch()}`],
      ['KDS queue', `/api/kitchen/orders?branch=${branch()}`]
    ]) {
      const res = await request(path, {token: owner()});
      const bytes = JSON.stringify(res.body ?? '').length;
      if (bytes > 150_000) oversized.push(`${label}: ${bytes} bytes`);
    }
    assert.deepEqual(oversized, [], 'a default page is too large');
  });
});
