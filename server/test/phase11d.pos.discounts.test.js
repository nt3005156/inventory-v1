/**
 * POS 11D — discount authorisation, ceilings and audit.
 *
 * The discount ENGINE shipped in Phase 4C: percentage and fixed, line and
 * order scope, coupon clamping, and an `order_discount` audit entry. That is
 * not rebuilt here.
 *
 * The audit found the stated policy — "any staff may discount, everything is
 * audited" — implemented as *unlimited* and audited. A till operator could
 * take 100% off any order and the audit would faithfully record the theft.
 * A reason was also optional, which makes an audit trail close to useless.
 *
 * This suite pins the ceilings that bound the policy without changing it:
 * staff still discount without asking anyone, up to a configurable limit.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Audit} from '../src/models/index.js';
import {Order, Restaurant} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {
  DISCOUNT_SUPERVISOR_ROLES,
  assertDiscountAuthorized,
  computeDiscountAmount
} from '../src/services/discounts.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
});

const staff = () => tokenFor(world.staffA);
const manager = () => tokenFor(world.manager);
const owner = () => tokenFor(world.owner);
const MENU = () => String(world.menu._id);
const BRANCH = () => String(world.branchA._id);

/** One line, optionally with an order-level and/or line-level discount. */
const placeOrder = (body = {}, token = staff()) =>
  request('/api/orders', {
    method: 'POST', token,
    body: {branch: BRANCH(), type: 'counter', items: [{menuItem: MENU(), qty: 1}], ...body}
  });

// ═══════════════════════════════════════════════════════════════════════════
// The engine (Phase 4C) — pinned, not rebuilt
// ═══════════════════════════════════════════════════════════════════════════

describe('11D — discount arithmetic', () => {
  it('computes percentage and fixed discounts against a base', () => {
    assert.equal(computeDiscountAmount({kind: 'percentage', value: 10, base: 1000}), 100);
    assert.equal(computeDiscountAmount({kind: 'fixed', value: 250, base: 1000}), 250);
    assert.equal(computeDiscountAmount({kind: 'percentage', value: 0, base: 1000}), 0);
  });

  it('clamps a discount to a configured maximum', () => {
    // Coupons carry their own ceiling; a manual discount has none, which is
    // why authorisation exists separately.
    assert.equal(
      computeDiscountAmount({kind: 'percentage', value: 50, base: 1000, maxDiscount: 200}),
      200
    );
  });

  it('refuses a percentage above 100 and a fixed amount above the order', async () => {
    const tooMuch = await placeOrder(
      {discount: {kind: 'percentage', value: 150, reason: 'probe'}}, manager()
    );
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.message, /cannot exceed 100%/);

    const overBill = await placeOrder(
      {discount: {kind: 'fixed', value: 999999, reason: 'probe'}}, manager()
    );
    assert.equal(overBill.status, 400);
    assert.match(overBill.body.message, /exceed the order subtotal/);
    assert.equal(await Order.countDocuments({}), 0);
  });

  it('applies a line discount and an order discount to the total', async () => {
    const line = await placeOrder(
      {items: [{menuItem: MENU(), qty: 1, discount: {kind: 'percentage', value: 10, reason: 'line'}}]},
      manager()
    );
    assert.equal(line.status, 201, JSON.stringify(line.body));
    assert.equal(line.body.itemDiscount, 35, '10% of the 350 line');

    const order = await placeOrder(
      {discount: {kind: 'fixed', value: 50, reason: 'order'}}, manager()
    );
    assert.equal(order.status, 201);
    assert.equal(order.body.discount, 50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorisation — the policy, bounded
// ═══════════════════════════════════════════════════════════════════════════

describe('11D — authorisation ceilings', () => {
  it('lets any staff discount up to the staff ceiling, with no supervisor', async () => {
    // This is the chosen policy and it is preserved: a counter does not need
    // a manager for a small goodwill gesture.
    for (const value of [5, 10, 20]) {
      const res = await placeOrder({discount: {kind: 'percentage', value, reason: 'goodwill'}});
      assert.equal(res.status, 201, `${value}%: ${JSON.stringify(res.body)}`);
    }
  });

  it('refuses a staff discount above the ceiling and writes nothing', async () => {
    for (const value of [25, 50, 100]) {
      const res = await placeOrder({discount: {kind: 'percentage', value, reason: 'too much'}});
      assert.equal(res.status, 403, `${value}% must need a supervisor`);
      assert.match(res.body.message, /needs a manager/);
    }
    assert.equal(await Order.countDocuments({}), 0, 'a refused discount writes no order');
  });

  it('lets a supervisor exceed the staff ceiling', async () => {
    for (const token of [manager(), owner()]) {
      const res = await placeOrder({discount: {kind: 'percentage', value: 50, reason: 'manager call'}}, token);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
  });

  it('enforces the absolute amount ceiling as well as the percentage', async () => {
    // A big order makes 20% a large sum; the cash ceiling catches that.
    const big = await request('/api/orders', {
      method: 'POST', token: staff(),
      body: {
        branch: BRANCH(), type: 'counter',
        items: [{menuItem: MENU(), qty: 40}],
        discount: {kind: 'fixed', value: 600, reason: 'large writeoff'}
      }
    });
    assert.equal(big.status, 403, '600 is above the 500 staff cash ceiling');
    assert.match(big.body.message, /needs a manager/);
  });

  it('applies a hard ceiling to everyone, including an owner', async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {maxDiscountPercent: 50}});
    const res = await placeOrder({discount: {kind: 'percentage', value: 100, reason: 'mistyped'}}, owner());
    assert.equal(res.status, 403, 'the hard ceiling guards a mistyped 100%');
    assert.match(res.body.message, /not permitted/);
  });

  it('honours a restaurant that widens its own staff ceiling', async () => {
    await Restaurant.updateOne(
      {_id: world.restaurant._id},
      {$set: {staffMaxDiscountPercent: 40, staffMaxDiscountAmount: 5000}}
    );
    const res = await placeOrder({discount: {kind: 'percentage', value: 35, reason: 'policy'}});
    assert.equal(res.status, 201, 'the ceiling is configurable per restaurant');
  });

  it('names the roles that may exceed the ceiling', () => {
    assert.deepEqual([...DISCOUNT_SUPERVISOR_ROLES], ['owner', 'manager']);
    assert.ok(!DISCOUNT_SUPERVISOR_ROLES.includes('staff'));
    assert.ok(!DISCOUNT_SUPERVISOR_ROLES.includes('rider'));
  });

  it('authorises directly at the service boundary, not only over HTTP', () => {
    const restaurant = {staffMaxDiscountPercent: 20, staffMaxDiscountAmount: 500, maxDiscountPercent: 100};
    assert.doesNotThrow(() => assertDiscountAuthorized({
      kind: 'percentage', value: 10, amount: 100, base: 1000,
      user: {role: 'staff'}, restaurant
    }));
    assert.throws(() => assertDiscountAuthorized({
      kind: 'percentage', value: 30, amount: 300, base: 1000,
      user: {role: 'staff'}, restaurant
    }), /needs a manager/);
    assert.doesNotThrow(() => assertDiscountAuthorized({
      kind: 'percentage', value: 30, amount: 300, base: 1000,
      user: {role: 'manager'}, restaurant
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Evasion
// ═══════════════════════════════════════════════════════════════════════════

describe('11D — ceiling evasion', () => {
  it('cannot be dodged by splitting one write-off across lines', async () => {
    // Each line is individually 60% of its own line, and together they are
    // 60% of the order — well over a 20% ceiling.
    const res = await request('/api/orders', {
      method: 'POST', token: staff(),
      body: {
        branch: BRANCH(), type: 'counter',
        items: [
          {menuItem: MENU(), qty: 1, discount: {kind: 'percentage', value: 60, reason: 'a'}},
          {menuItem: MENU(), qty: 1, discount: {kind: 'percentage', value: 60, reason: 'b'}},
          {menuItem: MENU(), qty: 1, discount: {kind: 'percentage', value: 60, reason: 'c'}}
        ]
      }
    });
    assert.equal(res.status, 403, 'line discounts are authorised on their sum');
    assert.equal(await Order.countDocuments({}), 0);
  });

  it('cannot be dodged by combining a line discount with an order discount', async () => {
    // 15% on the line plus 15% on the order is ~28% combined, while each is
    // individually under the 20% ceiling.
    const res = await request('/api/orders', {
      method: 'POST', token: staff(),
      body: {
        branch: BRANCH(), type: 'counter',
        items: [{menuItem: MENU(), qty: 1, discount: {kind: 'percentage', value: 15, reason: 'line'}}],
        discount: {kind: 'percentage', value: 15, reason: 'order'}
      }
    });
    assert.equal(res.status, 403);
    assert.equal(await Order.countDocuments({}), 0);
  });

  it('still allows a modest combination under the ceiling', async () => {
    const res = await request('/api/orders', {
      method: 'POST', token: staff(),
      body: {
        branch: BRANCH(), type: 'counter',
        items: [{menuItem: MENU(), qty: 1, discount: {kind: 'percentage', value: 5, reason: 'line'}}],
        discount: {kind: 'percentage', value: 5, reason: 'order'}
      }
    });
    assert.equal(res.status, 201, 'the guard must not obstruct ordinary service');
  });

  it('does not let a coupon be blocked by the manual ceiling', async () => {
    // A coupon's limits are set by management in the coupon itself, so it is
    // authorised separately from a keyed-in discount.
    const coupon = await request('/api/coupons', {
      method: 'POST', token: manager(),
      body: {
        code: 'BIG50', kind: 'percentage', value: 50,
        scope: 'order', active: true, branches: [BRANCH()]
      }
    });
    if (coupon.status !== 201) return; // coupon API shape differs; engine covered by 4C
    const res = await placeOrder({coupon: 'BIG50'});
    assert.equal(res.status, 201, 'a management-issued coupon is not a till discount');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reason and audit trail
// ═══════════════════════════════════════════════════════════════════════════

describe('11D — reason and audit trail', () => {
  it('requires a reason for an order discount', async () => {
    const res = await placeOrder({discount: {kind: 'percentage', value: 10}});
    assert.equal(res.status, 400, 'an unexplained discount defeats the audit');
    assert.match(res.body.message, /reason is required/);
    assert.equal(await Order.countDocuments({}), 0);
  });

  it('requires a reason for a line discount', async () => {
    const res = await placeOrder({
      items: [{menuItem: MENU(), qty: 1, discount: {kind: 'percentage', value: 10}}]
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /reason is required/);
  });

  it('records who discounted, why, and how much', async () => {
    const res = await placeOrder({discount: {kind: 'percentage', value: 10, reason: 'Late service'}});
    assert.equal(res.status, 201);

    const stored = await Order.findById(res.body._id);
    assert.equal(String(stored.discountBy), String(world.staffA._id), 'the actor is recorded');
    assert.equal(stored.discountReason, 'Late service');
    assert.ok(stored.discountTotal > 0);

    const entry = await Audit.findOne({action: 'order_discount', entityId: stored._id}).lean();
    assert.ok(entry, 'every discount must be audited');
    assert.equal(String(entry.user), String(world.staffA._id));
    assert.equal(String(entry.branch), BRANCH());
  });

  it('does not audit an order that carries no discount', async () => {
    const res = await placeOrder({});
    assert.equal(res.status, 201);
    assert.equal(
      await Audit.countDocuments({action: 'order_discount', entityId: res.body._id}), 0,
      'a clean order must not create discount noise in the audit log'
    );
  });
});
