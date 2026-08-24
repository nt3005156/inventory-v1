#!/usr/bin/env node
/**
 * Phase 27 — MongoDB backup.
 *
 *   MongoDB  ->  mongodump (BSON + gzip)  ->  storage directory  ->  retention
 *
 * WHY mongodump AND NOT A FILESYSTEM COPY. Copying `/data/db` under a running
 * mongod produces a torn snapshot unless the filesystem can do an atomic
 * volume snapshot, which a plain `docker cp` or `tar` cannot. `mongodump`
 * reads through the server, so what lands on disk is a consistent view of each
 * collection.
 *
 * CONSISTENCY. `--oplog` captures the oplog window spanning the dump, so
 * `mongorestore --oplogReplay` produces a point-in-time consistent restore
 * across collections rather than a per-collection smear. This matters here
 * more than in most systems: an order, its payment and its inventory ledger
 * rows are written in one transaction, and a backup that captured the payment
 * but not the stock movement would restore a database that does not balance.
 * `--oplog` requires a replica set, which this deployment already is.
 *
 * WHAT IS NOT BACKED UP. Only MongoDB. There are no uploaded files in this
 * system (verified in Phase 25 — no upload endpoints exist), so the database
 * is the entire durable state apart from `.env`, which holds secrets and is
 * deliberately NOT captured here: writing JWT and payment secrets into a
 * backup tarball spreads them to wherever backups are copied. `.env` is
 * handled as a documented operator step in the runbook instead.
 *
 * Usage:
 *   node server/scripts/backup.js
 *   node server/scripts/backup.js --out /var/backups/mittho --keep-days 30
 *   node server/scripts/backup.js --verify-only <dir>
 */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_KEEP_DAYS = 14;
export const DEFAULT_KEEP_MINIMUM = 3;

/** Parse `--flag value` pairs without pulling in a CLI dependency. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * A backup label that sorts chronologically as a plain string.
 *
 * Deliberately UTC, not Kathmandu. Backup filenames are read by operators and
 * by the retention sweep; a local timezone that shifts would make the sort
 * order lie. The runbook says so explicitly so nobody misreads a filename as
 * local time.
 */
export function backupName(now = new Date()) {
  const iso = now.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  return `mittho-${iso}`;
}

/**
 * The database name from a MongoDB URI.
 *
 * Needed because `mongorestore` has to be told which database to write into,
 * and reading it from the URI keeps backup and restore pointing at the same
 * place without a second setting to get wrong.
 */
export function databaseFromUri(uri) {
  const withoutScheme = String(uri || '').replace(/^mongodb(\+srv)?:\/\//, '');
  const afterHost = withoutScheme.split('/').slice(1).join('/');
  const name = afterHost.split('?')[0].trim();
  if (!name) throw new Error('MONGODB_URI must include a database name');
  return name;
}

function run(command, args, {env} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => reject(
      error.code === 'ENOENT'
        ? new Error(`${command} is not installed or not on PATH. Install the MongoDB Database Tools.`)
        : error
    ));
    child.on('close', code => (code === 0
      ? resolve({stdout, stderr})
      // mongodump writes its progress to stderr, so include it: without it a
      // failure reports an exit code and nothing an operator can act on.
      : reject(Object.assign(new Error(`${command} exited ${code}: ${stderr.trim().slice(-800)}`), {code}))));
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/** Every file in the dump, relative to its root, sorted for a stable manifest. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

/**
 * Take a backup.
 *
 * Writes `<out>/<name>/dump/...` plus a `manifest.json` carrying a SHA-256 per
 * file. The manifest is what makes `verifyBackup()` meaningful: without
 * per-file digests, "the backup exists" is the only thing that could be
 * checked, and a truncated or silently corrupted dump would pass.
 */
export async function createBackup({
  uri = process.env.MONGODB_URI,
  outDir = process.env.BACKUP_DIR || './backups',
  now = new Date(),
  oplog = true,
  log = console.log
} = {}) {
  if (!uri) throw new Error('MONGODB_URI is required to take a backup');
  const database = databaseFromUri(uri);
  const name = backupName(now);
  const root = path.resolve(outDir, name);
  const dumpDir = path.join(root, 'dump');
  await fs.mkdir(dumpDir, {recursive: true});

  /**
   * `--oplog` is only accepted on a FULL CLUSTER dump — a URI carrying a
   * database name scopes the dump and mongodump then rejects the flag with
   * "bad option: --oplog mode only supported on full dumps". Verified against
   * mongodump 100.9.4 before this was written.
   *
   * So the oplog path connects with the database stripped from the URI (query
   * parameters such as replicaSet kept) and lets the dump cover the cluster.
   * `admin` comes along, which is harmless and is filtered at restore time by
   * pointing mongorestore at the single database directory.
   */
  const clusterUri = uri.replace(/\/[^/?]*(\?|$)/, '/$1');
  const args = oplog
    ? ['--uri', clusterUri, '--gzip', '--oplog', '--out', dumpDir]
    : ['--uri', uri, '--gzip', '--out', dumpDir];

  const started = Date.now();
  try {
    await run('mongodump', args);
  } catch (error) {
    if (oplog && /oplog|replica set|not supported|full dumps/i.test(error.message)) {
      log('  --oplog unavailable (not a replica set); falling back to a per-collection dump');
      await fs.rm(dumpDir, {recursive: true, force: true});
      await fs.mkdir(dumpDir, {recursive: true});
      await run('mongodump', ['--uri', uri, '--gzip', '--out', dumpDir]);
      return finish({root, dumpDir, database, name, started, oplog: false, log});
    }
    // Leave nothing half-written that a later restore could pick up.
    await fs.rm(root, {recursive: true, force: true});
    throw error;
  }
  return finish({root, dumpDir, database, name, started, oplog, log});
}

async function finish({root, dumpDir, database, name, started, oplog, log}) {
  const files = await walk(dumpDir);
  if (!files.length) {
    await fs.rm(root, {recursive: true, force: true});
    throw new Error('mongodump produced no files; refusing to record an empty backup');
  }

  const checksums = {};
  let bytes = 0;
  for (const relative of files) {
    const full = path.join(dumpDir, relative);
    checksums[relative] = await sha256(full);
    bytes += (await fs.stat(full)).size;
  }

  const manifest = {
    name,
    database,
    createdAt: new Date().toISOString(),
    tool: 'mongodump',
    gzip: true,
    oplog,
    durationMs: Date.now() - started,
    fileCount: files.length,
    bytes,
    checksums
  };
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`  backup ${name}: ${files.length} files, ${(bytes / 1024).toFixed(1)} KB, oplog=${oplog}`);
  return {path: root, manifest};
}

/**
 * Verify a backup on disk against its own manifest.
 *
 * A backup nobody has verified is a hope, not a backup. This is cheap enough
 * to run on every backup and is what the retention sweep checks before it
 * deletes an older copy.
 */
export async function verifyBackup(backupPath) {
  const manifestPath = path.join(backupPath, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return {ok: false, problems: ['manifest.json is missing or unreadable']};
  }

  const problems = [];
  const dumpDir = path.join(backupPath, 'dump');
  const present = new Set(await walk(dumpDir).catch(() => []));

  for (const [relative, expected] of Object.entries(manifest.checksums || {})) {
    if (!present.has(relative)) {
      problems.push(`missing file: ${relative}`);
      continue;
    }
    const actual = await sha256(path.join(dumpDir, relative));
    if (actual !== expected) problems.push(`checksum mismatch: ${relative}`);
  }
  for (const relative of present) {
    if (!(relative in (manifest.checksums || {}))) problems.push(`unexpected file: ${relative}`);
  }
  if (!Object.keys(manifest.checksums || {}).length) problems.push('manifest lists no files');

  return {ok: problems.length === 0, problems, manifest};
}

/**
 * Delete backups older than `keepDays`.
 *
 * Two safety rules, both deliberate:
 *
 *   1. `keepMinimum` copies always survive regardless of age. A misconfigured
 *      clock or a long outage must not be able to sweep away every backup.
 *   2. A backup that FAILS verification is never counted toward the minimum.
 *      Keeping three corrupt copies and deleting the one good one is the
 *      failure mode this rule exists to prevent.
 */
export async function applyRetention({
  outDir = process.env.BACKUP_DIR || './backups',
  keepDays = Number(process.env.BACKUP_KEEP_DAYS) || DEFAULT_KEEP_DAYS,
  keepMinimum = Number(process.env.BACKUP_KEEP_MINIMUM) || DEFAULT_KEEP_MINIMUM,
  now = new Date(),
  dryRun = false,
  log = console.log
} = {}) {
  const root = path.resolve(outDir);
  const entries = await fs.readdir(root, {withFileTypes: true}).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mittho-')) continue;
    const full = path.join(root, entry.name);
    const verification = await verifyBackup(full);
    let createdAt = null;
    try {
      createdAt = new Date(JSON.parse(await fs.readFile(path.join(full, 'manifest.json'), 'utf8')).createdAt);
    } catch { createdAt = (await fs.stat(full)).mtime; }
    candidates.push({name: entry.name, path: full, createdAt, healthy: verification.ok});
  }

  // Newest first, so "the ones we keep" are the freshest healthy copies.
  candidates.sort((a, b) => b.createdAt - a.createdAt);
  const healthy = candidates.filter(entry => entry.healthy);
  const protectedPaths = new Set(healthy.slice(0, keepMinimum).map(entry => entry.path));

  const cutoff = now.getTime() - keepDays * 86400000;
  const deleted = [];
  const kept = [];
  for (const entry of candidates) {
    const tooOld = entry.createdAt.getTime() < cutoff;
    if (tooOld && !protectedPaths.has(entry.path)) {
      if (!dryRun) await fs.rm(entry.path, {recursive: true, force: true});
      deleted.push(entry.name);
    } else {
      kept.push(entry.name);
    }
  }
  log(`  retention: kept ${kept.length}, deleted ${deleted.length} (keepDays=${keepDays}, keepMinimum=${keepMinimum})`);
  return {kept, deleted, healthy: healthy.length, unhealthy: candidates.length - healthy.length};
}

/** List backups newest first, with their verification state. */
export async function listBackups({outDir = process.env.BACKUP_DIR || './backups'} = {}) {
  const root = path.resolve(outDir);
  const entries = await fs.readdir(root, {withFileTypes: true}).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mittho-')) continue;
    const full = path.join(root, entry.name);
    const verification = await verifyBackup(full);
    rows.push({
      name: entry.name,
      path: full,
      ok: verification.ok,
      problems: verification.problems,
      createdAt: verification.manifest?.createdAt || null,
      bytes: verification.manifest?.bytes ?? null
    });
  }
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('backup.js');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out || process.env.BACKUP_DIR || './backups';

  if (args['verify-only']) {
    const target = args['verify-only'] === true ? outDir : args['verify-only'];
    const result = await verifyBackup(path.resolve(target));
    console.log(result.ok ? `OK ${target}` : `CORRUPT ${target}`);
    for (const problem of result.problems) console.log(`  - ${problem}`);
    process.exit(result.ok ? 0 : 1);
  }

  if (args.list) {
    for (const row of await listBackups({outDir})) {
      console.log(`${row.ok ? 'OK     ' : 'CORRUPT'} ${row.name}  ${row.createdAt || ''}`);
    }
    process.exit(0);
  }

  console.log('Backing up…');
  const {path: backupPath} = await createBackup({outDir});
  const verification = await verifyBackup(backupPath);
  if (!verification.ok) {
    console.error('Backup failed verification immediately after being written:');
    for (const problem of verification.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('  verified');
  await applyRetention({
    outDir,
    keepDays: Number(args['keep-days']) || Number(process.env.BACKUP_KEEP_DAYS) || DEFAULT_KEEP_DAYS
  });
  console.log(`Done: ${backupPath}`);
}
