import mongoose from 'mongoose';
import {Audit, Ingredient} from '../models/index.js';
import {Branch, InventoryBalance, StockCount} from '../models/operations.js';
import {userRestaurantContext} from './supplierCatalog.js';

/**
 * Stock count production hardening — recovery for wedged submitted sessions.
 *
 * A stock count holds an exclusive per-branch lock (`activeKey`, backed by the
 * unique partial index `stock_count_active_branch`). Only one draft/counting/
 * submitted session may exist per branch. That lock is released when the
 * session reaches a terminal state: approved, rejected or stale.
 *
 * Phase 14 fixed the common wedge (a stale snapshot). Auditing the shipped
 * behaviour against the running API found three ways a SUBMITTED session can
 * still hold its branch lock with no path to a terminal state:
 *
 *   1. DELETED INGREDIENT — approval calls moveStock(), which 404s with
 *      "Inventory movement ingredient was not found". The transaction aborts,
 *      so the session stays submitted and locked. Reproduced.
 *   2. ORPHAN LOCK — a terminal count (approved/rejected/stale) that still
 *      carries `activeKey` through legacy data or direct database edits. The
 *      schema refuses to SAVE such a document, but a raw collection write can
 *      create one, and it blocks the branch exactly the same way. Reproduced
 *      via a driver-level update.
 *   3. NO ELIGIBLE APPROVER — a manager-submitted count in a branch whose only
 *      manager is that same person. Separation of duties (correctly) refuses a
 *      self-approval, and if no owner acts, the branch stays locked. Reproduced.
 *
 * What this module does NOT do, by design:
 *   * never approves a count, and never posts stock;
 *   * never writes InventoryBalance or InventoryTransaction;
 *   * never touches a captured physicalQty, systemQty or variance;
 *   * never deletes a StockCount or any Audit row.
 *
 * All it does is move a proven-wedged session to a terminal state that
 * RELEASES the branch lock, so the branch can count again. The captured
 * figures are preserved on the document for the operator to inspect; a recount
 * is then created normally through the API.
 */

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * How long a submitted session must have sat untouched before recovery will
 * consider it. This is the primary protection against releasing a session a
 * manager is actively working on: an approval that is merely a few minutes
 * from happening must never be swept away underneath them.
 */
export const DEFAULT_MIN_AGE_MINUTES = 720; // 12 hours

/** Reasons a submitted session can be wedged. Each is proven, never assumed. */
export const RECOVERY_REASONS = Object.freeze({
  MISSING_INGREDIENT: 'missing_ingredient',
  ORPHAN_LOCK: 'orphan_lock',
  NO_ELIGIBLE_APPROVER: 'no_eligible_approver'
});

/** Terminal statuses. A count in one of these must not hold a branch lock. */
const TERMINAL_STATUSES = ['approved', 'rejected', 'stale'];

function minutesSince(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / 60000;
}

/**
 * Diagnoses one session and explains, in plain terms, why it does or does not
 * qualify. Returns `{qualifies, reason, detail, ...}` — never a bare boolean,
 * because an operator has to be able to read the output and agree with it.
 */
export async function diagnoseSession(count, {minAgeMinutes, session} = {}) {
  const ageMinutes = Math.floor(minutesSince(count.updatedAt || count.submittedAt || count.createdAt));

  // ORPHAN LOCK: terminal but still holding the lock. Age is irrelevant — the
  // decision is already made and recorded, so nobody can be mid-approval.
  if (TERMINAL_STATUSES.includes(count.status)) {
    if (!count.activeKey) {
      return {qualifies: false, reason: null, detail: 'Already terminal and holding no lock.', ageMinutes};
    }
    return {
      qualifies: true,
      reason: RECOVERY_REASONS.ORPHAN_LOCK,
      detail: `Count is already ${count.status} but still holds the branch lock, so the branch cannot start a new count. Releasing the lock changes no count data.`,
      ageMinutes,
      releaseOnly: true
    };
  }

  if (count.status !== 'submitted') {
    return {
      qualifies: false,
      reason: null,
      detail: `Status is ${count.status}. Only submitted sessions (or terminal sessions with an orphan lock) are recoverable; a draft or counting sheet belongs to whoever is filling it in.`,
      ageMinutes
    };
  }

  if (!count.activeKey) {
    return {qualifies: false, reason: null, detail: 'Submitted but holds no branch lock, so it is blocking nothing.', ageMinutes};
  }

  // ACTIVITY GUARD. Checked before any wedge reason, so a session someone
  // touched moments ago is never swept away even if it is genuinely wedged.
  if (ageMinutes < minAgeMinutes) {
    return {
      qualifies: false,
      reason: null,
      detail: `Modified ${ageMinutes} minute(s) ago, under the ${minAgeMinutes}-minute threshold. Treated as actively in review.`,
      ageMinutes,
      tooRecent: true
    };
  }

  // WEDGE 1 — an ingredient on the sheet no longer exists, so moveStock()
  // cannot post the variance and approval can never succeed.
  const ingredientIds = count.lines.map(line => line.ingredient);
  const present = await Ingredient.find({_id: {$in: ingredientIds}})
    .select('_id name').session(session || null).lean();
  const presentIds = new Set(present.map(row => String(row._id)));
  const missing = count.lines.filter(line => !presentIds.has(String(line.ingredient)));
  if (missing.length) {
    return {
      qualifies: true,
      reason: RECOVERY_REASONS.MISSING_INGREDIENT,
      detail: `${missing.length} counted ingredient(s) no longer exist (${missing.slice(0, 3).map(l => l.ingredientName).join(', ')}), so approval fails at the ledger and can never succeed.`,
      ageMinutes,
      missingIngredients: missing.map(line => ({
        ingredient: line.ingredient,
        ingredientName: line.ingredientName
      }))
    };
  }

  // WEDGE 3 — nobody is permitted to approve it. Owners may approve anything,
  // so this only arises when the restaurant has no active owner and the only
  // eligible manager is the person who created or submitted the count.
  const {User} = await import('../models/index.js');
  const submitter = String(count.submittedBy || '');
  const creator = String(count.createdBy || '');
  const approvers = await User.find({
    restaurantId: count.restaurant,
    role: {$in: ['owner', 'manager']},
    active: {$ne: false}
  }).select('_id role branch').session(session || null).lean();

  const eligible = approvers.filter(user => {
    const id = String(user._id);
    if (user.role === 'owner') return true;
    // A manager is bound to their branch and may not approve their own count.
    if (String(user.branch || '') !== String(count.branch)) return false;
    return id !== submitter && id !== creator;
  });

  if (!eligible.length) {
    return {
      qualifies: true,
      reason: RECOVERY_REASONS.NO_ELIGIBLE_APPROVER,
      detail: 'No active owner or independent branch manager can approve this count, so separation of duties leaves it permanently undecidable.',
      ageMinutes
    };
  }

  return {
    qualifies: false,
    reason: null,
    detail: `Approvable by ${eligible.length} user(s); this is a pending decision, not a wedged session.`,
    ageMinutes
  };
}

/**
 * Scans a restaurant (optionally one branch) and reports every session that
 * holds a branch lock, with a verdict for each.
 *
 * Read-only. Safe to run against production at any time.
 */
export async function scanLockedSessions({restaurantId, branchId, minAgeMinutes = DEFAULT_MIN_AGE_MINUTES, session} = {}) {
  if (!restaurantId) throw httpError('A restaurant is required to scan for locked stock counts', 400);
  const match = {restaurant: restaurantId, activeKey: {$type: 'string'}};
  if (branchId) match.branch = branchId;

  const counts = await StockCount.find(match)
    .sort({createdAt: 1})
    .session(session || null);

  const branches = await Branch.find({restaurant: restaurantId})
    .select('name code').session(session || null).lean();
  const branchName = new Map(branches.map(row => [String(row._id), `${row.name} (${row.code})`]));

  const rows = [];
  for (const count of counts) {
    const diagnosis = await diagnoseSession(count, {minAgeMinutes, session});
    rows.push({
      countId: String(count._id),
      countNo: count.countNo,
      branch: String(count.branch),
      branchName: branchName.get(String(count.branch)) || String(count.branch),
      status: count.status,
      scope: count.scope,
      lineCount: count.lines.length,
      submittedAt: count.submittedAt || null,
      updatedAt: count.updatedAt || null,
      ...diagnosis
    });
  }
  return rows;
}

/**
 * Recovers wedged sessions.
 *
 * DRY RUN BY DEFAULT: pass `apply: true` to write. A dry run reports exactly
 * what would change and touches nothing.
 *
 * Idempotent: recovery moves a session to a terminal state and clears its
 * lock, so a second run finds nothing left to do. Re-running is safe.
 */
export async function recoverLockedSessions({
  restaurantId,
  branchId,
  minAgeMinutes = DEFAULT_MIN_AGE_MINUTES,
  apply = false,
  reason,
  actorId = null,
  session
} = {}) {
  const note = clean(reason);
  if (apply && note.length < 10) {
    // An operator running a production recovery must say why, in the audit
    // trail, in words a later reader can act on.
    throw httpError('A recovery reason of at least 10 characters is required when applying', 400);
  }

  const scanned = await scanLockedSessions({restaurantId, branchId, minAgeMinutes, session});
  const eligible = scanned.filter(row => row.qualifies);

  const result = {
    dryRun: !apply,
    minAgeMinutes,
    scanned: scanned.length,
    eligible: eligible.length,
    recovered: 0,
    skipped: scanned.filter(row => !row.qualifies).map(row => ({
      countNo: row.countNo, status: row.status, detail: row.detail, ageMinutes: row.ageMinutes
    })),
    actions: []
  };

  for (const row of eligible) {
    const action = {
      countId: row.countId,
      countNo: row.countNo,
      branchName: row.branchName,
      fromStatus: row.status,
      reason: row.reason,
      detail: row.detail,
      ageMinutes: row.ageMinutes,
      // An orphan lock only needs the lock cleared; the count is already
      // terminal and its decision stands.
      toStatus: row.releaseOnly ? row.status : 'stale'
    };

    if (!apply) {
      result.actions.push({...action, applied: false});
      continue;
    }

    // Re-read inside the write, so a session someone decided between the scan
    // and the write is not clobbered. The evidence fields are `select:false`
    // but are REQUIRED by the schema, so they must be loaded explicitly or
    // saving a terminal count fails its own validation.
    const count = await StockCount.findById(row.countId)
      .select('+requestKey +requestHash +decisionKey +decisionHash')
      .session(session || null);
    // Same defence-in-depth note as the re-diagnosis below: within one run the
    // scan already filtered these out, so removing this alone does not fail
    // the suite. It guards the concurrent case, where the document changed
    // between the scan query and this read.
    if (!count || !count.activeKey) {
      result.actions.push({...action, applied: false, detail: 'Already resolved before the write; nothing to do.'});
      continue;
    }
    // Defence in depth against a decision landing between the scan and this
    // write. The scan above re-diagnoses on every run, so in a single-threaded
    // run this is redundant by design; it exists for the concurrent case, and
    // a mutation removing it therefore survives the suite. Kept deliberately:
    // the cost is one query, the failure it prevents is closing a count a
    // manager approved a moment earlier.
    const recheck = await diagnoseSession(count, {minAgeMinutes, session});
    if (!recheck.qualifies) {
      result.actions.push({...action, applied: false, detail: `No longer qualifies at write time: ${recheck.detail}`});
      continue;
    }

    const before = {
      status: count.status,
      activeKey: count.activeKey,
      countedLineCount: count.countedLineCount,
      totalVarianceValue: count.totalVarianceValue
    };

    count.activeKey = undefined;
    if (!row.releaseOnly) {
      // Closed as `stale`, the same terminal state the approval path uses when
      // a snapshot can no longer be trusted. It posts NOTHING to the ledger.
      // The captured physical quantities stay on the document untouched.
      count.status = 'stale';
      count.staleAt = new Date();
      if (actorId) count.staleDetectedBy = actorId;
      count.staleLines = await buildStaleEvidence(count, session);
    }

    await count.save({session: session || undefined});

    // Append-only: a NEW audit row. Nothing existing is edited or removed.
    await Audit.create([{
      entity: 'stock_count',
      entityId: count._id,
      restaurant: count.restaurant,
      branch: count.branch,
      action: 'stock_count_lock_recovered',
      before,
      after: {
        status: count.status,
        activeKey: null,
        recoveryReason: row.reason,
        detail: row.detail,
        ageMinutes: row.ageMinutes
      },
      reason: note,
      user: actorId || undefined
    }], {session: session || undefined});

    result.recovered += 1;
    result.actions.push({...action, applied: true});
  }

  return result;
}

/**
 * Stale evidence for a recovered session.
 *
 * The schema requires a stale count to carry at least one stale line. Where a
 * balance still exists the real captured-vs-current pair is recorded; where the
 * ingredient itself is gone, `currentQty` is null rather than a fabricated 0,
 * because "unknown" and "zero" are different facts.
 */
async function buildStaleEvidence(count, session) {
  const balances = await InventoryBalance.find({
    branch: count.branch,
    ingredient: {$in: count.lines.map(line => line.ingredient)}
  }).select('ingredient quantity').session(session || null).lean();
  const byIngredient = new Map(balances.map(row => [String(row.ingredient), row]));

  return count.lines.map(line => {
    const balance = byIngredient.get(String(line.ingredient));
    return {
      ingredient: line.ingredient,
      ingredientName: line.ingredientName,
      capturedQty: Number(line.systemQty),
      currentQty: balance ? Number(balance.quantity) : null
    };
  });
}

/**
 * HTTP entry point. Owner-only: this reaches across every branch of a
 * restaurant and closes sessions, which is not a branch-manager action.
 */
export async function runStockCountRecovery({user, branchId, minAgeMinutes, apply = false, reason, session}) {
  const context = await userRestaurantContext(user, {session});
  if (context.role !== 'owner') {
    throw httpError('Only an owner can run stock count lock recovery', 403);
  }
  let scopedBranch = null;
  if (branchId) {
    if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
    const branch = await Branch.findOne({_id: branchId, restaurant: context.restaurantId})
      .select('_id').session(session || null).lean();
    // Scoped by restaurant, so an owner cannot aim recovery at another tenant.
    if (!branch) throw httpError('Branch not found', 404);
    scopedBranch = branch._id;
  }

  const safeMinAge = minAgeMinutes === undefined || minAgeMinutes === null
    ? DEFAULT_MIN_AGE_MINUTES
    : Number(minAgeMinutes);
  if (!Number.isFinite(safeMinAge) || safeMinAge < 0) {
    throw httpError('minAgeMinutes must be a nonnegative number', 400);
  }

  return recoverLockedSessions({
    restaurantId: context.restaurantId,
    branchId: scopedBranch,
    minAgeMinutes: safeMinAge,
    apply,
    reason,
    actorId: context.userId,
    session
  });
}
