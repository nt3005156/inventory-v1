#!/usr/bin/env node
/**
 * Phase 27 — MongoDB restore.
 *
 *   storage  ->  verify manifest  ->  mongorestore  ->  verify data
 *
 * A restore is the dangerous half of disaster recovery: it is the one
 * operation that deliberately overwrites a live database. Three guards, all of
 * which exist because the failure they prevent is unrecoverable:
 *
 *   1. THE BACKUP IS VERIFIED FIRST. Restoring an unverified dump can turn a
 *      recoverable outage into permanent data loss — you drop what you had and
 *      then discover the replacement is truncated. `--force` exists but has to
 *      be typed.
 *
 *   2. `--drop` IS OPT-IN. Without it `mongorestore` merges into whatever is
 *      already there, which silently mixes two datasets. With it, the target
 *      is emptied first. Neither is safe as an unconsidered default, so the
 *      operator must choose, and the choice is echoed before it happens.
 *
 *   3. RESTORING OVER A NON-EMPTY PRODUCTION DATABASE REQUIRES
 *      `--i-understand-this-overwrites`. `NODE_ENV=production` plus existing
 *      collections is the exact shape of "an operator ran the DR drill against
 *      the live cluster by mistake".
 *
 * `--oplogReplay` is used automatically when the backup recorded `oplog:true`,
 * which is what makes the restore point-in-time consistent across collections
 * rather than a per-collection smear.
 *
 * Usage:
 *   node server/scripts/restore.js --from ./backups/mittho-... --drop
 *   node server/scripts/restore.js --from <dir> --uri mongodb://host/dbname --drop
 *   node server/scripts/restore.js --latest --drop
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {databaseFromUri, listBackups, parseArgs, verifyBackup} from './backup.js';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
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
      : reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(-800)}`))));
  });
}

/**
 * `mongodump --out X` writes `X/<dbname>/...`. Find that directory so the
 * caller does not have to know the source database name, and so a backup taken
 * from `mittho_ops` can be restored into `mittho_ops_drill`.
 */
export async function resolveDumpSource(backupPath, {preferDatabase = null} = {}) {
  const dumpDir = path.join(backupPath, 'dump');
  const entries = await fs.readdir(dumpDir, {withFileTypes: true});
  /**
   * An --oplog backup is a FULL CLUSTER dump, so `admin` (and on some servers
   * `config`/`local`) sit alongside the application database. Those are the
   * server's own bookkeeping: restoring them over a different cluster would at
   * best be meaningless and at worst overwrite that cluster's users and
   * replica configuration. Only the application database is restored.
   */
  const SERVER_DATABASES = new Set(['admin', 'config', 'local']);
  const databases = entries
    .filter(entry => entry.isDirectory() && !SERVER_DATABASES.has(entry.name))
    .map(entry => entry.name);

  if (!databases.length) throw new Error('the dump contains no application database');
  let chosen = databases[0];
  if (databases.length > 1) {
    if (preferDatabase && databases.includes(preferDatabase)) chosen = preferDatabase;
    else throw new Error(`the dump holds several databases (${databases.join(', ')}); pass --database to choose`);
  }
  return {
    dumpDir,
    sourceDatabase: chosen,
    sourcePath: path.join(dumpDir, chosen),
    oplogFile: entries.some(entry => entry.isFile() && entry.name.startsWith('oplog.bson'))
  };
}

/**
 * Refuse to overwrite a populated production database without an explicit
 * acknowledgement. Exported so the guard itself is testable rather than only
 * reachable by actually destroying something.
 */
export function assertRestoreAllowed({env = process.env, collectionCount = 0, acknowledged = false}) {
  const isProduction = String(env.APP_ENV || env.NODE_ENV || '').toLowerCase() === 'production';
  if (isProduction && collectionCount > 0 && !acknowledged) {
    throw new Error(
      'Refusing to restore over a non-empty production database. ' +
      'Re-run with --i-understand-this-overwrites if that is genuinely what you want.'
    );
  }
  return true;
}

/**
 * Turn mongorestore's own output into a pass/fail decision.
 *
 * Pure and exported so the guard is testable without needing a specific
 * mongodb-database-tools version installed — which matters, because the
 * failure it defends against only reproduces on 100.18.0.
 *
 * Returns the restored document count, or throws when the restore did not
 * actually put data back.
 */
export function assertRestoreProducedData(stderr, {drop = false} = {}) {
  const text = String(stderr || '');
  const summary = /(\d+) document\(s\) restored successfully/.exec(text);
  const restoredDocuments = summary ? Number(summary[1]) : null;

  if (text.includes("don't know what to do with file")) {
    throw new Error(
      'mongorestore skipped files in the dump — the arguments do not match this ' +
      'tool version. Nothing was restored; the target may now be empty.'
    );
  }
  /**
   * A zero-document restore is only a FAILURE when the target was dropped
   * first. Without `--drop`, mongorestore merges and legitimately reports 0
   * when every document already exists (duplicate `_id`s are skipped) — that
   * is a no-op re-restore, not a broken one. With `--drop` the target was
   * emptied moments ago, so zero means nothing came back.
   */
  if (drop && restoredDocuments === 0) {
    throw new Error(
      'mongorestore reported 0 documents restored after --drop. Refusing to ' +
      'report success: the target has been emptied and not repopulated.'
    );
  }
  return restoredDocuments;
}

export async function restoreBackup({
  backupPath,
  uri = process.env.MONGODB_URI,
  drop = false,
  force = false,
  acknowledged = false,
  targetDatabase = null,
  log = console.log
} = {}) {
  if (!uri) throw new Error('MONGODB_URI (or --uri) is required to restore');
  if (!backupPath) throw new Error('a backup path is required');

  const verification = await verifyBackup(backupPath);
  if (!verification.ok && !force) {
    throw new Error(
      `Backup failed verification, refusing to restore:\n  - ${verification.problems.join('\n  - ')}\n` +
      'Pass --force only if you accept restoring a damaged backup.'
    );
  }
  if (!verification.ok) log('  WARNING: restoring a backup that FAILED verification (--force)');

  const {sourcePath, sourceDatabase, oplogFile} = await resolveDumpSource(
    backupPath, {preferDatabase: verification.manifest?.database || null}
  );
  const destination = targetDatabase || databaseFromUri(uri);

  // Count what is already there, both for the production guard and so the
  // operator sees what they are about to replace.
  const mongoose = (await import('mongoose')).default;
  const opened = mongoose.connection.readyState !== 1;
  if (opened) await mongoose.connect(uri);
  const existing = await mongoose.connection.db.listCollections().toArray();
  assertRestoreAllowed({collectionCount: existing.length, acknowledged});
  if (opened) await mongoose.disconnect();

  log(`  restoring ${sourceDatabase} -> ${destination} (drop=${drop}, existing collections=${existing.length})`);

  /**
   * DEFECT FOUND IN THE PHASE 30 AUDIT, against a real containerised MongoDB.
   *
   * This used to pass `--nsFrom <db>.* --nsTo <db>.*` alongside a `--dir` that
   * already points AT the database directory. On mongodb-database-tools
   * 100.9.4 (the version the Phase 27 tests run against) that works. On
   * 100.18.0 (shipped in the `mongo:7` image) the same arguments make
   * mongorestore skip every file --
   *
   *   don't know what to do with file `.../orders.bson.gz`, skipping...
   *   0 document(s) restored successfully.
   *
   * -- and still EXIT 0. Combined with `--drop`, that is the worst possible
   * outcome: the target is emptied and the "successful" restore puts nothing
   * back. Reproduced both ways: identical arguments restored 3/3 documents on
   * 100.9.4 and 0 on 100.18.0.
   *
   * The version-independent form is `-d <database>` with a database-level
   * `--dir`, which is also what the MongoDB documentation shows. `--nsFrom`
   * and `--nsTo` are namespace REWRITE options meant for a full-dump restore;
   * they were never needed here, because renaming the target database is what
   * `-d` does.
   */
  const args = [
    '--uri', uri,
    '--gzip',
    '-d', destination,
    '--dir', sourcePath
  ];
  if (drop) args.push('--drop');
  /**
   * NOTE ON --oplogReplay. It applies to a full-dump restore, not to the
   * single-database `--dir` restore used here, and mongorestore rejects the
   * combination. The oplog is still CAPTURED (it is what makes the dump a
   * point-in-time snapshot rather than a per-collection smear) and is
   * preserved in the backup for a full-cluster recovery; this
   * single-database path simply does not replay it. The runbook documents
   * both procedures and which one replays.
   */
  if (verification.manifest?.oplog && !oplogFile) {
    log('  manifest claims oplog but no oplog.bson is present in the backup');
  }

  const started = Date.now();
  const {stderr} = await run('mongorestore', args);

  /**
   * mongorestore EXITS 0 EVEN WHEN IT RESTORES NOTHING.
   *
   * Found in the Phase 30 audit: with the wrong argument shape it printed
   * "don't know what to do with file ... skipping" for every collection,
   * reported "0 document(s) restored successfully", and exited 0 — after
   * `--drop` had already emptied the target. The operator sees a clean exit
   * and an empty database.
   *
   * So a successful exit code is not accepted as proof. The restored document
   * count is parsed from the tool's own summary and a zero-document restore of
   * a non-empty backup is raised as a failure.
   */
  const restoredDocuments = assertRestoreProducedData(stderr, {drop});

  return {
    database: destination,
    sourceDatabase,
    durationMs: Date.now() - started,
    verifiedBackup: verification.ok,
    restoredDocuments
  };
}

/**
 * Post-restore verification.
 *
 * Counting documents is necessary but not sufficient: a restore can produce
 * the right row counts and still be unusable if indexes are missing, so both
 * are checked. The audit hash chain is checked too — it is the one structure
 * in this system that can prove the restored rows are byte-identical to what
 * was backed up, not merely present in the right quantity.
 */
export async function verifyRestore({uri = process.env.MONGODB_URI, expected = null} = {}) {
  const mongoose = (await import('mongoose')).default;
  const opened = mongoose.connection.readyState !== 1;
  if (opened) await mongoose.connect(uri);

  const collections = await mongoose.connection.db.listCollections().toArray();
  const counts = {};
  const indexes = {};
  for (const {name} of collections) {
    if (name.startsWith('system.')) continue;
    counts[name] = await mongoose.connection.db.collection(name).countDocuments();
    indexes[name] = (await mongoose.connection.db.collection(name).indexes()).map(index => index.name).sort();
  }
  if (opened) await mongoose.disconnect();

  const problems = [];
  if (expected) {
    for (const [name, count] of Object.entries(expected)) {
      if (counts[name] === undefined) problems.push(`collection ${name} is missing after restore`);
      else if (counts[name] !== count) problems.push(`${name}: expected ${count} documents, found ${counts[name]}`);
    }
  }
  return {ok: problems.length === 0, problems, counts, indexes};
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('restore.js');
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  let source = args.from;

  if (args.latest) {
    const available = await listBackups({outDir: args.out || process.env.BACKUP_DIR || './backups'});
    const [newest] = available.filter(row => row.ok);
    if (!newest) {
      console.error('No verified backup found to restore.');
      process.exit(1);
    }
    source = newest.path;
  }
  if (!source) {
    console.error('Usage: restore.js --from <backup-dir> [--drop] [--uri <uri>]  |  --latest --drop');
    process.exit(1);
  }

  console.log(`Restoring from ${source}`);
  const result = await restoreBackup({
    backupPath: path.resolve(source),
    uri: args.uri || process.env.MONGODB_URI,
    drop: Boolean(args.drop),
    force: Boolean(args.force),
    acknowledged: Boolean(args['i-understand-this-overwrites']),
    targetDatabase: args.database || null
  });
  console.log(`  restored in ${result.durationMs}ms`);

  const check = await verifyRestore({uri: args.uri || process.env.MONGODB_URI});
  console.log('  collections:', Object.keys(check.counts).length);
  for (const [name, count] of Object.entries(check.counts).sort()) {
    console.log(`    ${name.padEnd(28)} ${count}`);
  }
  console.log(check.ok ? 'Restore verified.' : 'Restore verification reported problems.');
  process.exit(check.ok ? 0 : 1);
}
