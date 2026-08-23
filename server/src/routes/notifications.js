import {Router} from 'express';
import {z} from 'zod';
import {requirePermission} from '../middleware/auth.js';
import {
  describeTypes, listInbox, markAllRead, markRead, sweepSupplierInvoicesDue, unreadCount
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
  const status = error?.status || 500;
  const message = status >= 500 ? 'Server error' : String(error?.message || 'Request failed');
  return res.status(status).json({message: message.slice(0, 300)});
}

const boolish = value => {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
};

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
