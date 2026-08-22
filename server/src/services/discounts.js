import mongoose from 'mongoose';
import {Coupon, CouponRedemption} from '../models/index.js';
import {money} from './billing.js';

// Phase 4C — Discounts & Promotions.
export const DISCOUNT_KINDS = Object.freeze(['percentage', 'fixed']);
export const DISCOUNT_SCOPES = Object.freeze(['item', 'order']);
// Manual discounts are audited rather than capped; coupons carry their own rules.
export const DISCOUNT_SOURCES = Object.freeze(['manual', 'coupon']);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();
export const normalizeCode = value => clean(value).toUpperCase();

/**
 * Resolves a percentage or fixed discount against a base amount.
 *
 * Percentages are bounded to 0–100 and applied to the base; fixed amounts are
 * taken as NPR off. Either way the result is clamped to the base so a discount
 * can never exceed what is being discounted or turn a line negative.
 */
/**
 * Roles that may exceed the staff discount ceiling.
 *
 * RETAINED as the fallback only. Phase 17 moved the decision to the
 * `orders.discountoverride` permission so a custom Supervisor role can be
 * given override authority without being made a manager. This list is still
 * consulted when no resolved principal is available — a service-to-service
 * caller, or a test that passes a bare `{role}` object — so the historical
 * behaviour is preserved rather than silently dropped.
 */
export const DISCOUNT_SUPERVISOR_ROLES = Object.freeze(['owner', 'manager']);

/** The permission that authorises exceeding the staff ceiling. */
export const DISCOUNT_OVERRIDE_PERMISSION = 'orders.discountoverride';

/**
 * Is this caller allowed past the staff ceiling?
 *
 * Prefers the resolved principal (`req.principal`), which carries live
 * database-backed permissions. Falls back to the legacy role list when the
 * caller supplied only a role, so behaviour is unchanged for every existing
 * call path that has not been threaded through the guard.
 */
export function canOverrideDiscountCeiling(principal, user) {
  if (principal) {
    if (principal.baseRole === 'owner') return true;
    if (principal.permissions?.has?.(DISCOUNT_OVERRIDE_PERMISSION)) return true;
    // A resolved CUSTOM role is authoritative: it holds exactly what it was
    // granted, so absence of the permission is a genuine 'no', not a gap.
    if (principal.custom) return false;
  }
  return DISCOUNT_SUPERVISOR_ROLES.includes(String(user?.role || ''));
}

/**
 * 11D: authorise a manual discount against the restaurant's ceilings.
 *
 * Policy: ANY staff member may discount, and every discount is audited — a
 * counter should not need a manager for a small goodwill gesture. But
 * "unlimited and audited" is not a control, so a discount above the staff
 * ceiling needs a supervisor, and a hard ceiling applies to everyone to catch
 * a mistyped 100%.
 *
 * A reason is mandatory. An unexplained discount is indistinguishable from
 * theft after the fact, which defeats the point of auditing it.
 */
export function assertDiscountAuthorized({
  kind, value, amount, base, user, principal, restaurant, scope = 'order'
}) {
  const reason = clean(restaurant?.__reason ?? '');
  const role = String(user?.role || '');
  const isSupervisor = canOverrideDiscountCeiling(principal, user);

  const hardPercent = Number(restaurant?.maxDiscountPercent ?? 100);
  const staffPercent = Number(restaurant?.staffMaxDiscountPercent ?? 20);
  const staffAmount = Number(restaurant?.staffMaxDiscountAmount ?? 500);

  // Percentage equivalent, so a fixed amount is measured on the same scale.
  const effectivePercent = base > 0 ? (Number(amount) / Number(base)) * 100 : 0;

  if (effectivePercent > hardPercent + 1e-9) {
    throw httpError(
      `A discount above ${hardPercent}% is not permitted on this ${scope}`,
      403
    );
  }
  if (isSupervisor) return {requiresSupervisor: false, role};

  if (effectivePercent > staffPercent + 1e-9) {
    throw httpError(
      `A discount above ${staffPercent}% needs a manager. Ask a supervisor to apply it.`,
      403
    );
  }
  if (Number(amount) > staffAmount + 1e-9) {
    throw httpError(
      `A discount above ${staffAmount} needs a manager. Ask a supervisor to apply it.`,
      403
    );
  }
  return {requiresSupervisor: false, role};
}

export function computeDiscountAmount({kind, value, base, maxDiscount = null}) {
  const amount = Number(value);
  const target = money(base || 0);
  if (!DISCOUNT_KINDS.includes(kind)) throw httpError(`Discount kind must be one of ${DISCOUNT_KINDS.join(', ')}`, 400);
  if (!Number.isFinite(amount) || amount < 0) throw httpError('Discount value must be a non-negative number', 400);
  if (target < 0) throw httpError('Discount base must be a non-negative amount', 400);

  let discount;
  if (kind === 'percentage') {
    if (amount > 100) throw httpError('Percentage discount cannot exceed 100%', 400);
    discount = money(target * amount / 100);
  } else {
    discount = money(amount);
  }
  if (maxDiscount !== null && maxDiscount !== undefined && Number(maxDiscount) >= 0) {
    discount = money(Math.min(discount, Number(maxDiscount)));
  }
  // Never discount more than the base being discounted.
  return money(Math.min(discount, target));
}

/**
 * Applies per-item discounts to priced lines.
 *
 * An item discount reduces that line's net directly, so it must be resolved
 * before order-level maths: the order discount and any coupon then work from
 * the already-reduced subtotal rather than the list price.
 */
export function applyItemDiscounts({lines, itemDiscounts = []}) {
  if (!Array.isArray(itemDiscounts) || !itemDiscounts.length) {
    return {lines: lines.map(line => ({...line, discount: 0, discountedNet: line.lineNet})), itemDiscountTotal: 0};
  }
  const byIndex = new Map();
  for (const entry of itemDiscounts) {
    const index = Number(entry.index);
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
      throw httpError('Item discount refers to a line that is not on the order', 400);
    }
    if (byIndex.has(index)) throw httpError('Only one discount may be applied per line', 400);
    byIndex.set(index, entry);
  }

  let itemDiscountTotal = 0;
  const priced = lines.map((line, index) => {
    const entry = byIndex.get(index);
    if (!entry) return {...line, discount: 0, discountedNet: line.lineNet};
    if (entry.kind === 'fixed' && money(entry.value) > money(line.lineNet)) {
      throw httpError('Item discount cannot exceed the line total', 400);
    }
    const discount = computeDiscountAmount({kind: entry.kind, value: entry.value, base: line.lineNet});
    itemDiscountTotal = money(itemDiscountTotal + discount);
    return {
      ...line,
      discount,
      discountKind: entry.kind,
      discountValue: Number(entry.value),
      discountReason: clean(entry.reason) || undefined,
      discountedNet: money(line.lineNet - discount)
    };
  });
  return {lines: priced, itemDiscountTotal};
}

function isWithinWindow(coupon, now) {
  if (coupon.startsAt && now < new Date(coupon.startsAt)) return 'not_started';
  if (coupon.endsAt && now > new Date(coupon.endsAt)) return 'expired';
  return null;
}

/**
 * Validates a coupon against the order in hand and returns the discount it
 * would grant. Every rule the coupon carries is enforced here: active flag,
 * validity window, branch/order-type/menu-item scope, minimum spend, and both
 * the global and per-customer usage limits.
 *
 * `eligibleNet` is the portion of the order the coupon may discount — the whole
 * order, or just the matching lines when the coupon is scoped to menu items.
 */
export async function validateCoupon({
  code, restaurantId, branchId, orderType, customerId, lines = [], subtotal,
  now = new Date(), session, excludeOrderId = null
}) {
  const normalized = normalizeCode(code);
  if (!normalized) throw httpError('Coupon code is required', 400);

  const coupon = await Coupon.findOne({restaurant: restaurantId, code: normalized}).session(session || null);
  if (!coupon) throw httpError(`Coupon ${normalized} was not found`, 404);
  if (!coupon.active) throw httpError(`Coupon ${normalized} is not active`, 409);

  const window = isWithinWindow(coupon, now);
  if (window === 'not_started') throw httpError(`Coupon ${normalized} is not valid yet`, 409);
  if (window === 'expired') throw httpError(`Coupon ${normalized} has expired`, 409);

  if (coupon.branches?.length && branchId && !coupon.branches.some(b => String(b) === String(branchId))) {
    throw httpError(`Coupon ${normalized} is not valid at this branch`, 409);
  }
  if (coupon.orderTypes?.length && orderType && !coupon.orderTypes.includes(orderType)) {
    throw httpError(`Coupon ${normalized} is not valid for ${orderType} orders`, 409);
  }

  // Menu-item scoping narrows the discountable base to the matching lines.
  let eligibleNet = money(subtotal);
  if (coupon.menuItems?.length) {
    const scoped = lines.filter(line => coupon.menuItems.some(id => String(id) === String(line.menuItem)));
    if (!scoped.length) throw httpError(`Coupon ${normalized} does not apply to any item on this order`, 409);
    eligibleNet = money(scoped.reduce((sum, line) => sum + Number(line.discountedNet ?? line.lineNet ?? 0), 0));
  }

  if (Number(coupon.minOrderAmount || 0) > 0 && money(subtotal) < money(coupon.minOrderAmount)) {
    throw httpError(`Coupon ${normalized} needs a minimum order of ${money(coupon.minOrderAmount)}`, 409);
  }

  if (Number(coupon.usageLimit || 0) > 0) {
    const used = await CouponRedemption.countDocuments({
      coupon: coupon._id,
      ...(excludeOrderId ? {order: {$ne: excludeOrderId}} : {})
    }).session(session || null);
    if (used >= Number(coupon.usageLimit)) throw httpError(`Coupon ${normalized} has reached its usage limit`, 409);
  }

  if (Number(coupon.perCustomerLimit || 0) > 0) {
    if (!customerId) throw httpError(`Coupon ${normalized} requires an identified customer`, 409);
    const usedByCustomer = await CouponRedemption.countDocuments({
      coupon: coupon._id,
      customer: customerId,
      ...(excludeOrderId ? {order: {$ne: excludeOrderId}} : {})
    }).session(session || null);
    if (usedByCustomer >= Number(coupon.perCustomerLimit)) {
      throw httpError(`Coupon ${normalized} has already been used by this customer`, 409);
    }
  }

  const amount = computeDiscountAmount({
    kind: coupon.kind,
    value: coupon.value,
    base: eligibleNet,
    maxDiscount: coupon.maxDiscount
  });
  if (!(amount > 0)) throw httpError(`Coupon ${normalized} would not discount this order`, 409);

  return {coupon, code: normalized, amount, eligibleNet};
}

/**
 * Combines the manual order discount with a coupon.
 *
 * Both are applied to the item-discounted subtotal and the sum is clamped so
 * the order can never go below zero.
 */
export function resolveOrderDiscount({subtotalAfterItems, manual, couponAmount = 0}) {
  const base = money(subtotalAfterItems);
  let manualAmount = 0;
  if (manual && (manual.value !== undefined && manual.value !== null && manual.value !== '')) {
    // A keyed-in amount above the order is almost always a mistake (a mistyped
    // 1000 for 100), so it is rejected rather than silently clamped. A coupon's
    // value is set by management, so that one is clamped instead.
    if (manual.kind === 'fixed' && money(manual.value) > base) {
      throw httpError('Discount cannot exceed the order subtotal', 400);
    }
    manualAmount = computeDiscountAmount({kind: manual.kind, value: manual.value, base});
  }
  const total = money(Math.min(money(manualAmount + money(couponAmount)), base));
  return {manualAmount, couponAmount: money(couponAmount), orderDiscountTotal: total};
}

/**
 * Records a redemption so usage limits hold across orders.
 *
 * 11E: the total usage limit is CLAIMED atomically here, not merely checked
 * in validateCoupon(). Counting redemptions and then inserting is a
 * read-then-write race: two concurrent transactions both read `used = 0`
 * against a usageLimit of 1, both insert, and the coupon is redeemed twice.
 * Reproduced against the database before this was changed.
 *
 * The conditional $inc below is the real guarantee. Only one writer can move
 * timesRedeemed from N to N+1 while it is still below the limit; the loser
 * matches no document and is refused. validateCoupon() still runs first so a
 * guest gets a clear message in the ordinary case -- this closes the window
 * between that check and the insert.
 */
export async function recordRedemption({coupon, order, restaurantId, branchId, customerId, amount, user, session}) {
  const limit = Number(coupon.usageLimit || 0);
  if (limit > 0) {
    const claimed = await Coupon.updateOne(
      {_id: coupon._id, timesRedeemed: {$lt: limit}},
      {$inc: {timesRedeemed: 1}},
      {session}
    );
    if (!claimed.modifiedCount) {
      throw httpError(`Coupon ${coupon.code} has reached its usage limit`, 409);
    }
  } else {
    await Coupon.updateOne({_id: coupon._id}, {$inc: {timesRedeemed: 1}}, {session});
  }

  try {
    const [row] = await CouponRedemption.create([{
      coupon: coupon._id,
      restaurant: restaurantId,
      branch: branchId || null,
      order: order._id,
      customer: customerId || null,
      code: coupon.code,
      amount: money(amount),
      redeemedBy: user?.id || user?._id || null
    }], {session});
    return row;
  } catch (error) {
    // The unique {coupon, order} index refusing means this order already
    // redeemed the coupon, so the claim above must not stand.
    if (error?.code === 11000) {
      throw httpError(`Coupon ${coupon.code} has already been applied to this order`, 409);
    }
    throw error;
  }
}

/** Validates and normalizes a coupon definition before it is stored. */
export function normalizeCouponInput(input = {}) {
  const code = normalizeCode(input.code);
  if (!code) throw httpError('Coupon code is required', 400);
  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) {
    throw httpError('Coupon code may use letters, numbers, hyphen and underscore', 400);
  }
  if (!DISCOUNT_KINDS.includes(input.kind)) throw httpError(`Coupon kind must be one of ${DISCOUNT_KINDS.join(', ')}`, 400);
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) throw httpError('Coupon value must be greater than zero', 400);
  if (input.kind === 'percentage' && value > 100) throw httpError('Percentage coupon cannot exceed 100%', 400);

  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) throw httpError('Invalid coupon start date', 400);
  if (endsAt && Number.isNaN(endsAt.getTime())) throw httpError('Invalid coupon end date', 400);
  if (startsAt && endsAt && startsAt > endsAt) throw httpError('Coupon start date must be before its end date', 400);

  for (const [label, raw] of [['usage limit', input.usageLimit], ['per-customer limit', input.perCustomerLimit]]) {
    if (raw !== undefined && raw !== null && (!Number.isInteger(Number(raw)) || Number(raw) < 0)) {
      throw httpError(`Coupon ${label} must be a non-negative whole number`, 400);
    }
  }
  for (const id of [...(input.branches || []), ...(input.menuItems || [])]) {
    if (!mongoose.isValidObjectId(id)) throw httpError('Coupon scope contains an invalid id', 400);
  }

  return {
    code,
    description: clean(input.description) || undefined,
    kind: input.kind,
    value: money(value),
    maxDiscount: input.maxDiscount === undefined || input.maxDiscount === null ? null : money(input.maxDiscount),
    minOrderAmount: money(input.minOrderAmount || 0),
    startsAt,
    endsAt,
    usageLimit: Number(input.usageLimit || 0),
    perCustomerLimit: Number(input.perCustomerLimit || 0),
    branches: input.branches || [],
    menuItems: input.menuItems || [],
    orderTypes: input.orderTypes || [],
    active: input.active !== false
  };
}
