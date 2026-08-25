/**
 * P2C — subscription backfill for restaurants that predate billing.
 *
 * THE POLICY, STATED EXPLICITLY
 * -----------------------------
 * Every existing restaurant gets a subscription on ONE named plan, in ONE
 * named status, and nothing else is inferred. The brief forbids inventing
 * commercial history, so this migration:
 *
 *   - does NOT guess which plan a tenant "should" be on from their usage;
 *   - does NOT backdate `startDate` to the restaurant's creation, which would
 *     fabricate a billing relationship that never existed;
 *   - does NOT mark anybody as having paid;
 *   - does NOT reinterpret `Restaurant.status === 'trial'` as a paid plan.
 *
 * The default plan and status are PARAMETERS with conservative defaults, not
 * hardcoded commercial decisions. The operator running the migration chooses,
 * and the choice is recorded in the subscription history of every tenant it
 * touches.
 *
 * SAFETY PROPERTIES
 *   idempotent    a restaurant that already has a subscription is SKIPPED and
 *                 counted, never overwritten. Safe to run twice; the second
 *                 run reports zero created.
 *   dry-run       `--dry-run` reports exactly what would change and writes
 *                 nothing at all.
 *   restartable   each tenant is independent; a crash halfway leaves the
 *                 already-created subscriptions valid and the rest untouched.
 *   never invents a plan. If the named plan does not exist, it ABORTS rather
 *                 than creating one, because a plan carries prices somebody has
 *                 to have approved.
 *   reports unresolved cases rather than silently skipping them.
 *
 * Deliberately NOT in `OPERATIONAL_MIGRATIONS`. Index builds and data repairs
 * belong on the startup path; assigning commercial standing to every tenant on
 * the platform does not happen because somebody restarted a container. Run
 * explicitly, exactly like `tenantBackfill.js` (the P1 precedent).
 */
import mongoose from 'mongoose';
import {Plan, Subscription} from '../models/billing.js';
import {Restaurant} from '../models/operations.js';
import {recordSubscriptionChange, subscriptionSnapshot} from './subscriptionLifecycle.js';

const DAY_MS = 86_400_000;

/**
 * Default policy. Conservative on purpose:
 *   - `starter`, the least-privileged plan, so the migration cannot
 *     accidentally hand out Enterprise features;
 *   - `trialing`, so nobody is recorded as an active paying customer they
 *     never agreed to be.
 */
export const DEFAULT_BACKFILL_PLAN = 'starter';
export const DEFAULT_BACKFILL_STATUS = 'trialing';

/**
 * Assign a subscription to every restaurant that lacks one.
 *
 * Returns a full report rather than logging, so the caller (script or test)
 * decides how to present it.
 */
export async function backfillSubscriptions({
  planCode = DEFAULT_BACKFILL_PLAN,
  status = DEFAULT_BACKFILL_STATUS,
  trialDays = null,
  dryRun = false,
  now = new Date()
} = {}) {
  const report = {
    dryRun,
    planCode,
    status,
    restaurants: 0,
    alreadySubscribed: 0,
    created: 0,
    unresolved: [],
    createdFor: []
  };

  if (!['trialing', 'active'].includes(status)) {
    // A migration must not place tenants straight into a terminal state.
    throw Object.assign(
      new Error(`Backfill status must be trialing or active, not ${status}`), {status: 400});
  }

  const plan = await Plan.findOne({code: String(planCode).toLowerCase()}).lean();
  if (!plan) {
    // Never invent a plan: it carries prices that need commercial approval.
    throw Object.assign(
      new Error(`Plan "${planCode}" does not exist. Seed plans before backfilling subscriptions.`),
      {status: 404}
    );
  }

  const restaurants = await Restaurant.find({}).select('name status').lean();
  report.restaurants = restaurants.length;

  // One query for every existing subscription rather than one per tenant.
  const existing = await Subscription.find({
    restaurant: {$in: restaurants.map(row => row._id)}
  }).select('restaurant').lean();
  const subscribed = new Set(existing.map(row => String(row.restaurant)));

  const effectiveTrialDays = trialDays === null
    ? Number(plan.trialDays || 0)
    : Number(trialDays);

  for (const restaurant of restaurants) {
    if (subscribed.has(String(restaurant._id))) {
      // NEVER overwrite. This is what makes a second run a no-op.
      report.alreadySubscribed += 1;
      continue;
    }

    const trialing = status === 'trialing' && effectiveTrialDays > 0;
    if (status === 'trialing' && effectiveTrialDays <= 0) {
      // Asked for a trial on a plan with no trial period. Reported rather than
      // silently converted to `active`, which would upgrade a tenant's
      // commercial standing without anybody deciding to.
      report.unresolved.push({
        restaurant: String(restaurant._id),
        name: restaurant.name,
        reason: `plan "${plan.code}" has trialDays=0, cannot start a trial`
      });
      continue;
    }

    if (dryRun) {
      report.created += 1;
      report.createdFor.push({
        restaurant: String(restaurant._id), name: restaurant.name,
        plan: plan.code, status
      });
      continue;
    }

    const created = await Subscription.create({
      restaurant: restaurant._id,
      plan: plan._id,
      status,
      // NOT backdated. The commercial relationship starts when it is recorded.
      startDate: now,
      trialStart: trialing ? now : null,
      trialEnd: trialing ? new Date(now.getTime() + effectiveTrialDays * DAY_MS) : null,
      currentPeriodStart: now,
      currentPeriodEnd: trialing
        ? new Date(now.getTime() + effectiveTrialDays * DAY_MS)
        : new Date(now.getTime() + 30 * DAY_MS),
      note: 'Created by the P2C subscription backfill'
    });

    await recordSubscriptionChange({
      subscription: created,
      restaurantId: restaurant._id,
      event: trialing ? 'trial_started' : 'plan_assigned',
      before: null,
      after: subscriptionSnapshot(created),
      reason: `P2C backfill: assigned ${plan.code} (${status})`,
      actor: null,
      // Named so history shows this was a migration, not an operator decision.
      systemActor: 'system:migration'
    });

    report.created += 1;
    report.createdFor.push({
      restaurant: String(restaurant._id), name: restaurant.name,
      plan: plan.code, status
    });
  }

  return report;
}

/**
 * Report what a backfill would do, writing nothing. A thin alias so the intent
 * is unambiguous at the call site.
 */
export function verifySubscriptionCoverage(options = {}) {
  return backfillSubscriptions({...options, dryRun: true});
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const planArg = args.find(a => a.startsWith('--plan='));
  const statusArg = args.find(a => a.startsWith('--status='));

  const uri = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/mittho';

  const {installAuditChain} = await import('./auditTrail.js');
  await mongoose.connect(uri);
  installAuditChain();
  try {
    const report = await backfillSubscriptions({
      dryRun,
      ...(planArg ? {planCode: planArg.split('=')[1]} : {}),
      ...(statusArg ? {status: statusArg.split('=')[1]} : {})
    });
    console.log(`\n${dryRun ? 'DRY RUN — nothing was written' : 'Subscription backfill complete'}\n`);
    console.log(`  plan                 ${report.planCode} (${report.status})`);
    console.log(`  restaurants          ${report.restaurants}`);
    console.log(`  already subscribed   ${report.alreadySubscribed}`);
    console.log(`  ${dryRun ? 'would create       ' : 'created            '}  ${report.created}`);
    if (report.unresolved.length) {
      console.log(`\n  UNRESOLVED (${report.unresolved.length}):`);
      for (const row of report.unresolved) console.log(`    ${row.name}: ${row.reason}`);
    }
    console.log('');
  } finally {
    await mongoose.disconnect();
  }
}
