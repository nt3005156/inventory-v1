/**
 * Customer CRM (Phase 9).
 *
 * Scope: customers are RESTAURANT-WIDE. See the Customer schema for why.
 * Every function here takes a tenant context and filters by `restaurant`, so
 * a manager can never read or write another restaurant's guest — and, unlike
 * the pre-Phase-9 branch-scoped model, one guest is one record across
 * branches so lifetime spend and loyalty actually aggregate.
 *
 * Privacy: nothing here is reachable without authentication. The public
 * storefront resolves guests through its own narrow path and never calls
 * these read/search functions.
 */
import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {Branch, Customer, Delivery, Order, Payment} from '../models/operations.js';
import {money} from './billing.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {assertTenantBranchAccess} from './kitchen.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * Normalise a Nepali phone number into a comparison key.
 *
 * "+977 9800-000001", "9779800000001" and "09800000001" are one human being.
 * Without this, phone-based deduplication is decorative: the same guest keys
 * differently depending on how they typed it.
 */
export function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  // Nepal country code, with or without a leading 00.
  if (digits.startsWith('00977')) digits = digits.slice(5);
  else if (digits.startsWith('977') && digits.length > 10) digits = digits.slice(3);
  // Trunk zero on a local number.
  if (digits.length > 10 && digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/** Escape user input before it reaches a regular expression. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the caller's restaurant, and validate a branch when one is given.
 * Staff and managers stay inside their own branch for writes that name one.
 */
export async function customerContext(user, {branchId, session} = {}) {
  const {restaurantId} = await userRestaurantContext(user);
  if (!restaurantId) throw httpError('User is not attached to a restaurant', 403);
  if (branchId) {
    await assertTenantBranchAccess(user, branchId, {session});
  }
  return {restaurantId};
}

/**
 * Loyalty tier from lifetime spend. Deliberately simple and derived, so a tier
 * can never drift out of step with what the guest actually spent.
 */
export function tierFor(lifetimeSpend) {
  const spend = Number(lifetimeSpend || 0);
  if (spend >= 100000) return 'platinum';
  if (spend >= 50000) return 'gold';
  if (spend >= 15000) return 'silver';
  return 'bronze';
}

/**
 * Recompute a customer's rollups from their orders.
 *
 * Always derived, never incremented in place: an incremented counter drifts
 * the moment an order is refunded, cancelled or edited, and a CRM whose
 * numbers cannot be trusted is worse than none.
 *
 * Revenue counts only orders that actually represent money kept — refunds are
 * subtracted, cancelled orders excluded.
 */
export async function recalculateCustomerStats(customerId, {session} = {}) {
  const customer = await Customer.findById(customerId).session(session || null);
  if (!customer) throw httpError('Customer not found', 404);

  const orders = await Order.find({customer: customer._id})
    .select('status total paidAmount refundAmount createdAt')
    .session(session || null)
    .lean();

  const revenueStatuses = new Set(['completed', 'refunded']);
  let totalSpend = 0;
  let totalRefunded = 0;
  let completedOrders = 0;
  let cancelledOrders = 0;
  let firstOrderAt = null;
  let lastOrderAt = null;

  for (const order of orders) {
    if (order.status === 'cancelled') {
      cancelledOrders += 1;
      continue;
    }
    if (revenueStatuses.has(order.status)) {
      completedOrders += 1;
      const refunded = Number(order.refundAmount || 0);
      totalRefunded += refunded;
      totalSpend += Math.max(0, Number(order.total || 0) - refunded);
    }
    const at = order.createdAt ? new Date(order.createdAt) : null;
    if (at) {
      if (!firstOrderAt || at < firstOrderAt) firstOrderAt = at;
      if (!lastOrderAt || at > lastOrderAt) lastOrderAt = at;
    }
  }

  const totalOrders = orders.length;
  const averageOrderValue = completedOrders > 0 ? money(totalSpend / completedOrders) : 0;

  customer.stats = {
    totalOrders,
    completedOrders,
    cancelledOrders,
    totalSpend: money(totalSpend),
    totalRefunded: money(totalRefunded),
    averageOrderValue,
    firstOrderAt,
    lastOrderAt,
    statsUpdatedAt: new Date()
  };
  // Loyalty: one point per hundred rupees actually kept.
  const lifetimePoints = Math.floor(money(totalSpend) / 100);
  customer.loyalty = {
    ...(customer.loyalty?.toObject?.() || customer.loyalty || {}),
    lifetimePoints,
    tier: tierFor(totalSpend),
    joinedAt: customer.loyalty?.joinedAt || customer.createdAt || new Date()
  };
  if (customer.loyalty.points === undefined || customer.loyalty.points === null) {
    customer.loyalty.points = lifetimePoints;
  }
  // Keep the legacy fields in step for anything still reading them.
  customer.totalSpend = customer.stats.totalSpend;
  customer.lastOrderAt = lastOrderAt;
  customer.loyaltyPoints = customer.loyalty.points;

  await customer.save({session: session || undefined});
  return customer;
}

/**
 * Find an existing profile by phone, or create one.
 *
 * This is the single dedupe entry point, used by the CRM, the POS and the
 * public storefront alike, so every channel converges on one record per
 * person. The unique index is the real guarantee: on a duplicate-key race the
 * winner is re-read rather than a second profile being created.
 */
export async function findOrCreateCustomer({
  restaurantId, branchId, name, phone, email, address, session
}) {
  const phoneKey = normalizePhone(phone);
  if (!phoneKey) throw httpError('A phone number is required', 400);

  const existing = await Customer.findOne({restaurant: restaurantId, phoneKey})
    .session(session || null);

  if (existing) {
    let dirty = false;
    // Fill blanks from the newer contact, but never overwrite a known value:
    // a typo at the till must not rewrite an established profile.
    if (!clean(existing.name) && clean(name)) { existing.name = clean(name); dirty = true; }
    if (!clean(existing.email) && clean(email)) { existing.email = clean(email); dirty = true; }
    if (address && !(existing.addresses || []).some(a => clean(a.address) === clean(address))) {
      existing.addresses.push({label: 'Delivery', address: clean(address), default: false});
      dirty = true;
    }
    if (dirty) await existing.save({session: session || undefined});
    return {customer: existing, created: false};
  }

  try {
    const [created] = await Customer.create([{
      restaurant: restaurantId,
      branch: branchId || undefined,
      name: clean(name),
      phone: clean(phone),
      phoneKey,
      email: clean(email) || undefined,
      addresses: address ? [{label: 'Delivery', address: clean(address), default: true}] : [],
      loyalty: {points: 0, tier: 'bronze', lifetimePoints: 0, joinedAt: new Date()}
    }], {session: session || undefined});
    return {customer: created, created: true};
  } catch (error) {
    // Lost a concurrent race: the other writer's record is the right one.
    if (error?.code === 11000) {
      const winner = await Customer.findOne({restaurant: restaurantId, phoneKey})
        .session(session || null);
      if (winner) return {customer: winner, created: false};
    }
    throw error;
  }
}

/**
 * Search across phone, name, email and customer id.
 *
 * Phone matching runs on the normalised key so a formatted query still finds
 * the guest. Everything is scoped to the caller's restaurant.
 */
export async function searchCustomers({
  user, q, branchId, includeInactive = false, tag, page = 1, limit = 25
}) {
  const {restaurantId} = await customerContext(user, {branchId});

  const filter = {restaurant: restaurantId};
  if (!includeInactive) filter.active = {$ne: false};
  if (branchId) filter.branch = new mongoose.Types.ObjectId(String(branchId));
  if (clean(tag)) filter.tags = clean(tag).toLowerCase();

  const term = clean(q);
  if (term) {
    const or = [];
    // Customer id — an exact handle, so try it first.
    if (mongoose.isValidObjectId(term)) or.push({_id: new mongoose.Types.ObjectId(term)});
    const phoneKey = normalizePhone(term);
    if (phoneKey) {
      or.push({phoneKey});
      // Partial phone entry is how staff actually search at a counter.
      if (phoneKey.length >= 3) or.push({phoneKey: new RegExp(escapeRegex(phoneKey))});
    }
    const safe = escapeRegex(term);
    or.push({name: new RegExp(safe, 'i')});
    or.push({email: new RegExp(safe, 'i')});
    filter.$or = or;
  }

  const perPage = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const current = Math.max(Number(page) || 1, 1);

  const [customers, total] = await Promise.all([
    Customer.find(filter)
      .sort({'stats.lastOrderAt': -1, createdAt: -1})
      .skip((current - 1) * perPage)
      .limit(perPage)
      .populate('branch', 'name code')
      .lean(),
    Customer.countDocuments(filter)
  ]);

  return {
    customers,
    total,
    page: current,
    pages: Math.max(1, Math.ceil(total / perPage)),
    scope: 'restaurant'
  };
}

/** Load one customer, enforcing the tenant boundary. */
export async function getCustomer({user, customerId, session}) {
  if (!mongoose.isValidObjectId(customerId)) throw httpError('Invalid customer', 400);
  const {restaurantId} = await customerContext(user);
  const customer = await Customer.findOne({_id: customerId, restaurant: restaurantId})
    .session(session || null)
    .populate('branch', 'name code')
    .populate('preferences.favouriteItems', 'name price');
  // A customer in another restaurant is reported as missing, not as forbidden:
  // "403" would confirm the record exists.
  if (!customer) throw httpError('Customer not found', 404);
  return customer;
}

/**
 * Full relationship history: orders, payments, refunds, cancellations and
 * deliveries. This is what makes the profile useful at the counter.
 */
export async function getCustomerHistory({user, customerId, limit = 50}) {
  const customer = await getCustomer({user, customerId});

  const orders = await Order.find({customer: customer._id})
    .sort({createdAt: -1})
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .select('orderNo status type total paidAmount dueAmount refundAmount createdAt completedAt branch invoiceNo paymentMethod deliveryAddress items')
    .populate('branch', 'name code')
    .lean();

  const orderIds = orders.map(o => o._id);
  const [payments, deliveries] = await Promise.all([
    Payment.find({order: {$in: orderIds}}).sort({createdAt: -1}).lean(),
    Delivery.find({order: {$in: orderIds}}).sort({createdAt: -1}).populate('rider', 'name').lean()
  ]);

  const paymentsByOrder = new Map();
  for (const payment of payments) {
    const key = String(payment.order);
    if (!paymentsByOrder.has(key)) paymentsByOrder.set(key, []);
    paymentsByOrder.get(key).push(payment);
  }
  const deliveryByOrder = new Map(deliveries.map(d => [String(d.order), d]));

  return {
    customer,
    orders: orders.map(order => ({
      ...order,
      itemCount: (order.items || []).reduce((sum, i) => sum + Number(i.qty || 0), 0),
      items: undefined,
      payments: paymentsByOrder.get(String(order._id)) || [],
      delivery: deliveryByOrder.get(String(order._id)) || null
    })),
    // Refunds are payments recorded against a refunded parent.
    refunds: payments.filter(p => p.status === 'refunded' || p.refundOf),
    cancellations: orders.filter(o => o.status === 'cancelled'),
    deliveries
  };
}

/** Create a profile from the CRM. Deduplicates on phone. */
export async function createCustomer({user, input}) {
  const {restaurantId} = await customerContext(user, {branchId: input.branch});

  const phoneKey = normalizePhone(input.phone);
  if (!phoneKey) throw httpError('A valid phone number is required', 400);

  const existing = await Customer.findOne({restaurant: restaurantId, phoneKey});
  if (existing) {
    // Surfacing the existing record is more useful than a bare conflict: the
    // UI can offer to open it instead of silently failing.
    throw Object.assign(
      httpError('A customer with this phone number already exists', 409),
      {existingCustomerId: String(existing._id)}
    );
  }

  const customer = await Customer.create({
    restaurant: restaurantId,
    branch: input.branch || undefined,
    name: clean(input.name),
    phone: clean(input.phone),
    phoneKey,
    email: clean(input.email) || undefined,
    addresses: input.addresses || [],
    notes: clean(input.notes) || undefined,
    preferences: input.preferences || undefined,
    tags: (input.tags || []).map(t => clean(t).toLowerCase()).filter(Boolean),
    loyalty: {points: 0, tier: 'bronze', lifetimePoints: 0, joinedAt: new Date()}
  });

  await Audit.create({
    entity: 'customer', entityId: customer._id, branch: customer.branch,
    action: 'customer_created',
    after: {name: customer.name, phone: customer.phone}, user: user.id
  });
  return customer;
}

/**
 * Update a profile. Stats and loyalty totals are NOT writable here — they are
 * derived, and letting an operator type a lifetime-spend figure would make
 * every report a guess.
 */
export async function updateCustomer({user, customerId, input}) {
  const customer = await getCustomer({user, customerId});
  const before = {
    name: customer.name, phone: customer.phone, email: customer.email,
    notes: customer.notes, tags: [...(customer.tags || [])]
  };

  if (input.phone !== undefined) {
    const phoneKey = normalizePhone(input.phone);
    if (!phoneKey) throw httpError('A valid phone number is required', 400);
    if (phoneKey !== customer.phoneKey) {
      const clash = await Customer.findOne({
        restaurant: customer.restaurant, phoneKey, _id: {$ne: customer._id}
      });
      if (clash) throw httpError('Another customer already uses this phone number', 409);
      customer.phone = clean(input.phone);
      customer.phoneKey = phoneKey;
    }
  }
  if (input.name !== undefined) customer.name = clean(input.name);
  if (input.email !== undefined) customer.email = clean(input.email) || undefined;
  if (input.notes !== undefined) customer.notes = clean(input.notes) || undefined;
  if (input.addresses !== undefined) customer.addresses = input.addresses;
  if (input.tags !== undefined) {
    customer.tags = input.tags.map(t => clean(t).toLowerCase()).filter(Boolean);
  }
  if (input.preferences !== undefined) {
    customer.preferences = {...(customer.preferences?.toObject?.() || {}), ...input.preferences};
  }
  if (input.branch !== undefined && input.branch) {
    await assertTenantBranchAccess(user, input.branch);
    customer.branch = input.branch;
  }

  await customer.save();
  await Audit.create({
    entity: 'customer', entityId: customer._id, branch: customer.branch,
    action: 'customer_updated', before,
    after: {name: customer.name, phone: customer.phone, email: customer.email}, user: user.id
  });
  return customer;
}

/**
 * Deactivate (soft delete).
 *
 * Customers are never hard-deleted: orders reference them, and destroying a
 * profile would orphan financial history and corrupt past reports. Owners get
 * a reversible switch instead.
 */
export async function setCustomerActive({user, customerId, active, reason}) {
  const customer = await getCustomer({user, customerId});
  customer.active = Boolean(active);
  if (!active) {
    customer.deactivatedAt = new Date();
    customer.deactivatedBy = user.id;
    customer.deactivationReason = clean(reason) || undefined;
  } else {
    customer.deactivatedAt = null;
    customer.deactivatedBy = null;
    customer.deactivationReason = undefined;
  }
  await customer.save();
  await Audit.create({
    entity: 'customer', entityId: customer._id, branch: customer.branch,
    action: active ? 'customer_reactivated' : 'customer_deactivated',
    after: {active: customer.active, reason: customer.deactivationReason}, user: user.id
  });
  return customer;
}

/**
 * Merge a duplicate into a surviving profile.
 *
 * Historic data created two records for one person (the pre-Phase-9 model made
 * this routine across branches). Merging repoints the orders, unions the
 * addresses, and leaves a tombstone pointing at the survivor so old links
 * still resolve.
 */
export async function mergeCustomers({user, sourceId, targetId}) {
  if (String(sourceId) === String(targetId)) {
    throw httpError('A customer cannot be merged into itself', 400);
  }
  const source = await getCustomer({user, customerId: sourceId});
  const target = await getCustomer({user, customerId: targetId});

  const session = await mongoose.startSession();
  try {
    let merged;
    await session.withTransaction(async () => {
      await Order.updateMany({customer: source._id}, {$set: {customer: target._id}}, {session});

      for (const address of source.addresses || []) {
        if (!(target.addresses || []).some(a => clean(a.address) === clean(address.address))) {
          target.addresses.push({label: address.label, address: address.address, default: false});
        }
      }
      if (!clean(target.email) && clean(source.email)) target.email = source.email;
      if (!clean(target.notes) && clean(source.notes)) target.notes = source.notes;
      target.tags = [...new Set([...(target.tags || []), ...(source.tags || [])])];
      target.loyalty.points = Number(target.loyalty?.points || 0) + Number(source.loyalty?.points || 0);
      await target.save({session});

      // Tombstone: retire the duplicate but keep the pointer.
      // Free the phone key so the constraint does not block the survivor.
      // This must be an explicit $unset via the driver: the schema's
      // pre-validate hook re-derives phoneKey from phone on every save, so
      // clearing the field on the document would simply be undone.
      await Customer.collection.updateOne(
        {_id: source._id},
        {
          $set: {
            active: false,
            mergedInto: target._id,
            deactivatedAt: new Date(),
            deactivatedBy: new mongoose.Types.ObjectId(String(user.id)),
            deactivationReason: `Merged into ${target._id}`
          },
          $unset: {phoneKey: ''}
        },
        {session}
      );

      merged = target;
    });

    await recalculateCustomerStats(merged._id);
    await Audit.create({
      entity: 'customer', entityId: merged._id, branch: merged.branch,
      action: 'customer_merged',
      before: {source: String(source._id)}, after: {target: String(merged._id)}, user: user.id
    });
    return await getCustomer({user, customerId: merged._id});
  } finally {
    session.endSession();
  }
}

/**
 * Address book operations (Phase 10).
 *
 * Addresses are edited individually rather than by replacing the whole array,
 * so two staff members editing different addresses cannot clobber each other.
 * Exactly one address may be the default, and that invariant is enforced here
 * rather than trusted to the caller.
 */
function applyDefaultInvariant(customer, defaultIndex) {
  customer.addresses.forEach((address, index) => {
    address.default = index === defaultIndex;
  });
}

export async function addCustomerAddress({user, customerId, input}) {
  const customer = await getCustomer({user, customerId});
  if ((customer.addresses || []).length >= 10) {
    throw httpError('A customer may keep at most 10 addresses', 409);
  }
  const address = clean(input.address);
  if (address.length < 5) throw httpError('A usable street address is required', 400);
  // The same place saved twice is a data-entry slip, not two addresses.
  if ((customer.addresses || []).some(a => clean(a.address).toLowerCase() === address.toLowerCase())) {
    throw httpError('That address is already saved for this customer', 409);
  }

  customer.addresses.push({
    label: clean(input.label) || 'Home',
    address,
    instructions: clean(input.instructions) || undefined,
    default: false
  });
  // The first address a customer ever has must be their default, otherwise
  // delivery has nothing to fall back on.
  const index = customer.addresses.length - 1;
  if (customer.addresses.length === 1 || input.default) applyDefaultInvariant(customer, index);

  await customer.save();
  await Audit.create({
    entity: 'customer', entityId: customer._id, branch: customer.branch,
    action: 'customer_address_added', after: {label: input.label, address}, user: user.id
  });
  return customer;
}

export async function updateCustomerAddress({user, customerId, addressId, input}) {
  const customer = await getCustomer({user, customerId});
  const target = customer.addresses.id(addressId);
  if (!target) throw httpError('Address not found', 404);

  if (input.address !== undefined) {
    const address = clean(input.address);
    if (address.length < 5) throw httpError('A usable street address is required', 400);
    target.address = address;
  }
  if (input.label !== undefined) target.label = clean(input.label) || 'Home';
  if (input.instructions !== undefined) {
    target.instructions = clean(input.instructions) || undefined;
  }
  if (input.default === true) {
    applyDefaultInvariant(customer, customer.addresses.indexOf(target));
  }

  await customer.save();
  await Audit.create({
    entity: 'customer', entityId: customer._id, branch: customer.branch,
    action: 'customer_address_updated', after: {address: target.address}, user: user.id
  });
  return customer;
}

export async function removeCustomerAddress({user, customerId, addressId}) {
  const customer = await getCustomer({user, customerId});
  const target = customer.addresses.id(addressId);
  if (!target) throw httpError('Address not found', 404);

  const wasDefault = target.default;
  target.deleteOne();
  // Never leave a customer with addresses but no default.
  if (wasDefault && customer.addresses.length) applyDefaultInvariant(customer, 0);

  await customer.save();
  await Audit.create({
    entity: 'customer', entityId: customer._id, branch: customer.branch,
    action: 'customer_address_removed', before: {address: target.address}, user: user.id
  });
  return customer;
}

/** Manual loyalty adjustment, always audited. */
export async function adjustLoyaltyPoints({user, customerId, delta, reason}) {
  const customer = await getCustomer({user, customerId});
  const change = Number(delta);
  if (!Number.isFinite(change) || change === 0) {
    throw httpError('A non-zero point adjustment is required', 400);
  }
  const before = Number(customer.loyalty?.points || 0);
  const after = before + change;
  if (after < 0) throw httpError('Loyalty points cannot go negative', 400);

  customer.loyalty.points = after;
  customer.loyaltyPoints = after;
  await customer.save();

  await Audit.create({
    entity: 'customer', entityId: customer._id, branch: customer.branch,
    action: 'customer_loyalty_adjusted',
    before: {points: before}, after: {points: after, reason: clean(reason) || null}, user: user.id
  });
  return customer;
}

/**
 * Refresh rollups after an order changes, without ever breaking the operation
 * that triggered it.
 *
 * Stats are a reporting concern: a failure here must not roll back a payment
 * or a refund. Call this AFTER the transaction commits.
 */
export async function refreshCustomerStatsSafe(customerId) {
  if (!customerId) return null;
  try {
    return await recalculateCustomerStats(customerId);
  } catch {
    // Deliberately swallowed. The nightly/manual recalculate endpoint repairs
    // any drift, and a CRM number is never worth failing a sale over.
    return null;
  }
}

/** Aggregate CRM figures for the workspace header. */
export async function customerSummary({user, branchId}) {
  const {restaurantId} = await customerContext(user, {branchId});
  const match = {restaurant: restaurantId, active: {$ne: false}};
  if (branchId) match.branch = new mongoose.Types.ObjectId(String(branchId));

  const [totals] = await Customer.aggregate([
    {$match: match},
    {$group: {
      _id: null,
      customers: {$sum: 1},
      totalSpend: {$sum: '$stats.totalSpend'},
      totalOrders: {$sum: '$stats.totalOrders'},
      loyaltyPoints: {$sum: '$loyalty.points'}
    }}
  ]);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [active, repeat] = await Promise.all([
    Customer.countDocuments({...match, 'stats.lastOrderAt': {$gte: thirtyDaysAgo}}),
    Customer.countDocuments({...match, 'stats.completedOrders': {$gte: 2}})
  ]);

  const customers = totals?.customers || 0;
  return {
    customers,
    activeLast30Days: active,
    repeatCustomers: repeat,
    totalSpend: money(totals?.totalSpend || 0),
    totalOrders: totals?.totalOrders || 0,
    loyaltyPoints: totals?.loyaltyPoints || 0,
    averageSpendPerCustomer: customers ? money((totals?.totalSpend || 0) / customers) : 0
  };
}
