import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {Branch} from '../models/operations.js';
import {
  catalogOptions,
  catalogPriceHistory,
  createCatalogItem,
  createSupplier,
  listCatalog,
  listSuppliers,
  updateCatalogItem,
  updateSupplier
} from '../services/supplierCatalog.js';
import {ensureSupplierCatalogIndexes} from '../services/supplierCatalogMigration.js';
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
}).strict().refine(value => Object.keys(value).some(key => !['expectedVersion', 'reason'].includes(key)), {
  message: 'At least one catalog field is required'
});

const supplierFields = {
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(120).optional(),
  address: z.string().trim().max(240).optional(),
  paymentTerms: z.string().trim().max(120).optional(),
  active: z.boolean().optional(),
  reason
};
const supplierCreateSchema = z.object(supplierFields).strict();
const supplierUpdateSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  ...Object.fromEntries(Object.entries(supplierFields).map(([key, value]) => [key, value.optional()]))
}).strict().refine(value => Object.keys(value).some(key => !['expectedVersion', 'reason'].includes(key)), {
  message: 'At least one supplier field is required'
});
const supplierQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().max(1000000).optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
}).strict();

function fail(res, error) {
  const conflict = error?.name === 'VersionError' || error?.errorLabels?.includes('TransientTransactionError');
  res.status(error.status || (conflict ? 409 : 400)).json({message: error.message || 'Supplier catalog request failed'});
}

async function publishRestaurantCatalogChange(restaurant, payload) {
  try {
    const branches = await Branch.find({restaurant, active: {$ne: false}}).select('_id').lean();
    for (const branch of branches) publishPurchasingEvent(branch._id, payload);
  } catch (error) {
    // The database transaction is already committed; a transient notification failure must not invite a duplicate retry.
    console.error('Supplier catalog realtime publish failed', error);
  }
}

async function publishCatalogChange(row, changeReason) {
  await publishRestaurantCatalogChange(row.restaurant, {
    reason: changeReason,
    catalogItemId: String(row._id),
    supplierId: String(row.supplier?._id || row.supplier),
    ingredientId: String(row.ingredient?._id || row.ingredient)
  });
}

async function publishSupplierChange(row, changeReason) {
  await publishRestaurantCatalogChange(row.restaurant, {
    reason: changeReason,
    supplierId: String(row._id)
  });
}

r.get('/suppliers', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const query = supplierQuerySchema.parse(req.query);
    res.json(await listSuppliers({user: req.user, ...query}));
  } catch (error) {
    fail(res, error);
  }
});

r.post('/suppliers', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const input = supplierCreateSchema.parse(req.body);
    await ensureSupplierCatalogIndexes();
    let row;
    await session.withTransaction(async () => {
      row = await createSupplier({input, user: req.user, session});
    });
    await publishSupplierChange(row, 'catalog_supplier_create');
    res.status(201).json(row);
  } catch (error) {
    fail(res, error);
  } finally {
    await session.endSession();
  }
});

r.patch('/suppliers/:id', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {expectedVersion, ...patch} = supplierUpdateSchema.parse(req.body);
    await ensureSupplierCatalogIndexes();
    let row;
    await session.withTransaction(async () => {
      row = await updateSupplier({supplierId: req.params.id, patch, expectedVersion, user: req.user, session});
    });
    await publishSupplierChange(row, 'catalog_supplier_update');
    res.json(row);
  } catch (error) {
    fail(res, error);
  } finally {
    await session.endSession();
  }
});

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
