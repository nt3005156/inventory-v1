import React, {useCallback, useEffect, useRef, useState} from 'react';
import {connectBranchSocket} from './socket.js';

/**
 * Rider workspace (Phase 11).
 *
 * Rendered instead of the staff shell when the logged-in user is a rider, so a
 * courier never sees — or can even navigate to — an operational screen. The
 * backend refuses them regardless; this is about not showing a phone user a
 * dead menu.
 *
 * Designed for a phone held one-handed on a bike: one job in focus, a single
 * large primary action, and everything else out of the way.
 */

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

const clock = value => value
  ? new Date(value).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})
  : null;

/** The single next step, mirroring the server's state machine exactly. */
const NEXT_STEP = {
  assigned: {status: 'picked_up', label: 'Collected from kitchen'},
  picked_up: {status: 'out_for_delivery', label: 'On my way'},
  out_for_delivery: {status: 'delivered', label: 'Delivered'}
};

const STATUS_LABEL = {
  pending: 'Waiting', assigned: 'Assigned', picked_up: 'Collected',
  out_for_delivery: 'On the way', delivered: 'Delivered',
  failed: 'Failed', cancelled: 'Cancelled'
};

export default function RiderApp({call, user, token, onLogout}) {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState('active');
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Proof-of-delivery capture. Completion is irreversible, so it goes through
  // an explicit form rather than a single tap.
  const [proofFor, setProofFor] = useState(null);
  const [proof, setProof] = useState({proofType: 'handed_to_customer', receivedBy: '', proofNote: ''});
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState('offline');
  const [expired, setExpired] = useState(false);
  const loadRef = useRef(() => {});

  const load = useCallback(async () => {
    try {
      const dashboard = await call('/deliveries/mine/dashboard');
      setData(dashboard);
      setError('');
      setExpired(false);
    } catch (e) {
      // A rider on a bike loses signal constantly; distinguish "your session
      // ended" from "the network blipped", because only one needs a re-login.
      if (/Authentication required/i.test(e.message)) setExpired(true);
      else setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [call]);

  loadRef.current = load;

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'done') return;
    call('/deliveries/mine?includeCompleted=true')
      .then(all => setHistory(all.filter(d => ['delivered', 'failed'].includes(d.status))))
      .catch(e => setError(e.message));
  }, [tab, call, notice]);

  // Realtime: riders are placed in their private rider:<id> room during the
  // handshake, so no branch is requested here.
  useEffect(() => {
    if (!token) return undefined;
    const socket = connectBranchSocket(token);
    socket.on('connect', () => { setLive('live'); loadRef.current(); });
    socket.on('disconnect', reason => {
      setLive(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });
    socket.on('connect_error', () => setLive('reconnecting'));
    socket.on('delivery:update', payload => {
      loadRef.current();
      if (payload?.reason === 'assigned') setNotice('New delivery assigned to you');
      else if (payload?.status === 'cancelled') setNotice('A delivery was cancelled');
    });
    return () => {
      socket.off('delivery:update');
      socket.disconnect();
    };
  }, [token]);

  const act = async (fn, message) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (e) {
      if (/Authentication required/i.test(e.message)) setExpired(true);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const advance = (delivery, step) => {
    // Completing a delivery is irreversible and now requires evidence, so it
    // opens the proof form instead of firing immediately.
    if (step.status === 'delivered') {
      setProof({proofType: 'handed_to_customer', receivedBy: '', proofNote: ''});
      setProofFor(delivery);
      return undefined;
    }
    return act(
      () => call(`/deliveries/${delivery._id}/status`, {
        method: 'PATCH', body: JSON.stringify({status: step.status})
      }),
      `Marked ${STATUS_LABEL[step.status].toLowerCase()}`
    );
  };

  /** The server re-validates all of this; the form only avoids a wasted trip. */
  const proofIncomplete = proof.proofType !== 'handed_to_customer'
    && !proof.receivedBy.trim() && !proof.proofNote.trim();

  const submitProof = async () => {
    if (proofIncomplete || busy) return;
    const delivery = proofFor;
    setProofFor(null);
    await act(
      () => call(`/deliveries/${delivery._id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'delivered',
          proofType: proof.proofType,
          ...(proof.receivedBy.trim() ? {receivedBy: proof.receivedBy.trim()} : {}),
          ...(proof.proofNote.trim() ? {proofNote: proof.proofNote.trim()} : {})
        })
      }),
      'Delivery completed'
    );
  };

  const reportFailure = delivery => {
    // Irreversible: a failed delivery cannot be walked back.
    if (!window.confirm('Mark this delivery as failed? This cannot be undone.')) return undefined;
    const reason = window.prompt('What went wrong? (required)');
    if (!reason || !reason.trim()) return undefined;
    return act(
      () => call(`/deliveries/${delivery._id}/status`, {
        method: 'PATCH', body: JSON.stringify({status: 'failed', reason: reason.trim()})
      }),
      'Delivery reported as failed'
    );
  };

  const toggleShift = () => act(
    () => call('/deliveries/mine/availability', {
      method: 'PATCH', body: JSON.stringify({available: !data.rider.available})
    }),
    data?.rider?.available ? 'You are now off shift' : 'You are now on shift'
  );

  if (expired) {
    return (
      <div className="rider rider-centre">
        <div className="rider-panel">
          <h2>Session expired</h2>
          <p className="rider-muted">Please sign in again to continue delivering.</p>
          <button className="rider-primary" onClick={onLogout}>Sign in</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rider rider-centre">
        <div className="rider-panel"><p className="rider-muted">Loading your deliveries…</p></div>
      </div>
    );
  }

  const active = (data?.deliveries || []).filter(d => d.status !== 'pending');
  const shown = tab === 'done' ? history : active;
  const open = shown.find(d => String(d._id) === String(openId)) || null;

  return (
    <div className="rider">
      <header className="rider-head">
        <div>
          <span className="rider-hello">{data?.rider?.name || user?.name}</span>
          <span className={'rider-live is-' + live}>
            {live === 'live' ? 'Connected' : live === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
          </span>
        </div>
        <button className="rider-signout" onClick={onLogout}>Sign out</button>
      </header>

      <section className="rider-shift">
        <div>
          <b>{data?.rider?.available ? 'On shift' : 'Off shift'}</b>
          <span className="rider-muted">
            {data?.workload ?? 0} of {data?.capacity ?? 0} jobs
            {data?.atCapacity ? ' · full' : ''}
          </span>
        </div>
        <button
          className={data?.rider?.available ? 'rider-ghost' : 'rider-primary'}
          disabled={busy || data?.rider?.active === false}
          onClick={toggleShift}
        >
          {data?.rider?.available ? 'Go off shift' : 'Go on shift'}
        </button>
      </section>

      {data?.rider?.active === false && (
        <div className="rider-alert rider-warn">
          Your rider account is inactive. Contact your manager.
        </div>
      )}
      {error && <div className="rider-alert rider-error">{error}</div>}
      {notice && (
        <div className="rider-alert rider-ok" onClick={() => setNotice('')}>{notice}</div>
      )}

      <div className="rider-stats">
        <Stat label="Delivered today" value={data?.today?.delivered ?? 0}/>
        <Stat label="Failed today" value={data?.today?.failed ?? 0}/>
        <Stat label="Active now" value={data?.workload ?? 0}/>
      </div>

      <nav className="rider-tabs">
        <button className={tab === 'active' ? 'is-active' : ''} onClick={() => setTab('active')}>
          Active ({active.length})
        </button>
        <button className={tab === 'done' ? 'is-active' : ''} onClick={() => setTab('done')}>
          Finished
        </button>
      </nav>

      {!shown.length && (
        <p className="rider-empty">
          {tab === 'active'
            ? data?.rider?.available
              ? 'No deliveries right now. You will be notified when one is assigned.'
              : 'You are off shift. Go on shift to receive deliveries.'
            : 'Nothing finished yet.'}
        </p>
      )}

      {shown.map(delivery => {
        const step = NEXT_STEP[delivery.status];
        const isOpen = String(delivery._id) === String(openId);
        return (
          <article key={delivery._id} className={'rider-job is-' + delivery.status}>
            <button
              className="rider-job-head"
              onClick={() => setOpenId(isOpen ? null : delivery._id)}
            >
              <div>
                <b>{delivery.order?.orderNo || 'Delivery'}</b>
                <span className={'rider-chip is-' + delivery.status}>
                  {STATUS_LABEL[delivery.status]}
                </span>
              </div>
              <span className="rider-amount">{rs(delivery.order?.total)}</span>
            </button>

            <p className="rider-address">{delivery.address}</p>
            {delivery.instructions && (
              <p className="rider-note">“{delivery.instructions}”</p>
            )}

            {delivery.order?.collectOnDelivery && (
              <p className="rider-collect">
                Collect {rs(delivery.order.amountDue)} on delivery
                {delivery.order.paymentMethod ? ` · ${delivery.order.paymentMethod}` : ''}
              </p>
            )}

            {isOpen && (
              <div className="rider-detail">
                <dl className="rider-dl">
                  <dt>Customer</dt><dd>{delivery.customerName || 'Not recorded'}</dd>
                  <dt>Phone</dt>
                  <dd>
                    {delivery.customerPhone
                      ? <a href={`tel:${delivery.customerPhone}`}>{delivery.customerPhone}</a>
                      : 'Not recorded'}
                  </dd>
                  <dt>Payment</dt>
                  <dd>
                    {delivery.order?.collectOnDelivery
                      ? `Collect ${rs(delivery.order.amountDue)}`
                      : 'Already paid'}
                  </dd>
                  {delivery.estimatedMinutes > 0 && (
                    <>
                      <dt>Target</dt><dd>{delivery.estimatedMinutes} minutes</dd>
                    </>
                  )}
                  {delivery.dueAt && (<><dt>Due by</dt><dd>{clock(delivery.dueAt)}</dd></>)}
                  {delivery.assignedAt && (
                    <><dt>Assigned</dt><dd>{clock(delivery.assignedAt)}</dd></>
                  )}
                  {delivery.pickedUpAt && (
                    <><dt>Collected</dt><dd>{clock(delivery.pickedUpAt)}</dd></>
                  )}
                  {delivery.dispatchedAt && (
                    <><dt>Departed</dt><dd>{clock(delivery.dispatchedAt)}</dd></>
                  )}
                  {delivery.deliveredAt && (
                    <><dt>Delivered</dt><dd>{clock(delivery.deliveredAt)}</dd></>
                  )}
                </dl>

                {!!delivery.order?.items?.length && (
                  <>
                    <h4>In the bag</h4>
                    <ul className="rider-items">
                      {delivery.order.items.map((item, i) => (
                        <li key={i}>{item.qty} × {item.name}</li>
                      ))}
                    </ul>
                  </>
                )}

                {delivery.failureReason && (
                  <p className="rider-failure">Failed: {delivery.failureReason}</p>
                )}

                {delivery.proofType && (
                  <>
                    <h4>Proof of delivery</h4>
                    <dl className="rider-dl">
                      <dt>Handover</dt>
                      <dd>{delivery.proofType.replace(/_/g, ' ')}</dd>
                      {delivery.receivedBy && (<><dt>Received by</dt><dd>{delivery.receivedBy}</dd></>)}
                      {delivery.proofNote && (<><dt>Note</dt><dd>{delivery.proofNote}</dd></>)}
                    </dl>
                  </>
                )}
              </div>
            )}

            {(step || ['assigned', 'picked_up', 'out_for_delivery'].includes(delivery.status)) && (
              <div className="rider-actions">
                {step && (
                  <button
                    className="rider-primary rider-big"
                    disabled={busy}
                    onClick={() => advance(delivery, step)}
                  >
                    {step.label}
                  </button>
                )}
                <button
                  className="rider-ghost"
                  disabled={busy}
                  onClick={() => reportFailure(delivery)}
                >
                  Report a problem
                </button>
              </div>
            )}
          </article>
        );
      })}

      {proofFor && (
        <div className="rider-modal" role="dialog" aria-modal="true">
          <div className="rider-modalbox">
            <h3>Confirm delivery</h3>
            <p className="rider-muted">
              {proofFor.order?.orderNo} · {proofFor.address}
            </p>
            {proofFor.order?.collectOnDelivery && (
              <p className="rider-collect">
                Collect {rs(proofFor.order.amountDue)} before completing
              </p>
            )}

            <label>How was it handed over?
              <select
                value={proof.proofType}
                onChange={e => setProof(p => ({...p, proofType: e.target.value}))}
              >
                <option value="handed_to_customer">Handed to the customer</option>
                <option value="left_with_neighbour">Left with a neighbour</option>
                <option value="reception">Left at reception</option>
                <option value="left_at_door">Left at the door</option>
                <option value="other">Other</option>
              </select>
            </label>

            {proof.proofType !== 'handed_to_customer' && (
              <label>Who received it?
                <input
                  value={proof.receivedBy}
                  placeholder="Name, or where it was left"
                  onChange={e => setProof(p => ({...p, receivedBy: e.target.value}))}
                />
              </label>
            )}

            <label>Note (optional)
              <textarea
                rows={2}
                value={proof.proofNote}
                onChange={e => setProof(p => ({...p, proofNote: e.target.value}))}
              />
            </label>

            {proofIncomplete && (
              <p className="rider-hint">
                Record who received it, or add a note, before completing.
              </p>
            )}

            <div className="rider-modalactions">
              <button className="rider-ghost" onClick={() => setProofFor(null)}>Cancel</button>
              <button
                className="rider-primary"
                disabled={proofIncomplete || busy}
                onClick={submitProof}
              >
                {busy ? 'Saving…' : 'Confirm delivered'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({label, value}) {
  return (
    <div className="rider-stat">
      <span className="rider-stat-value">{value}</span>
      <span className="rider-stat-label">{label}</span>
    </div>
  );
}
