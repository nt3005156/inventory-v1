import React, {useEffect, useState} from 'react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 0});

export default function POS({menu = [], branches = [], user, call}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [cart, setCart] = useState([]);
  const [type, setType] = useState('counter');
  const [customerId, setCustomerId] = useState('');
  const [customers, setCustomers] = useState([]);
  const [address, setAddress] = useState('');
  const [deliveryFee, setDeliveryFee] = useState('');
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
    call('/customers?branch=' + branchId).then(r => setCustomers(Array.isArray(r) ? r : [])).catch(() => setCustomers([]));
  }, [branchId]);

  const add = m => setCart(c => {
    const x = c.find(i => i._id === m._id);
    return x ? c.map(i => i._id === m._id ? {...i, qty: i.qty + 1} : i) : [...c, {...m, qty: 1}];
  });
  const VAT_RATE = 13;
  const round = n => Math.round((Number(n) || 0) * 100) / 100;
  const net = round(cart.reduce((s, x) => s + (x.vatInclusive
    ? (x.price * x.qty) / (1 + VAT_RATE / 100)
    : x.price * x.qty), 0));
  const itemVat = round(cart.reduce((s, x) => s + (x.vatInclusive
    ? x.price * x.qty - (x.price * x.qty) / (1 + VAT_RATE / 100)
    : x.price * x.qty * VAT_RATE / 100), 0));
  const serviceCharge = type === 'dine-in' ? round(net * 0.1) : 0;
  const fee = type === 'delivery' ? round(Number(deliveryFee) || 0) : 0;
  const vat = round(itemVat + serviceCharge * VAT_RATE / 100);
  const total = round(net + serviceCharge + vat + fee);
  const ready = cart.length && branchId
    && (type !== 'dine-in' || tableId)
    && (type !== 'delivery' || (customerId && address.trim()));
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
        <select value={type} onChange={e => {
          const next = e.target.value;
          setType(next);
          if (next !== 'dine-in') setTableId('');
          if (next !== 'delivery') { setAddress(''); setDeliveryFee(''); }
        }}>
          <option value="dine-in">Dine-in</option>
          <option value="takeaway">Takeaway</option>
          <option value="counter">Counter</option>
          <option value="delivery">Delivery</option>
        </select>
        {type === 'dine-in' && (
          <select value={tableId} onChange={e => setTableId(e.target.value)}>
            <option value="">Select a table (required)</option>
            {seatable.map(t => <option key={t._id} value={t._id}>{t.name} · {t.area || 'Floor'} · {t.seats} seats</option>)}
          </select>
        )}
        {type === 'delivery' && (
          <>
            <select value={customerId} onChange={e => {
              setCustomerId(e.target.value);
              const c = customers.find(x => x._id === e.target.value);
              const preset = c?.addresses?.find(a => a.default) || c?.addresses?.[0];
              if (preset?.address) setAddress(preset.address);
            }}>
              <option value="">Select a customer (required)</option>
              {customers.map(c => <option key={c._id} value={c._id}>{c.name}{c.phone ? ' · ' + c.phone : ''}</option>)}
            </select>
            <input placeholder="Delivery address (required)" value={address} onChange={e => setAddress(e.target.value)} />
            <input type="number" min="0" step="10" placeholder="Delivery fee (Rs.)" value={deliveryFee} onChange={e => setDeliveryFee(e.target.value)} />
          </>
        )}
        <select value={payment} onChange={e => setPayment(e.target.value)}>
          <option>cash</option>
          <option>eSewa</option>
          <option>Khalti</option>
          <option>card</option>
        </select>
        <div className="metric"><span>Subtotal (net)</span><b>{rs(net)}</b></div>
        {serviceCharge > 0 && <div className="metric"><span>Service charge 10%</span><b>{rs(serviceCharge)}</b></div>}
        <div className="metric"><span>VAT {VAT_RATE}%</span><b>{rs(vat)}</b></div>
        {fee > 0 && <div className="metric"><span>Delivery fee</span><b>{rs(fee)}</b></div>}
        <div className="total"><span>Total</span><b>{rs(total)}</b></div>
        {type === 'dine-in' && !tableId && <p className="warn">Select a table to complete a dine-in order.</p>}
        {type === 'delivery' && (!customerId || !address.trim()) && <p className="warn">Delivery needs a customer and an address.</p>}
        <button
          className="checkout"
          disabled={!ready}
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
                  table: type === 'dine-in' ? tableId : undefined,
                  customer: type === 'delivery' ? customerId : undefined,
                  deliveryAddress: type === 'delivery' ? address.trim() : undefined,
                  deliveryFee: type === 'delivery' && Number(deliveryFee) > 0 ? Number(deliveryFee) : undefined,
                  vatRate: VAT_RATE
                })
              });
              await call(`/orders/${order._id}/payments`, {
                method: 'POST',
                body: JSON.stringify({amount: order.total, method: payment === 'eSewa' ? 'esewa' : payment.toLowerCase()})
              });
              setCart([]);
              setTableId('');
              setCustomerId('');
              setAddress('');
              setDeliveryFee('');
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
