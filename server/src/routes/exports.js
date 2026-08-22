import {Router} from 'express';
import mongoose from 'mongoose';
import {auth, requirePermission} from '../middleware/auth.js';
import {Audit} from '../models/index.js';
import {Restaurant} from '../models/operations.js';
import {
  RENDERERS, assertExportFormat, safeFilename, writePdfDocument
} from '../services/exportEngine.js';
import {
  EXPORT_DATASET_KEYS, availableDatasets, exportableBranches, prepareExport
} from '../services/exportDatasets.js';
import {drawReportPack, drawSupplierStatement, drawTaxInvoice} from '../services/exportDocuments.js';
import {getReceipt} from '../services/receipts.js';
import {buildSupplierStatement} from '../services/statements.js';
import {buildPnl} from '../services/pnl.js';
import {analyticsScope, buildCustomerReport, buildInventoryReport, buildSalesReport} from '../services/analytics.js';

/**
 * Phase 19 — export engine HTTP surface.
 *
 * Three families, one authorisation story:
 *
 *   GET /api/exports/datasets            what this caller may download
 *   GET /api/exports/:dataset.:format    bulk CSV / XLSX / PDF extracts
 *   GET /api/exports/invoices/:orderId   A4 tax invoice PDF
 *   GET /api/exports/statements/:id      supplier statement PDF
 *   GET /api/exports/reports/:report     management report PDF
 *
 * NOTHING here re-implements a query, a permission check or an arithmetic
 * rule. Bulk datasets go through `prepareExport()`, which resolves scope with
 * the same `analyticsScope()` the reports use; documents go through the
 * existing `getReceipt()`, `buildSupplierStatement()`, `buildPnl()` and the
 * Phase 18 analytics builders, every one of which enforces its own tenancy.
 * The route's own job is the format, the filename and the audit row.
 */

const r = Router();

const MGMT = ['owner', 'manager'];

/** Mirrors the purchasing router's sanitiser: never leak internals. */
const fail = (res, e) => {
  if (res.headersSent) {
    // The body is already going out; a JSON error would corrupt the file.
    if (!res.destroyed) res.destroy(e instanceof Error ? e : new Error('Export failed'));
    return undefined;
  }
  const status = e?.status || (e?.name === 'ZodError' ? 400 : 500);
  let message = e?.message || 'Export failed';
  if (e?.name === 'MongoServerError' || e?.name === 'ValidationError' || e?.name === 'CastError') {
    message = 'We could not process that request';
  } else if (status >= 500) {
    message = 'Server error';
  }
  return res.status(status).json({message: String(message).slice(0, 300)});
};

/**
 * An export is a bulk disclosure of financial and personal data. Who pulled
 * what, when, for which branch and period is exactly the trail an investigator
 * needs after a data leak, so every download writes an audit row BEFORE the
 * bytes are streamed — a row written afterwards would be missing precisely for
 * the aborted or failed downloads that matter most.
 */
async function recordExport({req, kind, target, format, scope, extra = {}}) {
  await Audit.create({
    entity: 'export',
    entityId: new mongoose.Types.ObjectId(),
    restaurant: scope?.restaurantId || null,
    branch: scope?.branch?._id || null,
    action: `export_${kind}`,
    after: {
      target,
      format,
      scope: scope?.branch ? 'branch' : 'restaurant',
      from: req.query.from || null,
      to: req.query.to || null,
      ...extra
    },
    user: req.user?.id
  });
}

// ── catalogue ────────────────────────────────────────────────────────────────

r.get('/exports/datasets', requirePermission('reports.export'), async (req, res) => {
  try {
    res.json({
      datasets: availableDatasets(req.user),
      formats: ['csv', 'xlsx', 'pdf'],
      branches: await exportableBranches({user: req.user})
    });
  } catch (e) { fail(res, e); }
});

// ── bulk datasets ────────────────────────────────────────────────────────────

/**
 * `:dataset.:format` rather than a `?format=` query so the URL a browser
 * downloads already carries a sensible extension.
 */
r.get(`/exports/:dataset(${EXPORT_DATASET_KEYS.join('|')}).:format`, requirePermission('reports.export'), async (req, res) => {
  try {
    const format = assertExportFormat(req.params.format);
    const prepared = await prepareExport({
      datasetKey: req.params.dataset,
      user: req.user,
      branchId: req.query.branch,
      from: req.query.from,
      to: req.query.to
    });
    await recordExport({
      req, kind: 'dataset', target: prepared.dataset.key, format, scope: prepared.scope
    });
    await RENDERERS[format](res, {
      filename: prepared.filename,
      sheetName: prepared.dataset.title,
      title: prepared.title,
      subtitle: prepared.subtitle,
      meta: prepared.meta,
      columns: prepared.columns,
      rows: prepared.rows
    });
  } catch (e) { fail(res, e); }
});

// ── documents ────────────────────────────────────────────────────────────────

/**
 * Tax invoice PDF. `issue` is NOT accepted here: allocating a legal invoice
 * number is a mutation and stays on `GET /orders/:id/receipt?issue=true`,
 * which already transacts, pins `invoicedTotal` and writes the audit row. This
 * endpoint renders what exists — an un-invoiced order prints as a receipt.
 */
r.get('/exports/invoices/:orderId.pdf', requirePermission('invoices.issue'), async (req, res) => {
  try {
    const receipt = await getReceipt({orderId: req.params.orderId, user: req.user, issue: false});
    await Audit.create({
      entity: 'order',
      entityId: new mongoose.Types.ObjectId(String(req.params.orderId)),
      action: 'export_invoice_pdf',
      after: {invoiceNo: receipt.invoiceNo, document: receipt.document, format: 'pdf'},
      user: req.user?.id
    });
    await writePdfDocument(res, {
      filename: safeFilename(`mittho-${receipt.invoiceNo || receipt.orderNo}`, 'pdf').replace(/\.pdf$/, ''),
      draw: doc => drawTaxInvoice(doc, receipt)
    });
  } catch (e) { fail(res, e); }
});

r.get('/exports/statements/:supplierId.pdf', requirePermission('reports.export'), async (req, res) => {
  try {
    const statement = await buildSupplierStatement({
      supplierId: req.params.supplierId,
      branchId: req.query.branch,
      user: req.user,
      from: req.query.from,
      to: req.query.to,
      // A statement PDF is a document, not a bulk extract: one page-worth of
      // ledger lines with an explicit "showing n of m" footer.
      limit: 500
    });
    await Audit.create({
      entity: 'supplier',
      entityId: new mongoose.Types.ObjectId(String(req.params.supplierId)),
      branch: statement.branch?._id || null,
      action: 'export_statement_pdf',
      after: {
        supplier: statement.supplier?.name,
        from: statement.period?.from || null,
        to: statement.period?.to || null,
        closingBalance: statement.summary?.closingBalance,
        format: 'pdf'
      },
      user: req.user?.id
    });
    await writePdfDocument(res, {
      filename: `mittho-statement-${statement.supplier?.name || 'supplier'}-${statement.period?.to || 'today'}`,
      draw: doc => drawSupplierStatement(doc, statement)
    });
  } catch (e) { fail(res, e); }
});

const REPORT_PACKS = Object.freeze({
  pnl: {title: 'Profit and Loss', parts: ['pnl']},
  sales: {title: 'Sales Report', parts: ['sales']},
  inventory: {title: 'Inventory Report', parts: ['inventory']},
  customers: {title: 'Customer Report', parts: ['customers']},
  full: {title: 'Management Report Pack', parts: ['pnl', 'sales', 'inventory', 'customers']}
});

r.get(`/exports/reports/:report(${Object.keys(REPORT_PACKS).join('|')}).pdf`, requirePermission('reports.export'), async (req, res) => {
  try {
    const pack = REPORT_PACKS[req.params.report];
    const scope = await analyticsScope({branchId: req.query.branch, user: req.user});
    const restaurant = await Restaurant.findById(scope.restaurantId).select('name').lean();
    const args = {
      branchId: req.query.branch, user: req.user, from: req.query.from, to: req.query.to
    };

    // Built through the same functions the JSON endpoints call, so a PDF and
    // the on-screen report for the same parameters cannot disagree.
    const payload = {};
    if (pack.parts.includes('pnl')) payload.pnl = await buildPnl(args);
    if (pack.parts.includes('sales')) {
      payload.sales = await buildSalesReport({...args, granularity: req.query.granularity});
    }
    if (pack.parts.includes('inventory')) payload.inventory = await buildInventoryReport(args);
    if (pack.parts.includes('customers')) payload.customers = await buildCustomerReport(args);

    await recordExport({req, kind: 'report', target: req.params.report, format: 'pdf', scope});

    const scopeLabel = scope.branch ? `${scope.branch.name} (${scope.branch.code || '—'})` : 'All branches';
    await writePdfDocument(res, {
      filename: `mittho-${req.params.report}-${scope.branch?.code || 'all'}-${req.query.to || req.query.from || 'to-date'}`,
      draw: doc => drawReportPack(doc, {
        title: pack.title,
        meta: [
          `${restaurant?.name || 'Restaurant'} · ${scopeLabel}`,
          `${req.query.from || 'beginning'} to ${req.query.to || 'today'} (Asia/Kathmandu)`,
          `Requested by ${req.user?.name || req.user?.id} (${req.user?.role})`
        ],
        ...payload
      })
    });
  } catch (e) { fail(res, e); }
});

export default r;
