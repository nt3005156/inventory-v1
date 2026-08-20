import mongoose from 'mongoose';
import {Restaurant} from '../models/operations.js';
import {User} from '../models/index.js';
import {raiseReorderAlerts} from './reorderEngine.js';
import {ensureSchedulerLockIndexes, mongoSchedulerLock} from './schedulerLock.js';

/**
 * Phase 16A — scheduled reorder sweep.
 *
 * ── HORIZONTAL SCALING LIMITATION, STATED PLAINLY ─────────────────────────
 * This is an IN-PROCESS interval timer. If the API is run as more than one
 * container, every container will tick. That is deliberately not pretended
 * away, and it is safe here for one specific reason: the sweep's only write is
 * an alert insert guarded by the unique partial index
 * `alert_open_condition` on {branch, type, referenceId} scoped to
 * open/acknowledged (see alertMigration.js). A second container's duplicate
 * insert loses the race with E11000 and is swallowed, so N containers still
 * produce ONE alert per condition.
 *
 * What multiple containers would still cost is N times the read load, and
 * `lastRun` telemetry that reflects only the local process. A leader election
 * or a distributed lock (Redis, or a MongoDB TTL lock document) is the correct
 * fix before horizontal scaling, and the repository has no Redis and no lock
 * collection today. Rather than invent one, this uses the existing
 * `configureRateLimitStore()`-style seam: `setSchedulerLock()` accepts an
 * external lock implementation, so a deployment that scales out can supply one
 * without touching this module.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Safety properties:
 *   * one timer per process, enforced by a module-level singleton, so
 *     importing this from several modules cannot start two schedulers;
 *   * a tick never overlaps itself — a slow sweep skips the next tick rather
 *     than piling up;
 *   * every error is caught and logged; the timer survives and the API is
 *     never brought down by a failing sweep;
 *   * `unref()` so the timer cannot hold the process open during shutdown;
 *   * disabled by default, enabled by environment configuration.
 */

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;

/** Module-level singleton. Importing this twice must not start two timers. */
let state = null;

/** Optional external mutual exclusion, for a future multi-container deploy. */
let lockProvider = null;

/**
 * Supply a distributed lock. `acquire()` should return a falsy value when
 * another instance holds the lock, and a release function otherwise.
 */
export function setSchedulerLock(provider) {
  lockProvider = typeof provider?.acquire === 'function' ? provider : null;
  return lockProvider;
}

const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/** Reads scheduler configuration from the environment. */
export function resolveSchedulerConfig(env = process.env) {
  const enabled = truthy(env.REORDER_SCHEDULER_ENABLED);
  // Phase 16B: the distributed lock is ON by default whenever the scheduler is
  // enabled, because the repository already mandates a replica set. It can be
  // turned off for a single-instance deployment that wants to skip the extra
  // round trip, but that choice is now explicit rather than the silent default.
  const distributedLock = env.REORDER_SCHEDULER_DISTRIBUTED_LOCK === undefined
    ? true
    : truthy(env.REORDER_SCHEDULER_DISTRIBUTED_LOCK);
  const lockTtlRaw = Number(env.REORDER_SCHEDULER_LOCK_TTL_SECONDS ?? 300);
  const raw = Number(env.REORDER_SCHEDULER_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES);
  const intervalMinutes = Number.isFinite(raw)
    ? Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.trunc(raw)))
    : DEFAULT_INTERVAL_MINUTES;
  const lookbackDaysRaw = Number(env.REORDER_SCHEDULER_LOOKBACK_DAYS ?? 30);
  return {
    enabled,
    intervalMinutes,
    intervalMs: intervalMinutes * 60000,
    lookbackDays: Number.isFinite(lookbackDaysRaw) ? Math.min(365, Math.max(1, Math.trunc(lookbackDaysRaw))) : 30,
    distributedLock,
    lockTtlSeconds: Number.isFinite(lockTtlRaw) ? Math.min(3600, Math.max(30, Math.trunc(lockTtlRaw))) : 300,
    // Honest about what this is.
    distributed: Boolean(lockProvider),
    scope: lockProvider ? 'distributed-lock' : 'in-process'
  };
}

/**
 * Runs the sweep once for every restaurant, as that restaurant's owner.
 *
 * The sweep is tenant-scoped by design: it reuses `raiseReorderAlerts`, which
 * derives its scope from the acting user, so it cannot reach across
 * restaurants. A restaurant with no active owner is skipped and reported
 * rather than swept with borrowed privileges.
 */
export async function runScheduledSweep({lookbackDays = 30} = {}) {
  const started = Date.now();
  const result = {
    startedAt: new Date(started),
    restaurants: 0,
    swept: 0,
    skipped: [],
    raised: 0,
    errors: []
  };

  if (mongoose.connection.readyState !== 1) {
    result.errors.push({scope: 'connection', message: 'MongoDB is not connected; sweep skipped'});
    result.durationMs = Date.now() - started;
    return result;
  }

  const restaurants = await Restaurant.find({}).select('_id name').lean();
  result.restaurants = restaurants.length;

  for (const restaurant of restaurants) {
    try {
      // Act as a real owner of that restaurant. Fabricating a superuser would
      // bypass the tenancy guards the sweep depends on for its scoping.
      const owner = await User.findOne({
        restaurantId: restaurant._id, role: 'owner', active: {$ne: false}
      }).select('_id role restaurantId branch').lean();
      if (!owner) {
        result.skipped.push({restaurant: String(restaurant._id), reason: 'No active owner to scope the sweep'});
        continue;
      }
      const actor = {id: String(owner._id), role: 'owner', restaurantId: String(restaurant._id)};
      const outcome = await raiseReorderAlerts({user: actor, lookbackDays});
      // Also durably record the computed classes (high waste, unusual
      // consumption) so they can be acknowledged rather than only appearing
      // in a live list.
      const {persistComputedAlerts} = await import('./alerts.js');
      const computed = await persistComputedAlerts({user: actor, restaurantId: restaurant._id})
        .catch(error => {
          result.errors.push({restaurant: String(restaurant._id), message: `Computed alerts: ${error?.message}`});
          return {persisted: 0};
        });
      result.swept += 1;
      result.raised += Number(outcome?.raised || 0) + Number(computed?.persisted || 0);
    } catch (error) {
      // One tenant's bad data must never stop the others, and must never take
      // the API down.
      result.errors.push({restaurant: String(restaurant._id), message: error?.message || 'Sweep failed'});
    }
  }

  result.durationMs = Date.now() - started;
  result.finishedAt = new Date();
  return result;
}

/** Current scheduler telemetry, for the health/diagnostics endpoint. */
export function schedulerStatus() {
  if (!state) return {running: false, ...resolveSchedulerConfig()};
  return {
    running: true,
    intervalMinutes: state.config.intervalMinutes,
    lookbackDays: state.config.lookbackDays,
    distributed: Boolean(lockProvider),
    lockKind: lockProvider?.kind || null,
    scope: lockProvider ? 'distributed-lock' : 'in-process',
    ticks: state.ticks,
    inFlight: state.inFlight,
    lastRunAt: state.lastRunAt,
    lastDurationMs: state.lastDurationMs,
    lastRaised: state.lastRaised,
    lastError: state.lastError,
    skippedOverlaps: state.skippedOverlaps,
    lockContentions: state.lockContentions
  };
}

/**
 * Starts the scheduler. Idempotent: a second call returns the running
 * instance rather than starting a second timer.
 */
export function startReorderScheduler({env = process.env, logger = console} = {}) {
  const config = resolveSchedulerConfig(env);
  if (!config.enabled) return {started: false, reason: 'REORDER_SCHEDULER_ENABLED is not set', config};
  // Singleton guard: several modules may initialise, only one timer may exist.
  if (state) return {started: false, reason: 'Scheduler already running', config: state.config};

  // Install the MongoDB lease lock unless a provider was injected by a test or
  // a deployment explicitly opted out.
  if (!lockProvider && config.distributedLock) {
    setSchedulerLock(mongoSchedulerLock({ttlSeconds: config.lockTtlSeconds}));
    ensureSchedulerLockIndexes().catch(error =>
      logger.warn?.('[reorder-scheduler] could not build the lock TTL index', error?.message));
  }

  const local = {
    config,
    ticks: 0,
    inFlight: false,
    skippedOverlaps: 0,
    lockContentions: 0,
    lastRunAt: null,
    lastDurationMs: null,
    lastRaised: null,
    lastError: null,
    timer: null
  };

  const tick = async () => {
    // A slow sweep must not overlap itself and stack up work.
    if (local.inFlight) {
      local.skippedOverlaps += 1;
      return;
    }
    local.inFlight = true;
    let release = null;
    try {
      if (lockProvider) {
        release = await lockProvider.acquire();
        if (!release) {
          // Another instance holds the lease. Not an error: exactly one
          // instance doing the work is the whole point.
          local.lockContentions += 1;
          return;
        }
      }
      local.ticks += 1;
      const outcome = await runScheduledSweep({lookbackDays: config.lookbackDays});
      local.lastRunAt = outcome.finishedAt || new Date();
      local.lastDurationMs = outcome.durationMs;
      local.lastRaised = outcome.raised;
      local.lastError = outcome.errors.length ? outcome.errors[0].message : null;
      if (outcome.errors.length) {
        logger.warn?.('[reorder-scheduler] sweep completed with errors', {errors: outcome.errors.length});
      }
    } catch (error) {
      // Never let a scheduler failure reach the process. The API keeps serving.
      local.lastError = error?.message || 'Scheduled sweep failed';
      logger.error?.('[reorder-scheduler] sweep failed', local.lastError);
    } finally {
      local.inFlight = false;
      if (typeof release === 'function') {
        try { await release(); } catch { /* releasing a lock must not throw upward */ }
      }
    }
  };

  local.timer = setInterval(tick, config.intervalMs);
  // Do not hold the event loop open; shutdown must not wait for a timer.
  local.timer.unref?.();
  local.tick = tick;
  state = local;

  logger.log?.(
    `[reorder-scheduler] enabled every ${config.intervalMinutes}m `
    + `(${lockProvider ? 'distributed lock' : 'in-process; not safe across multiple API containers without a lock'})`
  );
  return {started: true, config, runNow: tick};
}

/** Stops the scheduler. Safe to call when it was never started. */
export async function stopReorderScheduler() {
  if (!state) return {stopped: false};
  clearInterval(state.timer);
  const wasInFlight = state.inFlight;
  state = null;
  return {stopped: true, wasInFlight};
}

/** Test seam: run one tick synchronously without waiting for the interval. */
export async function triggerSchedulerTick() {
  if (!state) throw Object.assign(new Error('Scheduler is not running'), {status: 409});
  await state.tick();
  return schedulerStatus();
}
