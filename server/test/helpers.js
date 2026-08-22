import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import operations from '../src/routes/operations.js';
import exportsRouter from '../src/routes/exports.js';
import rbacRouter from '../src/routes/rbac.js';
import supplierCatalog from '../src/routes/supplierCatalog.js';
import ingredientsRouter from '../src/routes/ingredients.js';
import recipesRouter from '../src/routes/recipes.js';
import customersRouter from '../src/routes/customers.js';
import deliveriesRouter from '../src/routes/deliveries.js';
import authRouter from '../src/routes/auth.js';
import accountsRouter from '../src/routes/accounts.js';
import {attachRealtime, closeRealtime} from '../src/services/realtime.js';
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
    } catch {}
  }
  if (!server) {
    const app = express();
    app.use(express.json());
    // Mounted so login is exercised by tests, exactly as production does it.
    app.use('/api', authRouter);
    app.use('/api', accountsRouter);
    app.use('/api', customersRouter);
    app.use('/api', deliveriesRouter);
    app.use('/api', rbacRouter);
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

export async function request(path, {method = 'GET', token, body, headers = {}} = {}) {
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
  return {status: res.status, body: data};
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
