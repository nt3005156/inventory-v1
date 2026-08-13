import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {PurchaseOrder, SupplierInvoice, SupplierPayment} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../models/purchasing.js';
import {assertBranchAccess} from '../services/kitchen.js';
import {receivePurchaseOrder} from '../services/receiving.js';
import {returnPurchaseOrder} from '../services/returns.js';
import {buildSupplierStatement} from '../services/statements.js';
import {buildPurchasingReport} from '../services/purchasingReport.js';
import {updateSupplierInvoice} from '../services/invoices.js';
import {transitionPurchaseOrder} from '../services/purchaseOrders.js';

const r = Router();
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});

const receiveSchema = z.object({
  notes: z.string().optional(),
  items: z.array(z.object({
    itemId: z.string(),
    receivedQty: z.number(),
    damagedQty: z.number().optional(),
    unitPrice: z.number().optional(),
    batchNumber: z.string().optional(),
    expiryDate: z.string().optional()
  })).min(1)
});

r.get('/purchase-orders/:id', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id).populate('supplier items.ingredient');
    if (!po) return res.status(404).json({message: 'Purchase order not found'});
    assertBranchAccess(req.user, po.branch);
    res.json(po);
  } catch (e) {
    fail(res, e);
  }
});

const poStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'sent', 'cancelled']),
  notes: z.string().optional()
});

r.patch('/purchase-orders/:id/status', auth(['owner', 'manager']), async (req, res) => {
  try {
    const body = poStatusSchema.parse(req.body);
    res.json(await transitionPurchaseOrder({
      poId: req.params.id,
      status: body.status,
      notes: body.notes,
      user: req.user
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/purchase-orders/:id/receipts', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({message: 'Purchase order not found'});
    assertBranchAccess(req.user, po.branch);
    res.json(await GoodsReceipt.find({purchaseOrder: po._id}).sort({createdAt: -1}).populate('items.ingredient receivedBy'));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/purchase-orders/:id/receive', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = receiveSchema.parse(req.body);
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
    let result;
    await session.withTransaction(async () => {
      result = await receivePurchaseOrder({
        poId: req.params.id,
        items: body.items.map(i => ({...i, expiryDate: i.expiryDate ? new Date(i.expiryDate) : undefined})),
        notes: body.notes,
        user: req.user,
        session,
        idempotencyKey
      });
    });
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
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({message: 'Purchase order not found'});
    assertBranchAccess(req.user, po.branch);
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

export default r;
