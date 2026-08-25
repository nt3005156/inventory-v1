/**
 * P2C — the shared commercial write path.
 *
 * Extracted into its own module for two reasons:
 *
 *   1. The SCHEDULER needs to transition subscriptions with no platform actor.
 *      Importing `subscriptions.js` for that would drag in `platformAdmin.js`
 *      and its authorization helpers, which a background job neither has nor
 *      needs — and would create an import cycle the moment the admin service
 *      wanted anything back.
 *
 *   2. Both the administrative path and the automatic path must write the SAME
 *      pair of records. Two copies of that logic is how one of them quietly
 *      stops writing history.
 *
 * SYSTEM ACTIONS ARE NOT ANONYMOUS. A sweep-driven expiry records
 * `actorRole: 'system:scheduler'` with a null actor id, rather than inventing a
 * user. "Nobody did this, the clock did" is the honest record, and it is
 * distinguishable from an operator action in both logs.
 */
import {Audit} from '../models/index.js';
import {
  SUBSCRIPTION_EVENTS, Subscription, SubscriptionEvent, canTransition
} from '../models/billing.js';
import {invalidateEntitlements} from './entitlements.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** The commercially meaningful fields, for before/after records. */
export function subscriptionSnapshot(subscription) {
  if (!subscription) return null;
  return {
    plan: subscription.plan ? String(subscription.plan) : null,
    status: subscription.status,
    trialEnd: subscription.trialEnd || null,
    currentPeriodEnd: subscription.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd)
  };
}

/**
 * Write one commercial change to BOTH logs, and drop the entitlement cache.
 *
 * The `SubscriptionEvent` is awaited and allowed to throw: it IS the commercial
 * record, and an operation whose history cannot be written has not safely
 * happened. The `Audit` row is best-effort and never throws into the caller —
 * losing a log line must not roll back a completed state change. That asymmetry
 * is deliberate and matches `recordAudit()`'s existing contract.
 */
export async function recordSubscriptionChange({
  subscription, event, before, after, reason, actor = null, restaurantId, systemActor = null
}) {
  if (!SUBSCRIPTION_EVENTS.includes(event)) {
    throw httpError(`Unknown subscription event: ${event}`, 500);
  }

  const actorRole = actor?.platformRole
    ? `platform:${actor.platformRole}`
    : (systemActor || null);

  await SubscriptionEvent.create({
    restaurant: restaurantId,
    subscription: subscription._id,
    event,
    before,
    after,
    reason: clean(reason) || undefined,
    actor: actor?._id || null,
    actorName: actor?.name || null,
    actorRole
  });

  try {
    await Audit.create({
      entity: 'subscription',
      entityId: subscription._id,
      restaurant: restaurantId,
      action: event,
      before,
      after,
      reason: clean(reason) || undefined,
      user: actor?._id || undefined,
      userName: actor?.name || undefined,
      userRole: actorRole || undefined
    });
  } catch (error) {
    console.error('Subscription audit write failed', {event, message: error?.message});
  }

  invalidateEntitlements(restaurantId);
}

/**
 * Move a subscription to a terminal state from the SCHEDULER.
 *
 * Re-reads the document and re-checks the transition rather than trusting the
 * id the sweep selected, because the sweep's query and this write are not in
 * one transaction: an operator may have cancelled or reactivated the
 * subscription in between. Losing that race must be a no-op, never an
 * overwrite of a human decision with a stale machine one.
 *
 * Idempotent: a second run finds the row already in its target state and
 * reports `changed: false` without writing a duplicate history row.
 */
export async function expireSubscription({
  subscriptionId, event, targetStatus = 'expired', reason, now = new Date()
}) {
  const subscription = await Subscription.findById(subscriptionId);
  if (!subscription) return {changed: false, reason: 'missing'};

  if (subscription.status === targetStatus) return {changed: false, reason: 'already'};

  if (!canTransition(subscription.status, targetStatus)) {
    // Somebody changed it underneath us. Leave their decision alone.
    return {changed: false, reason: `illegal_transition_${subscription.status}_${targetStatus}`};
  }

  const before = subscriptionSnapshot(subscription);
  subscription.status = targetStatus;
  subscription.endedAt = now;
  if (targetStatus === 'cancelled') {
    subscription.cancelledAt = subscription.cancelledAt || now;
    subscription.cancelAtPeriodEnd = false;
  }
  await subscription.save();

  await recordSubscriptionChange({
    subscription,
    restaurantId: subscription.restaurant,
    event,
    before,
    after: subscriptionSnapshot(subscription),
    reason,
    actor: null,
    // Named so the history distinguishes the clock from a person.
    systemActor: 'system:scheduler'
  });

  return {changed: true, status: targetStatus};
}
