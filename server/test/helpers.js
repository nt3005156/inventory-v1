import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import operations from '../src/routes/operations.js';
import exportsRouter from '../src/routes/exports.js';
import rbacRouter from '../src/routes/rbac.js';
import auditRouter from '../src/routes/audit.js';
import notificationsRouter from '../src/routes/notifications.js';
import onboardingRouter from '../src/routes/onboarding.js';
import tenantsRouter from '../src/routes/tenants.js';
import platformRouter from '../src/routes/platform.js';
import subscriptionsRouter from '../src/routes/subscriptions.js';
import brandingRouter from '../src/routes/branding.js';
import supplierCatalog from '../src/routes/supplierCatalog.js';
import ingredientsRouter from '../src/routes/ingredients.js';
import recipesRouter from '../src/routes/recipes.js';
import customersRouter from '../src/routes/customers.js';
import deliveriesRouter from '../src/routes/deliveries.js';
import authRouter from '../src/routes/auth.js';
import accountsRouter from '../src/routes/accounts.js';
import {attachRealtime, closeRealtime} from '../src/services/realtime.js';
import {securityHeaders} from '../src/middleware/securityHeaders.js';
import {User} from '../src/models/index.js';
import {Restaurant, Branch, InventoryBalance, RestaurantTable, Order} from '../src/models/operations.js';
import {Ingredient, MenuItem} from '../src/models/index.js';
import {moveStock} from '../src/services/inventoryLedger.js';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'kds-core-test-secret';

let replset;
let server;
let baseUrl;

export function tokenFor(user, extras = {}) {
  return jwt.sign(
    {
      id: user._id, name: user.name, role: user.role,
      restaurantId: user.restaurantId || null, branch: user.branch || null,
      // Phase 17: mirror production's session-version claim so tests exercise
      // the same revocation path the real signToken() produces.
      sv: Number(user.sessionVersion || 0),
      ...extras
    },
    process.env.JWT_SECRET,
    {expiresIn: '2h'}
  );
}

export async function startTestApp() {
  if (!replset) {
    replset = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: 'wiredTiger'}});
    await mongoose.connect(replset.getUri());
    // Ensure branch transfer indexes exist for idempotency guarantees
    try {
      const {ensureStockTransferIndexes} = await import('../src/services/stockTransferMigration.js');
      await ensureStockTransferIndexes();
      // Per-device sessions need the unique sessionHash index in tests too.
      const {ensureSessionIndexes} = await import('../src/services/sessionMigration.js');
      await ensureSessionIndexes();
      // Audit chain hook must be installed before any row is written.
      const {ensureAuditIndexes} = await import('../src/services/auditMigration.js');
      await ensureAuditIndexes();
    } catch {}
  }
  if (!server) {
    const app = express();
    // Phase 25: the harness installs the SAME security-header middleware as
    // production. Headers that only exist in index.js are headers no test can
    // assert -- which is how the unscoped crud() block in index.js went
    // unnoticed for so long.
    app.use(securityHeaders());
    app.use(express.json({limit: '256kb'}));
    // Mounted so login is exercised by tests, exactly as production does it.
    app.use('/api', authRouter);
    app.use('/api', accountsRouter);
    app.use('/api', customersRouter);
    app.use('/api', deliveriesRouter);
    app.use('/api', tenantsRouter);
    app.use('/api', platformRouter);
    app.use('/api', subscriptionsRouter);
    app.use('/api', brandingRouter);
    app.use('/api', onboardingRouter);
    app.use('/api', rbacRouter);
    app.use('/api', auditRouter);
    app.use('/api', notificationsRouter);
    app.use('/api', exportsRouter);
    app.use('/api', operations);
    app.use('/api', supplierCatalog);
    app.use('/api', ingredientsRouter);
    app.use('/api', recipesRouter);
    app.use((err, req, res, next) => res.status(err.status || 500).json({message: err.message || 'Server error'}));
    server = http.createServer(app);
    attachRealtime(server);
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const {port} = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  }
  return {baseUrl};
}

export async function stopTestApp() {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replset) {
    await replset.stop();
    replset = null;
  }
}

export async function clearDb() {
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) await collection.deleteMany({});
}

export async function request(path, {method = 'GET', token, body, headers = {}, raw = false} = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  // `raw` exposes the response headers, which the Phase 25 header assertions
  // need. The default shape is unchanged so no existing caller is affected.
  return raw
    ? {status: res.status, body: data, headers: res.headers}
    : {status: res.status, body: data};
}

export async function seedWorld() {
  const restaurant = await Restaurant.create({name: 'Mittho Test', currency: 'NPR', vatRate: 13});
  const branchA = await Branch.create({restaurant: restaurant._id, name: 'Kathmandu Branch', code: 'KTM', address: 'Kalanki'});
  const branchB = await Branch.create({restaurant: restaurant._id, name: 'Lalitpur Branch', code: 'LTP', address: 'Patan'});
  const owner = await User.create({name: 'Owner', email: 'owner@test.com', password: 'hashed', role: 'owner', restaurant: 'Mittho Test', restaurantId: restaurant._id});
  const manager = await User.create({name: 'Manager', email: 'manager@test.com', password: 'hashed', role: 'manager', restaurant: 'Mittho Test', restaurantId: restaurant._id, branch: branchA._id});
  const staffA = await User.create({name: 'Staff A', email: 'staffa@test.com', password: 'hashed', role: 'staff', restaurant: 'Mittho Test', restaurantId: restaurant._id, branch: branchA._id});
  const staffB = await User.create({name: 'Staff B', email: 'staffb@test.com', password: 'hashed', role: 'staff', restaurant: 'Mittho Test', restaurantId: restaurant._id, branch: branchB._id});
  const ingredient = await Ingredient.create({restaurant: restaurant._id, code: 'ING-T1', name: 'Basmati Rice', unit: 'g', minimumStock: 2000});
  const menu = await MenuItem.create({
    // Phase 25: the fixture used to omit `restaurant`, which only worked
    // because recipes.js widened every lookup to also match unowned rows --
    // a cross-tenant shared pool. Production has always set it (createMenuItem
    // writes `restaurant: restaurantId`), so the fixture was the outlier.
    restaurant: restaurant._id,
    name: 'Chicken Biryani',
    price: 350,
    vatInclusive: false,
    recipe: [{ingredient: ingredient._id, qty: 250, unit: 'g'}]
  });
  const openingSession=await mongoose.startSession();
  try{
    await openingSession.withTransaction(async()=>{
      for(const branch of [branchA,branchB]){
        await moveStock({
          branch:branch._id,
          ingredient:ingredient._id,
          qty:20000,
          unit:'g',
          unitCost:0.045,
          type:'OPENING',
          reason:'Test opening stock',
          referenceType:'test_fixture',
          referenceId:ingredient._id,
          user:owner._id,
          idempotencyKey:`test-opening:${branch._id}:${ingredient._id}`
        },openingSession);
        await InventoryBalance.updateOne(
          {branch:branch._id,ingredient:ingredient._id},
          {$set:{reorderLevel:4000}},
          {session:openingSession}
        );
      }
    });
  }finally{
    await openingSession.endSession();
  }
  const table = await RestaurantTable.create({branch: branchA._id, name: 'T1', area: 'Main Hall', seats: 4});
  const tableB = await RestaurantTable.create({branch: branchB._id, name: 'L1', area: 'Patio', seats: 4});
  return {restaurant, branchA, branchB, owner, manager, staffA, staffB, ingredient, menu, table, tableB};
}

export function makeOrder(world, overrides = {}) {
  return Order.create({
    orderNo: 'ORD-' + Math.random().toString(36).slice(2, 9).toUpperCase(),
    // P1B: fixtures carry the tenant, exactly as production writes do. A
    // fixture that omits it would let a tenant-scoped query pass by accident.
    restaurant: world.restaurant._id,
    branch: world.branchA._id,
    table: world.table._id,
    type: 'dine-in',
    status: 'pending',
    items: [{menuItem: world.menu._id, name: world.menu.name, qty: 1, unitPrice: 350, foodCost: 11.25, notes: 'less spicy'}],
    subtotal: 350,
    vatRate: 13,
    vat: 45.5,
    total: 395.5,
    dueAmount: 395.5,
    inventoryDeducted: true,
    inventoryReversed: false,
    createdBy: world.owner._id,
    ...overrides
  });
}
