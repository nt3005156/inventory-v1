import {money} from './billing.js';
import {applyItemDiscounts} from './discounts.js';

// Phase 4A — POS Core.
// The four service channels the POS sells through.
export const ORDER_TYPES = Object.freeze(['dine-in', 'takeaway', 'counter', 'delivery']);

// Nepal convention: 13% VAT, and dine-in commonly carries a 10% service charge
// that is itself taxable, so it is added to the base before VAT is applied.
export const DEFAULT_VAT_RATE = 13;
export const DEFAULT_DINE_IN_SERVICE_RATE = 10;

export const TYPE_RULES = Object.freeze({
  'dine-in': {table: 'required', serviceChargeRate: DEFAULT_DINE_IN_SERVICE_RATE, deliveryFee: false, customer: 'optional'},
  takeaway: {table: 'forbidden', serviceChargeRate: 0, deliveryFee: false, customer: 'optional'},
  counter: {table: 'forbidden', serviceChargeRate: 0, deliveryFee: false, customer: 'optional'},
  delivery: {table: 'forbidden', serviceChargeRate: 0, deliveryFee: true, customer: 'required'}
});

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

export function normalizeOrderType(type) {
  const value = String(type ?? 'counter').trim().toLowerCase();
  if (!ORDER_TYPES.includes(value)) {
    throw httpError(`Order type must be one of ${ORDER_TYPES.join(', ')}`, 400);
  }
  return value;
}

export function rulesFor(type) {
  return TYPE_RULES[normalizeOrderType(type)];
}

/**
 * Validates the channel-specific shape of an order before it is priced.
 * Dine-in must be seated; takeaway/counter/delivery must not hold a table;
 * delivery must identify the customer and where the food is going.
 */
export function assertTypeRules({type, table, customer, deliveryAddress}) {
  const orderType = normalizeOrderType(type);
  const rules = TYPE_RULES[orderType];

  if (rules.table === 'required' && !table) {
    throw httpError('Dine-in orders require a table', 400);
  }
  if (rules.table === 'forbidden' && table) {
    throw httpError(`${orderType} orders cannot be assigned a table`, 400);
  }
  if (rules.customer === 'required' && !customer) {
    throw httpError('Delivery orders require a customer', 400);
  }
  if (orderType === 'delivery' && !String(deliveryAddress ?? '').trim()) {
    throw httpError('Delivery orders require a delivery address', 400);
  }
  if (orderType !== 'delivery' && String(deliveryAddress ?? '').trim()) {
    throw httpError('Only delivery orders accept a delivery address', 400);
  }
  return orderType;
}

export function resolveServiceChargeRate(type, requested) {
  const rules = rulesFor(type);
  if (requested === undefined || requested === null || requested === '') return rules.serviceChargeRate;
  const rate = Number(requested);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw httpError('Service charge rate must be between 0 and 100', 400);
  if (rate > 0 && rules.serviceChargeRate === 0) {
    throw httpError(`${normalizeOrderType(type)} orders do not carry a service charge`, 400);
  }
  return rate;
}

export function resolveDeliveryFee(type, requested) {
  const fee = Number(requested || 0);
  if (!Number.isFinite(fee) || fee < 0) throw httpError('Delivery fee must be a non-negative amount', 400);
  if (fee > 0 && !rulesFor(type).deliveryFee) {
    throw httpError(`${normalizeOrderType(type)} orders cannot carry a delivery fee`, 400);
  }
  return money(fee);
}

/**
 * Prices one order line.
 *
 * A VAT-inclusive menu price already contains the tax the guest pays, so the
 * net is extracted from it and the VAT is taken as the exact remainder — that
 * keeps an inclusive item's total identical to the price on the menu board.
 * A VAT-exclusive price is the net, and VAT is added on top.
 */
export function priceLine({unitPrice, qty, vatInclusive, vatRate = DEFAULT_VAT_RATE}) {
  const price = Number(unitPrice || 0);
  const quantity = Number(qty || 0);
  const rate = Number(vatRate ?? DEFAULT_VAT_RATE);
  if (!Number.isFinite(price) || price < 0) throw httpError('Line unit price must be a non-negative amount', 400);
  if (!Number.isFinite(quantity) || quantity <= 0) throw httpError('Line quantity must be greater than zero', 400);

  if (vatInclusive) {
    const gross = money(price * quantity);
    const net = money(gross / (1 + rate / 100));
    return {
      unitPrice: price,
      qty: quantity,
      vatInclusive: true,
      netUnitPrice: money(net / quantity),
      lineNet: net,
      lineVat: money(gross - net),
      lineGross: gross
    };
  }
  const net = money(price * quantity);
  const vat = money(net * rate / 100);
  return {
    unitPrice: price,
    qty: quantity,
    vatInclusive: false,
    netUnitPrice: price,
    lineNet: net,
    lineVat: vat,
    lineGross: money(net + vat)
  };
}

/**
 * Rolls priced lines into order totals.
 *
 * Order of operations (Nepal): net subtotal, less discount, plus service
 * charge; VAT applies to that whole base. The delivery fee is a pass-through
 * charge added after VAT and is not itself taxed.
 */
export function computeOrderTotals({lines, discount = 0, serviceChargeRate = 0, deliveryFee = 0, vatRate = DEFAULT_VAT_RATE}) {
  const rate = Number(vatRate ?? DEFAULT_VAT_RATE);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw httpError('VAT rate must be between 0 and 100', 400);

  const subtotal = money(lines.reduce((sum, line) => sum + line.lineNet, 0));
  // Item-level discounts (Phase 4C) reduce their line before order maths run.
  const itemDiscount = money(lines.reduce((sum, line) => sum + Number(line.discount || 0), 0));
  const netAfterItems = money(subtotal - itemDiscount);
  const itemVat = money(lines.reduce((sum, line) => {
    const lineNet = Number(line.lineNet || 0);
    if (lineNet <= 0) return sum + Number(line.lineVat || 0);
    // VAT follows the discounted portion of the line.
    const share = Number(line.discountedNet ?? lineNet) / lineNet;
    return sum + Number(line.lineVat || 0) * share;
  }, 0));
  const discountAmount = money(discount || 0);
  if (discountAmount < 0) throw httpError('Discount must be a non-negative amount', 400);
  if (discountAmount > netAfterItems) throw httpError('Discount cannot exceed the order subtotal', 400);

  const discountedNet = money(netAfterItems - discountAmount);
  const serviceCharge = money(discountedNet * Number(serviceChargeRate || 0) / 100);
  // Discounting removes tax with it; the service charge adds tax of its own.
  const discountVat = money(discountAmount * rate / 100);
  const serviceVat = money(serviceCharge * rate / 100);
  const vat = money(Math.max(0, itemVat - discountVat + serviceVat));
  const fee = money(deliveryFee || 0);
  const total = money(discountedNet + serviceCharge + vat + fee);

  return {
    subtotal,
    itemDiscount,
    netAfterItems,
    discount: discountAmount,
    discountTotal: money(itemDiscount + discountAmount),
    serviceChargeRate: Number(serviceChargeRate || 0),
    serviceCharge,
    vatRate: rate,
    vat,
    deliveryFee: fee,
    total,
    itemVat,
    taxableBase: money(discountedNet + serviceCharge)
  };
}

/**
 * Full POS pricing pass: validate the channel, price every line, total it up.
 */
export function priceOrder({type, table, customer, deliveryAddress, items, discount, itemDiscounts, serviceChargeRate, deliveryFee, vatRate = DEFAULT_VAT_RATE}) {
  const orderType = assertTypeRules({type, table, customer, deliveryAddress});
  if (!Array.isArray(items) || !items.length) throw httpError('An order needs at least one item', 400);

  const rawLines = items.map(item => priceLine({
    unitPrice: item.unitPrice,
    qty: item.qty,
    vatInclusive: item.vatInclusive,
    vatRate
  }));
  const {lines} = applyItemDiscounts({lines: rawLines, itemDiscounts});
  const totals = computeOrderTotals({
    lines,
    discount,
    serviceChargeRate: resolveServiceChargeRate(orderType, serviceChargeRate),
    deliveryFee: resolveDeliveryFee(orderType, deliveryFee),
    vatRate
  });
  return {type: orderType, lines, ...totals};
}
