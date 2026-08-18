/**
 * A stub eSewa/Khalti provider.
 *
 * The point is to exercise the REAL network path — our code builds real
 * signatures, makes real HTTP calls, parses real responses — while keeping the
 * provider's answer under test control. Stubbing our own gateway module out
 * would only prove that a mock returns what a mock was told to return.
 *
 * It speaks both protocols faithfully:
 *   eSewa  GET  /api/epay/transaction/status/  → {status, total_amount, ref_id}
 *   Khalti POST /api/v2/epayment/initiate/     → {pidx, payment_url}
 *   Khalti POST /api/v2/epayment/lookup/       → {status, total_amount, ...}
 */
import express from 'express';
import http from 'node:http';
import {createHmac} from 'node:crypto';

export const ESEWA_TEST_SECRET = '8gBm/:&EnhH.1/q';
export const ESEWA_TEST_CODE = 'EPAYTEST';
export const KHALTI_TEST_SECRET = 'test_secret_key_for_suite';

export async function startStubGateway() {
  const state = {
    // transaction_uuid -> {status, amount, refId}
    esewa: new Map(),
    // pidx -> {status, amountPaisa, purchaseOrderId, transactionId}
    khalti: new Map(),
    // Force transport-level behaviour for the outage/timeout tests.
    esewaFailure: null, // 'down' | 'slow' | '500'
    khaltiFailure: null,
    calls: {esewaStatus: 0, khaltiInitiate: 0, khaltiLookup: 0},
    nextPidx: 1
  };

  const app = express();
  app.use(express.json());

  app.get('/api/epay/transaction/status/', async (req, res) => {
    state.calls.esewaStatus += 1;
    if (state.esewaFailure === '500') return res.status(500).json({message: 'upstream'});
    if (state.esewaFailure === 'slow') {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    const uuid = String(req.query.transaction_uuid || '');
    const record = state.esewa.get(uuid);
    if (!record) {
      return res.json({
        product_code: req.query.product_code, transaction_uuid: uuid,
        total_amount: Number(req.query.total_amount), status: 'NOT_FOUND'
      });
    }
    res.json({
      product_code: req.query.product_code,
      transaction_uuid: uuid,
      total_amount: record.amount,
      status: record.status,
      ref_id: record.refId || null
    });
  });

  app.post('/api/v2/epayment/initiate/', (req, res) => {
    state.calls.khaltiInitiate += 1;
    if (state.khaltiFailure === '500') return res.status(500).json({detail: 'upstream'});
    if (String(req.headers.authorization || '') !== `Key ${KHALTI_TEST_SECRET}`) {
      return res.status(401).json({detail: 'Invalid key'});
    }
    const pidx = `pidx-${state.nextPidx++}`;
    state.khalti.set(pidx, {
      status: 'Initiated',
      amountPaisa: Number(req.body.amount),
      purchaseOrderId: String(req.body.purchase_order_id),
      transactionId: null
    });
    res.json({
      pidx,
      payment_url: `http://stub.local/pay/${pidx}`,
      expires_at: new Date(Date.now() + 1800_000).toISOString(),
      expires_in: 1800
    });
  });

  app.post('/api/v2/epayment/lookup/', async (req, res) => {
    state.calls.khaltiLookup += 1;
    if (state.khaltiFailure === '500') return res.status(500).json({detail: 'upstream'});
    if (state.khaltiFailure === 'slow') {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (String(req.headers.authorization || '') !== `Key ${KHALTI_TEST_SECRET}`) {
      return res.status(401).json({detail: 'Invalid key'});
    }
    const pidx = String(req.body.pidx || '');
    const record = state.khalti.get(pidx);
    if (!record) return res.status(404).json({detail: 'Not found'});
    res.json({
      pidx,
      total_amount: record.amountPaisa,
      status: record.status,
      transaction_id: record.transactionId,
      fee: 0,
      refunded: false,
      purchase_order_id: record.purchaseOrderId,
      purchase_order_name: 'Order'
    });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    state,
    /** Environment pointing our gateway code at this stub. */
    env(overrides = {}) {
      return {
        NODE_ENV: 'test',
        PAYMENT_MODE: 'sandbox',
        ESEWA_MERCHANT_CODE: ESEWA_TEST_CODE,
        ESEWA_SECRET_KEY: ESEWA_TEST_SECRET,
        ESEWA_FORM_URL: `${baseUrl}/api/epay/main/v2/form`,
        ESEWA_STATUS_URL: `${baseUrl}/api/epay/transaction/status/`,
        KHALTI_SECRET_KEY: KHALTI_TEST_SECRET,
        KHALTI_BASE_URL: baseUrl,
        PAYMENT_RETURN_BASE_URL: 'http://localhost:5173',
        ...overrides
      };
    },
    /** Pretend the guest completed/failed a payment at the provider. */
    setEsewa(uuid, {status = 'COMPLETE', amount, refId = '000ABC'} = {}) {
      state.esewa.set(uuid, {status, amount, refId});
    },
    setKhalti(pidx, patch) {
      const current = state.khalti.get(pidx) || {};
      state.khalti.set(pidx, {...current, ...patch});
    },
    khaltiByPurchaseOrder(reference) {
      for (const [pidx, record] of state.khalti) {
        if (record.purchaseOrderId === reference) return {pidx, record};
      }
      return null;
    },
    reset() {
      state.esewa.clear();
      state.khalti.clear();
      state.esewaFailure = null;
      state.khaltiFailure = null;
      state.calls.esewaStatus = 0;
      state.calls.khaltiInitiate = 0;
      state.calls.khaltiLookup = 0;
    },
    async stop() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/**
 * Build the base64 `data` blob eSewa appends to its success redirect, signed
 * exactly the way eSewa signs it.
 */
export function signedEsewaCallback({
  transactionUuid,
  totalAmount,
  status = 'COMPLETE',
  transactionCode = '000ABC',
  productCode = ESEWA_TEST_CODE,
  secret = ESEWA_TEST_SECRET,
  signedFieldNames = 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names',
  tamper = null
} = {}) {
  const payload = {
    transaction_code: transactionCode,
    status,
    total_amount: String(totalAmount),
    transaction_uuid: transactionUuid,
    product_code: productCode,
    signed_field_names: signedFieldNames
  };
  const message = signedFieldNames.split(',').map(f => `${f}=${payload[f]}`).join(',');
  payload.signature = createHmac('sha256', secret).update(message).digest('base64');
  // Tamper AFTER signing, to model an attacker editing a genuinely signed blob.
  if (tamper) Object.assign(payload, tamper);
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}
