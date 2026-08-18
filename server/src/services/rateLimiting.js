/**
 * Rate-limit layer.
 *
 * SCOPE AND CORRECTNESS
 * ---------------------
 * Counters live in this process's memory (express-rate-limit's MemoryStore).
 *
 *   Single API instance   → supported and correct.
 *   Multiple API instances→ NOT correct. Each container keeps its own counters,
 *                           so with N containers behind a load balancer the
 *                           effective limit is up to N × max. This is a known,
 *                           documented limitation, not a solved problem.
 *
 * The current deployment (docker-compose.yml) runs exactly one `api` service
 * and no Redis, so a shared store would be a new production dependency with no
 * present benefit. Rather than add one speculatively, the store is injected
 * through `configureRateLimitStore()`: introducing `rate-limit-redis` later is
 * a single call at startup and touches no route.
 *
 * CLIENT IDENTITY
 * ---------------
 * The bucket key is `req.ip`, which Express derives from the socket peer plus
 * the `trust proxy` setting (see services/deployment.js). Behind the nginx in
 * client/nginx.conf with TRUST_PROXY=1, req.ip is the rightmost entry that
 * nginx appended to X-Forwarded-For — the real client. With trust proxy
 * misconfigured to trust more hops than exist, a caller could prepend a forged
 * entry and change their own bucket, which is exactly why the default is
 * 'loopback' and `true`/`*` is rejected outright.
 *
 * Authenticated requests are keyed by user id where a limiter is applied to a
 * staff route, so one abusive account cannot exhaust the bucket of everyone
 * sharing an office NAT address.
 */
import rateLimit, {MemoryStore} from 'express-rate-limit';

/**
 * Login throttle. 10 attempts per 15 minutes per client IP is enough for a
 * fat-fingered barista and far too slow for credential stuffing.
 */
export const AUTH_RATE_LIMIT = Object.freeze({windowMs: 15 * 60_000, max: 10});

let storeFactory = null;
const activeStores = new Set();

/**
 * Install a shared store factory (for example rate-limit-redis) before any
 * limiter is built. Passing null restores per-process memory counters.
 */
export function configureRateLimitStore(factory) {
  storeFactory = typeof factory === 'function' ? factory : null;
}

/** True once a shared store has been installed; drives the /health report. */
export function rateLimitScope() {
  return storeFactory ? 'shared-store' : 'per-instance-memory';
}

/**
 * Build a limiter.
 *
 * @param {object}   options            windowMs / max, plus any express-rate-limit option.
 * @param {string}   options.name       identifies the limiter in logs and tests.
 * @param {boolean}  options.byUser     key authenticated callers by user id.
 * @param {function} options.enabled    predicate evaluated PER REQUEST.
 *
 * `enabled` is read per request on purpose: ES module imports are hoisted, so a
 * test harness that sets NODE_ENV after import cannot beat a decision made at
 * module-load time.
 */
export function createRateLimiter({name, byUser = false, enabled, ...options}) {
  const store = storeFactory ? storeFactory({name, ...options}) : new MemoryStore();
  activeStores.add(store);

  const limiter = rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    // express-rate-limit's own trust-proxy heuristic guesses wrong for a
    // deliberate hop count; deployment.js owns that decision and is tested.
    validate: {trustProxy: false, xForwardedForHeader: false},
    store,
    keyGenerator: (req, res) => {
      if (byUser && req.user?.id) return `user:${req.user.id}`;
      return `ip:${ipKey(req)}`;
    },
    handler: (req, res) => res.status(429).json({
      message: 'Too many requests. Please slow down and try again shortly.'
    }),
    ...options
  });

  const isEnabled = typeof enabled === 'function' ? enabled : () => true;
  const wrapped = (req, res, next) => (isEnabled(req) ? limiter(req, res, next) : next());
  wrapped.limiterName = name;
  wrapped.resetKey = key => limiter.resetKey?.(key);
  return wrapped;
}

/**
 * Normalised client identity.
 *
 * req.ip already honours `trust proxy`. IPv4-mapped IPv6 addresses
 * (::ffff:203.0.113.9) are folded so the same client cannot occupy two buckets
 * depending on how the socket was accepted.
 */
export function ipKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return String(ip).replace(/^::ffff:/, '');
}

/** Test/ops helper: drop every counter held by every limiter built here. */
export async function resetAllRateLimits() {
  for (const store of activeStores) await store.resetAll?.();
}
