import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Phase 19 — export engine.
 *
 * Three concerns live here and nowhere else:
 *
 *  1. SERIALISATION. CSV, XLSX and PDF renderers that all consume the SAME
 *     `{columns, rows}` shape, where `rows` is an async iterable. A dataset is
 *     therefore described once and can be emitted in any format; there is no
 *     per-format copy of the column list to drift.
 *
 *  2. STREAMING. Nothing here ever holds the full result set. Rows arrive from
 *     a MongoDB cursor, are formatted one at a time, and are written straight
 *     to the socket with backpressure respected. `iterateCursor()` is the
 *     single place any dataset is allowed to pull documents from the driver,
 *     which is what makes the laziness testable (see `exportStats`).
 *
 *  3. SAFETY. CSV formula injection is neutralised, filenames are sanitised
 *     before they reach a header, and a fault that happens AFTER the first
 *     byte destroys the socket instead of completing a truncated file that
 *     looks valid. A half-written export that opens cleanly in Excel is worse
 *     than no export at all.
 */

export const EXPORT_FORMATS = Object.freeze(['csv', 'xlsx', 'pdf']);

/** Documents are paginated artefacts, not bulk extracts. */
export const PDF_MAX_ROWS = 2000;

/** Cursor batch size. Small enough that a huge export never spikes, large
 *  enough that a normal one is not chatty. */
export const EXPORT_BATCH_SIZE = 200;

const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * Observable read counter.
 *
 * Exists so a test can prove the export is lazy: consume three rows of a
 * three-hundred-row dataset and assert that three documents were read. An
 * implementation that quietly went back to `find().lean()` would report three
 * hundred and fail, which is exactly the regression this guards.
 */
export const exportStats = {documentsRead: 0, cursorsOpened: 0, cursorsClosed: 0};

export function resetExportStats() {
  exportStats.documentsRead = 0;
  exportStats.cursorsOpened = 0;
  exportStats.cursorsClosed = 0;
}

/**
 * The only sanctioned way to walk a Mongoose query in an export.
 *
 * `.cursor()` keeps at most one batch in memory. The `finally` closes the
 * cursor even when the consumer stops early (a client that aborts the
 * download, or the PDF row cap being reached), so an abandoned export does not
 * leave a server-side cursor open.
 */
export async function* iterateCursor(query, {batchSize = EXPORT_BATCH_SIZE} = {}) {
  const cursor = query.lean().batchSize(batchSize).cursor({batchSize});
  exportStats.cursorsOpened += 1;
  try {
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      exportStats.documentsRead += 1;
      yield doc;
    }
  } finally {
    exportStats.cursorsClosed += 1;
    await cursor.close().catch(() => {});
  }
}

/** Same guarantee for an aggregation pipeline. */
export async function* iterateAggregate(model, pipeline, {batchSize = EXPORT_BATCH_SIZE} = {}) {
  const cursor = model.aggregate(pipeline).cursor({batchSize});
  exportStats.cursorsOpened += 1;
  try {
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      exportStats.documentsRead += 1;
      yield doc;
    }
  } finally {
    exportStats.cursorsClosed += 1;
    await cursor.close().catch(() => {});
  }
}

// ── value formatting ─────────────────────────────────────────────────────────

export const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

/** Kathmandu local timestamp. Reports are read in Nepal, not in UTC. */
export function kathmanduTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + KATHMANDU_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
}

export function kathmanduDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Turns a raw document value into the primitive the renderers agree on.
 * Numbers stay numbers so a spreadsheet can total them; dates become
 * Kathmandu-local strings so every format shows the same instant.
 */
export function formatValue(value, type) {
  if (value === null || value === undefined) return type === 'money' || type === 'number' || type === 'int' ? 0 : '';
  switch (type) {
    case 'money': return money(value);
    // Unit costs are NOT money to 2dp. Rice at Rs 0.045/g rounds to 0.05, and
    // the exported row then fails to multiply out: 20,000 x 0.05 = 1,000 next
    // to a stock value of 900. Four decimals keeps qty x cost = value true.
    case 'cost': return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
    case 'number': return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
    case 'int': return Math.trunc(Number(value) || 0);
    case 'date': return kathmanduDate(value);
    case 'datetime': return kathmanduTimestamp(value);
    case 'bool': return value ? 'yes' : 'no';
    default: return String(value);
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * A supplier called `=cmd|'/c calc'!A1` is a CSV injection payload: opened in
 * Excel it executes. Prefixing with an apostrophe forces the cell to text. The
 * tab and carriage return are included because Excel strips leading
 * whitespace before deciding, so ` =1+1` is still a formula.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_PREFIXES.some(prefix => text.startsWith(prefix))) text = `'${text}`;
  if (/["\n\r,;]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(values) {
  return values.map(csvCell).join(',') + '\r\n';
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

/** Strips anything that could break out of a Content-Disposition header. */
export function safeFilename(name, extension) {
  const base = String(name || 'export')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // Leading dots and dashes go too: a name beginning `..-` or `-` is both
    // ugly and, on some clients, argument-like.
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 80) || 'export';
  return `${base}.${extension}`;
}

function attach(res, filename, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  // An export is a point-in-time extract of live financial data. Caching it,
  // anywhere, risks one user being handed another tenant's file.
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** Write respecting backpressure, so a slow client cannot balloon the heap. */
function write(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => { res.off('drain', onDrain); res.off('error', onError); res.off('close', onError); };
    res.once('drain', onDrain);
    res.once('error', onError);
    res.once('close', onError);
  });
}

/**
 * A fault after the first byte cannot be turned into a 500 — the status line
 * is already gone. Destroying the socket makes the transfer fail at the
 * client, which is the honest outcome: the alternative is a truncated CSV that
 * opens perfectly and is silently missing rows.
 */
function abort(res, error) {
  if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error('Export failed'));
  throw error;
}

// ── renderers ────────────────────────────────────────────────────────────────

/**
 * @param {object} spec
 * @param {Array<{key,header,type,width}>} spec.columns
 * @param {AsyncIterable<object>} spec.rows  formatted-value source
 */
export async function writeCsv(res, {filename, columns, rows}) {
  attach(res, safeFilename(filename, 'csv'), 'text/csv; charset=utf-8');
  let count = 0;
  try {
    // BOM: without it Excel on Windows reads UTF-8 as the local codepage and
    // mangles every Nepali name in the file.
    await write(res, '\uFEFF' + csvRow(columns.map(column => column.header)));
    for await (const row of rows) {
      await write(res, csvRow(columns.map(column => formatValue(row[column.key], column.type))));
      count += 1;
    }
  } catch (error) {
    abort(res, error);
  }
  await new Promise(resolve => res.end(resolve));
  return count;
}

const XLSX_NUMBER_FORMATS = {
  money: '#,##0.00',
  number: '#,##0.###',
  int: '#,##0'
};

export async function writeXlsx(res, {filename, sheetName = 'Export', title, meta = [], columns, rows}) {
  attach(res, safeFilename(filename, 'xlsx'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({stream: res, useStyles: true, useSharedStrings: false});
  workbook.creator = 'Mittho OPS';
  workbook.created = new Date();
  // The number of rows before the column header: title, meta lines, spacer.
  const preambleRows = (title ? 1 : 0) + meta.length + (title || meta.length ? 1 : 0);
  const headerRowNumber = preambleRows + 1;
  // WorksheetWriter exposes `views` as a GETTER ONLY — assigning to it throws
  // `Cannot set property views of #<WorksheetWriter>`, which killed the
  // response mid-stream and surfaced to the client as "other side closed".
  // The streaming writer takes it as a constructor option instead.
  const sheet = workbook.addWorksheet(
    String(sheetName).slice(0, 31).replace(/[\\/*?:[\]]/g, '-'),
    // Freeze the header, or a 40,000-row financial extract is unreadable once
    // an accountant scrolls.
    {views: [{state: 'frozen', ySplit: headerRowNumber}]}
  );
  sheet.columns = columns.map(column => ({
    key: column.key,
    width: column.width || Math.min(40, Math.max(12, String(column.header).length + 4))
  }));

  let count = 0;
  try {
    if (title) {
      const row = sheet.addRow([title]);
      row.font = {bold: true, size: 14};
      row.commit();
    }
    for (const line of meta) {
      const row = sheet.addRow([line]);
      row.font = {size: 9, color: {argb: 'FF64748B'}};
      row.commit();
    }
    if (title || meta.length) sheet.addRow([]).commit();

    const header = sheet.addRow(columns.map(column => column.header));
    header.font = {bold: true, color: {argb: 'FFFFFFFF'}};
    header.alignment = {vertical: 'middle'};
    header.eachCell(cell => {
      cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF1F2937'}};
      cell.border = {bottom: {style: 'thin', color: {argb: 'FF111827'}}};
    });
    header.commit();

    for await (const source of rows) {
      const row = sheet.addRow(columns.map(column => formatValue(source[column.key], column.type)));
      columns.forEach((column, index) => {
        const format = XLSX_NUMBER_FORMATS[column.type];
        if (format) {
          const cell = row.getCell(index + 1);
          cell.numFmt = format;
          cell.alignment = {horizontal: 'right'};
        }
      });
      row.commit();
      count += 1;
    }
    await workbook.commit();
  } catch (error) {
    abort(res, error);
  }
  return count;
}

const PDF_MARGIN = 36;

function pdfHeader(doc, {title, subtitle, meta}) {
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827').text(title, {align: 'left'});
  if (subtitle) doc.font('Helvetica').fontSize(10).fillColor('#374151').text(subtitle);
  for (const line of meta || []) doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(line);
  doc.moveDown(0.6);
  doc.fillColor('#111827');
}

function pdfTableHeader(doc, columns, widths) {
  const y = doc.y;
  doc.rect(PDF_MARGIN, y - 2, widths.reduce((a, b) => a + b, 0), 16).fill('#1f2937');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
  let x = PDF_MARGIN;
  columns.forEach((column, index) => {
    doc.text(String(column.header), x + 3, y + 2, {
      width: widths[index] - 6, align: column.type && column.type !== 'string' && column.type !== 'date' && column.type !== 'datetime' ? 'right' : 'left', lineBreak: false
    });
    x += widths[index];
  });
  doc.fillColor('#111827').font('Helvetica').fontSize(8);
  doc.y = y + 18;
}

/**
 * Landscape tabular PDF with a repeated header and page numbers.
 *
 * Capped at PDF_MAX_ROWS and says so on the page when it truncates. A PDF is a
 * document a person reads; a 200,000-row extract belongs in CSV, and silently
 * emitting a 4,000-page file would be a denial-of-service on the server and on
 * whoever opens it.
 */
export async function writePdfTable(res, {filename, title, subtitle, meta = [], columns, rows, limit = PDF_MAX_ROWS}) {
  attach(res, safeFilename(filename, 'pdf'), 'application/pdf');
  const doc = new PDFDocument({size: 'A4', layout: 'landscape', margin: PDF_MARGIN, bufferPages: false});
  doc.pipe(res);

  const usable = doc.page.width - PDF_MARGIN * 2;
  const weights = columns.map(column => column.width || 12);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map(weight => (weight / weightTotal) * usable);

  let count = 0;
  let truncated = false;
  try {
    pdfHeader(doc, {title, subtitle, meta});
    pdfTableHeader(doc, columns, widths);

    for await (const source of rows) {
      if (count >= limit) { truncated = true; break; }
      if (doc.y > doc.page.height - PDF_MARGIN - 26) {
        doc.addPage();
        pdfTableHeader(doc, columns, widths);
      }
      const y = doc.y;
      if (count % 2 === 1) {
        doc.rect(PDF_MARGIN, y - 2, usable, 13).fill('#f3f4f6').fillColor('#111827');
      }
      let x = PDF_MARGIN;
      columns.forEach((column, index) => {
        const value = formatValue(source[column.key], column.type);
        const numeric = typeof value === 'number';
        doc.text(
          numeric ? value.toLocaleString('en-US', {minimumFractionDigits: column.type === 'money' ? 2 : 0, maximumFractionDigits: column.type === 'money' ? 2 : 3}) : String(value),
          x + 3, y + 1,
          {width: widths[index] - 6, align: numeric ? 'right' : 'left', lineBreak: false, ellipsis: true}
        );
        x += widths[index];
      });
      doc.y = y + 13;
      count += 1;
    }

    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
      .text(truncated
        ? `Showing the first ${count} rows. This report was truncated — use the CSV or XLSX export for the complete data set.`
        : `${count} row(s).`);
    doc.end();
  } catch (error) {
    try { doc.end(); } catch { /* the socket is going away anyway */ }
    abort(res, error);
  }
  await new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  return count;
}

/**
 * Free-form PDF (invoices, statements) — the caller draws, this handles the
 * headers, the stream and the completion promise.
 */
export async function writePdfDocument(res, {filename, draw}) {
  attach(res, safeFilename(filename, 'pdf'), 'application/pdf');
  const doc = new PDFDocument({size: 'A4', margin: 48, bufferPages: false});
  doc.pipe(res);
  try {
    await draw(doc);
    doc.end();
  } catch (error) {
    try { doc.end(); } catch { /* already tearing down */ }
    abort(res, error);
  }
  await new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  return 1;
}

export function assertExportFormat(format) {
  const value = String(format || 'csv').toLowerCase();
  if (!EXPORT_FORMATS.includes(value)) {
    throw httpError(`format must be one of ${EXPORT_FORMATS.join(', ')}`, 400);
  }
  return value;
}

export const RENDERERS = Object.freeze({csv: writeCsv, xlsx: writeXlsx, pdf: writePdfTable});
