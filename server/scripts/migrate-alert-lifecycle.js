#!/usr/bin/env node
// Phase 16B — alert lifecycle migration runner.
//
// Usage:
//   node scripts/migrate-alert-lifecycle.js              # DRY RUN (default)
//   node scripts/migrate-alert-lifecycle.js --apply      # write changes
//   node scripts/migrate-alert-lifecycle.js --verify     # post-run verification
//
// What it does:
//   * backfills `status` onto legacy notifications (read -> resolved, else open)
//   * retires duplicate OPEN alerts for the same {branch, type, referenceId},
//     keeping the newest and marking the rest resolved (never deleted)
//   * builds the unique partial index that makes duplicate suppression a
//     database guarantee
//
// It is idempotent: a second --apply reports 0 changes. Nothing is deleted.
// See README.md — "Alert lifecycle migration (runbook)".
import 'dotenv/config';
import {resolveCliMongoUri} from '../src/services/cliDatabase.js';
import mongoose from 'mongoose';
import {Notification} from '../src/models/operations.js';
import {ensureAlertIndexes, planAlertMigration} from '../src/services/alertMigration.js';

const apply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify');

const uri = resolveCliMongoUri();
if (!uri) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

async function verify() {
  const collection = mongoose.connection.db.collection(Notification.collection.collectionName);
  const [total, missing, open, acknowledged, resolved] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({status: {$exists: false}}),
    collection.countDocuments({status: 'open'}),
    collection.countDocuments({status: 'acknowledged'}),
    collection.countDocuments({status: 'resolved'})
  ]);
  const duplicates = await collection.aggregate([
    {$match: {status: {$in: ['open', 'acknowledged']}, referenceId: {$type: 'objectId'}, branch: {$type: 'objectId'}}},
    {$group: {_id: {branch: '$branch', type: '$type', referenceId: '$referenceId'}, count: {$sum: 1}}},
    {$match: {count: {$gt: 1}}},
    {$count: 'groups'}
  ]).toArray();
  const indexes = (await collection.indexes()).map(index => index.name);
  return {
    total, missingStatus: missing, open, acknowledged, resolved,
    duplicateGroups: duplicates[0]?.groups || 0,
    uniqueIndexPresent: indexes.includes('alert_open_condition')
  };
}

await mongoose.connect(uri);
try {
  if (verifyOnly) {
    console.log(JSON.stringify(await verify(), null, 2));
    console.log('\nVerification only. Expect missingStatus: 0, duplicateGroups: 0, uniqueIndexPresent: true.');
  } else if (!apply) {
    const plan = await planAlertMigration();
    console.log(JSON.stringify(plan, null, 2));
    console.log('');
    console.log(`Alerts on file      : ${plan.totalAlerts}`);
    console.log(`Missing a status    : ${plan.missingStatus}`);
    console.log(`Already valid       : ${plan.alreadyValid}`);
    console.log(`Would set resolved  : ${plan.backfill.wouldMarkResolved}`);
    console.log(`Would set open      : ${plan.backfill.wouldMarkOpen}`);
    console.log(`Duplicate rows to retire: ${plan.duplicates.retired}`);
    for (const sample of plan.duplicates.samples || []) {
      console.log(`  - ${sample.type} branch ${sample.branch}: ${sample.duplicates} duplicate(s), keeping ${sample.keeping}`);
    }
    console.log('');
    console.log(plan.changesRequired
      ? 'DRY RUN ONLY — review the above, then re-run with --apply.'
      : 'DRY RUN ONLY — nothing needs changing; --apply would be a no-op.');
  } else {
    const before = await verify();
    const result = await ensureAlertIndexes();
    const after = await verify();
    console.log(JSON.stringify({before, result, after}, null, 2));
    console.log('');
    console.log(`Applied. Backfilled ${result.updated}, retired ${result.retired} duplicate(s).`);
    console.log('Re-run without --apply to confirm it now reports zero changes.');
  }
} finally {
  await mongoose.disconnect();
}
