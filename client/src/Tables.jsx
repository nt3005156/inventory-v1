import React, {useEffect, useState} from 'react';

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

export default function Tables({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({name: '', area: 'Main Hall', seats: 4});
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

  const pay = async table => {
    const order = table.currentOrder;
    if (!order?.dueAmount) return;
    setBusy(table._id + 'pay');
    setError('');
    try {
      await call('/orders/' + order._id + '/payments', {method: 'POST', body: JSON.stringify({amount: order.dueAmount, method: 'cash'})});
      load();
    } catch (e) {
      setError(e.message || 'Payment failed');
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
          <p>Branch seating · linked to open dine-in orders · NPR checkout stays on the order</p>
        </div>
        <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
          {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
        </select>
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
              const order = table.currentOrder;
              return (
                <article key={table._id} className={'table-card table-' + table.status + (table.active === false ? ' table-inactive' : '')}>
                  <div className="table-cardhead">
                    <b>{table.name}</b>
                    <label className={'pill tablepill-' + table.status}>{table.status === 'disabled' ? 'out of service' : table.status}</label>
                  </div>
                  <p className="table-meta">{table.seats || 0} seats{order ? ` · ${order.orderNo}` : ''}</p>
                  {order && (
                    <div className="table-order">
                      <span>{order.type} · {order.status}</span>
                      <strong>{rs(order.dueAmount > 0 ? order.dueAmount : order.total)}</strong>
                      {(order.items || []).slice(0, 3).map((item, i) => <small key={i}>{item.qty}× {item.name}</small>)}
                    </div>
                  )}
                  <div className="kds-actions">
                    {canOperate && (ACTIONS[table.status] || []).filter(a => !a.manager || canManage).map(a => (
                      <button
                        key={a.status}
                        className={a.status === 'disabled' ? 'kds-cancel' : 'kds-go'}
                        disabled={!!busy || !!order}
                        onClick={() => setStatus(table, a.status)}
                      >
                        {busy === table._id + a.status ? 'Updating…' : a.label}
                      </button>
                    ))}
                    {canOperate && order?.dueAmount > 0 && (
                      <button className="kds-go" disabled={!!busy} onClick={() => pay(table)}>
                        {busy === table._id + 'pay' ? 'Updating…' : 'Take payment'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
