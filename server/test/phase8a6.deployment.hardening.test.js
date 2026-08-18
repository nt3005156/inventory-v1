/**
 * Phase 8A.6 — public API deployment hardening.
 *
 * Covers the three deployment-level concerns raised by the 8A.5 audit:
 *   1. rate limiting (identity, enforcement, route independence, scope)
 *   2. trust proxy / client IP (direct, proxied, spoofed X-Forwarded-For)
 *   3. CORS / environment safety (dev vs staging vs production)
 *
 * These build their own tiny Express apps on purpose. The shared test harness
 * runs with NODE_ENV=test, which disables the live limiters so the functional
 * suites are not throttled; asserting real 429s therefore requires an app that
 * mounts the limiter unconditionally.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import cors from 'cors';

import {
  allowedOrigins,
  describeDeployment,
  isHardenedEnvironment,
  resolveCorsOptions,
  resolveCorsPolicy,
  resolveEnvironment,
  resolveTrustProxy
} from '../src/services/deployment.js';
import {
  AUTH_RATE_LIMIT,
  configureRateLimitStore,
  createRateLimiter,
  ipKey,
  rateLimitScope
} from '../src/services/rateLimiting.js';
import {PUBLIC_RATE_LIMITS} from '../src/routes/storefront.js';
import {validateRuntimeEnvironment} from '../src/services/startup.js';

// ── helpers ──────────────────────────────────────────────────────────────────

async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function hit(url, {headers = {}, method = 'GET'} = {}) {
  const res = await fetch(url, {headers, method});
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {status: res.status, body, headers: res.headers};
}

const PROD = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://mongo:27017/mittho_ops?replicaSet=rs0',
  JWT_SECRET: 'a'.repeat(40),
  PORT: '4000',
  CLIENT_URL: 'https://ops.example.com'
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. RATE LIMITING
// ═════════════════════════════════════════════════════════════════════════════

describe('8A.6 §1 — rate limiting', () => {
  it('limits every public endpoint, hardest on the write path', () => {
    for (const key of ['browse', 'quote', 'order', 'track']) {
      assert.ok(PUBLIC_RATE_LIMITS[key].max > 0, `${key} must be limited`);
      assert.ok(PUBLIC_RATE_LIMITS[key].windowMs > 0, `${key} needs a window`);
    }
    assert.ok(PUBLIC_RATE_LIMITS.order.max < PUBLIC_RATE_LIMITS.quote.max);
    assert.ok(PUBLIC_RATE_LIMITS.quote.max < PUBLIC_RATE_LIMITS.browse.max);
  });

  it('limits the unauthenticated staff endpoint (login) too', () => {
    assert.ok(AUTH_RATE_LIMIT.max > 0 && AUTH_RATE_LIMIT.max <= 20,
      'login must be throttled tightly enough to blunt credential stuffing');
    assert.ok(AUTH_RATE_LIMIT.windowMs >= 60_000);
  });

  it('enforces the limit and then rejects with 429 and a safe message', async () => {
    const app = express();
    app.get('/x', createRateLimiter({name: 't:enforced', windowMs: 60_000, max: 3}),
      (_req, res) => res.json({ok: true}));
    const {url, close} = await listen(app);
    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await hit(`${url}/x`)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);

      const blocked = await hit(`${url}/x`);
      assert.equal(blocked.status, 429);
      assert.match(blocked.body.message, /Too many requests/);
      // No internals in the refusal.
      assert.doesNotMatch(JSON.stringify(blocked.body), /store|MemoryStore|keyGenerator|stack/i);
    } finally {
      await close();
    }
  });

  it('publishes standard RateLimit headers and no legacy ones', async () => {
    const app = express();
    app.get('/x', createRateLimiter({name: 't:headers', windowMs: 60_000, max: 2}),
      (_req, res) => res.json({ok: true}));
    const {url, close} = await listen(app);
    try {
      const first = await hit(`${url}/x`);
      assert.ok(first.headers.get('ratelimit-limit') || first.headers.get('ratelimit'));
      assert.equal(first.headers.get('x-ratelimit-limit'), null);
    } finally {
      await close();
    }
  });

  it('keeps independent routes in independent buckets', async () => {
    const app = express();
    app.get('/a', createRateLimiter({name: 't:a', windowMs: 60_000, max: 1}),
      (_req, res) => res.json({route: 'a'}));
    app.get('/b', createRateLimiter({name: 't:b', windowMs: 60_000, max: 1}),
      (_req, res) => res.json({route: 'b'}));
    const {url, close} = await listen(app);
    try {
      assert.equal((await hit(`${url}/a`)).status, 200);
      assert.equal((await hit(`${url}/a`)).status, 429, 'route a is exhausted');
      assert.equal((await hit(`${url}/b`)).status, 200, 'route b must be unaffected');
    } finally {
      await close();
    }
  });

  it('can be disabled per request without removing the limiter', async () => {
    // This is the mechanism the test suite relies on. It must be evaluated per
    // request, not at module load, or an ES-hoisted import would win the race.
    let bypass = true;
    const app = express();
    app.get('/x', createRateLimiter({name: 't:toggle', windowMs: 60_000, max: 1, enabled: () => !bypass}),
      (_req, res) => res.json({ok: true}));
    const {url, close} = await listen(app);
    try {
      for (let i = 0; i < 5; i += 1) assert.equal((await hit(`${url}/x`)).status, 200);
      bypass = false;
      assert.equal((await hit(`${url}/x`)).status, 200);
      assert.equal((await hit(`${url}/x`)).status, 429, 'the limiter is live once enabled');
    } finally {
      await close();
    }
  });

  it('keys authenticated callers by user so one account cannot starve a shared NAT', async () => {
    const app = express();
    app.use((req, _res, next) => {
      const id = req.headers['x-test-user'];
      if (id) req.user = {id};
      next();
    });
    app.get('/x', createRateLimiter({name: 't:byuser', windowMs: 60_000, max: 1, byUser: true}),
      (_req, res) => res.json({ok: true}));
    const {url, close} = await listen(app);
    try {
      assert.equal((await hit(`${url}/x`, {headers: {'x-test-user': 'u1'}})).status, 200);
      assert.equal((await hit(`${url}/x`, {headers: {'x-test-user': 'u1'}})).status, 429);
      assert.equal((await hit(`${url}/x`, {headers: {'x-test-user': 'u2'}})).status, 200,
        'a second user on the same IP must have its own bucket');
    } finally {
      await close();
    }
  });

  it('reports per-instance scope until a shared store is installed', () => {
    assert.equal(rateLimitScope(), 'per-instance-memory');
    try {
      // Proving the seam exists: a shared store can be injected without
      // touching a single route. No Redis is added today — the deployment is
      // single-instance — but the layer is ready for one.
      const seen = [];
      configureRateLimitStore(options => {
        seen.push(options.name);
        return undefined; // express-rate-limit falls back to its default store
      });
      assert.equal(rateLimitScope(), 'shared-store');
      createRateLimiter({name: 't:injected', windowMs: 1000, max: 1});
      assert.deepEqual(seen, ['t:injected'], 'the factory receives the limiter name');
    } finally {
      configureRateLimitStore(null);
      assert.equal(rateLimitScope(), 'per-instance-memory');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. TRUST PROXY / CLIENT IP
// ═════════════════════════════════════════════════════════════════════════════

describe('8A.6 §2 — trust proxy and client IP', () => {
  it('defaults to loopback rather than trusting a hop that may not exist', () => {
    assert.equal(resolveTrustProxy({}), 'loopback');
  });

  it('accepts an explicit hop count for the nginx topology', () => {
    assert.equal(resolveTrustProxy({TRUST_PROXY: '1'}), 1);
    assert.equal(resolveTrustProxy({TRUST_PROXY: '2'}), 2);
  });

  it('accepts explicit disabling and named subnets', () => {
    assert.equal(resolveTrustProxy({TRUST_PROXY: 'false'}), false);
    assert.equal(resolveTrustProxy({TRUST_PROXY: '0'}), false);
    assert.equal(resolveTrustProxy({TRUST_PROXY: 'uniquelocal'}), 'uniquelocal');
    assert.equal(resolveTrustProxy({TRUST_PROXY: '10.0.0.0/8'}), '10.0.0.0/8');
  });

  it('refuses to trust every proxy', () => {
    for (const value of ['true', '*', 'yes', 'ON']) {
      assert.throws(() => resolveTrustProxy({TRUST_PROXY: value}), /must not be true/,
        `TRUST_PROXY=${value} must be rejected`);
    }
    assert.throws(() => resolveTrustProxy({TRUST_PROXY: '99'}), /implausibly large/);
  });

  it('is validated at startup so a bad value never reaches production', () => {
    assert.doesNotThrow(() => validateRuntimeEnvironment({...PROD, TRUST_PROXY: '1'}));
    assert.throws(() => validateRuntimeEnvironment({...PROD, TRUST_PROXY: 'true'}), /must not be true/);
  });

  it('ignores X-Forwarded-For on a direct request (trust proxy off)', async () => {
    const app = express();
    app.set('trust proxy', false);
    app.get('/who', (req, res) => res.json({ip: ipKey(req)}));
    const {url, close} = await listen(app);
    try {
      const direct = await hit(`${url}/who`);
      assert.equal(direct.body.ip, '127.0.0.1');
      const spoofed = await hit(`${url}/who`, {headers: {'X-Forwarded-For': '203.0.113.9'}});
      assert.equal(spoofed.body.ip, '127.0.0.1', 'a forged header must not become the client IP');
    } finally {
      await close();
    }
  });

  it('reads the client IP that the expected proxy appended (trust proxy = 1)', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/who', (req, res) => res.json({ip: ipKey(req)}));
    const {url, close} = await listen(app);
    try {
      // Exactly what nginx sends: X-Forwarded-For: <real client>
      const proxied = await hit(`${url}/who`, {headers: {'X-Forwarded-For': '203.0.113.9'}});
      assert.equal(proxied.body.ip, '203.0.113.9');

      // A client that prepends its own entry: nginx appends the peer address,
      // so the rightmost (trusted) hop still identifies the true caller.
      const forged = await hit(`${url}/who`, {headers: {'X-Forwarded-For': '9.9.9.9, 203.0.113.9'}});
      assert.equal(forged.body.ip, '203.0.113.9',
        'the forged leftmost entry must be ignored with one trusted hop');
    } finally {
      await close();
    }
  });

  it('does not let a spoofed X-Forwarded-For escape the limit when no proxy is trusted', async () => {
    const app = express();
    app.set('trust proxy', false);
    app.get('/x', createRateLimiter({name: 't:spoof-off', windowMs: 60_000, max: 2}),
      (_req, res) => res.json({ok: true}));
    const {url, close} = await listen(app);
    try {
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await hit(`${url}/x`, {headers: {'X-Forwarded-For': `10.0.0.${i}`}})).status);
      }
      assert.deepEqual(statuses, [200, 200, 429, 429],
        'rotating a forged header must not mint fresh rate-limit buckets');
    } finally {
      await close();
    }
  });

  it('does not let a prepended X-Forwarded-For entry escape the limit behind one proxy', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/x', createRateLimiter({name: 't:spoof-1hop', windowMs: 60_000, max: 2}),
      (_req, res) => res.json({ok: true}));
    const {url, close} = await listen(app);
    try {
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        // The attacker varies the entry they control; nginx's appended entry
        // (203.0.113.9) is the trusted one and stays constant.
        statuses.push((await hit(`${url}/x`, {
          headers: {'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9`}
        })).status);
      }
      assert.deepEqual(statuses, [200, 200, 429, 429]);
    } finally {
      await close();
    }
  });

  it('separates genuinely different clients behind the proxy', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/x', createRateLimiter({name: 't:distinct', windowMs: 60_000, max: 1}),
      (_req, res) => res.json({ok: true}));
    const {url, close} = await listen(app);
    try {
      assert.equal((await hit(`${url}/x`, {headers: {'X-Forwarded-For': '203.0.113.1'}})).status, 200);
      assert.equal((await hit(`${url}/x`, {headers: {'X-Forwarded-For': '203.0.113.1'}})).status, 429);
      assert.equal((await hit(`${url}/x`, {headers: {'X-Forwarded-For': '203.0.113.2'}})).status, 200,
        'a different real client must not inherit the exhausted bucket');
    } finally {
      await close();
    }
  });

  it('folds IPv4-mapped IPv6 so one client cannot hold two buckets', () => {
    assert.equal(ipKey({ip: '::ffff:203.0.113.9'}), '203.0.113.9');
    assert.equal(ipKey({ip: '203.0.113.9'}), '203.0.113.9');
    assert.equal(ipKey({socket: {remoteAddress: '::1'}}), '::1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. CORS / ENVIRONMENT SAFETY
// ═════════════════════════════════════════════════════════════════════════════

describe('8A.6 §3 — environment classification', () => {
  it('treats development, test, staging and production as distinct', () => {
    assert.equal(resolveEnvironment({NODE_ENV: 'development'}), 'development');
    assert.equal(resolveEnvironment({NODE_ENV: 'test'}), 'test');
    assert.equal(resolveEnvironment({NODE_ENV: 'production'}), 'production');
    assert.equal(resolveEnvironment({APP_ENV: 'staging', NODE_ENV: 'production'}), 'staging');
    assert.equal(resolveEnvironment({}), 'development');
  });

  it('lets staging opt into hardening even while NODE_ENV=production for the build', () => {
    assert.equal(isHardenedEnvironment({APP_ENV: 'staging', NODE_ENV: 'development'}), true,
      'a staging deployment must never behave like development');
    assert.equal(isHardenedEnvironment({NODE_ENV: 'production'}), true);
    assert.equal(isHardenedEnvironment({NODE_ENV: 'development'}), false);
  });

  it('fails closed on an unrecognised APP_ENV rather than guessing development', () => {
    assert.throws(() => resolveEnvironment({APP_ENV: 'prod-ish'}), /APP_ENV must be one of/);
    assert.equal(resolveEnvironment({NODE_ENV: 'uat'}), 'production',
      'an unknown NODE_ENV must fall to the strict side');
  });
});

describe('8A.6 §3 — CORS policy resolution', () => {
  it('allows the permissive fallback only in development', () => {
    const dev = resolveCorsPolicy({NODE_ENV: 'development', CLIENT_URL: ''});
    assert.equal(dev.mode, 'reflect-any-origin');
    assert.deepEqual(dev.origins, []);
  });

  it('refuses to start production without CLIENT_URL', () => {
    assert.throws(() => resolveCorsPolicy({NODE_ENV: 'production'}), /CLIENT_URL is required in production/);
    assert.throws(() => validateRuntimeEnvironment({...PROD, CLIENT_URL: ''}), /CLIENT_URL is required/);
  });

  it('refuses to start staging without CLIENT_URL', () => {
    assert.throws(
      () => resolveCorsPolicy({APP_ENV: 'staging', NODE_ENV: 'development', CLIENT_URL: ''}),
      /CLIENT_URL is required in staging/
    );
  });

  it('rejects a wildcard in every environment', () => {
    for (const env of [{NODE_ENV: 'production'}, {APP_ENV: 'staging'}, {NODE_ENV: 'development'}]) {
      assert.throws(() => resolveCorsPolicy({...env, CLIENT_URL: '*'}), /never \*/);
      assert.throws(() => resolveCorsPolicy({...env, CLIENT_URL: 'https://ops.example.com,*'}), /never \*/);
    }
    assert.throws(() => validateRuntimeEnvironment({...PROD, CLIENT_URL: '*'}), /never \*/);
  });

  it('rejects paths, non-HTTP schemes and plaintext public origins in production', () => {
    assert.throws(() => resolveCorsPolicy({...PROD, CLIENT_URL: 'https://ops.example.com/app'}), /without paths/);
    assert.throws(() => resolveCorsPolicy({...PROD, CLIENT_URL: 'ftp://ops.example.com'}), /without paths|invalid/);
    assert.throws(() => resolveCorsPolicy({...PROD, CLIENT_URL: 'not a url'}), /invalid origin/);
    assert.throws(() => resolveCorsPolicy({...PROD, CLIENT_URL: 'http://ops.example.com'}), /must use https/);
    // Loopback over http stays usable for a local production smoke test.
    assert.doesNotThrow(() => resolveCorsPolicy({...PROD, CLIENT_URL: 'http://localhost:8080'}));
  });

  it('supports multiple allowed origins and normalises them', () => {
    const policy = resolveCorsPolicy({
      ...PROD,
      CLIENT_URL: ' https://ops.example.com/, https://order.example.com '
    });
    assert.equal(policy.mode, 'allowlist');
    assert.deepEqual(policy.origins, ['https://ops.example.com', 'https://order.example.com']);
    assert.deepEqual(allowedOrigins({CLIENT_URL: 'https://a.test/,https://b.test'}),
      ['https://a.test', 'https://b.test']);
  });

  it('never enables credentials, so a foreign origin cannot ride ambient auth', () => {
    assert.equal(resolveCorsOptions(PROD).credentials, false);
    assert.equal(resolveCorsOptions({NODE_ENV: 'development'}).credentials, false);
  });

  it('describes the resolved posture for /health', () => {
    const described = describeDeployment({...PROD, TRUST_PROXY: '1'});
    assert.deepEqual(described, {
      environment: 'production',
      cors: 'allowlist',
      allowedOrigins: ['https://ops.example.com'],
      trustProxy: 1
    });
  });
});

describe('8A.6 §3 — CORS enforced over real HTTP', () => {
  let allowlisted;
  let permissive;

  before(async () => {
    const build = async env => {
      const app = express();
      const options = resolveCorsOptions(env);
      app.use(cors({origin: options.origin, credentials: options.credentials}));
      app.get('/api/public/menu', (_req, res) => res.json({items: []}));
      return listen(app);
    };
    allowlisted = await build({...PROD, CLIENT_URL: 'https://ops.example.com,https://order.example.com'});
    permissive = await build({NODE_ENV: 'development', CLIENT_URL: ''});
  });

  after(async () => {
    await allowlisted?.close();
    await permissive?.close();
  });

  it('returns the allow header for a configured origin', async () => {
    for (const origin of ['https://ops.example.com', 'https://order.example.com']) {
      const res = await hit(`${allowlisted.url}/api/public/menu`, {headers: {Origin: origin}});
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
    }
  });

  it('withholds the allow header from an unauthorised origin', async () => {
    const res = await hit(`${allowlisted.url}/api/public/menu`, {
      headers: {Origin: 'https://evil.example.com'}
    });
    // The response body still exists — CORS is a browser-side read control —
    // but without the header the browser refuses to hand it to the page.
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('is not fooled by a lookalike origin', async () => {
    for (const origin of [
      'https://ops.example.com.evil.test',
      'http://ops.example.com',
      'https://evil.test?https://ops.example.com'
    ]) {
      const res = await hit(`${allowlisted.url}/api/public/menu`, {headers: {Origin: origin}});
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${origin} must not be allowed`);
    }
  });

  it('never sets allow-credentials', async () => {
    const res = await hit(`${allowlisted.url}/api/public/menu`, {
      headers: {Origin: 'https://ops.example.com'}
    });
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  it('rejects an unauthorised origin on the preflight too', async () => {
    const preflight = await fetch(`${allowlisted.url}/api/public/menu`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });

  it('still reflects any origin in development', async () => {
    const res = await hit(`${permissive.url}/api/public/menu`, {
      headers: {Origin: 'http://localhost:5173'}
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  it('serves callers with no Origin header at all (curl, mobile, same-origin)', async () => {
    const res = await hit(`${allowlisted.url}/api/public/menu`);
    assert.equal(res.status, 200);
  });
});
