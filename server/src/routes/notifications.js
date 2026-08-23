import {Router} from 'express';
import {z} from 'zod';
import {requirePermission} from '../middleware/auth.js';
import {
  describeTypes, listInbox, listOwnInbox, markAllOwnRead, markAllRead, markOwnRead, markRead,
  ownUnreadCount, sweepSupplierInvoicesDue, unreadCount
} from '../services/notifications.js';

/**
 * Phase 23 — the notification centre.
 *
 * Read and acknowledge only. Notifications are WRITTEN by the services that
 * perform the underlying act (a payment writes its own notification), never by
 * a client — an endpoint that let a caller author a notification would let
 * anyone forge "payment received" into somebody else's inbox.
 *
 * Scope is enforced in the service: the caller's restaurant always, their
 * branch unless they are an owner, and a notification addressed to one user is
 * private to that user.
 */

const r = Router();

function fail(res, error) {
  // A schema rejection is a 400, not a 500. This router previously mapped a
  // ZodError to "Server error" with a 500, so a `.strict()` body carrying an
  // unexpected key -- exactly what a caller probing for a `userId` override
  // sends -- looked like a server fault. Same shape as the deliveries router.
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

const boolish = value => {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
};

/**
 * SELF-SCOPED INBOX.
 *
 * Declared BEFORE `/notifications/:id/read` so Express cannot parse "mine" as
 * an id, and kept as a separate route tree rather than a mode of the branch
 * inbox: a flag on a shared endpoint is one refactor away from being widened
 * by accident, whereas these handlers have no code path that can return a row
 * belonging to anyone else.
 *
 * Guarded by `notifications.mine`, which the rider bundle holds. It is NOT
 * `notifications.view` — that is branch-scoped and would hand a courier the
 * branch's payment, refund, purchasing and inventory notifications.
 *
 * IDENTITY COMES FROM THE TOKEN, ALWAYS. `userId`, `riderId` and
 * `recipientId` in the query or body are ignored: nothing in this handler or
 * in `listOwnInbox`/`markOwnRead` reads them. A caller cannot name a
 * different subject.
 */
r.get('/notifications/mine', requirePermission('notifications.mine'), async (req, res) => {
  try {
    res.json(await listOwnInbox({
      user: req.user,
      unread: boolish(req.query.unread),
      type: req.query.type,
      page: req.query.page,
      limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

r.get('/notifications/mine/unread-count', requirePermission('notifications.mine'), async (req, res) => {
  try {
    res.json(await ownUnreadCount({user: req.user}));
  } catch (e) { fail(res, e); }
});

r.post('/notifications/mine/read-all', requirePermission('notifications.mine'), async (req, res) => {
  try {
    res.json(await markAllOwnRead({user: req.user}));
  } catch (e) { fail(res, e); }
});

r.patch('/notifications/mine/:id/read', requirePermission('notifications.mine'), async (req, res) => {
  try {
    const body = z.object({read: z.boolean().optional()}).strict().parse(req.body ?? {});
    res.json(await markOwnRead({
      user: req.user, notificationId: req.params.id, read: body.read ?? true
    }));
  } catch (e) { fail(res, e); }
});

r.get('/notifications', requirePermission('notifications.view'), async (req, res) => {
  try {
    res.json(await listInbox({
      user: req.user,
      branchId: req.query.branch,
      // Absent means "everything"; true is the unread tab, false the read tab.
      unread: boolish(req.query.unread),
      type: req.query.type,
      kind: req.query.kind,
      page: req.query.page,
      limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

/** Badge count, cheap enough for the shell to poll. */
r.get('/notifications/unread-count', requirePermission('notifications.view'), async (req, res) => {
  try {
    res.json(await unreadCount({user: req.user, branchId: req.query.branch}));
  } catch (e) { fail(res, e); }
});

/** The catalogue, so the UI filter is not a second hard-coded copy. */
r.get('/notifications/types', requirePermission('notifications.view'), async (req, res) => {
  try {
    res.json(describeTypes());
  } catch (e) { fail(res, e); }
});

/**
 * Mark all read. Declared BEFORE `/notifications/:id/read` so Express does not
 * try to parse "read-all" as an id.
 */
r.post('/notifications/read-all', requirePermission('notifications.view'), async (req, res) => {
  try {
    res.json(await markAllRead({user: req.user, branchId: req.query.branch || req.body?.branch}));
  } catch (e) { fail(res, e); }
});

r.patch('/notifications/:id/read', requirePermission('notifications.view'), async (req, res) => {
  try {
    const body = z.object({read: z.boolean().optional()}).strict().parse(req.body ?? {});
    res.json(await markRead({
      user: req.user, notificationId: req.params.id, read: body.read ?? true
    }));
  } catch (e) { fail(res, e); }
});

/**
 * Raise notifications for supplier invoices falling due.
 *
 * A time-based condition rather than an event, so it is swept. Owner-only and
 * guarded by `purchase.invoice` because it reads supplier liability. Intended
 * to be called on a schedule; exposed so an operator can run it on demand.
 */
r.post('/notifications/sweep/supplier-invoices', requirePermission('purchase.invoice'), async (req, res) => {
  try {
    const body = z.object({withinDays: z.number().int().min(0).max(90).optional()})
      .strict().parse(req.body ?? {});
    res.json(await sweepSupplierInvoicesDue({user: req.user, withinDays: body.withinDays ?? 3}));
  } catch (e) { fail(res, e); }
});

export default r;
