import mongoose from 'mongoose';
import {Order, SalesInvoiceCounter} from '../models/operations.js';

/**
 * Phase 13 — sales tax invoice counter indexes.
 *
 * `salesInvoiceCounterSchema` declared a unique index on
 * `{restaurant, branchCode, year}` but the model is `autoIndex:false` and no
 * migration ever built it, so in practice the index did not exist. The
 * consequence was not cosmetic: `nextInvoiceNumber()` allocates with an upsert,
 * and without the unique constraint two concurrent first-issues each upsert
 * their OWN counter document and both read `value: 1`. Reproduced against the
 * running API — four different orders were all issued `INV-KTM-2026-000001`,
 * with four counter rows for one branch.
 *
 * A duplicated sequential tax invoice number is a VAT compliance failure, so
 * the counters are consolidated before the unique index is built.
 */

async function ensureCollection(name) {
  const existing = await mongoose.connection.db.listCollections({name}).toArray();
  if (!existing.length) {
    await mongoose.connection.db.createCollection(name).catch(error => {
      // A concurrent process may have won the race; that is the desired state.
      if (error?.codeName !== 'NamespaceExists') throw error;
    });
  }
}

/**
 * Collapses duplicate counter rows for one {restaurant, branchCode, year}.
 *
 * The surviving row keeps the HIGHEST value seen, so the sequence can only ever
 * move forward. That may leave a gap where duplicates were issued, which is the
 * safe direction: a gap is explainable, a reused number is not.
 */
export async function consolidateSalesInvoiceCounters() {
  const counters = mongoose.connection.db.collection('salesinvoicecounters');
  const groups = await counters.aggregate([
    {
      $group: {
        _id: {restaurant: '$restaurant', branchCode: '$branchCode', year: '$year'},
        ids: {$push: '$_id'},
        maxValue: {$max: '$value'},
        count: {$sum: 1}
      }
    },
    {$match: {count: {$gt: 1}}}
  ]).toArray();

  let consolidated = 0;
  for (const group of groups) {
    const [keep, ...drop] = group.ids;
    await counters.updateOne({_id: keep}, {$set: {value: group.maxValue}});
    await counters.deleteMany({_id: {$in: drop}});
    consolidated += drop.length;
  }
  return consolidated;
}

/**
 * Reports orders sharing an invoice number within a restaurant.
 *
 * Deliberately REPORT-ONLY. An issued tax invoice number is a legal document
 * already in a customer's hands; renumbering it automatically would be worse
 * than the duplicate. Operators must reconcile these by hand and issue credit
 * notes, so the migration surfaces them rather than "repairing" them.
 */
export async function findDuplicateInvoiceNumbers() {
  const duplicates = await Order.aggregate([
    {$match: {invoiceNo: {$type: 'string', $ne: null}}},
    {$group: {_id: '$invoiceNo', orders: {$push: '$_id'}, count: {$sum: 1}}},
    {$match: {count: {$gt: 1}}},
    {$sort: {_id: 1}}
  ]);
  return duplicates.map(row => ({invoiceNo: row._id, orders: row.orders, count: row.count}));
}

export async function ensureSalesInvoiceIndexes() {
  if (!mongoose.connection.db) return null;
  await ensureCollection('salesinvoicecounters');
  await ensureCollection(Order.collection.collectionName);

  const consolidated = await consolidateSalesInvoiceCounters();

  const counters = mongoose.connection.db.collection('salesinvoicecounters');
  await counters.createIndex(
    {restaurant: 1, branchCode: 1, year: 1},
    {unique: true, name: 'sales_invoice_counter_scope'}
  );

  // An invoice number must be unique within a restaurant. Partial, because
  // most orders are never invoiced and `null` is not a value that should
  // collide.
  const duplicates = await findDuplicateInvoiceNumbers();
  let invoiceNumberIndex = null;
  if (!duplicates.length) {
    await Order.collection.createIndex(
      {branch: 1, invoiceNo: 1},
      {
        unique: true,
        name: 'order_branch_invoice_no',
        partialFilterExpression: {invoiceNo: {$type: 'string'}}
      }
    );
    invoiceNumberIndex = 'order_branch_invoice_no';
  }

  return {
    consolidated,
    invoiceNumberIndex,
    // Surfaced, never silently rewritten.
    duplicateInvoiceNumbers: duplicates
  };
}

export {SalesInvoiceCounter};
