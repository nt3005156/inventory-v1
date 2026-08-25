#!/usr/bin/env node
/**
 * P2D.1 — audit-chain verification. READ ONLY.
 *
 * WHY A CLI TOOL AND NOT AN HTTP ENDPOINT
 * ---------------------------------------
 * This walks EVERY tenant's chain. Exposing that over HTTP would create a
 * cross-tenant surface whose only protection is a permission check, for a job
 * that is run by an operator during an investigation — not by an application.
 * `verifyAuditChain()` already serves the per-tenant, owner-scoped HTTP case.
 * Keeping the cross-tenant view behind shell access means the blast radius of
 * a permission mistake is zero.
 *
 * IT NEVER WRITES. No model is imported that could mutate; every query is
 * `.lean()`. The audit schema also refuses updates and deletes outright, so a
 * bug here still could not rewrite history.
 *
 * EXIT CODES
 *   0  integrity intact (legacy-canonicalisation rows do not fail the run)
 *   1  a real integrity problem: content mismatch, broken link, bad sequence
 *   2  the tool itself could not run
 *
 * USAGE
 *   npm run audit:verify
 *   npm run audit:verify -- --json
 *   npm run audit:verify -- --restaurant <id>
 *   npm run audit:verify -- --limit 100000
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import {Audit} from '../src/models/index.js';
import {classifyAuditRow} from '../src/services/auditTrail.js';
import {AUDIT_HASH_VERSION} from '../src/services/auditCanonical.js';
import {Restaurant} from '../src/models/operations.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const restaurantArg = (args.find(a => a.startsWith('--restaurant=')) || '').split('=')[1]
  || (args.includes('--restaurant') ? args[args.indexOf('--restaurant') + 1] : null);
const limitArg = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]
  || (args.includes('--limit') ? args[args.indexOf('--limit') + 1] : 0)) || 200000;

function usage() {
  console.error(`
Verify the audit hash chain. Read-only; never writes.

  node scripts/verify-audit-chain.js [--json] [--restaurant <id>] [--limit N]

  --json         machine-readable output
  --restaurant   verify one tenant's chain only
  --limit        maximum rows to read (default 200000)

Exit 0 = intact, 1 = integrity problem, 2 = tool failure.
`);
}

if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }

/**
 * Verify one chain — the rows sharing a `restaurant` scope.
 *
 * Chains are per restaurant (plus a global chain for untenanted rows), which
 * is how they are written, so they must be verified the same way. Verifying
 * all rows as one sequence would report a break at every tenant boundary.
 */
function verifyChain(rows) {
  const problems = [];
  const counts = {
    rows: rows.length, valid: 0, legacy: 0, content: 0, malformed: 0, link: 0, sequence: 0
  };
  let previous = null;

  for (const row of rows) {
    const problem = classifyAuditRow(row);
    if (!problem) {
      counts.valid += 1;
    } else {
      if (problem.type === 'legacy_canonicalisation'
        || problem.type === 'legacy_unverifiable') counts.legacy += 1;
      else if (problem.type === 'malformed') counts.malformed += 1;
      else counts.content += 1;
      problems.push({
        ...problem,
        id: String(row._id),
        action: row.action || null,
        at: row.at || null,
        hashVersion: row.hashVersion ?? 1
      });
    }

    if (previous) {
      if (Number(row.sequence) !== Number(previous.sequence) + 1) {
        counts.sequence += 1;
        problems.push({
          type: 'sequence', id: String(row._id), sequence: row.sequence,
          action: row.action || null,
          detail: `expected ${Number(previous.sequence) + 1}, found ${row.sequence}`
        });
      }
      if (row.prevHash !== previous.hash) {
        counts.link += 1;
        problems.push({
          type: 'link', id: String(row._id), sequence: row.sequence,
          action: row.action || null,
          detail: `prevHash does not match the hash of sequence ${previous.sequence}`
        });
      }
    }
    previous = row;
  }

  return {counts, problems, head: previous
    ? {sequence: previous.sequence, hash: previous.hash} : null};
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL
    || 'mongodb://127.0.0.1:27017/mittho';
  await mongoose.connect(uri);

  const filter = {};
  if (restaurantArg) {
    if (!mongoose.isValidObjectId(restaurantArg)) {
      console.error(`Not a valid restaurant id: ${restaurantArg}`);
      process.exit(2);
    }
    filter.restaurant = new mongoose.Types.ObjectId(String(restaurantArg));
  }

  // Sorted by scope then sequence, so each chain is walked in write order.
  const rows = await Audit.find(filter)
    .sort({restaurant: 1, sequence: 1, _id: 1})
    .limit(limitArg)
    .lean();

  // Group by chain scope. Untenanted rows form the 'global' chain.
  const chains = new Map();
  for (const row of rows) {
    const key = row.restaurant ? String(row.restaurant) : 'global';
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(row);
  }

  const restaurantIds = [...chains.keys()].filter(k => k !== 'global');
  const names = new Map();
  if (restaurantIds.length) {
    for (const r of await Restaurant.find({_id: {$in: restaurantIds}}).select('name').lean()) {
      names.set(String(r._id), r.name);
    }
  }

  const report = {
    hashVersion: AUDIT_HASH_VERSION,
    scannedAt: new Date().toISOString(),
    totalRows: rows.length,
    chains: [],
    totals: {valid: 0, legacy: 0, content: 0, malformed: 0, link: 0, sequence: 0},
    // Filled in below.
    integrityOk: true,
    guarantee: 'Detects tampering. Prevention of direct database writes requires '
      + 'an append-only store or off-host log shipping.'
  };

  for (const [key, chainRows] of chains) {
    const result = verifyChain(chainRows);
    for (const field of Object.keys(report.totals)) {
      report.totals[field] += result.counts[field] || 0;
    }
    report.chains.push({
      scope: key,
      restaurant: key === 'global' ? null : {id: key, name: names.get(key) || null},
      counts: result.counts,
      head: result.head,
      // Capped so a badly broken database cannot produce gigabytes of JSON.
      problems: result.problems.slice(0, 200),
      problemCount: result.problems.length
    });
  }

  /**
   * Legacy-canonicalisation rows are intact and deliberately do NOT fail the
   * run. Every deployment with pre-P2D.1 history has them, and failing on them
   * would make the exit code permanently red — which trains operators to stop
   * looking at it, destroying the value of the check.
   */
  const real = report.totals.content + report.totals.malformed
    + report.totals.link + report.totals.sequence;
  report.integrityOk = real === 0;
  report.realProblemCount = real;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nAudit chain verification (canonicalisation v${AUDIT_HASH_VERSION})`);
    console.log(`  scanned              ${report.totalRows} rows in ${report.chains.length} chain(s)\n`);
    console.log(`  valid                ${report.totals.valid}`);
    console.log(`  legacy (v1, intact)  ${report.totals.legacy}`);
    console.log(`  content mismatch     ${report.totals.content}`);
    console.log(`  malformed            ${report.totals.malformed}`);
    console.log(`  broken links         ${report.totals.link}`);
    console.log(`  sequence gaps        ${report.totals.sequence}`);

    for (const chain of report.chains) {
      if (!chain.problemCount) continue;
      const label = chain.restaurant
        ? `${chain.restaurant.name || 'unnamed'} (${chain.restaurant.id})`
        : 'global (untenanted rows)';
      console.log(`\n  ${label}`);
      for (const p of chain.problems.slice(0, 10)) {
        console.log(`    seq ${String(p.sequence).padEnd(6)} ${p.type.padEnd(24)} ${p.action || ''}`);
        if (p.detail) console.log(`      ${p.detail}`);
      }
      if (chain.problemCount > 10) {
        console.log(`    …and ${chain.problemCount - 10} more`);
      }
    }

    if (report.totals.legacy) {
      console.log(`\n  NOTE: ${report.totals.legacy} row(s) use canonicalisation v1.`);
      console.log('  These are INTACT, not tampered. They predate the P2D.1 fix and cannot');
      console.log('  be re-hashed: MongoDB discarded the undefined keys, so the original');
      console.log('  payload is unrecoverable. See P2D.1-AUDIT.md.');
    }

    console.log(report.integrityOk
      ? '\n  INTEGRITY OK\n'
      : `\n  INTEGRITY FAILED — ${real} real problem(s)\n`);
  }

  return report.integrityOk ? 0 : 1;
}

main()
  .then(async code => { await mongoose.disconnect(); process.exit(code); })
  .catch(async error => {
    console.error('\nVerification could not run:', error?.message || error, '\n');
    try { await mongoose.disconnect(); } catch { /* already down */ }
    process.exit(2);
  });
