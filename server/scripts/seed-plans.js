#!/usr/bin/env node
/**
 * P2C — plan catalogue seed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHERE THE COMMERCIAL VALUES LIVE — READ THIS BEFORE CHANGING PRICES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The numbers in this file are DEVELOPMENT AND DEMO VALUES. Nobody has given
 * us approved commercial pricing or approved limits, and inventing them
 * silently in source would bake a guess into the product.
 *
 * They are deliberately structured so the real values can be set WITHOUT a
 * code change, in either of two ways:
 *
 *   1. Platform UI / API — `PATCH /api/platform/plans/:id` with
 *      `platform.billing.manage`. Every edit is audited. This is the intended
 *      route for a live platform.
 *
 *   2. Re-running this script with `--force`, which UPDATES existing plans in
 *      place. Useful for a fresh environment; it does not delete or reassign
 *      anybody's subscription.
 *
 * The limit STRUCTURE (which keys exist) is in `models/billing.js`
 * `LIMIT_KEYS`. The limit VALUES are data, and live only in Plan documents.
 *
 * PRICES ARE INTEGER MINOR UNITS — paisa for NPR. 850000 is Rs 8,500.00.
 * There is no float arithmetic anywhere in the billing path.
 *
 * The starting point for these figures is the stated commercial target of
 * roughly NPR 1 crore/year across ~100 restaurants, which is about NPR 8,300
 * per restaurant per month. `professional` is therefore set near that figure
 * as the expected middle tier, with starter below and enterprise above. That
 * is a MODELLING ASSUMPTION for development, not an approved price list.
 *
 * Unlimited is `null`, never -1 or a large number — see models/billing.js.
 *
 * USAGE
 *   node scripts/seed-plans.js            create missing plans, leave existing
 *   node scripts/seed-plans.js --force    also update existing plans in place
 *   node scripts/seed-plans.js --dry-run  report only
 */
import 'dotenv/config';
import {resolveCliMongoUri} from '../src/services/cliDatabase.js';
import mongoose from 'mongoose';
import {Plan} from '../src/models/billing.js';

export const DEMO_PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'A single branch getting started: POS, inventory and the kitchen display.',
    displayOrder: 1,
    monthlyPrice: 350000,   // NPR 3,500.00
    annualPrice: 3500000,   // NPR 35,000.00 — two months free
    currency: 'NPR',
    trialDays: 14,
    limits: {
      maxBranches: 1,
      maxUsers: 8,
      maxManagers: 2,
      maxStaff: 5,
      maxRiders: 2,
      maxMenuItems: 120,
      maxCustomers: 2000,
      maxTables: 20,
      maxStations: 2,
      maxMonthlyOrders: 3000,
      maxMonthlyOnlineOrders: 300
    },
    features: {
      pos: true, inventory: true, kds: true, tables: true,
      purchasing: false, delivery: false, onlineOrdering: false, reservations: false,
      advancedReports: false, loyalty: false, supplierPerformance: false,
      reorderAutomation: false, multiBranch: false, advancedAccounting: false, apiAccess: false,
      // Core branding (name, logo, colours, contact, receipt footer) needs no
      // entitlement at all — every tenant gets it. These gate the tiers above.
      advancedBranding: false, whiteLabel: false, customDomain: false
    }
  },
  {
    code: 'professional',
    name: 'Professional',
    description: 'Multi-branch operations with purchasing, delivery and online ordering.',
    displayOrder: 2,
    monthlyPrice: 830000,   // NPR 8,300.00 — the ~1 crore/year modelling figure
    annualPrice: 8300000,
    currency: 'NPR',
    trialDays: 14,
    limits: {
      maxBranches: 5,
      maxUsers: 40,
      maxManagers: 10,
      maxStaff: 25,
      maxRiders: 10,
      maxMenuItems: 600,
      maxCustomers: 25000,
      maxTables: 120,
      maxStations: 8,
      maxMonthlyOrders: 25000,
      maxMonthlyOnlineOrders: 5000
    },
    features: {
      pos: true, inventory: true, kds: true, tables: true,
      purchasing: true, delivery: true, onlineOrdering: true, reservations: true,
      advancedReports: true, supplierPerformance: true, reorderAutomation: true,
      multiBranch: true,
      advancedBranding: true,
      loyalty: false, advancedAccounting: false, apiAccess: false,
      whiteLabel: false, customDomain: false
    }
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Unlimited scale, full accounting, loyalty and API access.',
    displayOrder: 3,
    monthlyPrice: 2000000,  // NPR 20,000.00
    annualPrice: 20000000,
    currency: 'NPR',
    trialDays: 30,
    limits: {
      // `null` is UNLIMITED, explicitly. Not -1, not 999999.
      maxBranches: null,
      maxUsers: null,
      maxManagers: null,
      maxStaff: null,
      maxRiders: null,
      maxMenuItems: null,
      maxCustomers: null,
      maxTables: null,
      maxStations: null,
      maxMonthlyOrders: null,
      maxMonthlyOnlineOrders: null
    },
    features: Object.fromEntries([
      'pos', 'inventory', 'purchasing', 'kds', 'tables', 'delivery', 'onlineOrdering',
      'reservations', 'advancedReports', 'loyalty', 'supplierPerformance',
      'reorderAutomation', 'multiBranch', 'advancedAccounting', 'apiAccess',
      'advancedBranding', 'whiteLabel', 'customDomain'
    ].map(key => [key, true]))
  }
];

/**
 * Idempotent. Creates plans that are missing; leaves existing ones alone unless
 * `force`, which updates them in place. Never deletes a plan and never touches
 * a subscription — a plan somebody is paying for must not vanish.
 */
export async function seedPlans({force = false, dryRun = false} = {}) {
  const report = {created: [], updated: [], unchanged: [], dryRun};

  for (const definition of DEMO_PLANS) {
    const existing = await Plan.findOne({code: definition.code});

    if (!existing) {
      if (!dryRun) await Plan.create({...definition, active: true});
      report.created.push(definition.code);
      continue;
    }
    if (!force) {
      report.unchanged.push(definition.code);
      continue;
    }
    if (!dryRun) {
      Object.assign(existing, definition);
      // Mixed paths need an explicit dirty flag or Mongoose will not persist.
      existing.markModified('limits');
      existing.markModified('features');
      await existing.save();
    }
    report.updated.push(definition.code);
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const uri = resolveCliMongoUri();

  await mongoose.connect(uri);
  try {
    const report = await seedPlans({force, dryRun});
    console.log(`\n${dryRun ? 'DRY RUN — nothing written' : 'Plan seed complete'}`);
    console.log(`  created    ${report.created.join(', ') || '(none)'}`);
    console.log(`  updated    ${report.updated.join(', ') || '(none)'}`);
    console.log(`  unchanged  ${report.unchanged.join(', ') || '(none)'}`);
    if (report.unchanged.length && !force) {
      console.log('\n  Existing plans were left alone. Re-run with --force to update them,');
      console.log('  or edit them through the platform UI so the change is audited.\n');
    } else {
      console.log('');
    }
  } finally {
    await mongoose.disconnect();
  }
}
