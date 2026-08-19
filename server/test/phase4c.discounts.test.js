import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Audit, Coupon, CouponRedemption} from '../src/models/index.js';
import {Customer} from '../src/models/operations.js';
import {
  applyItemDiscounts,
  computeDiscountAmount,
  normalizeCouponInput,
  resolveOrderDiscount
} from '../src/services/discounts.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {daysAgo, daysAhead} from './dates.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const owner = () => tokenFor(world.owner);
const staff = () => tokenFor(world.staffA);

// seedWorld menu: Chicken Biryani, price 350, vatInclusive false.
function order(body, token = owner()) {
  return request('/api/orders', {
    method: 'POST',
    token,
    body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 2}], ...body}
  });
}

function makeCoupon(body, token = owner()) {
  return request('/api/coupons', {method: 'POST', token, body});
}

describe('Phase 4C — discount maths', () => {
  it('computes percentage and fixed amounts', () => {
    assert.equal(computeDiscountAmount({kind: 'percentage', value: 10, base: 1000}), 100);
    assert.equal(computeDiscountAmount({kind: 'percentage', value: 12.5, base: 800}), 100);
    assert.equal(computeDiscountAmount({kind: 'fixed', value: 150, base: 1000}), 150);
  });

  it('clamps a discount to the base and honours a cap', () => {
    // A fixed discount larger than the order cannot make it negative.
    assert.equal(computeDiscountAmount({kind: 'fixed', value: 5000, base: 700}), 700);
    assert.equal(computeDiscountAmount({kind: 'percentage', value: 100, base: 700}), 700);
    // maxDiscount caps a generous percentage.
    assert.equal(computeDiscountAmount({kind: 'percentage', value: 50, base: 1000, maxDiscount: 200}), 200);
  });

  it('rejects malformed discounts', () => {
    assert.throws(() => computeDiscountAmount({kind: 'percentage', value: 101, base: 100}), /cannot exceed 100/);
    assert.throws(() => computeDiscountAmount({kind: 'fixed', value: -1, base: 100}), /non-negative/);
    assert.throws(() => computeDiscountAmount({kind: 'bogus', value: 1, base: 100}), /kind must be one of/);
  });

  it('applies item discounts to the right lines only', () => {
    const lines = [
      {lineNet: 700, lineVat: 91},
      {lineNet: 300, lineVat: 39}
    ];
    const {lines: out, itemDiscountTotal} = applyItemDiscounts({
      lines, itemDiscounts: [{index: 0, kind: 'percentage', value: 10}]
    });
    assert.equal(itemDiscountTotal, 70);
    assert.equal(out[0].discountedNet, 630);
    assert.equal(out[1].discount, 0);
    assert.equal(out[1].discountedNet, 300);
    assert.throws(() => applyItemDiscounts({lines, itemDiscounts: [{index: 9, kind: 'fixed', value: 1}]}), /not on the order/);
    assert.throws(() => applyItemDiscounts({
      lines, itemDiscounts: [{index: 0, kind: 'fixed', value: 1}, {index: 0, kind: 'fixed', value: 2}]
    }), /one discount may be applied per line/);
  });

  it('combines a manual discount with a coupon and clamps the pair', () => {
    const combined = resolveOrderDiscount({subtotalAfterItems: 1000, manual: {kind: 'percentage', value: 10, reason: 'Test discount'}, couponAmount: 150});
    assert.equal(combined.manualAmount, 100);
    assert.equal(combined.couponAmount, 150);
    assert.equal(combined.orderDiscountTotal, 250);
    // Together they can never exceed the order.
    const clamped = resolveOrderDiscount({subtotalAfterItems: 500, manual: {kind: 'fixed', value: 400, reason: 'Test discount'}, couponAmount: 300});
    assert.equal(clamped.orderDiscountTotal, 500);
  });

  it('validates coupon definitions', () => {
    assert.throws(() => normalizeCouponInput({code: 'x', kind: 'fixed', value: 10}), /letters, numbers/);
    assert.throws(() => normalizeCouponInput({code: 'SAVE10', kind: 'percentage', value: 101}), /cannot exceed 100/);
    assert.throws(() => normalizeCouponInput({code: 'SAVE10', kind: 'fixed', value: 0}), /greater than zero/);
    assert.throws(() => normalizeCouponInput({
      code: 'SAVE10', kind: 'fixed', value: 10, startsAt: daysAhead(5), endsAt: daysAgo(5)
    }), /start date must be before/);
    const ok = normalizeCouponInput({code: ' save10 ', kind: 'percentage', value: 10});
    assert.equal(ok.code, 'SAVE10');
  });
});

describe('Phase 4C — item and order discounts on POST /api/orders', () => {
  it('applies a percentage item discount and recomputes VAT on the reduced line', async () => {
    const res = await order({items: [{menuItem: String(world.menu._id), qty: 2, discount: {kind: 'percentage', value: 10, reason: 'Damaged plating'}}]});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.subtotal, 700);
    assert.equal(res.body.itemDiscount, 70);
    assert.equal(res.body.items[0].discount, 70);
    assert.equal(res.body.items[0].discountKind, 'percentage');
    assert.equal(res.body.items[0].discountReason, 'Damaged plating');
    // VAT follows the discounted net: 13% of 630.
    assert.equal(res.body.vat, 81.9);
    assert.equal(res.body.total, 711.9);
  });

  it('applies a fixed item discount', async () => {
    const res = await order({items: [{menuItem: String(world.menu._id), qty: 2, discount: {kind: 'fixed', value: 100, reason: 'Test discount'}}]});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.itemDiscount, 100);
    assert.equal(res.body.vat, 78); // 13% of 600
    assert.equal(res.body.total, 678);
  });

  it('applies a percentage order discount', async () => {
    const res = await order({discount: {kind: 'percentage', value: 20, reason: 'Regular guest'}});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.subtotal, 700);
    assert.equal(res.body.manualDiscount, 140);
    assert.equal(res.body.discountTotal, 140);
    assert.equal(res.body.discountReason, 'Regular guest');
    assert.equal(res.body.vat, 72.8); // 13% of 560
    assert.equal(res.body.total, 632.8);
  });

  it('still accepts a bare numeric discount as a fixed amount', async () => {
    const res = await order({discount: 100});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.discount, 100);
    assert.equal(res.body.vat, 78);
    assert.equal(res.body.total, 678);
  });

  it('stacks an item discount under an order discount', async () => {
    const res = await order({
      items: [{menuItem: String(world.menu._id), qty: 2, discount: {kind: 'fixed', value: 100, reason: 'Test discount'}}],
      discount: {kind: 'percentage', value: 10, reason: 'Test discount'}
    });
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.subtotal, 700);
    assert.equal(res.body.itemDiscount, 100);
    // Order discount works off the post-item net of 600.
    assert.equal(res.body.manualDiscount, 60);
    assert.equal(res.body.discountTotal, 160);
    assert.equal(res.body.vat, 70.2); // 13% of 540
    assert.equal(res.body.total, 610.2);
  });

  it('refuses a discount larger than the order', async () => {
    assert.equal((await order({discount: {kind: 'fixed', value: 99999, reason: 'Test discount'}})).status, 400);
    assert.equal((await order({discount: {kind: 'percentage', value: 150, reason: 'Test discount'}})).status, 400);
    assert.equal((await order({discount: -50})).status, 400);
  });

  it('rejects an over-large manual discount but clamps a generous coupon', async () => {
    // A mistyped manual amount is refused outright...
    assert.equal((await order({discount: {kind: 'fixed', value: 5000, reason: 'Test discount'}})).status, 400);
    assert.equal((await order({items: [{menuItem: String(world.menu._id), qty: 2, discount: {kind: 'fixed', value: 5000, reason: 'Test discount'}}]})).status, 400);
    // ...but a management-set coupon worth more than the order simply zeroes it.
    await makeCoupon({code: 'GENEROUS', kind: 'fixed', value: 5000});
    const res = await order({coupon: 'GENEROUS'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.couponDiscount, 700);
    assert.equal(res.body.vat, 0);
    assert.equal(res.body.total, 0);
  });

  it('records who applied a discount in the audit log', async () => {
    const res = await order({discount: {kind: 'fixed', value: 50, reason: 'Service delay'}}, staff());
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.discountBy, String(world.staffA._id));
    const entry = await Audit.findOne({entity: 'order', entityId: res.body._id, action: 'order_discount'});
    assert.ok(entry, 'expected an audit entry for the discount');
    assert.equal(String(entry.user), String(world.staffA._id));
    assert.equal(entry.after.manualDiscount, 50);
    assert.equal(entry.reason, 'Service delay');
  });

  it('writes no discount audit entry for an undiscounted order', async () => {
    const res = await order({});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(await Audit.countDocuments({entityId: res.body._id, action: 'order_discount'}), 0);
  });
});

describe('Phase 4C — coupons', () => {
  it('creates, lists and retrieves a coupon', async () => {
    const created = await makeCoupon({code: 'welcome10', kind: 'percentage', value: 10, description: 'New guest'});
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.code, 'WELCOME10');
    assert.equal(created.body.active, true);

    const list = await request('/api/coupons', {token: owner()});
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const one = await request('/api/coupons/' + created.body._id, {token: owner()});
    assert.equal(one.body.redemptions, 0);
    // Duplicate codes are refused.
    assert.equal((await makeCoupon({code: 'WELCOME10', kind: 'fixed', value: 50})).status, 409);
  });

  it('redeems a percentage coupon on an order', async () => {
    await makeCoupon({code: 'SAVE10', kind: 'percentage', value: 10});
    const res = await order({coupon: 'save10'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.couponCode, 'SAVE10');
    assert.equal(res.body.couponDiscount, 70);
    assert.equal(res.body.discountTotal, 70);
    assert.equal(res.body.vat, 81.9);
    assert.equal(res.body.total, 711.9);

    const redemption = await CouponRedemption.findOne({order: res.body._id});
    assert.ok(redemption);
    assert.equal(redemption.amount, 70);
    const coupon = await Coupon.findOne({code: 'SAVE10'});
    assert.equal(coupon.timesRedeemed, 1);
  });

  it('applies a fixed coupon and caps it with maxDiscount', async () => {
    await makeCoupon({code: 'FLAT200', kind: 'fixed', value: 200});
    const flat = await order({coupon: 'FLAT200'});
    assert.equal(flat.body.couponDiscount, 200);

    await makeCoupon({code: 'HALFCAP', kind: 'percentage', value: 50, maxDiscount: 100});
    const capped = await order({coupon: 'HALFCAP'});
    assert.equal(capped.body.couponDiscount, 100); // 50% of 700 capped at 100
  });

  it('enforces the validity window', async () => {
    await makeCoupon({code: 'FUTURE', kind: 'fixed', value: 50, startsAt: daysAhead(3)});
    await makeCoupon({code: 'PAST', kind: 'fixed', value: 50, endsAt: daysAgo(1)});
    await makeCoupon({code: 'LIVE', kind: 'fixed', value: 50, startsAt: daysAgo(1), endsAt: daysAhead(1)});

    assert.equal((await order({coupon: 'FUTURE'})).status, 409);
    assert.equal((await order({coupon: 'PAST'})).status, 409);
    assert.equal((await order({coupon: 'LIVE'})).status, 201);
  });

  it('rejects unknown and deactivated codes', async () => {
    const created = await makeCoupon({code: 'GONE', kind: 'fixed', value: 50});
    assert.equal((await order({coupon: 'NOSUCHCODE'})).status, 404);
    const removed = await request('/api/coupons/' + created.body._id, {method: 'DELETE', token: owner()});
    assert.equal(removed.status, 200);
    assert.equal(removed.body.coupon.active, false);
    assert.equal((await order({coupon: 'GONE'})).status, 409);
  });

  it('enforces the minimum order amount', async () => {
    await makeCoupon({code: 'BIG', kind: 'fixed', value: 100, minOrderAmount: 1000});
    // Subtotal 700 is under the minimum.
    assert.equal((await order({coupon: 'BIG'})).status, 409);
    // Three plates clears it.
    const ok = await order({coupon: 'BIG', items: [{menuItem: String(world.menu._id), qty: 3}]});
    assert.equal(ok.status, 201, ok.body?.message);
    assert.equal(ok.body.couponDiscount, 100);
  });

  it('enforces the total usage limit', async () => {
    await makeCoupon({code: 'ONCE', kind: 'fixed', value: 50, usageLimit: 1});
    assert.equal((await order({coupon: 'ONCE'})).status, 201);
    assert.equal((await order({coupon: 'ONCE'})).status, 409);
  });

  it('enforces the per-customer limit', async () => {
    const guest = await Customer.create({branch: world.branchA._id, name: 'Ram', phone: '9800000002'});
    const other = await Customer.create({branch: world.branchA._id, name: 'Sita', phone: '9800000003'});
    await makeCoupon({code: 'PERGUEST', kind: 'fixed', value: 50, perCustomerLimit: 1});

    assert.equal((await order({coupon: 'PERGUEST', customer: String(guest._id)})).status, 201);
    assert.equal((await order({coupon: 'PERGUEST', customer: String(guest._id)})).status, 409);
    // A different guest may still use it.
    assert.equal((await order({coupon: 'PERGUEST', customer: String(other._id)})).status, 201);
    // An anonymous sale cannot satisfy a per-customer rule.
    assert.equal((await order({coupon: 'PERGUEST'})).status, 409);
  });

  it('scopes a coupon to a branch and an order type', async () => {
    await makeCoupon({code: 'BRANCHB', kind: 'fixed', value: 50, branches: [String(world.branchB._id)]});
    assert.equal((await order({coupon: 'BRANCHB'})).status, 409);

    await makeCoupon({code: 'DELIVERYONLY', kind: 'fixed', value: 50, orderTypes: ['delivery']});
    assert.equal((await order({coupon: 'DELIVERYONLY'})).status, 409);
  });

  it('scopes a coupon to specific menu items', async () => {
    await makeCoupon({code: 'BIRYANI', kind: 'percentage', value: 10, menuItems: [String(world.menu._id)]});
    const ok = await order({coupon: 'BIRYANI'});
    assert.equal(ok.status, 201, ok.body?.message);
    assert.equal(ok.body.couponDiscount, 70); // 10% of the matching line only

    const {MenuItem} = await import('../src/models/index.js');
    const other = await MenuItem.create({
      restaurant: world.restaurant._id, name: 'Plain Rice', price: 100, vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 50, unit: 'g'}]
    });
    await makeCoupon({code: 'RICEONLY', kind: 'percentage', value: 50, menuItems: [String(other._id)]});
    // The coupon matches nothing on a biryani-only ticket.
    assert.equal((await order({coupon: 'RICEONLY'})).status, 409);
  });

  it('stacks a coupon with a manual discount', async () => {
    await makeCoupon({code: 'STACK', kind: 'fixed', value: 100});
    const res = await order({coupon: 'STACK', discount: {kind: 'fixed', value: 50, reason: 'Test discount'}});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.couponDiscount, 100);
    assert.equal(res.body.manualDiscount, 50);
    assert.equal(res.body.discountTotal, 150);
    assert.equal(res.body.vat, 71.5); // 13% of 550
    assert.equal(res.body.total, 621.5);
  });

  it('previews a coupon without redeeming it', async () => {
    await makeCoupon({code: 'PREVIEW', kind: 'percentage', value: 10});
    const res = await request('/api/coupons/validate', {
      method: 'POST', token: staff(),
      body: {code: 'preview', subtotal: 700, branch: String(world.branchA._id), orderType: 'counter'}
    });
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.amount, 70);
    // Nothing was consumed.
    assert.equal(await CouponRedemption.countDocuments({}), 0);
    assert.equal((await Coupon.findOne({code: 'PREVIEW'})).timesRedeemed, 0);

    const bad = await request('/api/coupons/validate', {
      method: 'POST', token: staff(), body: {code: 'NOPE', subtotal: 700}
    });
    assert.equal(bad.status, 404);
    assert.equal(bad.body.valid, false);
  });

  it('leaves no redemption behind when the order fails', async () => {
    await makeCoupon({code: 'ROLLBACK', kind: 'fixed', value: 50});
    // Quantity far beyond available stock aborts the transaction after validation.
    const res = await order({coupon: 'ROLLBACK', items: [{menuItem: String(world.menu._id), qty: 999}]});
    assert.equal(res.status, 409, res.body?.message);
    assert.equal(await CouponRedemption.countDocuments({}), 0);
    assert.equal((await Coupon.findOne({code: 'ROLLBACK'})).timesRedeemed, 0);
  });
});

describe('Phase 4C — authorization', () => {
  it('lets any staff apply a manual discount', async () => {
    // POS 11D: staff still discount without a supervisor, but 25% is above
    // the default 20% staff ceiling, so this uses a within-policy figure.
    // The ceiling itself is covered in phase11d.pos.discounts.test.js.
    const res = await order({discount: {kind: 'percentage', value: 20, reason: 'Test discount'}}, staff());
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.manualDiscount, 140);
  });

  it('restricts coupon management to owners and managers', async () => {
    // Staff cannot mint codes.
    assert.equal((await makeCoupon({code: 'STAFFMADE', kind: 'fixed', value: 50}, staff())).status, 403);
    const created = await makeCoupon({code: 'MANAGED', kind: 'fixed', value: 50, active: true}, tokenFor(world.manager));
    assert.equal(created.status, 201, created.body?.message);

    // Staff may read and redeem, but not edit.
    assert.equal((await request('/api/coupons', {token: staff()})).status, 200);
    assert.equal((await request('/api/coupons/' + created.body._id, {
      method: 'PATCH', token: staff(), body: {value: 500}
    })).status, 403);

    // Only owners retire a coupon.
    assert.equal((await request('/api/coupons/' + created.body._id, {
      method: 'DELETE', token: tokenFor(world.manager)
    })).status, 403);
    assert.equal((await request('/api/coupons/' + created.body._id, {
      method: 'DELETE', token: owner()
    })).status, 200);
  });

  it('rejects unauthenticated and guest access', async () => {
    assert.equal((await request('/api/coupons')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/coupons', {token: guest})).status, 403);
    assert.equal((await makeCoupon({code: 'GUESTMADE', kind: 'fixed', value: 5}, guest)).status, 403);
  });

  it('keeps coupons inside their own restaurant', async () => {
    await makeCoupon({code: 'TENANT', kind: 'fixed', value: 50});
    const {Restaurant} = await import('../src/models/operations.js');
    const {User} = await import('../src/models/index.js');
    const otherRestaurant = await Restaurant.create({name: 'Other Co', currency: 'NPR', vatRate: 13});
    const outsider = await User.create({
      name: 'Outsider', email: 'outsider@test.com', password: 'x', role: 'owner',
      restaurant: 'Other Co', restaurantId: otherRestaurant._id
    });
    const list = await request('/api/coupons', {token: tokenFor(outsider)});
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 0, 'another restaurant must not see these coupons');
  });
});
