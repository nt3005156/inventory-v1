/**
 * CRM API (Phase 9).
 *
 * Every route is authenticated. There is deliberately NO public equivalent:
 * customer records are personal data and the storefront never reads them.
 *
 * RBAC:
 *   staff            — search, read, create, update (they serve the guest)
 *   manager / owner   — plus loyalty adjustments and merges
 *   owner            — plus deactivation/reactivation
 */
import {Router} from 'express';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {assertTenantBranchAccess} from '../services/kitchen.js';
import {
  addCustomerAddress,
  adjustLoyaltyPoints,
  createCustomer,
  customerSummary,
  getCustomer,
  getCustomerHistory,
  mergeCustomers,
  removeCustomerAddress,
  updateCustomerAddress,
  recalculateCustomerStats,
  searchCustomers,
  setCustomerActive,
  updateCustomer
} from '../services/customers.js';

const r = Router();

function fail(res, error) {
  const status = error?.status || (error?.name === 'ZodError' ? 400 : 500);
  let message = error?.message || 'Server error';
  if (error?.name === 'ZodError') {
    const issue = Array.isArray(error.issues) ? error.issues[0] : null;
    const field = issue?.path?.length ? issue.path.join('.') : null;
    message = field ? `Invalid ${field}` : 'Some details are missing or invalid';
  } else if (status >= 500) {
    message = 'Server error';
  }
  const body = {message: String(message).slice(0, 300)};
  // Surfaced deliberately so the UI can offer to open the existing profile
  // instead of leaving the operator stuck on a conflict.
  if (error?.existingCustomerId) body.existingCustomerId = error.existingCustomerId;
  return res.status(status).json(body);
}

const addressSchema = z.object({
  label: z.string().trim().max(60).optional(),
  address: z.string().trim().min(1).max(300),
  instructions: z.string().trim().max(300).optional(),
  default: z.boolean().optional()
});

// Phase 10: addresses are managed individually so concurrent edits to
// different addresses cannot overwrite one another.
const addressCreateSchema = z.object({
  label: z.string().trim().max(60).optional(),
  address: z.string().trim().min(5).max(300),
  instructions: z.string().trim().max(300).optional(),
  default: z.boolean().optional()
}).strict();

const addressUpdateSchema = addressCreateSchema.partial().strict();

const preferencesSchema = z.object({
  dietary: z.enum(['none', 'vegetarian', 'vegan', 'halal', 'jain']).optional(),
  spiceLevel: z.enum(['none', 'mild', 'medium', 'hot', 'extra-hot']).optional(),
  allergies: z.array(z.string().trim().max(60)).max(20).optional(),
  favouriteItems: z.array(z.string()).max(30).optional(),
  seating: z.string().trim().max(60).optional(),
  contactPreference: z.enum(['phone', 'sms', 'email', 'none']).optional(),
  marketingOptIn: z.boolean().optional()
}).strict();

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(160).optional().or(z.literal('')),
  branch: z.string().optional(),
  addresses: z.array(addressSchema).max(10).optional(),
  notes: z.string().trim().max(2000).optional(),
  preferences: preferencesSchema.optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional()
}).strict();

const updateSchema = createSchema.partial().strict();

// ── Reads ────────────────────────────────────────────────────────────────────

/** Aggregate figures for the CRM header. Declared before /:id. */
r.get('/customers/summary', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await customerSummary({user: req.user, branchId: req.query.branch}));
  } catch (e) {
    fail(res, e);
  }
});

/** Search by phone, name, email or customer id. */
r.get('/customers/search', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await searchCustomers({
      user: req.user,
      q: req.query.q,
      branchId: req.query.branch,
      tag: req.query.tag,
      includeInactive: req.query.includeInactive === 'true',
      page: req.query.page,
      limit: req.query.limit
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/customers/:id/history', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await getCustomerHistory({
      user: req.user, customerId: req.params.id, limit: req.query.limit
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/customers/:id', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await getCustomer({user: req.user, customerId: req.params.id}));
  } catch (e) {
    fail(res, e);
  }
});

// ── Writes ───────────────────────────────────────────────────────────────────

r.post('/customers/:id/recalculate', auth(['owner', 'manager']), async (req, res) => {
  try {
    // Prove tenancy before touching the record.
    await getCustomer({user: req.user, customerId: req.params.id});
    res.json(await recalculateCustomerStats(req.params.id));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/customers/:id/loyalty', auth(['owner', 'manager']), async (req, res) => {
  try {
    const body = z.object({
      delta: z.number().int(),
      reason: z.string().trim().max(300).optional()
    }).strict().parse(req.body || {});
    res.json(await adjustLoyaltyPoints({
      user: req.user, customerId: req.params.id, delta: body.delta, reason: body.reason
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/customers/merge', auth(['owner', 'manager']), async (req, res) => {
  try {
    const body = z.object({source: z.string(), target: z.string()}).strict().parse(req.body || {});
    res.json(await mergeCustomers({
      user: req.user, sourceId: body.source, targetId: body.target
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/customers/:id/active', auth(['owner']), async (req, res) => {
  try {
    const body = z.object({
      active: z.boolean(),
      reason: z.string().trim().max(300).optional()
    }).strict().parse(req.body || {});
    res.json(await setCustomerActive({
      user: req.user, customerId: req.params.id, active: body.active, reason: body.reason
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/customers/:id/addresses', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const body = addressCreateSchema.parse(req.body || {});
    res.status(201).json(await addCustomerAddress({
      user: req.user, customerId: req.params.id, input: body
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/customers/:id/addresses/:addressId', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const body = addressUpdateSchema.parse(req.body || {});
    res.json(await updateCustomerAddress({
      user: req.user, customerId: req.params.id, addressId: req.params.addressId, input: body
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.delete('/customers/:id/addresses/:addressId', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    res.json(await removeCustomerAddress({
      user: req.user, customerId: req.params.id, addressId: req.params.addressId
    }));
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/customers/:id', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const body = updateSchema.parse(req.body || {});
    res.json(await updateCustomer({user: req.user, customerId: req.params.id, input: body}));
  } catch (e) {
    fail(res, e);
  }
});

/**
 * A hard delete is deliberately not offered: orders reference customers and
 * destroying a profile would orphan financial history. 405 says so explicitly
 * rather than 404, which would look like a routing mistake.
 */
r.delete('/customers/:id', auth(['owner']), (_req, res) => {
  res.status(405).json({
    message: 'Customers are deactivated, not deleted, because orders reference them. Use PATCH /customers/:id/active.'
  });
});

r.post('/customers', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    // Authorization BEFORE validation. If the caller has no right to the named
    // branch, they must be denied outright — answering 400 would tell them
    // their payload was merely malformed and invite them to retry, and it
    // discloses that validation ran against another tenant's branch at all.
    if (req.body?.branch) await assertTenantBranchAccess(req.user, req.body.branch);
    const body = createSchema.parse(req.body || {});
    res.status(201).json(await createCustomer({user: req.user, input: body}));
  } catch (e) {
    fail(res, e);
  }
});

export default r;
