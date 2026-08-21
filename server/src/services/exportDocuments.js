import {
  kathmanduDate, kathmanduTimestamp, money
} from './exportEngine.js';

/**
 * Phase 19 — PDF document layouts.
 *
 * Draws three document families onto a PDFKit document:
 *
 *   • tax invoice / receipt — from `buildReceipt()`, the SAME payload the HTML
 *     thermal receipt renders. The PDF is A4 stationery, not a reformatted
 *     re-derivation, so a PDF and a printed receipt for one order can never
 *     show different figures.
 *   • supplier statement — from `buildSupplierStatement()`.
 *   • report summary — from the P&L / sales / inventory / customer analytics.
 *
 * These functions only DRAW. They do no querying, no authorisation and no
 * arithmetic beyond laying out numbers that were computed upstream, which is
 * why they can be unit-tested against a literal payload.
 */

const PAGE_LEFT = 48;
const PAGE_RIGHT = 547; // A4 595pt minus the 48pt margin
const WIDTH = PAGE_RIGHT - PAGE_LEFT;

const npr = value => Number(value || 0).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

/**
 * PDFKit's standard fonts are WinAnsi-encoded, so a Devanagari glyph would be
 * dropped silently and a customer name in Nepali would print as blanks. Rather
 * than lose the characters, transliterate what cannot be encoded to a
 * placeholder and keep the ASCII around it. Honest degradation beats a name
 * that vanishes off a tax document.
 */
export function pdfSafe(value) {
  const text = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\u0000-\u00FF]/g, '?');
}

function hr(doc, y = doc.y) {
  doc.save().moveTo(PAGE_LEFT, y).lineTo(PAGE_RIGHT, y)
    .lineWidth(0.7).strokeColor('#d1d5db').stroke().restore();
  doc.y = y + 8;
}

function labelValue(doc, label, value, {x = PAGE_LEFT, width = WIDTH / 2} = {}) {
  const y = doc.y;
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(pdfSafe(label), x, y, {width});
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(pdfSafe(value || '—'), x, doc.y, {width});
  doc.fillColor('#111827');
}

function totalsRow(doc, label, value, {bold = false, negative = false} = {}) {
  const y = doc.y;
  const labelWidth = 150;
  const x = PAGE_RIGHT - labelWidth - 100;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
    .fillColor(negative ? '#991b1b' : '#111827');
  doc.text(pdfSafe(label), x, y, {width: labelWidth, align: 'right'});
  doc.text(npr(value), x + labelWidth, y, {width: 100, align: 'right'});
  doc.y = y + (bold ? 16 : 13);
  doc.fillColor('#111827');
}

function tableHeader(doc, columns) {
  const y = doc.y;
  doc.save().rect(PAGE_LEFT, y - 2, WIDTH, 15).fill('#1f2937').restore();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
  let x = PAGE_LEFT;
  for (const column of columns) {
    doc.text(pdfSafe(column.header), x + 3, y + 2, {width: column.width - 6, align: column.align || 'left', lineBreak: false});
    x += column.width;
  }
  doc.fillColor('#111827').font('Helvetica').fontSize(8);
  doc.y = y + 17;
}

function tableRow(doc, columns, values, {index = 0, columnsHeader} = {}) {
  if (doc.y > 780) {
    doc.addPage();
    tableHeader(doc, columnsHeader || columns);
  }
  const y = doc.y;
  if (index % 2 === 1) doc.save().rect(PAGE_LEFT, y - 2, WIDTH, 13).fill('#f3f4f6').restore();
  doc.font('Helvetica').fontSize(8).fillColor('#111827');
  let x = PAGE_LEFT;
  columns.forEach((column, position) => {
    doc.text(pdfSafe(values[position]), x + 3, y + 1, {
      width: column.width - 6, align: column.align || 'left', lineBreak: false, ellipsis: true
    });
    x += column.width;
  });
  doc.y = y + 13;
}

// ── tax invoice / receipt ────────────────────────────────────────────────────

/**
 * A4 tax invoice from a `buildReceipt()` payload.
 *
 * Deliberately reproduces the receipt's own truth markers rather than
 * suppressing them: a VOID invoice is stamped VOID, a reprint says which
 * reprint it is, and an order that drifted after invoicing prints the pinned
 * `invoicedTotal` with a warning. A PDF that quietly looked cleaner than the
 * thermal receipt would be the more dangerous document.
 */
export function drawTaxInvoice(doc, receipt) {
  const seller = receipt.seller || {};
  const totals = receipt.totals || {};

  doc.font('Helvetica-Bold').fontSize(18).text(pdfSafe(seller.name || 'Restaurant'), PAGE_LEFT, 48);
  doc.font('Helvetica').fontSize(9).fillColor('#374151');
  if (seller.branch) doc.text(pdfSafe(`${seller.branch}${seller.branchCode ? ` (${seller.branchCode})` : ''}`));
  if (seller.address) doc.text(pdfSafe(seller.address));
  if (seller.phone) doc.text(pdfSafe(`Tel ${seller.phone}`));
  if (seller.pan) doc.text(pdfSafe(`PAN ${seller.pan}`));
  doc.fillColor('#111827');

  const heading = receipt.document === 'tax_invoice' ? 'TAX INVOICE' : 'RECEIPT';
  doc.font('Helvetica-Bold').fontSize(14).text(heading, PAGE_LEFT, 48, {width: WIDTH, align: 'right'});
  doc.font('Helvetica').fontSize(9).fillColor('#374151')
    .text(pdfSafe(receipt.invoiceNo || receipt.orderNo), {width: WIDTH, align: 'right'})
    .text(pdfSafe(kathmanduTimestamp(receipt.issuedAt)), {width: WIDTH, align: 'right'});
  if (receipt.reprint) {
    doc.fillColor('#92400e').font('Helvetica-Bold')
      .text(pdfSafe(`REPRINT (${receipt.reprintNumber})`), {width: WIDTH, align: 'right'});
  }
  if (receipt.voided) {
    doc.fillColor('#991b1b').font('Helvetica-Bold').fontSize(12)
      .text('VOID', {width: WIDTH, align: 'right'});
  }
  doc.fillColor('#111827');

  doc.y = Math.max(doc.y, 130);
  hr(doc);

  const infoY = doc.y;
  labelValue(doc, 'Order', receipt.orderNo, {x: PAGE_LEFT, width: 160});
  doc.y = infoY;
  labelValue(doc, 'Customer',
    receipt.customer?.name || receipt.customer?.phone || 'Walk-in', {x: PAGE_LEFT + 170, width: 160});
  doc.y = infoY;
  labelValue(doc, 'Table / Type',
    receipt.order?.table || receipt.order?.typeLabel || receipt.order?.type || '—',
    {x: PAGE_LEFT + 340, width: 160});
  doc.y = infoY + 34;
  hr(doc);

  const columns = [
    {header: 'Item', width: 230},
    {header: 'Qty', width: 45, align: 'right'},
    {header: 'Rate', width: 70, align: 'right'},
    {header: 'Discount', width: 70, align: 'right'},
    {header: 'Amount', width: 84, align: 'right'}
  ];
  tableHeader(doc, columns);
  (receipt.lines || []).forEach((line, index) => {
    const modifiers = (line.modifiers || [])
      .map(modifier => (modifier.removed ? 'No ' : '') + modifier.name).join(', ');
    tableRow(doc, columns, [
      line.name + (modifiers ? ` — ${modifiers}` : ''),
      String(line.qty),
      npr(line.unitPrice),
      line.discount ? npr(line.discount) : '',
      npr(line.lineTotal)
    ], {index, columnsHeader: columns});
  });

  doc.moveDown(0.6);
  hr(doc);
  totalsRow(doc, 'Subtotal', totals.subtotal);
  if (totals.discountTotal) totalsRow(doc, 'Discount', -Math.abs(totals.discountTotal), {negative: true});
  if (totals.serviceCharge) {
    totalsRow(doc, `Service charge ${totals.serviceChargeRate || 0}%`, totals.serviceCharge);
  }
  totalsRow(doc, `VAT ${totals.vatRate ?? 13}%`, totals.vat);
  if (totals.deliveryFee) totalsRow(doc, 'Delivery fee', totals.deliveryFee);
  totalsRow(doc, 'TOTAL', totals.total, {bold: true});

  const payment = receipt.payment || {};
  if ((payment.tenders || []).length || (payment.refunds || []).length) {
    doc.moveDown(0.4);
    hr(doc);
    doc.font('Helvetica-Bold').fontSize(9).text('Payment', PAGE_LEFT, doc.y);
    doc.font('Helvetica').fontSize(9);
    for (const tender of payment.tenders || []) {
      totalsRow(doc, `${String(tender.method || '').toUpperCase()}${tender.transactionId ? ` · ${tender.transactionId}` : ''}`, tender.amount);
    }
    for (const refund of payment.refunds || []) {
      totalsRow(doc, `Refund · ${String(refund.method || '').toUpperCase()}`, -Math.abs(refund.amount), {negative: true});
    }
    if (payment.due) totalsRow(doc, 'Balance due', payment.due, {bold: true, negative: true});
  }

  if (receipt.tampered) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#991b1b').text(
      pdfSafe(`This order has changed since invoice ${receipt.invoiceNo} was issued. The invoiced total was ${npr(receipt.invoicedTotal)}.`),
      PAGE_LEFT, doc.y, {width: WIDTH}
    );
    doc.fillColor('#111827');
  }

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(7).fillColor('#6b7280').text(
    pdfSafe(`${seller.footer || ''}  Printed ${receipt.printedAtLocal || kathmanduTimestamp(new Date())} Asia/Kathmandu.`),
    PAGE_LEFT, doc.y, {width: WIDTH}
  );
}

// ── supplier statement ───────────────────────────────────────────────────────

export function drawSupplierStatement(doc, statement) {
  const supplier = statement.supplier || {};
  doc.font('Helvetica-Bold').fontSize(16).text('SUPPLIER STATEMENT', PAGE_LEFT, 48);
  doc.font('Helvetica').fontSize(9).fillColor('#374151')
    .text(pdfSafe(supplier.name || 'Supplier'))
    .text(pdfSafe(statement.branch ? `${statement.branch.name} (${statement.branch.code || '—'})` : 'All branches'))
    .text(pdfSafe(`Period ${statement.period?.from || 'beginning'} to ${statement.period?.to || statement.period?.asOf || 'today'} (Asia/Kathmandu)`));
  doc.fillColor('#111827');
  doc.moveDown(0.6);
  hr(doc);

  const summary = statement.summary || {};
  const cardY = doc.y;
  const cards = [
    ['Opening balance', summary.openingBalance],
    ['Invoiced', summary.periodInvoiced],
    ['Payments', summary.periodPayments],
    ['Closing balance', summary.closingBalance]
  ];
  cards.forEach(([label, value], index) => {
    doc.y = cardY;
    labelValue(doc, label, `Rs ${npr(value)}`, {x: PAGE_LEFT + index * (WIDTH / 4), width: WIDTH / 4 - 8});
  });
  doc.y = cardY + 36;
  hr(doc);

  const columns = [
    {header: 'Date', width: 62},
    {header: 'Type', width: 82},
    {header: 'Reference', width: 125},
    {header: 'Debit', width: 76, align: 'right'},
    {header: 'Credit', width: 76, align: 'right'},
    {header: 'Balance', width: 78, align: 'right'}
  ];
  tableHeader(doc, columns);
  (statement.lines || []).forEach((line, index) => {
    tableRow(doc, columns, [
      kathmanduDate(line.date),
      String(line.type || '').replace(/_/g, ' '),
      line.ref || '',
      line.debit ? npr(line.debit) : '',
      line.credit ? npr(line.credit) : '',
      npr(line.balance)
    ], {index, columnsHeader: columns});
  });

  doc.moveDown(0.6);
  hr(doc);
  totalsRow(doc, 'Invoiced', statement.invoiced);
  totalsRow(doc, 'Payments', statement.paid);
  totalsRow(doc, 'Returns', statement.returned);
  totalsRow(doc, 'OUTSTANDING', statement.balance, {bold: true});

  const aging = statement.aging;
  if (aging?.buckets) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(9).text('Aging', PAGE_LEFT, doc.y);
    doc.font('Helvetica').fontSize(8).fillColor('#374151').text(
      pdfSafe(Object.entries(aging.buckets).map(([bucket, value]) => `${bucket}: ${npr(value)}`).join('   ')),
      PAGE_LEFT, doc.y, {width: WIDTH}
    );
    doc.fillColor('#111827');
  }

  doc.moveDown(1);
  const pagination = statement.linePagination;
  doc.font('Helvetica').fontSize(7).fillColor('#6b7280').text(
    pdfSafe(pagination && pagination.total > (statement.lines || []).length
      ? `Showing ${statement.lines.length} of ${pagination.total} ledger lines (page ${pagination.page} of ${pagination.pages}).`
      : `${(statement.lines || []).length} ledger line(s).`),
    PAGE_LEFT, doc.y, {width: WIDTH}
  );
}

// ── report summaries ─────────────────────────────────────────────────────────

function section(doc, heading) {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(pdfSafe(heading), PAGE_LEFT, doc.y);
  doc.moveDown(0.2);
}

function kpiGrid(doc, entries, {perRow = 4} = {}) {
  const columnWidth = WIDTH / perRow;
  for (let index = 0; index < entries.length; index += perRow) {
    const rowY = doc.y;
    entries.slice(index, index + perRow).forEach(([label, value], column) => {
      doc.y = rowY;
      labelValue(doc, label, value, {x: PAGE_LEFT + column * columnWidth, width: columnWidth - 8});
    });
    doc.y = rowY + 34;
  }
}

function simpleTable(doc, columns, rows, {limit = 25, empty = 'No data.'} = {}) {
  if (!rows?.length) {
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(empty, PAGE_LEFT, doc.y, {width: WIDTH});
    doc.fillColor('#111827');
    return;
  }
  tableHeader(doc, columns);
  rows.slice(0, limit).forEach((row, index) => tableRow(doc, columns, row, {index, columnsHeader: columns}));
  if (rows.length > limit) {
    doc.font('Helvetica').fontSize(7).fillColor('#6b7280')
      .text(pdfSafe(`Showing the top ${limit} of ${rows.length} rows. Use the CSV or XLSX export for the full list.`), PAGE_LEFT, doc.y + 3, {width: WIDTH});
    doc.fillColor('#111827');
  }
}

/**
 * The management report pack: P&L headline, sales breakdowns, inventory
 * position and customer summary, whichever the caller asked for.
 */
export function drawReportPack(doc, {title, meta = [], pnl, sales, inventory, customers}) {
  doc.font('Helvetica-Bold').fontSize(16).text(pdfSafe(title), PAGE_LEFT, 48);
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280');
  for (const line of meta) doc.text(pdfSafe(line), {width: WIDTH});
  doc.fillColor('#111827');
  doc.moveDown(0.4);
  hr(doc);

  if (pnl) {
    section(doc, 'Profit and loss');
    kpiGrid(doc, [
      ['Net revenue', `Rs ${npr(pnl.revenue)}`],
      ['Gross revenue', `Rs ${npr(pnl.grossRevenue)}`],
      ['Refunds', `Rs ${npr(pnl.refunds)}`],
      ['Discounts', `Rs ${npr(pnl.discounts)}`],
      ['VAT', `Rs ${npr(pnl.vat)}`],
      ['COGS', `Rs ${npr(pnl.cogs)}`],
      ['Gross profit', `Rs ${npr(pnl.grossProfit)}`],
      ['Purchases', `Rs ${npr(pnl.purchases)}`],
      ['Waste', `Rs ${npr(pnl.waste)}`],
      ['Expenses', `Rs ${npr(pnl.expenses)}`],
      ['Inventory value', `Rs ${npr(pnl.inventoryValue)}`],
      ['Net profit', `Rs ${npr(pnl.netProfit)}`]
    ]);
  }

  if (sales) {
    section(doc, `Sales by ${sales.period?.granularity || 'period'}`);
    simpleTable(doc,
      [
        {header: 'Period', width: 110},
        {header: 'Orders', width: 60, align: 'right'},
        {header: 'Net revenue', width: 110, align: 'right'},
        {header: 'Discounts', width: 100, align: 'right'},
        {header: 'Gross profit', width: 119, align: 'right'}
      ],
      (sales.byPeriod || []).map(row => [
        row.period, String(row.orders), npr(row.netRevenue), npr(row.discounts), npr(row.grossProfit)
      ]),
      {empty: 'No sales in this period.'}
    );

    section(doc, 'Top items');
    simpleTable(doc,
      [
        {header: 'Item', width: 190},
        {header: 'Category', width: 110},
        {header: 'Qty', width: 60, align: 'right'},
        {header: 'Revenue', width: 139, align: 'right'}
      ],
      (sales.byItem || []).map(row => [row.name, row.category, String(row.qty), npr(row.revenue)]),
      {limit: 15, empty: 'No items sold.'}
    );

    section(doc, 'Payment methods');
    simpleTable(doc,
      [
        {header: 'Method', width: 200},
        {header: 'Tenders', width: 130, align: 'right'},
        {header: 'Amount', width: 169, align: 'right'}
      ],
      (sales.byPaymentMethod || []).map(row => [row.method, String(row.count), npr(row.amount)]),
      {empty: 'No payments recorded.'}
    );
  }

  if (inventory) {
    section(doc, 'Inventory position');
    kpiGrid(doc, [
      ['Stock value', `Rs ${npr(inventory.stockValue)}`],
      ['Waste', `Rs ${npr(inventory.waste?.value)}`],
      ['Adjustments', `Rs ${npr(inventory.adjustments?.value)}`],
      ['Count variance', `Rs ${npr(inventory.countVariance?.varianceValue)}`],
      ['Expired value', `Rs ${npr(inventory.expiry?.expired?.value)}`],
      ['Expiring value', `Rs ${npr(inventory.expiry?.expiring?.value)}`]
    ]);
    section(doc, 'Highest value stock');
    simpleTable(doc,
      [
        {header: 'Ingredient', width: 200},
        {header: 'Code', width: 80},
        {header: 'Qty', width: 90, align: 'right'},
        {header: 'Value', width: 129, align: 'right'}
      ],
      (inventory.topValue || []).map(row => [row.name, row.code, String(row.quantity), npr(row.value)]),
      {limit: 15, empty: 'No stock on hand.'}
    );
  }

  if (customers) {
    section(doc, 'Customers');
    kpiGrid(doc, [
      ['Customers', String(customers.totals?.customers ?? 0)],
      ['Repeat customers', String(customers.totals?.repeatCustomers ?? 0)],
      ['Repeat rate', `${npr(customers.totals?.repeatRate)}%`],
      ['Avg order value', `Rs ${npr(customers.totals?.averageOrderValue)}`]
    ]);
    section(doc, 'Top customers');
    simpleTable(doc,
      [
        {header: 'Customer', width: 170},
        {header: 'Phone', width: 100},
        {header: 'Orders', width: 60, align: 'right'},
        {header: 'Revenue', width: 169, align: 'right'}
      ],
      (customers.topCustomers || []).map(row => [row.name, row.phone, String(row.orders), npr(row.revenue)]),
      {limit: 15, empty: 'No identified customers.'}
    );
  }

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(7).fillColor('#6b7280').text(
    pdfSafe(`Generated ${kathmanduTimestamp(new Date())} Asia/Kathmandu. Figures come from the reporting API and are not recomputed for this document.`),
    PAGE_LEFT, doc.y, {width: WIDTH}
  );
}

export const __testables = {npr, money};
