#!/usr/bin/env node
/**
 * P2G.5 — monthly order quota DRY RUN.
 * P2G.9 — extended to cover the ONLINE sub-allowance as well.
 *
 * Answers one question and mutates nothing:
 *
 *     "Who would be affected if monthly order enforcement were switched on
 *      right now?"
 *
 * BOTH ceilings are reported, because P2G.7 shipped `maxMonthlyOnlineOrders`
 * as a second, independently enforceable limit and an operator had no way to
 * see who was over it. A tenant can be comfortably inside their overall
 * allowance and still have an exhausted storefront.
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
 *   1  at least one tenant is AT or OVER EITHER ceiling
 *   2  the run itself failed
 */
import mongoose from 'mongoose';
import {resolveCliMongoUri} from '../src/services/cliDatabase.js';
import 'dotenv/config';
import {Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {classifyUsage} from '../src/services/orderQuota.js';
import {
  getOnlineOrderUsage, getOrderUsage, monthKey, normalizeTimezone
} from '../src/services/usage.js';

/**
 * P2G.9 — the report and enforcement MUST agree on what "affected" means.
 *
 * Shared so a future status cannot be added to one and forgotten in the
 * other, which is exactly how a dry run stops being trustworthy.
 */
const AFFECTED = new Set(['OVER', 'AT_LIMIT']);
const isAffected = row => AFFECTED.has(row.overall.status) || AFFECTED.has(row.online.status);

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
     * The limits are read from the tenant's own plan rather than from
     * `getLimit()`, deliberately: `getLimit` consults the cached entitlement,
     * and a dry run should report what is CONFIGURED rather than whatever a
     * 30-second cache happens to hold.
     */
    const subscription = await Subscription.findOne({restaurant: restaurant._id}).lean();
    const plan = subscription ? await Plan.findById(subscription.plan).lean() : null;
    const overallLimit = plan?.limits?.maxMonthlyOrders ?? null;
    const onlineLimit = plan?.limits?.maxMonthlyOnlineOrders ?? null;

    /**
     * P2G.9 — THE SAME FUNCTIONS ENFORCEMENT USES.
     *
     * `getOrderUsage()` and `getOnlineOrderUsage()` are called directly rather
     * than reimplemented here, so the report cannot drift from the ceiling it
     * predicts. That means the dry run inherits, for free:
     *
     *   • the online discriminator `Order.source === 'online'` — NOT
     *     `Order.type`, whose `['delivery','takeaway']` would wrongly bill a
     *     till takeaway against the storefront allowance;
     *   • tenant-local month boundaries from `Restaurant.timezone`, with no
     *     hardcoded Kathmandu offset;
     *   • the countable-status rule, which excludes `cancelled` and includes
     *     everything else in the enum.
     *
     * A test asserts dry-run usage === enforcement usage on one fixture.
     */
    const overallUsage = await getOrderUsage(restaurant._id, {now, timezone});
    const onlineUsage = await getOnlineOrderUsage(restaurant._id, {now, timezone});

    const subscribed = Boolean(subscription && plan);
    const classify = (usage, limit) =>
      (subscribed ? classifyUsage(usage, limit) : 'NO_SUBSCRIPTION');

    /**
     * Only meaningful once a numeric ceiling has been EXCEEDED.
     *
     * `>` rather than `>=` states the intent — an at-limit tenant has no
     * overage to clear — though the two are indistinguishable in value, since
     * `usage - limit` is 0 at the boundary anyway. A mutant swapping them
     * survives the suite and is genuinely equivalent, not a coverage gap.
     *
     * `typeof limit === 'number'` rather than a truthiness test: `null` means
     * unlimited and `0` is a real ceiling that everything exceeds.
     */
    const overageOf = (usage, limit) =>
      (typeof limit === 'number' && usage > limit ? usage - limit : 0);

    const overall = {
      usage: overallUsage,
      limit: overallLimit,
      overage: overageOf(overallUsage, overallLimit),
      status: classify(overallUsage, overallLimit)
    };
    const online = {
      usage: onlineUsage,
      limit: onlineLimit,
      overage: overageOf(onlineUsage, onlineLimit),
      status: classify(onlineUsage, onlineLimit)
    };

    rows.push({
      restaurantId: String(restaurant._id),
      name: restaurant.name,
      timezone,
      month: monthKey(now, timezone),
      tenantStatus: restaurant.status || null,
      planCode: plan?.code || null,
      planName: plan?.name || null,
      subscriptionStatus: subscription?.status || null,
      overall,
      online,
      /**
       * The pre-P2G.9 flat fields, kept verbatim.
       *
       * `--json` is a machine interface an operator may already be parsing,
       * and the existing P2G.5 tests read them. Renaming them would break both
       * for no benefit; the nested `overall` block carries the same numbers.
       */
      usage: overall.usage,
      limit: overall.limit,
      status: overall.status
    });
  }

  const countBy = (scope, status) => rows.filter(row => row[scope].status === status).length;
  const affected = rows.filter(isAffected);

  return {
    generatedAt: new Date().toISOString(),
    tenants: rows.length,
    /** Tenants affected by EITHER ceiling — what an operator must act on. */
    affected: affected.length,
    /**
     * `over` / `atLimit` remain the OVERALL figures they have always been, so
     * existing callers keep their meaning. The online equivalents are
     * reported alongside rather than folded in.
     */
    over: countBy('overall', 'OVER'),
    atLimit: countBy('overall', 'AT_LIMIT'),
    onlineOver: countBy('online', 'OVER'),
    onlineAtLimit: countBy('online', 'AT_LIMIT'),
    rows
  };
}

export function render(report, {onlyAffected = false} = {}) {
  const rows = onlyAffected ? report.rows.filter(isAffected) : report.rows;

  /**
   * A `usage/limit` cell, with the overage appended when there is one. The
   * overage is the number an operator actually acts on — "raise this plan by
   * at least 4" — so it is shown inline rather than in a column that is empty
   * for most tenants.
   */
  const cell = scope => {
    const limit = scope.limit === null ? '∞' : String(scope.limit);
    const base = `${scope.usage}/${limit}`;
    return scope.overage > 0 ? `${base} (+${scope.overage})` : base;
  };

  const width = (label, pick) => Math.max(label.length, ...rows.map(r => pick(r).length), 1);
  const widths = {
    name: width('Restaurant', r => r.name),
    plan: width('Plan', r => r.planCode || '—'),
    zone: width('Timezone', r => r.timezone),
    all: width('Orders', r => cell(r.overall)),
    web: width('Online', r => cell(r.online))
  };

  const header = 'Restaurant'.padEnd(widths.name)
    + '  ' + 'Plan'.padEnd(widths.plan)
    + '  ' + 'Timezone'.padEnd(widths.zone)
    + '  ' + 'Month'.padEnd(7)
    + '  ' + 'Orders'.padStart(widths.all)
    + '  ' + 'Online'.padStart(widths.web)
    + '  Overall      Online';
  const lines = ['', header, '-'.repeat(header.length)];

  for (const row of rows) {
    lines.push(
      row.name.padEnd(widths.name)
      + '  ' + (row.planCode || '—').padEnd(widths.plan)
      + '  ' + row.timezone.padEnd(widths.zone)
      + '  ' + row.month.padEnd(7)
      + '  ' + cell(row.overall).padStart(widths.all)
      + '  ' + cell(row.online).padStart(widths.web)
      + '  ' + row.overall.status.padEnd(11)
      + '  ' + row.online.status
    );
  }

  lines.push('');
  lines.push(
    `${report.tenants} tenant(s)`
    + ` · overall: ${report.over} OVER, ${report.atLimit} AT LIMIT`
    + ` · online: ${report.onlineOver} OVER, ${report.onlineAtLimit} AT LIMIT`
  );
  if (report.affected) {
    lines.push('');
    lines.push('Enabling enforcement now WOULD refuse the next order for the tenants');
    lines.push('listed as OVER or AT LIMIT. Raise their plans first.');
    lines.push('An online OVER/AT LIMIT blocks storefront orders only; the till');
    lines.push('keeps working unless the OVERALL column is also affected.');
  } else {
    lines.push('No tenant would be blocked by enabling enforcement.');
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const uri = resolveCliMongoUri();
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
