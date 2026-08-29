import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {loadFileBackedSecrets, FILE_BACKED_SECRETS} from '../src/services/secrets.js';
import {resolveCliMongoUri} from '../src/services/cliDatabase.js';

/**
 * P2H.4 — MongoDB authentication.
 *
 * THE VULNERABILITY THIS CLOSES, measured against the running stack before the
 * change: any container on the backend network could read and write the whole
 * database with NO credentials —
 *
 *     listDatabases WITHOUT auth: OK, found 4 databases
 *     owner email:  owner@mittho.demo
 *     password hash exposed: $2a$12$TKx9HVjLcY4bs...
 *     wrote attacker flag: true
 *
 * After the change the same probe returns `Unauthorized` for read, write and
 * listDatabases.
 *
 * WHAT THIS FILE CAN AND CANNOT TEST. The live authentication behaviour lives
 * in Docker and is verified there (see the phase report); the harness runs
 * against an in-memory replica set with no auth, so asserting "auth is on"
 * here would be theatre. What IS asserted here is everything that can regress
 * silently in source: the compose configuration, the credential handling, and
 * the CLI URI resolution that broke the moment auth was switched on.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8');

// ── the deployment configuration ─────────────────────────────────────────────

describe('P2H4 · the Docker deployment requires authentication', () => {
  const compose = read('docker-compose.yml');

  it('starts mongod with a keyfile, which implies --auth', () => {
    /**
     * `--auth` alone is not enough for a replica set: members must authenticate
     * to each other, which needs a shared keyfile. Supplying `--keyFile`
     * implies `--auth`, so this single flag is the whole switch.
     */
    assert.match(compose, /--keyFile/, 'mongod is not started with a keyfile');
    assert.match(compose, /\/run\/secrets\/mongo_keyfile/);
    assert.ok(
      !/--noauth/.test(compose), 'authentication is explicitly disabled'
    );
  });

  it('never publishes the MongoDB port to the host', () => {
    // Defence in depth: even with auth on, the database should not be
    // reachable from outside the compose network.
    const mongoService = compose.slice(
      compose.indexOf('  mongo:'), compose.indexOf('  mongo-init:')
    );
    assert.ok(
      !/^\s+-\s+"?\d*:?27017/m.test(mongoService),
      'the MongoDB port is published to the host'
    );
    assert.match(mongoService, /networks:\s*\n\s+- backend/);
  });

  it('keeps the backend network internal, so mongo has no route off the host', () => {
    assert.match(compose, /backend:\s*\n\s+driver: bridge\s*\n\s+internal: true/);
  });

  it('passes the connection string as a FILE, not an environment variable', () => {
    /**
     * The URI now contains a password. An environment variable is printed in
     * full by `docker inspect` to anyone with socket access on the host, so it
     * is mounted as a Docker secret and read via the existing `*_FILE`
     * convention.
     */
    assert.match(compose, /MONGODB_URI_FILE:/);
    assert.ok(
      !/MONGODB_URI:\s*\$\{COMPOSE_MONGODB_URI/.test(compose),
      'the old inline MONGODB_URI is still present'
    );
    assert.match(compose, /secrets:\s*\n\s+- mongodb_uri/);
  });

  it('declares every credential as a file-based secret', () => {
    for (const secret of [
      'mongo_keyfile', 'mongo_root_password', 'mongo_app_password', 'mongodb_uri'
    ]) {
      assert.match(
        compose, new RegExp(`${secret}:\\s*\\n\\s+file: \\./secrets/${secret}`),
        `${secret} is not declared as a file secret`
      );
    }
  });

  it('contains no hardcoded password anywhere in the compose file', () => {
    // The whole point of generating credentials per deployment.
    assert.ok(!/MONGO_INITDB_ROOT_PASSWORD/.test(compose), 'an inline root password is set');
    assert.ok(
      !/mongodb:\/\/[^\s:]+:[^\s@]+@/.test(compose),
      'a connection string with an embedded password is committed'
    );
  });
});

// ── credentials must never be committable ────────────────────────────────────

describe('P2H4 · generated credentials cannot be committed', () => {
  it('git-ignores the secrets directory', () => {
    const ignored = read('.gitignore');
    assert.match(ignored, /^\/?secrets\/$/m, 'secrets/ is not git-ignored');
  });

  it('documents the file-based URI without shipping a real credential', () => {
    const example = read('.env.example');
    assert.match(example, /MONGODB_URI_FILE=/);
    // A placeholder is fine; an actual password is not.
    assert.ok(
      !/mongodb:\/\/[^\s:]+:[^\s@<]+@/.test(example),
      '.env.example contains a connection string with a password'
    );
  });

  it('grants the application user the LEAST privilege it needs', () => {
    const init = read('scripts/mongo-init-auth.sh');
    // readWrite scoped to the application database, and nothing wider.
    assert.match(init, /roles:\s*\[\{role:\s*"readWrite",\s*db:\s*dbName\}\]/);
    for (const forbidden of [
      'readWriteAnyDatabase', 'dbOwner', 'clusterAdmin', 'userAdminAnyDatabase'
    ]) {
      assert.ok(
        !new RegExp(`role:\\s*"${forbidden}"`).test(init),
        `the application user is granted ${forbidden}`
      );
    }
    // `root` appears exactly once, for the bootstrap/administration identity.
    assert.equal(
      (init.match(/role: "root"/g) || []).length, 1,
      'root is granted more than once'
    );
  });

  it('creates the application user in its own database, not admin', () => {
    /**
     * `authSource` is the database the user lives in. Creating the application
     * user inside its own database means a leaked credential authenticates
     * nowhere else.
     */
    const init = read('scripts/mongo-init-auth.sh');
    assert.match(init, /const appDb = db\.getSiblingDB\(dbName\)/);
    assert.match(init, /appDb\.createUser/);
    const bootstrap = read('scripts/mongo-bootstrap-auth.sh');
    assert.match(bootstrap, /authSource=%s/);
  });

  it('generates a password per deployment rather than shipping one', () => {
    const bootstrap = read('scripts/mongo-bootstrap-auth.sh');
    assert.match(bootstrap, /\/dev\/urandom/, 'passwords are not randomly generated');
    assert.match(bootstrap, /openssl rand -base64 756/, 'the keyfile is not random');
    // Restrictive permissions, or MongoDB refuses to start.
    assert.match(bootstrap, /chmod 400 "\$\{SECRETS_DIR\}\/mongo_keyfile"/);
    assert.match(bootstrap, /chown 999:999/, 'the keyfile owner is never corrected');
  });
});

// ── the CLI regression that authentication exposed ───────────────────────────

describe('P2H4 · CLI tools resolve the credential the same way the API does', () => {
  it('MONGODB_URI is a file-backed secret', () => {
    assert.ok(FILE_BACKED_SECRETS.includes('MONGODB_URI'));
  });

  it('resolves MONGODB_URI_FILE, which nine CLI tools previously ignored', () => {
    /**
     * THE DEFECT, MEASURED. `src/seed.js` and eight scripts each did
     * `process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/...'` and none
     * called `loadFileBackedSecrets()`. Harmless while MongoDB was open;
     * the moment auth was enabled, `npm run seed` in the container failed with
     * `ECONNREFUSED 127.0.0.1:27017` because only `MONGODB_URI_FILE` was set.
     */
    const env = {MONGODB_URI_FILE: path.join(ROOT, 'package.json')};
    const uri = resolveCliMongoUri({env});
    assert.ok(uri.length > 0, 'the file-backed URI was not resolved');
    assert.equal(env.MONGODB_URI, uri, 'the resolved value was not written back');
  });

  it('REFUSES to invent an unauthenticated localhost fallback', () => {
    /**
     * The dangerous shape, not just the broken one. A tool that silently falls
     * back to `mongodb://127.0.0.1:27017/...` will, on a developer machine
     * running a local mongod, quietly operate on the WRONG DATABASE instead of
     * failing. It must refuse.
     */
    assert.throws(
      () => resolveCliMongoUri({env: {}}),
      /MONGODB_URI is not set/,
      'a CLI tool would silently connect to an unauthenticated localhost database'
    );
  });

  it('honours an explicit fallback only when one is asked for', () => {
    const uri = resolveCliMongoUri({env: {}, fallback: 'mongodb://127.0.0.1:27017/scratch'});
    assert.equal(uri, 'mongodb://127.0.0.1:27017/scratch');
  });

  it('no CLI entry point still hardcodes an unauthenticated default', () => {
    const files = [
      'server/src/seed.js',
      'server/scripts/seed-plans.js',
      'server/scripts/order-quota-dry-run.js',
      'server/scripts/platform-admin.js',
      'server/scripts/verify-audit-chain.js',
      'server/scripts/backfill-completed-at.js',
      'server/scripts/migrate-alert-lifecycle.js',
      'server/scripts/recover-stock-count-locks.js',
      'server/scripts/restore.js'
    ];
    for (const file of files) {
      const source = read(file);
      assert.ok(
        source.includes('resolveCliMongoUri'),
        `${file} does not resolve the URI through the shared helper`
      );
      assert.ok(
        !/process\.env\.MONGODB_URI\s*\|\|\s*'mongodb:/.test(source),
        `${file} still falls back to a hardcoded unauthenticated URI`
      );
    }
  });

  it('a missing secret file is a loud failure, not a silent fallback', () => {
    // Quietly falling back is how a deployment runs on the wrong credential
    // while the operator believes it is using the right one.
    assert.throws(
      () => loadFileBackedSecrets({MONGODB_URI_FILE: '/nonexistent/secret'}),
      /could not be read/
    );
  });
});
