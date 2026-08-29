#!/usr/bin/env node
// Controlled migration: backfill completedAt for historical orders that were
// completed before the payment/delivery paths stamped it.
//
// Usage:
//   node scripts/backfill-completed-at.js            # dry run (default)
//   node scripts/backfill-completed-at.js --apply    # write changes
//
// Safe to re-run: existing completedAt values are never overwritten, and
// orders with no audit evidence are left null rather than given a guess.
import 'dotenv/config';
import {resolveCliMongoUri} from '../src/services/cliDatabase.js';
import mongoose from 'mongoose';
import {backfillCompletedAt} from '../src/services/completedAtBackfill.js';

const apply = process.argv.includes('--apply');
const uri = resolveCliMongoUri();
if (!uri) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}
await mongoose.connect(uri);
const result = await backfillCompletedAt({dryRun: !apply});
console.log(JSON.stringify(result, null, 2));
console.log(apply ? 'Backfill applied.' : 'Dry run only — re-run with --apply to write.');
await mongoose.disconnect();
