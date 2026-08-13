import React, {useEffect, useRef, useState} from 'react';
import {connectBranchSocket} from './socket.js';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 0});

const ACTIONS = {
  available: [
    {status: 'occupied', label: 'Seat'},
    {status: 'reserved', label: 'Reserve'},
    {status: 'disabled', label: 'Out of service', manager: true}
  ],
  reserved: [
    {status: 'occupied', label: 'Seat'},
    {status: 'available', label: 'Release'}
  ],
  occupied: [
    {status: 'cleaning', label: 'Mark cleaning'},
    {status: 'available', label: 'Free table'}
  ],
  cleaning: [
    {status: 'available', label: 'Ready'},
    {status: 'disabled', label: 'Out of service', manager: true}
  ],
  disabled: [
    {status: 'available', label: 'Enable', manager: true}
  ]
};

export default function Tables({call, branches = [], user, token}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({name: '', area: 'Main Hall', seats: 4});
  const [ops, setOps] = useState({});
  const [live, setLive] = useState('connecting');
  const authToken = token || (typeof localStorage !== 'undefined' ? localStorage.token : '');
  const canManage = ['owner', 'manager'].includes(user?.role);
  const canOperate = ['owner', 'manager', 'staff'].includes(user?.role);

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const load = () => {
    if (!branchId) {
      setLoading(false);
      setRows([]);
      return;
    }
    setLoading(true);
    setError('');
    call('/tables?branch=' + encodeURIComponent(branchId))
      .then(data => setRows(Array.isArray(data) ? data : []))
      .catch(e => setError(e.message || 'Could not load tables'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [branchId]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (live === 'live') return;
    const tick = setInterval(() => loadRef.current(), 5000);
    return () => clearInterval(tick);
  }, [branchId, live]);

  useEffect(() => {
    if (!authToken || !branchId) return undefined;
    const socket = connectBranchSocket(authToken, branchId);
    const onUpdate = payload => {
      if (payload?.branch && String(payload.branch) !== String(branchId)) return;
      loadRef.current();
    };
    socket.on('connect', () => {
      setLive('live');
      socket.emit('join:branch', branchId, ack => {
        if (ack && ack.ok === false) setError(ack.message || 'Could not join floor room');
      });
      loadRef.current();
    });
    socket.on('disconnect', reason => {
      setLive(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });
    socket.on('connect_error', () => setLive('reconnecting'));
    socket.on('table:update', onUpdate);
    return () => {
      socket.emit('leave:branch', branchId);
      socket.off('table:update', onUpdate);
      socket.disconnect();
    };
  }, [authToken, branchId]);

  const setStatus = async (table, status) => {
    setBusy(table._id + status);
    setError('');
    try {
      await call('/tables/' + table._id + '/status', {method: 'PATCH', body: JSON.stringify({status})});
      load();
    } catch (e) {
      setError(e.message || 'Table update failed');
    } finally {
      setBusy('');
    }
  };

  const checks = table => {
    if (Array.isArray(table.currentOrders) && table.currentOrders.length) return table.currentOrders;
    return table.currentOrder ? [table.currentOrder] : [];
  };

  const pay = async (order, amount) => {
    const value = Number(amount);
    if (!(value > 0)) return;
    setBusy(order._id + 'pay');
    setError('');
    try {
      await call('/orders/' + order._id + '/payments', {method: 'POST', body: JSON.stringify({amount: value, method: 'cash'})});
      load();
    } catch (e) {
      setError(e.message || 'Payment failed');
    } finally {
      setBusy('');
    }
  };

  const split = async order => {
    const picks = (order.items || []).map(item => ({itemId: item._id, qty: Number(ops[order._id]?.split?.[item._id] || 0)})).filter(x => x.qty > 0);
    if (!picks.length) return;
    setBusy(order._id + 'split');
    setError('');
    try {
      await call('/orders/' + order._id + '/split', {method: 'POST', body: JSON.stringify({items: picks})});
      setOps(x => ({...x, [order._id]: {}}));
      load();
    } catch (e) {
      setError(e.message || 'Split failed');
    } finally {
      setBusy('');
    }
  };

  const move = async table => {
    const toTable = ops[table._id]?.moveTo;
    if (!toTable) return;
    setBusy(table._id + 'move');
    setError('');
    try {
      await call('/tables/' + table._id + '/move', {method: 'POST', body: JSON.stringify({toTable})});
      setOps(x => ({...x, [table._id]: {}}));
      load();
    } catch (e) {
      setError(e.message || 'Move failed');
    } finally {
      setBusy('');
    }
  };

  const merge = async table => {
    const intoTable = ops[table._id]?.mergeTo;
    if (!intoTable) return;
    setBusy(table._id + 'merge');
    setError('');
    try {
      await call('/tables/' + table._id + '/merge', {method: 'POST', body: JSON.stringify({intoTable})});
      setOps(x => ({...x, [table._id]: {}}));
      load();
    } catch (e) {
      setError(e.message || 'Merge failed');
    } finally {
      setBusy('');
    }
  };

  const create = async e => {
    e.preventDefault();
    if (!branchId) return;
    setError('');
    try {
      await call('/tables', {method: 'POST', body: JSON.stringify({branch: branchId, name: form.name, area: form.area, seats: Number(form.seats)})});
      setForm({name: '', area: form.area, seats: 4});
      load();
    } catch (e) {
      setError(e.message || 'Could not create table');
    }
  };

  if (!visibleBranches.length) {
    return <section className="panel"><h2>Tables</h2><p className="empty">No branch is configured. Run the demo seed, then refresh.</p></section>;
  }

  const areas = [...new Set(rows.map(t => t.area || 'Floor'))];

  return (
    <section className="panel">
      <div className="title">
        <div>
          <h2>Floor tables</h2>
          <p>Live branch seating · occupy, pay, move and merge update every host on this floor</p>
        </div>
        <div className="kds-toolbar">
          <span className={'kds-live ' + (live === 'live' ? 'on' : live === 'reconnecting' || live === 'connecting' ? 'wait' : 'off')}>{live === 'live' ? 'Live' : live === 'reconnecting' ? 'Reconnecting' : live === 'offline' ? 'Offline' : 'Connecting'}</span>
        <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
          {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
        </select>
        </div>
      </div>
      {error && <p className="danger">{error}</p>}
      {canManage && (
        <form className="purchaseform" onSubmit={create}>
          <input required value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="Table name"/>
          <input value={form.area} onChange={e => setForm({...form, area: e.target.value})} placeholder="Area"/>
          <input type="number" min="1" value={form.seats} onChange={e => setForm({...form, seats: e.target.value})} placeholder="Seats"/>
          <button>Add table</button>
        </form>
      )}
      {loading && <p>Loading tables…</p>}
      {!loading && !rows.length && !error && <p className="empty">No tables at this branch.</p>}
      {areas.map(area => (
        <div key={area}>
          <h3>{area}</h3>
          <div className="table-floor">
            {rows.filter(t => (t.area || 'Floor') === area).map(table => {
              const orders = checks(table);
              const order = orders[0];
              return (
                <article key={table._id} className={'table-card table-' + table.status + (table.active === false ? ' table-inactive' : '')}>
                  <div className="table-cardhead">
                    <b>{table.name}</b>
                    <label className={'pill tablepill-' + table.status}>{table.status === 'disabled' ? 'out of service' : table.status}</label>
                  </div>
                  <p className="table-meta">{table.seats || 0} seats{orders.length ? ` · ${orders.length} check${orders.length > 1 ? 's' : ''}` : ''}</p>
                  {orders.map(check => (
                    <div className="table-order" key={check._id}>
                      <span>{check.orderNo} · {check.status}</span>
                      <strong>Due {rs(check.dueAmount)} / {rs(check.total)}</strong>
                      {(check.items || []).map(item => (
                        <small key={item._id || item.name}>{item.qty}× {item.name} · {rs((item.unitPrice || 0) * item.qty)}</small>
                      ))}
                      {canOperate && check.dueAmount > 0 && (
                        <div className="table-ops">
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            value={ops[check._id]?.payAmount ?? check.dueAmount}
                            onChange={e => setOps(x => ({...x, [check._id]: {...x[check._id], payAmount: e.target.value}}))}
                          />
                          <button className="kds-go" disabled={!!busy} onClick={() => pay(check, ops[check._id]?.payAmount ?? check.dueAmount)}>
                            {busy === check._id + 'pay' ? 'Updating…' : 'Pay'}
                          </button>
                        </div>
                      )}
                      {canOperate && ((check.items || []).length > 1 || (check.items || []).some(i => i.qty > 1)) ? (
                        <div className="table-split">
                          {(check.items || []).map(item => (
                            <label key={item._id}>
                              Split {item.name}
                              <input
                                type="number"
                                min="0"
                                max={item.qty}
                                step="1"
                                value={ops[check._id]?.split?.[item._id] || 0}
                                onChange={e => setOps(x => ({...x, [check._id]: {...x[check._id], split: {...(x[check._id]?.split || {}), [item._id]: e.target.value}}}))}
                              />
                            </label>
                          ))}
                          <button className="kds-go" disabled={!!busy} onClick={() => split(check)}>
                            {busy === check._id + 'split' ? 'Updating…' : 'Split check'}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  <div className="kds-actions">
                    {canOperate && (ACTIONS[table.status] || []).filter(a => !a.manager || canManage).map(a => (
                      <button
                        key={a.status}
                        className={a.status === 'disabled' ? 'kds-cancel' : 'kds-go'}
                        disabled={!!busy || !!orders.length}
                        onClick={() => setStatus(table, a.status)}
                      >
                        {busy === table._id + a.status ? 'Updating…' : a.label}
                      </button>
                    ))}
                  </div>
                  {canOperate && order && (
                    <div className="table-ops">
                      <select
                        value={ops[table._id]?.moveTo || ''}
                        onChange={e => setOps(x => ({...x, [table._id]: {...x[table._id], moveTo: e.target.value}}))}
                      >
                        <option value="">Move to…</option>
                        {rows.filter(t => t._id !== table._id && t.active !== false && (['available', 'reserved'].includes(t.status) || (t.status === 'occupied' && !checks(t).length))).map(t => (
                          <option key={t._id} value={t._id}>{t.name}</option>
                        ))}
                      </select>
                      <button className="kds-go" disabled={!!busy || !ops[table._id]?.moveTo} onClick={() => move(table)}>
                        {busy === table._id + 'move' ? 'Updating…' : 'Move'}
                      </button>
                      <select
                        value={ops[table._id]?.mergeTo || ''}
                        onChange={e => setOps(x => ({...x, [table._id]: {...x[table._id], mergeTo: e.target.value}}))}
                      >
                        <option value="">Merge into…</option>
                        {rows.filter(t => t._id !== table._id && checks(t).length).map(t => (
                          <option key={t._id} value={t._id}>{t.name} · {checks(t)[0]?.orderNo}</option>
                        ))}
                      </select>
                      <button className="kds-go" disabled={!!busy || !ops[table._id]?.mergeTo} onClick={() => merge(table)}>
                        {busy === table._id + 'merge' ? 'Updating…' : 'Merge'}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
