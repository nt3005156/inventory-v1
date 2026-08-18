/**
 * Provider protocol adapters: eSewa ePay v2 and Khalti ePayment v2.
 *
 * These are pure protocol — signing, encoding, HTTP, and response shape. They
 * hold no database logic and make no decision about an order. The rule they
 * exist to enforce is that a payment is only ever real if the PROVIDER says so
 * on a server-to-server channel we initiated. A browser redirect is a hint
 * that something happened, never proof of what.
 */
import {createHmac, timingSafeEqual} from 'node:crypto';
import {esewaConfig, khaltiConfig} from './paymentConfig.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Per-request deadline, overridable so the timeout path itself is testable. */
function timeoutFor(env = process.env) {
  const configured = Number(env.PAYMENT_HTTP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

export class GatewayError extends Error {
  constructor(message, {status = 502, provider, retriable = false, cause} = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.provider = provider;
    this.retriable = retriable;
    this.cause = cause;
  }
}

/**
 * fetch with a hard timeout. A gateway that never answers must not hold an
 * Express handler (and its Mongo session) open indefinitely.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new GatewayError('The payment provider did not respond in time', {status: 504, retriable: true, cause: error});
    }
    throw new GatewayError('The payment provider could not be reached', {status: 502, retriable: true, cause: error});
  } finally {
    clearTimeout(timer);
  }
}

/** Constant-time compare so a signature cannot be recovered by timing. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * eSewa amounts are compared with a paisa-level tolerance: the gateway echoes
 * "1000.0" for 1000 and may format differently, so exact string equality is
 * wrong while a loose == would accept a genuine mismatch.
 */
function amountsMatch(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

// ── eSewa ePay v2 ────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256, base64, over `field=value` pairs joined by commas in exactly
 * the order named by signed_field_names. Field order is part of the protocol.
 */
export function esewaSignature({fields, order, secret}) {
  const message = order.map(name => `${name}=${fields[name]}`).join(',');
  return createHmac('sha256', secret).update(message).digest('base64');
}

/**
 * Build the signed form the guest's browser POSTs to eSewa.
 * total_amount must equal amount + tax + service + delivery, and it is the
 * server's number — never a client's.
 */
export function buildEsewaForm({amount, transactionUuid, successUrl, failureUrl, env = process.env}) {
  const config = esewaConfig(env);
  if (!config.configured) {
    throw new GatewayError('eSewa is not configured', {status: 503, provider: 'esewa'});
  }
  // eSewa accepts alphanumerics and hyphens only in transaction_uuid.
  if (!/^[A-Za-z0-9-]+$/.test(String(transactionUuid))) {
    throw new GatewayError('Invalid eSewa transaction reference', {status: 400, provider: 'esewa'});
  }

  const total = Number(amount).toFixed(2);
  const fields = {
    amount: total,
    tax_amount: '0',
    total_amount: total,
    transaction_uuid: String(transactionUuid),
    product_code: config.productCode,
    product_service_charge: '0',
    product_delivery_charge: '0',
    success_url: successUrl,
    failure_url: failureUrl,
    signed_field_names: 'total_amount,transaction_uuid,product_code'
  };
  fields.signature = esewaSignature({
    fields,
    order: ['total_amount', 'transaction_uuid', 'product_code'],
    secret: config.secret
  });

  return {provider: 'esewa', method: 'POST', action: config.formUrl, fields};
}

/**
 * Verify the base64 `data` blob eSewa appends to the success redirect.
 *
 * The signature covers whichever fields signed_field_names names, so the
 * message is rebuilt from that list rather than a hardcoded one — otherwise a
 * caller could shorten the list and sign a subset.
 */
export function verifyEsewaCallback({data, env = process.env}) {
  const config = esewaConfig(env);
  if (!config.configured) {
    throw new GatewayError('eSewa is not configured', {status: 503, provider: 'esewa'});
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'));
  } catch (error) {
    throw new GatewayError('Malformed eSewa response', {status: 400, provider: 'esewa', cause: error});
  }
  if (!decoded || typeof decoded !== 'object') {
    throw new GatewayError('Malformed eSewa response', {status: 400, provider: 'esewa'});
  }

  const signedFieldNames = String(decoded.signed_field_names || '');
  if (!signedFieldNames) {
    throw new GatewayError('eSewa response is unsigned', {status: 400, provider: 'esewa'});
  }
  // The transaction identity fields must be inside the signed set, or a
  // valid-looking signature could cover nothing that matters.
  const signedList = signedFieldNames.split(',').map(f => f.trim()).filter(Boolean);
  for (const required of ['transaction_uuid', 'total_amount', 'status']) {
    if (!signedList.includes(required)) {
      throw new GatewayError('eSewa response signature does not cover the transaction', {status: 400, provider: 'esewa'});
    }
  }

  const expected = esewaSignature({fields: decoded, order: signedList, secret: config.secret});
  if (!safeEqual(expected, decoded.signature)) {
    throw new GatewayError('eSewa signature verification failed', {status: 400, provider: 'esewa'});
  }

  return {
    provider: 'esewa',
    transactionUuid: String(decoded.transaction_uuid),
    status: String(decoded.status || '').toUpperCase(),
    amount: Number(decoded.total_amount),
    reference: decoded.transaction_code ? String(decoded.transaction_code) : null,
    raw: decoded
  };
}

/**
 * Server-to-server status check. This is the authority: even a
 * correctly-signed redirect is confirmed against eSewa directly before any
 * money is recorded, which also covers the case where the guest never returns.
 */
export async function esewaStatus({transactionUuid, amount, env = process.env}) {
  const config = esewaConfig(env);
  if (!config.configured) {
    throw new GatewayError('eSewa is not configured', {status: 503, provider: 'esewa'});
  }
  const url = new URL(config.statusUrl);
  url.searchParams.set('product_code', config.productCode);
  url.searchParams.set('total_amount', Number(amount).toFixed(2));
  url.searchParams.set('transaction_uuid', String(transactionUuid));

  const response = await fetchWithTimeout(url.toString(), {headers: {Accept: 'application/json'}}, timeoutFor(env));
  if (!response.ok) {
    throw new GatewayError('eSewa rejected the status enquiry', {
      status: response.status >= 500 ? 502 : 400,
      provider: 'esewa',
      retriable: response.status >= 500
    });
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new GatewayError('eSewa returned an unreadable status', {status: 502, provider: 'esewa', cause: error});
  }

  return {
    provider: 'esewa',
    status: String(body.status || '').toUpperCase(),
    amount: Number(body.total_amount),
    transactionUuid: String(body.transaction_uuid ?? transactionUuid),
    reference: body.ref_id ? String(body.ref_id) : null,
    amountMatches: amountsMatch(body.total_amount, amount),
    raw: body
  };
}

// ── Khalti ePayment v2 ───────────────────────────────────────────────────────

/** Khalti works in paisa; our ledger works in rupees. */
export const toPaisa = rupees => Math.round(Number(rupees) * 100);
export const fromPaisa = paisa => Number(paisa) / 100;

/**
 * Server-to-server initiation. The secret key never reaches the browser: we
 * call Khalti, and hand the guest only the returned payment_url.
 */
export async function initiateKhalti({amount, purchaseOrderId, purchaseOrderName, returnUrl, websiteUrl, customer, env = process.env}) {
  const config = khaltiConfig(env);
  if (!config.configured) {
    throw new GatewayError('Khalti is not configured', {status: 503, provider: 'khalti'});
  }

  const response = await fetchWithTimeout(config.initiateUrl, {
    method: 'POST',
    headers: {Authorization: `Key ${config.secret}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      return_url: returnUrl,
      website_url: websiteUrl,
      amount: toPaisa(amount),
      purchase_order_id: String(purchaseOrderId),
      purchase_order_name: String(purchaseOrderName).slice(0, 120),
      customer_info: customer ? {
        name: customer.name || undefined,
        email: customer.email || undefined,
        phone: customer.phone || undefined
      } : undefined
    })
  }, timeoutFor(env));

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body?.pidx || !body?.payment_url) {
    throw new GatewayError('Khalti could not start this payment', {
      status: response.status >= 500 ? 502 : 400,
      provider: 'khalti',
      retriable: response.status >= 500
    });
  }

  return {
    provider: 'khalti',
    pidx: String(body.pidx),
    paymentUrl: String(body.payment_url),
    expiresAt: body.expires_at ? new Date(body.expires_at) : null
  };
}

/**
 * The lookup API is the only thing that decides a Khalti payment. The redirect
 * carries a `status` query parameter; it is deliberately ignored here.
 *
 * Khalti statuses: Completed, Pending, Initiated, Refunded, Expired,
 * User canceled. Only Completed is money.
 */
export async function khaltiLookup({pidx, env = process.env}) {
  const config = khaltiConfig(env);
  if (!config.configured) {
    throw new GatewayError('Khalti is not configured', {status: 503, provider: 'khalti'});
  }

  const response = await fetchWithTimeout(config.lookupUrl, {
    method: 'POST',
    headers: {Authorization: `Key ${config.secret}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({pidx: String(pidx)})
  }, timeoutFor(env));

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body) {
    throw new GatewayError('Khalti could not confirm this payment', {
      status: response.status >= 500 ? 502 : 400,
      provider: 'khalti',
      retriable: response.status >= 500
    });
  }

  return {
    provider: 'khalti',
    status: String(body.status || ''),
    pidx: String(body.pidx ?? pidx),
    amount: fromPaisa(body.total_amount),
    reference: body.transaction_id ? String(body.transaction_id) : null,
    purchaseOrderId: body.purchase_order_id ? String(body.purchase_order_id) : null,
    refunded: Boolean(body.refunded),
    raw: body
  };
}

/**
 * Normalise both providers onto one internal vocabulary so the order workflow
 * never branches on provider-specific strings.
 *   paid | pending | failed | cancelled | expired | refunded
 */
export function normalizeGatewayStatus(provider, status) {
  const value = String(status || '').trim().toLowerCase();
  if (provider === 'esewa') {
    if (value === 'complete') return 'paid';
    if (value === 'pending' || value === 'ambiguous') return 'pending';
    if (value === 'canceled' || value === 'cancelled') return 'cancelled';
    if (value === 'full_refund' || value === 'partial_refund') return 'refunded';
    return 'failed'; // NOT_FOUND, ERROR, anything unknown
  }
  if (provider === 'khalti') {
    if (value === 'completed') return 'paid';
    if (value === 'pending' || value === 'initiated') return 'pending';
    if (value === 'user canceled' || value === 'user cancelled') return 'cancelled';
    if (value === 'expired') return 'expired';
    if (value === 'refunded') return 'refunded';
    return 'failed';
  }
  return 'failed';
}

export const __testing = {amountsMatch, safeEqual, fetchWithTimeout};
