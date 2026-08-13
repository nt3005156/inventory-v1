import React, {useEffect, useState} from 'react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 0});

export default function POS({menu = [], branches = [], user, call}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [cart, setCart] = useState([]);
  const [type, setType] = useState('dine-in');
  const [payment, setPayment] = useState('cash');
  const [tableId, setTableId] = useState('');
  const [tables, setTables] = useState([]);
  const [posError, setPosError] = useState('');

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  useEffect(() => {
    if (!branchId) return;
    setTableId('');
    setPosError('');
    call('/tables?branch=' + branchId).then(setTables).catch(e => setPosError(e.message));
  }, [branchId]);

  const add = m => setCart(c => {
    const x = c.find(i => i._id === m._id);
    return x ? c.map(i => i._id === m._id ? {...i, qty: i.qty + 1} : i) : [...c, {...m, qty: 1}];
  });
  const total = cart.reduce((s, x) => s + x.price * x.qty, 0);
  const seatable = tables.filter(t => t.active !== false && ['available', 'reserved'].includes(t.status));

  if (!visibleBranches.length) {
    return <section className="panel"><h2>Point of sale</h2><p className="empty">No branch is configured. Run the demo seed, then refresh.</p></section>;
  }

  return (
    <div className="pos">
      <section className="panel">
        <div className="title">
          <div>
            <h2>Menu · tap to add</h2>
            <p>Completed orders deduct recipe stock at this branch.</p>
          </div>
          <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
            {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        <div className="menu">
          {menu.map(m => (
            <button key={m._id} onClick={() => add(m)}>
              <small>{m.category}</small>
              <b>{m.name}</b>
              <strong>{rs(m.price)}</strong>
            </button>
          ))}
        </div>
      </section>
      <section className="panel order">
        <h2>Current order</h2>
        {cart.length ? cart.map(x => (
          <div className="cart" key={x._id}>
            <b>{x.name}</b>
            <span>
              <button onClick={() => setCart(c => c.map(y => y._id === x._id ? {...y, qty: Math.max(1, y.qty - 1)} : y))}>−</button>
              {' '}{x.qty}{' '}
              <button onClick={() => add(x)}>+</button>
              {' · '}{rs(x.price * x.qty)}
            </span>
          </div>
        )) : <p className="empty">Add menu items to begin.</p>}
        {posError && <p className="danger">{posError}</p>}
        <select value={type} onChange={e => { setType(e.target.value); if (e.target.value !== 'dine-in') setTableId(''); }}>
          <option value="dine-in">Dine-in</option>
          <option value="takeaway">Takeaway</option>
          <option value="delivery">Delivery</option>
        </select>
        {type === 'dine-in' && (
          <select value={tableId} onChange={e => setTableId(e.target.value)}>
            <option value="">No table</option>
            {seatable.map(t => <option key={t._id} value={t._id}>{t.name} · {t.area || 'Floor'} · {t.seats} seats</option>)}
          </select>
        )}
        <select value={payment} onChange={e => setPayment(e.target.value)}>
          <option>cash</option>
          <option>eSewa</option>
          <option>Khalti</option>
          <option>card</option>
        </select>
        <div className="total"><span>Total</span><b>{rs(total)}</b></div>
        <button
          className="checkout"
          disabled={!cart.length || !branchId}
          onClick={async () => {
            if (!branchId) return;
            setPosError('');
            try {
              const order = await call('/orders', {
                method: 'POST',
                body: JSON.stringify({
                  branch: branchId,
                  items: cart.map(x => ({menuItem: x._id, qty: x.qty})),
                  type,
                  table: tableId || undefined,
                  vatRate: 13
                })
              });
              await call(`/orders/${order._id}/payments`, {
                method: 'POST',
                body: JSON.stringify({amount: order.total, method: payment === 'eSewa' ? 'esewa' : payment.toLowerCase()})
              });
              setCart([]);
              setTableId('');
              call('/tables?branch=' + branchId).then(setTables);
            } catch (e) {
              setPosError(e.message);
            }
          }}
        >Complete order</button>
      </section>
    </div>
  );
}
