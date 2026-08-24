#!/usr/bin/env node
/**
 * Phase 30 — production readiness gate.
 *
 * Drives the RUNNING Docker stack through nginx and asserts the behaviour a
 * production deployment depends on. This is not a unit test: it talks to real
 * containers over HTTP and WebSocket, so a pass means the assembled system
 * works, not that the code compiles.
 *
 *   node scripts/production-audit.mjs [--base http://localhost:8080]
 *
 * Exit code is 0 only if every check passes. Anything else is a failed gate.
 */
import {io} from 'socket.io-client';

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 ? process.argv[i + 1] : 'http://localhost:8080';
})();

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 58 - name.length))}`);
}

function record(name, ok, detail = '') {
  results.push({section: currentSection, name, ok, detail});
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? '');
  } catch (error) {
    record(name, false, error.message.slice(0, 110));
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let token = null;
let branch = null;

async function api(path, {method = 'GET', body, headers = {}, auth = true, raw = false} = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? {Authorization: `Bearer ${token}`} : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (raw) return response;
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return {status: response.status, body: parsed, headers: response.headers};
}

// ── 1. delivery chain ────────────────────────────────────────────────────────

section('ARCHITECTURE — Web / Nginx / API / MongoDB');

await check('nginx serves the SPA shell', async () => {
  const res = await api('/', {auth: false, raw: true});
  assert(res.status === 200, `status ${res.status}`);
  const html = await res.text();
  assert(html.includes('<div id="root"'), 'no React root element');
  return `${html.length} bytes`;
});

await check('hashed JS bundle is served', async () => {
  const shell = await (await api('/', {auth: false, raw: true})).text();
  const match = shell.match(/\/assets\/[^"']+\.js/);
  assert(match, 'no bundle referenced in the shell');
  const asset = await api(match[0], {auth: false, raw: true});
  assert(asset.status === 200, `asset status ${asset.status}`);
  return match[0];
});

await check('API reachable through nginx and DB connected', async () => {
  const res = await api('/health', {auth: false});
  assert(res.status === 200, `status ${res.status}`);
  assert(res.body.ok === true, 'health not ok');
  assert(res.body.database === 'connected', `database ${res.body.database}`);
  assert(res.body.startup === 'ready', `startup ${res.body.startup}`);
  return `db=${res.body.database} pool=${res.body.pool.maxPoolSize}`;
});

await check('nginx sends security headers', async () => {
  const res = await api('/', {auth: false, raw: true});
  for (const header of ['x-content-type-options', 'content-security-policy', 'x-frame-options']) {
    assert(res.headers.get(header), `${header} missing`);
  }
  assert(!/nginx\/[\d.]/.test(res.headers.get('server') || ''), 'nginx version disclosed');
  return 'nosniff, CSP, frame-options, no version';
});

// ── 2. security ──────────────────────────────────────────────────────────────

section('SECURITY — authentication, authorization, isolation');

await check('anonymous request is refused', async () => {
  const res = await api('/api/orders', {auth: false});
  assert(res.status === 401, `status ${res.status}`);
  return '401';
});

await check('login issues a token and leaks no credential', async () => {
  const res = await api('/api/auth/login', {
    method: 'POST', auth: false,
    body: {email: 'owner@mittho.demo', password: 'MitthoDemo2026'}
  });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.body.token, 'no token');
  const serialised = JSON.stringify(res.body);
  assert(!serialised.includes('MitthoDemo2026'), 'password echoed');
  assert(!serialised.includes('$2'), 'bcrypt hash echoed');
  token = res.body.token;
  return `token ${token.length} chars`;
});

await check('wrong password and unknown user answer identically', async () => {
  const known = await api('/api/auth/login', {
    method: 'POST', auth: false, body: {email: 'owner@mittho.demo', password: 'wrong-password-1'}
  });
  const unknown = await api('/api/auth/login', {
    method: 'POST', auth: false, body: {email: 'nobody@nowhere.test', password: 'wrong-password-1'}
  });
  assert(known.status === unknown.status, 'status differs — user enumeration');
  assert(JSON.stringify(known.body) === JSON.stringify(unknown.body), 'body differs');
  return `both ${known.status}`;
});

await check('NoSQL operator injection cannot bypass login', async () => {
  for (const body of [
    {email: {$ne: null}, password: {$ne: null}},
    {email: {$gt: ''}, password: {$gt: ''}}
  ]) {
    const res = await api('/api/auth/login', {method: 'POST', auth: false, body});
    assert(![200, 201].includes(res.status), `injection accepted: ${res.status}`);
    assert(!res.body?.token, 'token issued to an injected credential');
  }
  return 'refused';
});

await check('a token without an expiry is refused', async () => {
  // Forged with no `exp`. The signature is wrong too, but the point is that
  // neither path can produce a session.
  const header = Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({id: '507f1f77bcf86cd799439011', role: 'owner'})).toString('base64url');
  const res = await api('/api/orders', {headers: {Authorization: `Bearer ${header}.${payload}.x`}});
  assert(res.status === 401, `status ${res.status}`);
  return '401';
});

await check('branches resolve for the authenticated tenant', async () => {
  const res = await api('/api/branches');
  assert(res.status === 200, `status ${res.status}`);
  assert(Array.isArray(res.body) && res.body.length, 'no branches');
  branch = res.body[0]._id;
  return `${res.body.length} branches`;
});

await check('cross-tenant access is refused', async () => {
  // A well-formed but foreign ObjectId must never resolve.
  const foreign = '000000000000000000000001';
  const res = await api(`/api/orders?branch=${foreign}`);
  assert([400, 403, 404].includes(res.status), `status ${res.status}`);
  return `${res.status}`;
});

await check('error responses do not leak internals', async () => {
  const res = await api('/api/menu-items/not-a-valid-object-id');
  const message = String(res.body?.message || '');
  assert(!/Cast to ObjectId|MongoServerError|at Object\.|\/app\//.test(message), `leaked: ${message}`);
  return `${res.status} "${message.slice(0, 44)}"`;
});

// ── 3. restaurant operations ─────────────────────────────────────────────────

section('RESTAURANT OPERATIONS');

const modules = [
  ['POS · menu', '/api/menu-items?limit=20', b => b.items.length],
  ['POS · orders', '/api/orders?branch=$B&limit=10', b => b.orders.length],
  ['POS · tables', `/api/tables?branch=$B`, b => b.length],
  ['POS · customers', `/api/customers?branch=$B&limit=10`, b => b.customers.length],
  ['KDS · queue', `/api/kitchen/orders?branch=$B`, b => b.length],
  ['KDS · board', `/api/kitchen/board?branch=$B`, b => (b.stations || []).length],
  ['Inventory · balances', `/api/inventory/balances?branch=$B`, b => b.length],
  ['Inventory · ledger', `/api/inventory/transactions?branch=$B&limit=10`, b => b.length],
  ['Inventory · valuation', `/api/inventory/valuation?branch=$B`, b => (b.method ? 'ok' : '?')],
  ['Inventory · batches', `/api/inventory/batches?branch=$B`, b => (b.items || b).length],
  ['Purchasing · orders', `/api/purchase-orders?branch=$B`, b => (b.items || b).length],
  ['Purchasing · suppliers', `/api/suppliers`, b => (b.items || b).length],
  ['Purchasing · catalogue', `/api/supplier-catalog`, b => (b.items || b).length],
  ['Purchasing · invoices', `/api/supplier-invoices?branch=$B`, b => (b.items || b).length],
  ['Delivery · list', `/api/deliveries?branch=$B`, b => (b.items || b).length],
  ['Customers · summary', `/api/customers/summary?branch=$B`, () => 'ok'],
  ['Reports · dashboard', `/api/dashboard?branch=$B`, () => 'ok'],
  ['Reports · P&L', `/api/reports/pnl?branch=$B`, () => 'ok'],
  ['Reports · menu engineering', `/api/analytics/menu-engineering?branch=$B`, b => (b.length ?? 'ok')],
  ['Notifications', `/api/notifications`, b => b.notifications.length],
  ['Audit trail', `/api/audit`, b => b.events.length]
];

for (const [name, template, extract] of modules) {
  await check(name, async () => {
    const path = template.replace('$B', branch);
    const res = await api(path);
    assert(res.status === 200, `status ${res.status}`);
    const size = JSON.stringify(res.body).length;
    assert(size < 400_000, `payload ${size} bytes is too large for a default page`);
    return `${extract(res.body)} · ${(size / 1024).toFixed(1)}KB`;
  });
}

// ── 4. the money path ────────────────────────────────────────────────────────

section('FINANCIAL — POS to payment to tax invoice, with stock');

let orderId = null;
let orderTotal = 0;
let ingredientId = null;
let stockBefore = 0;

await check('inventory reads before the sale', async () => {
  const menu = await api('/api/menu-items?limit=60');
  const dish = menu.body.items.find(item => item.recipe?.length);
  assert(dish, 'no dish with a recipe');
  ingredientId = String(dish.recipe[0].ingredient?._id || dish.recipe[0].ingredient);
  const balances = await api(`/api/inventory/balances?branch=${branch}`);
  const row = balances.body.find(b => String(b.ingredient?._id || b.ingredient) === ingredientId);
  stockBefore = Number(row?.quantity || 0);
  globalThis.__dish = dish;
  return `${dish.name} · stock ${stockBefore}`;
});

await check('POS creates an order priced by the server', async () => {
  const res = await api('/api/orders', {
    method: 'POST',
    body: {branch, type: 'counter', items: [{menuItem: String(globalThis.__dish._id), qty: 2}]}
  });
  assert(res.status === 201, `status ${res.status} ${JSON.stringify(res.body).slice(0, 80)}`);
  orderId = res.body._id;
  orderTotal = res.body.total;
  // VAT must be computed, not echoed from the client.
  assert(res.body.vat > 0, 'no VAT computed');
  const expectedVat = Math.round(res.body.subtotal * 0.13 * 100) / 100;
  assert(Math.abs(res.body.vat - expectedVat) < 0.02, `VAT ${res.body.vat} != ${expectedVat}`);
  return `${res.body.orderNo} total ${orderTotal} vat ${res.body.vat}`;
});

await check('payment settles the order to zero due', async () => {
  const res = await api(`/api/orders/${orderId}/payments`, {
    method: 'POST',
    headers: {'Idempotency-Key': `audit-${Date.now()}`},
    body: {amount: orderTotal, method: 'cash'}
  });
  assert(res.status === 201, `status ${res.status}`);
  assert(Number(res.body.order.dueAmount) === 0, `due ${res.body.order.dueAmount}`);
  return `paid ${res.body.order.paidAmount}`;
});

await check('tax invoice is issued with a sequential number', async () => {
  const res = await api(`/api/orders/${orderId}/receipt?issue=true`);
  assert(res.status === 200, `status ${res.status}`);
  assert(res.body.invoiceNo, 'no invoice number');
  assert(/^INV-/.test(res.body.invoiceNo), `unexpected format ${res.body.invoiceNo}`);
  return res.body.invoiceNo;
});

await check('inventory was deducted by the sale', async () => {
  const balances = await api(`/api/inventory/balances?branch=${branch}`);
  const row = balances.body.find(b => String(b.ingredient?._id || b.ingredient) === ingredientId);
  const after = Number(row?.quantity || 0);
  assert(after < stockBefore, `stock did not move: ${stockBefore} -> ${after}`);
  return `${stockBefore} -> ${after}`;
});

await check('the ledger recorded the deduction', async () => {
  const res = await api(`/api/inventory/transactions?branch=${branch}&limit=5`);
  assert(res.status === 200, `status ${res.status}`);
  const deduction = res.body.find(row => row.type === 'RECIPE_DEDUCTION');
  assert(deduction, 'no RECIPE_DEDUCTION row');
  assert(deduction.changeQty < 0, 'deduction is not negative');
  return `${deduction.type} ${deduction.changeQty}`;
});

await check('refund requires a reason', async () => {
  const res = await api(`/api/orders/${orderId}/refunds`, {
    method: 'POST', headers: {'Idempotency-Key': `audit-r-${Date.now()}`},
    body: {amount: 1}
  });
  assert(res.status >= 400, `a reasonless refund was accepted: ${res.status}`);
  return `${res.status}`;
});

// ── 5. realtime ──────────────────────────────────────────────────────────────

section('REALTIME — Socket.IO through nginx');

await check('websocket upgrade succeeds through nginx', async () => {
  const socket = io(BASE, {
    auth: {token, branch}, transports: ['websocket'], reconnection: false
  });
  const seen = [];
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', error => reject(new Error(error.message)));
      setTimeout(() => reject(new Error('connect timeout')), 10_000);
    });
    assert(socket.io.engine.transport.name === 'websocket',
      `fell back to ${socket.io.engine.transport.name}`);

    for (const event of ['kitchen:new-order', 'payment:update', 'inventory:update']) {
      socket.on(event, () => seen.push(event));
    }
    const joined = await new Promise(resolve => {
      socket.emit('join:branch', String(branch), resolve);
      setTimeout(() => resolve(null), 4000);
    });
    assert(joined?.ok, `join refused: ${JSON.stringify(joined)}`);

    // Drive a real order and expect the events to arrive.
    const created = await api('/api/orders', {
      method: 'POST',
      body: {branch, type: 'counter', items: [{menuItem: String(globalThis.__dish._id), qty: 1}]}
    });
    assert(created.status === 201, `order status ${created.status}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert(seen.includes('kitchen:new-order'), `no kitchen event (saw ${seen.join(',') || 'none'})`);
    return `transport=websocket events=${[...new Set(seen)].join(',')}`;
  } finally {
    socket.close();
  }
});

await check('an unauthenticated socket is refused', async () => {
  const socket = io(BASE, {transports: ['websocket'], reconnection: false});
  try {
    const outcome = await new Promise(resolve => {
      socket.once('connect', () => resolve('connected'));
      socket.once('connect_error', error => resolve(error.message));
      setTimeout(() => resolve('timeout'), 6000);
    });
    assert(outcome !== 'connected', 'an anonymous socket was accepted');
    return outcome.slice(0, 40);
  } finally {
    socket.close();
  }
});

// ── 6. performance ───────────────────────────────────────────────────────────

section('PERFORMANCE — response times through the full stack');

const timed = [
  ['orders list', `/api/orders?branch=$B&limit=25`],
  ['POS menu', '/api/menu-items?limit=100'],
  ['KDS queue', `/api/kitchen/orders?branch=$B`],
  ['dashboard', `/api/dashboard?branch=$B`],
  ['P&L', `/api/reports/pnl?branch=$B`],
  ['inventory balances', `/api/inventory/balances?branch=$B`],
  ['menu engineering', `/api/analytics/menu-engineering?branch=$B`]
];

for (const [name, template] of timed) {
  await check(`${name} responds promptly`, async () => {
    const path = template.replace('$B', branch);
    await api(path); // warm
    const started = Date.now();
    const res = await api(path);
    const took = Date.now() - started;
    assert(res.status === 200, `status ${res.status}`);
    // Generous: this is a shared CI box through nginx, not a benchmark. The
    // point is to catch an order-of-magnitude regression, not to grade speed.
    assert(took < 2000, `${took}ms exceeds the 2s ceiling`);
    return `${took}ms · ${(JSON.stringify(res.body).length / 1024).toFixed(1)}KB`;
  });
}

await check('list endpoints are paginated', async () => {
  const res = await api(`/api/orders?branch=${branch}&limit=5`);
  assert(res.body.orders.length === 5, `limit ignored: ${res.body.orders.length} rows`);
  assert(res.body.pagination.total >= 5, 'no total reported');
  const greedy = await api(`/api/orders?branch=${branch}&limit=100000`);
  assert(greedy.body.orders.length <= 200, 'no hard ceiling on page size');
  return `limit honoured, ceiling ${greedy.body.orders.length}`;
});

// ── summary ──────────────────────────────────────────────────────────────────

const failed = results.filter(r => !r.ok);
console.log(`\n${'═'.repeat(64)}`);
console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`\n  FAILURES:`);
  for (const f of failed) console.log(`    [${f.section}] ${f.name}: ${f.detail}`);
}
console.log(`${'═'.repeat(64)}\n`);
process.exit(failed.length ? 1 : 0);
