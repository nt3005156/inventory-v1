/**
 * Online payment workflow (Phase 8B).
 *
 * The single rule this module exists to enforce:
 *
 *   A payment is real only when the PROVIDER confirms it, server-to-server,
 *   for an amount we ourselves recorded before the guest left.
 *
 * Consequences, all implemented below:
 *   - The redirect's own `status` parameter is never believed. eSewa's signed
 *     blob is verified AND then re-confirmed by status enquiry; Khalti's
 *     redirect is ignored entirely in favour of the lookup API.
 *   - The amount is compared against `expectedAmount`, captured at initiation
 *     from the server-computed order total.
 *   - Every callback is recorded as a PaymentEvent with a unique dedupeKey, so
 *     a replayed callback is refused by the database rather than by a check
 *     that might be forgotten.
 *   - Settlement runs in a transaction and sets `settledAt`, which carries a
 *     unique partial index per order, so two racing callbacks cannot both pay.
 */
import {randomUUID, createHash} from 'node:crypto';
import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {Branch, Order, Payment, PaymentEvent, PaymentIntent} from '../models/operations.js';
import {money} from './billing.js';
import {
  availablePaymentMethods,
  paymentMode,
  paymentReturnBase,
  providerConfig,
  redactPaymentPayload
} from './paymentConfig.js';
import {
  GatewayError,
  buildEsewaForm,
  esewaStatus,
  initiateKhalti,
  khaltiLookup,
  normalizeGatewayStatus,
  verifyEsewaCallback
} from './paymentGateways.js';

const httpError = (message, status = 400) => Object.assign(new Error(message), {status});
/**
 * An error whose message is written for the guest and is safe to show even at
 * a 5xx status. Opt-in, so an unexpected internal 500 is still masked.
 */
const publicError = (message, status = 400) =>
  Object.assign(new Error(message), {status, publicMessage: true});

// A guest gets a bounded window to pay before the intent is treated as stale.
export const PAYMENT_INTENT_TTL_MINUTES = 30;

const clean = value => String(value ?? '').trim();

/**
 * Our reference, and the gateway join key.
 *
 * Deliberately NOT the order id: it must be unguessable, because anyone who
 * can guess a live reference could attempt to associate their own gateway
 * session with someone else's order. A UUID also satisfies eSewa's
 * alphanumeric-and-hyphen constraint.
 */
export function newPaymentReference() {
  return `MO-${randomUUID()}`;
}

/**
 * Stable fingerprint of a provider message. Two byte-identical callbacks
 * produce the same key and the unique index rejects the duplicate; a genuinely
 * different message (a later status transition) produces a different key and
 * is allowed through.
 */
export function dedupeKeyFor({provider, reference, kind, payload}) {
  const digest = createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex')
    .slice(0, 32);
  return `${provider}:${reference}:${kind}:${digest}`;
}

/**
 * Append to the payment audit trail.
 *
 * Returns false when the event already exists — that IS the duplicate-callback
 * signal, and it comes from a unique index rather than from a read-then-write
 * race.
 */
export async function recordPaymentEvent({intent, kind, outcome, amount, message, detail, dedupeKey, session}) {
  try {
    await PaymentEvent.create([{
      intent: intent._id,
      order: intent.order,
      provider: intent.provider,
      kind,
      outcome,
      dedupeKey,
      amount: money(amount || 0),
      message: message ? String(message).slice(0, 300) : undefined,
      detail: detail ? redactPaymentPayload(detail) : null
    }], {session: session || undefined});
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * Start a payment for an online order.
 *
 * Only a `pending`, unpaid, online order may be paid for. The amount comes
 * from the stored order, never from the caller.
 */
export async function createPaymentIntent({orderNo, phone, provider, env = process.env}) {
  const reference = clean(orderNo).toUpperCase();
  const contact = clean(phone);
  if (!reference || !contact) throw httpError('Order number and phone are required', 400);
  if (!['esewa', 'khalti'].includes(provider)) {
    throw httpError('Choose either eSewa or Khalti', 400);
  }
  if (!availablePaymentMethods(env).includes(provider)) {
    throw publicError(`${provider === 'esewa' ? 'eSewa' : 'Khalti'} is not available right now`, 503);
  }

  // Ownership: the caller must know the order number AND the phone on it. This
  // is the same non-enumerable pairing the public tracking endpoint uses, so a
  // stranger cannot start (or complete) a payment against someone else's order.
  const order = await Order.findOne({orderNo: reference}).populate('customer', 'name phone email');
  if (!order || clean(order.customer?.phone) !== contact) {
    throw httpError('No matching order found', 404);
  }
  if (order.source !== 'online') throw httpError('This order is not an online order', 409);
  if (Number(order.paidAmount || 0) > 0 || order.paymentSettledAt) {
    throw httpError('This order is already paid', 409);
  }
  if (!['pending'].includes(order.status)) {
    throw httpError(`This order can no longer be paid (${order.status})`, 409);
  }

  const branch = await Branch.findById(order.branch).select('restaurant name');
  if (!branch) throw httpError('Branch not found', 404);

  /**
   * P2E — starting a NEW online payment requires the onlineOrdering
   * entitlement.
   *
   * Deliberately placed after the ownership and status checks, so a caller
   * who does not already know the order number AND its phone number learns
   * nothing about the tenant's plan — the 404 above still fires first.
   *
   * Note what is NOT gated: the payment RETURN handler and reference lookup.
   * A guest who was redirected to eSewa while the feature was live must be
   * able to complete and verify that payment even if the plan lapses in
   * between. Stranding money in flight would be worse than the revenue the
   * gate protects.
   */
  const {assertFeature} = await import('./entitlements.js');
  await assertFeature(branch.restaurant, 'onlineOrdering', {label: 'Online payment'});

  const amount = money(order.total);
  if (!(amount > 0)) throw httpError('This order has no payable amount', 409);

  const ourReference = newPaymentReference();
  const expiresAt = new Date(Date.now() + PAYMENT_INTENT_TTL_MINUTES * 60_000);
  const mode = paymentMode(env);

  const [intent] = await PaymentIntent.create([{
    order: order._id,
    branch: order.branch,
    restaurant: branch.restaurant,
    provider,
    reference: ourReference,
    expectedAmount: amount,
    status: 'initiated',
    mode,
    expiresAt
  }]);

  const base = paymentReturnBase(env);
  const returnUrl = `${base}/order/payment/return?ref=${encodeURIComponent(ourReference)}`;
  const failureUrl = `${base}/order/payment/return?ref=${encodeURIComponent(ourReference)}&cancelled=1`;

  try {
    let redirect;
    if (provider === 'esewa') {
      // eSewa is a browser form POST; there is no server-to-server initiation.
      redirect = buildEsewaForm({
        amount, transactionUuid: ourReference, successUrl: returnUrl, failureUrl, env
      });
    } else {
      const started = await initiateKhalti({
        amount,
        purchaseOrderId: ourReference,
        purchaseOrderName: `Order ${order.orderNo}`,
        returnUrl,
        websiteUrl: base,
        customer: order.customer,
        env
      });
      intent.providerReference = started.pidx;
      if (started.expiresAt) intent.expiresAt = started.expiresAt;
      redirect = {provider: 'khalti', method: 'GET', action: started.paymentUrl, fields: {}};
    }

    intent.status = 'pending';
    intent.attempts += 1;
    await intent.save();

    await recordPaymentEvent({
      intent, kind: 'initiated', outcome: 'pending', amount,
      message: `Payment started with ${provider}`,
      detail: {mode, reference: ourReference},
      dedupeKey: dedupeKeyFor({provider, reference: ourReference, kind: 'initiated', payload: {at: Date.now()}})
    });
    await Audit.create([{
      entity: 'payment', entityId: intent._id, branch: order.branch,
      action: 'online_payment_initiated',
      after: {provider, reference: ourReference, amount, orderNo: order.orderNo},
      user: null
    }]);

    return {intent, order, redirect, amount, reference: ourReference, expiresAt: intent.expiresAt};
  } catch (error) {
    // A provider that is down must leave a truthful record, not a dangling
    // "pending" intent that looks like the guest might still pay.
    intent.status = 'failed';
    intent.failureReason = error instanceof GatewayError ? error.message : 'Could not start the payment';
    await intent.save();
    await recordPaymentEvent({
      intent, kind: 'failed', outcome: 'failed', amount,
      message: intent.failureReason,
      dedupeKey: dedupeKeyFor({provider, reference: ourReference, kind: 'failed', payload: {at: Date.now()}})
    });
    throw error;
  }
}

/**
 * Mark an intent (and its order) paid, exactly once.
 *
 * Everything here is inside one transaction: the Payment record, the order
 * totals, and the intent's settledAt. The unique partial index on
 * {order, settledAt} is the real guarantee — if two verified callbacks race,
 * the second write fails at the database, not at an application check.
 */
async function settleIntent({intent, confirmed, session}) {
  const order = await Order.findById(intent.order).session(session);
  if (!order) throw httpError('Order not found', 404);

  // Atomically CLAIM the intent before doing anything that moves money.
  //
  // Concurrent callbacks all target the SAME intent document, so a unique
  // index across documents can never separate them - the guarantee has to be a
  // conditional write. This update matches only while settledAt is still null,
  // so exactly one racing caller transitions the document and the losers get
  // null back and settle nothing.
  const claimedAt = new Date();
  const claim = await PaymentIntent.findOneAndUpdate(
    {_id: intent._id, settledAt: null},
    {$set: {settledAt: claimedAt, status: 'paid'}},
    {new: true, session}
  );
  if (!claim) {
    // Someone else won. Report their settled result; never write a second one.
    const settled = await PaymentIntent.findById(intent._id).session(session);
    const existing = settled?.payment ? await Payment.findById(settled.payment).session(session) : null;
    return {order, payment: existing, alreadySettled: true};
  }

  const amount = money(confirmed.amount);
  const transactionId = confirmed.reference || intent.providerReference || intent.reference;

  // Phase 8A already wrote a pending Payment stub when the guest chose a
  // digital method. Upgrade that row rather than adding a second one, so an
  // order never carries two Payment records for one settlement.
  let payment = await Payment.findOne({
    order: order._id, method: intent.provider, status: 'pending'
  }).session(session);

  if (payment) {
    payment.amount = amount;
    payment.transactionId = transactionId;
    payment.status = 'paid';
    await payment.save({session});
  } else {
    [payment] = await Payment.create([{
      order: order._id,
      // P1B: gateway settlements carry the tenant explicitly.
      restaurant: order.restaurant,
      branch: order.branch,
      amount,
      method: intent.provider,
      transactionId,
      status: 'paid'
    }], {session});
  }

  order.paidAmount = money(Number(order.paidAmount || 0) + amount);
  order.dueAmount = money(Math.max(0, Number(order.total || 0) - Number(order.paidAmount)));
  order.paymentSettledAt = new Date();
  order.paymentReference = intent.reference;
  await order.save({session});

  // Finish populating the document we successfully claimed above.
  await PaymentIntent.updateOne(
    {_id: intent._id},
    {$set: {
      paidAmount: amount,
      transactionId: confirmed.reference || null,
      payment: payment._id,
      lastCheckedAt: new Date(),
      lastResponse: redactPaymentPayload(confirmed.raw || null)
    }},
    {session}
  );
  intent.status = 'paid';
  intent.paidAmount = amount;
  intent.settledAt = claimedAt;
  intent.payment = payment._id;

  await Audit.create([{
    entity: 'payment', entityId: payment._id, branch: order.branch,
    action: 'online_payment_settled',
    after: {
      provider: intent.provider, amount, orderNo: order.orderNo,
      reference: intent.reference, transactionId: intent.transactionId
    },
    user: null
  }], {session});

  return {order, payment, alreadySettled: false};
}

/**
 * Record a non-paid terminal/interim outcome without touching the order's
 * money. A failed or cancelled payment must leave the order payable again.
 */
async function recordUnsuccessful({intent, outcome, message, confirmed}) {
  intent.status = outcome;
  intent.failureReason = message ? String(message).slice(0, 300) : null;
  intent.lastCheckedAt = new Date();
  if (confirmed?.raw) intent.lastResponse = redactPaymentPayload(confirmed.raw);
  await intent.save();
  return intent;
}

/**
 * The verification core, shared by the callback route and by any later
 * reconciliation sweep.
 *
 * `payload` is whatever the browser came back with. It is used only to locate
 * the intent and to detect duplicates — never to decide the outcome.
 */
export async function verifyAndSettle({reference, payload = {}, env = process.env, source = 'callback'}) {
  const ref = clean(reference);
  if (!ref) throw httpError('Payment reference is required', 400);

  const intent = await PaymentIntent.findOne({reference: ref});
  if (!intent) throw httpError('Unknown payment reference', 404);

  const config = providerConfig(intent.provider, env);
  if (!config.configured) throw httpError('This payment method is not available', 503);

  // Duplicate protection comes first: an identical repeat of a message we have
  // already processed must not trigger another provider call or another write.
  const dedupeKey = dedupeKeyFor({
    provider: intent.provider, reference: ref, kind: source, payload
  });
  const firstTime = await recordPaymentEvent({
    intent, kind: source === 'callback' ? 'callback' : 'status_check',
    outcome: 'pending', amount: intent.expectedAmount,
    message: 'Provider response received', detail: payload, dedupeKey
  });
  if (!firstTime) {
    // Replay. Report the settled truth we already hold; change nothing.
    const order = await Order.findById(intent.order);
    return {
      intent, order, duplicate: true,
      outcome: intent.status,
      paid: intent.status === 'paid'
    };
  }

  // Already settled by an earlier, different message: still never pay twice.
  if (intent.settledAt) {
    const order = await Order.findById(intent.order);
    return {intent, order, duplicate: false, alreadySettled: true, outcome: 'paid', paid: true};
  }

  // ── Establish the truth from the provider, not from the browser ──────────
  let confirmed;
  if (intent.provider === 'esewa') {
    // If eSewa sent its signed blob, the signature must verify. A bad
    // signature is a hard stop: it means the response was tampered with.
    if (payload?.data) {
      const verified = verifyEsewaCallback({data: payload.data, env});
      if (verified.transactionUuid !== ref) {
        await recordPaymentEvent({
          intent, kind: 'rejected', outcome: 'rejected', amount: intent.expectedAmount,
          message: 'Signed response is for a different transaction',
          dedupeKey: `${dedupeKey}:mismatch`
        });
        throw httpError('This payment response does not match the order', 400);
      }
    }
    // Signature good (or absent) — confirm with eSewa directly regardless.
    confirmed = await esewaStatus({transactionUuid: ref, amount: intent.expectedAmount, env});
  } else {
    const pidx = intent.providerReference || clean(payload?.pidx);
    if (!pidx) throw httpError('This payment cannot be confirmed', 400);
    confirmed = await khaltiLookup({pidx, env});
    // The lookup must be for the purchase we started, when Khalti echoes it.
    if (confirmed.purchaseOrderId && confirmed.purchaseOrderId !== ref) {
      await recordPaymentEvent({
        intent, kind: 'rejected', outcome: 'rejected', amount: intent.expectedAmount,
        message: 'Lookup is for a different purchase',
        dedupeKey: `${dedupeKey}:mismatch`
      });
      throw httpError('This payment response does not match the order', 400);
    }
  }

  const outcome = normalizeGatewayStatus(intent.provider, confirmed.status);
  intent.attempts += 1;

  if (outcome !== 'paid') {
    await recordUnsuccessful({
      intent, outcome, confirmed,
      message: `Provider reported ${confirmed.status || 'no status'}`
    });
    await recordPaymentEvent({
      intent, kind: outcome === 'cancelled' ? 'cancelled' : outcome === 'expired' ? 'expired' : 'failed',
      outcome, amount: intent.expectedAmount,
      message: `Provider reported ${confirmed.status}`, detail: confirmed.raw,
      dedupeKey: `${dedupeKey}:${outcome}`
    });
    const order = await Order.findById(intent.order);
    return {intent, order, duplicate: false, outcome, paid: false};
  }

  // ── Paid, per the provider. Now check it is OUR payment, for OUR amount ──
  const expected = money(intent.expectedAmount);
  const actual = money(confirmed.amount);
  if (Math.abs(expected - actual) >= 0.01) {
    // Underpayment or tampering: the provider says paid, but not what we asked
    // for. Never fulfil; flag for a human.
    await recordUnsuccessful({
      intent, outcome: 'failed', confirmed,
      message: `Amount mismatch: expected ${expected}, provider reported ${actual}`
    });
    await recordPaymentEvent({
      intent, kind: 'rejected', outcome: 'rejected', amount: actual,
      message: `Amount mismatch: expected ${expected}, received ${actual}`,
      detail: confirmed.raw, dedupeKey: `${dedupeKey}:amount`
    });
    await Audit.create([{
      entity: 'payment', entityId: intent._id, branch: intent.branch,
      action: 'online_payment_amount_mismatch',
      after: {expected, actual, reference: ref, provider: intent.provider},
      user: null
    }]);
    throw httpError('The paid amount does not match this order', 409);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await settleIntent({intent, confirmed, session});
    });
    await recordPaymentEvent({
      intent, kind: 'settled', outcome: 'paid', amount: actual,
      message: 'Payment confirmed by provider', detail: confirmed.raw,
      dedupeKey: `${dedupeKey}:settled`
    });
    return {
      intent, order: result.order, payment: result.payment,
      duplicate: false, outcome: 'paid', paid: true
    };
  } catch (error) {
    // The unique {order, settledAt} index firing means a concurrent callback
    // won the race. That is success, not failure — report the settled state.
    if (error?.code === 11000) {
      const fresh = await PaymentIntent.findById(intent._id);
      const order = await Order.findById(intent.order);
      return {intent: fresh, order, duplicate: true, outcome: 'paid', paid: true};
    }
    throw error;
  } finally {
    session.endSession();
  }
}

/**
 * Explicit cancellation (the guest used the gateway's back/cancel path).
 * Only ever downgrades an unsettled intent; a paid payment is never undone by
 * a browser redirect.
 */
export async function cancelPaymentIntent({reference, env = process.env}) {
  const ref = clean(reference);
  const intent = await PaymentIntent.findOne({reference: ref});
  if (!intent) throw httpError('Unknown payment reference', 404);
  if (intent.settledAt) {
    return {intent, cancelled: false, reason: 'already-paid'};
  }
  // Ask the provider anyway: a guest who pays and then hits "cancel" must not
  // lose a real payment. Only cancel if the provider agrees it is not paid.
  try {
    const check = await refreshIntentStatus({intent, env});
    if (check.paid) return {intent: check.intent, cancelled: false, reason: 'already-paid'};
  } catch {
    // Provider unreachable — fall through and mark cancelled locally. A later
    // reconciliation can still settle it if it turns out to have been paid.
  }
  await recordUnsuccessful({intent, outcome: 'cancelled', message: 'Cancelled by the customer'});
  await recordPaymentEvent({
    intent, kind: 'cancelled', outcome: 'cancelled', amount: intent.expectedAmount,
    message: 'Cancelled by the customer',
    dedupeKey: dedupeKeyFor({provider: intent.provider, reference: ref, kind: 'cancelled', payload: {at: Date.now()}})
  });
  return {intent, cancelled: true};
}

/**
 * Re-ask the provider about an intent. Used by cancellation, by the status
 * endpoint, and available for a reconciliation sweep over stale intents.
 */
export async function refreshIntentStatus({intent, env = process.env}) {
  let confirmed;
  if (intent.provider === 'esewa') {
    confirmed = await esewaStatus({transactionUuid: intent.reference, amount: intent.expectedAmount, env});
  } else {
    if (!intent.providerReference) return {intent, paid: false, outcome: intent.status};
    confirmed = await khaltiLookup({pidx: intent.providerReference, env});
  }
  const outcome = normalizeGatewayStatus(intent.provider, confirmed.status);
  return {intent, paid: outcome === 'paid', outcome, confirmed};
}

/** Whether an unsettled intent has outlived its window. */
export function isExpired(intent, now = new Date()) {
  if (!intent?.expiresAt) return false;
  if (intent.settledAt) return false;
  return new Date(intent.expiresAt).getTime() < now.getTime();
}

/** Guest-safe view. Never exposes internal ids or provider payloads. */
export function publicIntentView(intent, order) {
  return {
    reference: intent.reference,
    provider: intent.provider,
    status: intent.status,
    amount: money(intent.expectedAmount),
    paid: intent.status === 'paid',
    orderNo: order?.orderNo || null,
    orderStatus: order?.status || null,
    expiresAt: intent.expiresAt || null
  };
}
