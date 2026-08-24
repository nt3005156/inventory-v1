import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {Ingredient, MenuItem, Supplier, User} from '../src/models/index.js';
import {
  Branch, Customer, InventoryBalance, InventoryTransaction, Order, Payment, Restaurant
} from '../src/models/operations.js';
import {
  DEFAULT_KEEP_DAYS, applyRetention, backupName, createBackup, databaseFromUri, listBackups,
  parseArgs, verifyBackup
} from '../scripts/backup.js';
import {
  assertRestoreAllowed, assertRestoreProducedData, resolveDumpSource, restoreBackup, verifyRestore
} from '../scripts/restore.js';

/**
 * Phase 27 — backup and disaster recovery.
 *
 * The brief's rule is the important one: **do not claim disaster recovery
 * until restoration has actually been tested**. So this suite does not mock
 * anything. It stands up a real replica set, writes real data through the
 * application's own models, runs the real `mongodump`, DESTROYS the database,
 * runs the real `mongorestore`, and then proves the data came back — by
 * document counts, by index presence, by field-level comparison, and by
 * re-verifying the audit hash chain, which is the one structure that can show
 * the restored bytes are identical rather than merely numerous.
 *
 * If the MongoDB Database Tools are not installed, these tests SKIP loudly
 * rather than passing. A green suite that silently skipped the only thing it
 * was written to prove would be worse than no suite: it would let somebody
 * believe DR is tested when nothing ran.
 */

const TOOLS_AVAILABLE = (() => {
  for (const tool of ['mongodump', 'mongorestore']) {
    try {
      execFileSync(tool, ['--version'], {stdio: 'ignore'});
    } catch {
      return false;
    }
  }
  return true;
})();

if (!TOOLS_AVAILABLE) {
  console.warn(
    '\n[phase27] mongodump/mongorestore are NOT installed — the backup/restore ' +
    'integration tests were SKIPPED. Disaster recovery is therefore UNVERIFIED ' +
    'in this environment. Install the MongoDB Database Tools to run them.\n'
  );
}

let replset;
let uri;
let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mittho-dr-'));
  if (!TOOLS_AVAILABLE) return;
  // A real replica set: --oplog and point-in-time consistency need one, and a
  // standalone would let the test pass while the production path could not.
  replset = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: 'wiredTiger'}});
  // getUri() returns `mongodb://host:port/?replicaSet=...` -- concatenating a
  // database name onto that produces a malformed URI that times out on
  // connect. getUri(name) inserts it in the right place.
  uri = replset.getUri('mittho_dr_test');
  await mongoose.connect(uri);
});

after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replset) await replset.stop();
  if (workDir) await fs.rm(workDir, {recursive: true, force: true});
});

/** Realistic, referentially complete data written through the real models. */
async function seedRecoverable() {
  const restaurant = await Restaurant.create({name: 'DR Co', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({restaurant: restaurant._id, name: 'DR Branch', code: 'DR1'});
  const owner = await User.create({
    name: 'DR Owner', email: 'dr@test.com', password: 'hashed', role: 'owner',
    restaurant: 'DR Co', restaurantId: restaurant._id
  });
  const supplier = await Supplier.create({restaurant: restaurant._id, name: 'DR Supplier'});
  const ingredients = await Ingredient.insertMany(
    Array.from({length: 25}, (_, i) => ({
      restaurant: restaurant._id, code: `DR-${String(i).padStart(3, '0')}`,
      name: `DR Ingredient ${i}`, unit: 'g', lastPurchasePrice: 0.15, supplier: supplier._id
    }))
  );
  const menu = await MenuItem.insertMany(
    Array.from({length: 25}, (_, i) => ({
      restaurant: restaurant._id, name: `DR Dish ${i}`, price: 200 + i * 5, vatInclusive: false,
      recipe: [{ingredient: ingredients[i % ingredients.length]._id, qty: 100, unit: 'g'}]
    }))
  );
  const customers = await Customer.insertMany(
    Array.from({length: 40}, (_, i) => ({
      restaurant: restaurant._id, branch: branch._id, name: `DR Customer ${i}`,
      phone: `9840${String(100000 + i)}`, phoneKey: `9840${String(100000 + i)}`
    }))
  );
  await InventoryBalance.collection.insertMany(ingredients.map(ing => ({
    branch: branch._id, ingredient: ing._id, quantity: 10000, averageCost: 0.15,
    reserved: 0, ledgerVersion: 0, createdAt: new Date(), updatedAt: new Date()
  })));

  const orders = await Order.insertMany(
    Array.from({length: 60}, (_, i) => {
      const item = menu[i % menu.length];
      const subtotal = item.price;
      return {
        orderNo: `DR-ORD-${String(i).padStart(4, '0')}`,
        branch: branch._id, customer: customers[i % customers.length]._id, type: 'counter',
        status: 'completed',
        items: [{menuItem: item._id, name: item.name, qty: 1, unitPrice: item.price, lineTotal: subtotal * 1.13}],
        subtotal, vatRate: 13, vat: subtotal * 0.13, total: subtotal * 1.13,
        paidAmount: subtotal * 1.13, dueAmount: 0, createdBy: owner._id
      };
    })
  );
  await Payment.insertMany(orders.map(order => ({
    order: order._id, amount: order.total, method: 'cash', status: 'paid', cashier: owner._id
  })));
  await InventoryTransaction.collection.insertMany(
    Array.from({length: 150}, (_, i) => ({
      restaurant: restaurant._id, branch: branch._id, ingredient: ingredients[i % ingredients.length]._id,
      type: 'RECIPE_DEDUCTION', previousQty: 10000, changeQty: -50, newQty: 9950,
      unit: 'g', unitCost: 0.15, totalCost: 7.5, reason: 'dr fixture movement',
      referenceType: 'dr_fixture', referenceId: ingredients[i % ingredients.length]._id,
      user: owner._id, idempotencyKey: `dr-tx-${i}`, createdAt: new Date(), updatedAt: new Date()
    }))
  );

  // Audit rows go through the model so the hash chain is stamped, which is
  // what makes the post-restore integrity check meaningful.
  const {ensureAuditIndexes} = await import('../src/services/auditMigration.js');
  await ensureAuditIndexes();
  const {Audit} = await import('../src/models/index.js');
  for (let i = 0; i < 12; i += 1) {
    await Audit.create({
      entity: 'order', entityId: orders[i]._id, restaurant: restaurant._id, branch: branch._id,
      action: 'dr_fixture', after: {orderNo: orders[i].orderNo}, user: owner._id
    });
  }

  return {restaurant, branch, owner, ingredients, menu, customers, orders};
}

/** Every non-system collection and its document count. */
async function snapshotCounts() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  const counts = {};
  for (const {name} of collections) {
    if (name.startsWith('system.')) continue;
    counts[name] = await mongoose.connection.db.collection(name).countDocuments();
  }
  return counts;
}

// ── unit-level behaviour (runs with or without the tools) ────────────────────

describe('Phase 27 · backup plumbing', () => {
  it('derives the database name from a URI', () => {
    assert.equal(databaseFromUri('mongodb://mongo:27017/mittho_ops?replicaSet=rs0'), 'mittho_ops');
    assert.equal(databaseFromUri('mongodb://host:27017/db'), 'db');
    assert.equal(databaseFromUri('mongodb+srv://u:p@cluster.example.net/mittho?retryWrites=true'), 'mittho');
    // A URI with no database would make mongorestore guess, which is how a
    // restore ends up in the wrong place.
    assert.throws(() => databaseFromUri('mongodb://mongo:27017'), /must include a database name/);
    assert.throws(() => databaseFromUri(''), /must include a database name/);
  });

  it('names backups so they sort chronologically as strings', () => {
    const older = backupName(new Date('2026-01-02T03:04:05.000Z'));
    const newer = backupName(new Date('2026-01-02T03:04:06.000Z'));
    assert.ok(older < newer, 'string sort must match time order');
    assert.match(older, /^mittho-2026-01-02T03-04-05/);
    // UTC, deliberately: a local timezone that shifts would make the sort lie.
    assert.ok(older.includes('T03-04-05'), 'the label is UTC');
  });

  it('parses CLI arguments', () => {
    assert.deepEqual(
      parseArgs(['--from', '/b/x', '--drop', '--keep-days', '30']),
      {from: '/b/x', drop: true, 'keep-days': '30'}
    );
    assert.deepEqual(parseArgs([]), {});
  });

  it('refuses to overwrite a populated production database unacknowledged', () => {
    /**
     * The guard exists because the realistic accident is an operator running
     * the DR drill against the live cluster. It is tested directly rather than
     * by actually destroying something.
     */
    assert.throws(
      () => assertRestoreAllowed({env: {APP_ENV: 'production'}, collectionCount: 12, acknowledged: false}),
      /Refusing to restore over a non-empty production database/
    );
    // An EMPTY production database is the real recovery case and must work.
    assert.equal(assertRestoreAllowed({env: {APP_ENV: 'production'}, collectionCount: 0}), true);
    // Acknowledged is allowed: the guard is a speed bump, not a lock.
    assert.equal(
      assertRestoreAllowed({env: {APP_ENV: 'production'}, collectionCount: 12, acknowledged: true}),
      true
    );
    // Non-production is unguarded.
    assert.equal(assertRestoreAllowed({env: {APP_ENV: 'staging'}, collectionCount: 12}), true);
    assert.equal(assertRestoreAllowed({env: {NODE_ENV: 'production'}, collectionCount: 3, acknowledged: true}), true);
  });

  it('treats a zero-document restore as a failure, not a success', () => {
    /**
     * DEFECT FOUND IN THE PHASE 30 AUDIT.
     *
     * `mongorestore` EXITS 0 even when it restores nothing. Against the
     * containerised MongoDB (mongodb-database-tools 100.18.0) the old
     * `--nsFrom/--nsTo` + database-level `--dir` combination made it skip every
     * file, print "0 document(s) restored successfully" and exit 0 — after
     * `--drop` had already emptied the target. The identical arguments worked
     * on 100.9.4, the version this suite runs against, so exit status alone
     * could never have caught it.
     *
     * The guard is tested as a pure function precisely BECAUSE the failure is
     * version-specific: this assertion holds on any machine.
     */
    const skipped = [
      "don't know what to do with file `/tmp/dr/mittho_ops/orders.bson.gz`, skipping...",
      '0 document(s) restored successfully. 0 document(s) failed to restore.'
    ].join('\n');
    assert.throws(
      () => assertRestoreProducedData(skipped, {drop: true}),
      /skipped files in the dump/
    );

    // Zero documents after --drop means the target was emptied and not refilled.
    assert.throws(
      () => assertRestoreProducedData('0 document(s) restored successfully.', {drop: true}),
      /0 documents restored after --drop/
    );

    // A healthy restore returns its count.
    assert.equal(
      assertRestoreProducedData('1115 document(s) restored successfully. 0 document(s) failed to restore.', {drop: true}),
      1115
    );

    /**
     * WITHOUT --drop, zero is legitimate: mongorestore merges and skips
     * duplicate _ids, so re-restoring an unchanged backup reports 0. Treating
     * that as a failure would break the documented merge path — which is
     * exactly what my first version of this guard did, caught by the existing
     * merge test.
     */
    assert.equal(assertRestoreProducedData('0 document(s) restored successfully.', {drop: false}), 0);
  });

  it('reports a missing or corrupt backup rather than trusting it', async () => {
    const empty = path.join(workDir, 'not-a-backup');
    await fs.mkdir(empty, {recursive: true});
    const missing = await verifyBackup(empty);
    assert.equal(missing.ok, false);
    assert.match(missing.problems[0], /manifest/);
  });
});

// ── the real thing ───────────────────────────────────────────────────────────

describe('Phase 27 · backup, destroy, restore, verify', {skip: !TOOLS_AVAILABLE && 'MongoDB Database Tools not installed'}, () => {
  let seeded;
  let before_;
  let backupDir;

  before(async () => {
    seeded = await seedRecoverable();
    before_ = await snapshotCounts();
    backupDir = path.join(workDir, 'backups');
  });

  it('takes a verified backup of a live database', async () => {
    const {path: backupPath, manifest} = await createBackup({uri, outDir: backupDir, log: () => {}});
    assert.ok(manifest.fileCount > 0, 'the dump must contain files');
    assert.ok(manifest.bytes > 0);
    assert.equal(manifest.gzip, true);
    assert.equal(manifest.oplog, true, 'a replica set backup must capture the oplog');
    assert.equal(manifest.database, 'mittho_dr_test');

    const verification = await verifyBackup(backupPath);
    assert.equal(verification.ok, true, JSON.stringify(verification.problems));

    // Every collection that held data must be present in the dump.
    const {sourcePath} = await resolveDumpSource(backupPath);
    const dumped = (await fs.readdir(sourcePath)).filter(f => f.endsWith('.bson.gz')).map(f => f.replace('.bson.gz', ''));
    for (const name of Object.keys(before_)) {
      assert.ok(dumped.includes(name), `${name} is missing from the dump`);
    }
  });

  it('detects a corrupted backup instead of restoring it', async () => {
    /**
     * The single most valuable test here. A backup that cannot be shown to be
     * intact is a hope. Corrupt one byte and the manifest must catch it, and
     * the restore must refuse.
     */
    const {path: backupPath} = await createBackup({uri, outDir: backupDir, log: () => {}});
    const {sourcePath} = await resolveDumpSource(backupPath);
    const victim = (await fs.readdir(sourcePath)).find(f => f.endsWith('.bson.gz'));
    const target = path.join(sourcePath, victim);
    const bytes = await fs.readFile(target);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await fs.writeFile(target, bytes);

    const verification = await verifyBackup(backupPath);
    assert.equal(verification.ok, false, 'a corrupted file must fail verification');
    assert.match(verification.problems.join(' '), /checksum mismatch/);

    await assert.rejects(
      () => restoreBackup({backupPath, uri, drop: true, log: () => {}}),
      /failed verification, refusing to restore/
    );

    await fs.rm(backupPath, {recursive: true, force: true});
  });

  it('RESTORES a destroyed database and returns every document', async () => {
    /**
     * The drill the brief asks for, for real:
     *
     *   backup -> DROP THE DATABASE -> restore -> verify
     *
     * Nothing is mocked. `dropDatabase()` is the genuine article: after it,
     * the data exists only inside the dump on disk.
     */
    const {path: backupPath} = await createBackup({uri, outDir: backupDir, log: () => {}});
    assert.equal((await verifyBackup(backupPath)).ok, true);

    // Capture field-level evidence, not just counts, so "restored" means the
    // same rows and not merely the same number of rows.
    const orderBefore = await Order.findOne({orderNo: 'DR-ORD-0007'}).lean();
    const customerBefore = await Customer.findOne({name: 'DR Customer 11'}).lean();
    const indexesBefore = (await mongoose.connection.db.collection('orders').indexes())
      .map(index => index.name).sort();
    assert.ok(orderBefore && customerBefore);

    // ── DESTROY ──────────────────────────────────────────────────────────────
    await mongoose.connection.db.dropDatabase();
    const afterDrop = await snapshotCounts();
    assert.deepEqual(afterDrop, {}, 'the database must genuinely be empty');
    assert.equal(await Order.countDocuments(), 0, 'the orders really are gone');

    // ── RESTORE ──────────────────────────────────────────────────────────────
    const result = await restoreBackup({backupPath, uri, drop: true, log: () => {}});
    assert.equal(result.verifiedBackup, true);
    assert.equal(result.database, 'mittho_dr_test');

    // ── VERIFY ───────────────────────────────────────────────────────────────
    const after = await snapshotCounts();
    assert.deepEqual(after, before_, 'every collection must return with its full document count');

    const orderAfter = await Order.findOne({orderNo: 'DR-ORD-0007'}).lean();
    assert.ok(orderAfter, 'the sampled order came back');
    assert.equal(orderAfter.total, orderBefore.total);
    assert.equal(String(orderAfter._id), String(orderBefore._id), '_id must be preserved');
    assert.equal(String(orderAfter.customer), String(orderBefore.customer), 'references must survive');
    assert.equal(orderAfter.items[0].name, orderBefore.items[0].name);

    const customerAfter = await Customer.findOne({name: 'DR Customer 11'}).lean();
    assert.equal(customerAfter.phoneKey, customerBefore.phoneKey);

    // Indexes are not documents; a restore that returns rows but not indexes
    // leaves a database that works and then collapses under load.
    const indexesAfter = (await mongoose.connection.db.collection('orders').indexes())
      .map(index => index.name).sort();
    assert.deepEqual(indexesAfter, indexesBefore, 'indexes must be restored too');

    // Unique constraints must still bite after the restore.
    await assert.rejects(
      () => Customer.create({
        restaurant: seeded.restaurant._id, branch: seeded.branch._id,
        name: 'Clash', phone: customerBefore.phone, phoneKey: customerBefore.phoneKey
      }),
      /duplicate key|E11000/i,
      'the unique phone index must be enforced after restore'
    );
  });

  it('reports how many documents it actually restored', async () => {
    /**
     * DEFECT FOUND IN THE PHASE 30 AUDIT, and the assertion that would have
     * caught it.
     *
     * `mongorestore` EXITS 0 even when it restores nothing. Against the
     * containerised MongoDB (tools 100.18.0) the old `--nsFrom/--nsTo` +
     * database-level `--dir` combination made it skip every file, print
     * "0 document(s) restored successfully", and exit 0 — after `--drop` had
     * emptied the target. The same arguments restored correctly on 100.9.4,
     * which is the version this suite runs against, so a green suite hid a
     * broken production restore.
     *
     * Exit status is therefore no longer treated as proof. This asserts the
     * COUNT, which is version-independent.
     */
    const {path: backupPath} = await createBackup({uri, outDir: backupDir, log: () => {}});
    await mongoose.connection.db.dropDatabase();

    const result = await restoreBackup({backupPath, uri, drop: true, log: () => {}});
    assert.ok(
      result.restoredDocuments > 0,
      `restore reported ${result.restoredDocuments} documents — a silent empty restore`
    );
    // Sanity: the number must match what is actually in the database.
    const counts = await snapshotCounts();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    assert.equal(result.restoredDocuments, total,
      'the reported count must match the documents present');
    assert.ok(total >= 300, `expected a substantial restore, got ${total}`);
  });

  it('restores an intact audit hash chain', async () => {
    /**
     * Document counts prove quantity; the hash chain proves CONTENT. Each
     * audit row hashes its own fields plus the previous row's hash, so if the
     * restore altered a single byte anywhere in the chain, verification breaks
     * from that point on.
     */
    const {Audit} = await import('../src/models/index.js');
    const {verifyAuditChain} = await import('../src/services/auditTrail.js');

    const rows = await Audit.find({}).sort({sequence: 1}).lean();
    assert.ok(rows.length >= 12, `expected a chain to verify, found ${rows.length}`);
    for (const row of rows) {
      assert.ok(row.hash, 'every restored audit row kept its hash');
      assert.ok(Number.isInteger(row.sequence), 'sequence survived');
    }

    const result = await verifyAuditChain({
      user: {id: String(seeded.owner._id), role: 'owner'}
    });
    // The service reports `verified`, not `ok`.
    assert.equal(result.verified, true,
      `audit chain broken after restore: ${JSON.stringify(result.problems)}`);
    assert.equal(result.problemCount, 0);
    assert.ok(result.checked >= 12, `expected the whole chain to be checked, got ${result.checked}`);
    assert.ok(result.head?.hash, 'the chain head survived the restore');
  });

  it('verifies a restore against expected counts and reports mismatches', async () => {
    const good = await verifyRestore({uri, expected: {orders: before_.orders}});
    assert.equal(good.ok, true, JSON.stringify(good.problems));
    assert.ok(good.counts.orders > 0);
    assert.ok(good.indexes.orders.includes('_id_'));

    // The checker must actually fail when the numbers disagree — otherwise
    // "restore verified" means nothing.
    const bad = await verifyRestore({uri, expected: {orders: before_.orders + 1}});
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], /expected/);

    const absent = await verifyRestore({uri, expected: {no_such_collection: 1}});
    assert.equal(absent.ok, false);
    assert.match(absent.problems[0], /missing after restore/);
  });

  it('DROPS before restoring, so a restore is not a merge', async () => {
    /**
     * Mutation testing caught this gap: removing `--drop` survived every test.
     * Without it `mongorestore` MERGES into whatever is present, so restoring
     * a backup over a partially-recovered database silently mixes two
     * datasets — old rows that were deleted after the backup come back, and
     * nobody notices until the accounts disagree.
     *
     * Proven by writing a row that does NOT exist in the backup and checking
     * the restore removes it.
     */
    const {path: backupPath} = await createBackup({uri, outDir: backupDir, log: () => {}});

    const ghost = await Order.create({
      orderNo: 'DR-GHOST-0001', branch: seeded.branch._id, type: 'counter', status: 'completed',
      items: [{menuItem: seeded.menu[0]._id, name: 'Ghost', qty: 1, unitPrice: 1}],
      subtotal: 1, vatRate: 13, vat: 0.13, total: 1.13, paidAmount: 1.13, dueAmount: 0,
      createdBy: seeded.owner._id
    });
    assert.ok(await Order.findById(ghost._id).lean(), 'the ghost exists before the restore');

    await restoreBackup({backupPath, uri, drop: true, log: () => {}});

    assert.equal(await Order.findById(ghost._id).lean(), null,
      'a row absent from the backup must not survive a --drop restore');
    assert.equal(await Order.countDocuments(), before_.orders, 'the count matches the backup exactly');

    // CONTROL: without --drop the same call leaves the extra row in place,
    // which is precisely why --drop must be deliberate rather than assumed.
    const ghost2 = await Order.create({
      orderNo: 'DR-GHOST-0002', branch: seeded.branch._id, type: 'counter', status: 'completed',
      items: [{menuItem: seeded.menu[0]._id, name: 'Ghost2', qty: 1, unitPrice: 1}],
      subtotal: 1, vatRate: 13, vat: 0.13, total: 1.13, paidAmount: 1.13, dueAmount: 0,
      createdBy: seeded.owner._id
    });
    await restoreBackup({backupPath, uri, drop: false, log: () => {}});
    assert.ok(await Order.findById(ghost2._id).lean(),
      'without --drop the restore merges, leaving the extra row');

    // Put the database back for the tests that follow.
    await restoreBackup({backupPath, uri, drop: true, log: () => {}});
    assert.equal(await Order.countDocuments(), before_.orders);
  });

  it('captures a replayable oplog in the backup', async () => {
    /**
     * `--oplog` is what makes the dump point-in-time consistent ACROSS
     * collections rather than a per-collection smear. That matters here
     * because an order, its payment and its inventory ledger rows are written
     * in one transaction — a backup that caught the payment but not the stock
     * movement would restore a database that does not balance.
     *
     * Mutation testing caught that dropping the flag survived: the manifest
     * assertion alone did not check the file was actually produced.
     */
    const {path: backupPath, manifest} = await createBackup({uri, outDir: backupDir, log: () => {}});
    assert.equal(manifest.oplog, true, 'the manifest records an oplog backup');

    const oplogEntries = Object.keys(manifest.checksums).filter(name => name.startsWith('oplog.bson'));
    assert.ok(oplogEntries.length > 0, 'oplog.bson must be present in the dump and the manifest');

    const {oplogFile} = await resolveDumpSource(backupPath, {preferDatabase: manifest.database});
    assert.equal(oplogFile, true, 'the restore path can see the oplog file');

    const stat = await fs.stat(path.join(backupPath, 'dump', 'oplog.bson'));
    assert.ok(stat.size > 0, 'the captured oplog is not empty');
  });

  it('refuses to record a backup that produced no files', async () => {
    /**
     * Mutation testing caught that the empty-dump guard was untested. An empty
     * dump that gets a manifest is the worst possible artefact: it VERIFIES
     * cleanly (nothing to check), counts toward retention, and restores
     * nothing.
     */
    await assert.rejects(
      () => createBackup({
        // A database that does not exist produces an empty dump.
        uri: replset.getUri('database_that_does_not_exist'),
        outDir: path.join(workDir, 'empty-backups'),
        oplog: false,
        log: () => {}
      }),
      /produced no files|refusing to record an empty backup/
    );
    // ...and nothing was left behind for a later restore to pick up.
    const leftovers = await fs.readdir(path.join(workDir, 'empty-backups')).catch(() => []);
    assert.deepEqual(leftovers, [], 'a failed backup must not leave a directory behind');
  });

  it('restores into a DIFFERENT database, so a drill cannot touch production', async () => {
    /**
     * The safe way to rehearse recovery: restore the production dump into a
     * scratch database and inspect it, leaving the live one untouched. This is
     * the procedure the runbook tells operators to use.
     */
    const liveOrdersAtBackup = await Order.countDocuments();
    const {path: backupPath} = await createBackup({uri, outDir: backupDir, log: () => {}});
    const drillUri = replset.getUri('mittho_dr_drill');

    await restoreBackup({backupPath, uri: drillUri, drop: true, targetDatabase: 'mittho_dr_drill', log: () => {}});

    /**
     * Compared against the LIVE count taken just before the backup, not
     * against the block-level `before_` snapshot: earlier tests in this block
     * legitimately add orders, so a fixed number would make this test depend
     * on execution order rather than on the restore working.
     */
    const drill = await verifyRestore({uri: drillUri});
    assert.ok(drill.counts.orders > 0, 'the drill copy has the data');
    assert.equal(drill.counts.orders, liveOrdersAtBackup,
      'the drill copy matches the source at backup time');

    // ...and the source database is untouched by the drill.
    const live = await verifyRestore({uri});
    assert.equal(live.counts.orders, liveOrdersAtBackup);
  });
});

// ── retention ────────────────────────────────────────────────────────────────

describe('Phase 27 · retention', () => {
  let retentionDir;

  beforeEach(async () => {
    retentionDir = await fs.mkdtemp(path.join(workDir, 'retention-'));
  });

  /** A backup-shaped directory with a valid manifest, aged as requested. */
  async function fakeBackup(name, ageDays, {healthy = true} = {}) {
    const root = path.join(retentionDir, name);
    const dumpDir = path.join(root, 'dump', 'db');
    await fs.mkdir(dumpDir, {recursive: true});
    const file = path.join(dumpDir, 'orders.bson.gz');
    await fs.writeFile(file, 'payload');
    const {createHash} = await import('node:crypto');
    const digest = createHash('sha256').update('payload').digest('hex');
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      name, database: 'db', tool: 'mongodump', gzip: true, oplog: true,
      createdAt: new Date(Date.now() - ageDays * 86400000).toISOString(),
      fileCount: 1, bytes: 7,
      // A "corrupt" copy gets a wrong digest, which is exactly what a bit-rot
      // or truncated upload looks like.
      checksums: {'db/orders.bson.gz': healthy ? digest : 'deadbeef'}
    }, null, 2));
    return root;
  }

  it('deletes backups past the retention window', async () => {
    await fakeBackup('mittho-old-1', 40);
    await fakeBackup('mittho-old-2', 30);
    await fakeBackup('mittho-recent-1', 2);
    await fakeBackup('mittho-recent-2', 1);
    await fakeBackup('mittho-recent-3', 0);
    await fakeBackup('mittho-recent-4', 0);

    const result = await applyRetention({outDir: retentionDir, keepDays: 14, keepMinimum: 3, log: () => {}});
    assert.deepEqual(result.deleted.sort(), ['mittho-old-1', 'mittho-old-2']);
    assert.equal(result.kept.length, 4);
    assert.equal(await fs.readdir(retentionDir).then(rows => rows.length), 4);
  });

  it('never sweeps away the last few backups, however old', async () => {
    /**
     * A stopped backup job plus a retention sweep is how an organisation
     * discovers it has no backups at all. Age alone must never be able to
     * empty the store.
     */
    await fakeBackup('mittho-ancient-1', 400);
    await fakeBackup('mittho-ancient-2', 380);
    await fakeBackup('mittho-ancient-3', 360);

    const result = await applyRetention({outDir: retentionDir, keepDays: 14, keepMinimum: 3, log: () => {}});
    assert.deepEqual(result.deleted, [], 'the floor must hold');
    assert.equal(result.kept.length, 3);
  });

  it('does not count a corrupt backup toward the minimum it protects', async () => {
    /**
     * The subtle failure: three corrupt copies "satisfy" a minimum of three,
     * so the sweep deletes the one good older copy and leaves nothing
     * restorable. Only verified backups count.
     */
    await fakeBackup('mittho-broken-1', 40, {healthy: false});
    await fakeBackup('mittho-broken-2', 39, {healthy: false});
    await fakeBackup('mittho-broken-3', 38, {healthy: false});
    await fakeBackup('mittho-good-old', 37, {healthy: true});

    const result = await applyRetention({outDir: retentionDir, keepDays: 14, keepMinimum: 3, log: () => {}});
    assert.equal(result.healthy, 1);
    assert.equal(result.unhealthy, 3);
    assert.ok(result.kept.includes('mittho-good-old'), 'the only restorable copy must survive');
    assert.ok(!result.deleted.includes('mittho-good-old'));
  });

  it('lists backups newest first with their health', async () => {
    await fakeBackup('mittho-a', 3);
    await fakeBackup('mittho-b', 1);
    await fakeBackup('mittho-c', 2, {healthy: false});

    const rows = await listBackups({outDir: retentionDir});
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, 'mittho-b', 'newest first');
    assert.equal(rows.find(row => row.name === 'mittho-c').ok, false);
    assert.equal(rows.find(row => row.name === 'mittho-a').ok, true);
  });

  it('has a sane default window', () => {
    assert.ok(DEFAULT_KEEP_DAYS >= 7, 'a week is the minimum useful history');
  });
});
