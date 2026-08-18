/**
 * Deployment topology configuration: environment class, trust proxy and CORS.
 *
 * Expected production topology (docker-compose.yml + client/nginx.conf):
 *
 *   Browser ──► web (nginx :80) ──► api (express :4000)
 *
 * Nginx is the ONLY reverse proxy in front of the API. It rewrites Host and
 * appends the real peer address to X-Forwarded-For, and the API port is
 * published on 127.0.0.1 only, so nothing outside the host can reach Express
 * directly. Express must therefore trust exactly one hop — no more. Trusting
 * more hops than actually exist lets a caller prepend a forged
 * X-Forwarded-For entry and steal someone else's rate-limit bucket, or hide
 * from their own.
 *
 * Because "how many proxies are in front of me" is a deployment fact and not a
 * code fact, it is configuration (TRUST_PROXY) with a *safe* default rather
 * than a hardcoded 1.
 */

const HARDENED_ENVIRONMENTS = new Set(['staging', 'production']);
const KNOWN_ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production']);

/**
 * Resolve which of development / test / staging / production this process is.
 *
 * NODE_ENV alone cannot express staging: build tooling only understands
 * "production" or not, and a staging box that runs with NODE_ENV=production
 * still needs production-grade CORS. APP_ENV is the explicit deployment class
 * and wins when set; NODE_ENV is the fallback. Anything unrecognised is
 * treated as production, because guessing "development" for an unknown value
 * would silently unlock the permissive path.
 */
export function resolveEnvironment(env = process.env) {
  const declared = String(env.APP_ENV || '').trim().toLowerCase();
  if (declared) {
    if (!KNOWN_ENVIRONMENTS.has(declared)) {
      throw new Error(`APP_ENV must be one of development, test, staging, production (received: ${declared})`);
    }
    return declared;
  }
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  if (!nodeEnv) return 'development';
  if (KNOWN_ENVIRONMENTS.has(nodeEnv)) return nodeEnv;
  return 'production';
}

/** Staging and production get identical, non-negotiable hardening. */
export function isHardenedEnvironment(env = process.env) {
  return HARDENED_ENVIRONMENTS.has(resolveEnvironment(env));
}

/**
 * Express `trust proxy` value.
 *
 *   unset            → 'loopback'  (safe default: only a proxy on the same host
 *                                   may set forwarding headers)
 *   'false' | 'off' | '0'
 *                    → false       (no proxy at all; req.ip is the socket peer)
 *   '1', '2', ...    → hop count   (trust exactly N proxies, counted from this
 *                                   server outwards — use 1 for the nginx in
 *                                   client/nginx.conf)
 *   'loopback' | 'linklocal' | 'uniquelocal' | CIDR list
 *                    → passed through to Express as-is
 *   'true' | '*'     → REJECTED    (trusting every hop means trusting the
 *                                   client's own X-Forwarded-For)
 *
 * The default is deliberately NOT 1: with no proxy in front, trusting one hop
 * means the caller's own forged header is believed.
 */
export function resolveTrustProxy(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? '').trim();
  if (!raw) return 'loopback';

  const lowered = raw.toLowerCase();
  if (['false', 'off', 'no'].includes(lowered)) return false;
  if (['true', 'on', 'yes', '*'].includes(lowered)) {
    throw new Error('TRUST_PROXY must not be true/*: that trusts client-supplied X-Forwarded-For headers. Use a hop count, "loopback", or an explicit proxy IP/CIDR list.');
  }

  if (/^\d+$/.test(lowered)) {
    const hops = Number(lowered);
    if (hops === 0) return false;
    if (hops > 10) throw new Error('TRUST_PROXY hop count is implausibly large; list the proxy addresses instead');
    return hops;
  }

  // Named subnets and explicit addresses/CIDRs are handed to Express untouched.
  return raw;
}

/**
 * The exact browser origins allowed to call this API.
 *
 * Normalised to scheme://host[:port] with no trailing slash so string equality
 * against the browser's Origin header is reliable.
 */
export function allowedOrigins(env = process.env) {
  return String(env.CLIENT_URL || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * Validate CLIENT_URL and decide whether the permissive development fallback
 * applies. Throws in staging/production rather than degrading, so a
 * misconfigured deployment refuses to start instead of quietly serving every
 * origin on the internet.
 */
export function resolveCorsPolicy(env = process.env) {
  const environment = resolveEnvironment(env);
  const hardened = HARDENED_ENVIRONMENTS.has(environment);
  const raw = String(env.CLIENT_URL || '').trim();
  const origins = allowedOrigins(env);

  if (raw === '*' || origins.includes('*')) {
    throw new Error('CLIENT_URL must list explicit HTTP(S) origins, never *');
  }

  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CLIENT_URL contains an invalid origin: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`CLIENT_URL must contain origins only, without paths: ${origin}`);
    }
    if (hardened && parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw new Error(`CLIENT_URL must use https outside development: ${origin}`);
    }
  }

  if (!origins.length) {
    if (hardened) {
      throw new Error(`CLIENT_URL is required in ${environment}`);
    }
    // Development/test convenience only: any origin may call the API. Never
    // reachable from staging or production because of the throw above.
    return {environment, mode: 'reflect-any-origin', origins: []};
  }

  return {environment, mode: 'allowlist', origins};
}

/**
 * Options for the `cors` middleware and for the Socket.IO CORS block.
 *
 * credentials is always false: authentication is a Bearer token held by the
 * SPA, never a cookie, so there is no reason to let a foreign origin send
 * ambient credentials — and combining credentials with a reflected origin is
 * the classic CORS foot-gun.
 */
export function resolveCorsOptions(env = process.env) {
  const policy = resolveCorsPolicy(env);
  const allowlist = new Set(policy.origins);

  return {
    policy,
    credentials: false,
    origin(origin, callback) {
      // No Origin header: same-origin fetches, curl, mobile clients, and
      // server-to-server calls. CORS is a browser control and does not apply.
      if (!origin) return callback(null, true);
      const normalized = String(origin).replace(/\/$/, '');
      if (policy.mode === 'reflect-any-origin') return callback(null, true);
      if (allowlist.has(normalized)) return callback(null, true);
      // Deny by omitting the header rather than throwing: an error would become
      // a 500 and leak configuration detail. The browser blocks the read.
      return callback(null, false);
    }
  };
}

/** One-line description used by /health and the startup banner. */
export function describeDeployment(env = process.env) {
  const policy = resolveCorsPolicy(env);
  return {
    environment: policy.environment,
    cors: policy.mode,
    allowedOrigins: policy.origins,
    trustProxy: resolveTrustProxy(env)
  };
}
