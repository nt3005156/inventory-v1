import {Branch, Order, Payment, Restaurant, SalesInvoiceCounter} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {money} from './billing.js';
import {refundedTotal, settledPayments} from './refunds.js';

// Phase 4E — Receipts.
//
// A receipt is a rendering of an order that already exists; it never re-prices
// anything. Every figure below is read from the stored order so a reprint two
// weeks later shows exactly what the guest was charged, even if menu prices,
// recipe costs or VAT settings have moved since.

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Kathmandu-local timestamp for the printed document. */
export function kathmanduStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).reduce((acc, p) => ({...acc, [p.type]: p.value}), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * Allocates the next tax invoice number for a branch and year.
 *
 * Mirrors the purchase-order counter: scoped by the number's visible branch
 * code so the sequence stays gapless and unique restaurant-wide.
 */
export async function nextInvoiceNumber({restaurantId, branch, issuedAt = new Date(), session}) {
  const year = Number(new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'Asia/Kathmandu'}).format(issuedAt));
  const branchCode = clean(branch.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch._id).slice(-4).toUpperCase();
  const counter = await SalesInvoiceCounter.findOneAndUpdate(
    {restaurant: restaurantId, branchCode, year},
    {$inc: {value: 1}, $setOnInsert: {restaurant: restaurantId, branch: branch._id, branchCode, year}},
    {upsert: true, new: true, session, setDefaultsOnInsert: true}
  );
  return `INV-${branchCode}-${year}-${String(counter.value).padStart(6, '0')}`;
}

const TYPE_LABELS = {
  'dine-in': 'Dine-in',
  takeaway: 'Takeaway',
  counter: 'Counter',
  delivery: 'Delivery',
  pickup: 'Pickup',
  online: 'Online'
};

/**
 * Assembles the receipt document for an order.
 *
 * VAT is reported both as the order total and as a per-line breakdown, since a
 * ticket can legitimately mix VAT-inclusive and VAT-exclusive menu prices and a
 * tax invoice has to show the taxable value it was computed from.
 */
export function buildReceipt({order, restaurant, branch, payments = [], customer, table}) {
  const vatRate = Number(order.vatRate ?? 13);
  const lines = (order.items || []).map(item => {
    const lineNet = money(item.lineNet ?? Number(item.unitPrice || 0) * Number(item.qty || 0));
    const discount = money(item.discount || 0);
    return {
      name: item.name,
      qty: Number(item.qty || 0),
      unitPrice: money(item.unitPrice),
      basePrice: money(item.basePrice ?? item.unitPrice),
      vatInclusive: item.vatInclusive === true,
      modifiers: (item.modifiers || []).map(m => ({
        name: m.name,
        price: money(m.price || 0),
        kind: m.kind,
        removed: Boolean(m.removed)
      })),
      specialInstructions: clean(item.specialInstructions) || undefined,
      notes: clean(item.notes) || undefined,
      discount,
      discountKind: discount > 0 ? item.discountKind : undefined,
      lineNet,
      lineVat: money(item.lineVat || 0),
      lineTotal: money(item.lineTotal ?? lineNet)
    };
  });

  const settled = settledPayments(payments);
  const refunded = refundedTotal(payments);
  const tenders = settled.map(p => ({
    method: p.method,
    amount: money(p.amount),
    transactionId: clean(p.transactionId) || undefined,
    at: p.createdAt
  }));
  const refunds = payments
    .filter(p => Number(p.amount) < 0)
    .map(p => ({
      method: p.method,
      amount: money(Math.abs(Number(p.amount))),
      reason: clean(p.reason) || undefined,
      at: p.createdAt
    }));

  const taxableValue = money(Number(order.total || 0) - Number(order.vat || 0) - Number(order.deliveryFee || 0));

  return {
    document: order.invoiceNo ? 'tax_invoice' : 'receipt',
    invoiceNo: order.invoiceNo || null,
    orderNo: order.orderNo,
    issuedAt: order.invoicedAt || order.updatedAt || order.createdAt,
    printedAt: new Date(),
    printedAtLocal: kathmanduStamp(),
    reprint: Number(order.printCount || 0) > 1,
    printCount: Number(order.printCount || 0),
    currency: restaurant?.currency || 'NPR',
    timezone: 'Asia/Kathmandu',
    seller: {
      name: restaurant?.name || 'Restaurant',
      pan: restaurant?.pan || null,
      branch: branch?.name || null,
      branchCode: branch?.code || null,
      address: branch?.address || restaurant?.address || null,
      phone: branch?.phone || restaurant?.phone || null,
      footer: restaurant?.receiptFooter || null
    },
    order: {
      id: String(order._id),
      type: order.type,
      typeLabel: TYPE_LABELS[order.type] || order.type,
      status: order.status,
      placedAt: order.createdAt,
      placedAtLocal: kathmanduStamp(order.createdAt),
      table: table?.name || null,
      deliveryAddress: order.deliveryAddress || null,
      itemCount: lines.reduce((sum, line) => sum + line.qty, 0)
    },
    customer: customer ? {name: customer.name || null, phone: customer.phone || null} : null,
    lines,
    totals: {
      subtotal: money(order.subtotal),
      itemDiscount: money(order.itemDiscount || 0),
      manualDiscount: money(order.manualDiscount || 0),
      couponDiscount: money(order.couponDiscount || 0),
      couponCode: order.couponCode || null,
      discountTotal: money(order.discountTotal || order.discount || 0),
      serviceChargeRate: Number(order.serviceChargeRate || 0),
      serviceCharge: money(order.serviceCharge || 0),
      taxableValue,
      vatRate,
      vat: money(order.vat || 0),
      deliveryFee: money(order.deliveryFee || 0),
      total: money(order.total)
    },
    payment: {
      tenders,
      refunds,
      paid: money(order.paidAmount || 0),
      due: money(order.dueAmount || 0),
      refunded,
      settled: money(order.dueAmount || 0) <= 0,
      change: 0
    }
  };
}

/** Loads an order and issues (or reuses) its tax invoice number. */
export async function getReceipt({orderId, user, issue = false, session}) {
  const order = await Order.findById(orderId).session(session || null);
  if (!order) throw httpError('Order not found', 404);
  assertBranchAccess(user, order.branch);

  const branch = await Branch.findById(order.branch).session(session || null);
  if (!branch) throw httpError('Branch not found', 404);
  const restaurant = await Restaurant.findById(branch.restaurant).session(session || null);

  // A tax invoice number is only allocated for a real sale, and only once.
  if (issue) {
    if (['cancelled'].includes(order.status)) throw httpError('A cancelled order cannot be invoiced', 409);
    if (!order.invoiceNo) {
      order.invoiceNo = await nextInvoiceNumber({
        restaurantId: branch.restaurant,
        branch,
        issuedAt: new Date(),
        session
      });
      order.invoicedAt = new Date();
    }
    order.printCount = Number(order.printCount || 0) + 1;
    order.lastPrintedAt = new Date();
    await order.save({session: session || undefined});
  }

  const [payments, populated] = await Promise.all([
    Payment.find({order: order._id}).sort({createdAt: 1}).session(session || null),
    Order.findById(order._id)
      .populate('customer', 'name phone')
      .populate('table', 'name area')
      .session(session || null)
  ]);

  return buildReceipt({
    order,
    restaurant,
    branch,
    payments,
    customer: populated?.customer,
    table: populated?.table
  });
}

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const npr = value => Number(value || 0).toLocaleString('en-NP', {minimumFractionDigits: 2, maximumFractionDigits: 2});

/**
 * Renders the receipt as a self-contained 80mm thermal-printer page.
 *
 * All styling is inline: the document must print identically with no network
 * access, so it references no external stylesheet, font or image.
 */
export function renderReceiptHtml(receipt) {
  const t = receipt.totals;
  const row = (label, value, cls = '') =>
    `<tr class="${cls}"><td>${esc(label)}</td><td class="r">${npr(value)}</td></tr>`;

  const lineRows = receipt.lines.map(line => {
    const mods = line.modifiers.length
      ? `<div class="mod">${line.modifiers.map(m => esc((m.removed ? 'No ' : '') + m.name)).join(', ')}</div>`
      : '';
    const note = line.specialInstructions ? `<div class="mod">“${esc(line.specialInstructions)}”</div>` : '';
    const disc = line.discount > 0 ? `<div class="mod">Discount −${npr(line.discount)}</div>` : '';
    return `<tr>
      <td>${esc(line.name)}${mods}${note}${disc}</td>
      <td class="c">${line.qty}</td>
      <td class="r">${npr(line.unitPrice)}</td>
      <td class="r">${npr(line.lineTotal)}</td>
    </tr>`;
  }).join('');

  const tenderRows = receipt.payment.tenders
    .map(p => row(p.method.toUpperCase() + (p.transactionId ? ` · ${p.transactionId}` : ''), p.amount))
    .join('');
  const refundRows = receipt.payment.refunds
    .map(p => row('Refund · ' + p.method.toUpperCase(), -p.amount, 'neg'))
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(receipt.invoiceNo || receipt.orderNo)}</title>
<style>
@page{size:80mm auto;margin:3mm}
*{box-sizing:border-box}
body{width:74mm;margin:0 auto;padding:4mm 0;font:12px/1.45 "DejaVu Sans Mono",“Courier New”,monospace;color:#000;background:#fff}
h1{font-size:15px;margin:0 0 2px;text-align:center;letter-spacing:.5px}
.sub{text-align:center;font-size:11px;margin:0}
.doc{text-align:center;font-weight:700;margin:8px 0 2px;font-size:12px;letter-spacing:1px}
hr{border:0;border-top:1px dashed #000;margin:7px 0}
table{width:100%;border-collapse:collapse}
td{padding:1px 0;vertical-align:top}
.r{text-align:right;white-space:nowrap}
.c{text-align:center;width:26px}
.items td{padding:3px 0}
.items thead td{border-bottom:1px solid #000;font-weight:700;padding-bottom:3px}
.mod{font-size:10px;padding-left:6px}
.tot td{padding:2px 0}
.grand td{border-top:1px solid #000;border-bottom:3px double #000;font-weight:700;font-size:13px;padding:4px 0}
.neg td{}
.meta{font-size:11px}
.foot{text-align:center;font-size:11px;margin-top:8px}
.reprint{text-align:center;font-weight:700;border:1px solid #000;padding:2px;margin:6px 0;font-size:11px}
@media print{.noprint{display:none}}
.noprint{display:block;text-align:center;margin:10px 0}
.noprint button{font:inherit;padding:6px 14px}
</style></head>
<body onload="window.focus()">
<h1>${esc(receipt.seller.name)}</h1>
${receipt.seller.branch ? `<p class="sub">${esc(receipt.seller.branch)}</p>` : ''}
${receipt.seller.address ? `<p class="sub">${esc(receipt.seller.address)}</p>` : ''}
${receipt.seller.phone ? `<p class="sub">Tel: ${esc(receipt.seller.phone)}</p>` : ''}
${receipt.seller.pan ? `<p class="sub">PAN: ${esc(receipt.seller.pan)}</p>` : ''}
<p class="doc">${receipt.invoiceNo ? 'TAX INVOICE' : 'RECEIPT'}</p>
${receipt.reprint ? `<p class="reprint">REPRINT (${receipt.printCount})</p>` : ''}
<hr>
<table class="meta">
${receipt.invoiceNo ? `<tr><td>Invoice</td><td class="r">${esc(receipt.invoiceNo)}</td></tr>` : ''}
<tr><td>Order</td><td class="r">${esc(receipt.orderNo)}</td></tr>
<tr><td>Date</td><td class="r">${esc(receipt.printedAtLocal)}</td></tr>
<tr><td>Type</td><td class="r">${esc(receipt.order.typeLabel)}</td></tr>
${receipt.order.table ? `<tr><td>Table</td><td class="r">${esc(receipt.order.table)}</td></tr>` : ''}
${receipt.customer?.name ? `<tr><td>Customer</td><td class="r">${esc(receipt.customer.name)}</td></tr>` : ''}
${receipt.customer?.phone ? `<tr><td>Phone</td><td class="r">${esc(receipt.customer.phone)}</td></tr>` : ''}
${receipt.order.deliveryAddress ? `<tr><td>Deliver to</td><td class="r">${esc(receipt.order.deliveryAddress)}</td></tr>` : ''}
</table>
<hr>
<table class="items">
<thead><tr><td>Item</td><td class="c">Qty</td><td class="r">Rate</td><td class="r">Amount</td></tr></thead>
<tbody>${lineRows}</tbody>
</table>
<hr>
<table class="tot">
${row('Subtotal', t.subtotal)}
${t.itemDiscount > 0 ? row('Item discounts', -t.itemDiscount) : ''}
${t.manualDiscount > 0 ? row('Discount', -t.manualDiscount) : ''}
${t.couponDiscount > 0 ? row('Coupon ' + (t.couponCode || ''), -t.couponDiscount) : ''}
${t.serviceCharge > 0 ? row(`Service charge ${t.serviceChargeRate}%`, t.serviceCharge) : ''}
${row('Taxable value', t.taxableValue)}
${row(`VAT ${t.vatRate}%`, t.vat)}
${t.deliveryFee > 0 ? row('Delivery fee', t.deliveryFee) : ''}
</table>
<table class="tot grand"><tr><td>TOTAL</td><td class="r">${npr(t.total)}</td></tr></table>
<table class="tot">
${tenderRows}
${refundRows}
${receipt.payment.due > 0 ? row('Balance due', receipt.payment.due) : ''}
</table>
<hr>
<p class="foot">${receipt.payment.settled ? 'PAID' : 'BALANCE DUE'}</p>
${receipt.seller.footer ? `<p class="foot">${esc(receipt.seller.footer)}</p>` : ''}
<p class="foot">Thank you · धन्यवाद</p>
<div class="noprint"><button onclick="window.print()">Print</button></div>
</body></html>`;
}
