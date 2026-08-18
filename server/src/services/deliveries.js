/**
 * Delivery operations (Phase 10).
 *
 * Two authorisation models meet here and must not be confused:
 *
 *   STAFF  (owner/manager/staff) are scoped by BRANCH. They see and dispatch
 *          everything in the branches they may access.
 *   RIDERS are scoped by ASSIGNMENT. A rider sees only deliveries assigned to
 *          them — never a branch queue, never another rider's job, and never
 *          anything at all before it is assigned to them.
 *
 * The rider rule is enforced in one place (`riderDeliveryOrFail`) and every
 * rider-facing path goes through it, so there is no route where the check can
 * be forgotten.
 */
import mongoose from 'mongoose';
import {Audit, User} from '../models/index.js';
import {Branch, Customer, DELIVERY_TRANSITIONS, Delivery, Order} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {publishKitchenOrder, publishDeliveryEvent} from './realtime.js';
import {stampStage} from './kds.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Statuses that still represent work in progress. */
export const LIVE_DELIVERY_STATUSES = Object.freeze([
  'pending', 'assigned', 'picked_up', 'out_for_delivery'
]);

/** An order must be at least this far along before it can go out. */
const DISPATCHABLE_ORDER_STATUSES = Object.freeze([
  'confirmed', 'accepted', 'preparing', 'ready', 'out_for_delivery'
]);

export function canTransitionDelivery(from, to) {
  return (DELIVERY_TRANSITIONS[from] || []).includes(to);
}

export function assertDeliveryTransition(from, to) {
  if (!to) throw httpError('A delivery status is required', 400);
  if (!DELIVERY_TRANSITIONS[to]) throw httpError(`Unknown delivery status: ${to}`, 400);
  if (from === to) throw httpError(`This delivery is already ${to}`, 409);
  if (!canTransitionDelivery(from, to)) {
    throw httpError(`A ${from} delivery cannot become ${to}`, 409);
  }
}

// ── Rider management ─────────────────────────────────────────────────────────

/** Riders belonging to the caller's restaurant. */
export async function listRiders({user, branchId, availableOnly = false, includeInactive = false}) {
  const {restaurantId} = await userRestaurantContext(user);
  const filter = {role: 'rider', restaurantId};
  if (branchId) {
    await assertTenantBranchAccess(user, branchId);
    filter.branch = new mongoose.Types.ObjectId(String(branchId));
  }
  if (!includeInactive) filter['rider.active'] = {$ne: false};
  if (availableOnly) filter['rider.available'] = true;

  const riders = await User.find(filter)
    .select('name email branch rider')
    .populate('branch', 'name code')
    .lean();

  // Live load, so a dispatcher can see who is already busy.
  const loads = await Delivery.aggregate([
    {$match: {rider: {$in: riders.map(r => r._id)}, status: {$in: [...LIVE_DELIVERY_STATUSES]}}},
    {$group: {_id: '$rider', active: {$sum: 1}}}
  ]);
  const loadByRider = new Map(loads.map(l => [String(l._id), l.active]));

  return riders.map(rider => ({
    ...rider,
    activeDeliveries: loadByRider.get(String(rider._id)) || 0,
    atCapacity: (loadByRider.get(String(rider._id)) || 0) >= Number(rider.rider?.maxConcurrent || 3)
  }));
}

/** Update a rider's profile, employment state or shift availability. */
export async function updateRiderProfile({user, riderId, input}) {
  const {restaurantId} = await userRestaurantContext(user);
  if (!mongoose.isValidObjectId(riderId)) throw httpError('Invalid rider', 400);

  const rider = await User.findOne({_id: riderId, role: 'rider', restaurantId});
  // A rider in another restaurant reads as missing, not forbidden: 403 would
  // confirm the account exists.
  if (!rider) throw httpError('Rider not found', 404);

  if (input.branch !== undefined) {
    if (input.branch) await assertTenantBranchAccess(user, input.branch);
    rider.branch = input.branch || undefined;
  }
  const profile = rider.rider || {};
  for (const key of ['phone', 'vehicle', 'licencePlate', 'notes']) {
    if (input[key] !== undefined) profile[key] = clean(input[key]) || undefined;
  }
  if (input.maxConcurrent !== undefined) profile.maxConcurrent = input.maxConcurrent;
  if (input.active !== undefined) {
    profile.active = Boolean(input.active);
    // Standing down a rider must also take them off shift, or they stay in the
    // "available" pool and can still be picked by a dispatcher.
    if (!profile.active) profile.available = false;
  }
  if (input.available !== undefined) {
    if (input.available && profile.active === false) {
      throw httpError('An inactive rider cannot be marked available', 409);
    }
    profile.available = Boolean(input.available);
  }
  rider.rider = profile;
  rider.markModified('rider');
  await rider.save();

  await Audit.create({
    entity: 'rider', entityId: rider._id, branch: rider.branch,
    action: 'rider_updated',
    after: {active: profile.active, available: profile.available, vehicle: profile.vehicle},
    user: user.id
  });
  return rider;
}

/**
 * A rider setting their own shift state. They may not change anything else.
 *
 * The rider identity comes from the verified token, never from the request
 * body, so a rider cannot toggle somebody else's shift.
 */
export async function setOwnAvailability({user, available}) {
  const rider = await User.findOne({_id: user.id, role: 'rider'});
  if (!rider) throw httpError('Rider not found', 404);
  if (available && rider.rider?.active === false) {
    throw httpError('Your rider account is inactive. Contact your manager.', 403);
  }
  const before = Boolean(rider.rider?.available);
  rider.rider = {...(rider.rider?.toObject?.() || rider.rider || {}), available: Boolean(available)};
  rider.markModified('rider');
  await rider.save();

  // Going off shift mid-rush is an operational fact a manager may need to
  // reconstruct later, so it is audited like any other state change.
  await Audit.create({
    entity: 'rider', entityId: rider._id, branch: rider.branch,
    action: available ? 'rider_available' : 'rider_unavailable',
    before: {available: before}, after: {available: Boolean(available)},
    user: user.id
  });
  return rider;
}

/**
 * Everything the rider home screen needs, in one call.
 *
 * Computed server-side from the rider's own deliveries: a client that
 * assembled these figures itself could be pointed at another rider's data.
 */
export async function riderDashboard({user}) {
  const rider = await User.findById(user.id).select('name branch rider').lean();
  if (!rider || rider.role === 'staff') throw httpError('Rider not found', 404);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [live, todayDelivered, todayFailed] = await Promise.all([
    Delivery.find({rider: user.id, status: {$in: [...LIVE_DELIVERY_STATUSES]}})
      .sort({createdAt: 1})
      .populate('order', 'orderNo total type paymentMethod paidAmount dueAmount customer')
      .lean(),
    Delivery.countDocuments({rider: user.id, status: 'delivered', deliveredAt: {$gte: startOfDay}}),
    Delivery.countDocuments({rider: user.id, status: 'failed', failedAt: {$gte: startOfDay}})
  ]);

  const customerIds = live.map(d => d.order?.customer).filter(Boolean);
  const customers = customerIds.length
    ? await Customer.find({_id: {$in: customerIds}}).select('name phone').lean()
    : [];
  const byId = new Map(customers.map(c => [String(c._id), c]));
  const views = live.map(d => riderDeliveryView(d, {
    customer: d.order?.customer ? byId.get(String(d.order.customer)) : null
  }));

  const maxConcurrent = Number(rider.rider?.maxConcurrent || 3);
  // The job in hand: whichever live delivery is furthest along.
  const rank = {out_for_delivery: 0, picked_up: 1, assigned: 2, pending: 3};
  const current = [...views].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0] || null;

  return {
    rider: {
      name: rider.name,
      active: rider.rider?.active !== false,
      available: Boolean(rider.rider?.available),
      vehicle: rider.rider?.vehicle || 'motorcycle'
    },
    activeDelivery: current,
    workload: views.length,
    capacity: maxConcurrent,
    atCapacity: views.length >= maxConcurrent,
    today: {delivered: todayDelivered, failed: todayFailed},
    deliveries: views
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Validate that a rider may take this delivery.
 *
 * Checks tenancy, employment, shift state and capacity. Capacity is a real
 * operational limit: silently stacking twelve jobs on one rider is how orders
 * go cold.
 */
async function assertRiderAssignable({riderId, restaurantId, branchId, session, ignoreDeliveryId}) {
  if (!mongoose.isValidObjectId(riderId)) throw httpError('Invalid rider', 400);
  const rider = await User.findOne({_id: riderId, role: 'rider'}).session(session || null);
  if (!rider) throw httpError('Rider not found', 404);
  if (String(rider.restaurantId) !== String(restaurantId)) {
    throw httpError('Rider not found', 404);
  }
  // A rider pinned to a branch may only serve that branch.
  if (rider.branch && String(rider.branch) !== String(branchId)) {
    throw httpError('That rider works at another branch', 409);
  }
  if (rider.rider?.active === false) throw httpError('That rider is inactive', 409);

  const liveFilter = {rider: rider._id, status: {$in: [...LIVE_DELIVERY_STATUSES]}};
  if (ignoreDeliveryId) liveFilter._id = {$ne: ignoreDeliveryId};
  const live = await Delivery.countDocuments(liveFilter).session(session || null);
  if (live >= Number(rider.rider?.maxConcurrent || 3)) {
    throw httpError('That rider is already at their delivery limit', 409);
  }
  return rider;
}

/**
 * Create the delivery job for an order.
 *
 * The address and instructions are copied from the order/customer at dispatch
 * time so that later edits to a saved address cannot rewrite history.
 */
export async function createDelivery({user, input}) {
  const session = await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      const order = await Order.findById(input.order).session(session);
      if (!order) throw httpError('Order not found', 404);
      await assertTenantBranchAccess(user, order.branch, {session});

      if (order.type !== 'delivery') {
        throw httpError('Only a delivery order can be dispatched', 409);
      }
      if (!DISPATCHABLE_ORDER_STATUSES.includes(order.status)) {
        throw httpError(`An order that is ${order.status} cannot be dispatched`, 409);
      }

      const branch = await Branch.findById(order.branch).select('restaurant').session(session);
      if (!branch) throw httpError('Branch not found', 404);

      const address = clean(input.address) || clean(order.deliveryAddress);
      if (address.length < 5) throw httpError('A delivery address is required', 400);

      const doc = {
        order: order._id,
        branch: order.branch,
        restaurant: branch.restaurant,
        address,
        phone: clean(input.phone) || undefined,
        instructions: clean(input.instructions) || undefined,
        estimatedMinutes: input.estimatedMinutes ?? 0,
        status: 'pending',
        dueAt: input.estimatedMinutes
          ? new Date(Date.now() + Number(input.estimatedMinutes) * 60_000)
          : null
      };

      if (input.rider) {
        await assertRiderAssignable({
          riderId: input.rider, restaurantId: branch.restaurant, branchId: order.branch, session
        });
        doc.rider = input.rider;
        doc.status = 'assigned';
        doc.assignedAt = new Date();
        doc.assignedBy = user.id;
        doc.assignmentHistory = [{
          rider: input.rider, assignedBy: user.id, at: new Date(), action: 'assigned'
        }];
      }

      try {
        [created] = await Delivery.create([doc], {session});
      } catch (error) {
        // The unique index on `order` is what actually prevents a duplicate
        // dispatch; two dispatchers clicking at once cannot both win.
        if (error?.code === 11000) {
          throw httpError('This order already has a delivery', 409);
        }
        throw error;
      }

      await Audit.create([{
        entity: 'delivery', entityId: created._id, branch: order.branch,
        action: 'delivery_created',
        after: {order: String(order._id), status: created.status, rider: input.rider || null},
        user: user.id
      }], {session});
    });

    publishDeliveryEvent(
      created.branch,
      {reason: 'created', deliveryId: String(created._id), status: created.status},
      {riderId: created.rider ? String(created.rider) : null}
    );
    return created;
  } finally {
    session.endSession();
  }
}

/** Assign or reassign a rider. Both are the same operation with a history entry. */
export async function assignRider({user, deliveryId, riderId, reason}) {
  const session = await mongoose.startSession();
  try {
    let delivery;
    await session.withTransaction(async () => {
      delivery = await Delivery.findById(deliveryId).session(session);
      if (!delivery) throw httpError('Delivery not found', 404);
      await assertTenantBranchAccess(user, delivery.branch, {session});

      if (['delivered', 'cancelled', 'failed'].includes(delivery.status)) {
        throw httpError(`A ${delivery.status} delivery cannot be reassigned`, 409);
      }

      const previous = delivery.rider ? String(delivery.rider) : null;
      if (previous === String(riderId)) {
        throw httpError('That rider already has this delivery', 409);
      }

      await assertRiderAssignable({
        riderId,
        restaurantId: delivery.restaurant,
        branchId: delivery.branch,
        session,
        ignoreDeliveryId: delivery._id
      });

      delivery.rider = riderId;
      delivery.assignedBy = user.id;
      delivery.assignedAt = new Date();
      // Reassignment rewinds an in-flight job to 'assigned': the new rider has
      // not picked anything up yet, and leaving it at out_for_delivery would
      // credit them with work they never did.
      if (['pending', 'picked_up', 'out_for_delivery'].includes(delivery.status)) {
        delivery.status = 'assigned';
        delivery.pickedUpAt = null;
        delivery.dispatchedAt = null;
      }
      delivery.assignmentHistory.push({
        rider: riderId, assignedBy: user.id, at: new Date(),
        reason: clean(reason) || undefined,
        action: previous ? 'reassigned' : 'assigned'
      });
      await delivery.save({session});

      await Audit.create([{
        entity: 'delivery', entityId: delivery._id, branch: delivery.branch,
        action: previous ? 'delivery_reassigned' : 'delivery_assigned',
        before: {rider: previous}, after: {rider: String(riderId), reason: clean(reason) || null},
        user: user.id
      }], {session});
    });

    publishDeliveryEvent(
      delivery.branch,
      {reason: 'assigned', deliveryId: String(delivery._id), status: delivery.status},
      {riderId: String(delivery.rider)}
    );
    return delivery;
  } finally {
    session.endSession();
  }
}

/**
 * The one place rider authorisation is decided.
 *
 * A rider may only ever load a delivery that is currently assigned to them.
 * Anything else is reported as not found, so the endpoint cannot be used to
 * discover which delivery ids exist.
 */
async function riderDeliveryOrFail(user, deliveryId, session) {
  if (!mongoose.isValidObjectId(deliveryId)) throw httpError('Delivery not found', 404);
  const delivery = await Delivery.findOne({_id: deliveryId, rider: user.id}).session(session || null);
  if (!delivery) throw httpError('Delivery not found', 404);
  return delivery;
}

/**
 * Advance a delivery.
 *
 * Riders drive their own job forward; staff may also intervene. The state
 * machine is identical for both — a rider cannot skip straight to delivered
 * from assigned any more than a manager can.
 */
export async function updateDeliveryStatus({user, deliveryId, status, reason, proofNote}) {
  const isRider = user.role === 'rider';
  const session = await mongoose.startSession();
  try {
    let delivery;
    let orderCompleted = false;
    await session.withTransaction(async () => {
      if (isRider) {
        delivery = await riderDeliveryOrFail(user, deliveryId, session);
        // A rider may move their job along, or report a genuine failure. They
        // may not cancel it — that is a management decision with money in it.
        if (!['picked_up', 'out_for_delivery', 'delivered', 'failed'].includes(status)) {
          throw httpError('Riders cannot set that status', 403);
        }
      } else {
        delivery = await Delivery.findById(deliveryId).session(session);
        if (!delivery) throw httpError('Delivery not found', 404);
        await assertTenantBranchAccess(user, delivery.branch, {session});
      }

      assertDeliveryTransition(delivery.status, status);
      if (status !== 'cancelled' && status !== 'pending' && !delivery.rider) {
        throw httpError('Assign a rider before moving this delivery', 409);
      }
      if (status === 'failed' && !clean(reason)) {
        throw httpError('A failure reason is required', 400);
      }

      const before = delivery.status;
      delivery.status = status;
      const now = new Date();
      if (status === 'picked_up') delivery.pickedUpAt = now;
      if (status === 'out_for_delivery') delivery.dispatchedAt = now;
      if (status === 'delivered') delivery.deliveredAt = now;
      if (status === 'failed') {
        delivery.failedAt = now;
        delivery.failureReason = clean(reason);
      }
      if (status === 'cancelled') delivery.cancelledAt = now;
      if (proofNote) delivery.proofNote = clean(proofNote);
      await delivery.save({session});

      // Keep the order in step. Dispatch and completion are order-level facts,
      // not just delivery-level ones.
      const order = await Order.findById(delivery.order).session(session);
      if (order) {
        if (status === 'out_for_delivery' && order.status === 'ready') {
          order.status = 'out_for_delivery';
          await order.save({session});
        }
        if (status === 'delivered' && order.status !== 'completed') {
          stampStage(order, 'completed');
          order.status = 'completed';
          await order.save({session});
          orderCompleted = true;
        }
      }

      await Audit.create([{
        entity: 'delivery', entityId: delivery._id, branch: delivery.branch,
        action: `delivery_${status}`,
        before: {status: before},
        after: {status, reason: clean(reason) || null},
        user: user.id
      }], {session});
    });

    publishDeliveryEvent(
      delivery.branch,
      {reason: 'status', deliveryId: String(delivery._id), status: delivery.status},
      {riderId: delivery.rider ? String(delivery.rider) : null}
    );
    if (orderCompleted) {
      const order = await Order.findById(delivery.order);
      if (order) await publishKitchenOrder(order, 'kitchen:status');
    }
    return delivery;
  } finally {
    session.endSession();
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The exact shape a rider is allowed to see.
 *
 * Built by hand rather than by returning the document, because a rider is an
 * external-facing courier and the delivery/order graph carries information
 * that is none of their business: per-item `foodCost` and `recipeCost` are
 * margin data, and `inventoryRequirements` describes recipes. Populating the
 * order wholesale leaked all three.
 *
 * They get exactly what is needed to complete the job: where to go, who to
 * call, what to collect, and whether money is owed on the doorstep.
 */
function riderDeliveryView(delivery, {customer} = {}) {
  const order = delivery.order && typeof delivery.order === 'object' ? delivery.order : null;
  const due = Number(order?.dueAmount ?? 0);
  const method = String(order?.paymentMethod || '').toLowerCase();

  return {
    _id: delivery._id,
    status: delivery.status,
    address: delivery.address,
    // Contact details for THIS delivery only. A rider needs to reach the
    // customer at the door; they never get the CRM profile behind it.
    customerName: customer?.name || null,
    customerPhone: delivery.phone || customer?.phone || null,
    instructions: delivery.instructions || null,
    estimatedMinutes: delivery.estimatedMinutes || 0,
    dueAt: delivery.dueAt || null,
    assignedAt: delivery.assignedAt || null,
    pickedUpAt: delivery.pickedUpAt || null,
    dispatchedAt: delivery.dispatchedAt || null,
    deliveredAt: delivery.deliveredAt || null,
    failedAt: delivery.failedAt || null,
    failureReason: delivery.failureReason || null,
    createdAt: delivery.createdAt,
    order: order
      ? {
        orderNo: order.orderNo,
        type: order.type,
        total: order.total,
        // Whether to collect cash, and how much. The only money fact a
        // courier needs.
        paymentMethod: order.paymentMethod || null,
        collectOnDelivery: due > 0,
        amountDue: due,
        itemCount: Array.isArray(order.items)
          ? order.items.reduce((sum, i) => sum + Number(i.qty || 0), 0)
          : undefined,
        // Names and quantities only, so the rider can check the bag. No
        // costs, no recipes, no modifiers.
        items: Array.isArray(order.items)
          ? order.items.map(i => ({name: i.name, qty: i.qty}))
          : undefined
      }
      : null
  };
}

/** A rider's own queue. Never exposes anything not assigned to them. */
export async function listRiderDeliveries({user, includeCompleted = false}) {
  const filter = {rider: user.id};
  if (!includeCompleted) filter.status = {$in: [...LIVE_DELIVERY_STATUSES]};
  const deliveries = await Delivery.find(filter)
    .sort({createdAt: 1})
    .limit(100)
    .populate('order', 'orderNo total type paymentMethod paidAmount dueAmount customer')
    .lean();

  const customerIds = deliveries.map(d => d.order?.customer).filter(Boolean);
  const customers = customerIds.length
    ? await Customer.find({_id: {$in: customerIds}}).select('name phone').lean()
    : [];
  const byId = new Map(customers.map(c => [String(c._id), c]));

  return deliveries.map(d => riderDeliveryView(d, {
    customer: d.order?.customer ? byId.get(String(d.order.customer)) : null
  }));
}

export async function getDeliveryForRider({user, deliveryId}) {
  const delivery = await riderDeliveryOrFail(user, deliveryId);
  const full = await Delivery.findById(delivery._id)
    .populate('order', 'orderNo total type paymentMethod paidAmount dueAmount items customer')
    .lean();
  const customer = full.order?.customer
    ? await Customer.findById(full.order.customer).select('name phone').lean()
    : null;
  return riderDeliveryView(full, {customer});
}

/** Staff view of a branch's deliveries. */
export async function listDeliveries({user, branchId, status, riderId, limit = 100}) {
  const {restaurantId} = await userRestaurantContext(user);
  const filter = {restaurant: restaurantId};
  if (branchId) {
    await assertTenantBranchAccess(user, branchId);
    filter.branch = new mongoose.Types.ObjectId(String(branchId));
  } else if (user.role !== 'owner') {
    // A non-owner without an explicit branch is confined to their own.
    const {branchId: own} = await userRestaurantContext(user);
    if (!own) throw httpError('User is not assigned to a branch', 403);
    filter.branch = new mongoose.Types.ObjectId(String(own));
  }
  if (status) filter.status = status;
  if (riderId) filter.rider = new mongoose.Types.ObjectId(String(riderId));

  return Delivery.find(filter)
    .sort({createdAt: -1})
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 300))
    .populate('order', 'orderNo total type status')
    .populate('rider', 'name rider.phone rider.vehicle')
    .lean();
}

/**
 * Dispatch dashboard.
 *
 * "Delayed" is derived rather than stored: a delivery is late when it is still
 * live and past its due time, which changes with the clock and so cannot be a
 * persisted flag.
 */
export async function deliveryDashboard({user, branchId}) {
  const {restaurantId} = await userRestaurantContext(user);
  const filter = {restaurant: restaurantId};
  if (branchId) {
    await assertTenantBranchAccess(user, branchId);
    filter.branch = new mongoose.Types.ObjectId(String(branchId));
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deliveries = await Delivery.find({
    ...filter,
    $or: [{status: {$in: [...LIVE_DELIVERY_STATUSES]}}, {createdAt: {$gte: since}}]
  })
    .sort({createdAt: -1})
    .limit(300)
    .populate('order', 'orderNo total type status')
    .populate('rider', 'name rider.phone rider.vehicle')
    .lean();

  const now = Date.now();
  const isLive = d => LIVE_DELIVERY_STATUSES.includes(d.status);
  const delayed = deliveries.filter(d => isLive(d) && d.dueAt && new Date(d.dueAt).getTime() < now);
  const delayedIds = new Set(delayed.map(d => String(d._id)));

  return {
    pending: deliveries.filter(d => d.status === 'pending'),
    assigned: deliveries.filter(d => d.status === 'assigned'),
    active: deliveries.filter(d => ['picked_up', 'out_for_delivery'].includes(d.status)),
    completed: deliveries.filter(d => d.status === 'delivered'),
    failed: deliveries.filter(d => ['failed', 'cancelled'].includes(d.status)),
    delayed,
    counts: {
      pending: deliveries.filter(d => d.status === 'pending').length,
      assigned: deliveries.filter(d => d.status === 'assigned').length,
      active: deliveries.filter(d => ['picked_up', 'out_for_delivery'].includes(d.status)).length,
      completed: deliveries.filter(d => d.status === 'delivered').length,
      failed: deliveries.filter(d => ['failed', 'cancelled'].includes(d.status)).length,
      delayed: delayedIds.size
    }
  };
}

/** A rider's delivery history and simple performance figures. */
export async function riderHistory({user, riderId, limit = 50}) {
  const {restaurantId} = await userRestaurantContext(user);
  const rider = await User.findOne({_id: riderId, role: 'rider', restaurantId}).lean();
  if (!rider) throw httpError('Rider not found', 404);

  const deliveries = await Delivery.find({rider: riderId})
    .sort({createdAt: -1})
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .populate('order', 'orderNo total')
    .lean();

  const delivered = deliveries.filter(d => d.status === 'delivered');
  const durations = delivered
    .filter(d => d.assignedAt && d.deliveredAt)
    .map(d => (new Date(d.deliveredAt) - new Date(d.assignedAt)) / 60000);

  return {
    rider: {
      _id: rider._id, name: rider.name, email: rider.email,
      active: rider.rider?.active !== false, available: Boolean(rider.rider?.available),
      vehicle: rider.rider?.vehicle
    },
    deliveries,
    stats: {
      total: deliveries.length,
      delivered: delivered.length,
      failed: deliveries.filter(d => d.status === 'failed').length,
      averageMinutes: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null
    }
  };
}
