import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {KitchenStation, MenuItem} from '../src/models/index.js';
import {Order} from '../src/models/operations.js';
import {
  BUILT_IN_STATION_CODES,
  assertStationCode,
  defaultStationOf,
  listStations,
  routeItemToStation
} from '../src/services/stations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

const stations = (query = '', token = owner()) =>
  request(`/api/kitchen/stations${query}`, {token});

async function menuItem(props) {
  return MenuItem.create({
    restaurant: world.restaurant._id,
    price: 200,
    vatInclusive: false,
    recipe: [{ingredient: world.ingredient._id, qty: 20, unit: 'g'}],
    ...props
  });
}

async function placeOrder(items, branch = world.branchA) {
  const res = await request('/api/orders', {
    method: 'POST', token: owner(),
    body: {branch: String(branch._id), type: 'counter', items}
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

const board = (query = '') =>
  request(`/api/kitchen/board?branch=${world.branchA._id}${query}`, {token: owner()});

// ── Required station set ─────────────────────────────────────────────────────
describe('Phase 5C — station catalogue', () => {
  it('ships kitchen, bar, grill, bakery and beverage among the built-ins', () => {
    for (const code of ['kitchen', 'bar', 'grill', 'bakery', 'beverage']) {
      assert.ok(BUILT_IN_STATION_CODES.includes(code), `missing built-in station: ${code}`);
    }
    // "Other stations" — the rest of the kitchen sections.
    for (const code of ['fry', 'tandoor', 'curry', 'cold', 'dessert', 'expo']) {
      assert.ok(BUILT_IN_STATION_CODES.includes(code), `missing station: ${code}`);
    }
  });

  it('seeds the built-in stations on first read', async () => {
    assert.equal(await KitchenStation.countDocuments({}), 0);
    const res = await stations();
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.stations.length, BUILT_IN_STATION_CODES.length);
    assert.ok(res.body.codes.includes('beverage'));
    // Seeding is idempotent.
    await stations();
    assert.equal(await KitchenStation.countDocuments({restaurant: world.restaurant._id}), BUILT_IN_STATION_CODES.length);
  });

  it('marks exactly one default station', async () => {
    await stations();
    const defaults = await KitchenStation.find({restaurant: world.restaurant._id, isDefault: true});
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].code, 'kitchen');
  });

  it('validates station codes', () => {
    assert.equal(assertStationCode('Momo_Counter'), 'momo_counter');
    assert.throws(() => assertStationCode(''), /required/);
    assert.throws(() => assertStationCode('has space'), /lowercase letters/);
    assert.throws(() => assertStationCode('-leading'), /lowercase letters/);
  });
});

// ── Custom stations ──────────────────────────────────────────────────────────
describe('Phase 5C — custom stations', () => {
  it('creates a restaurant-specific station', async () => {
    const created = await request('/api/kitchen/stations', {
      method: 'POST', token: manager(),
      body: {code: 'momo', name: 'Momo Counter', categories: ['momo', 'dumpling'], sortOrder: 5}
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.code, 'momo');
    assert.equal(created.body.isDefault, false);

    const list = await stations();
    assert.ok(list.body.codes.includes('momo'));
    // Duplicates are refused.
    assert.equal((await request('/api/kitchen/stations', {
      method: 'POST', token: manager(), body: {code: 'MOMO', name: 'Dup'}
    })).status, 409);
  });

  it('updates, deactivates and reinstates a station', async () => {
    const created = await request('/api/kitchen/stations', {
      method: 'POST', token: owner(), body: {code: 'pizza', name: 'Pizza Oven'}
    });
    const id = created.body._id;

    const renamed = await request(`/api/kitchen/stations/${id}`, {
      method: 'PATCH', token: manager(), body: {name: 'Wood Oven', categories: ['pizza']}
    });
    assert.equal(renamed.body.name, 'Wood Oven');
    assert.deepEqual(renamed.body.categories, ['pizza']);

    const removed = await request(`/api/kitchen/stations/${id}`, {method: 'DELETE', token: owner()});
    assert.equal(removed.status, 200);
    assert.equal(removed.body.station.active, false);
    assert.ok(!(await stations()).body.codes.includes('pizza'), 'inactive station hidden');
    assert.ok((await stations('?includeInactive=true')).body.stations.some(s => s.code === 'pizza'));
  });

  it('moves the default flag and protects the default station', async () => {
    await stations();
    const all = await KitchenStation.find({restaurant: world.restaurant._id});
    const kitchen = all.find(s => s.code === 'kitchen');
    const grill = all.find(s => s.code === 'grill');

    // The current default cannot be deactivated or deleted.
    assert.equal((await request(`/api/kitchen/stations/${kitchen._id}`, {
      method: 'PATCH', token: owner(), body: {active: false}
    })).status, 409);
    assert.equal((await request(`/api/kitchen/stations/${kitchen._id}`, {
      method: 'DELETE', token: owner()
    })).status, 409);

    const moved = await request(`/api/kitchen/stations/${grill._id}/default`, {
      method: 'POST', token: owner()
    });
    assert.equal(moved.status, 200, moved.body?.message);
    const defaults = await KitchenStation.find({restaurant: world.restaurant._id, isDefault: true});
    assert.equal(defaults.length, 1, 'exactly one default must remain');
    assert.equal(defaults[0].code, 'grill');
  });

  it('keeps stations inside their own restaurant', async () => {
    await request('/api/kitchen/stations', {
      method: 'POST', token: owner(), body: {code: 'momo', name: 'Momo'}
    });
    const {Restaurant} = await import('../src/models/operations.js');
    const {User} = await import('../src/models/index.js');
    const other = await Restaurant.create({name: 'Other Co', currency: 'NPR', vatRate: 13});
    const outsider = await User.create({
      name: 'Outsider', email: 'out@test.com', password: 'x', role: 'owner',
      restaurant: 'Other Co', restaurantId: other._id
    });
    const list = await request('/api/kitchen/stations', {token: tokenFor(outsider)});
    assert.ok(!list.body.codes.includes('momo'), 'another restaurant must not see it');
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────
describe('Phase 5C — order routing', () => {
  const catalogue = [
    {code: 'kitchen', name: 'Kitchen', isDefault: true, categories: ['main'], active: true},
    {code: 'bar', name: 'Bar', categories: ['cocktail'], active: true},
    {code: 'beverage', name: 'Beverage', categories: ['drinks', 'tea'], active: true},
    {code: 'grill', name: 'Grill', categories: ['bbq'], active: true}
  ];

  it('prefers an explicit item station over its category', () => {
    const item = {station: 'grill', category: 'cocktail'};
    assert.equal(routeItemToStation(item, catalogue), 'grill');
  });

  it('falls back to the category mapping', () => {
    assert.equal(routeItemToStation({category: 'cocktail'}, catalogue), 'bar');
    assert.equal(routeItemToStation({category: 'TEA'}, catalogue), 'beverage');
  });

  it('falls back to the default station last', () => {
    assert.equal(routeItemToStation({category: 'unmapped'}, catalogue), 'kitchen');
    assert.equal(routeItemToStation({}, catalogue), 'kitchen');
    // An explicit station the restaurant does not have is ignored, not trusted.
    assert.equal(routeItemToStation({station: 'teleporter'}, catalogue), 'kitchen');
  });

  it('ignores inactive stations when routing', () => {
    const withInactive = [...catalogue, {code: 'pizza', name: 'Pizza', categories: ['pizza'], active: false}];
    assert.equal(routeItemToStation({station: 'pizza'}, withInactive), 'kitchen');
    assert.equal(routeItemToStation({category: 'pizza'}, withInactive), 'kitchen');
  });

  it('picks a sensible default when none is flagged', () => {
    assert.equal(defaultStationOf([{code: 'bar', active: true}]), 'bar');
    assert.equal(defaultStationOf([]), 'kitchen');
  });

  it('routes each order line to its station at creation', async () => {
    await stations();
    const beer = await menuItem({name: 'Gorkha Beer', station: 'bar'});
    const tea = await menuItem({name: 'Milk Tea', category: 'tea'});      // by category
    const plain = await menuItem({name: 'Plain Rice', category: 'nothing'}); // default

    const order = await placeOrder([
      {menuItem: String(beer._id), qty: 1},
      {menuItem: String(tea._id), qty: 2},
      {menuItem: String(plain._id), qty: 1}
    ]);
    const stored = await Order.findById(order._id);
    const byName = Object.fromEntries(stored.items.map(i => [i.name, i.station]));
    assert.equal(byName['Gorkha Beer'], 'bar', 'explicit station');
    assert.equal(byName['Milk Tea'], 'beverage', 'category mapping');
    assert.equal(byName['Plain Rice'], 'kitchen', 'default station');
  });

  it('routes to a custom station', async () => {
    await request('/api/kitchen/stations', {
      method: 'POST', token: owner(), body: {code: 'momo', name: 'Momo Counter', categories: ['momo']}
    });
    const steamed = await menuItem({name: 'Steam Momo', category: 'momo'});
    const order = await placeOrder([{menuItem: String(steamed._id), qty: 1}]);
    const stored = await Order.findById(order._id);
    assert.equal(stored.items[0].station, 'momo');

    const momoBoard = await board('&station=momo');
    assert.equal(momoBoard.status, 200, momoBoard.body?.message);
    assert.equal(momoBoard.body.tickets.length, 1);
  });

  it('keeps the routed station on the ticket even if the menu changes later', async () => {
    await stations();
    const beer = await menuItem({name: 'Beer', station: 'bar'});
    const order = await placeOrder([{menuItem: String(beer._id), qty: 1}]);
    await MenuItem.updateOne({_id: beer._id}, {$set: {station: 'grill'}});
    const stored = await Order.findById(order._id);
    assert.equal(stored.items[0].station, 'bar', 'a live ticket must not re-route');
  });
});

// ── Board integration ────────────────────────────────────────────────────────
describe('Phase 5C — board station filtering', () => {
  it('separates work across bar, beverage and kitchen screens', async () => {
    await stations();
    const beer = await menuItem({name: 'Beer', station: 'bar'});
    const juice = await menuItem({name: 'Juice', station: 'beverage'});
    const curry = await menuItem({name: 'Curry', station: 'kitchen'});

    await placeOrder([
      {menuItem: String(beer._id), qty: 1},
      {menuItem: String(curry._id), qty: 1}
    ]);
    await placeOrder([{menuItem: String(juice._id), qty: 2}]);

    const bar = await board('&station=bar');
    assert.equal(bar.body.tickets.length, 1);
    assert.equal(bar.body.tickets[0].items.length, 1);
    assert.equal(bar.body.tickets[0].items[0].name, 'Beer');

    const bev = await board('&station=beverage');
    assert.equal(bev.body.tickets.length, 1);
    assert.equal(bev.body.tickets[0].items[0].name, 'Juice');

    const kitchen = await board('&station=kitchen');
    assert.equal(kitchen.body.tickets.length, 1);
    assert.equal(kitchen.body.tickets[0].items[0].name, 'Curry');
  });

  it('reports per-station counts and the configured list', async () => {
    await stations();
    const beer = await menuItem({name: 'Beer', station: 'bar'});
    await placeOrder([{menuItem: String(beer._id), qty: 1}]);
    const res = await board();
    assert.equal(res.body.summary.byStation.bar, 1);
    assert.equal(res.body.summary.byStation.grill, 0);
    assert.ok(res.body.stations.includes('beverage'));
    assert.ok(res.body.stationDetail.some(s => s.code === 'bar' && s.name === 'Bar'));
  });

  it('rejects a station the restaurant has not defined', async () => {
    await stations();
    assert.equal((await board('&station=teleporter')).status, 400);
  });

  it('accepts a station once it is created', async () => {
    assert.equal((await board('&station=momo')).status, 400);
    await request('/api/kitchen/stations', {
      method: 'POST', token: owner(), body: {code: 'momo', name: 'Momo'}
    });
    assert.equal((await board('&station=momo')).status, 200);
  });
});

// ── Menu API + authorization ─────────────────────────────────────────────────
describe('Phase 5C — menu assignment and authorization', () => {
  it('accepts a configured station on a menu item and rejects an unknown one', async () => {
    await stations();
    const good = await request('/api/menu-items', {
      method: 'POST', token: owner(),
      body: {name: 'Lassi', code: 'LASSI', price: 120, station: 'beverage',
        recipe: [{ingredient: String(world.ingredient._id), qty: 10, unit: 'g'}]}
    });
    assert.equal(good.status, 201, good.body?.message);
    assert.equal(good.body.station, 'beverage');

    const bad = await request('/api/menu-items', {
      method: 'POST', token: owner(),
      body: {name: 'Bad', code: 'BAD1', price: 10, station: 'teleporter',
        recipe: [{ingredient: String(world.ingredient._id), qty: 1, unit: 'g'}]}
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /Unknown station/);
  });

  it('lets staff read stations but not change them', async () => {
    assert.equal((await stations('', staff())).status, 200);
    assert.equal((await request('/api/kitchen/stations', {
      method: 'POST', token: staff(), body: {code: 'x1', name: 'X'}
    })).status, 403);

    const created = await request('/api/kitchen/stations', {
      method: 'POST', token: manager(), body: {code: 'x1', name: 'X'}
    });
    assert.equal(created.status, 201);
    assert.equal((await request(`/api/kitchen/stations/${created.body._id}`, {
      method: 'PATCH', token: staff(), body: {name: 'Y'}
    })).status, 403);
    // Only an owner retires a station.
    assert.equal((await request(`/api/kitchen/stations/${created.body._id}`, {
      method: 'DELETE', token: manager()
    })).status, 403);
    assert.equal((await request(`/api/kitchen/stations/${created.body._id}`, {
      method: 'DELETE', token: owner()
    })).status, 200);
  });

  it('rejects unauthenticated and guest access', async () => {
    assert.equal((await request('/api/kitchen/stations')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await stations('', guest)).status, 403);
  });
});
