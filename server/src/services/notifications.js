import mongoose from 'mongoose';
import {Notification} from '../models/operations.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {branchRoom, emitRoomEvent, publishRoleEvent, userRoom} from './realtime.js';
import {REALTIME_EVENTS} from './realtimeEvents.js';

/**
 * Phase 23 — centralised notification infrastructure.
 *
 * This BUILDS ON the existing alert system rather than replacing it. The
 * `Notification` model, its open/acknowledged/resolved lifecycle and the
 * `alerts.js` service already handled the inventory conditions (low stock,
 * expiry, negative inventory, high waste) and are untouched. What was missing:
 *
 *   • Seven of the nine notification types the brief names had no producer at
 *     all — PO approval, new order, payment, delivery, refund, inventory count
 *     and supplier invoice due. Verified by probe: only inventory conditions
 *     ever wrote a Notification.
 *   • No channel abstraction. Everything was implicitly in-app.
 *   • No per-recipient targeting. `Notification.user` existed on the schema
 *     but nothing ever set it — again verified by probe (zero rows).
 *
 * TWO KINDS OF NOTIFICATION, deliberately kept distinct
 * ------------------------------------------------------
 * ALERTS are about a CONDITION that is true right now ("this ingredient is
 * below its reorder level"). They deduplicate: raising the same condition
 * twice must not produce two rows, which is what the unique partial index
 * `alert_open_condition` on {branch, type, referenceId} enforces. They have a
 * lifecycle — somebody acknowledges and resolves them.
 *
 * EVENTS are about something that HAPPENED ("order #14 was paid"). Two
 * payments are two notifications even for the same order, so they must NOT
 * collide with that index. They are informational and are simply read.
 *
 * Conflating the two would either suppress genuine events or let alert spam
 * through, so `notify()` marks events with `kind: 'event'` and always sets a
 * unique `referenceId`, keeping them clear of the alert uniqueness constraint.
 */

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();

/**
 * The event notification catalogue.
 *
 * `roles` is the DEFAULT audience — who cares about this by job, not by
 * permission. It is a routing hint, never an authorisation decision: reading a
 * notification is still gated by tenancy and branch scope in `listInbox()`.
 */
export const NOTIFICATION_TYPES = Object.freeze({
  po_approval_required: {
    label: 'Purchase order awaiting approval',
    severity: 'warning',
    roles: ['owner', 'manager']
  },
  po_approved: {label: 'Purchase order approved', severity: 'info', roles: ['owner', 'manager']},
  po_rejected: {label: 'Purchase order rejected', severity: 'warning', roles: ['owner', 'manager']},
  new_order: {label: 'New order', severity: 'info', roles: ['owner', 'manager', 'staff']},
  payment_received: {label: 'Payment received', severity: 'info', roles: ['owner', 'manager']},
  refund_issued: {label: 'Refund issued', severity: 'warning', roles: ['owner', 'manager']},
  delivery_update: {label: 'Delivery update', severity: 'info', roles: ['owner', 'manager', 'staff']},
  inventory_count_submitted: {
    label: 'Stock count awaiting approval', severity: 'warning', roles: ['owner', 'manager']
  },
  inventory_count_approved: {label: 'Stock count approved', severity: 'info', roles: ['owner', 'manager']},
  supplier_invoice_due: {label: 'Supplier invoice due', severity: 'warning', roles: ['owner', 'manager']}
});

export const NOTIFICATION_TYPE_KEYS = Object.freeze(Object.keys(NOTIFICATION_TYPES));

/**
 * Delivery channels.
 *
 * Only `in_app` is IMPLEMENTED. `email`, `sms` and `push` are declared so the
 * data model and the API are stable, and every notification records which
 * channels were attempted — but there is NO email, SMS or push infrastructure
 * in this repository, so requesting one is recorded as `skipped` with a
 * reason. Nothing pretends to have sent anything.
 */
export const CHANNELS = Object.freeze(['in_app', 'email', 'sms', 'push']);
export const IMPLEMENTED_CHANNELS = Object.freeze(['in_app']);

export function channelStatus(channel) {
  if (channel === 'in_app') return {channel, status: 'delivered'};
  return {
    channel,
    status: 'skipped',
    reason: `No ${channel} provider is configured in this deployment`
  };
}

/**
 * Raise an EVENT notification.
 *
 * Never throws into the caller. Notifications are published after the business
 * transaction commits; failing a completed refund because a notification could
 * not be written would be strictly worse than losing the notification. Errors
 * are logged.
 *
 * @param {object} options
 * @param {string} options.type      one of NOTIFICATION_TYPES
 * @param {string} options.title     short human-facing summary
 * @param {string} [options.body]    detail line
 * @param {string[]} [options.channels]  requested channels; in_app is implicit
 * @param {ObjectId} [options.user]  target one person instead of a role audience
 */
export async function notify({
  type, title, body, restaurant, branch, user = null, severity,
  reference, referenceId, context = {}, channels = ['in_app'], session = null
}) {
  try {
    const definition = NOTIFICATION_TYPES[type];
    if (!definition) throw httpError(`Unknown notification type: ${type}`, 400);
    if (!restaurant) throw httpError('A notification needs a restaurant', 400);

    const requested = [...new Set(['in_app', ...channels])].filter(c => CHANNELS.includes(c));
    /**
     * Per-channel dispatch result, stored under `channels`.
     *
     * It used to be stored under `context.delivery`, which SILENTLY DESTROYED
     * caller context: `createDelivery()` passes `context: {delivery: <id>}`, and
     * because the channel list was spread in after `...context` it overwrote the
     * delivery id with the channel array. The notification then had no way back
     * to the delivery it was about. Found by building the deterministic delivery
     * fixture; the old test never reached the assertion, so nothing caught it.
     * The READ shape still exposes it as `delivery` so the client contract is
     * unchanged.
     */
    const channelResults = requested.map(channelStatus);

    const [row] = await Notification.create([{
      restaurant,
      branch: branch || undefined,
      user: user || undefined,
      type,
      title: clean(title).slice(0, 200),
      body: clean(body).slice(0, 1000) || undefined,
      severity: severity || definition.severity,
      // An EVENT is informational and has no condition to resolve, so it is
      // born 'resolved'. That also keeps it out of the unique partial index on
      // open alerts, which would otherwise collapse two real events for the
      // same order into one.
      status: 'resolved',
      resolvedAt: new Date(),
      read: false,
      // Belt and braces against the alert dedup index. `status: 'resolved'`
      // above already excludes events from `alert_open_condition`, whose
      // partial filter only matches open/acknowledged rows — confirmed by
      // mutation testing, where removing this changed nothing. It is kept so
      // events stay clear of that index even if the alert lifecycle is ever
      // widened to cover resolved rows.
      referenceId: referenceId || new mongoose.Types.ObjectId(),
      context: {
        ...context,
        kind: 'event',
        reference: clean(reference) || undefined,
        audience: user ? 'user' : definition.roles,
        channels: channelResults
      }
    }], {session: session || undefined});

    // Push to the people who care, in realtime. Role rooms are namespaced by
    // restaurant, so this cannot reach another tenant.
    publishNotification(row, definition);
    return row;
  } catch (error) {
    console.error('notification write failed', {type, message: error?.message});
    return null;
  }
}

/** Fan a notification out to its audience over Socket.IO. */
function publishNotification(row, definition) {
  if (!row) return;
  const payload = {
    notification: String(row._id),
    type: row.type,
    title: row.title,
    body: row.body || null,
    severity: row.severity,
    branch: row.branch ? String(row.branch) : null,
    reference: row.context?.reference || null
  };
  try {
    if (row.user) {
      /**
       * ADDRESSED TO ONE PERSON -> ONE ROOM.
       *
       * This used to emit to the RESTAURANT room and rely on the client to
       * filter on `user`. That was a leak, not a filter: every staff socket in
       * the tenant received the payload — title, body, branch and the target's
       * user id — and client-side filtering is not an authorisation boundary.
       * Reproduced directly before the fix: a private "PRIVATE-RIDER-A-JOB"
       * delivery notification arrived on a branch staff socket, while the
       * rider it was addressed to received NOTHING, because riders never join
       * the restaurant room.
       *
       * `user:<id>` is joined by every authenticated socket including riders
       * (who also hold `rider:<id>`), so the intended recipient — and only
       * them — receives it.
       */
      emitRoomEvent(userRoom(row.user), REALTIME_EVENTS.INVENTORY_ALERT, {
        ...payload, user: String(row.user)
      }, {branch: row.branch || null, idempotencyKey: String(row._id)});
      return;
    }

    /**
     * BRANCH-SCOPED NOTIFICATIONS GO TO THE BRANCH ROOM.
     *
     * Role rooms span the whole restaurant, so fanning a branch notification
     * out across them leaks it. Caught by the Phase 22 isolation test and
     * reproduced directly: creating an order in branch A delivered its title
     * to a branch B socket. A notification that names a branch is delivered to
     * that branch only; the row itself is still filtered again on read by
     * `listInbox()`, so this is delivery scoping, not the security boundary.
     *
     * Only a genuinely restaurant-wide notification (no branch) uses role
     * rooms, which is what they are for.
     */
    if (row.branch) {
      emitRoomEvent(branchRoom(row.branch), REALTIME_EVENTS.INVENTORY_ALERT, payload, {
        branch: row.branch, idempotencyKey: String(row._id)
      });
      return;
    }

    for (const role of definition.roles) {
      publishRoleEvent(row.restaurant, role, REALTIME_EVENTS.INVENTORY_ALERT, payload, {
        // Same notification, same event id across every role room, so a user
        // who holds two roles applies it once.
        idempotencyKey: String(row._id)
      });
    }
  } catch (error) {
    console.error('notification publish failed', error?.message);
  }
}

// ── notification centre ──────────────────────────────────────────────────────

/**
 * Resolve who may see what.
 *
 * An owner spans the restaurant; anybody else is pinned to their branch.
 * Restaurant-wide notifications (no branch) stay visible to everyone in the
 * tenant, because that is what "restaurant-wide" means.
 */
async function inboxScope({user, branchId}) {
  const identity = await userRestaurantContext(user);
  if (branchId) {
    const context = await purchaseBranchContext({user, branchId, allowInactive: true});
    return {restaurantId: context.restaurantId, branchIds: [context.branch._id], role: identity.role, userId: identity.userId};
  }
  if (identity.role !== 'owner') {
    if (!identity.branchId) throw httpError('User is not assigned to a branch', 403);
    return {
      restaurantId: identity.restaurantId, branchIds: [identity.branchId],
      role: identity.role, userId: identity.userId
    };
  }
  return {restaurantId: identity.restaurantId, branchIds: null, role: 'owner', userId: identity.userId};
}

function inboxMatch(scope, {unread, type, kind}) {
  const match = {restaurant: scope.restaurantId};
  if (scope.branchIds) {
    match.$and = [{
      $or: [
        {branch: {$in: scope.branchIds}},
        {branch: null},
        {branch: {$exists: false}}
      ]
    }];
  }
  // A notification addressed to ONE user is private to them. Everything else
  // is addressed to a role audience and is visible within scope.
  const privacy = {$or: [{user: null}, {user: {$exists: false}}, {user: scope.userId}]};
  match.$and = [...(match.$and || []), privacy];

  if (unread === true) match.read = false;
  if (unread === false) match.read = true;
  if (type) {
    const types = Array.isArray(type) ? type : String(type).split(',').map(clean).filter(Boolean);
    if (types.length) match.type = {$in: types};
  }
  if (kind === 'event') match['context.kind'] = 'event';
  if (kind === 'alert') match['context.kind'] = {$ne: 'event'};
  return match;
}

/**
 * The notification centre: unread, read, filtered, paginated, with a count.
 */
export async function listInbox({
  user, branchId, unread, type, kind, page = 1, limit = 25
}) {
  const scope = await inboxScope({user, branchId});
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const match = inboxMatch(scope, {unread, type, kind});

  const [rows, total, unreadCount] = await Promise.all([
    Notification.find(match)
      .sort({createdAt: -1, _id: -1})
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('branch', 'name code')
      .lean(),
    Notification.countDocuments(match),
    Notification.countDocuments({...inboxMatch(scope, {unread: true}), })
  ]);

  return {
    notifications: rows.map(view),
    unreadCount,
    pagination: {
      page: safePage, limit: safeLimit, total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    },
    scope: scope.branchIds ? 'branch' : 'restaurant'
  };
}

/** Read shape, built by hand so a schema addition cannot leak silently. */
function view(row) {
  return {
    _id: row._id,
    type: row.type,
    title: row.title,
    body: row.body || null,
    severity: row.severity,
    read: Boolean(row.read),
    status: row.status,
    kind: row.context?.kind === 'event' ? 'event' : 'alert',
    reference: row.context?.reference || null,
    branch: row.branch?._id || row.branch || null,
    branchName: row.branch?.name || null,
    user: row.user || null,
    // `channels` is the dispatch result. Older rows (and alert rows written by
    // alerts.js) stored it as `delivery`; both are read so the badge keeps
    // working for data written before the key was renamed.
    delivery: row.context?.channels || row.context?.delivery || [{channel: 'in_app', status: 'delivered'}],
    createdAt: row.createdAt
  };
}

// ── self-scoped inbox (riders) ───────────────────────────────────────────────

/**
 * The SELF-SCOPED inbox.
 *
 * A rider is addressed `delivery_update` notifications personally, but must
 * never read the branch board: `notifications.view` returns the branch's
 * payment, refund, purchasing and inventory notifications, so granting it to a
 * courier would be a privilege escalation. This is the separate, narrower
 * capability behind `notifications.mine`.
 *
 * THE SCOPE IS NOT A FILTER THE CALLER CAN INFLUENCE. It is built from the
 * authenticated identity only:
 *
 *   {restaurant: <caller's restaurant>, user: <caller's own id>}
 *
 * There is no branch parameter, no user parameter and no way to widen it. A
 * client-supplied `userId`/`riderId`/`recipientId` is not read anywhere in this
 * file — the query is constructed from `userRestaurantContext(user)`, which
 * resolves the row from storage using the id in the verified token. Rows with
 * no `user` (branch and restaurant-wide audiences) can never match, because
 * `user` is matched by equality against a concrete ObjectId.
 *
 * `restaurant` is redundant given that a notification's `user` already implies
 * its tenant, but it is kept as defence in depth: if a user were ever moved
 * between restaurants, their old inbox must not follow them.
 */
async function selfScope(user) {
  const identity = await userRestaurantContext(user);
  if (!identity.userId) throw httpError('Authentication required', 401);
  return {
    restaurantId: identity.restaurantId,
    userId: new mongoose.Types.ObjectId(String(identity.userId))
  };
}

function selfMatch(scope, {unread, type} = {}) {
  const match = {restaurant: scope.restaurantId, user: scope.userId};
  if (unread === true) match.read = false;
  if (unread === false) match.read = true;
  if (type) {
    const types = Array.isArray(type) ? type : String(type).split(',').map(clean).filter(Boolean);
    if (types.length) match.type = {$in: types};
  }
  return match;
}

/** Notifications addressed to the caller personally, and nothing else. */
export async function listOwnInbox({user, unread, type, page = 1, limit = 25}) {
  const scope = await selfScope(user);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const match = selfMatch(scope, {unread, type});

  const [rows, total, unread_] = await Promise.all([
    Notification.find(match)
      .sort({createdAt: -1, _id: -1})
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('branch', 'name code')
      .lean(),
    Notification.countDocuments(match),
    Notification.countDocuments(selfMatch(scope, {unread: true}))
  ]);

  return {
    notifications: rows.map(view),
    unreadCount: unread_,
    pagination: {
      page: safePage, limit: safeLimit, total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    },
    scope: 'self'
  };
}

/** Badge count for the rider shell. */
export async function ownUnreadCount({user}) {
  const scope = await selfScope(user);
  return {unread: await Notification.countDocuments(selfMatch(scope, {unread: true}))};
}

/**
 * Mark one of the caller's OWN notifications read.
 *
 * IDOR/BOLA: the id from the URL is only ever used as an ADDITIONAL narrowing
 * term on a query already pinned to the caller's own user id. Somebody else's
 * notification id therefore matches nothing and reads as 404 — the same answer
 * as an id that does not exist, so the endpoint cannot be used to discover
 * whether another user's notification exists.
 */
export async function markOwnRead({user, notificationId, read = true}) {
  if (!mongoose.isValidObjectId(notificationId)) throw httpError('Invalid notification', 400);
  const scope = await selfScope(user);
  const row = await Notification.findOne({
    ...selfMatch(scope),
    _id: new mongoose.Types.ObjectId(String(notificationId))
  });
  if (!row) throw httpError('Notification not found', 404);
  if (Boolean(row.read) === Boolean(read)) return view(row.toObject());
  row.read = Boolean(read);
  await row.save();
  return view(row.toObject());
}

/** Mark everything addressed to the caller read. */
export async function markAllOwnRead({user}) {
  const scope = await selfScope(user);
  const result = await Notification.updateMany(
    selfMatch(scope, {unread: true}),
    {$set: {read: true}}
  );
  return {
    updated: result.modifiedCount || 0,
    unread: await Notification.countDocuments(selfMatch(scope, {unread: true}))
  };
}

/** Unread badge count, cheap enough to poll. */
export async function unreadCount({user, branchId}) {
  const scope = await inboxScope({user, branchId});
  return {unread: await Notification.countDocuments(inboxMatch(scope, {unread: true}))};
}

/**
 * Mark one notification read.
 *
 * Scoped: a caller can only mark something they are entitled to see, so this
 * cannot be used to probe whether another branch's notification exists — an
 * out-of-scope id is a 404, exactly as a missing one is.
 */
export async function markRead({user, notificationId, read = true}) {
  if (!mongoose.isValidObjectId(notificationId)) throw httpError('Invalid notification', 400);
  const scope = await inboxScope({user});
  const match = {...inboxMatch(scope, {}), _id: new mongoose.Types.ObjectId(String(notificationId))};
  const row = await Notification.findOne(match);
  if (!row) throw httpError('Notification not found', 404);
  if (Boolean(row.read) === Boolean(read)) return view(row.toObject());
  row.read = Boolean(read);
  await row.save();
  return view(row.toObject());
}

/** Mark everything in scope read. Returns how many actually changed. */
export async function markAllRead({user, branchId}) {
  const scope = await inboxScope({user, branchId});
  const result = await Notification.updateMany(
    {...inboxMatch(scope, {unread: true})},
    {$set: {read: true}}
  );
  return {
    updated: result.modifiedCount || 0,
    unread: await Notification.countDocuments(inboxMatch(scope, {unread: true}))
  };
}

/** The catalogue, so the UI filter is not a second hard-coded copy. */
export function describeTypes() {
  return {
    types: NOTIFICATION_TYPE_KEYS.map(key => ({key, ...NOTIFICATION_TYPES[key]})),
    channels: CHANNELS.map(channel => ({
      channel,
      implemented: IMPLEMENTED_CHANNELS.includes(channel)
    }))
  };
}

// ── scheduled conditions ─────────────────────────────────────────────────────

/**
 * Supplier invoices falling due.
 *
 * Unlike the other eight types this is not triggered by an act — nothing
 * "happens" when an invoice becomes due, time simply passes. So it is a sweep,
 * meant to be run on a schedule or on demand by an owner.
 *
 * Deduplication matters more here than anywhere else: run daily, a naive
 * implementation would re-notify the same unpaid invoice every morning until
 * somebody paid it. The invoice id is used as `referenceId` and an existing
 * unread notification for that invoice suppresses a repeat, so each invoice
 * announces itself once per due window.
 *
 * @param {number} withinDays  how far ahead to look. Overdue invoices always
 *                             qualify regardless of this window.
 */
export async function sweepSupplierInvoicesDue({user, withinDays = 3, now = new Date()}) {
  const identity = await userRestaurantContext(user);
  if (identity.role !== 'owner') {
    throw httpError('Only an owner can run the supplier invoice sweep', 403);
  }
  const {SupplierInvoice} = await import('../models/operations.js');
  const horizon = new Date(now.getTime() + Math.max(0, Number(withinDays) || 0) * 86400000);

  const invoices = await SupplierInvoice.find({
    restaurant: identity.restaurantId,
    status: {$in: ['unpaid', 'partial']},
    dueDate: {$ne: null, $lte: horizon}
  }).populate('supplier', 'name').limit(500).lean();

  let created = 0;
  let suppressed = 0;
  for (const invoice of invoices) {
    // One live notification per invoice. `read: false` is the suppression
    // window: once somebody has read it, a later sweep may raise it again.
    const existing = await Notification.findOne({
      restaurant: identity.restaurantId,
      type: 'supplier_invoice_due',
      referenceId: invoice._id,
      read: false
    }).lean();
    if (existing) { suppressed += 1; continue; }

    const overdue = invoice.dueDate < now;
    const outstanding = Number(invoice.total || 0) - Number(invoice.paidAmount || 0);
    const written = await notify({
      type: 'supplier_invoice_due',
      restaurant: identity.restaurantId,
      branch: invoice.branch,
      severity: overdue ? 'critical' : 'warning',
      title: `${invoice.supplier?.name || 'Supplier'} invoice ${invoice.invoiceNo} ${overdue ? 'is overdue' : 'is due'}`,
      body: `Rs ${outstanding.toFixed(2)} outstanding · due ${new Date(invoice.dueDate).toISOString().slice(0, 10)}`,
      reference: invoice.invoiceNo,
      referenceId: invoice._id,
      context: {supplierInvoice: String(invoice._id), overdue, outstanding}
    });
    if (written) created += 1;
  }
  return {checked: invoices.length, created, suppressed, withinDays: Number(withinDays) || 0};
}
