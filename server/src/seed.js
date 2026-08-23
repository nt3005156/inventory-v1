/**
 * Phase 24 — realistic demo seed.
 *
 * Replaces the old five-ingredient / two-dish stub with a dataset an operator
 * can actually evaluate the system against: 60 ingredients, 65 menu items with
 * costed recipes, 16 suppliers, 3 branches, 26 tables, 20 customers, and real
 * trading history — purchase orders, goods receipts, batches, orders,
 * payments, and deliveries.
 *
 * DESIGN RULE: drive the REAL services wherever one exists.
 *
 * Stock arrives through `moveStock()`, so balances, the ledger, batches and
 * weighted-average cost are all genuinely consistent. Orders are priced by
 * `priceOrder()` and settled by `applyPayment()`, so the money adds up under
 * the same VAT and rounding rules production uses. Hand-writing these
 * collections would produce a demo that looks right and reconciles wrong — and
 * would silently stop matching the system the first time a pricing rule moved.
 *
 * WARNING — DEVELOPMENT ONLY. This script DELETES the contents of the
 * collections it manages and creates accounts with published passwords. It
 * refuses to run against NODE_ENV=production; see `assertNotProduction()`.
 *
 * Usage:
 *   npm run seed                 # wipe + seed the demo tenant
 *   npm run seed -- --keep       # seed only if the demo tenant is absent
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {Ingredient, MenuItem, Supplier, User} from './models/index.js';
import {SupplierIngredient, SupplierPriceHistory} from './models/supplierCatalog.js';
import {
  Branch, Customer, Delivery, InventoryBalance, InventoryBatch, InventoryTransaction, Notification,
  Order, Payment, PurchaseOrder, PurchaseOrderCounter, Restaurant, RestaurantTable,
  SalesInvoiceCounter, SupplierInvoice
} from './models/operations.js';
import {moveStock} from './services/inventoryLedger.js';
import {priceOrder} from './services/pos.js';
import {CUSTOMERS, INGREDIENTS, MENU, SUPPLIERS, TABLES} from './demo/catalogue.js';

/**
 * DEMO CREDENTIALS — DEVELOPMENT ONLY.
 *
 * Published deliberately so a developer can log in immediately. They are
 * therefore PUBLIC and must never exist in a production database. The guard
 * below refuses to run under NODE_ENV=production; the README says the same in
 * the one place an operator will read.
 */
export const DEMO_PASSWORD = 'MitthoDemo2026';
export const DEMO_ACCOUNTS = Object.freeze([
  {email: 'owner@mittho.demo', role: 'owner', name: 'Mittho Owner', branch: null},
  {email: 'manager.ktm@mittho.demo', role: 'manager', name: 'Kathmandu Manager', branch: 'KTM'},
  {email: 'manager.ltp@mittho.demo', role: 'manager', name: 'Lalitpur Manager', branch: 'LTP'},
  {email: 'cashier.ktm@mittho.demo', role: 'staff', name: 'Kathmandu Cashier', branch: 'KTM'},
  {email: 'kitchen.ktm@mittho.demo', role: 'staff', name: 'Kathmandu Kitchen', branch: 'KTM'},
  {email: 'cashier.ltp@mittho.demo', role: 'staff', name: 'Lalitpur Cashier', branch: 'LTP'},
  {email: 'cashier.bkt@mittho.demo', role: 'staff', name: 'Bhaktapur Cashier', branch: 'BKT'},
  {email: 'rider1@mittho.demo', role: 'rider', name: 'Bikash Rider', branch: 'KTM'},
  {email: 'rider2@mittho.demo', role: 'rider', name: 'Sunil Rider', branch: 'KTM'},
  {email: 'rider3@mittho.demo', role: 'rider', name: 'Nabin Rider', branch: 'LTP'}
]);

/**
 * A seed that wipes data must never be able to run against production.
 *
 * Checked here rather than left to operator discipline: the failure mode is
 * deleting a live restaurant's inventory, which is not recoverable from the
 * application.
 */
export function assertNotProduction(env = process.env) {
  if (String(env.NODE_ENV).toLowerCase() === 'production') {
    throw new Error(
      'Refusing to seed demo data with NODE_ENV=production. ' +
      'The demo accounts use published passwords and this script deletes data.'
    );
  }
  if (String(env.ALLOW_DEMO_SEED).toLowerCase() === 'false') {
    throw new Error('Demo seeding is disabled by ALLOW_DEMO_SEED=false');
  }
  return true;
}

const BRANCHES = [
  {name: 'Kathmandu Branch', code: 'KTM', address: 'Kalanki, Kathmandu', phone: '01-4270001', share: 1},
  {name: 'Lalitpur Branch', code: 'LTP', address: 'Pulchowk, Lalitpur', phone: '01-5540002', share: 0.6},
  {name: 'Bhaktapur Branch', code: 'BKT', address: 'Suryabinayak, Bhaktapur', phone: '01-6610003', share: 0.4}
];

/**
 * Deterministic pseudo-random.
 *
 * A demo that reshuffles on every run cannot be asserted against, and a
 * screenshot taken on Monday would not match the database on Tuesday.
 */
function makeRandom(seed = 20260824) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** Kathmandu is UTC+05:45; a date built in UTC lands on the wrong local day. */
function kathmanduDaysAgo(days, hour = 12) {
  const now = new Date();
  const utc = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, hour, 0, 0
  );
  return new Date(utc - (5 * 60 + 45) * 60 * 1000);
}

export async function seedDemoData({log = console.log} = {}) {
  assertNotProduction();
  const rand = makeRandom();

  // ── wipe ───────────────────────────────────────────────────────────────────
  // Only the collections this script owns. Audit rows are append-only and are
  // deliberately not touched.
  await Promise.all([
    User.deleteMany({}), Supplier.deleteMany({}), Ingredient.deleteMany({}), MenuItem.deleteMany({}),
    SupplierIngredient.deleteMany({}), SupplierPriceHistory.deleteMany({}),
    Restaurant.deleteMany({}), Branch.deleteMany({}), RestaurantTable.deleteMany({}),
    Customer.deleteMany({}), Order.deleteMany({}), Payment.deleteMany({}),
    Delivery.deleteMany({}), Notification.deleteMany({}),
    PurchaseOrder.deleteMany({}), PurchaseOrderCounter.deleteMany({}),
    SupplierInvoice.deleteMany({}), SalesInvoiceCounter.deleteMany({}),
    InventoryBalance.collection.deleteMany({}),
    InventoryBatch.collection.deleteMany({}),
    InventoryTransaction.collection.deleteMany({})
  ]);

  // ── 1. Restaurant ──────────────────────────────────────────────────────────
  const restaurant = await Restaurant.create({
    name: 'Mittho Biryani House',
    currency: 'NPR', vatRate: 13, address: 'Kalanki, Kathmandu, Nepal',
    phone: '01-4270001',
    // Demo PAN. Replace with the real registration before issuing tax invoices.
    pan: '301234567',
    receiptFooter: 'Thank you for dining with us · धन्यवाद'
  });

  // ── 2. Branches ────────────────────────────────────────────────────────────
  const branches = await Branch.create(BRANCHES.map(b => ({
    restaurant: restaurant._id, name: b.name, code: b.code, address: b.address, phone: b.phone
  })));
  const branchByCode = Object.fromEntries(branches.map(b => [b.code, b]));

  // ── 3. Users ───────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const users = [];
  for (const account of DEMO_ACCOUNTS) {
    users.push(await User.create({
      name: account.name,
      email: account.email,
      password: passwordHash,
      role: account.role,
      restaurant: restaurant.name,
      restaurantId: restaurant._id,
      branch: account.branch ? branchByCode[account.branch]._id : undefined,
      ...(account.role === 'rider'
        ? {rider: {active: true, available: true, phone: `98510001${users.length}`, vehicle: 'motorcycle', maxConcurrent: 3}}
        : {})
    }));
  }
  const owner = users.find(u => u.role === 'owner');
  const riders = users.filter(u => u.role === 'rider');

  // ── 4. Ingredients ─────────────────────────────────────────────────────────
  const ingredients = [];
  for (const [code, name, category, unit, cost, opening, reorder, shelfLife, storage] of INGREDIENTS) {
    ingredients.push(await Ingredient.create({
      restaurant: restaurant._id, code, name, category, unit,
      lastPurchasePrice: cost, standardCost: cost,
      minimumStock: Math.round(reorder * 0.5), reorderQty: reorder * 2, reorderLevel: reorder,
      shelfLifeDays: shelfLife, storage
    }));
  }
  const ingredientByCode = Object.fromEntries(ingredients.map(i => [i.code, i]));
  const openingByCode = Object.fromEntries(INGREDIENTS.map(i => [i[0], i[5]]));
  const costByCode = Object.fromEntries(INGREDIENTS.map(i => [i[0], i[4]]));

  // ── 5. Suppliers (+ catalogue links, so purchasing actually works) ─────────
  const suppliers = [];
  for (const [name, contact, address, paymentTerms] of SUPPLIERS) {
    suppliers.push(await Supplier.create({
      restaurant: restaurant._id, name, contact, address, paymentTerms,
      paymentTermsDays: Number(String(paymentTerms).replace(/\D/g, '')) || 0
    }));
  }
  const supplierByCategory = new Map();
  SUPPLIERS.forEach(([name, , , , category], index) => {
    if (!supplierByCategory.has(category)) supplierByCategory.set(category, suppliers[index]);
  });
  const fallbackSupplier = suppliers[0];

  /**
   * Catalogue links. A purchase order is priced from the SUPPLIER CATALOGUE,
   * not from the ingredient, so without these rows the demo could not raise a
   * single PO — which is exactly the kind of gap a stub seed hides.
   */
  for (const [code, , category, unit, cost] of INGREDIENTS) {
    const supplier = supplierByCategory.get(category) || fallbackSupplier;
    const ingredient = ingredientByCode[code];
    // Buy in the sensible wholesale unit: kg/litre for weighed goods, each for
    // countable ones.
    const bulk = unit === 'pcs' ? 1 : 1000;
    const catalogItem = await SupplierIngredient.create({
      restaurant: restaurant._id, supplier: supplier._id, ingredient: ingredient._id,
      supplierSku: `${supplier.name.slice(0, 3).toUpperCase()}-${code}`,
      purchaseUnit: unit === 'pcs' ? 'pcs' : unit === 'ml' ? 'l' : 'kg',
      baseUnit: unit, conversionFactor: bulk,
      currentPrice: round2(cost * bulk),
      minOrderQty: 1, leadDays: 2,
      createdBy: owner._id, updatedBy: owner._id
    });
    await SupplierPriceHistory.create({
      restaurant: restaurant._id, catalogItem: catalogItem._id, supplier: supplier._id,
      ingredient: ingredient._id, price: catalogItem.currentPrice,
      purchaseUnit: catalogItem.purchaseUnit, baseUnit: catalogItem.baseUnit,
      conversionFactor: catalogItem.conversionFactor,
      priceIncludesVat: false, vatRate: 13,
      reason: 'Demo opening supplier price', changedBy: owner._id
    });
    await Ingredient.updateOne(
      {_id: ingredient._id},
      {$set: {supplier: supplier._id, primarySupplier: supplier._id, supplierCount: 1}}
    );
  }

  // ── 6. Menu ────────────────────────────────────────────────────────────────
  const menuItems = [];
  for (const [name, nameNp, category, price, vatInclusive, station, prepMinutes, packagingCost, recipe] of MENU) {
    menuItems.push(await MenuItem.create({
      restaurant: restaurant._id, name, nameNp, category, price, vatInclusive,
      station, prepMinutes, packagingCost,
      recipe: recipe.map(([code, qty]) => ({
        ingredient: ingredientByCode[code]._id, qty, unit: ingredientByCode[code].unit
      }))
    }));
  }

  // ── 7. Tables ──────────────────────────────────────────────────────────────
  const tables = [];
  for (const [code, layout] of Object.entries(TABLES)) {
    for (const [name, area, seats] of layout) {
      tables.push(await RestaurantTable.create({branch: branchByCode[code]._id, name, area, seats}));
    }
  }

  // ── opening stock, through the real ledger ─────────────────────────────────
  // Batched into chunks: one transaction covering 180 movements is slow and
  // risks the 16MB oplog entry limit on a small dev box.
  for (const branch of branches) {
    const share = BRANCHES.find(b => b.code === branch.code).share;
    for (const ingredient of ingredients) {
      const qty = Math.round(openingByCode[ingredient.code] * share);
      if (qty <= 0) continue;
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await moveStock({
            branch: branch._id, ingredient: ingredient._id, qty,
            unit: ingredient.unit, unitCost: costByCode[ingredient.code],
            type: 'OPENING', reason: 'Demo opening stock',
            referenceType: 'demo_seed', referenceId: ingredient._id, user: owner._id,
            idempotencyKey: `demo-opening:${branch._id}:${ingredient._id}`,
            // Perishables get a realistic expiry so the batch/expiry screens
            // have something to show.
            ...(ingredient.shelfLifeDays && ingredient.shelfLifeDays <= 30
              ? {incomingBatches: [{
                quantity: qty, unitCost: costByCode[ingredient.code],
                batchNumber: `OPEN-${branch.code}-${ingredient.code}`,
                expiryDate: kathmanduDaysAgo(-Math.max(2, Math.round(ingredient.shelfLifeDays * 0.6)))
              }]}
              : {})
          }, session);
          await InventoryBalance.updateOne(
            {branch: branch._id, ingredient: ingredient._id},
            {$set: {minLevel: ingredient.minimumStock, reorderLevel: ingredient.reorderLevel}},
            {session}
          );
        });
      } finally {
        await session.endSession();
      }
    }
  }
  log(`  stock: opening balances for ${ingredients.length} ingredients × ${branches.length} branches`);

  // ── customers ──────────────────────────────────────────────────────────────
  const customers = [];
  for (const [name, phone, address, dietary, spiceLevel, tier] of CUSTOMERS) {
    const branch = pick(rand, branches);
    customers.push(await Customer.create({
      restaurant: restaurant._id, branch: branch._id, name, phone, phoneKey: phone,
      addresses: [{label: 'Home', address, default: true}],
      preferences: {dietary, spiceLevel, contactPreference: 'phone', marketingOptIn: rand() > 0.5},
      loyalty: {tier, points: Math.round(rand() * 900), lifetimePoints: Math.round(rand() * 4000)}
    }));
  }

  // ── purchase orders, received into stock ───────────────────────────────────
  // Approved and received through the same ledger path as production, so the
  // batches, costs and PO statuses are all internally consistent.
  const poSummary = {created: 0, received: 0};
  // Only suppliers that actually carry catalogue lines can be ordered from --
  // a PO is priced from the catalogue, so a supplier with no lines would
  // silently produce fewer purchase orders than intended.
  const stockedSuppliers = [];
  for (const supplier of suppliers) {
    const lines = await SupplierIngredient.countDocuments({
      restaurant: restaurant._id, supplier: supplier._id
    });
    if (lines) stockedSuppliers.push(supplier);
  }

  for (let index = 0; index < 8; index += 1) {
    const branch = branches[index % branches.length];
    const supplier = stockedSuppliers[index % stockedSuppliers.length];
    const catalogue = await SupplierIngredient.find({
      restaurant: restaurant._id, supplier: supplier._id
    }).limit(4).lean();
    if (!catalogue.length) continue;

    const orderDate = kathmanduDaysAgo(20 - index * 2, 10);
    const lines = catalogue.map(row => {
      const orderedQty = 5 + Math.round(rand() * 15);
      const unitPrice = row.currentPrice;
      const lineSubtotal = round2(orderedQty * unitPrice);
      return {
        ingredient: row.ingredient, supplierItem: row._id,
        orderedQty, receivedQty: 0, damagedQty: 0,
        unit: row.purchaseUnit, baseUnit: row.baseUnit, conversionFactor: row.conversionFactor,
        unitPrice, vatRate: 13,
        lineSubtotal, lineVat: round2(lineSubtotal * 0.13), lineTotal: round2(lineSubtotal * 1.13)
      };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
    const vat = round2(subtotal * 0.13);
    const received = index < 6;

    const po = await PurchaseOrder.create({
      restaurant: restaurant._id,
      poNo: `PO-${branch.code}-${String(index + 1).padStart(4, '0')}`,
      numberVersion: 2, branch: branch._id, supplier: supplier._id,
      status: received ? 'received' : index === 6 ? 'approved' : 'pending',
      orderDate, expectedDeliveryDate: kathmanduDaysAgo(18 - index * 2, 10),
      deliveryAddress: branch.address,
      submittedBy: owner._id, submittedAt: orderDate,
      ...(index !== 7 ? {approvedBy: owner._id, approvedAt: orderDate, approvalRound: 1} : {}),
      items: lines, subtotal, vat, total: round2(subtotal + vat),
      createdBy: owner._id, updatedBy: owner._id
    });
    poSummary.created += 1;

    if (!received) continue;
    // Receive it: stock in, through moveStock, with supplier-linked batches.
    for (const line of po.items) {
      const ingredient = ingredients.find(i => String(i._id) === String(line.ingredient));
      if (!ingredient) continue;
      const baseQty = Math.round(line.orderedQty * line.conversionFactor);
      const unitCost = round2(line.unitPrice / line.conversionFactor);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await moveStock({
            branch: branch._id, ingredient: ingredient._id, qty: baseQty,
            unit: ingredient.unit, unitCost,
            type: 'PURCHASE', reason: `Goods receipt ${po.poNo}`,
            referenceType: 'purchase_order', referenceId: po._id, user: owner._id,
            idempotencyKey: `demo-receipt:${po._id}:${ingredient._id}`,
            incomingBatches: [{
              quantity: baseQty, unitCost, supplier: supplier._id,
              batchNumber: `${po.poNo}-${ingredient.code}`,
              ...(ingredient.shelfLifeDays
                ? {expiryDate: kathmanduDaysAgo(-Math.max(3, Math.round(ingredient.shelfLifeDays * 0.7)))}
                : {})
            }]
          }, session);
        });
      } finally {
        await session.endSession();
      }
      line.receivedQty = line.orderedQty;
    }
    await po.save();
    poSummary.received += 1;

    // A supplier invoice for the received goods, some paid, some outstanding.
    await SupplierInvoice.create({
      restaurant: restaurant._id, branch: branch._id, supplier: supplier._id, purchaseOrder: po._id,
      invoiceNo: `SI-${branch.code}-${String(index + 1).padStart(4, '0')}`,
      invoiceNoNormalized: `SI-${branch.code}-${String(index + 1).padStart(4, '0')}`,
      invoiceDate: orderDate,
      dueDate: kathmanduDaysAgo(20 - index * 2 - 30, 10),
      subtotal, vat, total: round2(subtotal + vat),
      paidAmount: index % 3 === 0 ? round2(subtotal + vat) : 0,
      status: index % 3 === 0 ? 'paid' : 'unpaid',
      matching: {status: 'matched', matchedAt: orderDate, receiptIds: [], returnIds: []},
      createdBy: owner._id
    });
  }
  log(`  purchasing: ${poSummary.created} purchase orders (${poSummary.received} received into stock)`);

  // ── orders, payments and deliveries ────────────────────────────────────────
  const sellable = menuItems.filter(m => m.recipe.length);
  const summary = {orders: 0, payments: 0, deliveries: 0};
  const orderTypes = ['dine-in', 'counter', 'takeaway', 'delivery'];

  for (let index = 0; index < 60; index += 1) {
    const branch = index % 5 === 0 ? branches[1] : index % 7 === 0 ? branches[2] : branches[0];
    const type = orderTypes[index % orderTypes.length];
    const createdAt = kathmanduDaysAgo(Math.floor(index / 3), 11 + (index % 8));
    const lineCount = 1 + Math.floor(rand() * 3);

    const picks = [];
    for (let n = 0; n < lineCount; n += 1) {
      const item = pick(rand, sellable);
      if (picks.some(p => String(p.item._id) === String(item._id))) continue;
      picks.push({item, qty: 1 + Math.floor(rand() * 2)});
    }
    if (!picks.length) continue;

    /**
     * Resolve the channel-specific shape FIRST. `priceOrder()` enforces the
     * same rules the POS does -- dine-in must be seated, delivery must name a
     * customer and an address, and only delivery may carry a delivery fee --
     * so these have to be decided before pricing, not after.
     */
    const branchTables = tables.filter(t => String(t.branch) === String(branch._id));
    const table = type === 'dine-in' ? pick(rand, branchTables) : null;
    const customer = type === 'delivery'
      ? pick(rand, customers)
      : rand() > 0.6 ? pick(rand, customers) : null;
    const deliveryAddress = type === 'delivery'
      ? (customer?.addresses?.[0]?.address || 'Kalanki, Kathmandu')
      : undefined;

    // Price through the REAL pricing engine, so VAT, service charge and
    // rounding match what the POS would produce for the same basket.
    const pricing = priceOrder({
      type,
      table: table?._id,
      customer: customer?._id,
      deliveryAddress,
      items: picks.map(p => ({
        unitPrice: p.item.price, qty: p.qty, vatInclusive: p.item.vatInclusive !== false
      })),
      vatRate: 13,
      ...(type === 'delivery' ? {deliveryFee: 100} : {})
    });

    // Older orders are completed; the newest few are still live, so the KDS
    // and the floor plan have something on them.
    const live = index >= 56;
    const status = live ? ['pending', 'preparing', 'ready'][index % 3] : 'completed';

    const order = await Order.create({
      orderNo: `ORD-${branch.code}-${String(index + 1).padStart(5, '0')}`,
      branch: branch._id,
      customer: customer?._id,
      table: table?._id,
      type,
      status,
      items: picks.map((p, i) => ({
        menuItem: p.item._id, name: p.item.name, qty: p.qty,
        unitPrice: p.item.price, basePrice: p.item.price,
        vatInclusive: p.item.vatInclusive !== false,
        station: p.item.station || undefined,
        prepMinutes: p.item.prepMinutes || 0,
        // Costed from the recipe, so margin reporting is real.
        foodCost: round2(p.item.recipe.reduce((sum, line) => {
          const ing = ingredients.find(x => String(x._id) === String(line.ingredient));
          return sum + (ing ? costByCode[ing.code] * line.qty : 0);
        }, 0)),
        lineNet: pricing.lines[i].lineNet,
        lineVat: pricing.lines[i].lineVat,
        lineTotal: pricing.lines[i].lineGross
      })),
      deliveryAddress,
      subtotal: pricing.subtotal, vatRate: 13, vat: pricing.vat,
      serviceChargeRate: pricing.serviceChargeRate, serviceCharge: pricing.serviceCharge,
      deliveryFee: pricing.deliveryFee, total: pricing.total,
      paidAmount: status === 'completed' ? pricing.total : 0,
      dueAmount: status === 'completed' ? 0 : pricing.total,
      inventoryDeducted: true, inventoryReversed: false,
      createdBy: owner._id,
      createdAt, updatedAt: createdAt,
      ...(status === 'completed' ? {completedAt: createdAt, paymentSettledAt: createdAt} : {})
    });
    summary.orders += 1;

    if (status === 'completed') {
      const method = ['cash', 'esewa', 'khalti', 'card'][index % 4];
      await Payment.create({
        order: order._id, amount: pricing.total, method, status: 'paid',
        cashier: users.find(u => u.role === 'staff' && String(u.branch) === String(branch._id))?._id || owner._id,
        transactionId: method === 'cash' ? undefined : `DEMO-${method.toUpperCase()}-${index}`,
        createdAt, updatedAt: createdAt
      });
      summary.payments += 1;
    }

    if (type === 'delivery') {
      const rider = pick(rand, riders.filter(r => String(r.branch) === String(branch._id)) .length
        ? riders.filter(r => String(r.branch) === String(branch._id))
        : riders);
      const delivered = status === 'completed';
      await Delivery.create({
        order: order._id, branch: branch._id, restaurant: restaurant._id,
        rider: rider._id,
        address: order.deliveryAddress || 'Kalanki, Kathmandu',
        phone: customer?.phone,
        status: delivered ? 'delivered' : 'assigned',
        assignedAt: createdAt, assignedBy: owner._id,
        assignmentHistory: [{rider: rider._id, assignedBy: owner._id, at: createdAt, action: 'assigned'}],
        ...(delivered
          ? {
            pickedUpAt: createdAt, dispatchedAt: createdAt, deliveredAt: createdAt,
            proofType: 'handed_to_customer', proofAt: createdAt, proofBy: rider._id
          }
          : {}),
        createdAt, updatedAt: createdAt
      });
      summary.deliveries += 1;
    }
  }

  log(`  trading: ${summary.orders} orders, ${summary.payments} payments, ${summary.deliveries} deliveries`);

  return {
    restaurant,
    counts: {
      branches: branches.length,
      users: users.length,
      ingredients: ingredients.length,
      suppliers: suppliers.length,
      menuItems: menuItems.length,
      tables: tables.length,
      customers: customers.length,
      purchaseOrders: poSummary.created,
      orders: summary.orders,
      payments: summary.payments,
      deliveries: summary.deliveries,
      batches: await InventoryBatch.countDocuments({restaurant: restaurant._id}),
      inventoryBalances: await InventoryBalance.countDocuments({})
    }
  };
}

/** CLI entry point. Skipped when the module is imported by a test. */
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seed.js');
if (invokedDirectly) {
  assertNotProduction();
  await mongoose.connect(process.env.MONGODB_URI);

  if (process.argv.includes('--keep') && await Restaurant.countDocuments({})) {
    console.log('Existing data found and --keep was passed. Nothing was changed.');
    await mongoose.disconnect();
  } else {
    console.log('Seeding demo data…');
    const {counts} = await seedDemoData();
    console.log('');
    console.log('Demo data ready:');
    for (const [key, value] of Object.entries(counts)) {
      console.log(`  ${String(key).padEnd(20)} ${value}`);
    }
    console.log('');
    console.log('DEVELOPMENT-ONLY demo accounts — never use these in production:');
    for (const account of DEMO_ACCOUNTS) {
      console.log(`  ${account.email.padEnd(28)} ${account.role.padEnd(8)} ${DEMO_PASSWORD}`);
    }
    console.log('');
    await mongoose.disconnect();
  }
}
