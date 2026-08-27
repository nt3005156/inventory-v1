import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {MenuItem, User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements
} from '../src/services/entitlements.js';
import {ResourceCounter, readQuotaCounter} from '../src/services/quotaGuard.js';
import {createMenuItem} from '../src/services/recipes.js';

/**
 * P2G.2 — atomic menu-item quotas.
 *
 * THE DEFECT THIS CLOSES, measured on this path before the fix. `maxMenuItems`
 * = 2, six concurrent `POST /api/menu-items`, repeated ten times:
 *
 *     items created per trial: 6,6,3,4,4,4,4,3,5,5
 *
 * Check-then-act: all six read the same usage, all six passed, all six
 * inserted.
 *
 * A NOTE ON HOW THIS WAS MEASURED, because it nearly went the other way. The
 * first probe ran the burst ONCE and saw a clean 2, which looked like there
 * was no defect. That probe was faulty: with a warm entitlement cache the six
 * requests serialised. Repeating the burst is what exposes the race, so every
 * concurrency assertion below runs SEVERAL trials rather than one. A single
 * green trial proves nothing about a race.
 *
 * Every assertion counts DOCUMENTS IN THE DATABASE. A settled promise says
 * nothing about how many rows were written.
 */

const DAY = 86_400_000;
const TRIALS = 8;

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
 * A tenant on a plan OF ITS OWN with the given ceilings.
 *
 * The per-tenant plan is not incidental. P2G.1 wrote limits onto the shared
 * `starter` plan, so configuring a second tenant silently re-configured the
 * first and the isolation test measured the fixture instead of the code. Each
 * tenant here owns its plan, so each test states only its own ceilings.
 */
async function tenantWithLimits(name, limits) {
  const restaurant = await Restaurant.create({name, currency: 'NPR', status: 'active'});
  const branch = await Branch.create({
    restaurant: restaurant._id,
    name: `${name} Branch`,
    code: name.slice(0, 3).toUpperCase() + Math.floor(Math.random() * 10_000)
  });

  const plan = await Plan.create({
    code: `p2g2-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${name} Plan`,
    active: true,
    currency: 'NPR',
    limits,
    features: {pos: true, inventory: true}
  });
  const now = new Date();
  await Subscription.create({
    restaurant: restaurant._id, plan: plan._id, status: 'active',
    startDate: now, currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
  });

  invalidateEntitlements();
  __resetBillingEnforcementProbe();

  const owner = await User.create({
    name: `${name} Owner`,
    email: `owner-${Math.random().toString(36).slice(2)}@p2g2.test`,
    password: 'x', role: 'owner', restaurantId: restaurant._id, branch: branch._id
  });
  return {restaurant, branch, owner, token: tokenFor(owner), plan};
}

/** Create one menu item through the real service path. */
function createItem({owner, name, extra = {}}) {
  return createMenuItem({
    input: {name, price: 100, ...extra},
    user: {id: String(owner._id), role: 'owner'},
    principal: null
  });
}

/** Wipe items and counter so a trial starts from a known zero. */
async function resetTenant(restaurantId) {
  await MenuItem.deleteMany({restaurant: restaurantId});
  await ResourceCounter.deleteMany({restaurant: restaurantId});
}

// ── sequential behaviour must not regress ────────────────────────────────────

describe('P2G.2 · sequential menu-item enforcement still works', () => {
  it('allows exactly up to the limit, then refuses with 402', async () => {
    const {restaurant, owner} = await tenantWithLimits('SeqM', {
      maxMenuItems: 3, maxBranches: 9, maxUsers: 9
    });

    await createItem({owner, name: 'Seq Momo'});
    await createItem({owner, name: 'Seq Sekuwa'});
    await createItem({owner, name: 'Seq Thukpa'});
    // THE BOUNDARY: a plan that says three must permit exactly three.
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 3);

    await assert.rejects(
      () => createItem({owner, name: 'Seq Fourth'}),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, 'RESOURCE_LIMIT_REACHED');
        return true;
      }
    );
    // Refused means NOT WRITTEN, not "written and reported as an error".
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 3);
  });

  it('does not refuse an unlimited plan, and writes no counter for one', async () => {
    const {restaurant, owner} = await tenantWithLimits('UnlimM', {
      maxMenuItems: null, maxBranches: 9, maxUsers: 9
    });

    for (let i = 0; i < 5; i += 1) await createItem({owner, name: `Unlimited ${i}`});
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 5);
    // `null` is unlimited, and an unlimited resource must not maintain a
    // counter document nothing reads.
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), null);
  });
});

// ── the race itself ──────────────────────────────────────────────────────────

describe('P2G.2 · MEASURED FIX: concurrent menu-item creates cannot exceed the ceiling', () => {
  it(`holds the ceiling across ${TRIALS} bursts of 6 concurrent HTTP creates`, async () => {
    const {restaurant, token} = await tenantWithLimits('RaceHttp', {
      maxMenuItems: 2, maxBranches: 9, maxUsers: 9
    });

    const perTrial = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetTenant(restaurant._id);
      const responses = await Promise.all(Array.from({length: 6}, (_, i) => request(
        '/api/menu-items',
        {method: 'POST', token, body: {name: `Race ${trial}-${i}`, price: 100}}
      )));

      const created = await MenuItem.countDocuments({restaurant: restaurant._id});
      perTrial.push(created);

      // The API's own answer must agree with the database. A 201 that wrote
      // nothing, or a 402 that wrote something, are both defects.
      const accepted = responses.filter(r => r.status === 201).length;
      assert.equal(accepted, created, `trial ${trial}: ${accepted} × 201 but ${created} rows`);
      for (const refusal of responses.filter(r => r.status !== 201)) {
        assert.equal(refusal.status, 402, `unexpected ${refusal.status}: ${refusal.body?.message}`);
      }
    }

    assert.deepEqual(
      perTrial.filter(n => n > 2), [],
      `quota bypassed — items per trial on a limit of 2: ${perTrial.join(',')}`
    );
    // At least one create must succeed each time, or the "fix" is just an
    // endpoint that refuses everybody.
    assert.deepEqual(perTrial.filter(n => n < 1), [], `nothing created: ${perTrial.join(',')}`);
  });

  it(`holds the ceiling at the SERVICE layer too, across ${TRIALS} bursts`, async () => {
    // The route is not the only caller. A future caller of the service must
    // inherit the same protection.
    const {restaurant, owner} = await tenantWithLimits('RaceSvc', {
      maxMenuItems: 2, maxBranches: 9, maxUsers: 9
    });

    const perTrial = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetTenant(restaurant._id);
      const attempts = await Promise.allSettled(Array.from({length: 6}, (_, i) =>
        createItem({owner, name: `Svc ${trial}-${i}`})));

      const created = await MenuItem.countDocuments({restaurant: restaurant._id});
      perTrial.push(created);
      assert.equal(
        attempts.filter(a => a.status === 'fulfilled').length, created,
        `trial ${trial}: fulfilled/rows disagree`
      );
      for (const rejected of attempts.filter(a => a.status === 'rejected')) {
        assert.equal(rejected.reason.status, 402, rejected.reason.message);
        assert.equal(rejected.reason.code, 'RESOURCE_LIMIT_REACHED');
      }
    }

    assert.deepEqual(
      perTrial.filter(n => n > 2), [],
      `quota bypassed at the service layer: ${perTrial.join(',')}`
    );
  });

  it('a burst on a ceiling of 1 admits exactly one', async () => {
    // The tightest ceiling is where an off-by-one hides.
    const {restaurant, owner} = await tenantWithLimits('RaceOne', {
      maxMenuItems: 1, maxBranches: 9, maxUsers: 9
    });

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetTenant(restaurant._id);
      await Promise.allSettled(Array.from({length: 6}, (_, i) =>
        createItem({owner, name: `One ${trial}-${i}`})));
      assert.equal(
        await MenuItem.countDocuments({restaurant: restaurant._id}), 1,
        `trial ${trial} broke a ceiling of 1`
      );
    }
  });
});

// ── the reservation must not leak ────────────────────────────────────────────

describe('P2G.2 · a failed create does not leak a reserved seat', () => {
  it('releases the seat when the insert is rejected by the unique index', async () => {
    const {restaurant, owner} = await tenantWithLimits('LeakM', {
      maxMenuItems: 3, maxBranches: 9, maxUsers: 9
    });

    await createItem({owner, name: 'Leak Momo'});
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), 1);

    /**
     * A DUPLICATE NAME. `{restaurant, name}` is uniquely indexed, so this
     * fails INSIDE the reserved window — after the seat is taken, at the
     * insert. That is precisely the case the release exists for; a validation
     * error thrown earlier would never have reserved anything and would prove
     * nothing.
     */
    await assert.rejects(
      () => createItem({owner, name: 'Leak Momo'}),
      error => {
        assert.equal(error.status, 409);
        return true;
      }
    );

    // The seat came back. If it had not, the counter would read 2 for 1 row.
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), 1);
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 1);

    // And the tenant can still fill the plan they paid for.
    await createItem({owner, name: 'Leak Sekuwa'});
    await createItem({owner, name: 'Leak Thukpa'});
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 3);
    await assert.rejects(() => createItem({owner, name: 'Leak Fourth'}));
  });

  it('repeated failures do not erode the ceiling', async () => {
    // A leak of one seat per failure is easy to miss on a single attempt and
    // obvious after ten.
    const {restaurant, owner} = await tenantWithLimits('LeakLoop', {
      maxMenuItems: 2, maxBranches: 9, maxUsers: 9
    });
    await createItem({owner, name: 'Loop Base'});

    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(() => createItem({owner, name: 'Loop Base'}));
    }
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), 1);

    // The second seat is still purchasable.
    await createItem({owner, name: 'Loop Second'});
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 2);
  });

  it('a failure AFTER a successful create does not release a seat that is in use', async () => {
    /**
     * The reserved window is deliberately narrow: it wraps the insert ONLY.
     * Audit writing and the read-back happen outside it, because the row
     * exists by then and genuinely occupies a seat. Releasing there would put
     * the counter below reality — and reconciliation only ever raises a
     * counter (`$max`), so that drift would not self-heal.
     *
     * Probed by making the post-insert read-back throw.
     */
    const {restaurant, owner} = await tenantWithLimits('PostFail', {
      maxMenuItems: 2, maxBranches: 9, maxUsers: 9
    });

    const original = MenuItem.findOne.bind(MenuItem);
    let broken = false;
    MenuItem.findOne = function patched(...args) {
      if (broken) {
        broken = false;
        throw new Error('read-back exploded');
      }
      return original(...args);
    };
    try {
      broken = true;
      await assert.rejects(() => createItem({owner, name: 'Post Fail Item'}));
    } finally {
      MenuItem.findOne = original;
    }

    // The row was written, so the seat must still be held.
    const rows = await MenuItem.countDocuments({restaurant: restaurant._id});
    assert.equal(rows, 1, 'the insert should have committed before the read-back failed');
    assert.equal(
      await readQuotaCounter(restaurant._id, 'menuItems'), 1,
      'the seat was released for a row that exists — the counter now under-reports'
    );

    // And the ceiling still holds at 2 rather than having been widened to 3.
    await createItem({owner, name: 'Post Fail Second'});
    await assert.rejects(() => createItem({owner, name: 'Post Fail Third'}));
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 2);
  });
});

// ── tenants must not share a ceiling ─────────────────────────────────────────

describe('P2G.2 · one restaurant cannot consume another\'s menu quota', () => {
  it('keeps separate counters and separate ceilings under concurrent load', async () => {
    const a = await tenantWithLimits('IsoA', {maxMenuItems: 2, maxBranches: 9, maxUsers: 9});
    const b = await tenantWithLimits('IsoB', {maxMenuItems: 4, maxBranches: 9, maxUsers: 9});

    // Both burst at once, so a shared counter would show up as one tenant
    // stealing the other's headroom.
    await Promise.allSettled([
      ...Array.from({length: 6}, (_, i) => createItem({owner: a.owner, name: `IsoA ${i}`})),
      ...Array.from({length: 6}, (_, i) => createItem({owner: b.owner, name: `IsoB ${i}`}))
    ]);

    assert.equal(await MenuItem.countDocuments({restaurant: a.restaurant._id}), 2, 'tenant A');
    assert.equal(await MenuItem.countDocuments({restaurant: b.restaurant._id}), 4, 'tenant B');
    assert.equal(await readQuotaCounter(a.restaurant._id, 'menuItems'), 2);
    assert.equal(await readQuotaCounter(b.restaurant._id, 'menuItems'), 4);
  });

  it('exhausting one tenant does not refuse the other', async () => {
    const a = await tenantWithLimits('DrainA', {maxMenuItems: 1, maxBranches: 9, maxUsers: 9});
    const b = await tenantWithLimits('DrainB', {maxMenuItems: 3, maxBranches: 9, maxUsers: 9});

    await createItem({owner: a.owner, name: 'Drain A only'});
    await assert.rejects(() => createItem({owner: a.owner, name: 'Drain A extra'}));

    // B is untouched by A hitting its wall.
    await createItem({owner: b.owner, name: 'Drain B one'});
    await createItem({owner: b.owner, name: 'Drain B two'});
    await createItem({owner: b.owner, name: 'Drain B three'});
    assert.equal(await MenuItem.countDocuments({restaurant: b.restaurant._id}), 3);
  });

  it('scopes the counter document to the restaurant', async () => {
    const a = await tenantWithLimits('ScopeA', {maxMenuItems: 5, maxBranches: 9, maxUsers: 9});
    const b = await tenantWithLimits('ScopeB', {maxMenuItems: 5, maxBranches: 9, maxUsers: 9});
    await createItem({owner: a.owner, name: 'Scope A item'});

    const rows = await ResourceCounter.find({resource: 'menuItems'}).lean();
    assert.equal(rows.length, 1, 'one create must not write a counter for every tenant');
    assert.equal(String(rows[0].restaurant), String(a.restaurant._id));
    assert.equal(await readQuotaCounter(b.restaurant._id, 'menuItems'), null);
  });
});

// ── existing behaviour must be intact ────────────────────────────────────────

describe('P2G.2 · existing menu-item behaviour is unchanged', () => {
  it('still returns the full hydrated item, not the raw insert', async () => {
    const {owner} = await tenantWithLimits('ShapeM', {
      maxMenuItems: 9, maxBranches: 9, maxUsers: 9
    });
    const row = await createItem({
      owner, name: 'Shape Momo',
      extra: {price: 250, category: 'appetizer', code: 'SHP1', packagingCost: 5}
    });

    // The read-back path (`getMenuItem`) must still be what the caller gets —
    // moving the insert into a closure must not have changed the return value.
    assert.equal(row.name, 'Shape Momo');
    assert.equal(row.price, 250);
    assert.equal(row.category, 'appetizer');
    assert.equal(row.code, 'SHP1');
    assert.equal(row.recipeVersion, 1);
    assert.ok(row._id);
    assert.equal(row.packagingCost, 5);
  });

  it('still writes the audit row for a created item', async () => {
    const {restaurant, owner} = await tenantWithLimits('AuditM', {
      maxMenuItems: 9, maxBranches: 9, maxUsers: 9
    });
    const row = await createItem({owner, name: 'Audit Momo'});

    const {Audit} = await import('../src/models/index.js');
    const entry = await Audit.findOne({entity: 'menu_items', entityId: row._id}).lean();
    assert.ok(entry, 'the audit row must survive the insert moving into a closure');
    assert.equal(entry.action, 'create');
    assert.equal(String(entry.restaurant), String(restaurant._id));
  });

  it('still rejects invalid input BEFORE reserving a seat', async () => {
    const {restaurant, owner} = await tenantWithLimits('ValidM', {
      maxMenuItems: 2, maxBranches: 9, maxUsers: 9
    });

    await assert.rejects(() => createItem({owner, name: 'x'}), /at least 2 characters/);
    await assert.rejects(
      () => createItem({owner, name: 'Bad Price', extra: {price: -1}}), /Invalid price/
    );
    await assert.rejects(
      () => createItem({owner, name: 'Bad Code', extra: {code: 'no lowercase!'}}), /Code must be/
    );

    // Three refusals, and not one of them burnt a seat.
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), null);
    await createItem({owner, name: 'Valid One'});
    await createItem({owner, name: 'Valid Two'});
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 2);
  });

  it('still refuses a tenant with no subscription with the SUBSCRIPTION message', async () => {
    /**
     * Why `assertWithinLimit()` is still called even though the reservation is
     * now the enforcement: only the entitlement resolver knows the difference
     * between "over your plan" and "you have no plan". The counter knows a
     * number and would have said "your plan allows 0 menu items".
     */
    const restaurant = await Restaurant.create({
      name: 'NoSubM', currency: 'NPR', status: 'active'
    });
    await Branch.create({restaurant: restaurant._id, name: 'NS Branch', code: 'NSB'});
    const owner = await User.create({
      name: 'NS Owner', email: `ns-${Math.random().toString(36).slice(2)}@p2g2.test`,
      password: 'x', role: 'owner', restaurantId: restaurant._id
    });
    invalidateEntitlements();
    __resetBillingEnforcementProbe();

    await assert.rejects(
      () => createItem({owner, name: 'No Sub Momo'}),
      error => {
        assert.equal(error.status, 402);
        assert.match(error.message, /No subscription/i);
        return true;
      }
    );
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 0);
  });

  it('does not enforce, or write a counter, when enforcement is off', async () => {
    /**
     * Deploy-day safety. A deployment with no plan catalogue must behave
     * exactly as it did before P2G.2, or restarting the container refuses
     * every menu item on the platform.
     */
    const {restaurant, owner} = await tenantWithLimits('OffM', {
      maxMenuItems: 1, maxBranches: 9, maxUsers: 9
    });
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      process.env.BILLING_ENFORCEMENT = 'off';
      __resetBillingEnforcementProbe();

      for (let i = 0; i < 4; i += 1) await createItem({owner, name: `Off Item ${i}`});
      assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 4);
      assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), null);
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });

  it('the seeded world\'s existing menu item still counts against the ceiling', async () => {
    /**
     * The counter reconciles against the REAL count before testing the
     * ceiling, so pre-existing rows — a tenant that had items before quotas
     * were enforced — are not free.
     */
    const restaurant = world.restaurant;
    const plan = await Plan.create({
      code: `p2g2-pre-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Pre Plan', active: true, currency: 'NPR',
      limits: {maxMenuItems: 2, maxBranches: 9, maxUsers: 9},
      features: {pos: true, inventory: true}
    });
    const now = new Date();
    await Subscription.create({
      restaurant: restaurant._id, plan: plan._id, status: 'active',
      startDate: now, currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
    });
    invalidateEntitlements();
    __resetBillingEnforcementProbe();

    // `seedWorld()` already created 'Chicken Biryani'.
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 1);

    await createItem({owner: world.owner, name: 'Pre Second'});
    await assert.rejects(() => createItem({owner: world.owner, name: 'Pre Third'}));
    assert.equal(await MenuItem.countDocuments({restaurant: restaurant._id}), 2);
  });

  it('reconciles pre-existing rows into the counter BEFORE testing the ceiling', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding, and the only survivor of the
     * P2G.2 run.
     *
     * Mutant: `countActual: () => getMenuItemUsage(...)` -> `countActual: () => 0`,
     * i.e. the counter is never seeded from reality. Every sequential test
     * above still passed, because the check-then-act pre-flight
     * (`assertWithinLimit`, which reads the REAL count) refused the create
     * before the blinded counter was ever consulted. The mutant was masked,
     * not absent.
     *
     * It is only visible when the pre-flight is defeated — which is exactly
     * the concurrent case this phase is about. Six simultaneous requests all
     * read the same pre-flight usage and all pass it; the counter is then the
     * only thing standing between them and the ceiling, and a counter that
     * starts at 0 for a tenant that already has rows hands out seats that
     * are already occupied.
     *
     * The rows are inserted DIRECTLY, not through `createMenuItem`, because
     * the case being modelled is a tenant whose menu predates quota
     * enforcement — no counter has ever been written for them.
     */
    const {restaurant, owner} = await tenantWithLimits('Reconcile', {
      maxMenuItems: 3, maxBranches: 9, maxUsers: 9
    });

    // Two rows that exist with no counter behind them.
    await MenuItem.create([
      {restaurant: restaurant._id, name: 'Legacy One', price: 100},
      {restaurant: restaurant._id, name: 'Legacy Two', price: 100}
    ]);
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), null);

    await Promise.allSettled(Array.from({length: 6}, (_, i) =>
      createItem({owner, name: `Reconciled ${i}`})));

    // 2 legacy + at most 1 new = 3. A counter that ignored the legacy rows
    // would have granted three more seats and produced 5.
    const total = await MenuItem.countDocuments({restaurant: restaurant._id});
    assert.ok(
      total <= 3,
      `pre-existing rows were not reconciled into the counter: ${total} rows on a limit of 3`
    );
    assert.equal(total, 3, 'the one remaining seat should still have been sold');
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), 3);
  });
});

// ── P2G.1 must not have moved ────────────────────────────────────────────────

describe('P2G.2 · the user-seat quota from P2G.1 is untouched', () => {
  it('menu-item reservations use their own counter and do not consume seats', async () => {
    const {restaurant, branch, owner} = await tenantWithLimits('MixM', {
      maxMenuItems: 3, maxUsers: 2, maxStaff: 2, maxBranches: 9
    });

    await createItem({owner, name: 'Mix One'});
    await createItem({owner, name: 'Mix Two'});

    // Menu items consumed the menuItems counter and NOTHING else.
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), 2);
    assert.equal(await readQuotaCounter(restaurant._id, 'users'), null);
    assert.equal(await readQuotaCounter(restaurant._id, 'users:staff'), null);

    // And the seat quota still works, with the owner already holding one of 2.
    const {createStaffAccount} = await import('../src/services/staffAccounts.js');
    await createStaffAccount({
      user: {id: String(owner._id), role: 'owner'},
      input: {
        name: 'Mix Staff', email: `mix-${Math.random().toString(36).slice(2)}@p2g2.test`,
        password: 'LongEnough123', role: 'staff', branch: String(branch._id)
      }
    });
    assert.equal(await User.countDocuments({restaurantId: restaurant._id}), 2);
    await assert.rejects(() => createStaffAccount({
      user: {id: String(owner._id), role: 'owner'},
      input: {
        name: 'Mix Extra', email: `mix2-${Math.random().toString(36).slice(2)}@p2g2.test`,
        password: 'LongEnough123', role: 'staff', branch: String(branch._id)
      }
    }), error => {
      assert.equal(error.status, 402);
      return true;
    });
  });
});
