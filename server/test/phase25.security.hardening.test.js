import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Coupon, Ingredient, MenuItem, Supplier, User} from '../src/models/index.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {
  Branch, Customer, Order, PurchaseOrder, Restaurant, RestaurantTable
} from '../src/models/operations.js';
import {describeError} from '../src/services/httpErrors.js';
import {verifyAccessToken} from '../src/middleware/auth.js';

/**
 * Phase 25 — security hardening.
 *
 * A dedicated audit of authentication, JWT handling, tenant isolation, error
 * leakage, injection and socket authorization. Almost every test here asserts
 * that something is REFUSED, and the cross-tenant matrix at the bottom is the
 * brief's requirement made executable:
 *
 *     Restaurant A owner -> Restaurant B resource -> denied
 *
 * for every major module.
 */

let world;
let baseUrl;
let rival;

const owner = () => tokenFor(world.owner);
const staff = () => tokenFor(world.staffA);

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  rival = await buildRivalTenant();
});

/** A complete second tenant holding one of every major resource. */
async function buildRivalTenant() {
  const restaurant = await Restaurant.create({name: 'Rival Momo', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL'});
  const rivalOwner = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurantId: restaurant._id
  });
  const rivalStaff = await User.create({
    name: 'Rival Staff', email: 'rivalstaff@test.com', password: 'x', role: 'staff',
    restaurantId: restaurant._id, branch: branch._id
  });
  const ingredient = await Ingredient.create({
    restaurant: restaurant._id, code: 'RV-1', name: 'RIVAL-SECRET-SPICE', unit: 'g'
  });
  const menu = await MenuItem.create({
    restaurant: restaurant._id, name: 'RIVAL-SECRET-DISH', price: 999,
    recipe: [{ingredient: ingredient._id, qty: 10, unit: 'g'}]
  });
  const supplier = await Supplier.create({restaurant: restaurant._id, name: 'RIVAL-SECRET-SUPPLIER'});
  const catalogue = await SupplierIngredient.create({
    restaurant: restaurant._id, supplier: supplier._id, ingredient: ingredient._id,
    supplierSku: 'RIVAL-SECRET-SKU', purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: 1000,
    currentPrice: 500, createdBy: rivalOwner._id, updatedBy: rivalOwner._id
  });
  const table = await RestaurantTable.create({
    branch: branch._id, name: 'RVT1', area: 'RIVAL-SECRET-HALL', seats: 4
  });
  const customer = await Customer.create({
    restaurant: restaurant._id, branch: branch._id, name: 'RIVAL-SECRET-CUSTOMER',
    phone: '9999000111', phoneKey: '9999000111'
  });
  const order = await Order.create({
    orderNo: 'RIVAL-SECRET-ORD', branch: branch._id, table: table._id, type: 'dine-in',
    status: 'pending', items: [{menuItem: menu._id, name: 'RIVAL-SECRET-DISH', qty: 1, unitPrice: 999}],
    subtotal: 999, vatRate: 13, vat: 129.87, total: 1128.87, dueAmount: 1128.87,
    createdBy: rivalOwner._id
  });
  const purchaseOrder = await PurchaseOrder.create({
    restaurant: restaurant._id, poNo: 'RIVAL-SECRET-PO', branch: branch._id, supplier: supplier._id,
    status: 'draft', orderDate: new Date(),
    items: [{
      ingredient: ingredient._id, supplierItem: catalogue._id, orderedQty: 5, unit: 'kg',
      baseUnit: 'g', conversionFactor: 1000, unitPrice: 500, vatRate: 13,
      lineSubtotal: 2500, lineVat: 325, lineTotal: 2825
    }],
    subtotal: 2500, vat: 325, total: 2825, createdBy: rivalOwner._id, updatedBy: rivalOwner._id
  });
  return {
    restaurant, branch, owner: rivalOwner, staff: rivalStaff, ingredient, menu, supplier,
    catalogue, table, customer, order, purchaseOrder
  };
}

const DENIED = [400, 401, 403, 404, 405, 409];

// ── JWT ──────────────────────────────────────────────────────────────────────

describe('Phase 25 · JWT verification', () => {
  const claims = () => ({
    id: String(world.owner._id), role: 'owner',
    restaurantId: String(world.restaurant._id), sv: 0
  });

  it('refuses a token with no expiry', async () => {
    /**
     * FOUND AND FIXED. `jwt.verify(token, secret)` does not require `exp`, so
     * a token minted without one verified forever. Reproduced: a token whose
     * `iat` was a year old and which carried no `exp` returned 200 on
     * `/api/branches` and also opened a websocket.
     *
     * Note `requireExp` is NOT a jsonwebtoken option — passing it is silently
     * ignored, which is how the first attempt at this fix looked applied and
     * changed nothing. The claim is asserted explicitly instead.
     */
    const forever = jwt.sign(claims(), process.env.JWT_SECRET);
    assert.equal('exp' in jwt.decode(forever), false, 'the fixture really has no exp');

    const res = await request('/api/branches', {token: forever});
    assert.equal(res.status, 401, JSON.stringify(res.body));

    const ancient = jwt.sign(
      {...claims(), iat: Math.floor(Date.now() / 1000) - 86400 * 365},
      process.env.JWT_SECRET
    );
    assert.equal((await request('/api/branches', {token: ancient})).status, 401);

    // CONTROL: the same claims WITH an expiry are accepted, so the rejection
    // above is the missing `exp` and not a broken fixture.
    const proper = jwt.sign(claims(), process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await request('/api/branches', {token: proper})).status, 200);
  });

  it('pins the signing algorithm', async () => {
    const header = Buffer.from(JSON.stringify({alg: 'none', typ: 'JWT'})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({...claims(), exp: Math.floor(Date.now() / 1000) + 3600})).toString('base64url');
    assert.equal((await request('/api/branches', {token: `${header}.${payload}.`})).status, 401);

    // A valid HS512 signature over the same secret must not be accepted when
    // the deployment only ever issues HS256.
    const hs512 = jwt.sign(claims(), process.env.JWT_SECRET, {algorithm: 'HS512', expiresIn: '1h'});
    assert.equal((await request('/api/branches', {token: hs512})).status, 401,
      'only the pinned algorithm may verify');

    assert.throws(() => verifyAccessToken(hs512), /invalid algorithm/i);
  });

  it('refuses a wrong signature, an expired token and junk', async () => {
    const wrong = jwt.sign(claims(), 'a-totally-different-secret-value-1234567890', {expiresIn: '1h'});
    assert.equal((await request('/api/branches', {token: wrong})).status, 401);
    const expired = jwt.sign(claims(), process.env.JWT_SECRET, {expiresIn: '-1h'});
    assert.equal((await request('/api/branches', {token: expired})).status, 401);
    assert.equal((await request('/api/branches', {token: 'not.a.token'})).status, 401);
    assert.equal((await request('/api/branches')).status, 401);
  });

  it('never trusts role or tenant from the token itself', async () => {
    /**
     * Storage is authoritative. A staff user who forges `role: 'owner'` and
     * another tenant's `restaurantId` into an otherwise VALID token must gain
     * nothing: `resolvePrincipal()` re-reads both from the database.
     *
     * The claims are copied from a genuine token so that `sv` matches the
     * stored session version -- an arbitrary `sv: 0` would be rejected as a
     * revoked session (401) and the test would pass for the wrong reason.
     */
    const {exp, iat, ...genuine} = jwt.decode(tokenFor(world.staffA));
    const forged = jwt.sign(
      {
        ...genuine,
        role: 'owner',
        restaurantId: String(rival.restaurant._id)
      },
      process.env.JWT_SECRET, {expiresIn: '1h'}
    );

    /**
     * A forged `role` claim does not merely fail to grant access -- it ends
     * the request with 401. `resolvePrincipal()` treats a claim that disagrees
     * with storage as a token minted before a demotion and refuses it
     * outright, which is stricter than silently ignoring the claim.
     */
    const accounts = await request('/api/accounts', {token: forged});
    assert.equal(accounts.status, 401, 'a forged role claim must not be honoured');

    const branches = await request('/api/branches', {token: forged});
    assert.equal(branches.status, 401);
    assert.ok(!JSON.stringify(branches.body ?? '').includes('Rival Branch'),
      'a forged restaurantId claim must not widen tenant scope');

    /**
     * Forging ONLY the tenant, leaving `role` honest, is the subtler attack:
     * it survives the demotion check, so the tenant pin has to come from
     * storage. It does -- the caller still sees their own restaurant.
     */
    const tenantOnly = jwt.sign(
      {...genuine, restaurantId: String(rival.restaurant._id)},
      process.env.JWT_SECRET, {expiresIn: '1h'}
    );
    const scoped = await request('/api/branches', {token: tenantOnly});
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.ok(!JSON.stringify(scoped.body).includes('Rival Branch'),
      'the tenant must come from storage, not from the claim');
    for (const branch of scoped.body) {
      assert.equal(String(branch.restaurant), String(world.restaurant._id));
    }
  });
});

// ── authentication and enumeration ───────────────────────────────────────────

describe('Phase 25 · authentication', () => {
  it('gives an identical answer for a bad password and an unknown user', async () => {
    // Different messages, or a materially different shape, let an attacker
    // enumerate valid staff email addresses before ever guessing a password.
    const known = await request('/api/auth/login', {
      method: 'POST', body: {email: 'owner@test.com', password: 'definitely-wrong-1'}
    });
    const unknown = await request('/api/auth/login', {
      method: 'POST', body: {email: 'nobody@nowhere.test', password: 'definitely-wrong-1'}
    });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(known.status, 401);
  });

  it('cannot be bypassed with a NoSQL operator in the credentials', async () => {
    // `{$ne: null}` as an email would match the first user if the query were
    // built straight from the body.
    for (const body of [
      {email: {$ne: null}, password: {$ne: null}},
      {email: {$gt: ''}, password: {$gt: ''}},
      {email: 'owner@test.com', password: {$ne: 'x'}}
    ]) {
      const res = await request('/api/auth/login', {method: 'POST', body});
      assert.ok([400, 401].includes(res.status), `${JSON.stringify(body)} -> ${res.status}`);
      assert.ok(!res.body?.token, 'no token may be issued');
    }
  });

  it('never returns a password hash from any account endpoint', async () => {
    for (const path of ['/api/accounts', '/api/me/permissions']) {
      const res = await request(path, {token: owner()});
      const body = JSON.stringify(res.body ?? '');
      assert.ok(!body.includes('$2a$') && !body.includes('$2b$'), `${path} leaked a bcrypt hash`);
      assert.ok(!/"password"/.test(body), `${path} returned a password field`);
    }
  });
});

// ── error leakage ────────────────────────────────────────────────────────────

describe('Phase 25 · error responses do not leak internals', () => {
  it('maps an unexpected error to a generic 500, not a 400', () => {
    /**
     * Eight routers shared
     *   `(res, e) => res.status(e.status || 400).json({message: e.message})`
     * which echoed ANY error and blamed the caller for server bugs.
     */
    const bug = new TypeError("Cannot read properties of null (reading 'recipeVersion')");
    const mapped = describeError(bug);
    assert.equal(mapped.status, 500, 'a runtime bug is a server fault');
    assert.equal(mapped.message, 'Server error');
    assert.ok(!mapped.message.includes('recipeVersion'), 'no internal detail');

    const cast = Object.assign(new Error('Cast to ObjectId failed for value "abc"'), {name: 'CastError', status: 400});
    assert.ok(!describeError(cast).message.includes('ObjectId'), 'no driver detail');

    const mongo = Object.assign(new Error('E11000 duplicate key error collection: mittho.users'), {name: 'MongoServerError'});
    const mongoMapped = describeError(mongo);
    assert.equal(mongoMapped.status, 500);
    assert.ok(!mongoMapped.message.includes('mittho.users'), 'no collection name');

    // A deliberate client error still speaks plainly — the point is not to
    // make every message useless.
    assert.deepEqual(
      describeError(Object.assign(new Error('Branch is required'), {status: 400})),
      {status: 400, message: 'Branch is required'}
    );
    // And an explicit 5xx stays a 5xx.
    assert.equal(describeError(Object.assign(new Error('boom'), {status: 503})).message, 'Server error');
  });

  it('keeps a model validation rule as a usable 400', async () => {
    /**
     * The mapper must not be so blunt that it destroys real information. A
     * Mongoose ValidationError is a BUSINESS RULE the schema enforces, and for
     * some rules the schema is the only place they live. My first version of
     * this mapper swept it into "Server error", which turned a legitimate 400
     * into a 500 and told the operator nothing — caught by the existing
     * supplier-master tests, not by me.
     *
     * The authored field message is returned; the model name and internal path
     * that Mongoose prefixes ("Supplier validation failed: pan: ...") are not.
     */
    const res = await request('/api/suppliers', {
      method: 'POST', token: owner(), body: {name: 'No PAN Co', vatRegistered: true}
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /PAN/i, 'the operator is told what is wrong');
    assert.ok(!res.body.message.includes('validation failed'), 'no Mongoose prefix');
    assert.ok(!/^Supplier /.test(res.body.message), 'no model name');
    assert.equal(await Supplier.countDocuments({name: 'No PAN Co'}), 0);
  });

  it('summarises a validation error instead of dumping the schema', async () => {
    // This returned a full serialised ZodError, including internal paths.
    const res = await request(`/api/suppliers/${rival.supplier._id}`, {
      method: 'PATCH', token: owner(), body: {name: 'x'}
    });
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('invalid_type'), 'raw Zod issue code leaked');
    assert.ok(!body.includes('"received"'), 'raw Zod internals leaked');
    assert.ok(body.length < 200, `error body is too chatty: ${body}`);
  });

  it('does not leak a stack-shaped message from the recipes module', async () => {
    // Reproduced: 400 "Cannot read properties of null (reading 'recipeVersion')"
    // for another tenant's menu id — both an internal detail and an existence
    // oracle.
    const res = await request(`/api/menu-items/${rival.menu._id}/versions`, {token: owner()});
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.match(res.body.message, /not found/i);
    assert.ok(!res.body.message.includes('Cannot read properties'));
  });

  it('answers a foreign id exactly as a nonexistent one', async () => {
    // Otherwise the API is an existence oracle for other tenants' data.
    const missing = new mongoose.Types.ObjectId();
    for (const [label, foreign] of [
      ['menu item', rival.menu._id],
      ['ingredient', rival.ingredient._id],
      ['customer', rival.customer._id]
    ]) {
      const base = label === 'menu item' ? '/api/menu-items/'
        : label === 'ingredient' ? '/api/ingredients/' : '/api/customers/';
      const foreignRes = await request(`${base}${foreign}`, {token: owner()});
      const missingRes = await request(`${base}${missing}`, {token: owner()});
      assert.equal(foreignRes.status, missingRes.status, `${label}: status differs`);
      assert.deepEqual(foreignRes.body, missingRes.body, `${label}: body differs`);
    }
  });
});

// ── injection and input handling ─────────────────────────────────────────────

describe('Phase 25 · injection and input handling', () => {
  it('does not let a query-string operator widen a filter', async () => {
    for (const query of [
      'branch[$ne]=x', 'branch[$exists]=true', 'status[$ne]=zzz',
      'limit[$ne]=1', 'page[$gt]=0', 'type[$ne]=zzz'
    ]) {
      const res = await request(`/api/orders?${query}`, {token: owner()});
      assert.ok([200, 400].includes(res.status), `${query} -> ${res.status}`);
      // Whatever comes back must still be this tenant's data only.
      assert.ok(!JSON.stringify(res.body ?? '').includes('RIVAL-SECRET'),
        `${query} leaked another tenant`);
    }
  });

  it('treats a search term as text, not as a pattern', async () => {
    // `.*` must not behave as a regex that returns the whole customer table.
    await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id,
      name: 'Ordinary Guest', phone: '9800001234', phoneKey: '9800001234'
    });
    const wild = await request(
      `/api/customers/search?q=${encodeURIComponent('.*')}&branch=${world.branchA._id}`,
      {token: owner()}
    );
    assert.equal(wild.status, 200);
    assert.equal(wild.body.customers.length, 0, 'a regex metacharacter must not match everything');

    // CONTROL: a real substring still finds the row.
    const real = await request(
      `/api/customers/search?q=Ordinary&branch=${world.branchA._id}`, {token: owner()}
    );
    assert.equal(real.body.customers.length, 1);
  });

  it('rejects an oversized request body', async () => {
    const res = await request('/api/customers', {
      method: 'POST', token: owner(),
      body: {name: 'x'.repeat(2 * 1024 * 1024), phone: '9800000000', branch: String(world.branchA._id)}
    });
    assert.equal(res.status, 413, JSON.stringify(res.body).slice(0, 120));
    assert.equal(await Customer.countDocuments({phone: '9800000000'}), 0);
  });
});

// ── security headers ─────────────────────────────────────────────────────────

describe('Phase 25 · response headers', () => {
  it('sets the baseline hardening headers on API responses', async () => {
    const res = await request('/api/branches', {token: owner(), raw: true});
    const headers = res.headers;
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.match(headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.match(headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(headers.get('cache-control'), 'no-store',
      'an authenticated API response must not be cached');
  });

  it('does not send HSTS over plain HTTP in development', async () => {
    // Sending it from a dev box pins the browser to https:// and locks
    // developers out of their own machine.
    const res = await request('/api/branches', {token: owner(), raw: true});
    assert.equal(res.headers.get('strict-transport-security'), null);
  });
});

// ── the generic crud() helper ────────────────────────────────────────────────

describe('Phase 25 · no unscoped generic CRUD remains', () => {
  it('has removed the tenant-blind crud() generator', async () => {
    /**
     * `crud()` in index.js generated `Model.find()` with NO tenant filter,
     * `findByIdAndUpdate(req.params.id, req.body)` (any id, mass-assigned) and
     * `Model.create(req.body)`. Its only caller, `crud('expenses')`, was
     * already shadowed by the tenant-scoped routes in purchasing.js — verified
     * with an Express probe — so it was dead. It was also one mount-order
     * change away from silently replacing a hardened endpoint, and it lived
     * outside the harness's router set, exactly where the Phase 21
     * cross-tenant audit leak hid.
     */
    const {readFile} = await import('node:fs/promises');
    const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
    // Comment lines are stripped first: the explanatory note above the removal
    // names `crud('expenses', Expense)`, and matching that would make this
    // test pass or fail on prose rather than on code.
    const code = source
      .split('\n')
      .filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join('\n');
    assert.ok(!/const crud\s*=\s*\(/.test(code), 'the crud() generator must not come back');
    assert.ok(!/^[^/]*crud\('expenses'/m.test(code), 'no caller may remain');
    assert.ok(!/Model\.find\(\)/.test(code), 'no unfiltered Model.find() in index.js');
  });
});

// ── the legacy shared pool ───────────────────────────────────────────────────

describe('Phase 25 · the unowned-record pool is closed', () => {
  it('hides a record with no restaurant from every tenant', async () => {
    /**
     * FOUND AND FIXED. recipes.js widened lookups with
     * `$or: [{restaurant: id}, {restaurant: null}, {restaurant: {$exists:false}}]`
     * so pre-multi-tenancy rows stayed reachable. That made every unowned row
     * a GLOBAL SHARED POOL. Reproduced: two different restaurants both read
     * the same unowned menu item, and tenant B PATCHed its price to 777.
     */
    const orphanMenu = await MenuItem.create({name: 'LEGACY-SHARED-DISH', price: 100, recipe: []});
    const orphanIngredient = await Ingredient.create({code: 'LEG1', name: 'LEGACY-SHARED-ING', unit: 'g'});

    for (const [label, token] of [['A', owner()], ['B', tokenFor(rival.owner)]]) {
      const read = await request(`/api/menu-items/${orphanMenu._id}`, {token});
      assert.equal(read.status, 404, `tenant ${label} could read an unowned record`);

      const list = await request('/api/menu-items', {token});
      assert.ok(!JSON.stringify(list.body).includes('LEGACY-SHARED-DISH'),
        `tenant ${label} listed an unowned record`);

      const ingredients = await request('/api/ingredients', {token});
      assert.ok(!JSON.stringify(ingredients.body).includes('LEGACY-SHARED-ING'),
        `tenant ${label} listed an unowned ingredient`);
    }

    // And no tenant may WRITE to it — the cross-tenant write that was proven.
    const write = await request(`/api/menu-items/${orphanMenu._id}`, {
      method: 'PATCH', token: tokenFor(rival.owner), body: {price: 777}
    });
    assert.equal(write.status, 404, JSON.stringify(write.body));
    assert.equal((await MenuItem.findById(orphanMenu._id).lean()).price, 100,
      'the unowned record must be unchanged');
    assert.ok(orphanIngredient._id);
  });

  it('still serves each tenant its own records', async () => {
    // CONTROL. Closing the pool must not have hidden legitimate data.
    const list = await request('/api/menu-items', {token: owner()});
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some(item => item.name === 'Chicken Biryani'),
      'the tenant must still see its own menu');
  });
});

// ── THE CROSS-TENANT MATRIX ──────────────────────────────────────────────────

describe('Phase 25 · Restaurant A owner -> Restaurant B resource -> denied', () => {
  /**
   * The brief's requirement, for every major module.
   *
   * An owner is used deliberately: they are the most privileged principal and
   * `assertBranchAccess()` returns early for them, so an owner is precisely
   * the account that a branch-only check fails to stop. The tenant boundary
   * has to be enforced somewhere else, and this proves it is.
   */
  const cases = () => [
    ['orders · read', 'GET', `/api/orders/${rival.order._id}`],
    ['orders · payments', 'GET', `/api/orders/${rival.order._id}/payments`],
    ['orders · payment summary', 'GET', `/api/orders/${rival.order._id}/payment-summary`],
    ['orders · receipt', 'GET', `/api/orders/${rival.order._id}/receipt`],
    ['orders · advance status', 'PATCH', `/api/orders/${rival.order._id}/status`, {status: 'accepted'}],
    ['orders · take payment', 'POST', `/api/orders/${rival.order._id}/payments`, {amount: 10, method: 'cash'}],
    ['orders · refund', 'POST', `/api/orders/${rival.order._id}/refunds`, {amount: 1, reason: 'probe'}],
    ['orders · reopen', 'POST', `/api/orders/${rival.order._id}/reopen`, {reason: 'probe'}],
    ['menu · read', 'GET', `/api/menu-items/${rival.menu._id}`],
    ['menu · update', 'PATCH', `/api/menu-items/${rival.menu._id}`, {price: 1}],
    ['menu · cost', 'GET', `/api/menu-items/${rival.menu._id}/cost`],
    ['menu · versions', 'GET', `/api/menu-items/${rival.menu._id}/versions`],
    ['menu · food costing', 'GET', `/api/menu-items/${rival.menu._id}/food-costing`],
    ['ingredients · read', 'GET', `/api/ingredients/${rival.ingredient._id}`],
    ['ingredients · update', 'PATCH', `/api/ingredients/${rival.ingredient._id}`, {name: 'pwned'}],
    ['ingredients · suppliers', 'GET', `/api/ingredients/${rival.ingredient._id}/suppliers`],
    ['ingredients · costs', 'GET', `/api/ingredients/${rival.ingredient._id}/costs`],
    ['suppliers · update', 'PATCH', `/api/suppliers/${rival.supplier._id}`, {expectedVersion: 0, name: 'pwned'}],
    ['supplier catalogue · update', 'PATCH', `/api/supplier-catalog/${rival.catalogue._id}`, {expectedVersion: 0, currentPrice: 1}],
    ['supplier catalogue · price history', 'GET', `/api/supplier-catalog/${rival.catalogue._id}/price-history`],
    ['purchasing · read PO', 'GET', `/api/purchase-orders/${rival.purchaseOrder._id}`],
    ['purchasing · approval history', 'GET', `/api/purchase-orders/${rival.purchaseOrder._id}/approval-history`],
    ['purchasing · receipts', 'GET', `/api/purchase-orders/${rival.purchaseOrder._id}/receipts`],
    ['purchasing · transition', 'PATCH', `/api/purchase-orders/${rival.purchaseOrder._id}/status`, {status: 'pending', expectedVersion: 0}],
    ['purchasing · list by branch', 'GET', `/api/purchase-orders?branch=${rival.branch._id}`],
    ['tables · read', 'GET', `/api/tables/${rival.table._id}`],
    ['tables · list by branch', 'GET', `/api/tables?branch=${rival.branch._id}`],
    ['tables · floor plan', 'GET', `/api/tables/floor?branch=${rival.branch._id}`],
    ['tables · settlement', 'GET', `/api/tables/${rival.table._id}/settlement`],
    ['tables · history', 'GET', `/api/tables/${rival.table._id}/history`],
    ['tables · bill', 'GET', `/api/tables/${rival.table._id}/bill`],
    ['tables · update', 'PATCH', `/api/tables/${rival.table._id}`, {seats: 9}],
    ['tables · set status', 'PATCH', `/api/tables/${rival.table._id}/status`, {status: 'cleaning'}],
    ['tables · delete', 'DELETE', `/api/tables/${rival.table._id}`],
    ['customers · read', 'GET', `/api/customers/${rival.customer._id}`],
    ['customers · history', 'GET', `/api/customers/${rival.customer._id}/history`],
    ['customers · update', 'PATCH', `/api/customers/${rival.customer._id}`, {name: 'pwned'}],
    ['customers · list by branch', 'GET', `/api/customers?branch=${rival.branch._id}`],
    ['inventory · balances', 'GET', `/api/inventory/balances?branch=${rival.branch._id}`],
    ['inventory · ledger', 'GET', `/api/inventory/transactions?branch=${rival.branch._id}`],
    ['inventory · batches', 'GET', `/api/inventory/batches?branch=${rival.branch._id}`],
    ['inventory · valuation', 'GET', `/api/inventory/valuation?branch=${rival.branch._id}`],
    ['inventory · adjust', 'POST', '/api/inventory/adjustments', {branch: null, ingredient: null, qty: 1, reason: 'probe'}],
    ['stock counts · list', 'GET', `/api/stock-counts?branch=${rival.branch._id}`],
    ['kitchen · queue', 'GET', `/api/kitchen/orders?branch=${rival.branch._id}`],
    ['kitchen · board', 'GET', `/api/kitchen/board?branch=${rival.branch._id}`],
    ['kds · priority', 'PATCH', `/api/orders/${rival.order._id}/priority`, {priority: 'rush'}],
    ['deliveries · list', 'GET', `/api/deliveries?branch=${rival.branch._id}`],
    ['riders · list', 'GET', `/api/riders?branch=${rival.branch._id}`],
    ['riders · update', 'PATCH', `/api/riders/${rival.staff._id}`, {maxConcurrent: 9}],
    ['riders · history', 'GET', `/api/riders/${rival.staff._id}/history`],
    ['reservations · list', 'GET', `/api/reservations?branch=${rival.branch._id}`],
    ['alerts · list', 'GET', `/api/alerts?branch=${rival.branch._id}`],
    ['waste · list', 'GET', `/api/waste/events?branch=${rival.branch._id}`],
    ['transfers · list', 'GET', `/api/transfers?branch=${rival.branch._id}`],
    ['dashboard', 'GET', `/api/dashboard?branch=${rival.branch._id}`],
    ['accounts · reset password', 'POST', `/api/accounts/${rival.staff._id}/password`, {password: 'NewPassword2026'}],
    ['accounts · deactivate', 'PATCH', `/api/accounts/${rival.staff._id}/active`, {active: false}],
    ['rbac · change role', 'PATCH', `/api/users/${rival.staff._id}/role`, {role: 'manager'}],
    ['exports · invoice pdf', 'GET', `/api/exports/invoices/${rival.order._id}.pdf`],
    ['exports · statement pdf', 'GET', `/api/exports/statements/${rival.supplier._id}.pdf`]
  ];

  it('refuses every cross-tenant request and leaks nothing', async () => {
    const allowed = [];
    const leaked = [];

    for (const [label, method, path, body] of cases()) {
      const res = await request(path, {method, token: owner(), ...(body ? {body} : {})});
      const text = JSON.stringify(res.body ?? '');

      if (!DENIED.includes(res.status)) {
        allowed.push(`${label}: ${method} ${path} -> ${res.status}`);
      }
      if (/RIVAL-SECRET/.test(text)) {
        leaked.push(`${label}: ${text.slice(0, 160)}`);
      }
    }

    assert.deepEqual(leaked, [], 'another tenant\'s data appeared in a response');
    assert.deepEqual(allowed, [], 'a cross-tenant request was allowed');
  });

  it('leaves the rival tenant\'s data untouched by those attempts', async () => {
    for (const [, method, path, body] of cases()) {
      if (method === 'GET') continue;
      await request(path, {method, token: owner(), ...(body ? {body} : {})});
    }
    // DATABASE: nothing the write attempts targeted may have changed.
    assert.equal((await MenuItem.findById(rival.menu._id).lean()).price, 999);
    assert.equal((await Ingredient.findById(rival.ingredient._id).lean()).name, 'RIVAL-SECRET-SPICE');
    assert.equal((await Order.findById(rival.order._id).lean()).status, 'pending');
    assert.equal((await Customer.findById(rival.customer._id).lean()).name, 'RIVAL-SECRET-CUSTOMER');
    assert.equal((await PurchaseOrder.findById(rival.purchaseOrder._id).lean()).status, 'draft');
    assert.ok(await RestaurantTable.findById(rival.table._id).lean(), 'the rival table still exists');
    assert.equal((await RestaurantTable.findById(rival.table._id).lean()).seats, 4);
    const rivalStaff = await User.findById(rival.staff._id).lean();
    assert.equal(rivalStaff.role, 'staff', 'no cross-tenant role change');
    assert.notEqual(rivalStaff.active, false, 'no cross-tenant deactivation');
  });

  it('the rival owner CAN reach their own resources', async () => {
    /**
     * The control for the whole matrix. Without it, every 403 above could be
     * explained by a broken fixture rather than by working authorization.
     */
    const token = tokenFor(rival.owner);
    const menu = await request(`/api/menu-items/${rival.menu._id}`, {token});
    assert.equal(menu.status, 200, JSON.stringify(menu.body));
    assert.equal(menu.body.name, 'RIVAL-SECRET-DISH');

    const tables = await request(`/api/tables?branch=${rival.branch._id}`, {token});
    assert.equal(tables.status, 200);

    const order = await request(`/api/orders/${rival.order._id}`, {token});
    assert.equal(order.status, 200);
    assert.equal(order.body.orderNo, 'RIVAL-SECRET-ORD');
  });
});

// ── branch isolation inside one tenant ───────────────────────────────────────

describe('Phase 25 · branch isolation within a tenant', () => {
  it('pins a branch-bound user to their own branch', async () => {
    // staffA is in branchA. branchB is the same tenant, so this is the branch
    // boundary rather than the tenant one.
    for (const path of [
      `/api/tables?branch=${world.branchB._id}`,
      `/api/inventory/balances?branch=${world.branchB._id}`,
      `/api/kitchen/orders?branch=${world.branchB._id}`
    ]) {
      const res = await request(path, {token: staff()});
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }
    // CONTROL: their own branch works.
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token: staff()})).status, 200);
  });

  it('lets an owner cross branches inside their OWN tenant only', async () => {
    // This is the documented asymmetry: `assertBranchAccess()` returns early
    // for an owner, which is correct within a restaurant and is exactly why
    // the tenant check above must exist separately.
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token: owner()})).status, 200);
    assert.equal((await request(`/api/tables?branch=${world.branchB._id}`, {token: owner()})).status, 200);
    const foreign = await request(`/api/tables?branch=${rival.branch._id}`, {token: owner()});
    assert.equal(foreign.status, 403, 'but never into another restaurant');
  });
});

// ── socket authorization ─────────────────────────────────────────────────────

describe('Phase 25 · socket authorization', () => {
  const connect = (token, branch) => new Promise(resolve => {
    import('socket.io-client').then(({io: ioClient}) => {
      const socket = ioClient(baseUrl, {
        auth: {token, ...(branch ? {branch: String(branch)} : {})},
        transports: ['websocket'], forceNew: true, reconnection: false
      });
      socket.once('connect', () => resolve({ok: true, socket}));
      socket.once('connect_error', error => resolve({ok: false, message: error.message}));
      setTimeout(() => resolve({ok: false, message: 'timeout'}), 4000);
    }).catch(error => resolve({ok: false, message: error.message}));
  });

  it('refuses an unauthenticated or forged handshake', async () => {
    const claims = {id: String(world.owner._id), role: 'owner', restaurantId: String(world.restaurant._id), sv: 0};
    for (const [label, token] of [
      ['no token', undefined],
      ['junk', 'not.a.token'],
      ['wrong secret', jwt.sign(claims, 'x'.repeat(48), {expiresIn: '1h'})],
      ['expired', jwt.sign(claims, process.env.JWT_SECRET, {expiresIn: '-1h'})],
      ['no expiry', jwt.sign(claims, process.env.JWT_SECRET)]
    ]) {
      const result = await connect(token);
      if (result.socket) result.socket.close();
      assert.equal(result.ok, false, `${label} was allowed to connect`);
    }
  });

  it('refuses a handshake asking for another tenant\'s branch', async () => {
    const result = await connect(owner(), rival.branch._id);
    if (result.socket) result.socket.close();
    assert.equal(result.ok, false, 'a cross-tenant branch handshake was accepted');
    assert.match(result.message, /branch/i);
  });

  it('refuses to JOIN another tenant\'s branch room after connecting', async () => {
    // The handshake is not the only door: `join:branch` must re-check.
    const result = await connect(owner(), world.branchA._id);
    assert.equal(result.ok, true, 'the control connection must succeed');
    try {
      const joined = await new Promise(resolve => {
        result.socket.emit('join:branch', String(rival.branch._id), resolve);
        setTimeout(() => resolve({timeout: true}), 3000);
      });
      assert.ok(!joined?.ok, `a cross-tenant join was accepted: ${JSON.stringify(joined)}`);
    } finally {
      result.socket.close();
    }
  });
});
