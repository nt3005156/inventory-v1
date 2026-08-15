import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {PurchaseOrder, SupplierInvoice, SupplierPayment} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../models/purchasing.js';
import {assertBranchAccess} from '../services/kitchen.js';
import {RECEIPT_DAMAGE_REASONS, receivePurchaseOrder, replayGoodsReceipt} from '../services/receiving.js';
import {returnPurchaseOrder} from '../services/returns.js';
import {buildSupplierStatement} from '../services/statements.js';
import {buildPurchasingReport} from '../services/purchasingReport.js';
import {buildPnl} from '../services/pnl.js';
import {buildDashboard} from '../services/dashboard.js';
import {listLiveInventory} from '../services/inventory.js';
import {buildMenuEngineering} from '../services/menuEngineering.js';
import {updateSupplierInvoice} from '../services/invoices.js';
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
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});

const poLineSchema = z.object({
  ingredient: z.string(),
  catalogItem: z.string().optional(),
  purchaseQty: z.number().positive().optional(),
  orderedQty: z.number().positive().optional(),
  unit: z.string().trim().max(30).optional(),
  unitPrice: z.number().positive().optional(),
  priceIncludesVat: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional()
});
const poCreateSchema = z.object({
  branch: z.string(),
  supplier: z.string(),
  items: z.array(poLineSchema).min(1).max(100),
  orderDate: z.string().optional(),
  expectedDeliveryDate: z.string().nullable().optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional()
});
const poUpdateSchema = z.object({
  supplier: z.string(),
  items: z.array(poLineSchema).min(1).max(100),
  expectedDeliveryDate: z.string().nullable().optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional(),
  expectedVersion: z.number().int().nonnegative()
});
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

r.post('/purchase-orders', auth(['owner', 'manager']), async (req, res) => {
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
  status: z.enum(['pending', 'approved', 'rejected', 'sent', 'cancelled']),
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

r.patch('/purchase-orders/:id/status', auth(['owner', 'manager']), async (req, res) => {
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

const returnSchema = z.object({
  reason: z.enum(['quality', 'wrong_item', 'expired', 'overstock', 'damaged', 'other']).optional(),
  notes: z.string().optional(),
  items: z.array(z.object({
    itemId: z.string(),
    qty: z.number(),
    unitPrice: z.number().optional(),
    batchNumber: z.string().optional()
  })).min(1)
});

r.get('/purchase-orders/:id/returns', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const po = await getPurchaseOrder({poId: req.params.id, user: req.user});
    res.json(await PurchaseReturn.find({purchaseOrder: po._id}).sort({createdAt: -1}).populate('items.ingredient returnedBy'));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/purchase-orders/:id/returns', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = returnSchema.parse(req.body);
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
    let result;
    await session.withTransaction(async () => {
      result = await returnPurchaseOrder({
        poId: req.params.id,
        items: body.items,
        reason: body.reason,
        notes: body.notes,
        user: req.user,
        session,
        idempotencyKey
      });
    });
    if (!result.duplicate) {
      publishPurchasingEvent(result.purchaseOrder.branch, {
        reason: 'return',
        poId: String(result.purchaseOrder._id)
      });
      publishInventoryEvent(result.purchaseOrder.branch, {
        reason: 'return',
        poId: String(result.purchaseOrder._id)
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
      user: req.user
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
      user: req.user
    });
    res.json({invoiced: statement.invoiced, paid: statement.paid, balance: statement.balance});
  } catch (e) {
    fail(res, e);
  }
});

r.get('/supplier-invoices/:id/payments', auth(['owner', 'manager']), async (req, res) => {
  try {
    const invoice = await SupplierInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({message: 'Invoice not found'});
    if (invoice.branch) assertBranchAccess(req.user, invoice.branch);
    res.json(await SupplierPayment.find({invoice: invoice._id}).sort({paidAt: 1, createdAt: 1}));
  } catch (e) {
    fail(res, e);
  }
});

const invoicePatchSchema = z.object({
  invoiceNo: z.string().min(1).optional(),
  invoiceDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  subtotal: z.number().nonnegative().optional(),
  vat: z.number().nonnegative().optional(),
  total: z.number().positive().optional(),
  notes: z.string().optional(),
  purchaseOrder: z.string().nullable().optional(),
  attachmentUrl: z.string().optional(),
  status: z.enum(['void']).optional()
});

r.get('/supplier-invoices/:id', auth(['owner', 'manager']), async (req, res) => {
  try {
    const invoice = await SupplierInvoice.findById(req.params.id).populate('supplier purchaseOrder');
    if (!invoice) return res.status(404).json({message: 'Invoice not found'});
    if (invoice.branch) assertBranchAccess(req.user, invoice.branch);
    res.json(invoice);
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/supplier-invoices/:id', auth(['owner', 'manager']), async (req, res) => {
  try {
    const body = invoicePatchSchema.parse(req.body);
    const invoice = await updateSupplierInvoice({invoiceId: req.params.id, user: req.user, patch: body});
    publishPurchasingEvent(invoice.branch, {
      reason: invoice.status === 'void' ? 'invoice_void' : 'invoice_update',
      invoiceId: String(invoice._id),
      supplierId: invoice.supplier ? String(invoice.supplier) : undefined,
      status: invoice.status
    });
    res.json(await SupplierInvoice.findById(invoice._id).populate('supplier purchaseOrder'));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/reports/purchasing', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await buildPurchasingReport({
      branchId: req.query.branch,
      user: req.user,
      from: req.query.from,
      to: req.query.to
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/reports/pnl', auth(['owner', 'manager']), async (req, res) => {
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

export default r;
