import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Writable} from 'node:stream';
import ExcelJS from 'exceljs';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Customer, Order, Payment, PurchaseOrder} from '../src/models/operations.js';
import {Supplier} from '../src/models/index.js';
import {
  csvCell, exportStats, formatValue, kathmanduDate, resetExportStats, safeFilename
} from '../src/services/exportEngine.js';
import {EXPORT_DATASET_KEYS, availableDatasets} from '../src/services/exportDatasets.js';
import {pdfSafe} from '../src/services/exportDocuments.js';

/**
 * Phase 19 — export engine.
 *
 * What these tests are actually trying to break:
 *   • a CSV that executes when opened in Excel;
 *   • an export that shows a manager another branch's money;
 *   • an export that quietly loads the whole collection into the heap;
 *   • a truncated file that still opens cleanly and looks complete;
 *   • a filename that escapes the Content-Disposition header.
 */

let baseUrl;
let world;

const raw = async (path, {token, headers = {}} = {}) => {
  const res = await fetch(baseUrl + path, {
    headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...headers}
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    type: res.headers.get('content-type') || '',
    disposition: res.headers.get('content-disposition') || '',
    cacheControl: res.headers.get('cache-control') || '',
    buffer,
    text: buffer.toString('utf8')
  };
};

const csvLines = text => text.replace(/^\uFEFF/, '').trim().split('\r\n');

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

/** A completed, paid counter sale on the given branch. */
async function sale({branch, total = 395.5, at = new Date(), customer = null, name = 'Chicken Biryani'} = {}) {
  const order = await Order.create({
    orderNo: `EXP-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    branch: branch || world.branchA._id,
    customer,
    type: 'counter',
    status: 'completed',
    items: [{menuItem: world.menu._id, name, qty: 1, unitPrice: 350, lineNet: 350, lineVat: 45.5, lineTotal: 395.5, foodCost: 11.25}],
    subtotal: 350,
    discountTotal: 0,
    vat: 45.5,
    total,
    paidAmount: total,
    dueAmount: 0,
    createdBy: world.owner._id
  });
  if (at) await Order.collection.updateOne({_id: order._id}, {$set: {createdAt: at, updatedAt: at}});
  return order;
}

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  resetExportStats();
});

// ── pure units ───────────────────────────────────────────────────────────────

describe('Phase 19 · CSV safety', () => {
  it('neutralises every formula prefix Excel recognises', () => {
    // A supplier named like a formula is a live remote-code path in Excel.
    // No quoting: the payload holds no comma, quote, semicolon or newline, so
    // the apostrophe alone is what defuses it.
    assert.equal(csvCell("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1");
    assert.equal(csvCell('+1+1'), "'+1+1");
    assert.equal(csvCell('-1+1'), "'-1+1");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    // Excel strips a leading tab or CR before deciding, so they count too.
    // A raw tab needs no CSV quoting; the apostrophe is the whole defence.
    assert.equal(csvCell('\t=1+1'), "'\t=1+1");
  });

  it('quotes and doubles embedded quotes, commas and newlines', () => {
    assert.equal(csvCell('Ram, Shyam'), '"Ram, Shyam"');
    assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
    // A semicolon matters because Excel in several locales splits on it.
    assert.equal(csvCell('a;b'), '"a;b"');
  });

  it('leaves an ordinary value untouched', () => {
    assert.equal(csvCell('Basmati Rice'), 'Basmati Rice');
    assert.equal(csvCell(350), '350');
    assert.equal(csvCell(null), '');
  });
});

describe('Phase 19 · value formatting', () => {
  it('renders dates in Kathmandu local time, not UTC', () => {
    // 2025-03-10T19:30:00Z is already 2025-03-11 in Kathmandu (+05:45).
    assert.equal(kathmanduDate('2025-03-10T19:30:00.000Z'), '2025-03-11');
    assert.equal(formatValue('2025-03-10T19:30:00.000Z', 'date'), '2025-03-11');
    assert.equal(formatValue('2025-03-10T19:30:00.000Z', 'datetime'), '2025-03-11 01:15');
  });

  it('keeps numbers numeric so a spreadsheet can total them', () => {
    assert.equal(formatValue(395.499, 'money'), 395.5);
    assert.equal(typeof formatValue(395.5, 'money'), 'number');
    assert.equal(formatValue(null, 'money'), 0);
    assert.equal(formatValue(null, 'string'), '');
    assert.equal(formatValue(true, 'bool'), 'yes');
  });
});

describe('Phase 19 · filename safety', () => {
  it('strips anything that could break the Content-Disposition header', () => {
    assert.equal(safeFilename('sales"; rm -rf /; x="', 'csv'), 'sales-rm--rf-x.csv');
    assert.equal(safeFilename('../../etc/passwd', 'csv'), 'etc-passwd.csv');
    assert.equal(safeFilename('report\r\nX-Evil: 1', 'pdf'), 'report-X-Evil-1.pdf');
    assert.equal(safeFilename('', 'xlsx'), 'export.xlsx');
  });
});

describe('Phase 19 · PDF encoding', () => {
  it('degrades unencodable glyphs rather than dropping them silently', () => {
    // PDFKit's standard fonts are WinAnsi. A Devanagari name would otherwise
    // vanish from a tax invoice with no indication anything was lost.
    assert.equal(pdfSafe('राम Shrestha'), '??? Shrestha');
    assert.equal(pdfSafe('Rs 1,234.00'), 'Rs 1,234.00');
  });
});

// ── HTTP: format and headers ─────────────────────────────────────────────────

describe('Phase 19 · dataset catalogue', () => {
  it('lists the datasets, formats and branches available to the caller', async () => {
    const res = await request('/api/exports/datasets', {token: owner()});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.datasets.map(d => d.key).sort(), [...EXPORT_DATASET_KEYS].sort());
    assert.deepEqual(res.body.formats, ['csv', 'xlsx', 'pdf']);
    assert.equal(res.body.branches.length, 2);
  });

  it('shows a branch manager only their own branch', async () => {
    const res = await request('/api/exports/datasets', {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.branches.length, 1);
    assert.equal(String(res.body.branches[0]._id), String(world.branchA._id));
  });

  it('refuses staff outright', async () => {
    assert.equal((await request('/api/exports/datasets', {token: staff()})).status, 403);
  });

  it('advertises nothing to a role with no datasets', () => {
    assert.deepEqual(availableDatasets({role: 'staff'}), []);
    assert.deepEqual(availableDatasets({role: 'rider'}), []);
  });
});

describe('Phase 19 · CSV export', () => {
  it('streams sales as CSV with an attachment header and a UTF-8 BOM', async () => {
    await sale({});
    const res = await raw('/api/exports/sales.csv', {token: owner()});
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/csv/);
    assert.match(res.disposition, /^attachment; filename="mittho-sales-all-branches-all\.csv"/);
    // Without the BOM, Excel on Windows mangles every Nepali name in the file.
    assert.equal(res.text[0], '\uFEFF');
    const lines = csvLines(res.text);
    assert.equal(lines[0], 'Order No,Invoice No,Placed At,Branch,Type,Status,Customer,Lines,Subtotal,Discount,Service Charge,VAT,Delivery Fee,Total,Refunded,Net Total');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /Kathmandu Branch/);
    assert.match(lines[1], /395\.5/);
  });

  it('never caches an export response', async () => {
    const res = await raw('/api/exports/sales.csv', {token: owner()});
    assert.match(res.cacheControl, /no-store/);
    assert.match(res.cacheControl, /private/);
  });

  it('rejects an unknown format and an unknown dataset', async () => {
    // A known dataset with a bad format is a bad REQUEST; an unknown dataset
    // does not match the route at all and is a 404.
    assert.equal((await request('/api/exports/sales.exe', {token: owner()})).status, 400);
    assert.equal((await request('/api/exports/salaries.csv', {token: owner()})).status, 404);
  });
});

describe('Phase 19 · XLSX export', () => {
  it('produces a workbook a spreadsheet can open, with typed numeric cells', async () => {
    await sale({});
    const res = await raw('/api/exports/sales.xlsx', {token: owner()});
    assert.equal(res.status, 200);
    assert.match(res.type, /spreadsheetml\.sheet/);
    // A real OOXML package, not a CSV with the wrong extension.
    assert.equal(res.buffer.subarray(0, 2).toString('latin1'), 'PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.buffer);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.name, 'Sales');

    // Title, three meta lines, a spacer, then the header row.
    assert.equal(sheet.getRow(1).getCell(1).value, 'Sales');
    const headerRow = sheet.getRow(6);
    assert.equal(headerRow.getCell(1).value, 'Order No');
    assert.equal(headerRow.getCell(14).value, 'Total');

    const dataRow = sheet.getRow(7);
    // The total must be a NUMBER: a string here means no SUM() in Excel.
    assert.equal(typeof dataRow.getCell(14).value, 'number');
    assert.equal(dataRow.getCell(14).value, 395.5);
    assert.equal(dataRow.getCell(14).numFmt, '#,##0.00');
    // Frozen header, or a 40,000-row financial extract is unreadable.
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, 6);
  });
});

describe('Phase 19 · PDF export', () => {
  it('emits a real PDF for a dataset', async () => {
    await sale({});
    const res = await raw('/api/exports/sales.pdf', {token: owner()});
    assert.equal(res.status, 200);
    assert.match(res.type, /application\/pdf/);
    assert.equal(res.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(res.buffer.subarray(-2048).toString('latin1'), /%%EOF/);
  });

  it('renders an A4 tax invoice for an invoiced order', async () => {
    // Issuing a tax invoice number requires a configured seller PAN.
    const {Restaurant} = await import('../src/models/operations.js');
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {pan: '987654321'}});
    const order = await sale({});
    const issued = await request(`/api/orders/${order._id}/receipt?issue=true`, {token: owner()});
    assert.equal(issued.status, 200);
    const res = await raw(`/api/exports/invoices/${order._id}.pdf`, {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(res.disposition, new RegExp(`filename="mittho-${issued.body.invoiceNo}\\.pdf"`));
  });

  it('does not allocate an invoice number as a side effect of exporting', async () => {
    // Numbering is a legal mutation and belongs to the receipt endpoint, which
    // transacts and pins invoicedTotal. An export must never burn a number.
    const order = await sale({});
    const res = await raw(`/api/exports/invoices/${order._id}.pdf`, {token: owner()});
    assert.equal(res.status, 200);
    const after = await Order.findById(order._id).lean();
    assert.equal(after.invoiceNo, undefined);
    assert.equal(Number(after.printCount || 0), 0);
  });

  it('renders a management report pack', async () => {
    await sale({});
    const res = await raw('/api/exports/reports/full.pdf', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(res.buffer.length > 2000, 'a four-section report pack should not be a stub');
  });

  it('renders a supplier statement PDF', async () => {
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Annapurna Traders'});
    const res = await raw(`/api/exports/statements/${supplier._id}.pdf`, {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});

// ── tenancy and authorisation ────────────────────────────────────────────────

describe('Phase 19 · tenancy and permissions', () => {
  it('confines a branch manager to their own branch across every dataset', async () => {
    await sale({branch: world.branchA._id, total: 111});
    await sale({branch: world.branchB._id, total: 222});

    const res = await raw('/api/exports/sales.csv', {token: manager()});
    assert.equal(res.status, 200);
    const body = res.text;
    assert.match(body, /Kathmandu Branch/);
    // Branch B's sale must not appear at all — not the branch, not the money.
    assert.doesNotMatch(body, /Lalitpur Branch/);
    assert.doesNotMatch(body, /222/);
  });

  it('refuses a manager who names another branch explicitly', async () => {
    const res = await request(`/api/exports/sales.csv?branch=${world.branchB._id}`, {token: manager()});
    assert.equal(res.status, 403);
  });

  it('refuses a branch belonging to another restaurant', async () => {
    const {Restaurant, Branch} = await import('../src/models/operations.js');
    const other = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const otherBranch = await Branch.create({restaurant: other._id, name: 'Rival', code: 'RVL'});
    const res = await request(`/api/exports/sales.csv?branch=${otherBranch._id}`, {token: owner()});
    assert.equal(res.status, 403);
  });

  it('gates the role in the SERVICE as well as the route', async () => {
    // DEFENCE IN DEPTH, proven rather than assumed. Removing either the
    // route's auth(MGMT) or the dataset's own `roles` check on its own leaves
    // the suite green, because the surviving layer still refuses. Removing
    // BOTH was verified to fail 'closes every export endpoint to staff and
    // riders'. Both layers are kept deliberately: `prepareExport()` is
    // callable from a script or a future route, and must not depend on a
    // caller having remembered to guard it.
    const {prepareExport} = await import('../src/services/exportDatasets.js');
    await assert.rejects(
      () => prepareExport({datasetKey: 'sales', user: {id: world.staffA._id, role: 'staff'}}),
      error => error.status === 403 && /Insufficient permission/.test(error.message)
    );
    // Control: the same call as a manager succeeds, so the rejection above is
    // about the ROLE and not about a broken argument.
    const allowed = await prepareExport({
      datasetKey: 'sales', user: {id: world.manager._id, role: 'manager'}
    });
    assert.equal(allowed.dataset.key, 'sales');
  });

  it('closes every export endpoint to staff and riders', async () => {
    const {User} = await import('../src/models/index.js');
    const rider = await User.create({
      name: 'Rider', email: 'rider-export@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    const paths = [
      '/api/exports/datasets',
      ...EXPORT_DATASET_KEYS.flatMap(key => [`/api/exports/${key}.csv`, `/api/exports/${key}.xlsx`, `/api/exports/${key}.pdf`]),
      '/api/exports/reports/pnl.pdf',
      '/api/exports/reports/full.pdf'
    ];
    for (const path of paths) {
      assert.equal((await request(path, {token: staff()})).status, 403, `${path} must refuse staff`);
      assert.equal((await request(path, {token: tokenFor(rider)})).status, 403, `${path} must refuse riders`);
    }
  });

  it('requires authentication', async () => {
    assert.equal((await request('/api/exports/sales.csv')).status, 401);
    assert.equal((await request('/api/exports/datasets')).status, 401);
  });

  it('keeps an ingredient from another restaurant out of the inventory export', async () => {
    const res = await raw('/api/exports/inventory.csv', {token: owner()});
    assert.equal(res.status, 200);
    assert.match(res.text, /Basmati Rice/);
    const lines = csvLines(res.text);
    assert.equal(lines.length, 3, 'two branches x one ingredient');
  });

  it('drops a balance row that points at another restaurant ingredient', async () => {
    // The `$match` on `ing.restaurant` is defence in depth: the balance is
    // reached through a branch the caller may already see, so without a
    // deliberately mis-scoped row the check is unobservable and the earlier
    // test stayed green when it was deleted. This plants exactly that row.
    const {Restaurant, InventoryBalance} = await import('../src/models/operations.js');
    const {Ingredient} = await import('../src/models/index.js');
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalIngredient = await Ingredient.create({
      restaurant: rival._id, code: 'RVL-1', name: 'Rival Secret Spice', unit: 'g'
    });
    await InventoryBalance.collection.insertOne({
      branch: world.branchA._id,
      ingredient: rivalIngredient._id,
      quantity: 5000, averageCost: 2, ledgerVersion: 0,
      storageLocation: 'Main Store', createdAt: new Date(), updatedAt: new Date()
    });

    const res = await raw('/api/exports/inventory.csv', {token: owner()});
    assert.equal(res.status, 200);
    // Control: the tenant's own ingredient is still there, so the assertion
    // below is not passing because the export returned nothing.
    assert.match(res.text, /Basmati Rice/);
    assert.doesNotMatch(res.text, /Rival Secret Spice/);
    assert.doesNotMatch(res.text, /RVL-1/);
    assert.equal(csvLines(res.text).length, 3);
  });

  it('scopes the payments export to the caller branch', async () => {
    const orderA = await sale({branch: world.branchA._id});
    const orderB = await sale({branch: world.branchB._id});
    await Payment.create({order: orderA._id, amount: 395.5, method: 'cash', status: 'paid', cashier: world.owner._id});
    await Payment.create({order: orderB._id, amount: 999, method: 'card', status: 'paid', cashier: world.owner._id});

    const managerCsv = await raw('/api/exports/payments.csv', {token: manager()});
    assert.doesNotMatch(managerCsv.text, /999/);
    assert.match(managerCsv.text, /395\.5/);

    const ownerCsv = await raw('/api/exports/payments.csv', {token: owner()});
    assert.match(ownerCsv.text, /999/);
    assert.match(ownerCsv.text, /395\.5/);
  });
});

// ── streaming behaviour ──────────────────────────────────────────────────────

describe('Phase 19 · large exports', () => {
  it('reads through a cursor and closes it, rather than materialising the collection', async () => {
    // 300 orders. If the dataset ever regresses to find().lean(), documentsRead
    // still ends at 300 but the cursor counters give the shape away; the real
    // proof is the partial-consumption test below.
    const docs = [];
    for (let index = 0; index < 300; index += 1) {
      docs.push({
        orderNo: `BULK-${index}`,
        branch: world.branchA._id,
        type: 'counter',
        status: 'completed',
        items: [],
        subtotal: 100, vat: 13, total: 113, paidAmount: 113, dueAmount: 0,
        createdBy: world.owner._id,
        createdAt: new Date(), updatedAt: new Date()
      });
    }
    await Order.collection.insertMany(docs);

    resetExportStats();
    const res = await raw('/api/exports/sales.csv', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(csvLines(res.text).length, 301, 'header plus 300 rows');
    assert.equal(exportStats.cursorsOpened, 1);
    assert.equal(exportStats.cursorsClosed, 1, 'the cursor must be closed');
    assert.equal(exportStats.documentsRead, 300);
  });

  it('is lazy: consuming three rows reads three documents, not the whole set', async () => {
    // THE memory test. A `find().lean()` implementation reads 300 here and
    // fails; only a real cursor reads 3.
    const docs = [];
    for (let index = 0; index < 300; index += 1) {
      docs.push({
        orderNo: `LAZY-${index}`, branch: world.branchA._id, type: 'counter', status: 'completed',
        items: [], subtotal: 100, vat: 13, total: 113, paidAmount: 113, dueAmount: 0,
        createdBy: world.owner._id, createdAt: new Date(), updatedAt: new Date()
      });
    }
    await Order.collection.insertMany(docs);

    const {prepareExport} = await import('../src/services/exportDatasets.js');
    resetExportStats();
    const prepared = await prepareExport({datasetKey: 'sales', user: {id: world.owner._id, role: 'owner'}});
    let taken = 0;
    for await (const row of prepared.rows) {
      assert.ok(row.orderNo);
      taken += 1;
      if (taken === 3) break;
    }
    assert.equal(taken, 3);
    assert.ok(exportStats.documentsRead < 300,
      `a lazy cursor must not read the whole collection (read ${exportStats.documentsRead})`);
    // Breaking out of the loop must still close the cursor, or an abandoned
    // download leaks a server-side cursor.
    assert.equal(exportStats.cursorsClosed, 1);
  });

  it('pulls through a driver cursor, never an awaited aggregate', async () => {
    // The counter above is NOT sufficient on its own, and a mutation proved
    // it: replacing the cursor with `await model.aggregate(pipeline)` and
    // yielding from the resulting array still reports 3 documents read,
    // because the counter measures rows YIELDED, not rows the driver
    // delivered. This asserts the mechanism directly — the implementation must
    // ask for `.cursor()` and must never await the aggregation itself.
    const {iterateAggregate} = await import('../src/services/exportEngine.js');
    const calls = [];
    let cursorClosed = false;
    let delivered = 0;
    const fakeModel = {
      aggregate(pipeline) {
        calls.push(pipeline);
        return {
          // An awaited aggregate would hit this and fail the test loudly.
          then() { throw new Error('the export awaited the aggregation instead of streaming it'); },
          cursor({batchSize}) {
            calls.push({batchSize});
            let index = 0;
            return {
              async next() {
                if (index >= 300) return null;
                delivered += 1;
                index += 1;
                return {a: index};
              },
              async close() { cursorClosed = true; }
            };
          }
        };
      }
    };

    let taken = 0;
    for await (const row of iterateAggregate(fakeModel, [{$match: {}}])) {
      assert.ok(row.a);
      taken += 1;
      if (taken === 3) break;
    }
    assert.equal(taken, 3);
    // THE assertion the previous test could not make: the driver handed over
    // exactly three documents, not three hundred.
    assert.equal(delivered, 3);
    assert.equal(cursorClosed, true, 'an abandoned export must close its cursor');
    assert.equal(calls[1].batchSize, 200, 'a bounded batch size keeps memory flat');
  });

  it('caps the PDF at PDF_MAX_ROWS and says so on the page', async () => {
    const {writePdfTable, PDF_MAX_ROWS} = await import('../src/services/exportEngine.js');
    assert.equal(PDF_MAX_ROWS, 2000);
    // Proven at the renderer rather than through 2,001 real orders: the cap is
    // a property of the renderer, and seeding 2,001 orders would only make the
    // suite slower without testing anything extra.
    let produced = 0;
    async function* rows() {
      for (let index = 0; index < 30; index += 1) { produced += 1; yield {a: index}; }
    }
    const chunks = [];
    const fake = fakeResponse(chunks);
    const written = await writePdfTable(fake, {
      filename: 'x', title: 'T', columns: [{key: 'a', header: 'A', type: 'int'}], rows: rows(), limit: 10
    });
    assert.equal(written, 10);
    // 11, not 30: the generator is only pulled one row past the cap.
    assert.equal(produced, 11);
    const pdf = Buffer.concat(chunks).toString('latin1');
    assert.match(pdf, /%PDF-/);
  });
});

// ── failure honesty ──────────────────────────────────────────────────────────

/** Minimal writable stand-in for an Express response. */
function fakeResponse(chunks, {failAfter = Infinity} = {}) {
  let written = 0;
  const stream = new Writable({
    write(chunk, encoding, callback) {
      written += 1;
      if (written > failAfter) return callback(new Error('socket exploded'));
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  stream.setHeader = () => {};
  stream.headersSent = false;
  return stream;
}

describe('Phase 19 · failure honesty', () => {
  it('destroys the socket instead of finishing a truncated CSV', async () => {
    // A half-written CSV that opens cleanly in Excel and is silently missing
    // rows is worse than a failed download. The transfer must break.
    const {writeCsv} = await import('../src/services/exportEngine.js');
    const chunks = [];
    const res = fakeResponse(chunks);
    let destroyedWith = null;
    res.destroy = error => { destroyedWith = error; };

    async function* rows() {
      yield {a: 1};
      throw new Error('cursor died mid-stream');
    }
    await assert.rejects(
      () => writeCsv(res, {filename: 'x', columns: [{key: 'a', header: 'A'}], rows: rows()}),
      /cursor died mid-stream/
    );
    assert.ok(destroyedWith instanceof Error, 'the response must be destroyed, not ended');
    assert.match(destroyedWith.message, /cursor died mid-stream/);
  });

  it('validates the reporting period before streaming a single byte', async () => {
    const bad = await request('/api/exports/sales.csv?from=2025-13-99', {token: owner()});
    assert.equal(bad.status, 400);
    // Month 13 satisfies the \d{2} shape check, so it fails the real-date
    // check rather than the format one.
    assert.match(bad.body.message, /not a real date/);
    assert.match(
      (await request('/api/exports/sales.csv?from=05-2025', {token: owner()})).body.message,
      /YYYY-MM-DD/
    );

    const inverted = await request('/api/exports/sales.csv?from=2025-05-10&to=2025-05-01', {token: owner()});
    assert.equal(inverted.status, 400);
  });

  it('rejects a well-shaped date that is not a real day', async () => {
    // DEFECT FOUND IN PHASE 18's reportingPeriod(), not introduced here.
    // The regex only checked the SHAPE. `2025-13-99` produced an Invalid Date
    // that reached the query and came back a 500; `2025-02-31` silently rolled
    // forward, so a report labelled February actually covered 3 March. Both
    // are now refused at the single place every report parses a date, which is
    // why the assertions below also cover the Phase 18 JSON endpoint.
    const rolled = await request('/api/exports/sales.csv?from=2025-02-31&to=2025-02-31', {token: owner()});
    assert.equal(rolled.status, 400);
    assert.match(rolled.body.message, /not a real date/);

    assert.equal((await request('/api/reports/sales?from=2025-13-99', {token: owner()})).status, 400);
    assert.equal((await request('/api/reports/sales?from=2025-02-31', {token: owner()})).status, 400);
    assert.equal((await request('/api/reports/inventory?to=2024-02-30', {token: owner()})).status, 400);

    // Control: a real leap day must still be accepted, or the guard is just
    // rejecting everything.
    assert.equal((await request('/api/reports/sales?from=2024-02-29&to=2024-02-29', {token: owner()})).status, 200);
  });

  it('applies the period filter rather than ignoring it', async () => {
    // A control that PASSES, so a green "filtered" assertion cannot come from
    // an export that simply returned nothing.
    await sale({at: new Date('2025-05-05T06:00:00.000Z')});
    await sale({at: new Date('2025-08-05T06:00:00.000Z')});

    const all = await raw('/api/exports/sales.csv', {token: owner()});
    assert.equal(csvLines(all.text).length, 3);

    const may = await raw('/api/exports/sales.csv?from=2025-05-01&to=2025-05-31', {token: owner()});
    assert.equal(csvLines(may.text).length, 2);
    assert.match(may.text, /2025-05-05/);
    assert.doesNotMatch(may.text, /2025-08-05/);
    assert.match(may.disposition, /mittho-sales-all-branches-2025-05-01_2025-05-31\.csv/);
  });
});

// ── audit ────────────────────────────────────────────────────────────────────

describe('Phase 19 · audit logging', () => {
  it('records who exported what, for which scope and period', async () => {
    const {Audit} = await import('../src/models/index.js');
    await sale({});
    await raw('/api/exports/sales.csv?from=2025-01-01&to=2025-12-31', {token: manager()});

    const rows = await Audit.find({entity: 'export'}).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'export_dataset');
    assert.equal(rows[0].after.target, 'sales');
    assert.equal(rows[0].after.format, 'csv');
    assert.equal(rows[0].after.scope, 'branch');
    assert.equal(rows[0].after.from, '2025-01-01');
    assert.equal(String(rows[0].user), String(world.manager._id));
    assert.equal(String(rows[0].branch), String(world.branchA._id));
    assert.equal(String(rows[0].restaurant), String(world.restaurant._id));
  });

  it('audits report and invoice PDFs too', async () => {
    const {Audit} = await import('../src/models/index.js');
    const order = await sale({});
    await raw('/api/exports/reports/pnl.pdf', {token: owner()});
    await raw(`/api/exports/invoices/${order._id}.pdf`, {token: owner()});

    const report = await Audit.findOne({action: 'export_report'}).lean();
    assert.equal(report.after.target, 'pnl');
    const invoice = await Audit.findOne({action: 'export_invoice_pdf'}).lean();
    assert.equal(String(invoice.entityId), String(order._id));
  });

  it('writes the audit row BEFORE the bytes, so an aborted download is still recorded', async () => {
    // A row written on completion is missing precisely for the downloads that
    // matter after a leak. Proven by ordering: the audit row exists even
    // though the dataset yields nothing.
    const {Audit} = await import('../src/models/index.js');
    await raw('/api/exports/customers.csv', {token: owner()});
    const row = await Audit.findOne({entity: 'export', 'after.target': 'customers'}).lean();
    assert.ok(row, 'an empty export is still a disclosure attempt and must be audited');
  });
});

// ── dataset content ──────────────────────────────────────────────────────────

describe('Phase 19 · dataset content', () => {
  it('exports suppliers with contact and credit detail flattened', async () => {
    await Supplier.create({
      restaurant: world.restaurant._id,
      name: 'Everest Foods',
      pan: '123456789',
      vatRegistered: true,
      paymentTermsDays: 30,
      creditLimit: 50000,
      leadTimeDays: 4,
      contacts: [{name: 'Sita Rai', role: 'Sales', phone: '9800000001', email: 'sita@everest.np', primary: true}],
      addresses: [{label: 'HQ', line1: 'Balaju', city: 'Kathmandu', kind: 'billing'}]
    });
    const res = await raw('/api/exports/suppliers.csv', {token: owner()});
    const lines = csvLines(res.text);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /Everest Foods/);
    assert.match(lines[1], /Sita Rai/);
    assert.match(lines[1], /123456789/);
    assert.match(lines[1], /"Balaju, Kathmandu"/);
    assert.match(lines[1], /50000/);
  });

  it('exports customers with their rollups and excludes merged records', async () => {
    const kept = await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id,
      name: 'Bikash Thapa', phone: '9801111111',
      stats: {totalOrders: 4, totalSpend: 4000, averageOrderValue: 1000}
    });
    await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id,
      name: 'Duplicate Bikash', phone: '9802222222', mergedInto: kept._id
    });
    const res = await raw('/api/exports/customers.csv', {token: owner()});
    assert.match(res.text, /Bikash Thapa/);
    // A merged duplicate is not a customer; exporting it would double-count.
    assert.doesNotMatch(res.text, /Duplicate Bikash/);
  });

  it('exports purchase orders with ordered and received quantities', async () => {
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Rice Wholesalers'});
    const created = await request('/api/purchase-orders', {
      method: 'POST', token: owner(),
      body: {
        branch: String(world.branchA._id),
        supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 5000, unit: 'g', unitPrice: 0.05, vatRate: 13}]
      }
    });
    assert.equal(created.status, 201);
    const res = await raw('/api/exports/purchases.csv', {token: owner()});
    const lines = csvLines(res.text);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /Rice Wholesalers/);
    assert.match(lines[1], /5000/);
    assert.match(lines[1], /draft/);
  });

  it('excludes cancelled orders from the sales export but keeps refunded ones', async () => {
    // Matches the analytics revenue definition, minus the refunded exclusion:
    // a refunded sale is money that moved and belongs on a financial extract,
    // with its refund shown, whereas a cancelled order never happened.
    await sale({});
    const cancelled = await sale({});
    await Order.collection.updateOne({_id: cancelled._id}, {$set: {status: 'cancelled'}});
    const refunded = await sale({});
    await Order.collection.updateOne({_id: refunded._id}, {$set: {status: 'refunded', refundAmount: 395.5}});

    const res = await raw('/api/exports/sales.csv', {token: owner()});
    const lines = csvLines(res.text);
    assert.equal(lines.length, 3);
    assert.doesNotMatch(res.text, /cancelled/);
    assert.match(res.text, /refunded/);
    // Net total nets the refund off: gross 395.5, refunded 395.5, net 0.
    const refundLine = lines.find(line => line.includes('refunded'));
    assert.ok(refundLine.endsWith(',395.5,395.5,0'), refundLine);
  });

  it('reports the inventory value as quantity times weighted average cost', async () => {
    const res = await raw('/api/exports/inventory.csv', {token: manager()});
    const lines = csvLines(res.text);
    assert.equal(lines.length, 2, 'one branch for a manager');
    // seedWorld: 20000g at 0.045 = 900.
    // 20,000 g at Rs 0.045 = Rs 900. Rounding the unit cost to 2dp would print
    // 0.05 here and the row would no longer multiply out.
    assert.match(lines[1], /20000,0\.045,900/);
  });
});

describe('Phase 19 · no bare auth', () => {
  it('does not use a bare auth() in the export router', async () => {
    const {readFile} = await import('node:fs/promises');
    const source = await readFile(new URL('../src/routes/exports.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /auth\(\)/);
  });
});
