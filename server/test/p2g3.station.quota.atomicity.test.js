import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {KitchenStation, User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements
} from '../src/services/entitlements.js';
import {ResourceCounter, readQuotaCounter} from '../src/services/quotaGuard.js';
import {
  BUILT_IN_STATION_CODES, createStation, deleteStation, listStations, updateStation
} from '../src/services/stations.js';
import {getStationUsage, getUsageSummary} from '../src/services/usage.js';

/**
 * P2G.3 — atomic kitchen-station quotas.
 *
 * THE DEFECT THIS CLOSES, measured before the fix. `maxStations` had no usage
 * counter at all and was enforced nowhere:
 *
 *     limit 2, four SEQUENTIAL creates   -> 201,201,201,201
 *     limit 2, six concurrent, 8 trials  -> 6,6,6,6,6,6,6,6
 *
 * WHAT COUNTS. Eleven built-in stations are auto-seeded per restaurant on
 * first read. Starter sells 2 and professional 8, so counting the seeded set
 * would put every tenant on those plans over quota the moment the feature
 * shipped. `maxStations` therefore counts stations the TENANT created, and the
 * built-ins are free. Deactivating one hands the seat back.
 *
 * Every concurrency assertion runs SEVERAL trials. A single clean burst is not
 * evidence — that lesson came from P2G.2, where a one-shot probe hid the race
 * entirely.
 *
 * Every assertion counts DOCUMENTS IN THE DATABASE.
 */

const DAY = 86_400_000;
const TRIALS = 8;
const BUILT_INS = BUILT_IN_STATION_CODES.length;

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

/** A tenant on a plan of its own, so no test can re-configure another's. */
async function tenantWithLimits(name, limits) {
  const restaurant = await Restaurant.create({name, currency: 'NPR', status: 'active'});
  const branch = await Branch.create({
    restaurant: restaurant._id,
    name: `${name} Branch`,
    code: name.slice(0, 3).toUpperCase() + Math.floor(Math.random() * 10_000)
  });
  const plan = await Plan.create({
    code: `p2g3-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${name} Plan`,
    active: true,
    currency: 'NPR',
    limits,
    features: {pos: true, inventory: true, kds: true}
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
    email: `owner-${Math.random().toString(36).slice(2)}@p2g3.test`,
    password: 'x', role: 'owner', restaurantId: restaurant._id, branch: branch._id
  });
  return {restaurant, branch, owner, token: tokenFor(owner), plan};
}

/** Stations the tenant created — what the ceiling actually governs. */
function customStations(restaurantId) {
  return KitchenStation.countDocuments({
    restaurant: restaurantId, builtIn: false, active: {$ne: false}
  });
}

/** Create through the real HTTP route, which owns the transaction. */
function postStation(token, code, name) {
  return request('/api/kitchen/stations', {
    method: 'POST', token, body: {code, name: name || code}
  });
}

async function resetTenant(restaurantId) {
  await KitchenStation.deleteMany({restaurant: restaurantId});
  await ResourceCounter.deleteMany({restaurant: restaurantId});
}

// ── the built-in seed must stay free ─────────────────────────────────────────

describe('P2G.3 · auto-seeded built-in stations do not consume the quota', () => {
  it(`seeds ${BUILT_INS} built-ins that cost a starter tenant nothing`, async () => {
    // The whole reason the counter excludes them: 11 seeded > 2 allowed.
    const {restaurant, token} = await tenantWithLimits('SeedFree', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });

    const listed = await request('/api/kitchen/stations', {token});
    assert.equal(listed.status, 200);
    assert.equal(
      await KitchenStation.countDocuments({restaurant: restaurant._id}), BUILT_INS
    );
    // Seeded rows are marked, and none of them counts.
    assert.equal(
      await KitchenStation.countDocuments({restaurant: restaurant._id, builtIn: true}),
      BUILT_INS
    );
    assert.equal(await getStationUsage(restaurant._id), 0);

    // And the tenant still gets the two stations they paid for.
    assert.equal((await postStation(token, 'own-a')).status, 201);
    assert.equal((await postStation(token, 'own-b')).status, 201);
    assert.equal((await postStation(token, 'own-c')).status, 402);
  });

  it('a renamed built-in stays free — the flag is persisted, not derived', async () => {
    /**
     * WHY THIS MATTERS. `PATCH {code:'renamed-grill'}` on the seeded `grill`
     * succeeds (measured). If "is this built-in?" were answered by checking
     * the code against BUILT_IN_STATION_CODES, a rename would silently turn a
     * free station into a billable one and consume a seat the tenant never
     * bought.
     */
    const {restaurant, token} = await tenantWithLimits('Renamed', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    await request('/api/kitchen/stations', {token});
    const grill = await KitchenStation.findOne({restaurant: restaurant._id, code: 'grill'});

    const renamed = await request(`/api/kitchen/stations/${grill._id}`, {
      method: 'PATCH', token, body: {code: 'renamed-grill', name: 'Renamed'}
    });
    assert.equal(renamed.status, 200);
    assert.equal(await getStationUsage(restaurant._id), 0, 'a rename must not cost a seat');

    // Both purchased seats remain available.
    assert.equal((await postStation(token, 'after-rename-a')).status, 201);
    assert.equal((await postStation(token, 'after-rename-b')).status, 201);
    assert.equal((await postStation(token, 'after-rename-c')).status, 402);
  });

  it('legacy rows carrying no builtIn flag are treated as free, not billable', async () => {
    // Rows written before P2G.3 have no flag. Reading them as built-in grants
    // seats rather than retroactively refusing tenants — the safe direction.
    const {restaurant} = await tenantWithLimits('Legacy', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    await KitchenStation.collection.insertMany([
      {restaurant: restaurant._id, code: 'legacy-a', name: 'Legacy A', active: true, sortOrder: 1},
      {restaurant: restaurant._id, code: 'legacy-b', name: 'Legacy B', active: true, sortOrder: 2}
    ]);
    assert.equal(await getStationUsage(restaurant._id), 0);
  });
});

// ── the race itself ──────────────────────────────────────────────────────────

describe('P2G.3 · MEASURED FIX: concurrent station creates cannot exceed the ceiling', () => {
  it(`holds a ceiling of 2 across ${TRIALS} bursts of 6 concurrent HTTP creates`, async () => {
    const {restaurant, token} = await tenantWithLimits('RaceStn', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });

    const perTrial = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetTenant(restaurant._id);
      const responses = await Promise.all(Array.from({length: 6}, (_, i) =>
        postStation(token, `t${trial}c${i}`, `T${trial} C${i}`)));

      const created = await customStations(restaurant._id);
      perTrial.push(created);

      const accepted = responses.filter(r => r.status === 201).length;
      assert.equal(accepted, created, `trial ${trial}: ${accepted} × 201 but ${created} rows`);
      for (const refusal of responses.filter(r => r.status !== 201)) {
        assert.equal(refusal.status, 402, `unexpected ${refusal.status}: ${refusal.body?.message}`);
      }
    }

    assert.deepEqual(
      perTrial.filter(n => n > 2), [],
      `quota bypassed — custom stations per trial on a limit of 2: ${perTrial.join(',')}`
    );
    assert.deepEqual(perTrial.filter(n => n < 1), [], `nothing created: ${perTrial.join(',')}`);
  });

  it(`holds a ceiling of 1 across ${TRIALS} bursts`, async () => {
    const {restaurant, token} = await tenantWithLimits('RaceOneStn', {
      maxStations: 1, maxBranches: 9, maxUsers: 9
    });
    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetTenant(restaurant._id);
      await Promise.all(Array.from({length: 6}, (_, i) =>
        postStation(token, `o${trial}c${i}`)));
      assert.equal(
        await customStations(restaurant._id), 1, `trial ${trial} broke a ceiling of 1`
      );
    }
  });

  it('sequential enforcement allows exactly the ceiling, then refuses', async () => {
    const {restaurant, token} = await tenantWithLimits('SeqStn', {
      maxStations: 3, maxBranches: 9, maxUsers: 9
    });
    for (const code of ['s1', 's2', 's3']) {
      assert.equal((await postStation(token, code)).status, 201, code);
    }
    const refused = await postStation(token, 's4');
    assert.equal(refused.status, 402);
    assert.match(refused.body.message, /kitchen stations/i);
    assert.equal(await customStations(restaurant._id), 3);
  });

  it('an unlimited ceiling refuses nobody and writes no counter', async () => {
    const {restaurant, token} = await tenantWithLimits('UnlimStn', {
      maxStations: null, maxBranches: 9, maxUsers: 9
    });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await postStation(token, `u${i}`)).status, 201);
    }
    assert.equal(await customStations(restaurant._id), 5);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), null);
  });
});

// ── failure paths must not drift the counter ─────────────────────────────────

describe('P2G.3 · no permanent quota drift from either failure path', () => {
  it('a duplicate code is refused and consumes no seat', async () => {
    const {restaurant, token} = await tenantWithLimits('DupStn', {
      maxStations: 3, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'dup')).status, 201);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);

    const clash = await postStation(token, 'dup');
    assert.equal(clash.status, 409);
    // The clash is detected before the reservation, so the counter is untouched.
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);
    assert.equal(await customStations(restaurant._id), 1);

    // Repeated failures must not erode the ceiling.
    for (let i = 0; i < 8; i += 1) assert.equal((await postStation(token, 'dup')).status, 409);
    assert.equal((await postStation(token, 'dup-b')).status, 201);
    assert.equal((await postStation(token, 'dup-c')).status, 201);
    assert.equal(await customStations(restaurant._id), 3);
  });

  it('RESERVATION SUCCEEDS, INSERT FAILS: the transaction rolls the seat back', async () => {
    /**
     * The failure path the brief calls out. The reservation joins the caller's
     * transaction, so an aborting insert must undo the increment too.
     *
     * Driven through the real transactional route by making the insert throw.
     */
    const {restaurant, token} = await tenantWithLimits('InsertFail', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'keep-me')).status, 201);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);

    const original = KitchenStation.create.bind(KitchenStation);
    let armed = false;
    KitchenStation.create = async function patched(...args) {
      if (armed) {
        armed = false;
        throw new Error('insert exploded');
      }
      return original(...args);
    };
    try {
      armed = true;
      const failed = await postStation(token, 'never-lands');
      assert.equal(failed.status, 500);
    } finally {
      KitchenStation.create = original;
    }

    // Not written...
    assert.equal(await customStations(restaurant._id), 1);
    assert.equal(
      await KitchenStation.countDocuments({restaurant: restaurant._id, code: 'never-lands'}), 0
    );
    // ...and crucially, not still holding a seat. A leak would read 2 here and
    // the tenant would have lost a station they paid for.
    assert.equal(
      await readQuotaCounter(restaurant._id, 'stations'), 1,
      'the aborted transaction leaked a reservation'
    );

    // The second seat is still purchasable — the real proof it was returned.
    assert.equal((await postStation(token, 'second-seat')).status, 201);
    assert.equal(await customStations(restaurant._id), 2);
  });

  it('an aborted transaction does not DOUBLE-release the seat', async () => {
    /**
     * The mirror-image drift, and the reason `withQuota` skips its
     * compensating release when a session is present. The transaction already
     * rolls the increment back; releasing as well would decrement twice and
     * leave the counter BELOW reality — which reconciliation, being `$max`,
     * would never repair. The tenant would silently gain a free station.
     */
    const {restaurant, token} = await tenantWithLimits('DoubleRelease', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'alpha')).status, 201);

    const original = KitchenStation.create.bind(KitchenStation);
    let armed = false;
    KitchenStation.create = async function patched(...args) {
      if (armed) {
        armed = false;
        throw new Error('insert exploded');
      }
      return original(...args);
    };
    try {
      armed = true;
      await postStation(token, 'doomed');
    } finally {
      KitchenStation.create = original;
    }

    // One real station, counter says one. Not zero.
    assert.equal(await customStations(restaurant._id), 1);
    assert.equal(
      await readQuotaCounter(restaurant._id, 'stations'), 1,
      'the seat was released twice — the counter now under-reports'
    );

    // So the ceiling still bites at 2, not at 3.
    assert.equal((await postStation(token, 'beta')).status, 201);
    assert.equal((await postStation(token, 'gamma')).status, 402);
    assert.equal(await customStations(restaurant._id), 2);
  });
});

// ── deactivation returns the seat ────────────────────────────────────────────

describe('P2G.3 · retiring a station returns its seat', () => {
  it('DELETE deactivates and frees a seat for a different code', async () => {
    const {restaurant, token} = await tenantWithLimits('FreeSeat', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    const first = await postStation(token, 'retire-me');
    assert.equal((await postStation(token, 'stays')).status, 201);
    assert.equal((await postStation(token, 'too-many')).status, 402);

    const removed = await request(`/api/kitchen/stations/${first.body._id}`, {
      method: 'DELETE', token
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deactivated, true);
    // The row survives — historical order lines still name it.
    assert.equal(await KitchenStation.countDocuments({_id: first.body._id}), 1);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);

    // The freed seat is spendable on a NEW code.
    assert.equal((await postStation(token, 'replacement')).status, 201);
    assert.equal(await customStations(restaurant._id), 2);
    assert.equal((await postStation(token, 'one-too-far')).status, 402);
  });

  it('deleting an already-inactive station does not free a second seat', async () => {
    // Otherwise two DELETEs on one row would drive the counter below reality.
    const {restaurant, token} = await tenantWithLimits('DoubleDelete', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    const first = await postStation(token, 'retire-twice');
    assert.equal((await postStation(token, 'other')).status, 201);

    for (let i = 0; i < 3; i += 1) {
      const res = await request(`/api/kitchen/stations/${first.body._id}`, {
        method: 'DELETE', token
      });
      assert.equal(res.status, 200);
    }
    assert.equal(
      await readQuotaCounter(restaurant._id, 'stations'), 1,
      'repeated deletes released more seats than the row ever held'
    );

    // Exactly one seat came back, so exactly one more station fits.
    assert.equal((await postStation(token, 'refill')).status, 201);
    assert.equal((await postStation(token, 'overflow')).status, 402);
  });

  it('REACTIVATING buys the seat back, and is refused when the plan is full', async () => {
    /**
     * The bypass this closes: deactivate, create a replacement, then
     * reactivate the old one and hold three on a ceiling of two.
     */
    const {restaurant, token} = await tenantWithLimits('Reactivate', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    const first = await postStation(token, 'toggle-me');
    assert.equal((await postStation(token, 'second')).status, 201);

    await request(`/api/kitchen/stations/${first.body._id}`, {method: 'DELETE', token});
    assert.equal((await postStation(token, 'replacement')).status, 201);
    assert.equal(await customStations(restaurant._id), 2);

    // Both seats are now spoken for, so the old station cannot come back.
    const revived = await request(`/api/kitchen/stations/${first.body._id}`, {
      method: 'PATCH', token, body: {active: true}
    });
    assert.equal(revived.status, 402, 'reactivation bypassed the ceiling');
    assert.equal(await customStations(restaurant._id), 2);
    assert.equal(
      (await KitchenStation.findById(first.body._id)).active, false,
      'the refused reactivation must not have been saved'
    );
  });

  it('reactivation succeeds when the plan has room', async () => {
    // The control for the test above: 402 must be the ceiling, not a
    // permanently broken reactivate.
    const {restaurant, token} = await tenantWithLimits('ReactivateOk', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    const first = await postStation(token, 'toggle-ok');
    await request(`/api/kitchen/stations/${first.body._id}`, {method: 'DELETE', token});
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 0);

    const revived = await request(`/api/kitchen/stations/${first.body._id}`, {
      method: 'PATCH', token, body: {active: true}
    });
    assert.equal(revived.status, 200, revived.body?.message);
    assert.equal((await KitchenStation.findById(first.body._id)).active, true);
    assert.equal(await customStations(restaurant._id), 1);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);
  });

  it('deactivating a LEGACY row (no flag) never releases a seat it never held', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding, the only survivor of the P2G.3 run.
     *
     * Mutant: `station.builtIn === false` -> `station.builtIn !== true` in
     * `updateStation`. Every other test still passed, because they all toggle
     * stations that carry an explicit flag, where the two spellings agree.
     *
     * They differ only for a pre-P2G.3 row, which has no `builtIn` field at
     * all. Such a row never consumed a seat, so releasing one when it is
     * deactivated invents a seat from nothing: the counter falls below the
     * true count, and reconciliation (`$max`) only ever raises a counter, so
     * that drift is permanent. The tenant silently gains a free station.
     *
     * This is the same `$ne`/missing-field trap that produced a real defect in
     * `getStationUsage()` earlier in this phase, so it is worth pinning in
     * both places.
     */
    const {restaurant, token} = await tenantWithLimits('LegacyToggle', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'real-one')).status, 201);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);

    // A row as it would exist before P2G.3: no `builtIn` field whatsoever.
    const legacy = await KitchenStation.collection.insertOne({
      restaurant: new mongoose.Types.ObjectId(String(restaurant._id)),
      code: 'legacy-toggle', name: 'Legacy Toggle', active: true, sortOrder: 5,
      isDefault: false, categories: []
    });

    const res = await request(`/api/kitchen/stations/${legacy.insertedId}`, {
      method: 'PATCH', token, body: {active: false}
    });
    assert.equal(res.status, 200);
    assert.equal(
      await readQuotaCounter(restaurant._id, 'stations'), 1,
      'a legacy row released a seat it never consumed — the counter now under-reports'
    );

    // So the ceiling still bites at 2 rather than having been widened to 3.
    assert.equal((await postStation(token, 'real-two')).status, 201);
    assert.equal((await postStation(token, 'real-three')).status, 402);
  });

  it('deactivating a built-in never touches the counter', async () => {
    const {restaurant, token} = await tenantWithLimits('BuiltInToggle', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'mine')).status, 201);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);

    // `grill` is seeded and not the default, so it can be retired.
    const grill = await KitchenStation.findOne({restaurant: restaurant._id, code: 'grill'});
    const res = await request(`/api/kitchen/stations/${grill._id}`, {method: 'DELETE', token});
    assert.equal(res.status, 200);
    assert.equal(
      await readQuotaCounter(restaurant._id, 'stations'), 1,
      'retiring a free built-in must not hand out a paid seat'
    );
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe('P2G.3 · one restaurant cannot consume another\'s station quota', () => {
  it('keeps separate counters under simultaneous bursts', async () => {
    const a = await tenantWithLimits('IsoStnA', {maxStations: 2, maxBranches: 9, maxUsers: 9});
    const b = await tenantWithLimits('IsoStnB', {maxStations: 2, maxBranches: 9, maxUsers: 9});

    await Promise.all([
      ...Array.from({length: 6}, (_, i) => postStation(a.token, `ia${i}`)),
      ...Array.from({length: 6}, (_, i) => postStation(b.token, `ib${i}`))
    ]);

    assert.equal(await customStations(a.restaurant._id), 2, 'tenant A');
    assert.equal(await customStations(b.restaurant._id), 2, 'tenant B');
    assert.equal(await readQuotaCounter(a.restaurant._id, 'stations'), 2);
    assert.equal(await readQuotaCounter(b.restaurant._id, 'stations'), 2);
  });

  it('exhausting one tenant does not refuse the other', async () => {
    const a = await tenantWithLimits('DrainStnA', {maxStations: 1, maxBranches: 9, maxUsers: 9});
    const b = await tenantWithLimits('DrainStnB', {maxStations: 3, maxBranches: 9, maxUsers: 9});

    assert.equal((await postStation(a.token, 'a-only')).status, 201);
    assert.equal((await postStation(a.token, 'a-extra')).status, 402);

    for (const code of ['b1', 'b2', 'b3']) {
      assert.equal((await postStation(b.token, code)).status, 201, code);
    }
    assert.equal(await customStations(b.restaurant._id), 3);
  });
});

// ── existing behaviour must be intact ────────────────────────────────────────

describe('P2G.3 · existing station behaviour is unchanged', () => {
  it('still enforces authorization on create', async () => {
    const {branch, restaurant} = await tenantWithLimits('AuthStn', {
      maxStations: 5, maxBranches: 9, maxUsers: 9
    });
    const staff = await User.create({
      name: 'Staff', email: `staff-${Math.random().toString(36).slice(2)}@p2g3.test`,
      password: 'x', role: 'staff', restaurantId: restaurant._id, branch: branch._id
    });
    const res = await postStation(tokenFor(staff), 'not-allowed');
    assert.equal(res.status, 403, 'a quota must not have replaced the permission check');
    assert.equal(await customStations(restaurant._id), 0);
    // A rejected request must not have burnt a seat either.
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), null);
  });

  it('still validates the station code, before reserving anything', async () => {
    const {restaurant, token} = await tenantWithLimits('ValidStn', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'Bad Code!')).status, 400);
    assert.equal((await postStation(token, '')).status, 400);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), null);

    assert.equal((await postStation(token, 'good-code')).status, 201);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 1);
  });

  it('still refuses to deactivate the default station', async () => {
    const {restaurant, token} = await tenantWithLimits('DefaultStn', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    await request('/api/kitchen/stations', {token});
    const def = await KitchenStation.findOne({restaurant: restaurant._id, isDefault: true});
    const res = await request(`/api/kitchen/stations/${def._id}`, {method: 'DELETE', token});
    assert.equal(res.status, 409);
    assert.equal((await KitchenStation.findById(def._id)).active, true);
  });

  it('still routes, lists and resolves stations as before', async () => {
    const {restaurant, token} = await tenantWithLimits('ListStn', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'pasta', 'Pasta Bar')).status, 201);

    const listed = await request('/api/kitchen/stations', {token});
    assert.equal(listed.status, 200);
    assert.equal(listed.body.stations.length, BUILT_INS + 1);
    assert.ok(listed.body.codes.includes('pasta'));

    const service = await listStations({restaurantId: restaurant._id, includeInactive: true});
    assert.equal(service.length, BUILT_INS + 1);
  });

  it('preserves the transaction: a failed audit write rolls the station back', async () => {
    /**
     * The route writes the station and its audit row in ONE transaction. That
     * atomicity predates this phase and must survive it — so must the seat.
     */
    const {restaurant, token} = await tenantWithLimits('TxnStn', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    const {Audit} = await import('../src/models/index.js');
    const original = Audit.create.bind(Audit);
    let armed = false;
    Audit.create = async function patched(...args) {
      if (armed) {
        armed = false;
        throw new Error('audit exploded');
      }
      return original(...args);
    };
    try {
      armed = true;
      const res = await postStation(token, 'rolled-back');
      assert.equal(res.status, 500);
    } finally {
      Audit.create = original;
    }

    assert.equal(
      await KitchenStation.countDocuments({restaurant: restaurant._id, code: 'rolled-back'}), 0,
      'the station survived a failed audit write — the transaction was weakened'
    );
    /**
     * `null`, not 0. My first assertion expected 0 and was simply wrong: this
     * tenant has never completed a create, and the whole transaction — the
     * counter upsert included — was rolled back, so no counter DOCUMENT exists
     * to hold a zero. `readQuotaCounter` returns null for "no row". That the
     * upsert vanished with the abort is itself the proof the reservation is
     * genuinely inside the transaction.
     */
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), null);
    // Both seats remain available.
    assert.equal((await postStation(token, 'after-a')).status, 201);
    assert.equal((await postStation(token, 'after-b')).status, 201);
  });

  it('does not enforce, or write a counter, when enforcement is off', async () => {
    const {restaurant, token} = await tenantWithLimits('OffStn', {
      maxStations: 1, maxBranches: 9, maxUsers: 9
    });
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      process.env.BILLING_ENFORCEMENT = 'off';
      __resetBillingEnforcementProbe();
      for (let i = 0; i < 4; i += 1) {
        assert.equal((await postStation(token, `off${i}`)).status, 201);
      }
      assert.equal(await customStations(restaurant._id), 4);
      assert.equal(await readQuotaCounter(restaurant._id, 'stations'), null);
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });

  it('reports station usage in the subscription summary instead of null', async () => {
    const {restaurant, token} = await tenantWithLimits('SummaryStn', {
      maxStations: 4, maxBranches: 9, maxUsers: 9
    });
    assert.equal((await postStation(token, 'sum-a')).status, 201);
    assert.equal((await postStation(token, 'sum-b')).status, 201);

    const summary = await getUsageSummary(restaurant._id);
    // Was hardcoded `null` before P2G.3 because nothing counted stations.
    assert.equal(summary.maxStations, 2);
  });

  it('the service path is protected too, not only the route', async () => {
    const {restaurant, owner} = await tenantWithLimits('SvcStn', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    const user = {id: String(owner._id), role: 'owner'};
    await createStation({restaurantId: restaurant._id, input: {code: 'svc-a', name: 'A'}, user});
    await createStation({restaurantId: restaurant._id, input: {code: 'svc-b', name: 'B'}, user});
    await assert.rejects(
      () => createStation({restaurantId: restaurant._id, input: {code: 'svc-c', name: 'C'}, user}),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, 'RESOURCE_LIMIT_REACHED');
        return true;
      }
    );
    assert.equal(await customStations(restaurant._id), 2);
  });

  it('sessionless service callers still release a leaked seat on failure', async () => {
    /**
     * `withQuota` skips its compensating release only when a session is
     * present. Called WITHOUT one — as `createStation` allows — the explicit
     * release must still happen, because no transaction will undo anything.
     */
    const {restaurant, owner} = await tenantWithLimits('SvcLeak', {
      maxStations: 2, maxBranches: 9, maxUsers: 9
    });
    const user = {id: String(owner._id), role: 'owner'};
    await createStation({restaurantId: restaurant._id, input: {code: 'leak-a', name: 'A'}, user});

    const original = KitchenStation.create.bind(KitchenStation);
    let armed = false;
    KitchenStation.create = async function patched(...args) {
      if (armed) {
        armed = false;
        throw new Error('insert exploded');
      }
      return original(...args);
    };
    try {
      armed = true;
      await assert.rejects(() => createStation({
        restaurantId: restaurant._id, input: {code: 'leak-b', name: 'B'}, user
      }));
    } finally {
      KitchenStation.create = original;
    }

    assert.equal(
      await readQuotaCounter(restaurant._id, 'stations'), 1,
      'a sessionless failure leaked its reservation'
    );
    await createStation({restaurantId: restaurant._id, input: {code: 'leak-c', name: 'C'}, user});
    assert.equal(await customStations(restaurant._id), 2);
  });
});

// ── earlier phases must not have moved ───────────────────────────────────────

describe('P2G.3 · the P2G.1 and P2G.2 quotas are untouched', () => {
  it('stations use their own counter and consume no other quota', async () => {
    const {restaurant, token} = await tenantWithLimits('MixStn', {
      maxStations: 2, maxMenuItems: 2, maxUsers: 2, maxStaff: 2, maxBranches: 9
    });
    assert.equal((await postStation(token, 'mix-a')).status, 201);
    assert.equal((await postStation(token, 'mix-b')).status, 201);

    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 2);
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), null);
    assert.equal(await readQuotaCounter(restaurant._id, 'users'), null);

    // And the menu-item ceiling still behaves exactly as P2G.2 left it.
    const {createMenuItem} = await import('../src/services/recipes.js');
    const owner = await User.findOne({restaurantId: restaurant._id, role: 'owner'});
    const asOwner = {id: String(owner._id), role: 'owner'};
    await createMenuItem({input: {name: 'Mix Momo', price: 100}, user: asOwner, principal: null});
    await createMenuItem({input: {name: 'Mix Sekuwa', price: 100}, user: asOwner, principal: null});
    await assert.rejects(() => createMenuItem({
      input: {name: 'Mix Third', price: 100}, user: asOwner, principal: null
    }), error => {
      assert.equal(error.status, 402);
      return true;
    });
    assert.equal(await readQuotaCounter(restaurant._id, 'menuItems'), 2);
    assert.equal(await readQuotaCounter(restaurant._id, 'stations'), 2);
  });
});
