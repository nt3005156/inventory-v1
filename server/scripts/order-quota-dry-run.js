#!/usr/bin/env node
/**
 * P2G.5 — monthly order quota DRY RUN.
 *
 * Answers one question and mutates nothing:
 *
 *     "Who would be affected if maxMonthlyOrders enforcement were switched on
 *      right now?"
 *
 * This exists because enforcement without it is reckless. `maxMonthlyOrders`
 * has never been enforced, so tenants have been free to sail past their
 * configured ceiling. Enabling enforcement blind would fail the next order for
 * every one of them, at the till, mid-service, with no warning to anybody.
 *
 * The intended sequence is:
 *
 *     deploy (BILLING_ENFORCEMENT unchanged)
 *          -> run this dry run
 *          -> raise plans / talk to the OVER tenants
 *          -> only then enable enforcement
 *
 * READ-ONLY BY CONSTRUCTION. It opens the connection, issues counts, prints,
 * and disconnects. It writes no counter documents, creates no reservations and
 * touches no tenant state — asserted by a test that snapshots the
 * `ResourceCounter` collection either side of a run.
 *
 * Usage:
 *   node scripts/order-quota-dry-run.js
 *   node scripts/order-quota-dry-run.js --json
 *   node scripts/order-quota-dry-run.js --only-affected
 *
 * Exit codes:
 *   0  nobody would be blocked
 *   1  at least one tenant is AT or OVER their limit
 *   2  the run itself failed
 */
import mongoose from 'mongoose';
import 'dotenv/config';
import {Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {classifyUsage} from '../src/services/orderQuota.js';
import {getOrderUsage, monthKey, normalizeTimezone} from '../src/services/usage.js';

/**
 * Build the report.
 *
 * Exported and separated from printing so the tests can assert the DATA
 * without parsing a table, and so a future admin endpoint can reuse it.
 */
export async function buildOrderQuotaReport({now = new Date()} = {}) {
  const restaurants = await Restaurant.find({})
    .select('name timezone status').sort({name: 1}).lean();

  const rows = [];
  for (const restaurant of restaurants) {
    const timezone = normalizeTimezone(restaurant.timezone);

    /**
     * The limit is read from the tenant's own plan rather than from
     * `getLimit()`, deliberately: `getLimit` consults the cached entitlement,
     * and a dry run should report what is CONFIGURED rather than whatever a
     * 30-second cache happens to hold.
     */
    const subscription = await Subscription.findOne({restaurant: restaurant._id}).lean();
    const plan = subscription ? await Plan.findById(subscription.plan).lean() : null;
    const limit = plan?.limits?.maxMonthlyOrders ?? null;

    const usage = await getOrderUsage(restaurant._id, {now, timezone});

    rows.push({
      restaurantId: String(restaurant._id),
      name: restaurant.name,
      timezone,
      month: monthKey(now, timezone),
      tenantStatus: restaurant.status || null,
      planCode: plan?.code || null,
      subscriptionStatus: subscription?.status || null,
      usage,
      limit,
      status: subscription && plan ? classifyUsage(usage, limit) : 'NO_SUBSCRIPTION'
    });
  }

  const affected = rows.filter(row => row.status === 'OVER' || row.status === 'AT_LIMIT');
  return {
    generatedAt: new Date().toISOString(),
    tenants: rows.length,
    affected: affected.length,
    over: rows.filter(row => row.status === 'OVER').length,
    atLimit: rows.filter(row => row.status === 'AT_LIMIT').length,
    rows
  };
}

function render(report, {onlyAffected = false} = {}) {
  const rows = onlyAffected
    ? report.rows.filter(row => row.status === 'OVER' || row.status === 'AT_LIMIT')
    : report.rows;

  const widths = {
    name: Math.max(10, ...rows.map(row => row.name.length)),
    zone: Math.max(8, ...rows.map(row => row.timezone.length))
  };

  const header = 'Restaurant'.padEnd(widths.name)
    + '  ' + 'Timezone'.padEnd(widths.zone)
    + '  ' + 'Month'.padEnd(7)
    + '  ' + 'Usage'.padStart(7)
    + '  ' + 'Limit'.padStart(7)
    + '  Status';
  const lines = ['', header, '-'.repeat(header.length)];

  for (const row of rows) {
    lines.push(
      row.name.padEnd(widths.name)
      + '  ' + row.timezone.padEnd(widths.zone)
      + '  ' + row.month.padEnd(7)
      + '  ' + String(row.usage).padStart(7)
      + '  ' + String(row.limit ?? 'unlimited').padStart(7)
      + '  ' + row.status
    );
  }

  lines.push('');
  lines.push(
    `${report.tenants} tenant(s) · ${report.over} OVER · ${report.atLimit} AT LIMIT`
  );
  if (report.affected) {
    lines.push('');
    lines.push('Enabling enforcement now WOULD refuse the next order for the tenants');
    lines.push('listed as OVER or AT LIMIT. Raise their plans first.');
  } else {
    lines.push('No tenant would be blocked by enabling enforcement.');
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mittho_ops';
  await mongoose.connect(uri);
  try {
    const report = await buildOrderQuotaReport();
    if (args.has('--json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(render(report, {onlyAffected: args.has('--only-affected')}));
    }
    return report.affected ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
}

// Only run when invoked directly, so importing the builder in tests is safe.
if (process.argv[1] && process.argv[1].endsWith('order-quota-dry-run.js')) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      console.error('Dry run failed:', error?.message || error);
      process.exit(2);
    });
}
