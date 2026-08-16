import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {User} from '../models/index.js';
import {
  Branch,
  SupplierInvoice,
  SupplierPayment,
  SupplierPaymentCounter
} from '../models/operations.js';

const PAYMENT_INDEXES = [
  {
    key: {restaurant: 1, paymentNo: 1},
    options: {unique: true, name: 'supplier_payment_restaurant_number'}
  },
  {
    key: {restaurant: 1, idempotencyKey: 1},
    options: {
      unique: true,
      name: 'supplier_payment_restaurant_idempotency',
      partialFilterExpression: {idempotencyKey: {$type: 'string'}}
    }
  },
  {
    key: {restaurant: 1, reversalIdempotencyKey: 1},
    options: {
      unique: true,
      name: 'supplier_payment_restaurant_reversal_idempotency',
      partialFilterExpression: {reversalIdempotencyKey: {$type: 'string'}}
    }
  },
  {
    key: {restaurant: 1, invoice: 1, status: 1, paidAt: 1},
    options: {name: 'supplier_payment_restaurant_invoice_status_date'}
  },
  {
    key: {restaurant: 1, branch: 1, status: 1, paidAt: -1},
    options: {name: 'supplier_payment_restaurant_branch_status_date'}
  },
  {
    key: {restaurant: 1, branch: 1, paidAt: -1},
    options: {name: 'supplier_payment_restaurant_branch_report_date'}
  },
  {
    key: {restaurant: 1, supplier: 1, status: 1, paidAt: -1},
    options: {name: 'supplier_payment_restaurant_supplier_status_date'}
  },
  {
    key: {restaurant: 1, supplier: 1, paidAt: 1, createdAt: 1, _id: 1},
    options: {name: 'supplier_payment_statement_scope_date'}
  },
  {
    key: {restaurant: 1, supplier: 1, branch: 1, paidAt: 1, createdAt: 1, _id: 1},
    options: {name: 'supplier_payment_statement_branch_date'}
  }
];
const COUNTER_INDEXES = [{
  key: {restaurant: 1, branchCode: 1, year: 1},
  options: {unique: true, name: 'supplier_payment_counter_scope'}
}];
const PAYMENT_METHODS = new Set(['cash', 'bank', 'esewa', 'khalti', 'card', 'legacy']);
const EPSILON = 0.011;

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const sameId = (left, right) => Boolean(left && right && String(left) === String(right));
const validDate = value => value instanceof Date && Number.isFinite(value.getTime());
const objectId = value => value instanceof mongoose.Types.ObjectId;
const validReferenceIds = values => [...new Set(values
  .map(value => String(value || ''))
  .filter(value => mongoose.isValidObjectId(value)))];

function branchCode(branch) {
  return String(branch?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch?._id || '').slice(-4).toUpperCase();
}

function localYear(date) {
  return Number(new Date(date.getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 4));
}

function legacyPaymentHash(_row, set) {
  return crypto.createHash('sha256').update(JSON.stringify({
    invoice: String(set.invoice),
    amount: set.amount,
    method: set.method,
    reference: String(set.reference || ''),
    paidAt: new Date(set.paidAt).toISOString()
  })).digest('hex');
}

function legacyReversalHash(row, reason) {
  return crypto.createHash('sha256').update(JSON.stringify({
    payment: String(row._id),
    reason: String(reason || '').trim()
  })).digest('hex');
}

function syntheticPaymentId(invoiceId) {
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(`supplier-payment:legacy-invoice-balance:${invoiceId}`).digest('hex').slice(0, 24)
  );
}

async function ensureCollection(name) {
  const db = mongoose.connection.db;
  if (!db) return;
  const exists = await db.listCollections({name}, {nameOnly: true}).hasNext();
  if (exists) return;
  try {
    await db.createCollection(name);
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error;
  }
}

function expectedInvoiceStatus(invoice, paidAmount) {
  if (invoice.status === 'void') return 'void';
  if (paidAmount <= EPSILON) return 'unpaid';
  if (paidAmount + EPSILON >= Number(invoice.total || 0)) return 'paid';
  return 'partial';
}

function paymentNeedsMigration(row) {
  return !objectId(row.restaurant)
    || !objectId(row.branch)
    || !objectId(row.invoice)
    || !objectId(row.supplier)
    || !objectId(row.createdBy)
    || typeof row.paymentNo !== 'string'
    || !row.paymentNo.trim()
    || row.numberVersion !== 2
    || row.currency !== 'NPR'
    || !['recorded', 'legacy_record', 'legacy_invoice_balance'].includes(row.origin)
    || !['posted', 'reversed'].includes(row.status)
    || !validDate(row.paidAt)
    || row.requestHashVersion !== 2;
}

async function preparePaymentMigration() {
  const [payments, invoices] = await Promise.all([
    SupplierPayment.collection.find({}).sort({paidAt: 1, createdAt: 1, _id: 1}).toArray(),
    SupplierInvoice.collection.find({}).project({
      restaurant: 1,
      branch: 1,
      supplier: 1,
      invoiceNo: 1,
      invoiceDate: 1,
      total: 1,
      paidAmount: 1,
      status: 1,
      createdBy: 1,
      updatedBy: 1,
      createdAt: 1
    }).toArray()
  ]);
  const invoiceById = new Map(invoices.map(invoice => [String(invoice._id), invoice]));
  const branches = await Branch.find({_id: {$in: validReferenceIds(invoices.map(invoice => invoice.branch))}})
    .select('_id restaurant code').lean();
  const branchById = new Map(branches.map(branch => [String(branch._id), branch]));
  const actorIds = validReferenceIds([
    ...payments.flatMap(payment => [payment.createdBy, payment.reversedBy]),
    ...invoices.flatMap(invoice => [invoice.createdBy, invoice.updatedBy])
  ]);
  const actors = await User.find({_id: {$in: actorIds}}).select('_id restaurantId').lean();
  const actorById = new Map(actors.map(actor => [String(actor._id), actor]));
  const ownerByRestaurant = new Map();
  const unresolved = [];
  const prepared = [];
  const occupiedNumbers = new Map();
  const occupiedIdempotencyKeys = new Map();
  const occupiedReversalKeys = new Map();

  for (const row of payments) {
    const invoice = invoiceById.get(String(row.invoice));
    const branch = invoice ? branchById.get(String(invoice.branch)) : null;
    const amount = money(row.amount);
    const method = String(row.method || '').trim().toLowerCase();
    const status = row.status || 'posted';
    const paidAt = validDate(row.paidAt)
      ? row.paidAt
      : validDate(row.createdAt)
        ? row.createdAt
        : invoice && validDate(invoice.invoiceDate)
          ? invoice.invoiceDate
          : null;
    const reference = row.reference == null ? undefined : String(row.reference).trim();
    const existingCreatedBy = actorById.get(String(row.createdBy || ''));
    let createdBy = existingCreatedBy?._id;
    if (!createdBy && invoice) {
      createdBy = actorById.get(String(invoice.updatedBy || ''))?._id
        || actorById.get(String(invoice.createdBy || ''))?._id;
    }
    if (!createdBy && invoice?.restaurant) {
      const key = String(invoice.restaurant);
      if (!ownerByRestaurant.has(key)) {
        ownerByRestaurant.set(key, await User.findOne({restaurantId: invoice.restaurant, role: 'owner'}).select('_id').lean());
      }
      createdBy = ownerByRestaurant.get(key)?._id;
    }
    const reversedBy = row.reversedBy ? actorById.get(String(row.reversedBy))?._id : null;
    const reversalReason = row.reversalReason == null ? '' : String(row.reversalReason).trim();
    const hasIdempotencyKey = Object.prototype.hasOwnProperty.call(row, 'idempotencyKey');
    const hasReversalKey = Object.prototype.hasOwnProperty.call(row, 'reversalIdempotencyKey');
    const idempotencyKey = hasIdempotencyKey
      ? String(row.idempotencyKey || '').trim()
      : `migration:supplier-payment:legacy:${row._id}`;
    const reversalIdempotencyKey = hasReversalKey
      ? String(row.reversalIdempotencyKey || '').trim()
      : status === 'reversed' ? `migration:supplier-payment:reversal:${row._id}` : '';
    const origin = ['recorded', 'legacy_record', 'legacy_invoice_balance'].includes(row.origin)
      ? row.origin
      : 'legacy_record';
    const migrationSource = row.migrationSource
      ? String(row.migrationSource).trim().slice(0, 200)
      : origin === 'recorded' ? undefined : 'Legacy SupplierPayment record';
    let malformed = !invoice
      || !branch
      || !objectId(invoice.restaurant)
      || !sameId(branch.restaurant, invoice.restaurant)
      || (row.restaurant && !sameId(row.restaurant, invoice.restaurant))
      || (row.branch && !sameId(row.branch, invoice.branch))
      || (row.supplier && !sameId(row.supplier, invoice.supplier))
      || !Number.isFinite(Number(row.amount))
      || !(amount > 0)
      || amount > 1_000_000_000
      || Math.abs(Number(row.amount) - amount) > 1e-9
      || !PAYMENT_METHODS.has(method)
      || !paidAt
      || (validDate(invoice.invoiceDate) && paidAt < invoice.invoiceDate)
      || !createdBy
      || (existingCreatedBy && !sameId(existingCreatedBy.restaurantId, invoice.restaurant))
      || (reference && reference.length > 200)
      || (origin !== 'recorded' && !migrationSource)
      || (origin === 'recorded' && method === 'legacy')
      || (origin === 'recorded' && !['cash', 'legacy'].includes(method) && (!reference || reference.length < 3))
      || !idempotencyKey
      || idempotencyKey.length > 120
      || (status === 'reversed' && (!reversalIdempotencyKey || reversalIdempotencyKey.length > 120))
      || (status === 'posted' && hasReversalKey)
      || !['posted', 'reversed'].includes(status)
      || (status === 'reversed' && (!validDate(row.reversedAt) || !reversedBy || reversalReason.length < 3 || reversalReason.length > 500))
      || (status === 'posted' && Boolean(row.reversedAt || row.reversedBy || reversalReason || hasReversalKey))
      || (reversedBy && !sameId(actorById.get(String(reversedBy))?.restaurantId, invoice.restaurant));
    if (!malformed && idempotencyKey) {
      const scope = `${invoice.restaurant}:${idempotencyKey}`;
      malformed = occupiedIdempotencyKeys.has(scope);
      occupiedIdempotencyKeys.set(scope, String(row._id));
    }
    if (!malformed && reversalIdempotencyKey) {
      const scope = `${invoice.restaurant}:${reversalIdempotencyKey}`;
      malformed = occupiedReversalKeys.has(scope);
      occupiedReversalKeys.set(scope, String(row._id));
    }
    if (malformed) {
      unresolved.push(String(row._id));
      continue;
    }
    const paymentNo = typeof row.paymentNo === 'string' ? row.paymentNo.trim().toUpperCase() : '';
    if (paymentNo.length > 80) {
      unresolved.push(String(row._id));
      continue;
    }
    if (paymentNo) {
      const key = String(invoice.restaurant);
      if (!occupiedNumbers.has(key)) occupiedNumbers.set(key, new Map());
      const existing = occupiedNumbers.get(key).get(paymentNo);
      if (existing && existing !== String(row._id)) {
        unresolved.push(String(row._id));
        continue;
      }
      occupiedNumbers.get(key).set(paymentNo, String(row._id));
    }
    const set = {
      restaurant: invoice.restaurant,
      branch: invoice.branch,
      invoice: invoice._id,
      supplier: invoice.supplier,
      paymentNo,
      numberVersion: 2,
      amount,
      currency: 'NPR',
      method,
      origin,
      paidAt,
      status,
      requestHashVersion: 2,
      createdBy
    };
    if (reference) set.reference = reference;
    if (migrationSource) set.migrationSource = migrationSource;
    set.idempotencyKey = idempotencyKey;
    const hasCurrentRequestHash = row.requestHashVersion === 2
      && typeof row.requestHash === 'string'
      && /^[a-f0-9]{64}$/.test(row.requestHash);
    set.requestHash = hasCurrentRequestHash ? row.requestHash : legacyPaymentHash(row, set);
    if (status === 'reversed') {
      set.reversedAt = row.reversedAt;
      set.reversedBy = reversedBy;
      set.reversalReason = reversalReason;
      set.reversalIdempotencyKey = reversalIdempotencyKey;
      set.reversalRequestHash = legacyReversalHash(row, reversalReason);
    }
    const normalizedFieldsNeedMigration = row.paymentNo !== set.paymentNo
      || row.method !== set.method
      || row.origin !== set.origin
      || (row.migrationSource == null ? undefined : String(row.migrationSource)) !== set.migrationSource
      || (row.reference == null ? undefined : String(row.reference)) !== set.reference;
    const hashNeedsMigration = Boolean(idempotencyKey && row.requestHash !== set.requestHash)
      || Boolean(reversalIdempotencyKey && row.reversalRequestHash !== set.reversalRequestHash);
    prepared.push({
      row,
      invoice,
      branch,
      set,
      needsMigration: paymentNeedsMigration(row) || normalizedFieldsNeedMigration || hashNeedsMigration
    });
  }

  const preparedByInvoice = new Map();
  for (const item of prepared) {
    const key = String(item.invoice._id);
    if (!preparedByInvoice.has(key)) preparedByInvoice.set(key, []);
    preparedByInvoice.get(key).push(item);
  }
  let synthesized = 0;
  const invoiceUpdates = [];
  for (const invoice of invoices) {
    const rows = preparedByInvoice.get(String(invoice._id)) || [];
    const posted = money(rows
      .filter(item => item.set.status === 'posted')
      .reduce((sum, item) => sum + item.set.amount, 0));
    const aggregatePaid = money(invoice.paidAmount || 0);
    const total = money(invoice.total || 0);
    if (!Number.isFinite(Number(invoice.paidAmount)) || aggregatePaid < 0 || posted > total + EPSILON
      || (invoice.status === 'void' && (aggregatePaid > EPSILON || posted > EPSILON))) {
      unresolved.push(String(invoice._id));
      continue;
    }
    let reconciledPaid = posted;
    if (aggregatePaid > posted + EPSILON) {
      const delta = money(aggregatePaid - posted);
      const branch = branchById.get(String(invoice.branch));
      const createdBy = actorById.get(String(invoice.updatedBy || ''))?._id
        || actorById.get(String(invoice.createdBy || ''))?._id;
      const syntheticId = syntheticPaymentId(invoice._id);
      const collision = payments.find(payment => sameId(payment._id, syntheticId) && !sameId(payment.invoice, invoice._id));
      if (!branch || !createdBy || collision || aggregatePaid > total + EPSILON) {
        unresolved.push(String(invoice._id));
        continue;
      }
      const paidAt = validDate(invoice.invoiceDate)
        ? invoice.invoiceDate
        : validDate(invoice.createdAt) ? invoice.createdAt : new Date(0);
      const key = `migration:supplier-payment:invoice-balance:${invoice._id}`;
      const synthetic = {
        _id: syntheticId,
        restaurant: invoice.restaurant,
        branch: invoice.branch,
        invoice: invoice._id,
        supplier: invoice.supplier,
        paymentNo: '',
        numberVersion: 2,
        amount: delta,
        currency: 'NPR',
        method: 'legacy',
        reference: `Migrated aggregate payment for invoice ${String(invoice.invoiceNo || invoice._id)}`.slice(0, 200),
        origin: 'legacy_invoice_balance',
        migrationSource: 'SupplierInvoice.paidAmount',
        paidAt,
        status: 'posted',
        idempotencyKey: key,
        requestHashVersion: 2,
        createdBy,
        createdAt: validDate(invoice.createdAt) ? invoice.createdAt : paidAt,
        updatedAt: new Date()
      };
      synthetic.requestHash = legacyPaymentHash(synthetic, synthetic);
      const item = {row: synthetic, invoice, branch, set: synthetic, synthetic: true, needsMigration: true};
      prepared.push(item);
      rows.push(item);
      if (!preparedByInvoice.has(String(invoice._id))) preparedByInvoice.set(String(invoice._id), rows);
      reconciledPaid = aggregatePaid;
      synthesized += 1;
    }
    if (posted > aggregatePaid + EPSILON) reconciledPaid = posted;
    const status = expectedInvoiceStatus(invoice, reconciledPaid);
    if (Math.abs(reconciledPaid - aggregatePaid) > EPSILON || status !== invoice.status) {
      invoiceUpdates.push({invoice, paidAmount: reconciledPaid, status});
    }
  }

  if (unresolved.length) {
    throw new Error(`Supplier payment migration cannot safely migrate ownership or financial data for: ${[...new Set(unresolved)].join(', ')}`);
  }

  const sequenceByScope = new Map();
  for (const item of prepared) {
    const code = branchCode(item.branch);
    const year = localYear(item.set.paidAt);
    const scope = `${item.invoice.restaurant}:${code}:${year}`;
    const expression = new RegExp(`^PAY-${code}-${year}-(\\d+)$`);
    const match = item.set.paymentNo.match(expression);
    if (match) sequenceByScope.set(scope, Math.max(sequenceByScope.get(scope) || 0, Number(match[1])));
  }
  prepared.sort((left, right) => left.set.paidAt - right.set.paidAt || String(left.row._id).localeCompare(String(right.row._id)));
  for (const item of prepared) {
    if (item.set.paymentNo) continue;
    const code = branchCode(item.branch);
    const year = localYear(item.set.paidAt);
    const scope = `${item.invoice.restaurant}:${code}:${year}`;
    const restaurantNumbers = occupiedNumbers.get(String(item.invoice.restaurant)) || new Map();
    occupiedNumbers.set(String(item.invoice.restaurant), restaurantNumbers);
    let value = sequenceByScope.get(scope) || 0;
    let paymentNo;
    do {
      value += 1;
      paymentNo = `PAY-${code}-${year}-${String(value).padStart(6, '0')}`;
    } while (restaurantNumbers.has(paymentNo));
    sequenceByScope.set(scope, value);
    restaurantNumbers.set(paymentNo, String(item.row._id));
    item.set.paymentNo = paymentNo;
    item.needsMigration = true;
  }
  return {prepared, invoiceUpdates, synthesized, sequenceByScope};
}

async function applyPaymentMigration({prepared, invoiceUpdates}, session) {
  const paymentOperations = prepared
    .filter(item => item.needsMigration || item.synthetic)
    .map(item => {
      const set = {...item.set};
      delete set._id;
      delete set.createdAt;
      delete set.updatedAt;
      const update = {$set: set};
      if (item.synthetic) {
        update.$setOnInsert = {
          createdAt: item.set.createdAt,
          updatedAt: item.set.updatedAt
        };
      }
      return {
        updateOne: {
          filter: {_id: item.row._id},
          update,
          upsert: Boolean(item.synthetic)
        }
      };
    });
  if (paymentOperations.length) {
    await SupplierPayment.collection.bulkWrite(paymentOperations, {ordered: false, session});
  }
  const invoiceOperations = invoiceUpdates.map(item => ({
    updateOne: {
      filter: {_id: item.invoice._id},
      update: {
        $set: {paidAmount: item.paidAmount, status: item.status},
        $inc: {__v: 1}
      }
    }
  }));
  if (invoiceOperations.length) {
    await SupplierInvoice.collection.bulkWrite(invoiceOperations, {ordered: false, session});
  }
  return {migrated: paymentOperations.length, reconciledInvoices: invoiceOperations.length};
}

async function alignCounters(prepared) {
  const scopes = new Map();
  for (const item of prepared) {
    const code = branchCode(item.branch);
    const year = localYear(item.set.paidAt);
    const match = item.set.paymentNo.match(new RegExp(`^PAY-${code}-${year}-(\\d+)$`));
    if (!match) continue;
    const key = `${item.invoice.restaurant}:${code}:${year}`;
    const current = scopes.get(key);
    const value = Number(match[1]);
    if (!current || value > current.value) {
      scopes.set(key, {
        restaurant: item.invoice.restaurant,
        branch: item.invoice.branch,
        branchCode: code,
        year,
        value
      });
    }
  }
  if (!scopes.size) return 0;
  await SupplierPaymentCounter.bulkWrite([...scopes.values()].map(scope => ({
    updateOne: {
      filter: {restaurant: scope.restaurant, branchCode: scope.branchCode, year: scope.year},
      update: {
        $setOnInsert: {
          restaurant: scope.restaurant,
          branch: scope.branch,
          branchCode: scope.branchCode,
          year: scope.year
        },
        $max: {value: scope.value}
      },
      upsert: true
    }
  })), {ordered: false});
  return scopes.size;
}

async function validatePaymentReferences() {
  const rows = await SupplierPayment.collection.find({}).toArray();
  const invoices = await SupplierInvoice.find({_id: {$in: validReferenceIds(rows.map(row => row.invoice))}})
    .select('_id restaurant branch supplier invoiceDate total status').lean();
  const invoiceById = new Map(invoices.map(invoice => [String(invoice._id), invoice]));
  const actors = await User.find({_id: {$in: validReferenceIds(rows.flatMap(row => [row.createdBy, row.reversedBy]))}})
    .select('_id restaurantId').lean();
  const actorById = new Map(actors.map(actor => [String(actor._id), actor]));
  const unresolved = [];
  for (const row of rows) {
    const invoice = invoiceById.get(String(row.invoice));
    const actor = actorById.get(String(row.createdBy));
    const reversalActor = row.reversedBy ? actorById.get(String(row.reversedBy)) : null;
    const malformed = !invoice
      || !objectId(row.restaurant)
      || !objectId(row.branch)
      || !objectId(row.invoice)
      || !objectId(row.supplier)
      || !objectId(row.createdBy)
      || !sameId(row.restaurant, invoice.restaurant)
      || !sameId(row.branch, invoice.branch)
      || !sameId(row.supplier, invoice.supplier)
      || !actor
      || !sameId(actor.restaurantId, row.restaurant)
      || typeof row.paymentNo !== 'string'
      || !row.paymentNo.trim()
      || row.paymentNo.length > 80
      || !(Number(row.amount) > 0)
      || Number(row.amount) > 1_000_000_000
      || Math.abs(Number(row.amount) - money(row.amount)) > 1e-9
      || !PAYMENT_METHODS.has(row.method)
      || !['recorded', 'legacy_record', 'legacy_invoice_balance'].includes(row.origin)
      || (row.origin !== 'recorded' && !String(row.migrationSource || '').trim())
      || (row.origin === 'recorded' && row.method === 'legacy')
      || (row.origin === 'recorded' && !['cash', 'legacy'].includes(row.method) && String(row.reference || '').trim().length < 3)
      || row.currency !== 'NPR'
      || row.numberVersion !== 2
      || row.requestHashVersion !== 2
      || !validDate(row.paidAt)
      || (validDate(invoice?.invoiceDate) && row.paidAt < invoice.invoiceDate)
      || typeof row.idempotencyKey !== 'string'
      || !row.idempotencyKey.trim()
      || row.idempotencyKey.length > 120
      || typeof row.requestHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(row.requestHash)
      || !['posted', 'reversed'].includes(row.status)
      || (row.status === 'reversed' && (!validDate(row.reversedAt) || !reversalActor
        || !sameId(reversalActor.restaurantId, row.restaurant) || !String(row.reversalReason || '').trim()
        || typeof row.reversalIdempotencyKey !== 'string' || !row.reversalIdempotencyKey.trim()
        || row.reversalIdempotencyKey.length > 120
        || row.reversalRequestHash !== legacyReversalHash(row, row.reversalReason)))
      || (row.status === 'posted' && Boolean(row.reversedAt || row.reversedBy || row.reversalReason
        || row.reversalIdempotencyKey || row.reversalRequestHash));
    if (malformed) unresolved.push(String(row._id));
  }
  if (unresolved.length) {
    throw new Error(`Supplier payment migration cannot safely migrate ownership or financial data for: ${unresolved.join(', ')}`);
  }
}

async function repairIndexes(model, specifications, obsoleteNames) {
  const existing = await model.collection.indexes();
  const droppedIndexes = [];
  for (const index of existing) {
    const specification = specifications.find(item => item.options.name === index.name);
    const sameKeySpecification = specifications.find(item => JSON.stringify(item.key) === JSON.stringify(index.key));
    const obsolete = obsoleteNames.has(index.name)
      || Boolean(sameKeySpecification && sameKeySpecification.options.name !== index.name)
      || index.unique && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1
      || index.unique && index.key?.reversalIdempotencyKey === 1 && Object.keys(index.key).length === 1;
    const mismatched = specification && (
      JSON.stringify(index.key) !== JSON.stringify(specification.key)
      || Boolean(index.unique) !== Boolean(specification.options.unique)
      || JSON.stringify(index.partialFilterExpression || null)
        !== JSON.stringify(specification.options.partialFilterExpression || null)
    );
    if (!obsolete && !mismatched) continue;
    await model.collection.dropIndex(index.name);
    droppedIndexes.push(index.name);
  }
  for (const specification of specifications) {
    await model.collection.createIndex(specification.key, specification.options);
  }
  return droppedIndexes;
}

export async function ensureSupplierPaymentIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(SupplierPayment.collection.collectionName);
  await ensureCollection(SupplierPaymentCounter.collection.collectionName);
  const plan = await preparePaymentMigration();
  const session = await mongoose.startSession();
  let applied;
  try {
    await session.withTransaction(async () => {
      applied = await applyPaymentMigration(plan, session);
    });
  } finally {
    await session.endSession();
  }
  await validatePaymentReferences();
  const alignedCounters = await alignCounters(plan.prepared);
  const [droppedPaymentIndexes, droppedCounterIndexes] = await Promise.all([
    repairIndexes(
      SupplierPayment,
      PAYMENT_INDEXES,
      new Set(['paymentNo_1', 'invoice_1', 'supplier_1', 'branch_1', 'idempotencyKey_1', 'reversalIdempotencyKey_1'])
    ),
    repairIndexes(
      SupplierPaymentCounter,
      COUNTER_INDEXES,
      new Set(['restaurant_1_branchCode_1_year_1', 'branchCode_1_year_1'])
    )
  ]);
  return {
    ...applied,
    synthesized: plan.synthesized,
    alignedCounters,
    droppedPaymentIndexes,
    droppedCounterIndexes,
    indexes: PAYMENT_INDEXES.map(item => item.options.name),
    counterIndexes: COUNTER_INDEXES.map(item => item.options.name)
  };
}
