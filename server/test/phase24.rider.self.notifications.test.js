import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {User} from '../src/models/index.js';
import {Branch, Notification, Restaurant} from '../src/models/operations.js';
import {notify} from '../src/services/notifications.js';
import {BUILTIN_ROLES, PERMISSION_CATALOG} from '../src/services/permissions.js';

/**
 * Phase 24 — rider self-scoped notifications.
 *
 * A rider is addressed `delivery_update` notifications personally, but could
 * not open a notification centre: `notifications.view` is BRANCH-scoped and
 * returns the branch's payment, refund, purchasing and inventory rows, so
 * granting it to a courier would have been a privilege escalation dressed up
 * as a UI fix.
 *
 * The answer is a separate, narrower capability — `notifications.mine` — and a
 * separate route tree whose query is pinned to the authenticated user's own
 * id. These tests are about proving the narrowness, not the feature: almost
 * every case below is an assertion that something is NOT readable.
 *
 * Every important assertion checks the DATABASE, not just the status code.
 */

let world;
let baseUrl;
let riderA;
let riderB;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const a = () => tokenFor(riderA);
const b = () => tokenFor(riderB);

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  riderA = await User.create({
    name: 'Rider A', email: 'ridera@test.com', password: 'x', role: 'rider',
    restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active: true, available: true}
  });
  riderB = await User.create({
    name: 'Rider B', email: 'riderb@test.com', password: 'x', role: 'rider',
    restaurantId: world.restaurant._id, branch: world.branchB._id,
    rider: {active: true, available: true}
  });
});

/** A notification addressed to one person. */
const personal = (user, title, type = 'delivery_update', branch = world.branchA._id) => notify({
  type, restaurant: world.restaurant._id, branch, user: user._id, title
});

/** A branch-audience notification: nobody in particular. */
const branchWide = (title, type = 'payment_received', branch = world.branchA._id) => notify({
  type, restaurant: world.restaurant._id, branch, title
});

// ── the capability itself ────────────────────────────────────────────────────

describe('Phase 24 · the self-scoped capability', () => {
  it('is a distinct permission and riders do NOT hold notifications.view', () => {
    const riderPermissions = [...BUILTIN_ROLES.rider.permissions];
    assert.ok(riderPermissions.includes('notifications.mine'), 'rider holds the self-scoped key');
    assert.ok(!riderPermissions.includes('notifications.view'),
      'a rider must NEVER hold the branch-scoped notification permission');
    assert.deepEqual(riderPermissions.sort(), ['deliveries.ride', 'notifications.mine']);
  });

  it('keeps notifications.view semantics unchanged for staff roles', () => {
    // Regression: the fix must not have moved anybody else's cheese.
    for (const role of ['manager', 'staff']) {
      const permissions = [...BUILTIN_ROLES[role].permissions];
      assert.ok(permissions.includes('notifications.view'), `${role} keeps notifications.view`);
      assert.ok(!permissions.includes('notifications.mine'),
        `${role} does not need the rider self-scope`);
    }
  });

  it('registers the permission in the catalogue under the naming convention', () => {
    const entry = PERMISSION_CATALOG.find(p => p.key === 'notifications.mine');
    assert.ok(entry, 'catalogued');
    assert.match(entry.key, /^[a-z]+\.[a-z]+$/, 'resource.action, two segments');
    assert.ok(entry.label && entry.group);
  });
});

// ── 1, 6: a rider reads and acknowledges their own ───────────────────────────

describe('Phase 24 · a rider reads their own inbox', () => {
  it('1. Rider A can read Rider A notifications', async () => {
    const row = await personal(riderA, 'RIDER-A-JOB-1');
    await personal(riderA, 'RIDER-A-JOB-2');
    assert.ok(row);

    const res = await request('/api/notifications/mine', {token: a()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'self');
    assert.equal(res.body.notifications.length, 2);
    assert.equal(res.body.unreadCount, 2);
    assert.equal(res.body.pagination.total, 2);
    // Newest first, and the payload carries what the brief requires.
    const first = res.body.notifications[0];
    assert.equal(first.title, 'RIDER-A-JOB-2');
    assert.equal(first.type, 'delivery_update');
    assert.equal(String(first.user), String(riderA._id), 'recipient user');
    assert.equal(String(first.branch), String(world.branchA._id), 'branch');
    assert.equal(first.read, false, 'read/unread state');
    assert.ok(first.createdAt, 'created timestamp');
    assert.ok('reference' in first, 'entity reference');

    // DATABASE: exactly the two rows exist and both belong to rider A.
    const stored = await Notification.find({user: riderA._id}).lean();
    assert.equal(stored.length, 2);
    for (const doc of stored) assert.equal(String(doc.user), String(riderA._id));

    const count = await request('/api/notifications/mine/unread-count', {token: a()});
    assert.equal(count.status, 200);
    assert.equal(count.body.unread, 2);
  });

  it('6. Rider A can mark their own notification as read', async () => {
    const row = await personal(riderA, 'RIDER-A-JOB');
    const res = await request(`/api/notifications/mine/${row._id}/read`, {
      method: 'PATCH', token: a(), body: {}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.read, true);

    // DATABASE, not merely the response body.
    assert.equal((await Notification.findById(row._id).lean()).read, true);
    assert.equal((await request('/api/notifications/mine/unread-count', {token: a()})).body.unread, 0);

    // And back again, so the tab really is a toggle over stored state.
    const undone = await request(`/api/notifications/mine/${row._id}/read`, {
      method: 'PATCH', token: a(), body: {read: false}
    });
    assert.equal(undone.body.read, false);
    assert.equal((await Notification.findById(row._id).lean()).read, false);
  });

  it('marks all of their own read without touching anybody else', async () => {
    await personal(riderA, 'A-1');
    await personal(riderA, 'A-2');
    const other = await personal(riderB, 'B-1', 'delivery_update', world.branchB._id);
    const branchRow = await branchWide('BRANCH-MONEY');

    const res = await request('/api/notifications/mine/read-all', {
      method: 'POST', token: a(), body: {}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.updated, 2, 'only their own two');
    assert.equal(res.body.unread, 0);

    // DATABASE: everyone else's rows are untouched.
    assert.equal(await Notification.countDocuments({user: riderA._id, read: false}), 0);
    assert.equal((await Notification.findById(other._id).lean()).read, false,
      "rider B's notification must not be marked read by rider A");
    assert.equal((await Notification.findById(branchRow._id).lean()).read, false,
      'a branch notification must not be marked read by a rider');

    // Idempotent.
    const again = await request('/api/notifications/mine/read-all', {method: 'POST', token: a(), body: {}});
    assert.equal(again.body.updated, 0);
  });

  it('filters unread/read and paginates within the self scope', async () => {
    for (let i = 0; i < 6; i += 1) await personal(riderA, `A-${i}`);
    await personal(riderB, 'B-1', 'delivery_update', world.branchB._id);

    const page1 = await request('/api/notifications/mine?limit=4&page=1', {token: a()});
    const page2 = await request('/api/notifications/mine?limit=4&page=2', {token: a()});
    assert.equal(page1.body.notifications.length, 4);
    assert.equal(page2.body.notifications.length, 2, "rider B's row must not appear on page 2");
    const ids = new Set([...page1.body.notifications, ...page2.body.notifications].map(n => String(n._id)));
    assert.equal(ids.size, 6, 'pages must not overlap');
    for (const row of [...page1.body.notifications, ...page2.body.notifications]) {
      assert.equal(String(row.user), String(riderA._id));
    }

    const target = page1.body.notifications[0];
    await request(`/api/notifications/mine/${target._id}/read`, {method: 'PATCH', token: a(), body: {}});
    assert.equal((await request('/api/notifications/mine?unread=true', {token: a()})).body.pagination.total, 5);
    assert.equal((await request('/api/notifications/mine?unread=false', {token: a()})).body.pagination.total, 1);
  });
});

// ── 2, 3, 4, 10: everything a rider must NOT read ────────────────────────────

describe('Phase 24 · what a rider must never read', () => {
  it('2. Rider A cannot read Rider B notifications', async () => {
    const mine = await personal(riderA, 'MINE');
    const theirs = await personal(riderB, 'RIDER-B-PRIVATE', 'delivery_update', world.branchB._id);

    const res = await request('/api/notifications/mine', {token: a()});
    assert.equal(res.status, 200);
    const titles = res.body.notifications.map(n => n.title);
    assert.deepEqual(titles, ['MINE']);
    assert.ok(!titles.includes('RIDER-B-PRIVATE'));

    // DATABASE: rider B's row genuinely exists — the absence above is scoping,
    // not a missing fixture.
    const stored = await Notification.findById(theirs._id).lean();
    assert.ok(stored, "rider B's notification exists in the database");
    assert.equal(String(stored.user), String(riderB._id));
    assert.notEqual(String(stored.user), String(mine.user));
  });

  it('3. Rider A cannot read branch-wide notifications', async () => {
    const branchRow = await branchWide('BRANCH-WIDE-ORDER', 'new_order');
    // Same branch as rider A, and unaddressed, so only the `user` pin excludes it.
    assert.equal(String(branchRow.branch), String(world.branchA._id));
    assert.equal(branchRow.user, undefined);

    const res = await request('/api/notifications/mine', {token: a()});
    assert.equal(res.body.notifications.length, 0);
    assert.equal(res.body.unreadCount, 0);

    // CONTROL: staff in that branch DO see it, proving the row is visible to
    // somebody and the rider's empty inbox is the scope working.
    const staffView = await request('/api/notifications', {token: staff()});
    assert.equal(staffView.status, 200);
    assert.ok(staffView.body.notifications.some(n => n.title === 'BRANCH-WIDE-ORDER'));
  });

  it('4. Rider A cannot read payment/refund notifications intended for staff', async () => {
    await branchWide('PAYMENT-RS-40000', 'payment_received');
    await branchWide('REFUND-RS-9000', 'refund_issued');
    await branchWide('PO-NEEDS-APPROVAL', 'po_approval_required');
    await branchWide('COUNT-SUBMITTED', 'inventory_count_submitted');
    await notify({
      type: 'supplier_invoice_due', restaurant: world.restaurant._id,
      branch: world.branchA._id, title: 'INVOICE-OVERDUE'
    });
    await personal(riderA, 'YOUR-DELIVERY');

    const res = await request('/api/notifications/mine', {token: a()});
    assert.equal(res.body.notifications.length, 1, 'only their own delivery job');
    assert.equal(res.body.notifications[0].title, 'YOUR-DELIVERY');
    assert.equal(res.body.notifications[0].type, 'delivery_update');

    // Even asked for by name, a sensitive type must not surface.
    for (const type of ['payment_received', 'refund_issued', 'po_approval_required',
      'inventory_count_submitted', 'supplier_invoice_due']) {
      const asked = await request(`/api/notifications/mine?type=${type}`, {token: a()});
      assert.equal(asked.status, 200);
      assert.equal(asked.body.notifications.length, 0, `${type} must not be readable by a rider`);
      assert.equal(asked.body.pagination.total, 0);
    }

    // DATABASE: those five rows exist and are addressed to nobody.
    assert.equal(await Notification.countDocuments({user: {$exists: false}}), 5);
  });

  it('10. cross-branch and cross-tenant notification access is rejected', async () => {
    // Another branch of the SAME restaurant, addressed to nobody.
    await branchWide('BRANCH-B-MONEY', 'payment_received', world.branchB._id);
    // Another branch, addressed to a different rider.
    await personal(riderB, 'BRANCH-B-RIDER-JOB', 'delivery_update', world.branchB._id);
    // A different tenant entirely, addressed to a rider with the same role.
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVL'});
    const rivalRider = await User.create({
      name: 'Rival Rider', email: 'rivalrider@test.com', password: 'x', role: 'rider',
      restaurantId: rival._id, branch: rivalBranch._id, rider: {active: true, available: true}
    });
    await notify({
      type: 'delivery_update', restaurant: rival._id, branch: rivalBranch._id,
      user: rivalRider._id, title: 'RIVAL-CONFIDENTIAL'
    });

    const res = await request('/api/notifications/mine', {token: a()});
    assert.equal(res.body.notifications.length, 0);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('BRANCH-B'), 'no other branch data');
    assert.ok(!body.includes('RIVAL-CONFIDENTIAL'), 'no other tenant data');

    // The rival's own rider still reads their own — the scope is per user, not
    // a blanket denial.
    const rivalView = await request('/api/notifications/mine', {token: tokenFor(rivalRider)});
    assert.equal(rivalView.status, 200);
    assert.equal(rivalView.body.notifications.length, 1);
    assert.equal(rivalView.body.notifications[0].title, 'RIVAL-CONFIDENTIAL');

    // A branch filter is not even accepted as an input on this route, so it
    // cannot be used to widen or pivot the scope.
    const pivot = await request(`/api/notifications/mine?branch=${world.branchB._id}`, {token: a()});
    assert.equal(pivot.status, 200);
    assert.equal(pivot.body.notifications.length, 0, 'a branch query param must not widen the scope');
  });
});

// ── 5, 7: writes ─────────────────────────────────────────────────────────────

describe('Phase 24 · a rider cannot modify anybody else', () => {
  it('5 & 7. Rider A cannot mark another user\'s notification as read', async () => {
    const riderBRow = await personal(riderB, 'B-PRIVATE', 'delivery_update', world.branchB._id);
    const branchRow = await branchWide('BRANCH-PAYMENT', 'payment_received');
    const managerRow = await personal(world.manager, 'MANAGER-PRIVATE', 'payment_received');

    for (const [label, row] of [
      ['another rider', riderBRow], ['a branch notification', branchRow], ['a manager', managerRow]
    ]) {
      const res = await request(`/api/notifications/mine/${row._id}/read`, {
        method: 'PATCH', token: a(), body: {}
      });
      // 404, not 403: a distinguishable answer would confirm the row exists.
      assert.equal(res.status, 404, `${label}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.message, /not found/i);
      // DATABASE: genuinely unchanged.
      assert.equal((await Notification.findById(row._id).lean()).read, false,
        `${label} must remain unread`);
    }

    // CONTROL: the identical call against their OWN row succeeds, so the 404s
    // above are authorisation and not a broken route.
    const own = await personal(riderA, 'A-PRIVATE');
    const ok = await request(`/api/notifications/mine/${own._id}/read`, {
      method: 'PATCH', token: a(), body: {}
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await Notification.findById(own._id).lean()).read, true);
  });

  it('cannot author a notification for anybody, including itself', async () => {
    // There is deliberately no write endpoint; forging "payment received" into
    // an inbox must be impossible.
    for (const path of ['/api/notifications', '/api/notifications/mine']) {
      const res = await request(path, {
        method: 'POST', token: a(),
        body: {type: 'payment_received', title: 'FORGED', user: String(riderA._id)}
      });
      assert.ok([403, 404, 405].includes(res.status), `${path} -> ${res.status}`);
    }
    assert.equal(await Notification.countDocuments({title: 'FORGED'}), 0);
  });
});

// ── 8, 9: authentication and role ────────────────────────────────────────────

describe('Phase 24 · authentication and role', () => {
  it('8. an anonymous request is 401', async () => {
    for (const [method, path] of [
      ['GET', '/api/notifications/mine'],
      ['GET', '/api/notifications/mine/unread-count'],
      ['POST', '/api/notifications/mine/read-all'],
      ['PATCH', `/api/notifications/mine/${new mongoose.Types.ObjectId()}/read`]
    ]) {
      const res = await request(path, {method, ...(method === 'GET' ? {} : {body: {}})});
      assert.equal(res.status, 401, `${method} ${path} -> ${res.status}`);
    }
  });

  it('rejects a token whose session has been revoked', async () => {
    const row = await personal(riderA, 'A-JOB');
    const stale = tokenFor(riderA);
    await User.updateOne({_id: riderA._id}, {$inc: {sessionVersion: 1}});
    const res = await request('/api/notifications/mine', {token: stale});
    assert.equal(res.status, 401, JSON.stringify(res.body));
    // The row is still there; it is the session that died, not the data.
    assert.ok(await Notification.findById(row._id).lean());
  });

  it('rejects a deactivated rider', async () => {
    await personal(riderA, 'A-JOB');
    await User.updateOne({_id: riderA._id}, {$set: {active: false}});
    const res = await request('/api/notifications/mine', {token: a()});
    assert.ok([401, 403].includes(res.status), `deactivated rider -> ${res.status}`);
  });

  it('9. a role without notifications.mine is denied', async () => {
    // Staff and manager hold `notifications.view`, not the self scope. The
    // denial proves the two are genuinely separate capabilities rather than
    // one permission wearing two names.
    for (const [label, token] of [['staff', staff()], ['manager', manager()]]) {
      const res = await request('/api/notifications/mine', {token});
      assert.equal(res.status, 403, `${label} -> ${res.status}`);
      assert.match(res.body.message, /permission/i);
    }
  });

  it('9c. the owner reaches the route by holding * but still sees only their own', async () => {
    /**
     * An owner holds `*` implicitly, so `requirePermission('notifications.mine')`
     * admits them. That is the existing permission model, not a new hole, and
     * it grants NOTHING: the route is self-scoped, so an owner calling it gets
     * only rows addressed to the owner personally — strictly LESS than the
     * branch inbox they already hold. Asserted rather than assumed, because
     * "the owner can reach it" is exactly the kind of thing that quietly stops
     * being harmless.
     */
    await personal(riderA, 'RIDER-A-PRIVATE');
    await personal(world.manager, 'MANAGER-PRIVATE', 'payment_received');
    const ownerRow = await personal(world.owner, 'OWNER-PRIVATE', 'payment_received');
    await branchWide('BRANCH-PAYMENT', 'payment_received');

    const res = await request('/api/notifications/mine', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'self');
    assert.equal(res.body.notifications.length, 1, 'the owner sees only their own');
    assert.equal(String(res.body.notifications[0]._id), String(ownerRow._id));
    assert.equal(String(res.body.notifications[0].user), String(world.owner._id));

    // Not the rider's, not the manager's, not the branch's.
    const body = JSON.stringify(res.body);
    for (const title of ['RIDER-A-PRIVATE', 'MANAGER-PRIVATE', 'BRANCH-PAYMENT']) {
      assert.ok(!body.includes(title), `${title} must not appear in a self-scoped response`);
    }
  });

  it('9b. a rider is still denied the branch-scoped endpoints', async () => {
    // The whole point: adding the self scope must not have opened the branch
    // inbox to riders by a side door.
    await branchWide('BRANCH-PAYMENT', 'payment_received');
    for (const [method, path] of [
      ['GET', '/api/notifications'],
      ['GET', '/api/notifications/unread-count'],
      ['GET', '/api/notifications/types'],
      ['POST', '/api/notifications/read-all'],
      ['POST', '/api/notifications/sweep/supplier-invoices']
    ]) {
      const res = await request(path, {method, token: a(), ...(method === 'GET' ? {} : {body: {}})});
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
    }
    // DATABASE: the branch row is still unread — read-all did not run.
    assert.equal(await Notification.countDocuments({read: false, title: 'BRANCH-PAYMENT'}), 1);
  });
});

// ── IDOR / BOLA ──────────────────────────────────────────────────────────────

describe('Phase 24 · IDOR and BOLA', () => {
  it('ignores every client-supplied identity parameter', async () => {
    await personal(riderA, 'A-OWN');
    await personal(riderB, 'B-OWN', 'delivery_update', world.branchB._id);
    await personal(world.manager, 'MANAGER-OWN', 'payment_received');

    /**
     * The authenticated identity must always win. If any of these were read as
     * authority, rider A would see rider B's or the manager's row.
     */
    for (const query of [
      `userId=${riderB._id}`, `user=${riderB._id}`, `riderId=${riderB._id}`,
      `recipientId=${riderB._id}`, `userId=${world.manager._id}`,
      `user_id=${riderB._id}`, `id=${riderB._id}`,
      `userId[]=${riderB._id}&userId[]=${riderA._id}`,
      `userId[$ne]=${riderA._id}`, `user[$exists]=true`, `read[$ne]=true`
    ]) {
      const res = await request(`/api/notifications/mine?${query}`, {token: a()});
      assert.equal(res.status, 200, `${query} -> ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.notifications.length, 1, `${query} widened the scope`);
      assert.equal(res.body.notifications[0].title, 'A-OWN', `${query} pivoted the scope`);
      assert.equal(String(res.body.notifications[0].user), String(riderA._id));
    }
  });

  it('ignores identity claims smuggled into the JWT itself', async () => {
    /**
     * The strongest version of the attack. `req.user` is built by spreading the
     * whole JWT payload, so any extra claim is visible to the handler. If the
     * self scope ever read a `userId`/`riderId`/`recipientId` claim instead of
     * resolving the row from `id`, a token carrying one would pivot the inbox.
     *
     * Mutation testing caught this: adding `if (user?.userId) scope.userId =
     * user.userId` survived the whole suite, because nothing sent such a claim.
     * The identity must come from storage, keyed by `id`, and nothing else.
     */
    await personal(riderA, 'A-OWN');
    await personal(riderB, 'B-OWN', 'delivery_update', world.branchB._id);
    await personal(world.manager, 'MANAGER-OWN', 'payment_received');

    for (const claim of ['userId', 'riderId', 'recipientId', 'user', 'sub', '_id']) {
      const forged = tokenFor(riderA, {[claim]: String(riderB._id)});
      const res = await request('/api/notifications/mine', {token: forged});
      assert.equal(res.status, 200, `${claim} -> ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.notifications.length, 1, `a forged ${claim} claim widened the scope`);
      assert.equal(res.body.notifications[0].title, 'A-OWN', `a forged ${claim} claim pivoted the scope`);
      assert.equal(String(res.body.notifications[0].user), String(riderA._id));
    }

    // The same for a write: a forged claim must not redirect the update.
    const theirs = await Notification.findOne({title: 'B-OWN'}).lean();
    const forgedWrite = tokenFor(riderA, {userId: String(riderB._id)});
    const patch = await request(`/api/notifications/mine/${theirs._id}/read`, {
      method: 'PATCH', token: forgedWrite, body: {}
    });
    assert.equal(patch.status, 404);
    assert.equal((await Notification.findById(theirs._id).lean()).read, false);
  });

  it('ignores an identity supplied in the body of a write', async () => {
    const own = await personal(riderA, 'A-OWN');
    const theirs = await personal(riderB, 'B-OWN', 'delivery_update', world.branchB._id);

    // A body that names somebody else must not redirect the write. The schema
    // is `.strict()`, so an unknown key is rejected outright rather than
    // silently ignored — either answer is safe, but the row must not change.
    const res = await request(`/api/notifications/mine/${own._id}/read`, {
      method: 'PATCH', token: a(), body: {read: true, user: String(riderB._id), userId: String(riderB._id)}
    });
    // `.strict()` rejects the unknown keys outright: a 400, not a silent
    // ignore. This router used to map a ZodError to 500 "Server error"; found
    // by this test and fixed to match the deliveries router.
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /invalid user|missing or invalid/i);
    assert.equal((await Notification.findById(own._id).lean()).read, false,
      'a rejected write must not have applied');
    assert.equal((await Notification.findById(theirs._id).lean()).read, false,
      "rider B's row must be untouched whatever the body claimed");

    const readAll = await request('/api/notifications/mine/read-all', {
      method: 'POST', token: a(), body: {userId: String(riderB._id), branch: String(world.branchB._id)}
    });
    assert.equal(readAll.status, 200, JSON.stringify(readAll.body));
    assert.equal((await Notification.findById(theirs._id).lean()).read, false,
      'a body-supplied branch or user must not widen mark-all-read');
  });

  it('does not follow a user who is moved to another restaurant', async () => {
    /**
     * DEFENCE IN DEPTH, proven rather than assumed.
     *
     * `user` alone would normally be enough — two users in different tenants
     * have different ids. The `restaurant` pin matters when a USER moves: their
     * old inbox must not travel with them. Mutation testing showed that
     * dropping the tenant pin otherwise survives, so this is the case that
     * makes it load-bearing.
     */
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVL'});
    // A row addressed to rider A but belonging to the OTHER restaurant.
    const stray = await notify({
      type: 'delivery_update', restaurant: rival._id, branch: rivalBranch._id,
      user: riderA._id, title: 'STRAY-OTHER-TENANT'
    });
    await personal(riderA, 'MINE-HERE');

    const res = await request('/api/notifications/mine', {token: a()});
    assert.equal(res.body.notifications.length, 1, 'only the current tenant');
    assert.equal(res.body.notifications[0].title, 'MINE-HERE');
    assert.equal(res.body.unreadCount, 1);

    // DATABASE: the stray row exists and is addressed to this very rider — the
    // exclusion is the tenant pin, not a missing fixture.
    const stored = await Notification.findById(stray._id).lean();
    assert.ok(stored);
    assert.equal(String(stored.user), String(riderA._id));
    assert.notEqual(String(stored.restaurant), String(world.restaurant._id));

    // It also cannot be marked read across the tenant boundary.
    const patch = await request(`/api/notifications/mine/${stray._id}/read`, {
      method: 'PATCH', token: a(), body: {}
    });
    assert.equal(patch.status, 404);
    assert.equal((await Notification.findById(stray._id).lean()).read, false);

    // Nor swept up by mark-all-read.
    await request('/api/notifications/mine/read-all', {method: 'POST', token: a(), body: {}});
    assert.equal((await Notification.findById(stray._id).lean()).read, false,
      'mark-all-read must not cross the tenant boundary');
  });

  it('does not leak the existence of another user\'s notification', async () => {
    const theirs = await personal(riderB, 'B-OWN', 'delivery_update', world.branchB._id);
    const missing = new mongoose.Types.ObjectId();

    const existing = await request(`/api/notifications/mine/${theirs._id}/read`, {
      method: 'PATCH', token: a(), body: {}
    });
    const absent = await request(`/api/notifications/mine/${missing}/read`, {
      method: 'PATCH', token: a(), body: {}
    });
    // Identical answers: an attacker cannot distinguish "exists but not yours"
    // from "does not exist", so the endpoint is not an existence oracle.
    assert.equal(existing.status, absent.status);
    assert.deepEqual(existing.body, absent.body);
    assert.equal(existing.status, 404);
  });

  it('rejects a malformed notification id without a cast error', async () => {
    const res = await request('/api/notifications/mine/not-an-object-id/read', {
      method: 'PATCH', token: a(), body: {}
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /invalid notification/i);
  });
});

// ── 11, 12: Socket.IO ────────────────────────────────────────────────────────

describe('Phase 24 · realtime isolation', () => {
  const connect = (token, branch) => new Promise((resolve, reject) => {
    import('socket.io-client').then(({io: ioClient}) => {
      const socket = ioClient(baseUrl, {
        auth: {token, ...(branch ? {branch: String(branch)} : {})},
        transports: ['websocket'], forceNew: true, reconnection: false
      });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 4000);
    }).catch(reject);
  });

  it('11 & 12. rider A receives their own notification and never rider B\'s', async () => {
    /**
     * SECURITY FIX, reproduced before it was made.
     *
     * A notification addressed to one user was emitted to the RESTAURANT room
     * with a `user` field for the client to filter on. Probed directly: a
     * private "PRIVATE-RIDER-A-JOB" arrived on a branch STAFF socket, while
     * rider A received nothing at all — riders never join the restaurant room.
     * Client-side filtering is not an authorisation boundary. It now goes to
     * `user:<id>` only.
     */
    const socketA = await connect(a());
    const socketB = await connect(b());
    const staffSocket = await connect(staff(), world.branchA._id);
    try {
      const seenA = [];
      const seenB = [];
      const seenStaff = [];
      socketA.on('inventory:alert', p => seenA.push(p.title));
      socketB.on('inventory:alert', p => seenB.push(p.title));
      staffSocket.on('inventory:alert', p => seenStaff.push(p.title));

      await personal(riderA, 'PRIVATE-RIDER-A-JOB');
      await settle(500);

      assert.deepEqual(seenA, ['PRIVATE-RIDER-A-JOB'], 'the addressed rider must receive it');
      assert.deepEqual(seenB, [], 'rider B must receive nothing');
      assert.deepEqual(seenStaff, [],
        'a personally addressed notification must not reach a branch staff socket');

      // DATABASE: one row, addressed to rider A.
      const rows = await Notification.find({title: 'PRIVATE-RIDER-A-JOB'}).lean();
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].user), String(riderA._id));
    } finally { socketA.close(); socketB.close(); staffSocket.close(); }
  });

  it('keeps branch-room isolation unchanged', async () => {
    // REGRESSION for Phase 23: a branch-audience notification still reaches
    // that branch and no other, and now also does not spill onto a rider.
    const staffB = await User.findOne({email: 'staffb@test.com'});
    const socketStaffA = await connect(staff(), world.branchA._id);
    const socketStaffB = await connect(tokenFor(staffB), world.branchB._id);
    const socketRider = await connect(a());
    try {
      const join = (socket, branch) =>
        new Promise(resolve => socket.emit('join:branch', String(branch), resolve));
      await join(socketStaffA, world.branchA._id);
      await join(socketStaffB, world.branchB._id);

      const seenA = [];
      const seenB = [];
      const seenRider = [];
      socketStaffA.on('inventory:alert', p => seenA.push(p.title));
      socketStaffB.on('inventory:alert', p => seenB.push(p.title));
      socketRider.on('inventory:alert', p => seenRider.push(p.title));

      await branchWide('BRANCH-A-PAYMENT', 'payment_received');
      await settle(500);

      assert.deepEqual(seenA, ['BRANCH-A-PAYMENT'], 'branch A still receives its own');
      assert.deepEqual(seenB, [], 'branch B still receives nothing');
      assert.deepEqual(seenRider, [], 'a rider must never receive a branch payment notification');
    } finally { socketStaffA.close(); socketStaffB.close(); socketRider.close(); }
  });

  it('never places a rider in the tenant restaurant room', async () => {
    /**
     * The `restaurant:<id>` room is tenant-wide. A rider joining it would
     * receive every tenant-wide signal, and it was the room a private
     * notification used to be broadcast on. Asserted directly through
     * `publishRestaurantEvent` rather than inferred, because after the routing
     * fix nothing in production emits there — so a regression that quietly put
     * riders in the room would otherwise go unnoticed until something did.
     */
    const {publishRestaurantEvent} = await import('../src/services/realtime.js');
    const {REALTIME_EVENTS} = await import('../src/services/realtimeEvents.js');
    const socketRider = await connect(a());
    const socketStaff = await connect(staff(), world.branchA._id);
    try {
      const seenRider = [];
      const seenStaff = [];
      socketRider.on('order:update', p => seenRider.push(p.marker));
      socketStaff.on('order:update', p => seenStaff.push(p.marker));

      publishRestaurantEvent(world.restaurant._id, REALTIME_EVENTS.ORDER_UPDATE, {marker: 'TENANT-WIDE'});
      await settle(400);

      assert.deepEqual(seenStaff, ['TENANT-WIDE'], 'staff are in the restaurant room');
      assert.deepEqual(seenRider, [], 'a rider must never be in the restaurant room');
    } finally { socketRider.close(); socketStaff.close(); }
  });

  it('does not place a rider in a branch or restaurant room even if they ask', async () => {
    // The handshake ignores a requested branch for a rider. Without this, a
    // rider could join a branch room and receive kitchen and stock traffic.
    const socket = await connect(a(), world.branchA._id);
    try {
      const seen = [];
      socket.on('inventory:alert', p => seen.push(p.title));
      socket.on('kitchen:new-order', p => seen.push(p));
      await branchWide('BRANCH-A-ORDER', 'new_order');
      await settle(400);
      assert.deepEqual(seen, [], 'a requested branch must not be honoured for a rider');
    } finally { socket.close(); }
  });
});
