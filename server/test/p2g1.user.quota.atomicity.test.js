import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, seedWorld, startTestApp, stopTestApp} from './helpers.js';
import {User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {__resetBillingEnforcementProbe, invalidateEntitlements} from '../src/services/entitlements.js';
import {ResourceCounter, readQuotaCounter, withCompoundQuota} from '../src/services/quotaGuard.js';
import {createStaffAccount} from '../src/services/staffAccounts.js';

/**
 * P2G.1 — atomic user seat quotas.
 *
 * THE DEFECT THIS CLOSES, measured in the P2F audit against this same path:
 *
 *     limit maxUsers = 2, one owner already present
 *     6 concurrent staff creates -> 6 fulfilled, 7 users exist   BYPASSED
 *
 * Check-then-act: every request read the same seat count, every one passed,
 * every one inserted.
 *
 * Every assertion below counts DOCUMENTS IN THE DATABASE. A settled promise
 * proves nothing about how many rows were written.
 */

const DAY = 86_400_000;

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  world = await seedWorld();
  await seedPlans();
  await ResourceCounter.createIndexes();
  __resetBillingEnforcementProbe();
});

/**
 * A tenant on a starter plan with the given seat ceilings.
 *
 * Limits are written onto the shared `starter` plan and the entitlement cache
 * is dropped, so each test states exactly the ceilings it depends on rather
 * than inheriting the seed's commercial values.
 */
async function tenantWithLimits(name, limits) {
  const restaurant = await Restaurant.create({name, currency: 'NPR', status: 'active'});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: `${name} Branch`,
    code: name.slice(0, 3).toUpperCase() + Math.floor(Math.random() * 1000)
  });

  /**
   * A PLAN OF ITS OWN for each tenant.
   *
   * My first version rewrote the shared `starter` plan's limits on every call,
   * so creating a second tenant silently changed the first one's ceilings —
   * the isolation test then measured my fixture rather than the code. Probed
   * and confirmed: both tenants resolved `maxUsers = 3` after the second
   * setup. A per-tenant plan makes each test state only its own ceilings.
   */
  const plan = await Plan.create({
    code: `p2g1-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${name} Plan`,
    active: true,
    currency: 'NPR',
    limits,
    // Seats are the subject here; nothing else should interfere.
    features: {pos: true, inventory: true}
  });
  const now = new Date();
  await Subscription.create({
    restaurant: restaurant._id, plan: plan._id, status: 'active',
    startDate: now, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
  });

  invalidateEntitlements();
  __resetBillingEnforcementProbe();

  const owner = await User.create({
    name: `${name} Owner`, email: `owner-${Math.random().toString(36).slice(2)}@quota.test`,
    password: 'x', role: 'owner', restaurantId: restaurant._id
  });
  return {restaurant, branch, owner};
}

/** Create one account through the real service path. */
function create({owner, branch, index, role = 'staff', tag = 't'}) {
  return createStaffAccount({
    user: {id: String(owner._id), role: 'owner'},
    input: {
      name: `${role}-${index}`,
      email: `${tag}-${role}-${index}-${Math.random().toString(36).slice(2)}@quota.test`,
      password: 'LongEnough123',
      role,
      branch: String(branch._id)
    }
  });
}

// ── sequential behaviour must not regress ────────────────────────────────────

describe('P2G.1 · sequential seat enforcement still works', () => {
  it('allows exactly up to the seat limit, then refuses', async () => {
    // maxUsers 3, and the owner already occupies one seat.
    const {restaurant, branch, owner} = await tenantWithLimits('SeqA', {
      maxUsers: 3, maxStaff: 99, maxManagers: 99, maxRiders: 99
    });

    await create({owner, branch, index: 1, tag: 'seqa'});
    await create({owner, branch, index: 2, tag: 'seqa'});
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 3);

    await assert.rejects(
      () => create({owner, branch, index: 3, tag: 'seqa'}),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, 'RESOURCE_LIMIT_REACHED');
        return true;
      }
    );
    // The refusal wrote nothing.
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 3);
  });

  it('enforces a per-role ceiling below the overall seat ceiling', async () => {
    const {restaurant, branch, owner} = await tenantWithLimits('SeqB', {
      maxUsers: 10, maxStaff: 1, maxManagers: 99, maxRiders: 99
    });

    await create({owner, branch, index: 1, role: 'staff', tag: 'seqb'});
    await assert.rejects(
      () => create({owner, branch, index: 2, role: 'staff', tag: 'seqb'}), /staff accounts/);

    // ...but a MANAGER is still creatable: only the staff ceiling was reached.
    await create({owner, branch, index: 3, role: 'manager', tag: 'seqb'});
    assert.equal(await User.countDocuments({restaurantId: restaurant._id, role: 'staff'}), 1);
    assert.equal(await User.countDocuments({restaurantId: restaurant._id, role: 'manager'}), 1);
  });

  it('treats an unlimited seat count as unlimited and writes no counter', async () => {
    const {restaurant, branch, owner} = await tenantWithLimits('SeqC', {
      maxUsers: null, maxStaff: null, maxManagers: null, maxRiders: null
    });
    for (let i = 0; i < 4; i += 1) await create({owner, branch, index: i, tag: 'seqc'});
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 5);
    assert.equal(await readQuotaCounter(restaurant._id, 'users'), null,
      'an unlimited plan should not maintain a counter document');
  });
});

// ── the measured race ────────────────────────────────────────────────────────

describe('P2G.1 · concurrent creation cannot exceed the seat quota', () => {
  it('MEASURED FIX: maxUsers=2, six concurrent creates -> at most 2 users', async () => {
    /**
     * The P2F reproduction, inverted into a regression test. Before the fix
     * this produced 7 users.
     */
    const {restaurant, branch, owner} = await tenantWithLimits('RaceA', {
      maxUsers: 2, maxStaff: 99, maxManagers: 99, maxRiders: 99
    });

    const attempts = await Promise.allSettled(
      Array.from({length: 6}, (_, i) => create({owner, branch, index: i, tag: 'racea'}))
    );

    const users = await User.countDocuments({restaurantId: restaurant._id});
    assert.ok(users <= 2, `quota bypassed: ${users} users exist on a limit of 2`);
    // The owner occupies one seat, so exactly one create can win.
    assert.equal(users, 2);
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);

    for (const attempt of attempts.filter(a => a.status === 'rejected')) {
      assert.equal(attempt.reason.status, 402);
      assert.equal(attempt.reason.code, 'RESOURCE_LIMIT_REACHED');
    }
  });

  it('MEASURED FIX: maxUsers=2 AND maxStaff=2, six concurrent staff creates', async () => {
    /**
     * The dual-ceiling case. Both must hold simultaneously; neither may be
     * exceeded, and a refusal on one must not consume the other.
     */
    const {restaurant, branch, owner} = await tenantWithLimits('RaceB', {
      maxUsers: 2, maxStaff: 2, maxManagers: 99, maxRiders: 99
    });

    await Promise.allSettled(
      Array.from({length: 6}, (_, i) => create({owner, branch, index: i, tag: 'raceb'}))
    );

    const users = await User.countDocuments({restaurantId: restaurant._id});
    const staff = await User.countDocuments({restaurantId: restaurant._id, role: 'staff'});
    assert.ok(users <= 2, `users bypassed: ${users} on a limit of 2`);
    assert.ok(staff <= 2, `staff bypassed: ${staff} on a limit of 2`);
    // The owner holds one of the two seats.
    assert.equal(users, 2);
    assert.equal(staff, 1);
  });

  it('holds the per-role ceiling when it is the binding constraint', async () => {
    // Plenty of seats overall, but only two staff.
    const {restaurant, branch, owner} = await tenantWithLimits('RaceC', {
      maxUsers: 50, maxStaff: 2, maxManagers: 99, maxRiders: 99
    });

    await Promise.allSettled(
      Array.from({length: 8}, (_, i) => create({owner, branch, index: i, tag: 'racec'}))
    );

    const staff = await User.countDocuments({restaurantId: restaurant._id, role: 'staff'});
    assert.equal(staff, 2, `staff ceiling bypassed: ${staff} exist on a limit of 2`);
  });

  it('keeps roles independent under mixed concurrent creation', async () => {
    const {restaurant, branch, owner} = await tenantWithLimits('RaceD', {
      maxUsers: 50, maxStaff: 2, maxManagers: 2, maxRiders: 2
    });

    await Promise.allSettled([
      ...Array.from({length: 4}, (_, i) => create({owner, branch, index: i, role: 'staff', tag: 'raced'})),
      ...Array.from({length: 4}, (_, i) => create({owner, branch, index: i, role: 'manager', tag: 'raced'}))
    ]);

    assert.equal(await User.countDocuments({restaurantId: restaurant._id, role: 'staff'}), 2);
    assert.equal(await User.countDocuments({restaurantId: restaurant._id, role: 'manager'}), 2);
  });
});

// ── no reservation may leak ──────────────────────────────────────────────────

describe('P2G.1 · a refused create never leaks a seat', () => {
  it('releases the maxUsers reservation when the per-role ceiling refuses', async () => {
    /**
     * THE COMPOUND-RESERVATION GUARANTEE.
     *
     * `maxUsers` is reserved first and `maxStaff` second. With `maxStaff: 0`
     * the second reservation always fails, so the first must be handed back —
     * otherwise every refused staff create silently burns a seat and a tenant
     * with a working plan eventually cannot create anybody.
     */
    const {restaurant, branch, owner} = await tenantWithLimits('LeakA', {
      maxUsers: 10, maxStaff: 0, maxManagers: 99, maxRiders: 99
    });

    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(() => create({owner, branch, index: i, tag: 'leaka'}));
    }

    // Ten refusals must not have consumed ten seats.
    const realUsers = await User.countDocuments({restaurantId: restaurant._id});
    const counter = await readQuotaCounter(restaurant._id, 'users');
    assert.equal(realUsers, 1, 'a refused create wrote a user');
    assert.equal(counter, realUsers,
      `seat counter drifted from reality: counter=${counter}, real=${realUsers}`);

    // And the seats are genuinely still usable.
    await create({owner, branch, index: 99, role: 'manager', tag: 'leaka'});
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 2);
  });

  it('releases every reservation when the CREATE ITSELF fails', async () => {
    /**
     * Exercises `withCompoundQuota`'s create-failure unwind DIRECTLY.
     *
     * A mutation finding: my first attempt used a duplicate email, assuming it
     * would fail inside `User.create()`. It does not — `createStaffAccount()`
     * rejects duplicates at line 119, long BEFORE any reservation is taken at
     * line 207, so no reservation existed to leak and the unwind path was
     * never entered. The mutant that deleted it survived.
     *
     * Driving the primitive directly is the honest way to cover this: the
     * failure has to happen after both reservations succeed, which no input to
     * `createStaffAccount()` can currently produce.
     */
    const {restaurant} = await tenantWithLimits('LeakB2', {
      maxUsers: 5, maxStaff: 5, maxManagers: 99, maxRiders: 99
    });

    const specs = [
      {
        restaurantId: restaurant._id, resource: 'users', limit: 5,
        countActual: async () => 0, label: 'user accounts'
      },
      {
        restaurantId: restaurant._id, resource: 'users:staff', limit: 5,
        countActual: async () => 0, label: 'staff accounts'
      }
    ];

    await assert.rejects(
      () => withCompoundQuota(specs, async () => {
        throw new Error('simulated insert failure');
      }),
      /simulated insert failure/
    );

    // BOTH reservations must have been handed back.
    assert.equal(await readQuotaCounter(restaurant._id, 'users'), 0,
      'the maxUsers reservation leaked after the create failed');
    assert.equal(await readQuotaCounter(restaurant._id, 'users:staff'), 0,
      'the per-role reservation leaked after the create failed');

    // Control: a create that SUCCEEDS consumes exactly one of each.
    await withCompoundQuota(specs, async () => 'ok');
    assert.equal(await readQuotaCounter(restaurant._id, 'users'), 1);
    assert.equal(await readQuotaCounter(restaurant._id, 'users:staff'), 1);
  });

  it('rejects a duplicate email before any seat is reserved', async () => {
    /**
     * The original intent of the test above, kept as its own case now that the
     * ordering is understood: a duplicate is refused by the pre-check, so no
     * seat is consumed by the attempt.
     */
    const {restaurant, branch, owner} = await tenantWithLimits('LeakB', {
      maxUsers: 5, maxStaff: 5, maxManagers: 99, maxRiders: 99
    });

    const email = `dup-${Math.random().toString(36).slice(2)}@quota.test`;
    const payload = {
      user: {id: String(owner._id), role: 'owner'},
      input: {
        name: 'First', email, password: 'LongEnough123',
        role: 'staff', branch: String(branch._id)
      }
    };
    await createStaffAccount(payload);
    // The duplicate is refused by the pre-check, which is itself a failure
    // path after validation — the reservation must not survive it.
    await assert.rejects(() => createStaffAccount(payload), /already exists/);

    const realUsers = await User.countDocuments({restaurantId: restaurant._id});
    assert.equal(realUsers, 2);
    assert.equal(await readQuotaCounter(restaurant._id, 'users'), realUsers,
      'a failed insert leaked a seat reservation');
  });

  it('reconciles a counter that has drifted below reality', async () => {
    const {restaurant, branch, owner} = await tenantWithLimits('LeakC', {
      maxUsers: 3, maxStaff: 99, maxManagers: 99, maxRiders: 99
    });
    await create({owner, branch, index: 1, tag: 'leakc'});

    // Corrupt the counter downwards, as a restore or a stray delete would.
    await ResourceCounter.updateOne(
      {restaurant: restaurant._id, resource: 'users'}, {$set: {count: 0}});

    // Reconciliation must notice the real count is 2 and still stop at 3.
    await create({owner, branch, index: 2, tag: 'leakc'});
    await assert.rejects(() => create({owner, branch, index: 3, tag: 'leakc'}), /allows 3/);
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 3);
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe('P2G.1 · one restaurant cannot consume another restaurant\'s seats', () => {
  it('keeps seat counters per tenant', async () => {
    const a = await tenantWithLimits('IsoA', {
      maxUsers: 2, maxStaff: 2, maxManagers: 99, maxRiders: 99
    });
    const b = await tenantWithLimits('IsoB', {
      maxUsers: 2, maxStaff: 2, maxManagers: 99, maxRiders: 99
    });

    // A exhausts its own seats.
    await create({owner: a.owner, branch: a.branch, index: 1, tag: 'isoa'});
    await assert.rejects(
      () => create({owner: a.owner, branch: a.branch, index: 2, tag: 'isoa'}), /allows 2/);

    // B is unaffected.
    await create({owner: b.owner, branch: b.branch, index: 1, tag: 'isob'});
    assert.equal(await User.countDocuments({restaurantId: b.restaurant._id}), 2);

    // Counters are scoped, not shared.
    assert.equal(await readQuotaCounter(a.restaurant._id, 'users'), 2);
    assert.equal(await readQuotaCounter(b.restaurant._id, 'users'), 2);
    const counters = await ResourceCounter.find({resource: 'users'}).lean();
    for (const counter of counters) {
      assert.ok(counter.restaurant, 'a seat counter exists with no tenant scope');
    }
  });

  it('does not let concurrent load in one tenant starve another', async () => {
    const a = await tenantWithLimits('IsoC', {
      maxUsers: 50, maxStaff: 50, maxManagers: 99, maxRiders: 99
    });
    const b = await tenantWithLimits('IsoD', {
      maxUsers: 3, maxStaff: 3, maxManagers: 99, maxRiders: 99
    });

    await Promise.allSettled([
      ...Array.from({length: 10}, (_, i) => create({owner: a.owner, branch: a.branch, index: i, tag: 'isoc'})),
      ...Array.from({length: 10}, (_, i) => create({owner: b.owner, branch: b.branch, index: i, tag: 'isod'}))
    ]);

    // B's ceiling held despite A's burst; A was not throttled by B's ceiling.
    assert.equal(await User.countDocuments({restaurantId: b.restaurant._id}), 3);
    assert.equal(await User.countDocuments({restaurantId: a.restaurant._id}), 11);
  });
});

// ── the rollout gate is respected ────────────────────────────────────────────

describe('P2G.1 · seat quotas respect the billing enforcement gate', () => {
  it('does not enforce seats on a deployment with no plan catalogue', async () => {
    /**
     * The P2C rule: an unprovisioned deployment must behave exactly as it did
     * before, or upgrading starts refusing staff accounts on a platform that
     * never sold seats.
     */
    const {restaurant, branch, owner} = await tenantWithLimits('GateA', {
      maxUsers: 1, maxStaff: 1, maxManagers: 99, maxRiders: 99
    });

    await Plan.deleteMany({});
    await Subscription.deleteMany({});
    invalidateEntitlements();
    __resetBillingEnforcementProbe();

    await create({owner, branch, index: 1, tag: 'gatea'});
    await create({owner, branch, index: 2, tag: 'gatea'});
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 3,
      'seats were enforced on an unprovisioned deployment');
  });
});

// ── existing behaviour must not regress ──────────────────────────────────────

describe('P2G.1 · unrelated account behaviour is unchanged', () => {
  it('still refuses an owner role, a weak password and a duplicate email', async () => {
    const {branch, owner} = await tenantWithLimits('RegA', {
      maxUsers: 50, maxStaff: 50, maxManagers: 99, maxRiders: 99
    });
    const base = {user: {id: String(owner._id), role: 'owner'}};

    await assert.rejects(() => createStaffAccount({
      ...base,
      input: {name: 'X', email: 'reg1@quota.test', password: 'LongEnough123',
        role: 'owner', branch: String(branch._id)}
    }), /Role must be one of/);

    await assert.rejects(() => createStaffAccount({
      ...base,
      input: {name: 'X', email: 'reg2@quota.test', password: 'short',
        role: 'staff', branch: String(branch._id)}
    }), /at least 10 characters/);

    await assert.rejects(() => createStaffAccount({
      ...base,
      input: {name: 'X', email: 'reg3@quota.test', password: 'LongEnough123', role: 'staff'}
    }), /branch is required/);
  });

  it('still returns a safe projection with no password hash', async () => {
    const {branch, owner} = await tenantWithLimits('RegB', {
      maxUsers: 50, maxStaff: 50, maxManagers: 99, maxRiders: 99
    });
    const created = await create({owner, branch, index: 1, tag: 'regb'});
    assert.equal(created.password, undefined);
    assert.ok(!JSON.stringify(created).toLowerCase().includes('password'));
    assert.ok(created.email);
  });

  it('still creates a rider with an off-shift profile', async () => {
    const {branch, owner} = await tenantWithLimits('RegC', {
      maxUsers: 50, maxStaff: 50, maxManagers: 50, maxRiders: 50
    });
    const rider = await create({owner, branch, index: 1, role: 'rider', tag: 'regc'});
    assert.equal(rider.role, 'rider');
    assert.equal(rider.rider.active, true);
    assert.equal(rider.rider.available, false);
  });
});
