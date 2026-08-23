import {Router} from 'express';
import {z} from 'zod';
import {requirePermission} from '../middleware/auth.js';
import {
  ONBOARDING_STEPS, addBranch, addIngredients, addMenu, addSuppliers, addTables, addTeam,
  onboardingStatus
} from '../services/onboarding.js';

/**
 * Phase 24 — new-restaurant onboarding.
 *
 *   Restaurant -> Branch -> Users -> Ingredients -> Suppliers -> Menu -> Tables
 *
 * Step 1 (restaurant + first owner) is a BOOTSTRAP and is deliberately NOT
 * mounted here. There is no authenticated principal inside a tenant that does
 * not exist yet, so an HTTP route for it would be an unauthenticated
 * tenant-minting endpoint. It lives in `services/onboarding.js` and is reached
 * through the seed script and the provisioning CLI.
 *
 * Every route below requires an authenticated caller and is scoped to that
 * caller's own restaurant. Each reuses the permission that already guards the
 * equivalent operation elsewhere — onboarding is a sequence over existing
 * capabilities, not a new authorisation system.
 */

const r = Router();

function fail(res, error) {
  const status = error?.status || (error?.name === 'ZodError' ? 400 : 500);
  let message = error?.message || 'Request failed';
  if (error?.name === 'ZodError') {
    const issue = Array.isArray(error.issues) ? error.issues[0] : null;
    const field = issue?.path?.length ? issue.path.join('.') : null;
    message = field ? `Invalid ${field}` : 'Some details are missing or invalid';
  } else if (status >= 500) {
    message = 'Server error';
  }
  return res.status(status).json({message: String(message).slice(0, 300)});
}

/** Progress, derived by counting rather than from a stored flag. */
r.get('/onboarding/status', requirePermission('branches.view'), async (req, res) => {
  try {
    res.json(await onboardingStatus({user: req.user}));
  } catch (e) { fail(res, e); }
});

/** The canonical step order, so the UI is not a second hard-coded copy. */
r.get('/onboarding/steps', requirePermission('branches.view'), async (req, res) => {
  try {
    res.json({steps: ONBOARDING_STEPS});
  } catch (e) { fail(res, e); }
});

const branchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(8),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(30).optional()
}).strict();

r.post('/onboarding/branch', requirePermission('branches.manage'), async (req, res) => {
  try {
    res.status(201).json(await addBranch({user: req.user, input: branchSchema.parse(req.body ?? {})}));
  } catch (e) { fail(res, e); }
});

const teamSchema = z.object({
  members: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(160),
    password: z.string().min(1).max(200),
    role: z.enum(['manager', 'staff', 'rider']),
    branch: z.string().optional(),
    phone: z.string().trim().max(30).optional(),
    vehicle: z.string().trim().max(30).optional(),
    licencePlate: z.string().trim().max(30).optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
    notes: z.string().trim().max(500).optional()
  })).min(1).max(50)
}).strict();

r.post('/onboarding/users', requirePermission('users.create'), async (req, res) => {
  try {
    res.status(201).json(await addTeam({user: req.user, members: teamSchema.parse(req.body ?? {}).members}));
  } catch (e) { fail(res, e); }
});

const ingredientsSchema = z.object({
  items: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    code: z.string().trim().max(30).optional(),
    nameNp: z.string().trim().max(120).optional(),
    category: z.string().trim().max(60).optional(),
    unit: z.string().trim().max(30).optional(),
    minimumStock: z.number().min(0).optional(),
    reorderQty: z.number().min(0).optional(),
    reorderLevel: z.number().min(0).optional(),
    lastPurchasePrice: z.number().min(0).optional(),
    shelfLifeDays: z.number().int().min(0).max(3650).optional(),
    storage: z.string().trim().max(120).optional()
  })).min(1).max(500)
}).strict();

r.post('/onboarding/ingredients', requirePermission('ingredients.manage'), async (req, res) => {
  try {
    res.status(201).json(await addIngredients({user: req.user, items: ingredientsSchema.parse(req.body ?? {}).items}));
  } catch (e) { fail(res, e); }
});

const suppliersSchema = z.object({
  items: z.array(z.object({
    name: z.string().trim().min(2).max(160),
    contact: z.string().trim().max(60).optional(),
    email: z.string().trim().max(160).optional(),
    address: z.string().trim().max(300).optional(),
    paymentTerms: z.string().trim().max(60).optional()
  })).min(1).max(200)
}).strict();

r.post('/onboarding/suppliers', requirePermission('suppliers.manage'), async (req, res) => {
  try {
    res.status(201).json(await addSuppliers({user: req.user, items: suppliersSchema.parse(req.body ?? {}).items}));
  } catch (e) { fail(res, e); }
});

const menuSchema = z.object({
  items: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    nameNp: z.string().trim().max(120).optional(),
    code: z.string().trim().max(30).optional(),
    category: z.string().trim().max(60).optional(),
    price: z.number().positive(),
    vatInclusive: z.boolean().optional(),
    packagingCost: z.number().min(0).optional(),
    prepMinutes: z.number().min(0).max(600).optional(),
    station: z.string().trim().max(40).optional(),
    recipe: z.array(z.object({
      ingredient: z.string(),
      qty: z.number().positive(),
      unit: z.string().trim().max(30).optional()
    })).max(50).optional()
  })).min(1).max(500)
}).strict();

r.post('/onboarding/menu', requirePermission('menu.manage'), async (req, res) => {
  try {
    res.status(201).json(await addMenu({user: req.user, items: menuSchema.parse(req.body ?? {}).items}));
  } catch (e) { fail(res, e); }
});

const tablesSchema = z.object({
  branch: z.string(),
  items: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    area: z.string().trim().max(60).optional(),
    seats: z.number().int().min(1).max(50).optional()
  })).min(1).max(200)
}).strict();

r.post('/onboarding/tables', requirePermission('tables.configure'), async (req, res) => {
  try {
    const body = tablesSchema.parse(req.body ?? {});
    res.status(201).json(await addTables({user: req.user, branchId: body.branch, items: body.items}));
  } catch (e) { fail(res, e); }
});

export default r;
