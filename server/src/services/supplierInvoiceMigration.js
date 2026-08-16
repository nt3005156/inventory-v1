import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Supplier, User} from '../models/index.js';
import {Branch, PurchaseOrder, SupplierInvoice} from '../models/operations.js';
import {buildInvoiceMatching, normalizeInvoiceNumber} from './invoices.js';

const INVOICE_INDEXES = [
  {
    key: {restaurant: 1, supplier: 1, invoiceNoNormalized: 1},
    options: {unique: true, name: 'supplier_invoice_restaurant_supplier_number'}
  },
  {
    key: {restaurant: 1, idempotencyKey: 1},
    options: {
      unique: true,
      name: 'supplier_invoice_restaurant_idempotency',
      partialFilterExpression: {idempotencyKey: {$type: 'string'}}
    }
  },
  {
    key: {restaurant: 1, branch: 1, status: 1, invoiceDate: -1},
    options: {name: 'supplier_invoice_restaurant_branch_status_date'}
  },
  {
    key: {restaurant: 1, purchaseOrder: 1, status: 1},
    options: {name: 'supplier_invoice_restaurant_po_status'}
  }
];

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const validDate = value => value instanceof Date && Number.isFinite(value.getTime());
const sameId = (left, right) => left && right && String(left) === String(right);
const isBsonObjectId = value => value instanceof mongoose.Types.ObjectId;
const validReferenceIds = values => [...new Set(values
  .map(value => String(value || ''))
  .filter(value => mongoose.isValidObjectId(value)))];
const validAttachmentUrl = value => {
  const text = String(value || '').trim();
  if (!text) return true;
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
};

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

function emptyMatching(linked) {
  return {
    status: linked ? 'awaiting_receipt' : 'unlinked',
    receivedSubtotal: 0,
    receivedVat: 0,
    receivedTotal: 0,
    returnedSubtotal: 0,
    returnedVat: 0,
    returnedTotal: 0,
    netReceivedSubtotal: 0,
    netReceivedVat: 0,
    netReceivedTotal: 0,
    previouslyInvoicedSubtotal: 0,
    previouslyInvoicedVat: 0,
    previouslyInvoicedTotal: 0,
    availableSubtotal: 0,
    availableVat: 0,
    availableTotal: 0,
    varianceSubtotal: 0,
    varianceVat: 0,
    varianceTotal: 0,
    receiptIds: [],
    returnIds: [],
    matchedAt: new Date()
  };
}

function legacyHash(row, set) {
  return crypto.createHash('sha256').update(JSON.stringify({
    branch: String(set.branch || row.branch || ''),
    supplier: String(row.supplier || ''),
    purchaseOrder: String(row.purchaseOrder || ''),
    invoiceNo: set.invoiceNoNormalized,
    invoiceDate: new Date(set.invoiceDate).toISOString(),
    dueDate: set.dueDate ? new Date(set.dueDate).toISOString() : '',
    subtotal: set.subtotal,
    vat: set.vat,
    total: set.total,
    notes: String(row.notes || '').trim(),
    attachmentUrl: String(row.attachmentUrl || '').trim()
  })).digest('hex');
}

async function backfillSupplierInvoices() {
  const rows = await SupplierInvoice.collection.find({
    $or: [
      {restaurant: {$not: {$type: 'objectId'}}},
      {branch: {$not: {$type: 'objectId'}}},
      {supplier: {$not: {$type: 'objectId'}}},
      {purchaseOrder: {$exists: true, $ne: null, $not: {$type: 'objectId'}}},
      {createdBy: {$not: {$type: 'objectId'}}},
      {updatedBy: {$exists: true, $ne: null, $not: {$type: 'objectId'}}},
      {voidedBy: {$exists: true, $ne: null, $not: {$type: 'objectId'}}},
      {invoiceNo: {$not: {$type: 'string'}}},
      {invoiceNoNormalized: {$not: {$type: 'string'}}},
      {invoiceNoNormalized: ''},
      {invoiceDate: {$not: {$type: 'date'}}},
      {dueDate: {$exists: true, $ne: null, $not: {$type: 'date'}}},
      {subtotal: {$not: {$type: 'number'}}},
      {vat: {$not: {$type: 'number'}}},
      {total: {$not: {$type: 'number'}}},
      {paidAmount: {$not: {$type: 'number'}}},
      {identityVersion: {$ne: 2}},
      {currency: {$ne: 'NPR'}},
      {priceIncludesVat: {$exists: false}},
      {vatRate: {$exists: false}},
      {matching: {$exists: false}},
      {updatedBy: {$exists: false}},
      {requestHashVersion: {$ne: 2}}
    ]
  }).sort({createdAt: 1, _id: 1}).toArray();
  if (!rows.length) return {migrated: 0, matchingRebuilt: 0, normalizedCollisions: 0};

  const branchIds = validReferenceIds(rows.map(row => row.branch));
  const supplierIds = validReferenceIds(rows.map(row => row.supplier));
  const poIds = validReferenceIds(rows.map(row => row.purchaseOrder));
  const [branches, suppliers, purchaseOrders] = await Promise.all([
    Branch.find({_id: {$in: branchIds}}).select('_id restaurant').lean(),
    Supplier.find({_id: {$in: supplierIds}}).select('_id restaurant').lean(),
    PurchaseOrder.find({_id: {$in: poIds}}).select('_id restaurant branch supplier createdBy updatedBy items status').lean()
  ]);
  const branchById = new Map(branches.map(row => [String(row._id), row]));
  const supplierById = new Map(suppliers.map(row => [String(row._id), row]));
  const poById = new Map(purchaseOrders.map(row => [String(row._id), row]));
  const actorIds = validReferenceIds([
    ...rows.flatMap(row => [row.createdBy, row.updatedBy, row.voidedBy]),
    ...purchaseOrders.flatMap(row => [row.createdBy, row.updatedBy])
  ]);
  const actors = await User.find({_id: {$in: actorIds}}).select('_id restaurantId').lean();
  const actorById = new Map(actors.map(actor => [String(actor._id), actor]));
  const ownerByRestaurant = new Map();
  const unresolved = [];
  const prepared = [];

  for (const row of rows) {
    const branch = branchById.get(String(row.branch));
    const supplier = supplierById.get(String(row.supplier));
    const po = row.purchaseOrder ? poById.get(String(row.purchaseOrder)) : null;
    // The referenced branch is the authoritative tenant source; raw BSON strings are
    // canonicalized below rather than copied back into ObjectId fields.
    const restaurant = branch?.restaurant;
    const rowActors = [row.createdBy, row.updatedBy, row.voidedBy].filter(Boolean);
    const ownershipConflict = !restaurant
      || !branch?.restaurant
      || !supplier?.restaurant
      || (row.restaurant && !sameId(row.restaurant, restaurant))
      || !sameId(supplier.restaurant, restaurant)
      || (row.purchaseOrder && !po)
      || (po && (!sameId(po.restaurant, restaurant) || !sameId(po.branch, branch._id) || !sameId(po.supplier, supplier._id)))
      || rowActors.some(actorId => {
        const actor = actorById.get(String(actorId));
        return !actor || !sameId(actor.restaurantId, restaurant);
      });
    if (ownershipConflict) {
      unresolved.push(String(row._id));
      continue;
    }
    const canonicalActor = value => actorById.get(String(value || ''))?._id || null;
    let actor = canonicalActor(row.createdBy)
      || canonicalActor(row.updatedBy)
      || canonicalActor(po?.updatedBy)
      || canonicalActor(po?.createdBy);
    if (!actor) {
      const key = String(restaurant);
      if (!ownerByRestaurant.has(key)) {
        ownerByRestaurant.set(key, await User.findOne({restaurantId: restaurant, role: 'owner'}).select('_id').lean());
      }
      actor = ownerByRestaurant.get(key)?._id;
    }
    if (!actor) {
      unresolved.push(String(row._id));
      continue;
    }

    const rawSubtotal = Number(row.subtotal);
    const rawVat = Number(row.vat);
    const rawTotal = Number(row.total);
    const subtotal = money(rawSubtotal);
    const vat = money(rawVat);
    const total = money(subtotal + vat);
    const rawPaidAmount = Number(row.paidAmount ?? 0);
    const paidAmount = money(rawPaidAmount);
    const rawVatRate = row.vatRate !== undefined
      ? Number(row.vatRate)
      : subtotal > 0 ? money(vat / subtotal * 100) : 13;
    const vatRate = money(rawVatRate);
    const invoiceNoNormalized = normalizeInvoiceNumber(row.invoiceNo);
    const invoiceDate = validDate(row.invoiceDate) ? row.invoiceDate : row.invoiceDate == null && validDate(row.createdAt) ? row.createdAt : null;
    const dueDate = row.dueDate == null ? null : validDate(row.dueDate) ? row.dueDate : null;
    const invalidDueDate = row.dueDate != null && (!dueDate || dueDate < invoiceDate);
    if (!Number.isFinite(rawSubtotal) || subtotal < 0
      || !Number.isFinite(rawVat) || vat < 0
      || !Number.isFinite(rawTotal) || !(total > 0) || Math.abs(money(rawTotal) - total) > 0.011
      || !Number.isFinite(rawPaidAmount) || paidAmount < 0 || paidAmount > total
      || !Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100
      || !invoiceNoNormalized || invoiceNoNormalized.length > 120
      || typeof row.invoiceNo !== 'string' || !row.invoiceNo.trim() || row.invoiceNo.trim().length > 120
      || (row.notes != null && (typeof row.notes !== 'string' || row.notes.trim().length > 1000))
      || (row.attachmentUrl != null && (typeof row.attachmentUrl !== 'string' || row.attachmentUrl.trim().length > 1000 || !validAttachmentUrl(row.attachmentUrl)))
      || !invoiceDate || invalidDueDate) {
      unresolved.push(String(row._id));
      continue;
    }
    const status = row.status === 'void' ? 'void' : paidAmount >= total ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';
    const set = {
      restaurant,
      branch: branch._id,
      supplier: supplier._id,
      invoiceNoNormalized,
      identityVersion: 2,
      invoiceDate,
      currency: 'NPR',
      priceIncludesVat: Boolean(row.priceIncludesVat),
      vatRate,
      subtotal,
      vat,
      total,
      paidAmount,
      status,
      matching: emptyMatching(Boolean(po)),
      requestHashVersion: 2,
      createdBy: canonicalActor(row.createdBy) || actor,
      updatedBy: canonicalActor(row.updatedBy) || actor
    };
    if (po) set.purchaseOrder = po._id;
    if (row.voidedBy) set.voidedBy = canonicalActor(row.voidedBy);
    if (dueDate) set.dueDate = dueDate;
    if (row.idempotencyKey) set.requestHash = legacyHash(row, set);
    prepared.push({row, set, po});
  }

  if (unresolved.length) {
    throw new Error(`Supplier invoice migration cannot safely migrate ownership or invoice data for: ${unresolved.join(', ')}`);
  }

  const preparedIds = prepared.map(item => item.row._id);
  const existingIdentities = await SupplierInvoice.collection.find({
    _id: {$nin: preparedIds},
    restaurant: {$type: 'objectId'},
    supplier: {$type: 'objectId'},
    invoiceNoNormalized: {$type: 'string'}
  }).project({restaurant: 1, supplier: 1, invoiceNoNormalized: 1}).toArray();
  const occupied = new Set(existingIdentities.map(row =>
    `${row.restaurant}:${row.supplier}:${row.invoiceNoNormalized}`
  ));
  let normalizedCollisions = 0;
  for (const item of prepared) {
    const original = item.set.invoiceNoNormalized;
    const key = `${item.set.restaurant}:${item.row.supplier}:${original}`;
    if (occupied.has(key)) {
      const suffix = ` #LEGACY-${String(item.row._id).toUpperCase()}`;
      item.set.invoiceNoNormalized = `${original.slice(0, Math.max(0, 120 - suffix.length))}${suffix}`;
      normalizedCollisions += 1;
    }
    occupied.add(`${item.set.restaurant}:${item.row.supplier}:${item.set.invoiceNoNormalized}`);
  }

  const operations = prepared.map(({row, set}) => ({
    updateOne: {filter: {_id: row._id}, update: {$set: set}}
  }));
  if (operations.length) await SupplierInvoice.collection.bulkWrite(operations, {ordered: false});

  let matchingRebuilt = 0;
  const affectedPoIds = [...new Set(prepared.filter(item => item.po).map(item => String(item.po._id)))];
  for (const poId of affectedPoIds) {
    const purchaseOrder = await PurchaseOrder.findById(poId);
    const linkedInvoices = await SupplierInvoice.find({
      restaurant: purchaseOrder.restaurant,
      branch: purchaseOrder.branch,
      purchaseOrder: purchaseOrder._id
    }).sort({createdAt: 1, _id: 1});
    const previousInvoiceIds = [];
    for (const invoice of linkedInvoices) {
      if (invoice.status === 'void') continue;
      const matching = await buildInvoiceMatching({
        context: {restaurantId: purchaseOrder.restaurant, branch: {_id: purchaseOrder.branch}},
        purchaseOrder,
        amounts: {subtotal: invoice.subtotal, vat: invoice.vat, total: invoice.total},
        previousInvoiceIds,
        session: null
      });
      await SupplierInvoice.collection.updateOne({_id: invoice._id}, {$set: {matching}});
      previousInvoiceIds.push(invoice._id);
      matchingRebuilt += 1;
    }
  }
  return {migrated: operations.length, matchingRebuilt, normalizedCollisions};
}

async function validateSupplierInvoiceReferences() {
  const rows = await SupplierInvoice.collection.find({}).project({
    restaurant: 1,
    branch: 1,
    supplier: 1,
    purchaseOrder: 1,
    createdBy: 1,
    updatedBy: 1,
    voidedBy: 1
  }).toArray();
  if (!rows.length) return;

  const [branches, suppliers, purchaseOrders, actors] = await Promise.all([
    Branch.find({_id: {$in: validReferenceIds(rows.map(row => row.branch))}}).select('_id restaurant').lean(),
    Supplier.find({_id: {$in: validReferenceIds(rows.map(row => row.supplier))}}).select('_id restaurant').lean(),
    PurchaseOrder.find({_id: {$in: validReferenceIds(rows.map(row => row.purchaseOrder))}})
      .select('_id restaurant branch supplier').lean(),
    User.find({_id: {$in: validReferenceIds(rows.flatMap(row => [row.createdBy, row.updatedBy, row.voidedBy]))}})
      .select('_id restaurantId').lean()
  ]);
  const branchById = new Map(branches.map(row => [String(row._id), row]));
  const supplierById = new Map(suppliers.map(row => [String(row._id), row]));
  const poById = new Map(purchaseOrders.map(row => [String(row._id), row]));
  const actorById = new Map(actors.map(row => [String(row._id), row]));
  const unresolved = [];

  for (const row of rows) {
    const branch = branchById.get(String(row.branch));
    const supplier = supplierById.get(String(row.supplier));
    const po = row.purchaseOrder ? poById.get(String(row.purchaseOrder)) : null;
    const actorIds = [row.createdBy, row.updatedBy, row.voidedBy].filter(Boolean);
    const malformed = !isBsonObjectId(row.restaurant)
      || !isBsonObjectId(row.branch)
      || !isBsonObjectId(row.supplier)
      || !isBsonObjectId(row.createdBy)
      || !isBsonObjectId(row.updatedBy)
      || (row.purchaseOrder && !isBsonObjectId(row.purchaseOrder))
      || (row.voidedBy && !isBsonObjectId(row.voidedBy))
      || !branch || !sameId(branch.restaurant, row.restaurant)
      || !supplier || !sameId(supplier.restaurant, row.restaurant)
      || !row.createdBy || !row.updatedBy
      || actorIds.some(actorId => {
        const actor = actorById.get(String(actorId));
        return !actor || !sameId(actor.restaurantId, row.restaurant);
      })
      || (row.purchaseOrder && (!po
        || !sameId(po.restaurant, row.restaurant)
        || !sameId(po.branch, row.branch)
        || !sameId(po.supplier, row.supplier)));
    if (malformed) unresolved.push(String(row._id));
  }
  if (unresolved.length) {
    throw new Error(`Supplier invoice migration cannot safely migrate ownership or invoice data for: ${unresolved.join(', ')}`);
  }
}

async function repairIndexes() {
  const existing = await SupplierInvoice.collection.indexes();
  const droppedIndexes = [];
  const obsoleteNames = new Set(['invoiceNo_1', 'idempotencyKey_1', 'branch_1', 'supplier_1', 'purchaseOrder_1']);
  for (const index of existing) {
    const specification = INVOICE_INDEXES.find(item => item.options.name === index.name);
    const sameKeySpecification = INVOICE_INDEXES.find(item => JSON.stringify(item.key) === JSON.stringify(index.key));
    const obsolete = obsoleteNames.has(index.name)
      || Boolean(sameKeySpecification && sameKeySpecification.options.name !== index.name)
      || index.unique && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1;
    const mismatched = specification && (
      JSON.stringify(index.key) !== JSON.stringify(specification.key)
      || Boolean(index.unique) !== Boolean(specification.options.unique)
      || JSON.stringify(index.partialFilterExpression || null)
        !== JSON.stringify(specification.options.partialFilterExpression || null)
    );
    if (!obsolete && !mismatched) continue;
    await SupplierInvoice.collection.dropIndex(index.name);
    droppedIndexes.push(index.name);
  }
  for (const specification of INVOICE_INDEXES) {
    await SupplierInvoice.collection.createIndex(specification.key, specification.options);
  }
  return droppedIndexes;
}

export async function ensureSupplierInvoiceIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(SupplierInvoice.collection.collectionName);
  const backfill = await backfillSupplierInvoices();
  await validateSupplierInvoiceReferences();
  const droppedIndexes = await repairIndexes();
  return {
    ...backfill,
    droppedIndexes,
    indexes: INVOICE_INDEXES.map(item => item.options.name)
  };
}
