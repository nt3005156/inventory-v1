/**
 * P2C — subscription lifecycle sweep.
 *
 * WHAT IT DOES
 *   trialing, trialEnd  <= now  ->  expired   (trial_expired)
 *   active,   periodEnd <= now  ->  expired   (subscription_expired)
 *   any,      periodEnd <= now and cancelAtPeriodEnd -> cancelled
 *
 * NO SECOND SCHEDULER
 * -------------------
 * The brief is explicit, and the repository already has the machinery: this
 * reuses `mongoSchedulerLock()` from `schedulerLock.js` — the Mongo TTL lease
 * that Phase 16B built for the reorder sweep — under a DIFFERENT lock name, so
 * the two jobs do not block each other while each stays singleton across
 * instances. Nothing about the locking mechanism is reimplemented here.
 *
 * WHY A SWEEP AT ALL, GIVEN THE RESOLVER ALREADY COMPUTES EXPIRY
 * --------------------------------------------------------------
 * `resolveEntitlement()` treats a lapsed trial as non-operational from the
 * DATE, regardless of the stored status. That is what makes the deadline
 * deterministic and means a stopped scheduler can never produce a hidden
 * infinite trial — access stops on time whether or not this job ever runs.
 *
 * So the sweep is NOT the enforcement mechanism. It exists to make the stored
 * status agree with reality, so that platform listings, filters and history are
 * honest rather than showing a tenant as `trialing` six weeks after their trial
 * ended. Enforcement is in the resolver; bookkeeping is here. Keeping those
 * separate is what makes the job safe to be late, to be skipped, or to be
 * turned off entirely.
 *
 * IDEMPOTENT AND RESTARTABLE. Each transition is guarded by the state machine
 * and re-queried per document, so running it twice changes nothing the second
 * time, and a crash mid-sweep leaves every already-processed row correct.
 */
import {Subscription} from '../models/billing.js';
import {ensureSchedulerLockIndexes, mongoSchedulerLock} from './schedulerLock.js';
import {expireSubscription} from './subscriptionLifecycle.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
/** Bounded so one sweep cannot hold the lease for an unbounded time. */
const MAX_PER_SWEEP = 500;

let state = null;
let lockProvider = null;

/** Swap in an external lock, mirroring the reorder scheduler's seam. */
export function setSubscriptionSchedulerLock(provider) {
  lockProvider = typeof provider?.acquire === 'function' ? provider : null;
  return lockProvider;
}

const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

export function resolveSubscriptionSchedulerConfig(env = process.env) {
  const enabled = truthy(env.SUBSCRIPTION_SCHEDULER_ENABLED);
  const distributedLock = env.SUBSCRIPTION_SCHEDULER_DISTRIBUTED_LOCK === undefined
    ? true
    : truthy(env.SUBSCRIPTION_SCHEDULER_DISTRIBUTED_LOCK);
  const raw = Number(env.SUBSCRIPTION_SCHEDULER_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES);
  const intervalMinutes = Number.isFinite(raw)
    ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.trunc(raw)))
    : DEFAULT_INTERVAL_MINUTES;
  const ttlRaw = Number(env.SUBSCRIPTION_SCHEDULER_LOCK_TTL_SECONDS ?? 300);
  return {
    enabled,
    intervalMinutes,
    distributedLock,
    lockTtlSeconds: Number.isFinite(ttlRaw) ? Math.max(30, Math.trunc(ttlRaw)) : 300
  };
}

/**
 * One pass. Exported so tests can drive it deterministically with an injected
 * clock rather than waiting for a timer.
 *
 * `shouldContinue` lets a lease-backed caller abort mid-sweep if the lease is
 * lost, so two instances cannot both be writing after a lease handover.
 */
export async function runSubscriptionSweep({
  now = new Date(), limit = MAX_PER_SWEEP, shouldContinue = () => true
} = {}) {
  const result = {trialsExpired: 0, subscriptionsExpired: 0, cancelled: 0, checked: 0, stopped: false};

  // Lapsed trials.
  const lapsedTrials = await Subscription.find({
    status: 'trialing', trialEnd: {$ne: null, $lte: now}
  }).select('_id restaurant').limit(limit).lean();

  for (const row of lapsedTrials) {
    if (!shouldContinue()) { result.stopped = true; return result; }
    result.checked += 1;
    const outcome = await expireSubscription({
      subscriptionId: row._id, event: 'trial_expired',
      reason: 'Trial period ended', now
    });
    if (outcome.changed) result.trialsExpired += 1;
  }

  // Lapsed active periods.
  const lapsedActive = await Subscription.find({
    status: 'active', currentPeriodEnd: {$ne: null, $lte: now}
  }).select('_id restaurant cancelAtPeriodEnd').limit(limit).lean();

  for (const row of lapsedActive) {
    if (!shouldContinue()) { result.stopped = true; return result; }
    result.checked += 1;
    // A scheduled cancellation becomes a real one at the period boundary.
    const outcome = row.cancelAtPeriodEnd
      ? await expireSubscription({
        subscriptionId: row._id, event: 'subscription_cancelled',
        targetStatus: 'cancelled', reason: 'Cancellation took effect at period end', now
      })
      : await expireSubscription({
        subscriptionId: row._id, event: 'subscription_expired',
        reason: 'Billing period ended', now
      });
    if (outcome.changed) {
      if (row.cancelAtPeriodEnd) result.cancelled += 1;
      else result.subscriptionsExpired += 1;
    }
  }

  return result;
}

export function subscriptionSchedulerStatus() {
  if (!state) return {running: false};
  return {
    running: true,
    intervalMinutes: state.intervalMinutes,
    distributedLock: state.distributedLock,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    lastError: state.lastError
  };
}

/**
 * Start the interval timer. Singleton per process; disabled unless
 * `SUBSCRIPTION_SCHEDULER_ENABLED` is set, so no existing deployment starts
 * doing commercial state transitions merely by upgrading.
 */
export async function startSubscriptionScheduler({env = process.env} = {}) {
  if (state) return state;
  const config = resolveSubscriptionSchedulerConfig(env);
  if (!config.enabled) return null;

  if (config.distributedLock) {
    await ensureSchedulerLockIndexes();
    if (!lockProvider) {
      // A DIFFERENT lock name from the reorder sweep, so the two singletons
      // are independent — sharing a name would let one job starve the other.
      lockProvider = mongoSchedulerLock({
        name: 'subscription-sweep', ttlSeconds: config.lockTtlSeconds
      });
    }
  }

  state = {
    intervalMinutes: config.intervalMinutes,
    distributedLock: config.distributedLock,
    lastRun: null,
    lastResult: null,
    lastError: null,
    busy: false,
    timer: null
  };

  const tick = async () => {
    // A slow sweep skips the next tick rather than piling up.
    if (state.busy) return;
    state.busy = true;
    let release = null;
    try {
      if (config.distributedLock && lockProvider) {
        release = await lockProvider.acquire();
        // Another instance holds the lease; that instance is doing the work.
        if (!release) return;
      }
      let held = true;
      const result = await runSubscriptionSweep({
        shouldContinue: () => held || !config.distributedLock
      });
      state.lastRun = new Date();
      state.lastResult = result;
      state.lastError = null;
      held = false;
    } catch (error) {
      // The timer must survive a failing sweep; the API must never go down
      // because a commercial bookkeeping job threw.
      state.lastError = error?.message || String(error);
      console.error('Subscription sweep failed', {message: state.lastError});
    } finally {
      if (typeof release === 'function') {
        try { await release(); } catch { /* lease already expired */ }
      }
      state.busy = false;
    }
  };

  state.timer = setInterval(tick, config.intervalMinutes * 60_000);
  // Never hold the process open during shutdown.
  if (typeof state.timer.unref === 'function') state.timer.unref();
  return state;
}

export function stopSubscriptionScheduler() {
  if (!state) return false;
  clearInterval(state.timer);
  state = null;
  return true;
}
