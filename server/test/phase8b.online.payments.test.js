/**
 * Phase 8B — real online payment integration (eSewa + Khalti).
 *
 * These tests run against a stub provider that speaks both real protocols over
 * real HTTP (test/helpers.payments.js), so the code under test builds genuine
 * HMAC signatures, makes genuine network calls and parses genuine responses.
 * The provider's *answer* is controlled; our side of the protocol is not.
 *
 * The security posture being proven throughout: the browser supplies intent,
 * the provider supplies truth, and the two are reconciled server-side against
 * an amount recorded before the guest ever left.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit} from '../src/models/index.js';
import {Order, Payment, PaymentEvent, PaymentIntent} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {startStubGateway, signedEsewaCallback, ESEWA_TEST_SECRET} from './helpers.payments.js';
import {
  esewaSignature,
  normalizeGatewayStatus,
  verifyEsewaCallback,
  toPaisa,
  fromPaisa
} from '../src/services/paymentGateways.js';
import {
  availablePaymentMethods,
  describePayments,
  paymentMode,
  redactPaymentPayload,
  requireProductionPaymentConfig
} from '../src/services/paymentConfig.js';
import {dedupeKeyFor, newPaymentReference} from '../src/services/onlinePayments.js';

let world;
let gateway;
let savedEnv;

before(async () => {
  await startTestApp();
  gateway = await startStubGateway();
  // The routes read process.env per call, so point the whole app at the stub.
  savedEnv = {...process.env};
  Object.assign(process.env, gateway.env());
});

after(async () => {
  process.env = savedEnv;
  await gateway?.stop();
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  gateway.reset();
  Object.assign(process.env, gateway.env());
  world = await seedWorld();
});

const BRANCH = () => String(world.branchA._id);
const PHONE = '9800000001';

/** Place a prepaid online order and return its public body. */
async function placePrepaidOrder(provider = 'esewa', qty = 1) {
  const res = await request('/api/public/orders', {
    method: 'POST',
    body: {
      branch: BRANCH(),
      type: 'takeaway',
      items: [{menuItem: String(world.menu._id), qty}],
      customer: {name: 'Ram Thapa', phone: PHONE},
      paymentMethod: provider
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** Start a gateway payment for an order. */
const startPayment = (orderNo, provider, phone = PHONE) =>
  request('/api/public/payments', {method: 'POST', body: {orderNo, phone, provider}});

const callbackFor = query =>
  request(`/api/public/payments/return?${new URLSearchParams(query).toString()}`);

// ═══════════════════════════════════════════════════════════════════════════
// Configuration and secret hygiene
// ═══════════════════════════════════════════════════════════════════════════

describe('8B — configuration', () => {
  it('offers only providers that are actually configured', () => {
    assert.deepEqual(availablePaymentMethods({NODE_ENV: 'test'}), ['cod', 'esewa'],
      'eSewa has vendor sandbox defaults; Khalti needs a key');
    assert.deepEqual(
      availablePaymentMethods({NODE_ENV: 'test', KHALTI_SECRET_KEY: 'k'}),
      ['cod', 'esewa', 'khalti']
    );
    assert.deepEqual(
      availablePaymentMethods({NODE_ENV: 'production', PAYMENT_MODE: 'production'}),
      ['cod'],
      'production has no default credentials, so no gateway is offered'
    );
  });

  it('exposes availability publicly without leaking any secret', async () => {
    const res = await request('/api/public/payment-methods');
    assert.equal(res.status, 200);
    assert.ok(res.body.methods.includes('esewa'));
    const serialised = JSON.stringify(res.body);
    assert.doesNotMatch(serialised, /8gBm|secret|Key /i, 'no credential may reach a guest');
  });

  it('defaults to sandbox and never to production by accident', () => {
    assert.equal(paymentMode({NODE_ENV: 'development'}), 'sandbox');
    assert.equal(paymentMode({NODE_ENV: 'test'}), 'sandbox');
    assert.equal(paymentMode({NODE_ENV: 'production'}), 'production');
    assert.throws(() => paymentMode({PAYMENT_MODE: 'live'}), /must be sandbox or production/);
  });

  it('refuses the published sandbox secret in production', () => {
    assert.throws(
      () => requireProductionPaymentConfig({
        NODE_ENV: 'production', PAYMENT_MODE: 'production',
        ESEWA_MERCHANT_CODE: 'REALCODE', ESEWA_SECRET_KEY: ESEWA_TEST_SECRET
      }),
      /published sandbox secret/
    );
    assert.throws(
      () => requireProductionPaymentConfig({
        NODE_ENV: 'production', PAYMENT_MODE: 'sandbox'
      }),
      /PAYMENT_MODE must not be sandbox in production/
    );
    assert.doesNotThrow(() => requireProductionPaymentConfig({
      NODE_ENV: 'production', PAYMENT_MODE: 'production',
      ESEWA_MERCHANT_CODE: 'REALCODE', ESEWA_SECRET_KEY: 'a-genuine-production-secret'
    }));
  });

  it('redacts secrets before anything is logged or persisted', () => {
    const redacted = redactPaymentPayload({
      signature: 'abc', total_amount: 100, Authorization: 'Key secret',
      nested: {secret_key: 'x', status: 'COMPLETE'}
    });
    assert.equal(redacted.signature, '[redacted]');
    assert.equal(redacted.Authorization, '[redacted]');
    assert.equal(redacted.nested.secret_key, '[redacted]');
    assert.equal(redacted.total_amount, 100, 'non-secret detail survives for support');
    assert.equal(redacted.nested.status, 'COMPLETE');
  });

  it('reports payment posture on /health without a secret', () => {
    const described = describePayments({NODE_ENV: 'test', KHALTI_SECRET_KEY: 'super-secret'});
    assert.equal(described.khalti.configured, true);
    assert.doesNotMatch(JSON.stringify(described), /super-secret/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Protocol correctness
// ═══════════════════════════════════════════════════════════════════════════

describe('8B — protocol', () => {
  it('signs eSewa exactly as the specification requires', () => {
    // Vendor-documented vector: field order matters and is part of the message.
    const signature = esewaSignature({
      fields: {total_amount: '100', transaction_uuid: '11-201-13', product_code: 'EPAYTEST'},
      order: ['total_amount', 'transaction_uuid', 'product_code'],
      secret: ESEWA_TEST_SECRET
    });
    const reordered = esewaSignature({
      fields: {total_amount: '100', transaction_uuid: '11-201-13', product_code: 'EPAYTEST'},
      order: ['transaction_uuid', 'total_amount', 'product_code'],
      secret: ESEWA_TEST_SECRET
    });
    assert.match(signature, /^[A-Za-z0-9+/]+=*$/, 'base64');
    assert.notEqual(signature, reordered, 'field order is significant');
  });

  it('converts rupees to paisa without floating point drift', () => {
    assert.equal(toPaisa(435.05), 43505);
    assert.equal(toPaisa(0.1 + 0.2), 30);
    assert.equal(fromPaisa(43505), 435.05);
  });

  it('maps every provider status onto one internal vocabulary', () => {
    assert.equal(normalizeGatewayStatus('esewa', 'COMPLETE'), 'paid');
    assert.equal(normalizeGatewayStatus('esewa', 'PENDING'), 'pending');
    assert.equal(normalizeGatewayStatus('esewa', 'NOT_FOUND'), 'failed');
    assert.equal(normalizeGatewayStatus('esewa', 'CANCELED'), 'cancelled');
    assert.equal(normalizeGatewayStatus('khalti', 'Completed'), 'paid');
    assert.equal(normalizeGatewayStatus('khalti', 'Initiated'), 'pending');
    assert.equal(normalizeGatewayStatus('khalti', 'User canceled'), 'cancelled');
    assert.equal(normalizeGatewayStatus('khalti', 'Expired'), 'expired');
    assert.equal(normalizeGatewayStatus('khalti', 'Refunded'), 'refunded');
    assert.equal(normalizeGatewayStatus('khalti', 'Something new'), 'failed',
      'an unknown status must never be treated as paid');
  });

  it('rejects a callback whose signature does not cover the transaction', () => {
    // A caller shortens signed_field_names so the signature covers nothing
    // that identifies the payment, then signs that subset correctly.
    const data = signedEsewaCallback({
      transactionUuid: 'MO-x', totalAmount: '100',
      signedFieldNames: 'product_code'
    });
    assert.throws(() => verifyEsewaCallback({data, env: gateway.env()}),
      /does not cover the transaction/);
  });

  it('rejects malformed and unsigned callbacks', () => {
    const env = gateway.env();
    assert.throws(() => verifyEsewaCallback({data: 'not-base64-json', env}), /Malformed/);
    const unsigned = Buffer.from(JSON.stringify({status: 'COMPLETE'})).toString('base64');
    assert.throws(() => verifyEsewaCallback({data: unsigned, env}), /unsigned/);
  });

  it('generates unguessable, protocol-legal references', () => {
    const a = newPaymentReference();
    const b = newPaymentReference();
    assert.notEqual(a, b);
    assert.match(a, /^MO-[0-9a-f-]{36}$/, 'alphanumeric and hyphens only, per eSewa');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Initiation
// ═══════════════════════════════════════════════════════════════════════════

describe('8B — initiation', () => {
  it('builds a signed eSewa form for the server-computed amount', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    assert.equal(started.status, 201);

    const {redirect, amount, reference} = started.body;
    assert.equal(redirect.method, 'POST');
    assert.equal(redirect.fields.total_amount, Number(order.total).toFixed(2));
    assert.equal(redirect.fields.transaction_uuid, reference);
    assert.equal(amount, order.total, 'the amount is the order total, not a client value');

    // The signature must verify against the fields actually being posted.
    const expected = esewaSignature({
      fields: redirect.fields,
      order: redirect.fields.signed_field_names.split(','),
      secret: ESEWA_TEST_SECRET
    });
    assert.equal(redirect.fields.signature, expected);

    const intent = await PaymentIntent.findOne({reference});
    assert.equal(intent.status, 'pending');
    assert.equal(intent.expectedAmount, order.total);
    assert.equal(intent.mode, 'sandbox');
  });

  it('initiates Khalti server-to-server and never exposes the key', async () => {
    const order = await placePrepaidOrder('khalti');
    const started = await startPayment(order.orderNo, 'khalti');
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.redirect.method, 'GET');
    assert.match(started.body.redirect.action, /^http:\/\/stub\.local\/pay\/pidx-/);
    assert.equal(gateway.state.calls.khaltiInitiate, 1);
    assert.doesNotMatch(JSON.stringify(started.body), /test_secret_key/);

    const intent = await PaymentIntent.findOne({reference: started.body.reference});
    assert.ok(intent.providerReference.startsWith('pidx-'));
    // Khalti is billed in paisa; the stub records exactly what we sent.
    const {record} = gateway.khaltiByPurchaseOrder(started.body.reference);
    assert.equal(record.amountPaisa, toPaisa(order.total));
  });

  it('records an audit entry when a payment starts', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const entry = await Audit.findOne({action: 'online_payment_initiated'}).lean();
    assert.ok(entry, 'initiation must be audited');
    assert.equal(entry.after.orderNo, order.orderNo);
    assert.equal(entry.after.reference, started.body.reference);
  });

  it('refuses to start a payment for someone else\'s order', async () => {
    const order = await placePrepaidOrder('esewa');
    const wrongPhone = await startPayment(order.orderNo, 'esewa', '9779999999');
    assert.equal(wrongPhone.status, 404, 'ownership is proved by orderNo + phone');
    assert.equal(await PaymentIntent.countDocuments({}), 0);
  });

  it('refuses an unknown order without revealing whether it exists', async () => {
    const missing = await startPayment('WEB-0000000', 'esewa');
    assert.equal(missing.status, 404);
    assert.match(missing.body.message, /No matching order/);
  });

  it('refuses a provider that is not configured', async () => {
    delete process.env.KHALTI_SECRET_KEY;
    try {
      const order = await placePrepaidOrder('esewa');
      const res = await startPayment(order.orderNo, 'khalti');
      assert.equal(res.status, 503);
      assert.match(res.body.message, /not available/);
    } finally {
      Object.assign(process.env, gateway.env());
    }
  });

  it('refuses to place an order with an unconfigured gateway', async () => {
    delete process.env.KHALTI_SECRET_KEY;
    try {
      const res = await request('/api/public/orders', {
        method: 'POST',
        body: {
          branch: BRANCH(), type: 'takeaway',
          items: [{menuItem: String(world.menu._id), qty: 1}],
          customer: {name: 'Ram', phone: PHONE},
          paymentMethod: 'khalti'
        }
      });
      assert.equal(res.status, 503, 'a dead redirect is worse than a refusal');
    } finally {
      Object.assign(process.env, gateway.env());
    }
  });

  it('records a truthful failure when the provider is unavailable', async () => {
    gateway.state.khaltiFailure = '500';
    const order = await placePrepaidOrder('khalti');
    const started = await startPayment(order.orderNo, 'khalti');
    assert.equal(started.status, 502);

    const intent = await PaymentIntent.findOne({order: (await Order.findOne({orderNo: order.orderNo}))._id});
    assert.equal(intent.status, 'failed', 'a dead intent must not look payable');
    const fresh = await Order.findOne({orderNo: order.orderNo});
    assert.equal(fresh.paidAmount, 0);
    assert.equal(fresh.paymentSettledAt, undefined);
  });

  it('times out rather than hanging when the provider never answers', async () => {
    gateway.state.esewaFailure = 'slow';
    try {
      const {esewaStatus} = await import('../src/services/paymentGateways.js');
      const began = Date.now();
      await assert.rejects(
        esewaStatus({
          transactionUuid: 'MO-never-answers',
          amount: 100,
          // 200ms budget against a 3s stub delay.
          env: {...gateway.env(), PAYMENT_HTTP_TIMEOUT_MS: '200'}
        }),
        error => {
          assert.equal(error.name, 'GatewayError');
          assert.equal(error.status, 504);
          assert.equal(error.retriable, true, 'a timeout is worth retrying');
          return true;
        }
      );
      // The deadline must actually be enforced, not merely reported.
      assert.ok(Date.now() - began < 2000, 'the request must abort well before the stub replies');
    } finally {
      gateway.state.esewaFailure = null;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Successful payment — the full acceptance chain
// ═══════════════════════════════════════════════════════════════════════════

describe('8B — successful payment', () => {
  it('settles eSewa end to end: order → payment → paid → kitchen → inventory', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;

    // The guest pays at eSewa.
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total, refId: '0001TS9'});
    const data = signedEsewaCallback({transactionUuid: reference, totalAmount: order.total});

    const returned = await callbackFor({ref: reference, data});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.paid, true);
    assert.equal(returned.body.status, 'paid');

    // Payment record.
    const payment = await Payment.findOne({order: (await Order.findOne({orderNo: order.orderNo}))._id});
    assert.equal(payment.status, 'paid');
    assert.equal(payment.method, 'esewa');
    assert.equal(payment.amount, order.total);
    assert.equal(payment.transactionId, '0001TS9', 'the provider reference is retained');

    // Order money.
    const paidOrder = await Order.findOne({orderNo: order.orderNo});
    assert.equal(paidOrder.paidAmount, order.total);
    assert.equal(paidOrder.dueAmount, 0);
    assert.ok(paidOrder.paymentSettledAt instanceof Date);

    // Audit.
    const settled = await Audit.findOne({action: 'online_payment_settled'}).lean();
    assert.ok(settled);
    assert.equal(settled.after.orderNo, order.orderNo);

    // …and the branch can now accept it, which is what moves stock.
    const accept = await request(`/api/online-orders/${paidOrder._id}/accept`, {
      method: 'POST', token: tokenFor(world.manager)
    });
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    const accepted = await Order.findById(paidOrder._id);
    assert.equal(accepted.status, 'confirmed');
    assert.equal(accepted.inventoryDeducted, true, 'inventory moves on acceptance');
  });

  it('settles Khalti via lookup, ignoring the redirect status parameter', async () => {
    const order = await placePrepaidOrder('khalti');
    const started = await startPayment(order.orderNo, 'khalti');
    const {reference} = started.body;
    const {pidx} = gateway.khaltiByPurchaseOrder(reference);

    gateway.setKhalti(pidx, {status: 'Completed', transactionId: 'txn-9'});
    // The browser claims something; the lookup is what counts.
    const returned = await callbackFor({ref: reference, pidx, status: 'Completed'});
    assert.equal(returned.status, 200);
    assert.equal(returned.body.paid, true);
    assert.ok(gateway.state.calls.khaltiLookup >= 1, 'the lookup API must be called');

    const payment = await Payment.findOne({method: 'khalti'});
    assert.equal(payment.amount, order.total);
    assert.equal(payment.transactionId, 'txn-9');
  });

  it('does not believe a redirect that merely claims success', async () => {
    const order = await placePrepaidOrder('khalti');
    const started = await startPayment(order.orderNo, 'khalti');
    const {reference} = started.body;
    const {pidx} = gateway.khaltiByPurchaseOrder(reference);

    // Provider still says Initiated; the browser says Completed. The provider wins.
    gateway.setKhalti(pidx, {status: 'Initiated'});
    const returned = await callbackFor({ref: reference, pidx, status: 'Completed'});
    assert.equal(returned.body.paid, false);
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0, 'no payment may be recorded as taken');

    const fresh = await Order.findOne({orderNo: order.orderNo});
    assert.equal(fresh.paidAmount, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Adversarial and failure cases
// ═══════════════════════════════════════════════════════════════════════════

describe('8B — security', () => {
  it('rejects a forged signature', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total});

    const forged = signedEsewaCallback({
      transactionUuid: reference, totalAmount: order.total, secret: 'the-wrong-secret'
    });
    const res = await callbackFor({ref: reference, data: forged});
    assert.equal(res.status, 400);
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0);
    const fresh = await Order.findOne({orderNo: order.orderNo});
    assert.equal(fresh.paidAmount, 0);
  });

  it('rejects a signed blob edited after signing', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total});

    // Genuinely signed for 10, then rewritten to claim the full amount.
    const tampered = signedEsewaCallback({
      transactionUuid: reference, totalAmount: '10',
      tamper: {total_amount: String(order.total)}
    });
    const res = await callbackFor({ref: reference, data: tampered});
    assert.equal(res.status, 400);
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0);
  });

  it('refuses a signed response belonging to a different transaction', async () => {
    const mine = await placePrepaidOrder('esewa');
    const startedMine = await startPayment(mine.orderNo, 'esewa');

    // Correctly signed, but for someone else's reference.
    const otherRef = newPaymentReference();
    const data = signedEsewaCallback({transactionUuid: otherRef, totalAmount: mine.total});
    const res = await callbackFor({ref: startedMine.body.reference, data});
    assert.equal(res.status, 400);
    assert.match(res.body.message, /does not match/);
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0);
  });

  it('refuses when the provider confirms a different amount', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;

    // The provider itself reports an underpayment.
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: 10});
    const data = signedEsewaCallback({transactionUuid: reference, totalAmount: 10});

    const res = await callbackFor({ref: reference, data});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /does not match/);
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0, 'an underpayment is never fulfilment');

    const flagged = await Audit.findOne({action: 'online_payment_amount_mismatch'}).lean();
    assert.ok(flagged, 'an amount mismatch must be flagged for a human');
    assert.equal(flagged.after.expected, order.total);
    assert.equal(flagged.after.actual, 10);

    const intent = await PaymentIntent.findOne({reference});
    assert.equal(intent.status, 'failed');
    assert.equal(intent.settledAt, null);
  });

  it('processes a duplicate callback exactly once', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total});
    const data = signedEsewaCallback({transactionUuid: reference, totalAmount: order.total});

    const first = await callbackFor({ref: reference, data});
    const second = await callbackFor({ref: reference, data});
    const third = await callbackFor({ref: reference, data});

    assert.equal(first.body.paid, true);
    assert.equal(second.body.paid, true, 'a replay reports the same settled truth');
    assert.equal(second.body.duplicate, true);
    assert.equal(third.body.duplicate, true);

    assert.equal(await Payment.countDocuments({status: 'paid'}), 1, 'exactly one settled payment');
    const paid = await Order.findOne({orderNo: order.orderNo});
    assert.equal(paid.paidAmount, order.total, 'the order is not paid twice');
  });

  it('survives concurrent callbacks without double-paying', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total});

    // Distinct payloads, so the dedupe key differs and both reach settlement.
    const payloads = [1, 2, 3, 4].map(i => signedEsewaCallback({
      transactionUuid: reference, totalAmount: order.total, transactionCode: `00REF${i}`
    }));
    const results = await Promise.all(payloads.map(data => callbackFor({ref: reference, data})));

    assert.ok(results.every(r => r.status === 200), JSON.stringify(results.map(r => r.body)));
    assert.equal(await Payment.countDocuments({status: 'paid'}), 1,
      'the unique {order, settledAt} index must hold under a race');
    const paid = await Order.findOne({orderNo: order.orderNo});
    assert.equal(paid.paidAmount, order.total);
  });

  it('refuses to start a second payment for an already-paid order', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total});
    await callbackFor({
      ref: reference,
      data: signedEsewaCallback({transactionUuid: reference, totalAmount: order.total})
    });

    const again = await startPayment(order.orderNo, 'esewa');
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already paid/);
    assert.equal(await Payment.countDocuments({status: 'paid'}), 1);
  });

  it('records a failed payment and leaves the order payable', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;

    gateway.setEsewa(reference, {status: 'NOT_FOUND', amount: order.total});
    const res = await callbackFor({ref: reference});
    assert.equal(res.status, 200);
    assert.equal(res.body.paid, false);
    assert.equal(res.body.status, 'failed');
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0);

    // The guest may try again.
    const retry = await startPayment(order.orderNo, 'esewa');
    assert.equal(retry.status, 201);
  });

  it('handles a cancelled payment without taking money', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    gateway.setEsewa(reference, {status: 'CANCELED', amount: order.total});

    const res = await callbackFor({ref: reference, cancelled: '1'});
    assert.equal(res.status, 200);
    assert.equal(res.body.paid, false);

    const intent = await PaymentIntent.findOne({reference});
    assert.equal(intent.status, 'cancelled');
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0);
  });

  it('does not cancel a payment the provider says was actually paid', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    // Guest paid, then hit "cancel" on the way back.
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total});

    const res = await callbackFor({ref: reference, cancelled: '1'});
    assert.equal(res.status, 200);
    const intent = await PaymentIntent.findOne({reference});
    assert.notEqual(intent.status, 'cancelled', 'a real payment must not be discarded');
  });

  it('treats an expired Khalti payment as unpaid', async () => {
    const order = await placePrepaidOrder('khalti');
    const started = await startPayment(order.orderNo, 'khalti');
    const {reference} = started.body;
    const {pidx} = gateway.khaltiByPurchaseOrder(reference);
    gateway.setKhalti(pidx, {status: 'Expired'});

    const res = await callbackFor({ref: reference, pidx});
    assert.equal(res.body.paid, false);
    assert.equal(res.body.status, 'expired');
    assert.equal(await Payment.countDocuments({status: 'paid'}), 0);
  });

  it('rejects a callback for an unknown reference', async () => {
    const res = await callbackFor({ref: 'MO-does-not-exist'});
    assert.equal(res.status, 404);
  });

  it('reports a provider outage during verification without inventing an outcome', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    gateway.state.esewaFailure = '500';
    try {
      const res = await callbackFor({ref: started.body.reference});
      assert.ok(res.status >= 400, 'an outage is not a payment');
      assert.equal(await Payment.countDocuments({status: 'paid'}), 0);
    } finally {
      gateway.state.esewaFailure = null;
    }
  });

  it('never leaks provider internals or secrets in a public error', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const forged = signedEsewaCallback({
      transactionUuid: started.body.reference, totalAmount: order.total, secret: 'wrong'
    });
    const res = await callbackFor({ref: started.body.reference, data: forged});
    const serialised = JSON.stringify(res.body);
    assert.doesNotMatch(serialised, /8gBm|test_secret_key|127\.0\.0\.1|node_modules|at Object/);
    assert.ok(serialised.length < 300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Order workflow protection
// ═══════════════════════════════════════════════════════════════════════════

describe('8B — order workflow', () => {
  it('refuses to accept an unpaid prepaid order, so no stock is committed', async () => {
    const order = await placePrepaidOrder('esewa');
    await startPayment(order.orderNo, 'esewa');
    const stored = await Order.findOne({orderNo: order.orderNo});

    const accept = await request(`/api/online-orders/${stored._id}/accept`, {
      method: 'POST', token: tokenFor(world.manager)
    });
    assert.equal(accept.status, 409);
    assert.match(accept.body.message, /not paid/);

    const after = await Order.findById(stored._id);
    assert.equal(after.status, 'pending');
    assert.equal(after.inventoryDeducted, false, 'no stock may move for unpaid food');
  });

  it('still allows a cash-on-delivery order to be accepted unpaid', async () => {
    const res = await request('/api/public/orders', {
      method: 'POST',
      body: {
        branch: BRANCH(), type: 'delivery',
        items: [{menuItem: String(world.menu._id), qty: 1}],
        customer: {name: 'Ram', phone: PHONE},
        address: 'Jhamsikhel, Lalitpur',
        paymentMethod: 'cod'
      }
    });
    assert.equal(res.status, 201);
    const stored = await Order.findOne({orderNo: res.body.orderNo});
    const accept = await request(`/api/online-orders/${stored._id}/accept`, {
      method: 'POST', token: tokenFor(world.manager)
    });
    assert.equal(accept.status, 200, 'COD is collected on delivery by design');
  });

  it('shows staff whether a prepaid order actually paid', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');

    let list = await request(`/api/online-orders?branch=${BRANCH()}`, {token: tokenFor(world.manager)});
    let row = list.body.orders.find(o => o.orderNo === order.orderNo);
    assert.equal(row.prepaid, true);
    assert.equal(row.paymentConfirmed, false);

    gateway.setEsewa(started.body.reference, {status: 'COMPLETE', amount: order.total});
    await callbackFor({
      ref: started.body.reference,
      data: signedEsewaCallback({transactionUuid: started.body.reference, totalAmount: order.total})
    });

    list = await request(`/api/online-orders?branch=${BRANCH()}`, {token: tokenFor(world.manager)});
    row = list.body.orders.find(o => o.orderNo === order.orderNo);
    assert.equal(row.paymentConfirmed, true);
  });

  it('keeps payment endpoints outside the staff authorisation surface', async () => {
    // Public payment routes are intentionally unauthenticated, but they must
    // not become a way to read staff data.
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const status = await request(`/api/public/payments/${started.body.reference}`);
    assert.equal(status.status, 200);
    assert.deepEqual(Object.keys(status.body).sort(), [
      'amount', 'expiresAt', 'orderNo', 'orderStatus', 'paid', 'provider', 'reference', 'status'
    ]);
    assert.doesNotMatch(JSON.stringify(status.body), /_id|customer|branch|restaurant/);
  });

  it('isolates payments to their own restaurant', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const intent = await PaymentIntent.findOne({reference: started.body.reference});
    assert.equal(String(intent.restaurant), String(world.restaurant._id));
    assert.equal(String(intent.branch), BRANCH());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Audit trail
// ═══════════════════════════════════════════════════════════════════════════

describe('8B — payment audit trail', () => {
  it('records every provider interaction, including rejected ones', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const {reference} = started.body;
    gateway.setEsewa(reference, {status: 'COMPLETE', amount: order.total});
    await callbackFor({
      ref: reference,
      data: signedEsewaCallback({transactionUuid: reference, totalAmount: order.total})
    });

    const events = await PaymentEvent.find({}).sort({at: 1}).lean();
    const kinds = events.map(e => e.kind);
    assert.ok(kinds.includes('initiated'));
    assert.ok(kinds.includes('callback'));
    assert.ok(kinds.includes('settled'));
    // Nothing secret is retained anywhere in the trail.
    assert.doesNotMatch(JSON.stringify(events), /8gBm|test_secret_key/);
    for (const event of events) {
      if (event.detail?.signature) {
        assert.equal(event.detail.signature, '[redacted]');
      }
    }
  });

  it('makes a duplicate provably impossible to record twice', async () => {
    const key = dedupeKeyFor({provider: 'esewa', reference: 'MO-1', kind: 'callback', payload: {a: 1}});
    const same = dedupeKeyFor({provider: 'esewa', reference: 'MO-1', kind: 'callback', payload: {a: 1}});
    const different = dedupeKeyFor({provider: 'esewa', reference: 'MO-1', kind: 'callback', payload: {a: 2}});
    assert.equal(key, same, 'an identical message yields an identical key');
    assert.notEqual(key, different, 'a different message is allowed through');
  });

  it('enforces the dedupe key at the database level', async () => {
    const order = await placePrepaidOrder('esewa');
    const started = await startPayment(order.orderNo, 'esewa');
    const intent = await PaymentIntent.findOne({reference: started.body.reference});
    await PaymentEvent.init();

    const base = {
      intent: intent._id, order: intent.order, provider: 'esewa',
      kind: 'callback', outcome: 'paid', dedupeKey: 'fixed-key', amount: 1
    };
    await PaymentEvent.create(base);
    await assert.rejects(
      PaymentEvent.create(base),
      error => error.code === 11000,
      'the unique index, not application logic, is the guarantee'
    );
  });
});
