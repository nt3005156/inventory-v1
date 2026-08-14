import {Router} from 'express';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {closeMonth, listMonthCloses, previewMonthClose, reopenMonth} from '../services/monthClose.js';

const r = Router();
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must use YYYY-MM');

r.get('/month-close/preview', auth(['owner', 'manager']), async (req, res) => {
  try {
    const month = monthSchema.parse(req.query.month);
    res.json(await previewMonthClose({month, branchId: req.query.branch, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/month-close', auth(['owner', 'manager']), async (req, res) => {
  try {
    res.json(await listMonthCloses({branchId: req.query.branch, user: req.user, limit: req.query.limit}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/month-close', auth(['owner']), async (req, res) => {
  try {
    const body = z.object({
      month: monthSchema,
      branch: z.string().optional().nullable(),
      notes: z.string().max(500).optional()
    }).parse(req.body);
    res.status(201).json(await closeMonth({month: body.month, branchId: body.branch, notes: body.notes, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/month-close/:id/reopen', auth(['owner']), async (req, res) => {
  try {
    const body = z.object({reason: z.string().trim().min(3).max(500)}).parse(req.body);
    res.json(await reopenMonth({snapshotId: req.params.id, reason: body.reason, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

export default r;
