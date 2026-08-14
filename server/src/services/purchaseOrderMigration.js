import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {Branch, PurchaseOrder} from '../models/operations.js';

const PO_INDEXES = [
  {
    key: {restaurant: 1, poNo: 1},
    options: {unique: true, name: 'po_restaurant_number_v2', partialFilterExpression: {numberVersion: 2}}
  },
  {
    key: {restaurant: 1, requestKey: 1},
    options: {unique: true, name: 'po_restaurant_request_key', partialFilterExpression: {requestKey: {$type: 'string'}}}
  },
  {
    key: {restaurant: 1, shortCloseIdempotencyKey: 1},
    options: {unique: true, name: 'po_restaurant_short_close_key', partialFilterExpression: {shortCloseIdempotencyKey: {$type: 'string'}}}
  },
  {
    key: {restaurant: 1, branch: 1, status: 1, createdAt: -1},
    options: {name: 'po_restaurant_branch_status_created'}
  },
  {
    key: {restaurant: 1, supplier: 1, createdAt: -1},
    options: {name: 'po_restaurant_supplier_created'}
  }
];

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

async function backfillPurchaseOrders() {
  const rows = await PurchaseOrder.collection.find({
    $or: [
      {restaurant: {$exists: false}},
      {orderDate: {$exists: false}},
      {subtotal: {$exists: false}},
      {vat: {$exists: false}},
      {'items.lineSubtotal': {$exists: false}},
      {'items.lineVat': {$exists: false}},
      {'items.lineTotal': {$exists: false}}
    ]
  }, {projection: {
    _id: 1, branch: 1, createdAt: 1, total: 1, restaurant: 1,
    orderDate: 1, subtotal: 1, vat: 1, items: 1
  }}).toArray();
  if (!rows.length) return 0;

  const branchIds = [...new Set(rows.map(row => String(row.branch || '')).filter(Boolean))];
  const branches = await Branch.find({_id: {$in: branchIds}}).select('_id restaurant').lean();
  const restaurantByBranch = new Map(branches.map(branch => [String(branch._id), branch.restaurant]));
  const operations = [];
  for (const row of rows) {
    const set = {};
    const restaurant = row.restaurant || restaurantByBranch.get(String(row.branch));
    if (!row.restaurant && restaurant) set.restaurant = restaurant;
    if (!row.orderDate) set.orderDate = row.createdAt || new Date();
    if (row.subtotal === undefined) set.subtotal = Number(row.total || 0);
    if (row.vat === undefined) set.vat = 0;
    if ((row.items || []).some(item => item.lineSubtotal === undefined || item.lineVat === undefined || item.lineTotal === undefined)) {
      set.items = row.items.map(item => {
        const lineSubtotal = item.lineSubtotal === undefined
          ? Math.round((Number(item.orderedQty || 0) * Number(item.unitPrice || 0) + Number.EPSILON) * 100) / 100
          : Number(item.lineSubtotal || 0);
        const lineVat = item.lineVat === undefined ? 0 : Number(item.lineVat || 0);
        return {
          ...item,
          priceIncludesVat: item.priceIncludesVat ?? false,
          vatRate: item.vatRate ?? 0,
          lineSubtotal,
          lineVat,
          lineTotal: item.lineTotal === undefined ? Math.round((lineSubtotal + lineVat + Number.EPSILON) * 100) / 100 : Number(item.lineTotal || 0)
        };
      });
    }
    if (Object.keys(set).length) operations.push({updateOne: {filter: {_id: row._id}, update: {$set: set}}});
  }
  if (operations.length) await PurchaseOrder.collection.bulkWrite(operations, {ordered: false});
  return operations.length;
}

async function backfillPurchaseOrderApprovals() {
  const lifecycleStatuses = ['pending', 'approved', 'rejected', 'sent', 'partially_received', 'received', 'closed_short'];
  const rows = await PurchaseOrder.collection.find({
    status: {$in: lifecycleStatuses},
    $or: [
      {submittedAt: {$exists: false}},
      {submittedBy: {$exists: false}},
      {approvalRound: {$exists: false}},
      {status: {$in: ['approved', 'sent', 'partially_received', 'received', 'closed_short']}, approvedAt: {$exists: false}},
      {status: 'rejected', rejectedAt: {$exists: false}},
      {status: 'rejected', rejectionReason: {$exists: false}}
    ]
  }, {projection: {
    _id: 1, status: 1, createdBy: 1, updatedBy: 1, createdAt: 1, updatedAt: 1,
    submittedBy: 1, submittedAt: 1, approvalRound: 1,
    approvedBy: 1, approvedAt: 1, approvalNote: 1,
    rejectedBy: 1, rejectedAt: 1, rejectionReason: 1
  }}).toArray();
  if (!rows.length) return 0;

  const audits = await Audit.find({
    entity: 'purchase_order',
    entityId: {$in: rows.map(row => row._id)},
    action: 'po_status',
    'after.status': {$in: ['pending', 'approved', 'rejected']}
  }).sort({at: 1, _id: 1}).select('entityId after user at').lean();
  const auditsByOrder = new Map();
  for (const audit of audits) {
    const key = String(audit.entityId);
    const events = auditsByOrder.get(key) || [];
    events.push(audit);
    auditsByOrder.set(key, events);
  }

  const approvedStatuses = ['approved', 'sent', 'partially_received', 'received', 'closed_short'];
  const operations = rows.map(row => {
    const events = auditsByOrder.get(String(row._id)) || [];
    const submitted = [...events].reverse().find(event => event.after?.status === 'pending');
    const approved = [...events].reverse().find(event => event.after?.status === 'approved');
    const rejected = [...events].reverse().find(event => event.after?.status === 'rejected');
    const set = {};
    if (!row.submittedAt) set.submittedAt = submitted?.at || row.updatedAt || row.createdAt || new Date();
    if (!row.submittedBy) set.submittedBy = submitted?.user || row.createdBy || row.updatedBy;
    if (row.approvalRound === undefined) set.approvalRound = Math.max(1, events.filter(event => event.after?.status === 'pending').length);
    if (approvedStatuses.includes(row.status)) {
      if (!row.approvedAt) set.approvedAt = approved?.at || row.updatedAt || row.createdAt || new Date();
      if (!row.approvedBy && approved?.user) set.approvedBy = approved.user;
    }
    if (row.status === 'rejected') {
      if (!row.rejectedAt) set.rejectedAt = rejected?.at || row.updatedAt || row.createdAt || new Date();
      if (!row.rejectedBy) set.rejectedBy = rejected?.user || row.updatedBy || row.createdBy;
      if (!row.rejectionReason) set.rejectionReason = rejected?.after?.rejectionReason || rejected?.after?.approvalNote || row.approvalNote || 'Legacy rejection reason unavailable';
    }
    return {updateOne: {filter: {_id: row._id}, update: {$set: set}}};
  });
  await PurchaseOrder.collection.bulkWrite(operations, {ordered: false});
  return operations.length;
}

function normalizedBranchCode(branch) {
  return String(branch?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch?._id || '').slice(-4).toUpperCase();
}

async function backfillPurchaseOrderCounters() {
  const counters = mongoose.connection.db.collection('purchaseordercounters');
  const rows = await counters.find({}, {projection: {_id: 1, restaurant: 1, branch: 1, branchCode: 1, year: 1, value: 1}}).toArray();
  if (!rows.length) return 0;

  const branchIds = [...new Set(rows.filter(row => !row.branchCode).map(row => String(row.branch || '')).filter(Boolean))];
  const branches = branchIds.length
    ? await Branch.find({_id: {$in: branchIds}}).select('_id code').lean()
    : [];
  const branchById = new Map(branches.map(branch => [String(branch._id), branch]));
  const groups = new Map();
  for (const row of rows) {
    if (!row.restaurant || !row.year) continue;
    const branchCode = normalizedBranchCode(row.branchCode
      ? {code: row.branchCode, _id: row.branch}
      : branchById.get(String(row.branch)) || {_id: row.branch});
    const key = `${row.restaurant}:${branchCode}:${row.year}`;
    const group = groups.get(key) || {branchCode, rows: [], value: 0};
    group.rows.push(row);
    group.value = Math.max(group.value, Number(row.value || 0));
    groups.set(key, group);
  }

  let migrated = 0;
  for (const group of groups.values()) {
    const [canonical, ...duplicates] = group.rows;
    const needsUpdate = canonical.branchCode !== group.branchCode || Number(canonical.value || 0) !== group.value;
    if (needsUpdate) {
      await counters.updateOne({_id: canonical._id}, {$set: {branchCode: group.branchCode, value: group.value}});
      migrated += 1;
    }
    if (duplicates.length) {
      await counters.deleteMany({_id: {$in: duplicates.map(row => row._id)}});
      migrated += duplicates.length;
    }
  }
  return migrated;
}

export async function ensurePurchaseOrderIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(PurchaseOrder.collection.collectionName);
  await ensureCollection(Audit.collection.collectionName);
  await ensureCollection('purchaseordercounters');
  const migrated = await backfillPurchaseOrders();
  const approvalMigrated = await backfillPurchaseOrderApprovals();
  const counterMigrated = await backfillPurchaseOrderCounters();
  for (const index of PO_INDEXES) {
    await PurchaseOrder.collection.createIndex(index.key, index.options);
  }
  await Audit.collection.createIndex(
    {restaurant: 1, branch: 1, entity: 1, entityId: 1, action: 1, at: 1},
    {name: 'audit_entity_timeline'}
  );
  const counters = mongoose.connection.db.collection('purchaseordercounters');
  const currentCounterIndex = (await counters.indexes()).find(index => index.name === 'po_counter_scope');
  if (currentCounterIndex && (
    currentCounterIndex.key?.restaurant !== 1
    || currentCounterIndex.key?.branchCode !== 1
    || currentCounterIndex.key?.year !== 1
    || Object.hasOwn(currentCounterIndex.key, 'branch')
  )) {
    await counters.dropIndex('po_counter_scope');
  }
  await counters.createIndex(
    {restaurant: 1, branchCode: 1, year: 1},
    {unique: true, name: 'po_counter_scope'}
  );
  return {
    migrated,
    approvalMigrated,
    counterMigrated,
    purchaseOrderIndexes: PO_INDEXES.map(index => index.options.name),
    approvalAuditIndex: 'audit_entity_timeline',
    counterIndex: 'po_counter_scope'
  };
}
