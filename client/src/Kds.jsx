import React, {useEffect, useState} from 'react';

const COLUMNS = [
  {key: 'new', title: 'New', statuses: ['pending', 'confirmed']},
  {key: 'accepted', title: 'Accepted', statuses: ['accepted']},
  {key: 'preparing', title: 'Preparing', statuses: ['preparing']},
  {key: 'ready', title: 'Ready', statuses: ['ready']}
];

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

export default function Kds({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

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
    setLoading(true);
    load();
    const tick = setInterval(load, 5000);
    return () => clearInterval(tick);
  }, [branchId]);

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

  return (
    <section className="panel kds-panel">
      <div className="title">
        <div>
          <h2>Kitchen display</h2>
          <p>Live branch queue · status changes do not deduct stock again</p>
        </div>
        <select
          className="kds-branch"
          value={branchId}
          disabled={!!locked}
          onChange={e => setBranchId(e.target.value)}
        >
          {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
        </select>
      </div>
      {error && <p className="danger">{error}</p>}
      {loading && <p>Loading kitchen queue…</p>}
      {!loading && !orders.length && !error && <p className="empty">No tickets in the kitchen queue.</p>}
      {!loading && !!orders.length && (
        <div className="kds-board">
          {COLUMNS.map(col => {
            const tickets = orders.filter(o => col.statuses.includes(o.status));
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
                    <article className={'kds-ticket kds-' + order.status} key={order._id}>
                      <div className="kds-tickethead">
                        <b>{order.orderNo || 'Order'}</b>
                        <label className="pill">{order.status}</label>
                      </div>
                      <div className="kds-meta">
                        <span>{order.type || 'counter'}</span>
                        {tableName && <span>Table {tableName}</span>}
                        <span>{clock(order.createdAt)} · {elapsed(order.createdAt)}</span>
                      </div>
                      <ul className="kds-items">
                        {(order.items || []).map((item, i) => (
                          <li key={order._id + '-' + i}>
                            <b>{item.qty}×</b> {item.name}
                            {item.notes && <small>{item.notes}</small>}
                          </li>
                        ))}
                      </ul>
                      <div className="kds-actions">
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
