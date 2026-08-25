/**
 * P1C — backfill direct tenant ownership onto Order and Payment.
 *
 *   Order.branch  ->  Branch.restaurant  ->  Order.restaurant
 *   Payment.order ->  Order.restaurant   ->  Payment.restaurant + branch
 *
 * WHY A MIGRATION AND NOT A DEFAULT. Every row written before P1B has no
 * `restaurant`. Those rows are historical sales and historical money; they
 * cannot be recreated and must not be guessed at.
 *
 * THE RULES THIS MIGRATION HOLDS TO
 * ---------------------------------
 * 1. IDEMPOTENT. Only rows with no `restaurant` are touched, so running it
 *    twice changes nothing the second time. Safe to put in startup.
 *
 * 2. RESTARTABLE. Work happens in bounded batches with no cross-batch state.
 *    Killing it halfway leaves a consistent partial result that the next run
 *    continues from — there is no "resume token" to lose.
 *
 * 3. IT NEVER INVENTS A TENANT ID. This is the rule that matters most. A row
 *    whose branch is missing, or whose branch has no restaurant, is REPORTED
 *    as unresolved and left alone. Stamping a plausible-looking tenant onto an
 *    order would silently move somebody's money between tenants, which is
 *    worse than leaving the row unmigrated and visible in a report.
 *
 * 4. DRY RUN FIRST. `dryRun: true` reports exactly what would change and what
 *    cannot be resolved, without writing. An operator should always run that
 *    against a copy of production before the real thing.
 *
 * It is deliberately NOT wired into OPERATIONAL_MIGRATIONS in this phase: a
 * backfill over the two largest collections should be an explicit operator
 * decision on first upgrade, not a surprise during a container restart.
 */
import mongoose from 'mongoose';
import {Branch, Order, Payment} from '../models/operations.js';

const DEFAULT_BATCH = 500;

/**
 * Map every branch to its restaurant, once.
 *
 * There are tens of branches and potentially millions of orders, so this is
 * one query rather than a lookup per row.
 */
async function branchTenantMap(session) {
  const branches = await Branch.find({}).select('_id restaurant').session(session || null).lean();
  const map = new Map();
  for (const branch of branches) {
    if (branch.restaurant) map.set(String(branch._id), branch.restaurant);
  }
  return map;
}

/**
 * Stage 1 — Order.branch -> Branch.restaurant -> Order.restaurant.
 *
 * Returns counts plus the ids of anything that could not be resolved, so a
 * human can look at them rather than the migration deciding for them.
 */
export async function backfillOrderTenants({
  dryRun = false, batchSize = DEFAULT_BATCH, session = null, log = () => {}
} = {}) {
  const tenants = await branchTenantMap(session);
  const result = {scanned: 0, updated: 0, unresolved: [], alreadyTagged: 0};

  const total = await Order.countDocuments({restaurant: {$exists: false}}).session(session || null);
  result.alreadyTagged = await Order.countDocuments({restaurant: {$exists: true}}).session(session || null);
  log(`  orders needing a tenant: ${total} (already tagged: ${result.alreadyTagged})`);

  // Cursor over untagged rows only. Because the write REMOVES a row from this
  // filter, a plain repeated query would skip; a cursor with a stable sort and
  // a batched bulk write is both restartable and skip-free.
  let lastId = null;
  for (;;) {
    const filter = {restaurant: {$exists: false}};
    if (lastId) filter._id = {$gt: lastId};
    const batch = await Order.find(filter)
      .select('_id branch')
      .sort({_id: 1})
      .limit(batchSize)
      .session(session || null)
      .lean();
    if (!batch.length) break;
    lastId = batch[batch.length - 1]._id;
    result.scanned += batch.length;

    const writes = [];
    for (const order of batch) {
      const restaurant = order.branch ? tenants.get(String(order.branch)) : null;
      if (!restaurant) {
        // NEVER guessed. Recorded and skipped.
        result.unresolved.push({
          collection: 'orders',
          _id: String(order._id),
          reason: order.branch ? 'branch has no restaurant' : 'order has no branch'
        });
        continue;
      }
      writes.push({updateOne: {filter: {_id: order._id}, update: {$set: {restaurant}}}});
    }

    if (writes.length && !dryRun) {
      await Order.bulkWrite(writes, {session: session || undefined, ordered: false});
    }
    result.updated += writes.length;
  }

  log(`  orders ${dryRun ? 'that would be' : ''} updated: ${result.updated}, unresolved: ${result.unresolved.length}`);
  return result;
}

/**
 * Stage 2 — Payment.order -> Order.restaurant -> Payment.restaurant + branch.
 *
 * Runs AFTER stage 1, because it reads the tenant that stage 1 wrote. Doing it
 * the other way round would leave every payment unresolved on a fresh upgrade.
 */
export async function backfillPaymentTenants({
  dryRun = false, batchSize = DEFAULT_BATCH, session = null, log = () => {}
} = {}) {
  const result = {scanned: 0, updated: 0, unresolved: [], alreadyTagged: 0};

  const total = await Payment.countDocuments({restaurant: {$exists: false}}).session(session || null);
  result.alreadyTagged = await Payment.countDocuments({restaurant: {$exists: true}}).session(session || null);
  log(`  payments needing a tenant: ${total} (already tagged: ${result.alreadyTagged})`);

  let lastId = null;
  for (;;) {
    const filter = {restaurant: {$exists: false}};
    if (lastId) filter._id = {$gt: lastId};
    const batch = await Payment.find(filter)
      .select('_id order')
      .sort({_id: 1})
      .limit(batchSize)
      .session(session || null)
      .lean();
    if (!batch.length) break;
    lastId = batch[batch.length - 1]._id;
    result.scanned += batch.length;

    // One query for the whole batch's orders rather than one per payment.
    const orderIds = batch.map(row => row.order).filter(Boolean);
    const orders = orderIds.length
      ? await Order.find({_id: {$in: orderIds}})
        .select('_id restaurant branch').session(session || null).lean()
      : [];
    const byId = new Map(orders.map(order => [String(order._id), order]));

    const writes = [];
    for (const payment of batch) {
      const order = payment.order ? byId.get(String(payment.order)) : null;
      if (!order) {
        result.unresolved.push({
          collection: 'payments',
          _id: String(payment._id),
          reason: payment.order ? 'order not found' : 'payment has no order'
        });
        continue;
      }
      if (!order.restaurant) {
        // Its order is itself unmigrated — reported, not guessed.
        result.unresolved.push({
          collection: 'payments',
          _id: String(payment._id),
          reason: 'order has no restaurant (run the order backfill first)'
        });
        continue;
      }
      writes.push({
        updateOne: {
          filter: {_id: payment._id},
          update: {$set: {restaurant: order.restaurant, ...(order.branch ? {branch: order.branch} : {})}}
        }
      });
    }

    if (writes.length && !dryRun) {
      await Payment.bulkWrite(writes, {session: session || undefined, ordered: false});
    }
    result.updated += writes.length;
  }

  log(`  payments ${dryRun ? 'that would be' : ''} updated: ${result.updated}, unresolved: ${result.unresolved.length}`);
  return result;
}

/**
 * Run both stages in order and summarise.
 *
 * `ok` is false when ANYTHING was left unresolved. A partially migrated
 * database is not a failure to be hidden — it is a state an operator must look
 * at, because the unresolved rows are usually orphaned data worth
 * understanding before it is patched.
 */
export async function backfillTenantOwnership({
  dryRun = false, batchSize = DEFAULT_BATCH, log = () => {}
} = {}) {
  const started = Date.now();
  log(dryRun ? 'Tenant backfill (DRY RUN — no writes)' : 'Tenant backfill');
  const orders = await backfillOrderTenants({dryRun, batchSize, log});
  const payments = await backfillPaymentTenants({dryRun, batchSize, log});

  const unresolved = [...orders.unresolved, ...payments.unresolved];
  const summary = {
    dryRun,
    durationMs: Date.now() - started,
    orders: {scanned: orders.scanned, updated: orders.updated, alreadyTagged: orders.alreadyTagged},
    payments: {scanned: payments.scanned, updated: payments.updated, alreadyTagged: payments.alreadyTagged},
    unresolved,
    unresolvedCount: unresolved.length,
    ok: unresolved.length === 0
  };
  log(`  done in ${summary.durationMs}ms — ok=${summary.ok}`);
  return summary;
}

/**
 * Post-migration assertion, for use as a gate.
 *
 * Counts what is still untagged. An operator (or a later phase that wants to
 * make the field `required`) can call this to decide whether the platform is
 * safe to tighten.
 */
export async function verifyTenantOwnership() {
  const [orders, payments] = await Promise.all([
    Order.countDocuments({restaurant: {$exists: false}}),
    Payment.countDocuments({restaurant: {$exists: false}})
  ]);
  return {
    ok: orders === 0 && payments === 0,
    ordersWithoutTenant: orders,
    paymentsWithoutTenant: payments
  };
}

/** CLI: `node src/services/tenantBackfill.js --dry-run` */
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('tenantBackfill.js');
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(process.env.MONGODB_URI);
  const summary = await backfillTenantOwnership({dryRun, log: console.log});
  console.log(JSON.stringify({...summary, unresolved: summary.unresolved.slice(0, 25)}, null, 2));
  const check = await verifyTenantOwnership();
  console.log('verification:', JSON.stringify(check));
  await mongoose.disconnect();
  process.exit(summary.ok ? 0 : 1);
}
