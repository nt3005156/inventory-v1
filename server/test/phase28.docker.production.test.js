import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {clearDb, startTestApp, stopTestApp} from './helpers.js';
import {SupplierInvoice, SupplierPayment, SupplierPaymentCounter} from '../src/models/operations.js';
import {FILE_BACKED_SECRETS, loadFileBackedSecrets} from '../src/services/secrets.js';

/**
 * Phase 28 — Docker productionization.
 *
 * The Compose stack itself was verified by RUNNING it (build, up, ps, and a
 * full request path through nginx); a unit test cannot prove a container is
 * healthy. What lives here is the code that phase introduced or fixed, so the
 * behaviour is protected by the suite rather than only by a session transcript:
 *
 *   • `*_FILE` secret loading, which lets secrets come from a mounted file
 *     instead of an environment variable that `docker inspect` prints in full.
 *   • The seed defect that made the API crash-loop on restart, found only
 *     because the stack was actually restarted against seeded data.
 *
 * The Compose file itself is also asserted, because the guarantees it encodes
 * (network isolation, healthchecks, restart policies) are easy to delete by
 * accident and impossible to notice until an incident.
 */

let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mittho-p28-'));
});
after(async () => {
  if (workDir) await fs.rm(workDir, {recursive: true, force: true});
});

// ── secrets ──────────────────────────────────────────────────────────────────

describe('Phase 28 · file-backed secrets', () => {
  it('reads a secret from a mounted file', async () => {
    const file = path.join(workDir, 'jwt_secret');
    await fs.writeFile(file, 'a-real-secret-value-that-is-long-enough-1234');
    const env = {JWT_SECRET_FILE: file};

    const loaded = loadFileBackedSecrets(env);
    assert.deepEqual(loaded, ['JWT_SECRET']);
    assert.equal(env.JWT_SECRET, 'a-real-secret-value-that-is-long-enough-1234');
  });

  it('strips the trailing newline a secret file almost always has', async () => {
    /**
     * `echo secret > file` and most secret managers append a newline. Carrying
     * it into an HMAC key or a MongoDB URI corrupts the value in a way that
     * only shows up as an authentication failure at runtime.
     */
    const file = path.join(workDir, 'with-newline');
    await fs.writeFile(file, 'secret-value-1234567890123456789012\n');
    const env = {JWT_SECRET_FILE: file};
    loadFileBackedSecrets(env);
    assert.equal(env.JWT_SECRET, 'secret-value-1234567890123456789012');
    assert.ok(!env.JWT_SECRET.includes('\n'));
  });

  it('lets the file win over an inline value', async () => {
    // Otherwise a stale environment variable silently beats the secret the
    // operator actually mounted.
    const file = path.join(workDir, 'wins');
    await fs.writeFile(file, 'from-the-file-0123456789012345678901');
    const env = {JWT_SECRET: 'from-the-environment', JWT_SECRET_FILE: file};
    loadFileBackedSecrets(env);
    assert.equal(env.JWT_SECRET, 'from-the-file-0123456789012345678901');
  });

  it('fails loudly when the file is missing or empty', async () => {
    /**
     * The dangerous behaviour would be a silent fallback: the deployment then
     * runs on a placeholder while the operator believes a real secret is
     * mounted. A missing secret file is a startup failure.
     */
    await assert.rejects(
      async () => loadFileBackedSecrets({JWT_SECRET_FILE: '/run/secrets/definitely-not-there'}),
      /could not be read/
    );

    const empty = path.join(workDir, 'empty');
    await fs.writeFile(empty, '');
    await assert.rejects(
      async () => loadFileBackedSecrets({JWT_SECRET_FILE: empty}),
      /is empty/
    );

    const blank = path.join(workDir, 'blank');
    await fs.writeFile(blank, '\n');
    await assert.rejects(async () => loadFileBackedSecrets({JWT_SECRET_FILE: blank}), /is empty/);
  });

  it('does nothing when no _FILE variable is set', () => {
    // A plain `docker compose up` with a .env must keep working unchanged.
    const env = {JWT_SECRET: 'inline-value'};
    assert.deepEqual(loadFileBackedSecrets(env), []);
    assert.equal(env.JWT_SECRET, 'inline-value');
  });

  it('covers every secret the deployment actually holds', () => {
    for (const name of ['JWT_SECRET', 'ESEWA_SECRET_KEY', 'KHALTI_SECRET_KEY', 'MONGODB_URI']) {
      assert.ok(FILE_BACKED_SECRETS.includes(name), `${name} must be loadable from a file`);
    }
  });

  it('loads several secrets in one pass', async () => {
    const jwt = path.join(workDir, 'multi-jwt');
    const esewa = path.join(workDir, 'multi-esewa');
    await fs.writeFile(jwt, 'jwt-secret-value-01234567890123456789');
    await fs.writeFile(esewa, 'esewa-secret-value');
    const env = {JWT_SECRET_FILE: jwt, ESEWA_SECRET_KEY_FILE: esewa};
    const loaded = loadFileBackedSecrets(env);
    assert.deepEqual(loaded.sort(), ['ESEWA_SECRET_KEY', 'JWT_SECRET']);
    assert.equal(env.ESEWA_SECRET_KEY, 'esewa-secret-value');
  });
});

// ── the seed defect found by restarting the real stack ───────────────────────

describe('Phase 28 · the seed cannot orphan supplier payments', () => {
  before(async () => { await startTestApp(); });
  after(async () => { await stopTestApp(); });

  it('clears supplier payments along with the invoices they reference', async () => {
    /**
     * FOUND BY RUNNING THE STACK, not by reading code.
     *
     * `ensureSupplierPaymentIndexes()` runs at every API startup and
     * synthesises a SupplierPayment for each invoice carrying a `paidAmount`.
     * The seed deleted SupplierInvoice but NOT SupplierPayment, so re-seeding
     * left payment rows pointing at invoices that no longer existed. On the
     * next boot the migration refused to guess their ownership and threw:
     *
     *   "Supplier payment migration cannot safely migrate ownership or
     *    financial data for: <ids>"
     *
     * The API then crash-looped and never became healthy. The migration was
     * right to refuse — the seed was wrong to orphan the rows.
     *
     * This test reproduces the exact shape: seed, synthesise a payment as the
     * migration would, re-seed, and assert no orphan survives.
     */
    await clearDb();
    const {seedDemoData} = await import('../src/seed.js');
    await seedDemoData({log: () => {}});

    const invoice = await SupplierInvoice.findOne({}).lean();
    assert.ok(invoice, 'the seed produced supplier invoices');

    // Stand in for what the startup migration writes.
    await SupplierPayment.create({
      restaurant: invoice.restaurant, branch: invoice.branch, supplier: invoice.supplier,
      invoice: invoice._id, amount: 100, currency: 'NPR', method: 'legacy', status: 'posted',
      paidAt: new Date(), paymentNo: 'PAY-TEST-2026-000001', numberVersion: 2,
      origin: 'legacy_invoice_balance', migrationSource: 'SupplierInvoice.paidAmount',
      idempotencyKey: `migration:test:${invoice._id}`, createdBy: invoice.createdBy,
      // Shape copied from a row the real migration wrote in the live Docker
      // stack, so the fixture matches production rather than approximating it.
      requestHash: 'a'.repeat(64), requestHashVersion: 2,
      reference: `Migrated aggregate payment for invoice ${invoice.invoiceNo}`
    });
    await SupplierPaymentCounter.create({
      restaurant: invoice.restaurant, branch: invoice.branch, branchCode: 'TST',
      year: 2026, value: 1
    });
    assert.equal(await SupplierPayment.countDocuments(), 1);

    // Re-seed: this is the step that used to leave the orphan behind.
    await seedDemoData({log: () => {}});

    assert.equal(await SupplierPayment.countDocuments(), 0,
      'a re-seed must not leave supplier payments pointing at deleted invoices');
    assert.equal(await SupplierPaymentCounter.countDocuments(), 0,
      'the payment number counter must be reset with its payments');

    // And the invariant the migration actually checks: every surviving payment
    // must reference an invoice that exists.
    const orphans = [];
    for (const payment of await SupplierPayment.find({}).lean()) {
      if (!await SupplierInvoice.countDocuments({_id: payment.invoice})) orphans.push(String(payment._id));
    }
    assert.deepEqual(orphans, [], 'no payment may reference a missing invoice');
  });

  it('leaves the startup migration able to run after a re-seed', async () => {
    // The real symptom was a crash on the NEXT boot, so run the migration
    // itself rather than trusting the counts above.
    const {ensureSupplierPaymentIndexes} = await import('../src/services/supplierPaymentMigration.js');
    await assert.doesNotReject(
      () => ensureSupplierPaymentIndexes(),
      'the supplier payment migration must survive a freshly seeded database'
    );
  });
});

// ── the compose contract ─────────────────────────────────────────────────────

describe('Phase 28 · the Compose stack encodes its guarantees', () => {
  let compose;

  before(async () => {
    compose = await fs.readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  });

  it('isolates the database on an internal network', () => {
    /**
     * Verified live: `docker compose exec web nc -z mongo 27017` cannot even
     * resolve the host, while the API reports `database: connected`. These
     * assertions stop the segmentation being deleted by a later edit.
     */
    assert.match(compose, /networks:\s*\n\s*frontend:/, 'a frontend network is declared');
    assert.match(compose, /backend:\s*\n\s*driver: bridge\s*\n\s*internal: true/,
      'the backend network must be internal — no route off the host');
    // Mongo must not be published to the host at all.
    assert.ok(!/27017:27017/.test(compose), 'MongoDB must never be published to the host');
  });

  it('keeps the API as the only bridge between the two networks', () => {
    const apiBlock = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  web:'));
    assert.match(apiBlock, /networks:[\s\S]*backend[\s\S]*frontend/, 'the API spans both networks');
    const webBlock = compose.slice(compose.indexOf('\n  web:'));
    assert.match(webBlock, /networks:\s*\n\s*- frontend/, 'web is frontend-only');
    assert.ok(!/\n  web:[\s\S]*?- backend/.test(compose), 'web must have no route to the database');
  });

  it('declares a healthcheck for every long-running service', () => {
    // `depends_on: condition: service_healthy` is only honoured if the
    // healthcheck is visible to Compose. A Dockerfile HEALTHCHECK is inherited
    // but is lost the moment the image is swapped for a prebuilt one.
    for (const service of ['mongo:', 'api:', 'web:']) {
      const start = compose.indexOf(`\n  ${service}`);
      const rest = compose.slice(start + 1);
      const end = rest.search(/\n {2}[a-z-]+:\n/);
      const block = end === -1 ? rest : rest.slice(0, end);
      assert.match(block, /healthcheck:/, `${service} needs a healthcheck in compose`);
    }
  });

  it('sets a restart policy and bounded logging on every service', () => {
    const restarts = compose.match(/restart: unless-stopped/g) || [];
    assert.ok(restarts.length >= 3, 'mongo, api and web must all restart');
    const logging = compose.match(/max-size: "10m"/g) || [];
    assert.ok(logging.length >= 3, 'unbounded container logs can fill the host disk');
  });

  it('persists MongoDB on a named volume', () => {
    // Verified live: 43 orders survived `docker compose down && up`.
    assert.match(compose, /mongo_data:\/data\/db/, 'the data directory must be a volume');
    assert.match(compose, /volumes:\s*\n\s*mongo_data:/, 'the volume must be declared');
  });

  it('runs a replica set, because the application requires transactions', async () => {
    /**
     * P2H.4: `command:` became a YAML LIST when the keyfile flags were added,
     * so `--replSet` and `rs0` are now on separate lines. The original regex
     * required them adjacent — it was matching the formatting, not the
     * guarantee. Both forms are accepted here.
     */
    assert.match(
      compose, /--replSet[\s"',\n-]+rs0/,
      'mongod must run as a replica set'
    );
    /**
     * P2H.4 UPDATE: `rs.initiate()` moved out of compose and into
     * `scripts/mongo-init-auth.sh`.
     *
     * It had to. Enabling authentication makes initiation part of a fixed
     * sequence that can only run INSIDE the mongo container, via MongoDB's
     * localhost exception: initiate, wait for PRIMARY, create the first user
     * (which closes the exception), then create the application user. A bare
     * `rs.initiate` from a sidecar cannot do that.
     *
     * The GUARANTEE is unchanged — the set is still initiated on first boot —
     * so the assertion follows it rather than being deleted.
     */
    const bootstrap = await fs.readFile(
      new URL('../../scripts/mongo-init-auth.sh', import.meta.url), 'utf8'
    );
    assert.match(bootstrap, /rs\.initiate/, 'the set must be initiated on first boot');
    assert.match(bootstrap, /isWritablePrimary/, 'boot must wait for a writable primary');
  });

  it('supports file-mounted secrets without breaking plain .env use', () => {
    for (const key of ['JWT_SECRET_FILE', 'ESEWA_SECRET_KEY_FILE', 'KHALTI_SECRET_KEY_FILE']) {
      assert.ok(compose.includes(key), `${key} must be wired through`);
      // Defaulted to empty, so `docker compose up` with a .env still works.
      assert.match(compose, new RegExp(`${key}: \\$\\{${key}:-\\}`));
    }
  });

  it('exposes no service to the host except nginx', () => {
    // The API is loopback-only for diagnostics; all real traffic goes through
    // nginx. A `0.0.0.0` binding on the API would bypass every nginx header.
    assert.match(compose, /"127\.0\.0\.1:4000:4000"/, 'the API must be loopback-only');
    assert.ok(!/"0\.0\.0\.0:4000/.test(compose), 'the API must not be world-exposed');
  });

  it('does not add Redis, which nothing requires', async () => {
    /**
     * The brief said to include Redis only if actually required. It is not:
     * there is no redis dependency in either package.json, rate limiting uses
     * an in-process store behind a pluggable factory, and the Socket.IO
     * adapter is per-instance. Adding it would be an unused service to secure,
     * back up and monitor.
     */
    assert.ok(!/\n\s*redis:/.test(compose), 'no Redis service should be declared');
    const rootPkg = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const apiPkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    for (const pkg of [rootPkg, apiPkg]) {
      const deps = {...pkg.dependencies, ...pkg.devDependencies};
      for (const name of Object.keys(deps || {})) {
        assert.ok(!/redis/i.test(name), `${name} suggests Redis is in use after all`);
      }
    }
  });
});

// ── nginx ────────────────────────────────────────────────────────────────────

describe('Phase 28 · nginx configuration', () => {
  let conf;
  let dockerfile;

  before(async () => {
    conf = await fs.readFile(new URL('../../client/nginx.conf', import.meta.url), 'utf8');
    dockerfile = await fs.readFile(new URL('../../client/Dockerfile', import.meta.url), 'utf8');
  });

  it('upgrades WebSocket connections for Socket.IO', () => {
    // Verified live: the client negotiated `transport: websocket` through
    // nginx, not a polling fallback.
    const block = conf.slice(conf.indexOf('location /socket.io/'));
    assert.match(block, /proxy_set_header Upgrade \$http_upgrade;/);
    assert.match(block, /proxy_set_header Connection "upgrade";/);
    assert.match(block, /proxy_http_version 1\.1;/);
    // Without a read timeout above the Socket.IO ping interval, nginx drops
    // an idle websocket and the client reconnect-storms.
    assert.match(block, /proxy_read_timeout \d+s;/);
  });

  it('forwards the client address so rate limiting and audit are truthful', () => {
    assert.match(conf, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
    assert.match(conf, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  });

  it('runs unprivileged', () => {
    /**
     * Verified before and after: `docker compose exec web id -u` returned 0
     * with the stock nginx image and 101 with the unprivileged one. A non-root
     * user cannot bind :80, hence the 8080 listener.
     */
    assert.match(dockerfile, /nginx-unprivileged/, 'use the unprivileged nginx image');
    assert.match(dockerfile, /USER 101/);
    assert.match(conf, /listen 8080;/, 'a non-root user cannot bind a privileged port');
  });

  it('health-checks nginx itself rather than the API behind it', () => {
    // The old check proxied /health to the API, so it could not tell "nginx is
    // broken" from "the API is down", and marked nginx unhealthy during an API
    // restart even though it was serving the SPA correctly.
    assert.match(dockerfile, /HEALTHCHECK[\s\S]*index\.html/);
  });

  it('serves the SPA and sends security headers', () => {
    assert.match(conf, /try_files \$uri \$uri\/ \/index\.html;/, 'client-side routing must work');
    for (const header of ['X-Content-Type-Options', 'Content-Security-Policy', 'X-Frame-Options']) {
      assert.ok(conf.includes(header), `${header} must be sent`);
    }
    assert.match(conf, /server_tokens off;/, 'do not advertise the nginx version');
  });
});
