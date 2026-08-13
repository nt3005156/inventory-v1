import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {PurchaseOrder} from '../models/operations.js';
import {GoodsReceipt} from '../models/purchasing.js';
import {assertBranchAccess} from '../services/kitchen.js';
import {receivePurchaseOrder} from '../services/receiving.js';

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

export default r;
