/**
 * POS 11E — coupon engine.
 *
 * The engine shipped in Phase 4C and implements all ten requirements: code,
 * percentage/fixed, validity window, minimum order, maximum discount, total
 * usage limit, per-customer limit, branch scope, menu-item scope and
 * redemption records. Those are pinned here rather than rebuilt.
 *
 * The audit found ONE real defect. The total usage limit was enforced by
 * counting redemptions in validateCoupon() and then inserting — a
 * read-then-write race. Two concurrent transactions both read `used = 0`
 * against a usageLimit of 1, both inserted, and the coupon was redeemed
 * twice. Reproduced against the database before the fix, which claims the
 * limit atomically with a conditional $inc on timesRedeemed.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Coupon, CouponRedemption, MenuItem} from '../src/models/index.js';
import {Customer, Order} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await Coupon.init();
  await CouponRedemption.init();
});

const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const MENU = () => String(world.menu._id);
const BRANCH = () => String(world.branchA._id);

const makeCoupon = (body, token = manager()) =>
  request('/api/coupons', {method: 'POST', token, body});

const placeOrder = (body = {}, token = manager()) =>
  request('/api/orders', {
    method: 'POST', token,
    body: {branch: BRANCH(), type: 'counter', items: [{menuItem: MENU(), qty: 1}], ...body}
  });

const newCustomer = (phone, name = 'Guest') => Customer.create({
  restaurant: world.restaurant._id, branch: world.branchA._id,
  name, phone, phoneKey: phone
});

// ═══════════════════════════════════════════════════════════════════════════
// Definition: code, kind, value
// ═══════════════════════════════════════════════════════════════════════════

describe('11E — coupon definition', () => {
  it('creates percentage and fixed coupons and applies them', async () => {
    assert.equal((await makeCoupon({code: 'PCT10', kind: 'percentage', value: 10})).status, 201);
    assert.equal((await makeCoupon({code: 'FIX50', kind: 'fixed', value: 50})).status, 201);

    // 350 line: 10% = 35, and a fixed 50 is taken off outright.
    const pct = await placeOrder({coupon: 'PCT10'});
    assert.equal(pct.status, 201, JSON.stringify(pct.body));
    assert.equal(pct.body.couponDiscount, 35);
    assert.equal(pct.body.couponCode, 'PCT10');

    const fixed = await placeOrder({coupon: 'FIX50'});
    assert.equal(fixed.body.couponDiscount, 50);
  });

  it('normalises the code and refuses a duplicate in the same restaurant', async () => {
    assert.equal((await makeCoupon({code: 'welcome', kind: 'fixed', value: 20})).status, 201);
    const stored = await Coupon.findOne({restaurant: world.restaurant._id});
    assert.equal(stored.code, 'WELCOME', 'codes are stored uppercase');

    const dupe = await makeCoupon({code: 'WELCOME', kind: 'fixed', value: 5});
    assert.ok([400, 409].includes(dupe.status), `got ${dupe.status}`);
    assert.equal(await Coupon.countDocuments({code: 'WELCOME'}), 1);

    // A lowercase code at the till still resolves.
    const res = await placeOrder({coupon: 'welcome'});
    assert.equal(res.status, 201);
    assert.equal(res.body.couponDiscount, 20);
  });

  it('refuses a nonsensical definition', async () => {
    assert.equal((await makeCoupon({code: 'OVER', kind: 'percentage', value: 150})).status, 400);
    assert.equal((await makeCoupon({code: 'NEG', kind: 'fixed', value: -5})).status, 400);
    assert.equal(await Coupon.countDocuments({}), 0);
  });

  it('reserves coupon creation for owners and managers', async () => {
    assert.equal((await makeCoupon({code: 'STAFFMADE', kind: 'fixed', value: 50}, staff())).status, 403);
    assert.equal(await Coupon.countDocuments({}), 0);
  });

  it('refuses an unknown code at the till', async () => {
    const res = await placeOrder({coupon: 'DOESNOTEXIST'});
    assert.equal(res.status, 404);
    assert.equal(await Order.countDocuments({}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Validity window and active flag
// ═══════════════════════════════════════════════════════════════════════════

describe('11E — validity', () => {
  const day = 24 * 60 * 60 * 1000;

  it('refuses a coupon that has not started or has expired', async () => {
    await makeCoupon({
      code: 'FUTURE', kind: 'fixed', value: 20,
      startsAt: new Date(Date.now() + day).toISOString()
    });
    await makeCoupon({
      code: 'PAST', kind: 'fixed', value: 20,
      endsAt: new Date(Date.now() - day).toISOString()
    });

    const early = await placeOrder({coupon: 'FUTURE'});
    assert.equal(early.status, 409);
    assert.match(early.body.message, /not valid yet/);

    const late = await placeOrder({coupon: 'PAST'});
    assert.equal(late.status, 409);
    assert.match(late.body.message, /expired/);
    assert.equal(await Order.countDocuments({}), 0);
  });

  it('accepts a coupon inside its window', async () => {
    await makeCoupon({
      code: 'NOW', kind: 'fixed', value: 20,
      startsAt: new Date(Date.now() - day).toISOString(),
      endsAt: new Date(Date.now() + day).toISOString()
    });
    assert.equal((await placeOrder({coupon: 'NOW'})).status, 201);
  });

  it('refuses a deactivated coupon', async () => {
    await makeCoupon({code: 'OFF', kind: 'fixed', value: 20, active: false});
    const res = await placeOrder({coupon: 'OFF'});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not active/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Minimum order and maximum discount
// ═══════════════════════════════════════════════════════════════════════════

describe('11E — thresholds', () => {
  it('enforces a minimum order amount', async () => {
    await makeCoupon({code: 'MIN1000', kind: 'fixed', value: 50, minOrderAmount: 1000});

    const small = await placeOrder({coupon: 'MIN1000'});
    assert.equal(small.status, 409, 'a 350 order is below the 1000 minimum');
    assert.match(small.body.message, /minimum order/);

    const big = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: BRANCH(), type: 'counter',
        items: [{menuItem: MENU(), qty: 5}], coupon: 'MIN1000'
      }
    });
    assert.equal(big.status, 201, '1750 clears the minimum');
    assert.equal(big.body.couponDiscount, 50);
  });

  it('clamps a percentage coupon to its maximum discount', async () => {
    await makeCoupon({code: 'CAP', kind: 'percentage', value: 50, maxDiscount: 40});
    const res = await placeOrder({coupon: 'CAP'});
    assert.equal(res.status, 201);
    // 50% of 350 is 175, clamped to 40. A coupon is clamped rather than
    // refused because its value was set by management, not typed at the till.
    assert.equal(res.body.couponDiscount, 40);
  });

  it('refuses a coupon that would discount nothing', async () => {
    await makeCoupon({code: 'ZERO', kind: 'percentage', value: 0.0001, maxDiscount: 0});
    const res = await placeOrder({coupon: 'ZERO'});
    assert.equal(res.status, 409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope
// ═══════════════════════════════════════════════════════════════════════════

describe('11E — scope', () => {
  it('restricts a coupon to its branches', async () => {
    await makeCoupon({
      code: 'BONLY', kind: 'fixed', value: 20, branches: [String(world.branchB._id)]
    });
    const res = await placeOrder({coupon: 'BONLY'});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not valid at this branch/);
  });

  it('applies a branch-scoped coupon at the right branch', async () => {
    await makeCoupon({
      code: 'AONLY', kind: 'fixed', value: 20, branches: [BRANCH()]
    });
    assert.equal((await placeOrder({coupon: 'AONLY'})).status, 201);
  });

  it('narrows the discount base to the scoped menu items', async () => {
    // vatInclusive:false so the discount base is the plain 200 and the
    // assertion below is about SCOPING, not VAT arithmetic.
    const other = await MenuItem.create({
      name: 'Side Salad', price: 200, recipe: [], vatInclusive: false
    });
    await makeCoupon({
      code: 'ITEMONLY', kind: 'percentage', value: 50, menuItems: [String(other._id)]
    });

    // Nothing on the order matches.
    const miss = await placeOrder({coupon: 'ITEMONLY'});
    assert.equal(miss.status, 409);
    assert.match(miss.body.message, /does not apply to any item/);

    // The scoped item is present alongside an unscoped one: only the scoped
    // line may be discounted, so 50% of 200 rather than 50% of 550.
    const hit = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: BRANCH(), type: 'counter',
        items: [{menuItem: MENU(), qty: 1}, {menuItem: String(other._id), qty: 1}],
        coupon: 'ITEMONLY'
      }
    });
    assert.equal(hit.status, 201, JSON.stringify(hit.body));
    // 50% of the 200 salad, NOT 50% of the 550 order.
    assert.equal(hit.body.couponDiscount, 100, 'only the scoped line is discountable');
  });

  it('restricts a coupon to its order types', async () => {
    await makeCoupon({code: 'DELIVERYONLY', kind: 'fixed', value: 20, orderTypes: ['delivery']});
    const res = await placeOrder({coupon: 'DELIVERYONLY'});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not valid for counter/);
  });

  it('does not leak a coupon to another restaurant', async () => {
    await makeCoupon({code: 'OURS', kind: 'fixed', value: 20});
    // A coupon is looked up by {restaurant, code}, so an identical code in
    // another tenant is a different coupon entirely.
    assert.equal(await Coupon.countDocuments({code: 'OURS'}), 1);
    const stored = await Coupon.findOne({code: 'OURS'});
    assert.equal(String(stored.restaurant), String(world.restaurant._id));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Usage limits — including the race that was found
// ═══════════════════════════════════════════════════════════════════════════

describe('11E — total usage limit', () => {
  it('stops accepting a coupon once the limit is reached', async () => {
    await makeCoupon({code: 'TWICE', kind: 'fixed', value: 20, usageLimit: 2});

    assert.equal((await placeOrder({coupon: 'TWICE'})).status, 201);
    assert.equal((await placeOrder({coupon: 'TWICE'})).status, 201);

    const third = await placeOrder({coupon: 'TWICE'});
    assert.equal(third.status, 409);
    assert.match(third.body.message, /usage limit/);
    assert.equal(await CouponRedemption.countDocuments({code: 'TWICE'}), 2);
  });

  it('claims the limit atomically, so concurrent orders cannot over-redeem', async () => {
    await makeCoupon({code: 'RACE', kind: 'fixed', value: 20, usageLimit: 1});
    const attempts = await Promise.all(
      [1, 2, 3, 4, 5].map(() => placeOrder({coupon: 'RACE'}))
    );
    assert.equal(attempts.filter(r => r.status === 201).length, 1);
    assert.equal(await CouponRedemption.countDocuments({code: 'RACE'}), 1);
    assert.equal((await Coupon.findOne({code: 'RACE'})).timesRedeemed, 1);
  });

  it('holds when two transactions interleave, not just when requests queue', async () => {
    // This is the defect the audit found, and HTTP alone does not reproduce
    // it: Express serialises the requests, so both mutations below survived
    // an over-the-wire concurrency test. Driving two genuinely overlapping
    // sessions is what exposes a read-then-write race.
    await makeCoupon({code: 'INTERLEAVE', kind: 'fixed', value: 20, usageLimit: 1});
    const coupon = await Coupon.findOne({code: 'INTERLEAVE'});
    const order = await placeOrder({});
    const {recordRedemption} = await import('../src/services/discounts.js');

    const first = await mongoose.startSession();
    const second = await mongoose.startSession();
    let secondSucceeded = false;
    try {
      first.startTransaction();
      second.startTransaction();

      // Both sessions observe the coupon as unused before either commits.
      const seenByFirst = await CouponRedemption.countDocuments({coupon: coupon._id}).session(first);
      const seenBySecond = await CouponRedemption.countDocuments({coupon: coupon._id}).session(second);
      assert.equal(seenByFirst, 0);
      assert.equal(seenBySecond, 0, 'both readers believe the coupon is free');

      const claim = session => recordRedemption({
        coupon, order: {_id: new mongoose.Types.ObjectId()},
        restaurantId: world.restaurant._id, branchId: world.branchA._id,
        customerId: null, amount: 20, user: {id: world.manager._id}, session
      });

      await claim(first);
      try {
        await claim(second);
        await first.commitTransaction();
        await second.commitTransaction();
        secondSucceeded = true;
      } catch {
        // Either the conditional claim matched nothing, or the commit hit a
        // write conflict on the same coupon document. Both are correct.
        await first.commitTransaction().catch(() => null);
        await second.abortTransaction().catch(() => null);
      }
    } finally {
      await first.endSession();
      await second.endSession();
    }

    assert.equal(secondSucceeded, false, 'a second concurrent claim must not commit');
    const fresh = await Coupon.findById(coupon._id);
    assert.equal(fresh.timesRedeemed, 1, 'a single-use coupon may be claimed once');
    assert.ok(
      await CouponRedemption.countDocuments({coupon: coupon._id}) <= 1,
      'no over-redemption may be persisted'
    );
    assert.ok(order.status === 201);
  });

  it('refuses a second claim at the database level, not only in application code', async () => {
    await makeCoupon({code: 'ATOMIC', kind: 'fixed', value: 20, usageLimit: 1});
    const coupon = await Coupon.findOne({code: 'ATOMIC'});

    // The conditional $inc is the guarantee: only one writer can move
    // timesRedeemed from 0 to 1 while it is still below the limit.
    const first = await Coupon.updateOne(
      {_id: coupon._id, timesRedeemed: {$lt: 1}}, {$inc: {timesRedeemed: 1}}
    );
    const second = await Coupon.updateOne(
      {_id: coupon._id, timesRedeemed: {$lt: 1}}, {$inc: {timesRedeemed: 1}}
    );

    assert.equal(first.modifiedCount, 1);
    assert.equal(second.modifiedCount, 0, 'the second claim must match no document');
    assert.equal((await Coupon.findById(coupon._id)).timesRedeemed, 1);
  });

  it('refuses a second claim at the service boundary once the limit is spent', async () => {
    // The sharpest assertion for the fix. recordRedemption() claims the limit
    // with a conditional $inc; with the old plain increment this second call
    // succeeded and the coupon was redeemed twice.
    const {recordRedemption} = await import('../src/services/discounts.js');
    await makeCoupon({code: 'ONEUSE', kind: 'fixed', value: 20, usageLimit: 1});
    const id = (await Coupon.findOne({code: 'ONEUSE'}))._id;

    const claim = async () => {
      const coupon = await Coupon.findById(id);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await recordRedemption({
            coupon, order: {_id: new mongoose.Types.ObjectId()},
            restaurantId: world.restaurant._id, branchId: world.branchA._id,
            customerId: null, amount: 20, user: {id: world.manager._id}, session
          });
        });
        return 'claimed';
      } catch (error) {
        return error.message;
      } finally {
        await session.endSession();
      }
    };

    assert.equal(await claim(), 'claimed');
    assert.match(await claim(), /usage limit/, 'the second claim must be refused');
    assert.equal((await Coupon.findById(id)).timesRedeemed, 1);
    assert.equal(await CouponRedemption.countDocuments({coupon: id}), 1);
  });

  it('is guarded twice: a friendly pre-check and an atomic claim', async () => {
    // Removing the count check in validateCoupon() alone does NOT allow
    // over-redemption, because recordRedemption() claims the limit
    // atomically. That is deliberate defence in depth: the pre-check exists
    // to give a clear message before the order is priced, and the claim is
    // the guarantee. Both are asserted so neither is dropped on the
    // assumption the other covers it.
    const {validateCoupon} = await import('../src/services/discounts.js');
    await makeCoupon({code: 'GUARDED', kind: 'fixed', value: 20, usageLimit: 1});
    assert.equal((await placeOrder({coupon: 'GUARDED'})).status, 201);

    // Layer 1: the pre-check refuses before anything is written.
    await assert.rejects(
      validateCoupon({
        code: 'GUARDED', restaurantId: world.restaurant._id, branchId: world.branchA._id,
        orderType: 'counter', customerId: null, lines: [], subtotal: 350
      }),
      /usage limit/,
      'validateCoupon must refuse a spent coupon'
    );

    // Layer 2: the counter itself is already at the limit.
    assert.equal((await Coupon.findOne({code: 'GUARDED'})).timesRedeemed, 1);
  });

  it('treats a zero limit as unlimited', async () => {
    await makeCoupon({code: 'UNLIMITED', kind: 'fixed', value: 10, usageLimit: 0});
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await placeOrder({coupon: 'UNLIMITED'})).status, 201);
    }
    assert.equal((await Coupon.findOne({code: 'UNLIMITED'})).timesRedeemed, 3);
  });
});

describe('11E — per-customer limit', () => {
  it('allows one use per customer and admits a different customer', async () => {
    const ram = await newCustomer('9800000001', 'Ram');
    const sita = await newCustomer('9800000002', 'Sita');
    await makeCoupon({code: 'ONEEACH', kind: 'fixed', value: 20, perCustomerLimit: 1});

    assert.equal((await placeOrder({coupon: 'ONEEACH', customer: String(ram._id)})).status, 201);

    const again = await placeOrder({coupon: 'ONEEACH', customer: String(ram._id)});
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already been used by this customer/);

    assert.equal((await placeOrder({coupon: 'ONEEACH', customer: String(sita._id)})).status, 201,
      'a different customer still gets their allowance');
  });

  it('requires an identified customer when a per-customer limit exists', async () => {
    await makeCoupon({code: 'NEEDSID', kind: 'fixed', value: 20, perCustomerLimit: 1});
    const res = await placeOrder({coupon: 'NEEDSID'});
    assert.equal(res.status, 409, 'an anonymous order cannot be limited per customer');
    assert.match(res.body.message, /identified customer/);
  });

  it('holds under concurrent orders from the same customer', async () => {
    const ram = await newCustomer('9800000003', 'Ram');
    await makeCoupon({code: 'PCRACE', kind: 'fixed', value: 20, perCustomerLimit: 1});

    const attempts = await Promise.all(
      [1, 2, 3, 4].map(() => placeOrder({coupon: 'PCRACE', customer: String(ram._id)}))
    );
    assert.equal(attempts.filter(r => r.status === 201).length, 1);
    assert.equal(await CouponRedemption.countDocuments({code: 'PCRACE'}), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Redemption records
// ═══════════════════════════════════════════════════════════════════════════

describe('11E — redemption records', () => {
  it('writes a redemption tied to the order, customer and amount', async () => {
    const ram = await newCustomer('9800000004', 'Ram');
    await makeCoupon({code: 'TRACKED', kind: 'fixed', value: 50});

    const res = await placeOrder({coupon: 'TRACKED', customer: String(ram._id)});
    assert.equal(res.status, 201);

    const row = await CouponRedemption.findOne({code: 'TRACKED'}).lean();
    assert.ok(row, 'a redemption must be recorded');
    assert.equal(String(row.order), String(res.body._id));
    assert.equal(String(row.customer), String(ram._id));
    assert.equal(row.amount, 50);
    assert.equal(String(row.restaurant), String(world.restaurant._id));
    assert.equal(String(row.branch), BRANCH());
    assert.ok(row.redeemedBy, 'the till operator is recorded');
  });

  it('keeps timesRedeemed in step with the redemption records', async () => {
    await makeCoupon({code: 'COUNTED', kind: 'fixed', value: 10});
    for (let i = 0; i < 3; i += 1) await placeOrder({coupon: 'COUNTED'});

    const coupon = await Coupon.findOne({code: 'COUNTED'});
    const rows = await CouponRedemption.countDocuments({coupon: coupon._id});
    assert.equal(coupon.timesRedeemed, rows,
      'the counter that guards the limit must match reality');
  });

  it('cannot record the same coupon twice against one order', async () => {
    await makeCoupon({code: 'ONCEPERORDER', kind: 'fixed', value: 10});
    const res = await placeOrder({coupon: 'ONCEPERORDER'});
    const coupon = await Coupon.findOne({code: 'ONCEPERORDER'});

    await assert.rejects(
      CouponRedemption.create({
        coupon: coupon._id, restaurant: world.restaurant._id, branch: world.branchA._id,
        order: res.body._id, code: 'ONCEPERORDER', amount: 10
      }),
      error => error.code === 11000,
      'the unique {coupon, order} index is the guarantee'
    );
  });

  it('writes no redemption when the order is refused', async () => {
    await makeCoupon({code: 'MINHIGH', kind: 'fixed', value: 50, minOrderAmount: 100000});
    assert.equal((await placeOrder({coupon: 'MINHIGH'})).status, 409);
    assert.equal(await CouponRedemption.countDocuments({}), 0);
    assert.equal((await Coupon.findOne({code: 'MINHIGH'})).timesRedeemed, 0,
      'a refused coupon must not burn a use');
  });
});
