import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {after, before, describe, test} from 'node:test';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import jwt from 'jsonwebtoken';

const productionSecret = '3f88962c111762160e8a97d2430c105272788ee32f2855fe';
const children = new Set();
let replset;

function spawnApi(environment) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {...process.env, ...environment},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function childOutput(child) {
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return () => output;
}

function waitForOutput(child, readOutput, pattern, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${readOutput()}`));
    }, timeoutMs);
    const inspect = () => {
      if (!pattern.test(readOutput())) return;
      cleanup();
      resolve();
    };
    const exited = (code, signal) => {
      cleanup();
      reject(new Error(`API exited before readiness (${code ?? signal}). Output:\n${readOutput()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', inspect);
      child.stderr.off('data', inspect);
      child.off('exit', exited);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', exited);
    inspect();
  });
}

function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for API process exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal});
    });
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const {port} = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

describe('production API process lifecycle', () => {
  before(async () => {
    replset = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: 'wiredTiger'}});
  });

  after(async () => {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map(child => waitForExit(child).catch(() => null)));
    if (replset) await replset.stop();
  });

  test('fails closed before listening when production configuration is unsafe', async () => {
    const child = spawnApi({
      NODE_ENV: 'production',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: 'replace-with-a-long-random-secret',
      CLIENT_URL: 'https://ops.example.com',
      PORT: String(await availablePort())
    });
    const readOutput = childOutput(child);
    const result = await waitForExit(child);

    assert.equal(result.code, 1);
    assert.match(readOutput(), /API startup failed/);
    assert.match(readOutput(), /JWT_SECRET must be replaced/);
  });

  test('refuses to start in production without CLIENT_URL rather than serving every origin', async () => {
    const child = spawnApi({
      NODE_ENV: 'production',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: productionSecret,
      CLIENT_URL: '',
      PORT: String(await availablePort())
    });
    const readOutput = childOutput(child);
    const result = await waitForExit(child);

    assert.equal(result.code, 1);
    assert.match(readOutput(), /CLIENT_URL is required in production/);
  });

  test('refuses to start in production with a wildcard CLIENT_URL', async () => {
    const child = spawnApi({
      NODE_ENV: 'production',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: productionSecret,
      CLIENT_URL: '*',
      PORT: String(await availablePort())
    });
    const readOutput = childOutput(child);
    const result = await waitForExit(child);

    assert.equal(result.code, 1);
    assert.match(readOutput(), /CLIENT_URL must list explicit HTTP\(S\) origins/);
  });

  test('refuses to start when TRUST_PROXY would trust client-supplied forwarding headers', async () => {
    const child = spawnApi({
      NODE_ENV: 'production',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: productionSecret,
      CLIENT_URL: 'https://ops.example.com',
      TRUST_PROXY: 'true',
      PORT: String(await availablePort())
    });
    const readOutput = childOutput(child);
    const result = await waitForExit(child);

    assert.equal(result.code, 1);
    assert.match(readOutput(), /TRUST_PROXY must not be true/);
  });

  test('refuses to start a staging deployment without an explicit origin allowlist', async () => {
    // APP_ENV=staging with NODE_ENV=development must NOT get the permissive
    // development fallback: staging is hardened exactly like production.
    const child = spawnApi({
      NODE_ENV: 'development',
      APP_ENV: 'staging',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: productionSecret,
      CLIENT_URL: '',
      PORT: String(await availablePort())
    });
    const readOutput = childOutput(child);
    const result = await waitForExit(child);

    assert.equal(result.code, 1);
    assert.match(readOutput(), /CLIENT_URL is required in staging/);
  });

  test('ignores forwarding headers entirely when TRUST_PROXY is disabled', async () => {
    // This is the case that distinguishes a real configuration read from a
    // hardcoded `trust proxy = 1`: with no proxy trusted, X-Forwarded-For must
    // have no effect at all on the client identity used for rate limiting.
    const port = await availablePort();
    const child = spawnApi({
      NODE_ENV: 'production',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: productionSecret,
      CLIENT_URL: 'https://ops.example.com',
      TRUST_PROXY: 'false',
      PORT: String(port)
    });
    const readOutput = childOutput(child);

    try {
      await waitForOutput(child, readOutput, new RegExp(`API ready on port ${port}`));

      const posture = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.equal(posture.trustProxy, 'false');

      const spoofed = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {'X-Forwarded-For': '203.0.113.9'}
      });
      assert.equal((await spoofed.json()).clientIp, '127.0.0.1',
        'a forged X-Forwarded-For must not become the client IP when no proxy is trusted');
    } finally {
      child.kill('SIGKILL');
      await waitForExit(child).catch(() => null);
    }
  });

  test('reads the real client IP behind the expected single nginx hop', async () => {
    const port = await availablePort();
    const allowedOrigin = 'https://ops.example.com';
    const child = spawnApi({
      NODE_ENV: 'production',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: productionSecret,
      CLIENT_URL: allowedOrigin,
      TRUST_PROXY: '1',
      PORT: String(port)
    });
    const readOutput = childOutput(child);

    try {
      await waitForOutput(child, readOutput, new RegExp(`API ready on port ${port}`));

      const posture = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.equal(posture.trustProxy, '1');
      assert.equal(posture.environment, 'production');

      // What nginx actually sends (client/nginx.conf appends $remote_addr).
      const proxied = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {'X-Forwarded-For': '203.0.113.9'}
      });
      assert.equal((await proxied.json()).clientIp, '203.0.113.9');

      // A caller who prepends their own entry cannot displace the address
      // nginx appended, so they cannot forge their rate-limit identity.
      const forged = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {'X-Forwarded-For': '9.9.9.9, 203.0.113.9'}
      });
      assert.equal((await forged.json()).clientIp, '203.0.113.9');
    } finally {
      child.kill('SIGKILL');
      await waitForExit(child).catch(() => null);
    }
  });

  test('becomes ready, enforces configured CORS origins, and exits cleanly on SIGTERM', async () => {
    const port = await availablePort();
    const allowedOrigin = 'http://localhost:8080';
    const child = spawnApi({
      NODE_ENV: 'production',
      MONGODB_URI: replset.getUri(),
      JWT_SECRET: productionSecret,
      CLIENT_URL: allowedOrigin,
      PORT: String(port)
    });
    const readOutput = childOutput(child);

    try {
      await waitForOutput(child, readOutput, new RegExp(`API ready on port ${port}`));

      const health = await fetch(`http://127.0.0.1:${port}/health`, {headers: {Origin: allowedOrigin}});
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('access-control-allow-origin'), allowedOrigin);
      // /health also reports the resolved deployment posture (Phase 8A.6) so an
      // operator can confirm from outside the container which environment
      // class, CORS mode and proxy trust the process actually booted with.
      assert.deepEqual(await health.json(), {
        ok: true,
        database: 'connected',
        startup: 'ready',
        environment: 'production',
        cors: 'allowlist',
        trustProxy: 'loopback',
        rateLimit: 'per-instance-memory',
        clientIp: '127.0.0.1',
        // Phase 8B: payment posture is reported too, so an operator can see
        // which gateways a running container actually has credentials for.
        // No secret appears here - only whether one is present.
        payments: {
          mode: 'production',
          esewa: {configured: false, productCode: null},
          khalti: {configured: false},
          methods: ['cod']
        }
      });

      // TRUST_PROXY is unset here, so the default 'loopback' applies: a proxy
      // on this host may set forwarding headers. That is the whole point of the
      // default, and it is asserted rather than assumed.
      const viaLocalProxy = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: {'X-Forwarded-For': '203.0.113.9'}
      });
      assert.equal((await viaLocalProxy.json()).clientIp, '203.0.113.9');

      const untrusted = await fetch(`http://127.0.0.1:${port}/health`, {headers: {Origin: 'https://untrusted.example'}});
      assert.equal(untrusted.status, 200);
      assert.equal(untrusted.headers.get('access-control-allow-origin'), null);

      const token = jwt.sign({id: '507f1f77bcf86cd799439011', role: 'owner'}, productionSecret);
      for (const path of ['/api/purchases', '/api/sales', '/api/waste']) {
        const retired = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
          body: '{}'
        });
        assert.equal(retired.status, 410, `${path} must stay retired`);
        assert.match((await retired.json()).message, /retired|no longer/i);
      }

      child.kill('SIGTERM');
      const result = await waitForExit(child);
      assert.equal(result.code, 0);
      assert.match(readOutput(), /SIGTERM received; shutting down/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child).catch(() => null);
      }
    }
  });
});
