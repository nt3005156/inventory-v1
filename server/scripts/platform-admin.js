#!/usr/bin/env node
/**
 * P2B — platform operator bootstrap.
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT
 * ----------------------------------------
 * The chicken-and-egg problem: granting platform authority requires
 * `platform.admins.manage`, which only a `super_admin` holds, and on a fresh
 * deployment nobody holds anything. Something has to create the first one.
 *
 * The tempting answers are all wrong:
 *
 *   "a public /bootstrap route that disables itself after first use" —
 *   the disable condition is "no super admin exists", which becomes true
 *   again after a restore from a backup taken before the first admin, after
 *   a botched migration, or after somebody demotes the last one. A route
 *   that is dormant rather than absent is a route that comes back.
 *
 *   "a route protected by a shared secret in an env var" — that is a
 *   password with no rotation, no audit and no expiry, sitting in a file
 *   that gets copied into CI logs.
 *
 *   "seed it in the seed script" — the demo seed runs in development and
 *   would either mint a real operator in production or be conditionally
 *   skipped, which is the dormant-route problem again.
 *
 * So the first operator is created by somebody with SHELL ACCESS to the
 * server, which is a strictly smaller and already-trusted set of people than
 * "anyone who can reach the HTTP port". After that, `PATCH
 * /api/platform/users/:id/platform-role` handles every subsequent grant, with
 * a rank ceiling, a mandatory reason and an audit row.
 *
 * This script grants authority to an account that ALREADY EXISTS. It does not
 * create logins and never touches a password: keeping credential handling out
 * of the platform authority path means a bug here cannot become a credential
 * bug.
 *
 * USAGE
 *   node scripts/platform-admin.js list
 *   node scripts/platform-admin.js grant <email> [role]     default super_admin
 *   node scripts/platform-admin.js revoke <email>
 *
 * Every mutation writes the same audited row the HTTP endpoint writes, with
 * the actor recorded as the target themselves and the reason naming the
 * script — an out-of-band grant must not be invisible in the audit trail.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import {Audit, User} from '../src/models/index.js';
import {PLATFORM_ROLES, PLATFORM_ROLE_KEYS} from '../src/services/platformAccess.js';
import {installAuditChain} from '../src/services/auditTrail.js';

const MONGO = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mittho';

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error(`
Platform operator administration.

  node scripts/platform-admin.js list
  node scripts/platform-admin.js grant <email> [${PLATFORM_ROLE_KEYS.join('|')}]
  node scripts/platform-admin.js revoke <email>

Roles:
${PLATFORM_ROLE_KEYS.map(key => `  ${key.padEnd(18)} ${PLATFORM_ROLES[key].description}`).join('\n')}

The account must already exist. This script never sets or reads a password.
`);
  process.exit(message ? 1 : 0);
}

async function main() {
  const [command, email, role] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') usage();

  await mongoose.connect(MONGO);
  // Rows written here must join the same hash chain as everything else.
  installAuditChain();

  try {
    if (command === 'list') {
      const rows = await User.find({platformRole: {$nin: [null, '']}})
        .select('name email active +platformRole').sort({createdAt: 1}).lean();
      if (!rows.length) {
        console.log('\nNo platform operators exist.');
        console.log('Create one with:  node scripts/platform-admin.js grant <email> super_admin\n');
        return;
      }
      console.log(`\n${rows.length} platform operator(s):\n`);
      for (const row of rows) {
        const state = row.active === false ? ' [DEACTIVATED — holds no authority]' : '';
        console.log(`  ${String(row.platformRole).padEnd(18)} ${row.email}  (${row.name})${state}`);
      }
      console.log('');
      return;
    }

    if (command !== 'grant' && command !== 'revoke') usage(`Unknown command: ${command}`);
    if (!email) usage('An email address is required.');

    const wanted = command === 'revoke'
      ? null
      : String(role || 'super_admin').trim().toLowerCase();
    if (wanted !== null && !PLATFORM_ROLE_KEYS.includes(wanted)) {
      usage(`Unknown platform role: ${wanted}`);
    }

    const target = await User.findOne({email: String(email).trim().toLowerCase()})
      .select('+platformRole');
    if (!target) {
      console.error(`\nNo account with that email exists. Create the login first, then grant authority.\n`);
      process.exit(1);
    }
    if (wanted !== null && target.active === false) {
      console.error('\nThat account is deactivated. Reactivate it before granting platform authority.\n');
      process.exit(1);
    }

    const previous = target.platformRole || null;
    if (previous === wanted) {
      console.log(`\nNo change: ${target.email} already ${wanted ? `holds ${wanted}` : 'holds no platform authority'}.\n`);
      return;
    }

    /**
     * The same last-super-admin protection the HTTP path enforces. A script
     * run by a human at 2am is exactly when this matters.
     */
    if (previous === 'super_admin' && wanted !== 'super_admin') {
      const remaining = await User.countDocuments({
        platformRole: 'super_admin', active: {$ne: false}, _id: {$ne: target._id}
      });
      if (remaining === 0) {
        console.error('\nRefused: that is the last active super administrator.\n');
        process.exit(1);
      }
    }

    target.platformRole = wanted;
    await target.save();

    await Audit.create({
      entity: 'platform_user', entityId: target._id,
      action: previous && wanted
        ? 'platform_admin_role_changed'
        : (wanted ? 'platform_admin_created' : 'platform_admin_revoked'),
      before: {platformRole: previous},
      after: {platformRole: wanted, email: target.email, name: target.name},
      reason: 'Granted out-of-band via scripts/platform-admin.js (shell access)',
      // No HTTP actor exists. Recording the target as the subject of their own
      // row is honest: the audit says what happened and by what mechanism,
      // rather than inventing an actor that was never authenticated.
      user: target._id,
      userName: target.name,
      userRole: 'script:platform-admin'
    });

    console.log(`\n${wanted ? `Granted ${wanted} to` : 'Revoked platform authority from'} ${target.email}.`);
    console.log('Their existing sessions still carry a valid token, but platform authority is');
    console.log('read from the database on every request, so the change is already in force.\n');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error('\nFailed:', error?.message || error, '\n');
  process.exit(1);
});
