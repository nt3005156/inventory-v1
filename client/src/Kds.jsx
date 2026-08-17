import React, {useEffect, useRef, useState} from 'react';
import {connectBranchSocket} from './socket.js';

const COLUMNS = [
  {key: 'new', title: 'New', statuses: ['pending', 'confirmed']},
  {key: 'preparing', title: 'Preparing', statuses: ['accepted', 'preparing']},
  {key: 'ready', title: 'Ready', statuses: ['ready']}
];

const TARGET_BY_TYPE = {'dine-in': 15, counter: 12, takeaway: 12, delivery: 10};

// Mirrors the server's escalation so the board ages between polls.
function targetFor(order) {
  const itemMax = (order.items || []).reduce((m, i) => Math.max(m, Number(i.prepMinutes || 0)), 0);
  return itemMax > 0 ? itemMax : (TARGET_BY_TYPE[order.type] ?? 15);
}

function ageOf(order, nowMs) {
  return Math.max(0, Math.floor((nowMs - new Date(order.createdAt).getTime()) / 60000));
}

function priorityOf(order, nowMs) {
  if (order.priority === 'rush') return 'overdue';
  const target = targetFor(order);
  const age = ageOf(order, nowMs);
  if (age >= target * 1.5) return 'overdue';
  if (age >= target) return 'late';
  if (age >= target * 0.75) return 'due';
  return 'normal';
}

const RANK = {overdue: 0, late: 1, due: 2, normal: 3};

function stationsOf(order) {
  return [...new Set((order.items || []).map(i => String(i.station || 'kitchen').toLowerCase()))].sort();
}

const QUEUE = ['pending', 'confirmed', 'accepted', 'preparing', 'ready'];

function nextAction(status) {
  if (status === 'pending' || status === 'confirmed') return {next: 'accepted', label: 'Accept'};
  if (status === 'accepted') return {next: 'preparing', label: 'Start preparing'};
  if (status === 'preparing') return {next: 'ready', label: 'Mark ready'};
  if (status === 'ready') return {next: 'completed', label: 'Complete'};
  return null;
}

function canCancelStatus(status) {
  return ['pending', 'confirmed', 'accepted', 'preparing'].includes(status);
}

function elapsed(from) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function clock(from) {
  try {
    return new Date(from).toLocaleTimeString('en-NP', {hour: '2-digit', minute: '2-digit'});
  } catch {
    return '';
  }
}

function sameBranch(order, branchId) {
  const id = order?.branch?._id || order?.branch;
  return id && String(id) === String(branchId);
}

function upsertOrder(list, order) {
  const next = list.filter(o => String(o._id) !== String(order._id));
  next.push(order);
  next.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return next;
}

export default function Kds({call, branches = [], user, token}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [live, setLive] = useState('connecting');
  const [station, setStation] = useState('');
  const [stations, setStations] = useState([]);
  const [nowMs, setNowMs] = useState(Date.now());
  const authToken = token || (typeof localStorage !== 'undefined' ? localStorage.token : '');

  const canAdvance = ['owner', 'manager', 'staff'].includes(user?.role);
  const canCancel = ['owner', 'manager'].includes(user?.role);

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const load = async () => {
    if (!branchId) {
      setLoading(false);
      setOrders([]);
      return;
    }
    setError('');
    try {
      const rows = await call('/kitchen/orders?branch=' + encodeURIComponent(branchId));
      setOrders(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(e.message || 'Could not load kitchen queue');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    call('/kitchen/stations')
      .then(r => setStations(r?.stations || []))
      .catch(() => setStations([]));
  }, []);

  // Age and priority are time-derived, so re-render every 30s even when idle.
  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(tick);
  }, []);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setLoading(true);
    load();
  }, [branchId]);

  useEffect(() => {
    if (live === 'live') return;
    const tick = setInterval(() => loadRef.current(), 5000);
    return () => clearInterval(tick);
  }, [branchId, live]);

  useEffect(() => {
    if (!authToken || !branchId) return undefined;
    const socket = connectBranchSocket(authToken, branchId);

    const applyNew = payload => {
      const order = payload?.order;
      if (!sameBranch(order, branchId) || !QUEUE.includes(order.status)) return;
      setOrders(curr => upsertOrder(curr, order));
    };
    const applyStatus = payload => {
      const order = payload?.order;
      if (!sameBranch(order, branchId)) return;
      setOrders(curr => QUEUE.includes(order.status) ? upsertOrder(curr, order) : curr.filter(o => String(o._id) !== String(order._id)));
    };

    socket.on('connect', () => {
      setLive('live');
      socket.emit('join:branch', branchId, ack => {
        if (ack && ack.ok === false) setError(ack.message || 'Could not join kitchen room');
      });
      loadRef.current();
    });
    socket.on('disconnect', reason => {
      setLive(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });
    socket.on('connect_error', () => setLive('reconnecting'));
    socket.on('kitchen:new-order', applyNew);
    socket.on('kitchen:status', applyStatus);
    // The server evicts sockets whose branch assignment was revoked mid-session.
    socket.on('branch:revoked', payload => {
      if (String(payload?.branch) !== String(branchId)) return;
      setOrders([]);
      setError('Your access to this branch was changed. Sign in again to continue.');
      setLive('offline');
    });

    return () => {
      socket.off('kitchen:new-order', applyNew);
      socket.off('kitchen:status', applyStatus);
      socket.disconnect();
    };
  }, [authToken, branchId]);

  const act = async (order, status) => {
    setBusy(order._id + status);
    setError('');
    try {
      await call('/orders/' + order._id + '/status', {method: 'PATCH', body: JSON.stringify({status})});
      await load();
    } catch (e) {
      setError(e.message || 'Kitchen update failed');
    } finally {
      setBusy('');
    }
  };

  if (!visibleBranches.length) {
    return (
      <section className="panel">
        <h2>Kitchen display</h2>
        <p className="empty">No branch is configured. Run the demo seed, then refresh.</p>
      </section>
    );
  }

  const liveLabel = live === 'live' ? 'Live' : live === 'reconnecting' ? 'Reconnecting' : live === 'offline' ? 'Offline' : 'Connecting';

  // Station filter and priority ordering are applied client-side so the live
  // socket feed stays authoritative and the board never waits on a refetch.
  const visible = orders
    .filter(o => !station || stationsOf(o).includes(station))
    .map(o => ({...o, _priority: priorityOf(o, nowMs), _age: ageOf(o, nowMs)}))
    .sort((a, b) => {
      const aRush = a.priority === 'rush', bRush = b.priority === 'rush';
      if (aRush !== bRush) return aRush ? -1 : 1;
      const rank = RANK[a._priority] - RANK[b._priority];
      if (rank !== 0) return rank;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

  return (
    <section className="panel kds-panel">
      <div className="title">
        <div>
          <h2>Kitchen display</h2>
          <p>Live branch queue · status changes do not deduct stock again</p>
        </div>
        <div className="kds-toolbar">
          <span className={'kds-live ' + (live === 'live' ? 'on' : live === 'reconnecting' || live === 'connecting' ? 'wait' : 'off')}>{liveLabel}</span>
          <select
            className="kds-branch"
            value={station}
            onChange={e => setStation(e.target.value)}
            title="Station filter"
          >
            <option value="">All stations</option>
            {stations.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
          <select
            className="kds-branch"
            value={branchId}
            disabled={!!locked}
            onChange={e => setBranchId(e.target.value)}
          >
            {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
      </div>
      {error && <p className="danger">{error}</p>}
      {loading && <p>Loading kitchen queue…</p>}
      {!loading && !visible.length && !error && (
        <p className="empty">{station ? `No tickets for the ${station} station.` : 'No tickets in the kitchen queue.'}</p>
      )}
      {!loading && !!visible.length && (
        <div className="kds-board">
          {COLUMNS.map(col => {
            const tickets = visible.filter(o => col.statuses.includes(o.status));
            return (
              <div className="kds-col" key={col.key}>
                <header className="kds-colhead">
                  <strong>{col.title}</strong>
                  <span>{tickets.length}</span>
                </header>
                {tickets.map(order => {
                  const action = nextAction(order.status);
                  const tableName = order.table?.name;
                  return (
                    <article className={'kds-ticket kds-' + order.status + ' kds-p-' + order._priority} key={order._id}>
                      <div className="kds-tickethead">
                        <b>{order.orderNo || 'Order'}</b>
                        <label className={'pill kds-prio kds-prio-' + order._priority}>
                          {order.priority === 'rush' ? 'RUSH' : order._priority}
                        </label>
                      </div>
                      <div className="kds-meta">
                        <span>{order.type || 'counter'}</span>
                        {tableName && <span>Table {tableName}</span>}
                        <span className={order._age >= targetFor(order) ? 'kds-agelate' : ''}>
                          {order._age}m / {targetFor(order)}m
                        </span>
                        <span>{clock(order.createdAt)}</span>
                      </div>
                      {!station && stationsOf(order).length > 1 && (
                        <div className="kds-stations">
                          {stationsOf(order).map(st => <span key={st}>{st}</span>)}
                        </div>
                      )}
                      <ul className="kds-items">
                        {(order.items || [])
                          .filter(item => !station || String(item.station || 'kitchen').toLowerCase() === station)
                          .map((item, i) => (
                          <li key={order._id + '-' + i}>
                            <b>{item.qty}×</b> {item.name}
                            {item.station && !station && <em className="kds-st">{item.station}</em>}
                            {item.notes && <small>{item.notes}</small>}
                            {item.specialInstructions && <small>“{item.specialInstructions}”</small>}
                          </li>
                        ))}
                      </ul>
                      <div className="kds-actions">
                        {canAdvance && (
                          <button
                            className={'kds-rush' + (order.priority === 'rush' ? ' on' : '')}
                            disabled={!!busy}
                            title="Toggle rush priority"
                            onClick={async () => {
                              setBusy(order._id + 'rush');
                              try {
                                await call(`/orders/${order._id}/priority`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({priority: order.priority === 'rush' ? 'normal' : 'rush'})
                                });
                                await loadRef.current();
                              } catch (e) { setError(e.message); } finally { setBusy(''); }
                            }}
                          >{order.priority === 'rush' ? 'Un-rush' : 'Rush'}</button>
                        )}
                        {canAdvance && action && (
                          <button
                            className="kds-go"
                            disabled={!!busy}
                            onClick={() => act(order, action.next)}
                          >
                            {busy === order._id + action.next ? 'Updating…' : action.label}
                          </button>
                        )}
                        {canCancel && canCancelStatus(order.status) && (
                          <button
                            className="kds-cancel"
                            disabled={!!busy}
                            onClick={() => act(order, 'cancelled')}
                          >
                            {busy === order._id + 'cancelled' ? 'Updating…' : 'Cancel'}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
