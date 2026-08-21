import mongoose from 'mongoose';
import {Ingredient, Supplier} from '../models/index.js';
import {
  Branch, Customer, InventoryBalance, Order, PurchaseOrder, Restaurant
} from '../models/operations.js';
import {analyticsScope, reportingPeriod} from './analytics.js';
import {iterateAggregate, iterateCursor, kathmanduDate} from './exportEngine.js';

/**
 * Phase 19 — the bulk export datasets.
 *
 * Each dataset is a column list plus a MongoDB pipeline. Two rules hold for
 * every one of them:
 *
 *  TENANCY. The scope always comes from `analyticsScope()`, the same resolver
 *  the Phase 18 reports use — which itself goes through
 *  `purchaseBranchContext()`. An export can therefore never see a branch its
 *  caller could not already see through the reporting API. No dataset builds
 *  its own `restaurant`/`branch` filter by hand.
 *
 *  STREAMING. Every source is a cursor. Joins are done with `$lookup` inside
 *  the pipeline rather than by pre-loading a lookup Map, so a restaurant with
 *  40,000 ingredients costs the same memory as one with four.
 *
 * `roles` on each dataset is the AUTHORITATIVE role gate. The route consults
 * it; hiding a button in the client is not a control.
 */

const MGMT = Object.freeze(['owner', 'manager']);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Sales that count as revenue — identical to the analytics definition. */
const REVENUE_STATUSES = {$nin: ['cancelled', 'draft', 'held']};

function periodMatch(field, period) {
  if (!period.fromDate && !period.toExclusive) return {};
  return {
    [field]: {
      ...(period.fromDate ? {$gte: period.fromDate} : {}),
      ...(period.toExclusive ? {$lt: period.toExclusive} : {})
    }
  };
}

function periodLabel(period) {
  if (!period.from && !period.to) return 'All dates';
  return `${period.from || 'beginning'} to ${period.to || 'today'} (Asia/Kathmandu)`;
}

/** `$lookup` a single referenced document and hoist one field out of it. */
function lookupOne(from, localField, as, project) {
  return [
    {$lookup: {from, localField, foreignField: '_id', as, pipeline: [{$project: project}]}},
    {$unwind: {path: `$${as}`, preserveNullAndEmptyArrays: true}}
  ];
}

// ── sales ────────────────────────────────────────────────────────────────────

const salesDataset = {
  key: 'sales',
  title: 'Sales',
  roles: MGMT,
  columns: [
    {key: 'orderNo', header: 'Order No', width: 14},
    {key: 'invoiceNo', header: 'Invoice No', width: 14},
    {key: 'placedAt', header: 'Placed At', type: 'datetime', width: 16},
    {key: 'branchName', header: 'Branch', width: 16},
    {key: 'type', header: 'Type', width: 10},
    {key: 'status', header: 'Status', width: 11},
    {key: 'customerName', header: 'Customer', width: 18},
    {key: 'items', header: 'Lines', type: 'int', width: 7},
    {key: 'subtotal', header: 'Subtotal', type: 'money', width: 12},
    {key: 'discountTotal', header: 'Discount', type: 'money', width: 11},
    {key: 'serviceCharge', header: 'Service Charge', type: 'money', width: 12},
    {key: 'vat', header: 'VAT', type: 'money', width: 11},
    {key: 'deliveryFee', header: 'Delivery Fee', type: 'money', width: 11},
    {key: 'total', header: 'Total', type: 'money', width: 12},
    {key: 'refundAmount', header: 'Refunded', type: 'money', width: 11},
    {key: 'netTotal', header: 'Net Total', type: 'money', width: 12}
  ],
  rows({scope, period}) {
    const pipeline = [
      {$match: {branch: {$in: scope.branchIds}, status: REVENUE_STATUSES, ...periodMatch('createdAt', period)}},
      {$sort: {createdAt: 1, _id: 1}},
      ...lookupOne('branches', 'branch', 'branchDoc', {name: 1}),
      ...lookupOne('customers', 'customer', 'customerDoc', {name: 1, phone: 1}),
      {
        $project: {
          orderNo: 1, invoiceNo: 1, placedAt: '$createdAt', type: 1, status: 1,
          branchName: '$branchDoc.name',
          customerName: {$ifNull: ['$customerDoc.name', '$customerDoc.phone']},
          items: {$size: {$ifNull: ['$items', []]}},
          subtotal: 1, discountTotal: {$ifNull: ['$discountTotal', '$discount']},
          serviceCharge: 1, vat: 1, deliveryFee: 1, total: 1,
          refundAmount: {$ifNull: ['$refundAmount', 0]},
          netTotal: {$subtract: [{$ifNull: ['$total', 0]}, {$ifNull: ['$refundAmount', 0]}]}
        }
      }
    ];
    return iterateAggregate(Order, pipeline);
  }
};

// ── inventory ────────────────────────────────────────────────────────────────

const inventoryDataset = {
  key: 'inventory',
  title: 'Inventory On Hand',
  roles: MGMT,
  dateless: true,
  columns: [
    {key: 'branchName', header: 'Branch', width: 16},
    {key: 'code', header: 'Code', width: 12},
    {key: 'name', header: 'Ingredient', width: 24},
    {key: 'category', header: 'Category', width: 14},
    {key: 'unit', header: 'Unit', width: 8},
    {key: 'quantity', header: 'Qty On Hand', type: 'number', width: 13},
    {key: 'averageCost', header: 'Avg Cost', type: 'cost', width: 11},
    {key: 'value', header: 'Stock Value', type: 'money', width: 13},
    {key: 'reorderLevel', header: 'Reorder Level', type: 'number', width: 12},
    {key: 'minLevel', header: 'Min Level', type: 'number', width: 11},
    {key: 'storageLocation', header: 'Location', width: 14}
  ],
  rows({scope}) {
    const pipeline = [
      {$match: {branch: {$in: scope.branchIds}}},
      ...lookupOne('ingredients', 'ingredient', 'ing', {name: 1, code: 1, unit: 1, category: 1, restaurant: 1}),
      // Belt and braces: the balance is reached through a branch the caller may
      // see, and the ingredient must also belong to the same restaurant.
      {$match: {'ing.restaurant': scope.restaurantId}},
      ...lookupOne('branches', 'branch', 'branchDoc', {name: 1}),
      {$sort: {'branchDoc.name': 1, 'ing.name': 1}},
      {
        $project: {
          branchName: '$branchDoc.name',
          code: '$ing.code', name: '$ing.name', category: '$ing.category', unit: '$ing.unit',
          quantity: {$ifNull: ['$quantity', 0]},
          averageCost: {$ifNull: ['$averageCost', 0]},
          value: {$multiply: [{$ifNull: ['$quantity', 0]}, {$ifNull: ['$averageCost', 0]}]},
          reorderLevel: {$ifNull: ['$reorderLevel', 0]},
          minLevel: {$ifNull: ['$minLevel', 0]},
          storageLocation: 1
        }
      }
    ];
    return iterateAggregate(InventoryBalance, pipeline);
  }
};

// ── purchases ────────────────────────────────────────────────────────────────

const purchasesDataset = {
  key: 'purchases',
  title: 'Purchase Orders',
  roles: MGMT,
  columns: [
    {key: 'poNo', header: 'PO No', width: 14},
    {key: 'orderDate', header: 'Order Date', type: 'date', width: 12},
    {key: 'branchName', header: 'Branch', width: 16},
    {key: 'supplierName', header: 'Supplier', width: 22},
    {key: 'status', header: 'Status', width: 14},
    {key: 'lines', header: 'Lines', type: 'int', width: 7},
    {key: 'orderedQty', header: 'Ordered Qty', type: 'number', width: 12},
    {key: 'receivedQty', header: 'Received Qty', type: 'number', width: 12},
    {key: 'subtotal', header: 'Subtotal', type: 'money', width: 12},
    {key: 'vat', header: 'VAT', type: 'money', width: 11},
    {key: 'total', header: 'Total', type: 'money', width: 13},
    {key: 'expectedDeliveryDate', header: 'Expected', type: 'date', width: 12}
  ],
  rows({scope, period}) {
    const pipeline = [
      {
        $match: {
          restaurant: scope.restaurantId,
          branch: {$in: scope.branchIds},
          ...periodMatch('orderDate', period)
        }
      },
      {$sort: {orderDate: 1, _id: 1}},
      ...lookupOne('branches', 'branch', 'branchDoc', {name: 1}),
      ...lookupOne('suppliers', 'supplier', 'supplierDoc', {name: 1}),
      {
        $project: {
          poNo: 1, orderDate: 1, status: 1, subtotal: 1, vat: 1, total: 1, expectedDeliveryDate: 1,
          branchName: '$branchDoc.name', supplierName: '$supplierDoc.name',
          lines: {$size: {$ifNull: ['$items', []]}},
          orderedQty: {$sum: '$items.orderedQty'},
          receivedQty: {$sum: '$items.receivedQty'}
        }
      }
    ];
    return iterateAggregate(PurchaseOrder, pipeline);
  }
};

// ── suppliers ────────────────────────────────────────────────────────────────

const suppliersDataset = {
  key: 'suppliers',
  title: 'Suppliers',
  roles: MGMT,
  dateless: true,
  columns: [
    {key: 'name', header: 'Supplier', width: 24},
    {key: 'status', header: 'Status', width: 12},
    {key: 'pan', header: 'PAN', width: 12},
    {key: 'vatRegistered', header: 'VAT Registered', type: 'bool', width: 12},
    {key: 'primaryContact', header: 'Primary Contact', width: 18},
    {key: 'phone', header: 'Phone', width: 14},
    {key: 'email', header: 'Email', width: 22},
    {key: 'address', header: 'Address', width: 24},
    {key: 'paymentTerms', header: 'Payment Terms', width: 16},
    {key: 'paymentTermsDays', header: 'Terms (days)', type: 'int', width: 11},
    {key: 'creditLimit', header: 'Credit Limit', type: 'money', width: 13},
    {key: 'leadTimeDays', header: 'Lead Time (days)', type: 'int', width: 12}
  ],
  rows({scope}) {
    // Suppliers are restaurant-level master data; there is no branch column to
    // filter on, so a branch-scoped export still returns the tenant's
    // suppliers. Said explicitly because silently returning everything would
    // otherwise look like a tenancy hole.
    const query = Supplier.find({restaurant: scope.restaurantId})
      .select('name status pan vatRegistered contact contacts address addresses paymentTerms paymentTermsDays creditLimit leadTimeDays')
      .sort({name: 1});
    return (async function* stream() {
      for await (const row of iterateCursor(query)) {
        const primary = (row.contacts || []).find(contact => contact.primary) || (row.contacts || [])[0] || {};
        const address = (row.addresses || []).find(a => a.kind === 'billing') || (row.addresses || [])[0];
        yield {
          name: row.name,
          status: row.status,
          pan: row.pan || '',
          vatRegistered: row.vatRegistered,
          primaryContact: primary.name || row.contact || '',
          phone: primary.phone || '',
          email: primary.email || '',
          address: address ? [address.line1, address.city].filter(Boolean).join(', ') : (row.address || ''),
          paymentTerms: row.paymentTerms || '',
          paymentTermsDays: row.paymentTermsDays || 0,
          creditLimit: row.creditLimit || 0,
          leadTimeDays: row.leadTimeDays || 0
        };
      }
    })();
  }
};

// ── customers ────────────────────────────────────────────────────────────────

const customersDataset = {
  key: 'customers',
  title: 'Customers',
  roles: MGMT,
  dateless: true,
  columns: [
    {key: 'name', header: 'Customer', width: 22},
    {key: 'phone', header: 'Phone', width: 14},
    {key: 'email', header: 'Email', width: 22},
    {key: 'branchName', header: 'Home Branch', width: 16},
    {key: 'tier', header: 'Tier', width: 10},
    {key: 'points', header: 'Points', type: 'int', width: 9},
    {key: 'totalOrders', header: 'Orders', type: 'int', width: 9},
    {key: 'totalSpend', header: 'Lifetime Spend', type: 'money', width: 14},
    {key: 'averageOrderValue', header: 'Avg Order', type: 'money', width: 12},
    {key: 'firstOrderAt', header: 'First Order', type: 'date', width: 12},
    {key: 'lastOrderAt', header: 'Last Order', type: 'date', width: 12},
    {key: 'active', header: 'Active', type: 'bool', width: 8}
  ],
  rows({scope}) {
    const match = {restaurant: scope.restaurantId, mergedInto: null};
    // A branch manager exports the guests attributed to their branch. An owner
    // sweeping the whole restaurant also picks up guests with no home branch.
    if (scope.branch) match.branch = scope.branch._id;
    const pipeline = [
      {$match: match},
      {$sort: {'stats.totalSpend': -1, _id: 1}},
      ...lookupOne('branches', 'branch', 'branchDoc', {name: 1}),
      {
        $project: {
          name: {$ifNull: ['$name', '']}, phone: 1, email: 1,
          branchName: '$branchDoc.name',
          tier: '$loyalty.tier',
          points: {$ifNull: ['$loyalty.points', 0]},
          totalOrders: {$ifNull: ['$stats.totalOrders', 0]},
          totalSpend: {$ifNull: ['$stats.totalSpend', {$ifNull: ['$totalSpend', 0]}]},
          averageOrderValue: {$ifNull: ['$stats.averageOrderValue', 0]},
          firstOrderAt: '$stats.firstOrderAt',
          lastOrderAt: {$ifNull: ['$stats.lastOrderAt', '$lastOrderAt']},
          active: 1
        }
      }
    ];
    return iterateAggregate(Customer, pipeline);
  }
};

// ── payments ─────────────────────────────────────────────────────────────────

const paymentsDataset = {
  key: 'payments',
  title: 'Payments',
  roles: MGMT,
  columns: [
    {key: 'takenAt', header: 'Taken At', type: 'datetime', width: 16},
    {key: 'branchName', header: 'Branch', width: 16},
    {key: 'orderNo', header: 'Order No', width: 14},
    {key: 'invoiceNo', header: 'Invoice No', width: 14},
    {key: 'method', header: 'Method', width: 10},
    {key: 'status', header: 'Status', width: 10},
    {key: 'amount', header: 'Amount', type: 'money', width: 13},
    {key: 'kind', header: 'Kind', width: 10},
    {key: 'transactionId', header: 'Transaction Ref', width: 20},
    {key: 'cashierName', header: 'Cashier', width: 16},
    {key: 'reason', header: 'Reason', width: 22}
  ],
  rows({scope, period}) {
    // Driven from ORDERS, not from payments: `Payment` carries no branch, so
    // filtering it directly would mean scanning every tender in the database
    // and joining afterwards. Starting at the branch-and-date indexed order
    // set keeps the scope filter where an index can serve it, and makes it
    // impossible to emit a tender whose order is out of scope.
    const pipeline = [
      {$match: {branch: {$in: scope.branchIds}, ...periodMatch('createdAt', period)}},
      {$sort: {createdAt: 1, _id: 1}},
      {$project: {orderNo: 1, invoiceNo: 1, branch: 1}},
      {
        $lookup: {
          from: 'payments', localField: '_id', foreignField: 'order', as: 'tender',
          pipeline: [{$sort: {createdAt: 1, _id: 1}}]
        }
      },
      {$unwind: '$tender'},
      ...lookupOne('branches', 'branch', 'branchDoc', {name: 1}),
      ...lookupOne('users', 'tender.cashier', 'cashierDoc', {name: 1}),
      {
        $project: {
          takenAt: '$tender.createdAt',
          branchName: '$branchDoc.name',
          orderNo: 1, invoiceNo: 1,
          method: '$tender.method',
          status: '$tender.status',
          amount: '$tender.amount',
          kind: {
            $cond: [{$lt: ['$tender.amount', 0]}, 'refund',
              {$cond: [{$eq: ['$tender.status', 'reversed']}, 'reversed', 'payment']}]
          },
          transactionId: '$tender.transactionId',
          cashierName: '$cashierDoc.name',
          reason: {$ifNull: ['$tender.reason', '$tender.reversalReason']}
        }
      }
    ];
    return iterateAggregate(Order, pipeline);
  }
};

export const EXPORT_DATASETS = Object.freeze({
  sales: salesDataset,
  inventory: inventoryDataset,
  purchases: purchasesDataset,
  suppliers: suppliersDataset,
  customers: customersDataset,
  payments: paymentsDataset
});

export const EXPORT_DATASET_KEYS = Object.freeze(Object.keys(EXPORT_DATASETS));

export function getDataset(key) {
  const dataset = EXPORT_DATASETS[String(key || '').toLowerCase()];
  if (!dataset) throw httpError(`dataset must be one of ${EXPORT_DATASET_KEYS.join(', ')}`, 404);
  return dataset;
}

/**
 * Resolves scope, enforces the dataset's role gate and returns everything the
 * renderers need. This is the single choke point: a route cannot obtain a row
 * stream without passing through it.
 */
export async function prepareExport({datasetKey, user, branchId, from, to}) {
  const dataset = getDataset(datasetKey);
  if (!dataset.roles.includes(user?.role)) {
    throw httpError('Insufficient permission', 403);
  }
  const scope = await analyticsScope({branchId, user});
  const period = dataset.dateless ? reportingPeriod({}) : reportingPeriod({from, to});
  const restaurant = await Restaurant.findById(scope.restaurantId).select('name').lean();

  const scopeLabel = scope.branch ? `${scope.branch.name} (${scope.branch.code || '—'})` : 'All branches';
  const meta = [
    `${restaurant?.name || 'Restaurant'} · ${scopeLabel}`,
    dataset.dateless ? `As at ${kathmanduDate(new Date())} (Asia/Kathmandu)` : periodLabel(period),
    `Generated ${kathmanduDate(new Date())} by ${user?.name || user?.id} (${user?.role})`
  ];

  const slugParts = [
    'mittho', dataset.key,
    scope.branch ? String(scope.branch.code || scope.branch.name) : 'all-branches',
    dataset.dateless ? kathmanduDate(new Date()) : [period.from, period.to].filter(Boolean).join('_') || 'all'
  ];

  return {
    dataset,
    scope,
    period,
    title: dataset.title,
    subtitle: scopeLabel,
    meta,
    filename: slugParts.join('-'),
    columns: dataset.columns,
    rows: dataset.rows({scope, period})
  };
}

/** Branches the caller may pick in the export UI. Mirrors the report scope. */
export async function exportableBranches({user}) {
  const scope = await analyticsScope({user});
  return Branch.find({_id: {$in: scope.branchIds}}).select('name code active').sort({name: 1}).lean();
}

/** Advertised catalogue, filtered to what this caller may actually download. */
export function availableDatasets(user) {
  return EXPORT_DATASET_KEYS
    .filter(key => EXPORT_DATASETS[key].roles.includes(user?.role))
    .map(key => ({
      key,
      title: EXPORT_DATASETS[key].title,
      dateless: Boolean(EXPORT_DATASETS[key].dateless),
      columns: EXPORT_DATASETS[key].columns.map(column => column.header)
    }));
}

export const __testables = {periodMatch, lookupOne, REVENUE_STATUSES, mongoose, Ingredient};
