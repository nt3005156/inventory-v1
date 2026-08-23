import {Router} from 'express';
import {requirePermission} from '../middleware/auth.js';
import {
  AUDIT_ACTIONS, AUDIT_ACTION_GROUPS, searchAudit, verifyAuditChain
} from '../services/auditTrail.js';

/**
 * Phase 21 — audit log and compliance search.
 *
 * READ ONLY BY CONSTRUCTION. There is deliberately no POST, PATCH or DELETE
 * here: audit rows are written by the services that perform the audited act,
 * and the model refuses modification through Mongoose. An endpoint that let a
 * client author or edit an audit row would defeat the whole subsystem.
 *
 * Guarded by `audit.view`, which lives only in the owner bundle.
 */

const r = Router();

function fail(res, error) {
  const status = error?.status || 500;
  const message = status >= 500 ? 'Server error' : String(error?.message || 'Request failed');
  return res.status(status).json({message: message.slice(0, 300)});
}

/**
 * Compliance search: who / what / when / where / entity / reference.
 *
 * Always scoped to the caller's restaurant, and to their branch unless they
 * are an owner — see `searchAudit()`. The audit log must not become a side
 * channel for reading another branch's refunds.
 */
r.get('/audit', requirePermission('audit.view'), async (req, res) => {
  try {
    res.json(await searchAudit({
      user: req.user,
      actorId: req.query.user,
      action: req.query.action,
      entity: req.query.entity,
      entityId: req.query.entityId,
      branchId: req.query.branch,
      reference: req.query.reference,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      limit: req.query.limit
    }));
  } catch (e) { fail(res, e); }
});

/** The action vocabulary, so the UI filter is not a second hard-coded copy. */
r.get('/audit/actions', requirePermission('audit.view'), async (req, res) => {
  try {
    res.json({actions: AUDIT_ACTIONS, groups: AUDIT_ACTION_GROUPS});
  } catch (e) { fail(res, e); }
});

/**
 * Tamper verification. Owner only — it is an integrity statement about the
 * whole tenant, not a per-branch view.
 */
r.get('/audit/verify', requirePermission('audit.view'), async (req, res) => {
  try {
    res.json(await verifyAuditChain({user: req.user, limit: req.query.limit}));
  } catch (e) { fail(res, e); }
});

export default r;
