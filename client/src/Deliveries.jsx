import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {connectBranchSocket} from './socket.js';

/**
 * Dispatch workspace (Phase 10).
 *
 * Two panes: the live board bucketed by state, and a rider roster showing who
 * is on shift and how loaded they are. A dispatcher's real questions are
 * "what is late?" and "who is free?", so those are the two things on screen.
 *
 * Updates arrive over the existing Socket.IO branch room via `delivery:update`.
 */

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

const clock = value => value
  ? new Date(value).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})
  : '—';

/** Minutes elapsed, for the ageing badge. */
function ageMinutes(value) {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / 60000);
}

const BUCKETS = [
  {key: 'pending', label: 'Unassigned', hint: 'Waiting for a rider'},
  {key: 'assigned', label: 'Assigned', hint: 'Rider allocated, not collected'},
  {key: 'active', label: 'On the road', hint: 'Collected or out for delivery'},
  {key: 'delayed', label: 'Delayed', hint: 'Past the promised time'},
  {key: 'completed', label: 'Delivered', hint: 'Last 24 hours'},
  {key: 'failed', label: 'Failed', hint: 'Failed or cancelled'}
];

// What a dispatcher may do next, given the current state.
const NEXT_ACTIONS = {
  assigned: [{status: 'picked_up', label: 'Mark collected'}],
  picked_up: [{status: 'out_for_delivery', label: 'Mark departed'}],
  out_for_delivery: [{status: 'delivered', label: 'Mark delivered'}]
};

export default function Deliveries({call, branches = [], user, token}) {
  const [branchId, setBranchId] = useState(branches[0]?._id || '');
  const [board, setBoard] = useState(null);
  const [riders, setRiders] = useState([]);
  const [bucket, setBucket] = useState('pending');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  // Rider account creation. Owner-only; the server enforces that too.
  const [newRider, setNewRider] = useState(null);
  const [saving, setSaving] = useState(false);

  const isSupervisor = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const [dashboard, roster] = await Promise.all([
        call(`/deliveries/dashboard?branch=${branchId}`),
        call(`/riders?branch=${branchId}&includeInactive=true`)
      ]);
      setBoard(dashboard);
      setRiders(roster);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [call, branchId]);

  useEffect(() => { load(); }, [load]);

  // Live board over the existing branch room, joined the same way Tables and
  // the KDS do it.
  const [live, setLive] = useState('offline');
  useEffect(() => {
    if (!token || !branchId) return undefined;
    const socket = connectBranchSocket(token, branchId);
    const onUpdate = payload => {
      if (payload?.branch && String(payload.branch) !== String(branchId)) return;
      load();
    };
    socket.on('connect', () => {
      setLive('live');
      socket.emit('join:branch', branchId, ack => {
        if (ack && ack.ok === false) setError(ack.message || 'Could not join the dispatch room');
      });
      load();
    });
    socket.on('disconnect', reason => {
      setLive(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });
    socket.on('connect_error', () => setLive('reconnecting'));
    socket.on('delivery:update', onUpdate);
    return () => {
      socket.emit('leave:branch', branchId);
      socket.off('delivery:update', onUpdate);
      socket.disconnect();
    };
  }, [token, branchId, load]);

  // A delayed job is time-sensitive; re-poll so the badge does not go stale
  // while nothing is being dispatched.
  useEffect(() => {
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn, message) => {
    setError('');
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const assign = (delivery, riderId) => {
    if (!riderId) return;
    setBusyId(delivery._id);
    return act(
      () => call(`/deliveries/${delivery._id}/assign`, {
        method: 'POST', body: JSON.stringify({rider: riderId})
      }),
      'Rider assigned'
    );
  };

  const advance = (delivery, status) => {
    setBusyId(delivery._id);
    return act(
      () => call(`/deliveries/${delivery._id}/status`, {
        method: 'PATCH', body: JSON.stringify({status})
      }),
      `Marked ${status.replace(/_/g, ' ')}`
    );
  };

  const failDelivery = delivery => {
    const reason = window.prompt('Why did this delivery fail?');
    if (!reason) return undefined;
    setBusyId(delivery._id);
    return act(
      () => call(`/deliveries/${delivery._id}/status`, {
        method: 'PATCH', body: JSON.stringify({status: 'failed', reason})
      }),
      'Delivery marked failed'
    );
  };

  const createRider = async () => {
    setSaving(true);
    setError('');
    try {
      await call('/accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: newRider.name.trim(),
          email: newRider.email.trim(),
          password: newRider.password,
          role: 'rider',
          branch: branchId,
          ...(newRider.phone.trim() ? {phone: newRider.phone.trim()} : {}),
          vehicle: newRider.vehicle
        })
      });
      setNewRider(null);
      setNotice('Rider account created');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const setRiderState = (riderId, patch, message) => act(
    () => call(`/riders/${riderId}`, {method: 'PATCH', body: JSON.stringify(patch)}),
    message
  );

  const visible = board?.[bucket] || [];
  const assignable = useMemo(
    () => riders.filter(r => r.rider?.active !== false && !r.atCapacity),
    [riders]
  );

  return (
    <div className="dlv">
      <header className="dlv-head">
        <div>
          <h1>Deliveries</h1>
          <p className="dlv-sub">Dispatch board and rider roster.</p>
        </div>
        <div className="dlv-headright">
          <span className={'dlv-live is-' + live}>{live}</span>
          <select value={branchId} onChange={e => setBranchId(e.target.value)}>
            {branches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
      </header>

      {error && <div className="dlv-alert dlv-error">{error}</div>}
      {notice && <div className="dlv-alert dlv-ok">{notice}</div>}

      <div className="dlv-buckets">
        {BUCKETS.map(b => (
          <button
            key={b.key}
            className={'dlv-bucket' + (bucket === b.key ? ' is-active' : '')
              + (b.key === 'delayed' && board?.counts?.delayed ? ' is-late' : '')}
            onClick={() => setBucket(b.key)}
            title={b.hint}
          >
            <span className="dlv-bucket-count">{board?.counts?.[b.key] ?? 0}</span>
            <span className="dlv-bucket-label">{b.label}</span>
          </button>
        ))}
      </div>

      <div className="dlv-body">
        <section className="dlv-list">
          {!visible.length && (
            <p className="dlv-empty">
              Nothing {BUCKETS.find(b => b.key === bucket)?.label.toLowerCase()}.
            </p>
          )}

          {visible.map(delivery => {
            const late = bucket === 'delayed'
              || (delivery.dueAt && new Date(delivery.dueAt) < new Date()
                && !['delivered', 'failed', 'cancelled'].includes(delivery.status));
            const age = ageMinutes(delivery.createdAt);
            return (
              <article key={delivery._id} className={'dlv-card' + (late ? ' is-late' : '')}>
                <div className="dlv-card-head">
                  <div>
                    <b>{delivery.order?.orderNo || 'Order'}</b>
                    <span className={`dlv-status is-${delivery.status}`}>
                      {delivery.status.replace(/_/g, ' ')}
                    </span>
                    {late && <span className="dlv-latebadge">Late</span>}
                  </div>
                  <span className="dlv-total">{rs(delivery.order?.total)}</span>
                </div>

                <p className="dlv-address">{delivery.address}</p>
                {delivery.instructions && (
                  <p className="dlv-instructions">“{delivery.instructions}”</p>
                )}

                <div className="dlv-meta">
                  <span>Placed {clock(delivery.createdAt)}{age !== null ? ` · ${age}m ago` : ''}</span>
                  {delivery.dueAt && <span>Due {clock(delivery.dueAt)}</span>}
                  <span>{delivery.rider?.name ? `Rider: ${delivery.rider.name}` : 'No rider'}</span>
                </div>

                {delivery.failureReason && (
                  <p className="dlv-failure">Failed: {delivery.failureReason}</p>
                )}

                {delivery.proofType && (
                  <p className="dlv-proof">
                    Proof: {delivery.proofType.replace(/_/g, ' ')}
                    {delivery.receivedBy ? ` · ${delivery.receivedBy}` : ''}
                    {delivery.proofNote ? ` · “${delivery.proofNote}”` : ''}
                  </p>
                )}

                <div className="dlv-cardactions">
                  {!['delivered', 'cancelled', 'failed'].includes(delivery.status) && (
                    <select
                      defaultValue=""
                      disabled={busyId === delivery._id}
                      onChange={e => assign(delivery, e.target.value)}
                    >
                      <option value="" disabled>
                        {delivery.rider ? 'Reassign to…' : 'Assign rider…'}
                      </option>
                      {assignable
                        .filter(r => String(r._id) !== String(delivery.rider?._id))
                        .map(r => (
                          <option key={r._id} value={r._id}>
                            {r.name} ({r.activeDeliveries} active)
                          </option>
                        ))}
                    </select>
                  )}

                  {(NEXT_ACTIONS[delivery.status] || []).map(action => (
                    <button
                      key={action.status}
                      className="dlv-primary"
                      disabled={busyId === delivery._id}
                      onClick={() => advance(delivery, action.status)}
                    >
                      {action.label}
                    </button>
                  ))}

                  {['assigned', 'picked_up', 'out_for_delivery'].includes(delivery.status) && (
                    <button
                      className="dlv-danger"
                      disabled={busyId === delivery._id}
                      onClick={() => failDelivery(delivery)}
                    >
                      Failed
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <aside className="dlv-riders">
          <div className="dlv-riderhead">
            <h2>Riders</h2>
            {isOwner && (
              <button onClick={() => setNewRider({
                name: '', email: '', password: '', phone: '', vehicle: 'motorcycle'
              })}>+ Add</button>
            )}
          </div>

          {newRider && (
            <div className="dlv-ridernew">
              <input placeholder="Full name" value={newRider.name}
                onChange={e => setNewRider(r => ({...r, name: e.target.value}))}/>
              <input placeholder="Email" type="email" value={newRider.email}
                onChange={e => setNewRider(r => ({...r, email: e.target.value}))}/>
              <input placeholder="Password (10+ chars, letters and numbers)" type="password"
                value={newRider.password}
                onChange={e => setNewRider(r => ({...r, password: e.target.value}))}/>
              <input placeholder="Phone" value={newRider.phone}
                onChange={e => setNewRider(r => ({...r, phone: e.target.value}))}/>
              <select value={newRider.vehicle}
                onChange={e => setNewRider(r => ({...r, vehicle: e.target.value}))}>
                {['motorcycle', 'scooter', 'bicycle', 'car', 'on-foot']
                  .map(v => <option key={v} value={v}>{v}</option>)}
              </select>
              <div className="dlv-rider-actions">
                <button onClick={() => setNewRider(null)}>Cancel</button>
                <button
                  className="dlv-primary"
                  disabled={saving || newRider.name.trim().length < 2
                    || !newRider.email.includes('@') || newRider.password.length < 10}
                  onClick={createRider}
                >
                  {saving ? 'Creating…' : 'Create rider'}
                </button>
              </div>
            </div>
          )}
          {!riders.length && <p className="dlv-empty">No riders at this branch.</p>}
          {riders.map(r => {
            const active = r.rider?.active !== false;
            return (
              <div key={r._id} className={'dlv-rider' + (active ? '' : ' is-off')}>
                <div className="dlv-rider-main">
                  <b>{r.name}</b>
                  <span className="dlv-rider-meta">
                    {r.rider?.vehicle || 'motorcycle'}
                    {r.rider?.phone ? ` · ${r.rider.phone}` : ''}
                  </span>
                </div>
                <div className="dlv-rider-state">
                  <span className={'dlv-dot' + (r.rider?.available && active ? ' is-on' : '')}/>
                  <span>
                    {!active ? 'Inactive' : r.rider?.available ? 'On shift' : 'Off shift'}
                    {' · '}{r.activeDeliveries}/{r.rider?.maxConcurrent ?? 3}
                  </span>
                  {r.atCapacity && active && <span className="dlv-full">Full</span>}
                </div>
                {isSupervisor && (
                  <div className="dlv-rider-actions">
                    <button
                      onClick={() => setRiderState(
                        r._id,
                        {available: !r.rider?.available},
                        r.rider?.available ? 'Rider off shift' : 'Rider on shift'
                      )}
                      disabled={!active}
                    >
                      {r.rider?.available ? 'End shift' : 'Start shift'}
                    </button>
                    <button
                      onClick={() => setRiderState(
                        r._id, {active: !active}, active ? 'Rider deactivated' : 'Rider reactivated'
                      )}
                    >
                      {active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </aside>
      </div>
    </div>
  );
}
