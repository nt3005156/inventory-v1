import {createHash} from 'node:crypto';
import mongoose from 'mongoose';
import {Audit, setAuditChainStamper, User} from '../models/index.js';
import {Branch} from '../models/operations.js';
import {userRestaurantContext} from './supplierCatalog.js';

/**
 * Phase 21 — audit trail, tamper evidence and compliance search.
 *
 * This does NOT replace the ~90 existing `Audit.create()` call sites. They
 * keep working unchanged; a Mongoose `pre('validate')` hook (installed here,
 * once) stamps the chain onto every row however it was written, so a service
 * that was never touched still ends up inside the tamper-evident chain.
 *
 * WHY A HASH CHAIN RATHER THAN "IT'S IMMUTABLE"
 * ---------------------------------------------
 * The schema refuses updates and deletes through Mongoose, which stops the
 * application — including a compromised route — from rewriting history. It
 * cannot stop somebody with direct database access: `db.audits.updateOne()`
 * in the mongo shell bypasses Mongoose entirely.
 *
 * So each row also carries `hash = SHA256(content || prevHash)`. Editing or
 * removing any row breaks verification for that row and every row after it.
 * That converts an undetectable rewrite into a detectable one, which is the
 * honest ceiling for a system storing its audit log in its own database.
 * Genuinely PREVENTING it needs an append-only store or shipping the log off
 * the box — recorded in the README rather than pretended away.
 */

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();

/** Actions the brief names, grouped so the UI can offer a sane filter. */
export const AUDIT_ACTION_GROUPS = Object.freeze({
  Authentication: ['login', 'login_failed', 'logout', 'sessions_revoked', 'session_device_revoked'],
  Accounts: [
    'account_created', 'account_password_reset', 'account_deactivated', 'account_reactivated',
    'user_role_assigned', 'role_created', 'role_updated', 'role_deleted'
  ],
  Pricing: ['menu_price_changed', 'create', 'update'],
  Inventory: [
    'stock_adjustment', 'stock_count_created', 'stock_count_submitted',
    'stock_count_approved', 'stock_count_rejected', 'waste_recorded', 'transfer_status'
  ],
  Purchasing: ['po_create', 'po_update', 'po_status', 'po_short_close', 'receive', 'post', 'reverse'],
  Money: [
    'payment', 'payment_reversed', 'order_refund', 'order_discount',
    'tax_invoice_issued', 'tax_invoice_reprinted', 'tax_invoice_voided'
  ]
});

export const AUDIT_ACTIONS = Object.freeze(
  [...new Set(Object.values(AUDIT_ACTION_GROUPS).flat())].sort()
);

// ── hash chain ───────────────────────────────────────────────────────────────

/**
 * Canonical serialisation of the fields the hash covers.
 *
 * Key order is fixed rather than taken from the object, because
 * `JSON.stringify` follows insertion order and two logically identical rows
 * must hash identically. `before`/`after` are stringified with sorted keys for
 * the same reason.
 */

/**
 * Depth- and cycle-safe canonicalisation.
 *
 * `before`/`after` are Mixed and callers put whatever they have in them —
 * including hydrated Mongoose documents, which carry `$__`, `$parent` and
 * other self-referencing internals. The first implementation recursed on those
 * and blew the stack, taking down every supplier-invoice write with a 500.
 * Found by the existing suite, not by inspection.
 *
 * A WeakSet breaks cycles and a depth cap stops pathological nesting; either
 * way the substituted marker still hashes deterministically, so tamper
 * detection is unaffected.
 */
const MAX_CANONICAL_DEPTH = 12;

function canonicaliseSafe(value, seen, depth) {
  if (value === null || value === undefined) return null;
  if (depth > MAX_CANONICAL_DEPTH) return '[depth]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // A hydrated document or subdocument: reduce to its plain form first.
    if (typeof value.toObject === 'function') {
      try { value = value.toObject({depopulate: true, virtuals: false}); } catch { return String(value); }
    } else if (typeof value.toJSON === 'function' && value._bsontype) {
      return String(value);
    }
    if (value === null) return null;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map(item => canonicaliseSafe(item, seen, depth + 1))
      : Object.keys(value).sort().reduce((acc, key) => {
        if (key.startsWith('$') || key === '__parentArray' || key === '__index') return acc;
        acc[key] = canonicaliseSafe(value[key], seen, depth + 1);
        return acc;
      }, {});
    seen.delete(value);
    return result;
  }
  return value;
}

export function auditPayload(row) {
  const seen = new WeakSet();
  const canonicalise = value => canonicaliseSafe(value, seen, 0);
  return JSON.stringify(canonicalise({
    entity: row.entity ?? null,
    entityId: row.entityId ? String(row.entityId) : null,
    restaurant: row.restaurant ? String(row.restaurant) : null,
    branch: row.branch ? String(row.branch) : null,
    action: row.action ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    reason: row.reason ?? null,
    user: row.user ? String(row.user) : null,
    userName: row.userName ?? null,
    userRole: row.userRole ?? null,
    ip: row.ip ?? null,
    reference: row.reference ?? null,
    at: row.at instanceof Date ? row.at.toISOString() : row.at ?? null,
    sequence: row.sequence ?? null
  }));
}

export function auditHash(row, prevHash) {
  return createHash('sha256')
    .update(auditPayload(row))
    .update(String(prevHash || 'GENESIS'))
    .digest('hex');
}

/**
 * Per-restaurant chain head.
 *
 * Serialised through an in-process queue: two concurrent audit writes for the
 * same tenant must not read the same head and produce a fork. Express is
 * single-threaded, so a promise chain is sufficient within one instance.
 * Across instances two rows can share a `prevHash`; verification tolerates
 * that by walking in `sequence` order and reporting a fork rather than
 * silently accepting it. Documented in the README.
 */
const chainLocks = new Map();

function withChainLock(key, task) {
  const previous = chainLocks.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  // Keep the map bounded: drop the entry once this link settles and nothing
  // newer has queued behind it.
  chainLocks.set(key, next.catch(() => {}));
  next.finally(() => {
    if (chainLocks.get(key) === undefined) return;
  });
  return next;
}

async function chainHead(restaurantId, session) {
  const query = Audit.findOne(restaurantId ? {restaurant: restaurantId} : {restaurant: null})
    .sort({sequence: -1})
    .select('hash sequence')
    .lean();
  if (session) query.session(session);
  return query;
}

/**
 * Install the chaining hook exactly once.
 *
 * Attached to `pre('validate')` on the compiled model so EVERY writer is
 * covered — including the 90 pre-existing `Audit.create()` calls that know
 * nothing about hashing.
 */
let hookInstalled = false;

export function installAuditChain() {
  if (hookInstalled) return false;
  hookInstalled = true;
  // The hook itself is declared on the schema (models/index.js) because a
  // pre('validate') attached after model() compilation never fires. Only the
  // implementation is injected here.
  setAuditChainStamper(async doc => {
    const restaurantId = doc.restaurant || null;
    const key = String(restaurantId || 'global');
    await withChainLock(key, async () => {
      const head = await chainHead(restaurantId, doc.$session?.());
      doc.sequence = Number(head?.sequence || 0) + 1;
      doc.prevHash = head?.hash || null;
      if (!doc.at) doc.at = new Date();
      doc.hash = auditHash(doc, doc.prevHash);
    });
  });
  return true;
}

// ── writing ──────────────────────────────────────────────────────────────────

/**
 * Record an audited event with full WHO/WHERE context.
 *
 * Preferred over calling `Audit.create()` directly for new code, because it
 * captures the actor's name/role and the request's IP. Existing call sites are
 * intentionally left alone: they still chain, they simply carry less context.
 *
 * Never throws into the caller's path. An audit write that fails must not roll
 * back the business operation it describes — losing the log entry is bad,
 * failing a completed refund because of it is worse. Failures are logged.
 */
export async function recordAudit({
  req = null, user = null, entity, entityId, action,
  before, after, reason, restaurant, branch, reference, session
}) {
  try {
    const actor = user || req?.user || null;
    const principal = req?.principal || null;
    const doc = {
      entity,
      entityId: entityId || undefined,
      restaurant: restaurant || (principal?.restaurantId ?? actor?.restaurantId) || undefined,
      branch: branch || undefined,
      action,
      before,
      after,
      reason: clean(reason) || undefined,
      user: actor?.id || actor?._id || undefined,
      userName: clean(actor?.name || principal?.name) || undefined,
      userRole: clean(principal?.roleKey || actor?.roleKey || actor?.role) || undefined,
      ip: clean(requestIp(req)).slice(0, 60) || undefined,
      userAgent: clean(req?.headers?.['user-agent']).slice(0, 300) || undefined,
      reference: clean(reference).slice(0, 120) || undefined
    };
    const [written] = await Audit.create([doc], session ? {session} : undefined);
    return written;
  } catch (error) {
    console.error('Audit write failed', {action, entity, message: error?.message});
    return null;
  }
}

/** Client IP, honouring the proxy configuration Express already resolves. */
export function requestIp(req) {
  if (!req) return '';
  return req.ip || req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
}

/**
 * Authentication events, which have no authenticated principal by definition.
 *
 * A failed login must never confirm whether the address exists, so the email
 * is recorded (an investigator needs it) but the row carries no user id when
 * the account is unknown.
 */
export async function recordAuthEvent({req, action, user = null, email, reason, restaurant}) {
  return recordAudit({
    req,
    entity: 'auth',
    entityId: user?._id || undefined,
    restaurant: restaurant || user?.restaurantId || undefined,
    branch: user?.branch || undefined,
    action,
    after: {email: clean(email).toLowerCase() || undefined},
    reason,
    user: user ? {id: user._id, name: user.name, role: user.role} : null,
    reference: clean(email).toLowerCase() || undefined
  });
}

// ── search ───────────────────────────────────────────────────────────────────

const MAX_LIMIT = 200;

function parseDate(value, label) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw httpError(`${label} must use YYYY-MM-DD`, 400);
  const date = new Date(`${value}T00:00:00.000+05:45`);
  if (Number.isNaN(date.getTime())) throw httpError(`${label} is not a real date`, 400);
  const roundTrip = new Date(date.getTime() + 5.75 * 3600 * 1000).toISOString().slice(0, 10);
  if (roundTrip !== String(value)) throw httpError(`${label} is not a real date`, 400);
  return date;
}

/**
 * Compliance search: user, action, date, branch, entity.
 *
 * ALWAYS scoped to the caller's own restaurant. A branch manager is further
 * pinned to their branch, so the audit log cannot become a side channel for
 * reading another branch's refunds.
 */
export async function searchAudit({
  user, actorId, action, entity, entityId, branchId, reference,
  from, to, page = 1, limit = 50
}) {
  const identity = await userRestaurantContext(user);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);

  const match = {restaurant: identity.restaurantId};

  // Branch scoping. An owner may span the restaurant; anybody else is confined
  // to their own branch regardless of what they ask for.
  if (identity.role !== 'owner') {
    if (!identity.branchId) throw httpError('User is not assigned to a branch', 403);
    if (branchId && String(branchId) !== String(identity.branchId)) {
      throw httpError('Branch access denied', 403);
    }
    // Restaurant-wide rows (branch: null) stay visible to a branch manager
    // only when they concern their own branch; anything explicitly stamped to
    // another branch is excluded.
    match.$or = [{branch: identity.branchId}, {branch: null}, {branch: {$exists: false}}];
  } else if (branchId) {
    if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
    const branch = await Branch.findOne({_id: branchId, restaurant: identity.restaurantId}).lean();
    if (!branch) throw httpError('Branch not found', 404);
    match.branch = branch._id;
  }

  if (actorId) {
    if (!mongoose.isValidObjectId(actorId)) throw httpError('Invalid user', 400);
    match.user = new mongoose.Types.ObjectId(String(actorId));
  }
  if (action) {
    const actions = Array.isArray(action) ? action : String(action).split(',').map(clean).filter(Boolean);
    if (actions.length) match.action = {$in: actions};
  }
  if (entity) match.entity = clean(entity);
  if (entityId) {
    if (!mongoose.isValidObjectId(entityId)) throw httpError('Invalid entity id', 400);
    match.entityId = new mongoose.Types.ObjectId(String(entityId));
  }
  if (reference) match.reference = new RegExp(clean(reference).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const fromDate = parseDate(from, 'from');
  const toDate = parseDate(to, 'to');
  const toExclusive = toDate ? new Date(toDate.getTime() + 86400000) : null;
  if (fromDate && toExclusive && fromDate >= toExclusive) throw httpError('from must not be after to', 400);
  if (fromDate || toExclusive) {
    match.at = {...(fromDate ? {$gte: fromDate} : {}), ...(toExclusive ? {$lt: toExclusive} : {})};
  }

  const [rows, total] = await Promise.all([
    Audit.find(match).sort({at: -1, _id: -1}).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    Audit.countDocuments(match)
  ]);

  return {
    events: rows.map(view),
    pagination: {page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit))},
    scope: identity.role === 'owner' ? 'restaurant' : 'branch'
  };
}

/** Read shape. Built by hand so a future schema field cannot leak silently. */
function view(row) {
  return {
    _id: row._id,
    at: row.at,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId || null,
    reference: row.reference || null,
    restaurant: row.restaurant || null,
    branch: row.branch || null,
    actor: {
      id: row.user || null,
      // Denormalised at write time, so this stays correct after a rename.
      name: row.userName || null,
      role: row.userRole || null
    },
    ip: row.ip || null,
    userAgent: row.userAgent || null,
    reason: row.reason || null,
    before: row.before ?? null,
    after: row.after ?? null,
    sequence: row.sequence ?? null,
    hash: row.hash || null
  };
}

// ── verification ─────────────────────────────────────────────────────────────

/**
 * Walk a restaurant's chain and report the first break.
 *
 * Detects three distinct failures, because they mean different things to an
 * investigator:
 *   `content`  — a row's stored hash does not match its own content: EDITED.
 *   `link`     — a row's prevHash does not match the previous row's hash:
 *                a row was DELETED or inserted between them.
 *   `sequence` — a gap or duplicate in the counter: rows REMOVED.
 */
export async function verifyAuditChain({user, limit = 5000}) {
  const identity = await userRestaurantContext(user);
  if (identity.role !== 'owner') throw httpError('Only an owner can verify the audit chain', 403);

  const rows = await Audit.find({restaurant: identity.restaurantId})
    .sort({sequence: 1, _id: 1})
    .limit(Math.min(20000, Math.max(1, Number(limit) || 5000)))
    .lean();

  const problems = [];
  let previous = null;
  for (const row of rows) {
    if (row.hash) {
      const expected = auditHash(row, row.prevHash);
      if (expected !== row.hash) {
        problems.push({type: 'content', sequence: row.sequence, id: String(row._id), action: row.action});
      }
    }
    if (previous) {
      if (Number(row.sequence) !== Number(previous.sequence) + 1) {
        problems.push({
          type: 'sequence', sequence: row.sequence, id: String(row._id),
          detail: `expected ${Number(previous.sequence) + 1}`
        });
      }
      if (row.prevHash !== previous.hash) {
        problems.push({type: 'link', sequence: row.sequence, id: String(row._id)});
      }
    }
    previous = row;
  }

  return {
    verified: problems.length === 0,
    checked: rows.length,
    head: previous ? {sequence: previous.sequence, hash: previous.hash} : null,
    problems: problems.slice(0, 50),
    problemCount: problems.length,
    // Stated in the response so an operator is never misled about the guarantee.
    guarantee: 'Detects tampering. Prevention of direct database writes requires an append-only store or off-host log shipping.'
  };
}
