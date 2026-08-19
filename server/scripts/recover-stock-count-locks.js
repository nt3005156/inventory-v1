#!/usr/bin/env node
// Production recovery for stock count sessions wedged holding a branch lock.
//
// Usage:
//   node scripts/recover-stock-count-locks.js --restaurant <id>                 # DRY RUN (default)
//   node scripts/recover-stock-count-locks.js --restaurant <id> --branch <id>   # one branch
//   node scripts/recover-stock-count-locks.js --restaurant <id> --min-age 1440  # older than 24h
//   node scripts/recover-stock-count-locks.js --restaurant <id> --apply --reason "..."
//
// This script NEVER approves a count, NEVER posts stock, NEVER writes an
// inventory balance or ledger row, and NEVER edits a captured physical
// quantity. It only releases a branch lock held by a session that is proven
// unable to reach a decision, and appends an audit row saying so.
//
// See README.md — "Stock count lock recovery (runbook)".
import 'dotenv/config';
import mongoose from 'mongoose';
import {recoverLockedSessions, DEFAULT_MIN_AGE_MINUTES} from '../src/services/stockCountRecovery.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const apply = process.argv.includes('--apply');
const restaurantId = arg('restaurant');
const branchId = arg('branch');
const minAgeMinutes = Number(arg('min-age', DEFAULT_MIN_AGE_MINUTES));
const reason = arg('reason', '');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}
if (!restaurantId) {
  console.error('--restaurant <id> is required, so a run can never span tenants by accident');
  process.exit(1);
}
if (apply && reason.trim().length < 10) {
  console.error('--reason "<why>" (10+ characters) is required with --apply; it is written to the audit trail');
  process.exit(1);
}

await mongoose.connect(uri);
try {
  const result = await recoverLockedSessions({
    restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
    branchId: branchId ? new mongoose.Types.ObjectId(String(branchId)) : null,
    minAgeMinutes,
    apply,
    reason
  });
  console.log(JSON.stringify(result, null, 2));
  console.log('');
  console.log(`Scanned ${result.scanned} locked session(s); ${result.eligible} qualify.`);
  for (const action of result.actions) {
    console.log(` - ${action.countNo} [${action.branchName}] ${action.fromStatus} -> ${action.toStatus}`);
    console.log(`     why: ${action.detail}`);
    console.log(`     ${action.applied ? 'APPLIED' : 'would apply (dry run)'}`);
  }
  for (const skip of result.skipped) {
    console.log(` - ${skip.countNo} SKIPPED (${skip.status}): ${skip.detail}`);
  }
  console.log('');
  console.log(apply
    ? `Applied. ${result.recovered} session(s) recovered. Re-run to confirm it now reports 0.`
    : 'Dry run only — review the output above, then re-run with --apply --reason "<why>".');
} finally {
  await mongoose.disconnect();
}
