import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth, requirePermission} from '../middleware/auth.js';
import {PurchaseOrder, SupplierInvoice} from '../models/operations.js';
import {GoodsReceipt} from '../models/purchasing.js';

import {RECEIPT_DAMAGE_REASONS, receivePurchaseOrder, replayGoodsReceipt} from '../services/receiving.js';
import {
  listPurchaseReturnOptions,
  listPurchaseReturns,
  replayPurchaseReturn,
  returnPurchaseOrder
} from '../services/returns.js';
import {buildSupplierStatement} from '../services/statements.js';
import {buildPurchasingReport} from '../services/purchasingReport.js';
import {
  buildReorderSuggestions, compareIngredientPrices, getIngredientPurchaseHistory,
  ingredientPriceReport, listUnpaidInvoices, purchaseSummary
} from '../services/procurement.js';
import {
  buildReorderPlan, createSuggestedPurchaseOrder, raiseReorderAlerts
} from '../services/reorderEngine.js';
import {getSupplierPerformance} from '../services/supplierPerformance.js';
import {
  buildCustomerReport, buildInventoryReport, buildSalesReport
} from '../services/analytics.js';
import {schedulerStatus} from '../services/reorderScheduler.js';
import {buildPnl} from '../services/pnl.js';
import {buildDashboard} from '../services/dashboard.js';
import {listLiveInventory} from '../services/inventory.js';
import {buildMenuEngineering, buildMenuEngineeringReport} from '../services/menuEngineering.js';
import {
  createSupplierInvoice,
  getSupplierInvoice,
  listSupplierInvoices,
  replaySupplierInvoiceCreate,
  refreshSupplierInvoiceMatching,
  updateSupplierInvoice
} from '../services/invoices.js';
import {
  createSupplierPayment,
  listSupplierInvoicePayments,
  replaySupplierPayment,
  replaySupplierPaymentReversal,
  reverseSupplierPayment
} from '../services/supplierPayments.js';
import {
  closeShortPurchaseOrder,
  replayShortClosePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  getPurchaseOrderApprovalHistory,
  listAccessibleBranches,
  listPurchaseOrders,
  replayPurchaseOrderCreate,
  transitionPurchaseOrder,
  updatePurchaseOrder
} from '../services/purchaseOrders.js';
import {publishPurchasingEvent, publishInventoryEvent} from '../services/realtime.js';
import {listExpenses, createExpense, updateExpense, deleteExpense} from '../services/expenses.js';

const r = Router();
/**
 * Phase 13: sanitise purchasing errors.
 *
 * This previously returned `e.message` verbatim. For a ZodError that is the
 * serialised issue array -- a ~600 character dump of internal schema
 * structure, expected types and field paths -- and for an unexpected fault it
 * is the raw exception text, which can carry driver or query detail. Neither
 * belongs in an HTTP response on endpoints that move money and stock.
 *
 * Deliberate 4xx messages authored in the services are still passed through:
 * "Cannot receive more than the outstanding quantity" is exactly what an
 * operator needs to see.
 */
const fail = (res, e) => {
  const status = e?.status || (e?.name === 'ZodError' ? 400 : 500);
  let message = e?.message || 'Request failed';

  if (e?.name === 'ZodError' || /^\[\s*\{/.test(String(message))) {
    const issue = Array.isArray(e?.issues) ? e.issues[0] : null;
    // A `custom` issue carries a message authored in the schema for the
    // operator ("Damage notes are required when the reason is other"). Those
    // are useful and safe, so they survive. Everything else is a structural
    // complaint whose wording exposes internal types and paths, and is
    // reduced to the offending field name.
    if (issue?.code === 'custom' && issue.message) {
      message = issue.message;
    } else if (issue?.code === 'unrecognized_keys') {
      // Naming the rejected key is what makes a strict-schema refusal
      // actionable, and the key came from the caller so it discloses nothing.
      const keys = (issue.keys || []).join(', ');
      message = keys ? `Unrecognized field: ${keys}` : 'Unrecognized field in request';
    } else {
      const field = issue?.path?.length ? issue.path.join('.') : null;
      message = field ? `Invalid ${field}` : 'Some details are missing or invalid';
    }
  } else if (e?.name === 'MongoServerError' || e?.name === 'ValidationError' || e?.name === 'CastError') {
    message = 'We could not process that request';
  } else if (status >= 500) {
    message = 'Server error';
  }
  return res.status(status).json({message: String(message).slice(0, 300)});
};

// Phase 13: .strict() so a client cannot post protected or misspelled fields.
// The server already derived every total, status and audit stamp itself and
// ignored injected values, but silently accepting them hides typos and means
// a future field addition could quietly become client-writable.
const poLineSchema = z.object({
  ingredient: z.string(),
  catalogItem: z.string().optional(),
  purchaseQty: z.number().positive().optional(),
  orderedQty: z.number().positive().optional(),
  unit: z.string().trim().max(30).optional(),
  unitPrice: z.number().positive().optional(),
  priceIncludesVat: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional()
}).strict();
const poCreateSchema = z.object({
  branch: z.string(),
  supplier: z.string(),
  items: z.array(poLineSchema).min(1).max(100),
  orderDate: z.string().optional(),
  expectedDeliveryDate: z.string().nullable().optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional()
}).strict();
const poUpdateSchema = z.object({
  supplier: z.string(),
  items: z.array(poLineSchema).min(1).max(100),
  expectedDeliveryDate: z.string().nullable().optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional(),
  expectedVersion: z.number().int().nonnegative()
}).strict();
const reportDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Report dates must use YYYY-MM-DD');
const purchasingReportQuerySchema = z.object({
  branch: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid branch').optional(),
  from: reportDateSchema.optional(),
  to: reportDateSchema.optional()
}).strict();
const poListSchema = z.object({
  branch: z.string(),
  q: z.string().trim().max(120).optional(),
  supplier: z.string().optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});

function publishPurchaseOrder(branch, payload) {
  try {
    publishPurchasingEvent(branch, payload);
  } catch (error) {
    console.error('purchase order realtime publish failed', error.message);
  }
}

r.get('/purchase-orders', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const query = poListSchema.parse(req.query);
    res.json(await listPurchaseOrders({user: req.user, branchId: query.branch, ...query}));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/purchase-order-branches', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await listAccessibleBranches({user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/purchase-orders', requirePermission('purchase.create'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const input = poCreateSchema.parse(req.body);
    const requestKey = req.headers['idempotency-key'];
    let result;
    try {
      await session.withTransaction(async () => {
        result = await createPurchaseOrder({input, user: req.user, requestKey, session});
      });
    } catch (error) {
      if (error?.code === 11000 && requestKey) result = await replayPurchaseOrderCreate({input, user: req.user, requestKey});
      else throw error;
    }
    if (!result.duplicate) publishPurchaseOrder(result.purchaseOrder.branch?._id || result.purchaseOrder.branch, {reason: 'po_create', poId: String(result.purchaseOrder._id)});
    res.status(result.duplicate ? 200 : 201).json(result.purchaseOrder);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.patch('/purchase-orders/:id', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = poUpdateSchema.parse(req.body);
    let po;
    await session.withTransaction(async () => {
      po = await updatePurchaseOrder({
        poId: req.params.id,
        input: body,
        expectedVersion: body.expectedVersion,
        user: req.user,
        session
      });
    });
    publishPurchaseOrder(po.branch?._id || po.branch, {reason: 'po_update', poId: String(po._id), status: po.status});
    res.json(po);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

const receiptDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must use YYYY-MM-DD')
  .refine(value => {
    const date = new Date(`${value}T00:00:00.000+05:45`);
    if (Number.isNaN(date.getTime())) return false;
    return new Date(date.getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 10) === value;
  }, 'Invalid expiry date');
const receiveSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  items: z.array(z.object({
    itemId: z.string(),
    receivedQty: z.number().positive(),
    damagedQty: z.number().nonnegative().optional(),
    damageReason: z.enum(RECEIPT_DAMAGE_REASONS).optional(),
    damageNotes: z.string().trim().max(500).optional(),
    batchNumber: z.string().trim().max(120).optional(),
    expiryDate: receiptDateSchema.optional()
  }).strict().superRefine((value, ctx) => {
    if (Number(value.damagedQty || 0) === 0 && (value.damageReason || value.damageNotes)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ['damageReason'], message: 'Damage details require a damaged quantity'});
    }
    if (value.damageReason === 'other' && String(value.damageNotes || '').trim().length < 3) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ['damageNotes'], message: 'Damage notes are required when the reason is other'});
    }
    if (value.expiryDate && !String(value.batchNumber || '').trim()) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ['batchNumber'], message: 'Batch number is required when an expiry date is recorded'});
    }
  })).min(1).max(100)
}).strict();

r.get('/purchase-orders/:id', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await getPurchaseOrder({poId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

const poStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'sent', 'closed', 'cancelled']),
  notes: z.string().trim().max(1000).optional(),
  expectedVersion: z.number().int().nonnegative().optional()
}).superRefine((value, ctx) => {
  if (value.status === 'rejected' && String(value.notes || '').trim().length < 3) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ['notes'], message: 'Rejection reason must be at least 3 characters'});
  }
});

r.get('/purchase-orders/:id/approval-history', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await getPurchaseOrderApprovalHistory({poId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/purchase-orders/:id/status', requirePermission('purchase.approve'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = poStatusSchema.parse(req.body);
    let po;
    await session.withTransaction(async () => {
      po = await transitionPurchaseOrder({
        poId: req.params.id,
        status: body.status,
        notes: body.notes,
        expectedVersion: body.expectedVersion,
        user: req.user,
        session
      });
    });
    publishPurchaseOrder(po.branch?._id || po.branch, {reason: 'po_status', poId: String(po._id), status: po.status});
    res.json(po);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

const shortCloseSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  expectedVersion: z.number().int().nonnegative()
}).strict();

r.post('/purchase-orders/:id/close-short', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  let body;
  let idempotencyKey;
  try {
    body = shortCloseSchema.parse(req.body);
    idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await closeShortPurchaseOrder({
          poId: req.params.id,
          reason: body.reason,
          expectedVersion: body.expectedVersion,
          user: req.user,
          session,
          idempotencyKey
        });
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        result = {
          purchaseOrder: await replayShortClosePurchaseOrder({
            poId: req.params.id,
            reason: body.reason,
            user: req.user,
            idempotencyKey
          }),
          duplicate: true
        };
      } else {
        throw error;
      }
    }
    const po = result.purchaseOrder;
    if (!result.duplicate) {
      publishPurchaseOrder(po.branch?._id || po.branch, {
        reason: 'po_short_close',
        poId: String(po._id),
        status: po.status
      });
    }
    res.json(po);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.get('/purchase-orders/:id/receipts', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const po = await getPurchaseOrder({poId: req.params.id, user: req.user});
    res.json(await GoodsReceipt.find({
      restaurant: po.restaurant,
      branch: po.branch?._id || po.branch,
      purchaseOrder: po._id
    })
      .sort({receivedAt: -1, _id: -1})
      .limit(500)
      .populate('items.ingredient', 'name code category unit')
      .populate('receivedBy', 'name role'));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/purchase-orders/:id/receive', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  let body;
  let idempotencyKey;
  try {
    body = receiveSchema.parse(req.body);
    idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await receivePurchaseOrder({
          poId: req.params.id,
          items: body.items,
          notes: body.notes,
          expectedVersion: body.expectedVersion,
          user: req.user,
          session,
          idempotencyKey
        });
        if (!result.duplicate) {
          await refreshSupplierInvoiceMatching({
            purchaseOrder: result.purchaseOrder,
            user: req.user,
            reason: 'goods_receipt',
            session
          });
        }
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        result = await replayGoodsReceipt({
          poId: req.params.id,
          items: body.items,
          notes: body.notes,
          user: req.user,
          idempotencyKey
        });
      } else {
        throw error;
      }
    }
    if (!result.duplicate) {
      const receivingBranch = result.purchaseOrder.branch?._id || result.purchaseOrder.branch;
      publishPurchasingEvent(receivingBranch, {
        reason: 'receive',
        poId: String(result.purchaseOrder._id),
        receiptId: String(result.receipt._id),
        receiptNo: result.receipt.receiptNo,
        status: result.purchaseOrder.status,
        hasDamage: Number(result.receipt.damagedValue || 0) > 0,
        acceptedValue: result.receipt.acceptedValue,
        damagedValue: result.receipt.damagedValue
      });
      publishInventoryEvent(receivingBranch, {
        reason: 'receive',
        poId: String(result.purchaseOrder._id),
        receiptId: String(result.receipt._id)
      });
    }
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

const returnLineSchema = z.object({
  itemId: z.string().trim().min(1),
  qty: z.number().finite().positive(),
  batchId: z.string().trim().min(1).optional(),
  batchNumber: z.string().trim().min(1).max(120).optional()
}).strict().refine(row => !(row.batchId && row.batchNumber), {
  message: 'Choose either batchId or batchNumber, not both'
});
const returnSchema = z.object({
  reason: z.enum(['quality', 'wrong_item', 'expired', 'overstock', 'damaged', 'other']).optional(),
  notes: z.string().trim().max(1000).optional(),
  expectedVersion: z.number().int().nonnegative(),
  items: z.array(returnLineSchema).min(1).max(100)
}).strict();

r.get('/purchase-orders/:id/return-options', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await listPurchaseReturnOptions({poId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/purchase-orders/:id/returns', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await listPurchaseReturns({poId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/purchase-orders/:id/returns', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  let body;
  let idempotencyKey;
  try {
    body = returnSchema.parse(req.body);
    idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await returnPurchaseOrder({
          poId: req.params.id,
          items: body.items,
          reason: body.reason,
          notes: body.notes,
          expectedVersion: body.expectedVersion,
          user: req.user,
          session,
          idempotencyKey
        });
        if (!result.duplicate) {
          await refreshSupplierInvoiceMatching({
            purchaseOrder: result.purchaseOrder,
            user: req.user,
            reason: 'purchase_return',
            session
          });
        }
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        result = await replayPurchaseReturn({
          poId: req.params.id,
          items: body.items,
          reason: body.reason,
          notes: body.notes,
          user: req.user,
          idempotencyKey
        });
      } else {
        throw error;
      }
    }
    if (!result.duplicate) {
      const returnBranch = result.purchaseOrder.branch?._id || result.purchaseOrder.branch;
      publishPurchasingEvent(returnBranch, {
        reason: 'return',
        poId: String(result.purchaseOrder._id),
        returnId: String(result.purchaseReturn._id),
        returnNo: result.purchaseReturn.returnNo,
        total: result.purchaseReturn.total
      });
      publishInventoryEvent(returnBranch, {
        reason: 'return',
        poId: String(result.purchaseOrder._id),
        returnId: String(result.purchaseReturn._id)
      });
    }
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.get('/suppliers/:id/statement', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await buildSupplierStatement({
      supplierId: req.params.id,
      branchId: req.query.branch,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      limit: req.query.limit,
      user: req.user
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/suppliers/:id/payments', auth(['owner', 'manager']), async (req, res) => {
  try {
    const statement = await buildSupplierStatement({
      supplierId: req.params.id,
      branchId: req.query.branch,
      from: req.query.from,
      to: req.query.to,
      user: req.user,
      limit: 500
    });
    res.json(statement.payments);
  } catch (e) {
    fail(res, e);
  }
});

r.get('/suppliers/:id/balance', auth(['owner', 'manager']), async (req, res) => {
  try {
    const statement = await buildSupplierStatement({
      supplierId: req.params.id,
      branchId: req.query.branch,
      to: req.query.asOf || req.query.to,
      user: req.user,
      limit: 1
    });
    res.json({
      supplier: statement.supplier,
      branch: statement.branch,
      asOf: statement.period.asOf,
      invoiced: statement.invoiced,
      paid: statement.paid,
      returned: statement.returned,
      outstandingFormula: statement.outstandingFormula,
      balance: statement.balance,
      aging: statement.aging,
      creditLimit: statement.supplier?.creditLimit ?? 0,
      // Surfaced so a buyer sees it before raising the next order, not after.
      creditAvailable: Math.round((Number(statement.supplier?.creditLimit || 0) - Number(statement.balance || 0)) * 100) / 100,
      overCreditLimit: Number(statement.supplier?.creditLimit || 0) > 0
        && Number(statement.balance || 0) > Number(statement.supplier?.creditLimit || 0)
    });
  } catch (e) {
    fail(res, e);
  }
});

const invoiceCreateSchema = z.object({
  branch: z.string(),
  supplier: z.string(),
  purchaseOrder: z.string().nullable().optional(),
  invoiceNo: z.string().trim().min(1).max(120),
  invoiceDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  priceIncludesVat: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  subtotal: z.number().nonnegative().optional(),
  vat: z.number().nonnegative().optional(),
  total: z.number().positive().optional(),
  notes: z.string().trim().max(1000).optional(),
  attachmentUrl: z.string().trim().max(1000).optional()
}).strict();
const invoiceListSchema = z.object({
  branch: z.string().optional(),
  supplier: z.string().optional(),
  status: z.enum(['unpaid', 'partial', 'paid', 'void']).optional(),
  q: z.string().trim().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional()
}).strict();
const invoicePatchSchema = z.object({
  invoiceNo: z.string().trim().min(1).max(120).optional(),
  invoiceDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  priceIncludesVat: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  subtotal: z.number().nonnegative().optional(),
  vat: z.number().nonnegative().optional(),
  total: z.number().positive().optional(),
  notes: z.string().trim().max(1000).optional(),
  purchaseOrder: z.string().nullable().optional(),
  attachmentUrl: z.string().trim().max(1000).optional(),
  status: z.enum(['void']).optional(),
  expectedVersion: z.number().int().nonnegative()
}).strict();

r.get('/supplier-invoices', auth(['owner', 'manager']), async (req, res) => {
  try {
    const query = invoiceListSchema.parse(req.query);
    res.json(await listSupplierInvoices({
      user: req.user,
      branchId: query.branch,
      supplierId: query.supplier,
      ...query
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/supplier-invoices', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  let input;
  let idempotencyKey;
  try {
    input = invoiceCreateSchema.parse(req.body);
    idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await createSupplierInvoice({input, user: req.user, idempotencyKey, session});
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        result = await replaySupplierInvoiceCreate({input, user: req.user, idempotencyKey});
      } else {
        throw error;
      }
    }
    const invoice = result.invoice;
    if (!result.duplicate) {
      publishPurchasingEvent(invoice.branch?._id || invoice.branch, {
        reason: 'invoice_create',
        invoiceId: String(invoice._id),
        poId: invoice.purchaseOrder?._id ? String(invoice.purchaseOrder._id) : invoice.purchaseOrder ? String(invoice.purchaseOrder) : undefined,
        supplierId: invoice.supplier?._id ? String(invoice.supplier._id) : String(invoice.supplier),
        matchingStatus: invoice.matching?.status
      }, {audience: 'management'});
    }
    res.status(result.duplicate ? 200 : 201).json({...invoice.toJSON(), duplicate: result.duplicate});
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

const supplierPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['cash', 'bank', 'esewa', 'khalti', 'card']),
  reference: z.string().trim().max(200).optional(),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expectedInvoiceVersion: z.number().int().nonnegative().optional()
}).strict();
const supplierPaymentReversalSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  expectedInvoiceVersion: z.number().int().nonnegative().optional()
}).strict();

r.get('/supplier-invoices/:id/payments', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await listSupplierInvoicePayments({invoiceId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/supplier-invoices/:id/payments', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  let input;
  let idempotencyKey;
  try {
    input = supplierPaymentSchema.parse(req.body);
    idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await createSupplierPayment({
          invoiceId: req.params.id,
          input,
          user: req.user,
          idempotencyKey,
          session
        });
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        result = await replaySupplierPayment({
          invoiceId: req.params.id,
          input,
          user: req.user,
          idempotencyKey
        });
      } else {
        throw error;
      }
    }
    if (!result.duplicate) {
      publishPurchasingEvent(result.payment.branch, {
        reason: 'invoice_pay',
        invoiceId: String(result.payment.invoice?._id || result.payment.invoice),
        paymentId: String(result.payment._id),
        paymentNo: result.payment.paymentNo,
        supplierId: String(result.payment.supplier?._id || result.payment.supplier),
        status: result.invoice.status
      }, {audience: 'management'});
    }
    res.status(result.duplicate ? 200 : 201).json({...result, duplicate: result.duplicate});
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.post('/supplier-payments/:id/reverse', auth(['owner']), async (req, res) => {
  const session = await mongoose.startSession();
  let body;
  let idempotencyKey;
  try {
    body = supplierPaymentReversalSchema.parse(req.body);
    idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await reverseSupplierPayment({
          paymentId: req.params.id,
          reason: body.reason,
          expectedInvoiceVersion: body.expectedInvoiceVersion,
          user: req.user,
          idempotencyKey,
          session
        });
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        result = await replaySupplierPaymentReversal({
          paymentId: req.params.id,
          reason: body.reason,
          user: req.user,
          idempotencyKey
        });
      } else {
        throw error;
      }
    }
    if (!result.duplicate) {
      publishPurchasingEvent(result.payment.branch, {
        reason: 'invoice_payment_reverse',
        invoiceId: String(result.payment.invoice?._id || result.payment.invoice),
        paymentId: String(result.payment._id),
        paymentNo: result.payment.paymentNo,
        supplierId: String(result.payment.supplier?._id || result.payment.supplier),
        status: result.invoice.status
      }, {audience: 'management'});
    }
    res.status(result.duplicate ? 200 : 201).json({...result, duplicate: result.duplicate});
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.get('/supplier-invoices/:id', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await getSupplierInvoice({invoiceId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/supplier-invoices/:id', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = invoicePatchSchema.parse(req.body);
    let invoice;
    await session.withTransaction(async () => {
      invoice = await updateSupplierInvoice({
        invoiceId: req.params.id,
        user: req.user,
        patch: body,
        expectedVersion: body.expectedVersion,
        session
      });
    });
    publishPurchasingEvent(invoice.branch?._id || invoice.branch, {
      reason: invoice.status === 'void' ? 'invoice_void' : 'invoice_update',
      invoiceId: String(invoice._id),
      supplierId: invoice.supplier?._id ? String(invoice.supplier._id) : String(invoice.supplier),
      status: invoice.status,
      matchingStatus: invoice.matching?.status
    }, {audience: 'management'});
    res.json(invoice);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.get('/reports/purchasing', auth(['owner', 'manager']), async (req, res) => {
  try {
    const query = purchasingReportQuerySchema.parse(req.query);
    res.json(await buildPurchasingReport({
      branchId: query.branch,
      user: req.user,
      from: query.from,
      to: query.to
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/reports/pnl', requirePermission('reports.view'), async (req, res) => {
  try {
    res.json(await buildPnl({
      branchId: req.query.branch,
      user: req.user,
      from: req.query.from,
      to: req.query.to
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/dashboard', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await buildDashboard({
      branchId: req.query.branch,
      user: req.user
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/inventory', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await listLiveInventory({
      branchId: req.query.branch,
      user: req.user
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/analytics/menu-engineering', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await buildMenuEngineering({
      branchId: req.query.branch,
      user: req.user,
      from: req.query.from,
      to: req.query.to
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/analytics/menu-engineering/report', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await buildMenuEngineeringReport({
      branchId: req.query.branch,
      user: req.user,
      from: req.query.from,
      to: req.query.to,
      targetFoodCostPercent: req.query.targetFoodCostPercent,
      limit: req.query.limit
    }));
  } catch (e) {
    fail(res, e);
  }
});

const expenseSchema = z.object({
  category: z.string().min(1),
  description: z.string().optional(),
  amount: z.number().positive(),
  vat: z.number().nonnegative().optional(),
  date: z.string().optional(),
  branch: z.string().nullable().optional()
});

const expensePatchSchema = z.object({
  category: z.string().min(1).optional(),
  description: z.string().optional(),
  amount: z.number().positive().optional(),
  vat: z.number().nonnegative().optional(),
  date: z.string().optional(),
  branch: z.string().nullable().optional()
});

r.get('/expenses', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await listExpenses({
      branchId: req.query.branch,
      user: req.user,
      from: req.query.from,
      to: req.query.to
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/expenses', auth(['owner', 'manager']), async (req, res) => {
  try {
    const body = expenseSchema.parse(req.body);
    res.status(201).json(await createExpense({...body, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/expenses/:id', auth(['owner', 'manager']), async (req, res) => {
  try {
    const body = expensePatchSchema.parse(req.body);
    res.json(await updateExpense({expenseId: req.params.id, patch: body, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.delete('/expenses/:id', auth(['owner', 'manager']), async (req, res) => {
  try {
    await deleteExpense({expenseId: req.params.id, user: req.user});
    res.status(204).end();
  } catch (e) {
    fail(res, e);
  }
});

// ── Phase 16: procurement intelligence ───────────────────────────────────────
// Read-only planning and reporting. Management only: these expose supplier
// pricing and what the restaurant owes, which is not line-staff information.
const MGMT = ['owner', 'manager'];

r.get('/purchasing/reorder-suggestions', auth(MGMT), async (req, res) => {
  try {
    res.json(await buildReorderSuggestions({
      branchId: req.query.branch, user: req.user, includeAll: String(req.query.includeAll) === 'true'
    }));
  } catch (e) { fail(res, e); }
});

r.get('/purchasing/price-comparison/:ingredientId', auth(MGMT), async (req, res) => {
  try {
    res.json(await compareIngredientPrices({ingredientId: req.params.ingredientId, user: req.user}));
  } catch (e) { fail(res, e); }
});

r.get('/purchasing/purchase-history/:ingredientId', auth(MGMT), async (req, res) => {
  try {
    res.json(await getIngredientPurchaseHistory({
      ingredientId: req.params.ingredientId, supplierId: req.query.supplier,
      branchId: req.query.branch, user: req.user, limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

r.get('/reports/purchase-by-supplier', auth(MGMT), async (req, res) => {
  try {
    res.json(await purchaseSummary({
      groupBy: 'supplier', branchId: req.query.branch, user: req.user,
      from: req.query.from, to: req.query.to
    }));
  } catch (e) { fail(res, e); }
});

r.get('/reports/purchase-by-branch', auth(MGMT), async (req, res) => {
  try {
    res.json(await purchaseSummary({
      groupBy: 'branch', branchId: req.query.branch, user: req.user,
      from: req.query.from, to: req.query.to
    }));
  } catch (e) { fail(res, e); }
});

r.get('/reports/ingredient-purchase-prices', auth(MGMT), async (req, res) => {
  try {
    res.json(await ingredientPriceReport({
      branchId: req.query.branch, user: req.user, limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

r.get('/reports/unpaid-invoices', auth(MGMT), async (req, res) => {
  try {
    res.json(await listUnpaidInvoices({
      branchId: req.query.branch, supplierId: req.query.supplier, user: req.user
    }));
  } catch (e) { fail(res, e); }
});

// ── Phase 17: reorder point engine ───────────────────────────────────────────
// reorderPoint = averageDailyUsage x leadTimeDays + safetyStock.
const reorderPlanQuery = q => ({
  lookbackDays: q.lookbackDays === undefined ? undefined : Number(q.lookbackDays),
  serviceLevel: q.serviceLevel === undefined ? undefined : Number(q.serviceLevel)
});

r.get('/purchasing/reorder-plan', auth(MGMT), async (req, res) => {
  try {
    res.json(await buildReorderPlan({
      branchId: req.query.branch, user: req.user,
      includeAll: String(req.query.includeAll) === 'true',
      ...reorderPlanQuery(req.query)
    }));
  } catch (e) { fail(res, e); }
});

// Opens a DRAFT purchase order from a suggestion. Deliberately a draft: the
// brief says a manager approves, so a computed number never commits money.
const suggestedPoSchema = z.object({
  branch: z.string(),
  supplier: z.string(),
  lookbackDays: z.number().int().min(1).max(365).optional(),
  serviceLevel: z.number().int().min(90).max(99).optional()
}).strict();

r.post('/purchasing/suggested-orders', auth(MGMT), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = suggestedPoSchema.parse(req.body);
    let result;
    await session.withTransaction(async () => {
      result = await createSuggestedPurchaseOrder({
        branchId: body.branch, supplierId: body.supplier, user: req.user,
        lookbackDays: body.lookbackDays, serviceLevel: body.serviceLevel,
        idempotencyKey: req.headers['idempotency-key'], session
      });
    });
    const po = result.purchaseOrder;
    publishPurchaseOrder(po.branch?._id || po.branch, {
      reason: 'reorder_suggestion', poId: String(po._id), status: po.status
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (e) { fail(res, e); } finally { session.endSession(); }
});

r.post('/purchasing/reorder-alerts/run', auth(MGMT), async (req, res) => {
  try {
    res.json(await raiseReorderAlerts({branchId: req.query.branch, user: req.user}));
  } catch (e) { fail(res, e); }
});

// Supplier delivery performance measured from real approve -> receive history.
r.get('/suppliers/:id/performance', auth(MGMT), async (req, res) => {
  try {
    res.json(await getSupplierPerformance({
      supplierId: req.params.id, branchId: req.query.branch, user: req.user, limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

// Scheduler telemetry, so an operator can see whether the sweep is actually
// running rather than assuming it is.
r.get('/purchasing/reorder-scheduler', auth(MGMT), async (req, res) => {
  try { res.json(schedulerStatus()); } catch (e) { fail(res, e); }
});

// ── Phase 18: analytics ──────────────────────────────────────────────────────
// Read-only. Management only: these expose revenue, margin and customer data.
// Every one is tenant- and branch-scoped through analyticsScope(), which reuses
// the same guards purchasing uses.
r.get('/reports/sales', requirePermission('reports.view'), async (req, res) => {
  try {
    res.json(await buildSalesReport({
      branchId: req.query.branch, user: req.user,
      from: req.query.from, to: req.query.to, granularity: req.query.granularity
    }));
  } catch (e) { fail(res, e); }
});

r.get('/reports/inventory', requirePermission('reports.view'), async (req, res) => {
  try {
    res.json(await buildInventoryReport({
      branchId: req.query.branch, user: req.user, from: req.query.from, to: req.query.to
    }));
  } catch (e) { fail(res, e); }
});

r.get('/reports/customers', requirePermission('reports.view'), async (req, res) => {
  try {
    res.json(await buildCustomerReport({
      branchId: req.query.branch, user: req.user,
      from: req.query.from, to: req.query.to, limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

export default r;
