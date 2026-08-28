import mongoose from 'mongoose';
import {Ingredient, MenuItem} from '../models/index.js';
import {Branch, Customer, Order, Payment, Restaurant} from '../models/operations.js';
import {money} from './billing.js';
import {priceOrder} from './pos.js';
import {applyModifierPricing, resolveModifiers, toOrderModifiers, normalizeInstructions} from './modifiers.js';
import {listStations, routeItemToStation} from './stations.js';
import {withMonthlyOnlineOrderQuota} from './orderQuota.js';
import {resolveEntitlement} from './entitlements.js';
import {recordRedemption, resolveOrderDiscount, validateCoupon} from './discounts.js';
import {availablePaymentMethods} from './paymentConfig.js';
import {findOrCreateCustomer} from './customers.js';

// Phase 8A — public online ordering.
//
// This is the system's first UNAUTHENTICATED write path, so the guiding rule
// throughout is: the browser supplies intent, never authority. A guest may say
// which menu item and how many; every price, tax, station and total is derived
// server-side from stored records. Nothing a guest sends is trusted as money.

export const ONLINE_ORDER_TYPES = Object.freeze(['delivery', 'takeaway']);
export const ONLINE_PAYMENT_METHODS = Object.freeze(['cod', 'esewa', 'khalti']);
// A public checkout must not be a channel for arbitrarily large orders.
export const MAX_PUBLIC_LINES = 30;
export const MAX_PUBLIC_QTY = 20;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * An error whose message is written for the guest and is safe to show even at
 * a 5xx status. Opt-in, so an unexpected internal 500 is still masked.
 */
function publicError(message, status = 400) {
  return Object.assign(new Error(message), {status, publicMessage: true});
}

const clean = value => String(value ?? '').trim();

/**
 * Resolves the branch a guest is ordering from.
 *
 * A public caller has no tenant context, so the branch id is the only handle —
 * but it is validated against active branches so a guessed or stale id cannot
 * reach an inactive or non-existent site.
 */
/**
 * P2E — the online-ordering entitlement gate for the PUBLIC surface.
 *
 * Placed in the SERVICE layer, not the routes: `getPublicMenu`, `priceCart`
 * and `placePublicOrder` each have more than one caller (routes, the payment
 * return handler, tests), and a route-level check would have to be duplicated
 * at every one of them and would be missed by the next.
 *
 * The tenant is derived from the BRANCH, using `resolvePublicBranch()` — the
 * mechanism this file already uses for menus and quotes. A guest's browser
 * never supplies a restaurant id, so it cannot aim the check at another
 * tenant.
 *
 * Imported lazily because `featureGuard` -> `entitlements` -> `tenantAdmin`
 * would otherwise close a cycle back to this module.
 */
async function assertOnlineOrdering(branchId, {label} = {}) {
  const {assertPublicFeature} = await import('./featureGuard.js');
  return assertPublicFeature({
    branchId, feature: 'onlineOrdering',
    resolveBranch: id => resolvePublicBranch(id),
    label: label || 'Online ordering'
  });
}

export async function resolvePublicBranch(branchId, {session} = {}) {
  if (!branchId) throw httpError('Branch is required', 400);
  if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  const branch = await Branch.findOne({_id: branchId, active: {$ne: false}})
    .select('restaurant name code address phone')
    .session(session || null)
    .lean();
  if (!branch) throw httpError('Branch not found', 404);
  return branch;
}

/** Branches a guest may order from, for the storefront's location picker. */
export async function listPublicBranches() {
  const branches = await Branch.find({active: {$ne: false}})
    .select('restaurant name code address phone')
    .sort({name: 1})
    .lean();
  const restaurants = await Restaurant.find({
    _id: {$in: [...new Set(branches.map(b => String(b.restaurant)))]}
  }).select('name currency').lean();
  const byId = new Map(restaurants.map(r => [String(r._id), r]));
  return branches.map(b => ({
    id: b._id,
    name: b.name,
    code: b.code,
    address: b.address || null,
    phone: b.phone || null,
    restaurant: byId.get(String(b.restaurant))?.name || null,
    currency: byId.get(String(b.restaurant))?.currency || 'NPR'
  }));
}

/**
 * The public menu for a branch.
 *
 * Deliberately narrow: cost, margin, recipe and supplier data are commercially
 * sensitive and never leave the building. Only what a guest needs to choose a
 * dish is exposed.
 */
export async function getPublicMenu({branchId}) {
  // Gated: the menu IS the ordering surface. Branding stays reachable
  // separately (P2D's /public/branding), so a restaurant without the feature
  // still has a public identity — it simply cannot take orders.
  const branch = await assertOnlineOrdering(branchId, {label: 'Online ordering'});
  const ingredientIds = await Ingredient.find({restaurant: branch.restaurant}).distinct('_id');
  const items = await MenuItem.find({
    active: {$ne: false},
    'recipe.ingredient': {$in: ingredientIds}
  }).sort({category: 1, name: 1}).lean();

  const categories = new Map();
  for (const item of items) {
    const key = clean(item.category) || 'other';
    if (!categories.has(key)) categories.set(key, []);
    categories.get(key).push({
      id: item._id,
      name: item.name,
      nameNp: item.nameNp || null,
      description: item.description || null,
      price: money(item.price),
      vatInclusive: item.vatInclusive !== false,
      imageUrl: item.imageUrl || null,
      // Guests need the choices, not the ingredient mappings behind them.
      modifierGroups: (item.modifierGroups || []).map(group => ({
        key: group.key,
        name: group.name,
        kind: group.kind,
        selection: group.selection,
        required: Boolean(group.required),
        minSelect: group.minSelect || 0,
        maxSelect: group.maxSelect || 0,
        options: (group.options || []).map(option => ({
          key: option.key,
          name: option.name,
          priceDelta: money(option.priceDelta || 0),
          priceOverride: option.priceOverride === null || option.priceOverride === undefined
            ? null
            : money(option.priceOverride),
          isDefault: Boolean(option.isDefault)
        }))
      }))
    });
  }

  return {
    branch: {
      id: branch._id, name: branch.name, code: branch.code,
      address: branch.address || null, phone: branch.phone || null
    },
    currency: 'NPR',
    categories: [...categories.entries()]
      .map(([category, menuItems]) => ({category, items: menuItems}))
      .sort((a, b) => a.category.localeCompare(b.category))
  };
}

/** Validates the guest's contact block. */
export function normalizeGuest(input = {}) {
  const name = clean(input.name);
  const phone = clean(input.phone);
  const email = clean(input.email);
  if (name.length < 2 || name.length > 120) throw httpError('A contact name is required', 400);
  // Nepal mobile numbers are 10 digits; allow +977 and separators.
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) throw httpError('A valid contact phone is required', 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError('Invalid email address', 400);
  return {name, phone, email: email || undefined};
}

/**
 * Prices a cart entirely from stored records.
 *
 * The guest sends menu item ids, quantities and modifier choices. Every price
 * is looked up here, so a tampered cart cannot buy a Rs.400 dish for Rs.1.
 */
export async function priceCart({branchId, type, items, deliveryAddress, couponCode, customerId, session}) {
  // Gated: quoting a cart is part of taking an order.
  await assertOnlineOrdering(branchId);
  const branch = await resolvePublicBranch(branchId, {session});
  const orderType = clean(type).toLowerCase() || 'delivery';
  if (!ONLINE_ORDER_TYPES.includes(orderType)) {
    throw httpError(`Online orders must be ${ONLINE_ORDER_TYPES.join(' or ')}`, 400);
  }
  if (!Array.isArray(items) || !items.length) throw httpError('Your cart is empty', 400);
  if (items.length > MAX_PUBLIC_LINES) throw httpError(`An online order may have at most ${MAX_PUBLIC_LINES} lines`, 400);

  const stations = await listStations({restaurantId: branch.restaurant, includeInactive: true, session});
  const priced = [];
  const lines = [];

  for (const row of items) {
    const qty = Number(row.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_PUBLIC_QTY) {
      throw httpError(`Quantity must be between 1 and ${MAX_PUBLIC_QTY}`, 400);
    }
    if (!mongoose.isValidObjectId(row.menuItem)) throw httpError('Invalid menu item', 400);

    const menuItem = await MenuItem.findById(row.menuItem).session(session || null);
    if (!menuItem || menuItem.active === false) throw httpError('That item is no longer available', 404);

    // The item must belong to this branch's restaurant, or a guest could pull
    // another tenant's menu into this order.
    const recipeIngredient = (menuItem.recipe || [])[0]?.ingredient;
    if (recipeIngredient) {
      const ingredient = await Ingredient.findById(recipeIngredient).select('restaurant').session(session || null).lean();
      if (ingredient && String(ingredient.restaurant) !== String(branch.restaurant)) {
        throw httpError('That item is not available at this branch', 404);
      }
    }

    const resolved = resolveModifiers({menuItem, selections: row.modifiers || []});
    const pricing = applyModifierPricing({basePrice: menuItem.price, modifiers: resolved});

    priced.push({unitPrice: pricing.unitPrice, qty, vatInclusive: menuItem.vatInclusive !== false});
    lines.push({
      menuItem: menuItem._id,
      name: menuItem.name,
      qty,
      basePrice: pricing.basePrice,
      unitPrice: pricing.unitPrice,
      vatInclusive: menuItem.vatInclusive !== false,
      station: routeItemToStation(menuItem, stations),
      prepMinutes: Number(menuItem.prepMinutes || 0),
      packagingCost: money(menuItem.packagingCost || 0),
      modifiers: toOrderModifiers(resolved),
      specialInstructions: normalizeInstructions(row.specialInstructions),
      recipeVersion: menuItem.recipeVersion || 1,
      inventoryRequirements: (menuItem.recipe || []).map(rec => ({
        ingredient: rec.ingredient,
        qty: Number(rec.qty || 0),
        unit: rec.unit
      }))
    });
  }

  const deliveryFee = orderType === 'delivery' ? money(branch.deliveryFee || 0) : 0;
  const base = priceOrder({
    type: orderType,
    customer: orderType === 'delivery' ? 'public' : undefined,
    deliveryAddress: orderType === 'delivery' ? (clean(deliveryAddress) || 'pending') : undefined,
    items: priced,
    deliveryFee,
    vatRate: 13
  });

  // Coupons reuse the Phase 4C engine, so every restriction it enforces —
  // validity window, branch and menu scope, usage and per-customer limits,
  // minimum spend and maximum discount — applies to a public order too. A
  // guest supplies only the code; the discount is computed here.
  let coupon = null;
  let couponAmount = 0;
  if (clean(couponCode)) {
    const result = await validateCoupon({
      code: couponCode,
      restaurantId: branch.restaurant,
      branchId: branch._id,
      orderType,
      customerId,
      lines: base.lines.map((line, i) => ({...line, menuItem: lines[i].menuItem})),
      subtotal: base.netAfterItems,
      session
    });
    coupon = result.coupon;
    couponAmount = result.amount;
  }

  const {orderDiscountTotal} = resolveOrderDiscount({
    subtotalAfterItems: base.netAfterItems, manual: null, couponAmount
  });

  const totals = orderDiscountTotal > 0
    ? priceOrder({
      type: orderType,
      customer: orderType === 'delivery' ? 'public' : undefined,
      deliveryAddress: orderType === 'delivery' ? (clean(deliveryAddress) || 'pending') : undefined,
      items: priced,
      discount: orderDiscountTotal,
      deliveryFee,
      vatRate: 13
    })
    : base;

  return {branch, orderType, lines, priced, totals, coupon, couponAmount};
}


/**
 * Confirms the branch can actually cook the cart.
 *
 * A public order does not deduct stock (the branch has not accepted it yet),
 * but taking an order the kitchen cannot fulfil wastes the guest's time and
 * the branch's. This is an availability check, not a reservation: the binding
 * deduction happens on acceptance, inside a transaction.
 */
export async function assertCartStock({branchId, lines, session}) {
  const {InventoryBalance} = await import('../models/operations.js');
  const required = new Map();
  for (const line of lines) {
    for (const requirement of line.inventoryRequirements || []) {
      const key = String(requirement.ingredient);
      required.set(key, (required.get(key) || 0) + Number(requirement.qty || 0) * Number(line.qty || 0));
    }
  }
  for (const [ingredientId, needed] of required) {
    const balance = await InventoryBalance.findOne({branch: branchId, ingredient: ingredientId})
      .session(session || null).lean();
    const onHand = Number(balance?.quantity || 0);
    if (onHand + 1e-9 < needed) {
      const {Ingredient: IngredientModel} = await import('../models/index.js');
      const ingredient = await IngredientModel.findById(ingredientId).select('name').session(session || null).lean();
      // Deliberately vague: exact stock levels are commercially sensitive.
      throw httpError(`Sorry, ${ingredient?.name || 'an item'} is out of stock right now`, 409);
    }
  }
}

/** Returns an existing public order for a repeated request key. */
export async function findByRequestKey(requestKey, {session} = {}) {
  if (!requestKey) return null;
  return Order.findOne({publicRequestKey: requestKey}).select('+publicRequestKey').session(session || null);
}

/**
 * Places a public order.
 *
 * Reuses the same Order shape the till produces, so a web order flows through
 * the kitchen, receipts and reporting exactly like any other. Inventory is NOT
 * deducted here: a web order is unconfirmed until the branch accepts it, and
 * deducting stock for an order that may be rejected would corrupt the ledger.
 */
export async function placePublicOrder({input, requestKey, session}) {
  /**
   * Gated INDEPENDENTLY of `priceCart()`.
   *
   * `priceCart()` is called below and is itself gated, so this is a second
   * check on the same decision. That is deliberate: order creation is the
   * irreversible act — it writes an Order, decrements stock and can take
   * money — and it must fail closed on its own merits rather than inheriting
   * safety from a helper somebody may later refactor or bypass.
   */
  await assertOnlineOrdering(input?.branch, {label: 'Online ordering'});
  const guest = normalizeGuest(input.customer);
  const {branch, orderType, lines, totals, coupon, couponAmount} = await priceCart({
    branchId: input.branch,
    type: input.type,
    items: input.items,
    deliveryAddress: input.address,
    couponCode: input.coupon,
    session
  });

  const address = clean(input.address);
  if (orderType === 'delivery' && address.length < 5) {
    throw httpError('A delivery address is required', 400);
  }
  const method = clean(input.paymentMethod).toLowerCase() || 'cod';
  if (!ONLINE_PAYMENT_METHODS.includes(method)) {
    throw httpError(`Payment must be one of ${ONLINE_PAYMENT_METHODS.join(', ')}`, 400);
  }
  // A gateway the deployment has no credentials for must not be selectable:
  // otherwise the guest reaches a dead redirect and the order sits unpayable.
  const offered = availablePaymentMethods();
  if (!offered.includes(method)) {
    throw publicError(`${method === 'esewa' ? 'eSewa' : 'Khalti'} is not available right now`, 503);
  }

  // Reuse an existing customer so a returning guest builds history rather than
  // a duplicate record. Phase 9 made this restaurant-wide and moved it behind
  // one shared helper, so the storefront, the POS and the CRM all converge on
  // the same profile — and the unique index settles any concurrent race.
  const {customer} = await findOrCreateCustomer({
    restaurantId: branch.restaurant,
    branchId: branch._id,
    name: guest.name,
    phone: guest.phone,
    email: guest.email,
    address,
    session
  });

  await assertCartStock({branchId: branch._id, lines, session});

  lines.forEach((line, index) => {
    line.lineNet = totals.lines[index].lineNet;
    line.lineVat = totals.lines[index].lineVat;
    line.lineTotal = totals.lines[index].lineGross;
  });

  /**
   * P2G.7 — a storefront order consumes BOTH monthly ceilings: the overall
   * `maxMonthlyOrders` and the online sub-allowance `maxMonthlyOnlineOrders`.
   * Both must hold, and the overall one is checked first so a globally
   * exhausted tenant gets the message about their plan rather than a
   * storefront-specific one.
   *
   * The tenant's timezone comes from the cached entitlement, so this adds no
   * `Restaurant` query to the guest checkout path.
   */
  const order = await withMonthlyOnlineOrderQuota({
    restaurantId: branch.restaurant,
    timezone: (await resolveEntitlement(branch.restaurant)).timezone,
    session: session || null
  }, async () => {
    const [created] = await Order.create([{
      orderNo: `WEB-${Date.now().toString().slice(-7)}`,
      publicRequestKey: requestKey || undefined,
      // P1B: the tenant is stamped on the row, not inferred from the branch.
      restaurant: branch.restaurant,
      branch: branch._id,
      customer: customer._id,
      type: orderType,
      // Awaiting the branch's acceptance; stock moves when they accept.
      status: 'pending',
      items: lines,
      deliveryAddress: orderType === 'delivery' ? address : undefined,
      subtotal: totals.subtotal,
      itemDiscount: 0,
      discount: totals.discount || 0,
      discountTotal: totals.discount || 0,
      couponDiscount: money(couponAmount || 0),
      couponCode: coupon ? coupon.code : undefined,
      vatRate: totals.vatRate,
      vat: totals.vat,
      serviceChargeRate: 0,
      serviceCharge: 0,
      deliveryFee: totals.deliveryFee,
      total: totals.total,
      paidAmount: 0,
      dueAmount: totals.total,
      inventoryDeducted: false,
      source: 'online',
      paymentMethod: method
    }], {session: session || undefined});
      return created;
  });

  // Redemption is recorded inside the same transaction, so usage limits hold
  // even if two guests submit the last use of a coupon simultaneously.
  if (coupon) {
    await recordRedemption({
      coupon, order, restaurantId: branch.restaurant, branchId: branch._id,
      customerId: customer._id, amount: couponAmount, user: {id: null}, session
    });
  }

  // A digital intent is recorded as pending, never as taken money. Nothing
  // here claims a gateway confirmed anything.
  let payment = null;
  if (method !== 'cod') {
    [payment] = await Payment.create([{
      order: order._id,
      // P1B: money carries its own tenant and branch.
      restaurant: branch.restaurant,
      branch: branch._id,
      amount: totals.total,
      method,
      status: 'pending'
    }], {session: session || undefined});
  }

  return {order, customer, payment, branch};
}

/** Public order status, keyed by order number + phone so it is not enumerable. */
export async function trackPublicOrder({orderNo, phone}) {
  const reference = clean(orderNo).toUpperCase();
  const contact = clean(phone);
  if (!reference || !contact) throw httpError('Order number and phone are required', 400);

  const order = await Order.findOne({orderNo: reference}).populate('customer', 'phone name').lean();
  // A wrong phone yields the same answer as a wrong order number, so the
  // endpoint cannot be used to enumerate orders.
  if (!order || clean(order.customer?.phone) !== contact) {
    throw httpError('No matching order found', 404);
  }
  return {
    orderNo: order.orderNo,
    status: order.status,
    type: order.type,
    placedAt: order.createdAt,
    total: money(order.total),
    paid: money(order.paidAmount),
    due: money(order.dueAmount),
    items: (order.items || []).map(i => ({name: i.name, qty: i.qty})),
    deliveryAddress: order.deliveryAddress || null
  };
}
