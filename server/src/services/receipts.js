import {Audit} from '../models/index.js';
import {Branch, Order, Payment, Restaurant, SalesInvoiceCounter} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
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

/**
 * Tax registration required before a numbered tax invoice may be issued.
 *
 * A Nepal tax invoice must carry the seller's PAN. Rather than fabricate or
 * silently omit it, issuing is refused so the invoice sequence is never spent
 * on a document that is not legally valid. A branch PAN overrides the
 * restaurant's when set.
 */
export function resolveSellerPan(restaurant, branch) {
  return clean(branch?.pan) || clean(restaurant?.pan) || null;
}

export function assertTaxConfig(restaurant, branch) {
  if (!resolveSellerPan(restaurant, branch)) {
    throw httpError(
      'Cannot issue a tax invoice: the restaurant PAN/VAT number is not configured. Set Restaurant.pan (or Branch.pan) first.',
      409
    );
  }
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
  // The upsert is only atomic because of the unique index on
  // {restaurant, branchCode, year}. Without it two concurrent first-issues each
  // insert their own counter, both read value 1, and two different orders are
  // handed the SAME tax invoice number — reproduced before the index existed.
  // With the index the loser gets E11000 instead, and retries onto the winner's
  // document, which is the correct outcome rather than a failed sale.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const counter = await SalesInvoiceCounter.findOneAndUpdate(
        {restaurant: restaurantId, branchCode, year},
        {$inc: {value: 1}, $setOnInsert: {restaurant: restaurantId, branch: branch._id, branchCode, year}},
        {upsert: true, new: true, session, setDefaultsOnInsert: true}
      );
      return `INV-${branchCode}-${year}-${String(counter.value).padStart(6, '0')}`;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      lastError = error;
    }
  }
  throw httpError('Could not allocate a tax invoice number; please retry', 503, {cause: lastError});
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

  // Phase 13: a reprint must be able to prove it still describes the sale the
  // number was issued against. `invoicedTotal` is pinned at allocation; if the
  // order has since drifted the document says so rather than quietly printing
  // a different figure under the same invoice number. Orders invoiced before
  // this field existed have no pinned total and are reported as unknown, never
  // as tampered.
  const invoicedTotal = order.invoicedTotal == null ? null : money(order.invoicedTotal);
  const tampered = Boolean(
    order.invoiceNo && invoicedTotal !== null && money(order.total) !== invoicedTotal
  );

  return {
    document: order.invoiceNo ? 'tax_invoice' : 'receipt',
    taxConfigured: Boolean(resolveSellerPan(restaurant, branch)),
    invoiceNo: order.invoiceNo || null,
    orderNo: order.orderNo,
    issuedAt: order.invoicedAt || order.updatedAt || order.createdAt,
    printedAt: new Date(),
    printedAtLocal: kathmanduStamp(),
    reprint: Number(order.printCount || 0) > 1,
    printCount: Number(order.printCount || 0),
    // The ORDINAL of this reprint, not the print count: the first reprint is
    // REPRINT (1), matching how a till operator counts them. printCount stays
    // the raw total, so the original print is print 1 / reprint 0.
    reprintNumber: Math.max(0, Number(order.printCount || 0) - 1),
    invoicedTotal,
    tampered,
    voided: Boolean(order.invoiceVoidedAt),
    voidedAt: order.invoiceVoidedAt || null,
    voidReason: clean(order.invoiceVoidReason) || null,
    currency: restaurant?.currency || 'NPR',
    timezone: 'Asia/Kathmandu',
    seller: {
      name: restaurant?.name || 'Restaurant',
      pan: resolveSellerPan(restaurant, branch),
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

/**
 * Phase 13: void an issued tax invoice without releasing its number.
 *
 * Cancelling an already-invoiced order used to leave the invoice number on the
 * order with nothing to say it had been voided, and a reprint was simply
 * refused with a 409 — so the customer's copy of a numbered tax invoice had no
 * counterpart in the system. A void keeps the number (a VAT sequence must stay
 * gapless), stamps the reprint VOID, and records why.
 */
export async function voidInvoiceForOrder({order, reason, user, session}) {
  if (!order.invoiceNo || order.invoiceVoidedAt) return false;
  order.invoiceVoidedAt = new Date();
  order.invoiceVoidReason = clean(reason) || 'Order cancelled after the tax invoice was issued';
  await order.save({session: session || undefined});
  await Audit.create([{
    entity: 'order',
    entityId: order._id,
    branch: order.branch,
    action: 'tax_invoice_voided',
    before: {invoiceNo: order.invoiceNo},
    after: {invoiceNo: order.invoiceNo, voidedAt: order.invoiceVoidedAt},
    reason: order.invoiceVoidReason,
    user: user?.id
  }], {session: session || undefined});
  return true;
}

/** Loads an order and issues (or reuses) its tax invoice number. */
export async function getReceipt({orderId, user, issue = false, session}) {
  const order = await Order.findById(orderId).session(session || null);
  if (!order) throw httpError('Order not found', 404);
  await assertTenantBranchAccess(user, order.branch, {session});

  const branch = await Branch.findById(order.branch).session(session || null);
  if (!branch) throw httpError('Branch not found', 404);
  const restaurant = await Restaurant.findById(branch.restaurant).session(session || null);

  // A tax invoice number is only allocated for a real sale, and only once.
  if (issue) {
    // A cancelled order may never be ALLOCATED a number. But if it already has
    // one, the guest is holding a numbered tax invoice, so a reprint must
    // remain possible — stamped VOID — rather than being refused outright.
    if (order.status === 'cancelled' && !order.invoiceNo) {
      throw httpError('A cancelled order cannot be invoiced', 409);
    }
    // Checked before the counter is touched, so a misconfigured tenant cannot
    // burn invoice numbers on documents that are not valid tax invoices.
    assertTaxConfig(restaurant, branch);
    const firstIssue = !order.invoiceNo;
    if (firstIssue) {
      order.invoiceNo = await nextInvoiceNumber({
        restaurantId: branch.restaurant,
        branch,
        issuedAt: new Date(),
        session
      });
      order.invoicedAt = new Date();
      // Phase 13: pin the figure the number was issued against. Without this a
      // reprint silently re-rendered whatever the order says today — an order
      // edited after invoicing reprinted the SAME invoice number showing a
      // different total, which is exactly the document a VAT audit relies on
      // being stable.
      order.invoicedTotal = money(order.total);
      order.invoicedBy = user?.id || null;
    }
    order.printCount = Number(order.printCount || 0) + 1;
    order.lastPrintedAt = new Date();
    await order.save({session: session || undefined});

    // Every allocation and every reprint is recorded. A tax document that can
    // be printed an unlimited number of times with no trace is a fraud risk:
    // the audit row is what distinguishes a genuine reissue from a duplicate
    // handed to a second guest.
    await Audit.create([{
      entity: 'order',
      entityId: order._id,
      branch: order.branch,
      action: firstIssue ? 'tax_invoice_issued' : 'tax_invoice_reprinted',
      after: {
        invoiceNo: order.invoiceNo,
        printCount: order.printCount,
        total: money(order.invoicedTotal ?? order.total)
      },
      user: user?.id
    }], {session: session || undefined});
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

/**
 * HTML escaping for both text and attribute contexts.
 *
 * The apostrophe matters: an unescaped `'` breaks out of any single-quoted
 * attribute. Nothing in the current template uses single quotes, but the
 * template is edited by hand and the escaper is the thing that must not depend
 * on that staying true. `/` is escaped too, so a payload cannot close a tag
 * early if a value is ever interpolated inside one.
 */
const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')
  .replace(/\//g, '&#47;');

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
${receipt.voided ? `<p class="reprint">*** VOID ***${receipt.voidReason ? `<br>${esc(receipt.voidReason)}` : ''}</p>` : ''}
${receipt.tampered ? `<p class="reprint">*** DOES NOT MATCH ISSUED INVOICE ***<br>Issued for ${npr(receipt.invoicedTotal)}</p>` : ''}
${receipt.reprint ? `<p class="reprint">REPRINT (${receipt.reprintNumber})</p>` : ''}
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
