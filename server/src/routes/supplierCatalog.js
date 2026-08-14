import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {Branch} from '../models/operations.js';
import {
  catalogOptions,
  catalogPriceHistory,
  createCatalogItem,
  listCatalog,
  updateCatalogItem
} from '../services/supplierCatalog.js';
import {publishPurchasingEvent} from '../services/realtime.js';

const r = Router();
const text = z.string().trim().min(1).max(80);
const reason = z.string().trim().max(240).optional();

const createSchema = z.object({
  supplier: z.string().min(1),
  ingredient: z.string().min(1),
  supplierSku: z.string().trim().max(80).optional(),
  purchaseUnit: text,
  conversionFactor: z.number().positive().max(1000000000),
  currentPrice: z.number().positive().max(1000000000),
  priceIncludesVat: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  minOrderQty: z.number().positive().max(1000000).default(1),
  leadDays: z.number().int().min(0).max(365).default(1),
  active: z.boolean().optional(),
  reason
});

const updateSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  supplierSku: z.string().trim().max(80).optional(),
  purchaseUnit: text.optional(),
  conversionFactor: z.number().positive().max(1000000000).optional(),
  currentPrice: z.number().positive().max(1000000000).optional(),
  priceIncludesVat: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  minOrderQty: z.number().positive().max(1000000).optional(),
  leadDays: z.number().int().min(0).max(365).optional(),
  active: z.boolean().optional(),
  reason
}).refine(value => Object.keys(value).some(key => !['expectedVersion', 'reason'].includes(key)), {
  message: 'At least one catalog field is required'
});

function fail(res, error) {
  const conflict = error?.name === 'VersionError' || error?.errorLabels?.includes('TransientTransactionError');
  res.status(error.status || (conflict ? 409 : 400)).json({message: error.message || 'Supplier catalog request failed'});
}

async function publishCatalogChange(row, reason) {
  try {
    const branches = await Branch.find({restaurant: row.restaurant, active: {$ne: false}}).select('_id').lean();
    for (const branch of branches) {
      publishPurchasingEvent(branch._id, {
        reason,
        catalogItemId: String(row._id),
        supplierId: String(row.supplier?._id || row.supplier),
        ingredientId: String(row.ingredient?._id || row.ingredient)
      });
    }
  } catch (error) {
    // The database transaction is already committed; a transient notification failure must not invite a duplicate retry.
    console.error('Supplier catalog realtime publish failed', error);
  }
}

r.get('/supplier-catalog/options', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await catalogOptions({user: req.user}));
  } catch (error) {
    fail(res, error);
  }
});

r.get('/supplier-catalog/:id/price-history', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await catalogPriceHistory({catalogId: req.params.id, user: req.user, limit: req.query.limit}));
  } catch (error) {
    fail(res, error);
  }
});

r.get('/supplier-catalog', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await listCatalog({
      user: req.user,
      q: req.query.q,
      supplier: req.query.supplier,
      ingredient: req.query.ingredient,
      active: req.query.active,
      page: req.query.page,
      limit: req.query.limit
    }));
  } catch (error) {
    fail(res, error);
  }
});

r.post('/supplier-catalog', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const input = createSchema.parse(req.body);
    let row;
    await session.withTransaction(async () => {
      row = await createCatalogItem({input, user: req.user, session});
    });
    await publishCatalogChange(row, 'catalog_create');
    res.status(201).json(row);
  } catch (error) {
    fail(res, error);
  } finally {
    await session.endSession();
  }
});

r.patch('/supplier-catalog/:id', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {expectedVersion, ...patch} = updateSchema.parse(req.body);
    let row;
    await session.withTransaction(async () => {
      row = await updateCatalogItem({
        catalogId: req.params.id,
        patch,
        expectedVersion,
        user: req.user,
        session
      });
    });
    await publishCatalogChange(row, 'catalog_update');
    res.json(row);
  } catch (error) {
    fail(res, error);
  } finally {
    await session.endSession();
  }
});

export default r;
