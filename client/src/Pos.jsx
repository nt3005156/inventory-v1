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

  const [configuring, setConfiguring] = useState(null);
  const [picks, setPicks] = useState({});
  const [instructions, setInstructions] = useState('');

  const sigOf = (id, mods, note) =>
    id + '|' + mods.map(m => m.group + ':' + m.option).sort().join(',') + '|' + (note || '');

  const priceWith = (item, mods) => {
    let price = Number(item.price || 0);
    let delta = 0;
    for (const pick of mods) {
      const group = (item.modifierGroups || []).find(g => g.key === pick.group);
      const option = (group?.options || []).find(o => o.key === pick.option);
      if (!option) continue;
      if (group.kind === 'variant' && option.priceOverride !== null && option.priceOverride !== undefined) {
        price = Number(option.priceOverride);
      } else {
        delta += Number(option.priceDelta || 0);
      }
    }
    return Math.round((price + delta) * 100) / 100;
  };

  const pushLine = (item, mods, note) => {
    const sig = sigOf(item._id, mods, note);
    setCart(c => {
      const found = c.find(i => i.sig === sig);
      if (found) return c.map(i => i.sig === sig ? {...i, qty: i.qty + 1} : i);
      return [...c, {
        sig,
        _id: item._id,
        name: item.name,
        vatInclusive: item.vatInclusive,
        price: priceWith(item, mods),
        basePrice: Number(item.price || 0),
        modifiers: mods,
        specialInstructions: note || '',
        modifierNames: mods.map(pick => {
          const group = (item.modifierGroups || []).find(g => g.key === pick.group);
          return (group?.options || []).find(o => o.key === pick.option)?.name || pick.option;
        }),
        qty: 1
      }];
    });
  };

  // Items with choices open a chooser; plain items drop straight into the cart.
  const add = m => {
    if ((m.modifierGroups || []).length) {
      const preset = {};
      for (const group of m.modifierGroups) {
        const fallback = (group.options || []).find(o => o.isDefault);
        if (group.selection === 'single' && fallback) preset[group.key] = [fallback.key];
      }
      setPicks(preset);
      setInstructions('');
      setConfiguring(m);
      return;
    }
    pushLine(m, [], '');
  };

  const bump = (line, by) => setCart(c => c
    .map(i => i.sig === line.sig ? {...i, qty: Math.max(0, i.qty + by)} : i)
    .filter(i => i.qty > 0));
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
      {configuring && (() => {
        const item = configuring;
        const chosen = Object.entries(picks).flatMap(([g, keys]) => keys.map(k => ({group: g, option: k})));
        const missing = (item.modifierGroups || []).filter(g => g.required && !(picks[g.key] || []).length);
        const toggle = (group, option) => setPicks(p => {
          const current = p[group.key] || [];
          if (group.selection === 'single') return {...p, [group.key]: current[0] === option.key ? [] : [option.key]};
          const max = Number(group.maxSelect || 0);
          if (current.includes(option.key)) return {...p, [group.key]: current.filter(k => k !== option.key)};
          if (max > 0 && current.length >= max) return p;
          return {...p, [group.key]: [...current, option.key]};
        });
        return (
          <section className="panel modifier-sheet">
            <div className="title">
              <div>
                <h2>{item.name}</h2>
                <p>Choose options for this item. Base price {rs(item.price)}.</p>
              </div>
              <button className="receive" onClick={() => setConfiguring(null)}>Cancel</button>
            </div>
            {(item.modifierGroups || []).map(group => (
              <div key={group.key} className="modifier-group">
                <h3>
                  {group.name}
                  <small>
                    {group.required ? 'Required' : 'Optional'}
                    {group.selection === 'single' ? ' · choose one' : group.maxSelect > 0 ? ` · up to ${group.maxSelect}` : ' · choose any'}
                  </small>
                </h3>
                <div className="modifier-options">
                  {(group.options || []).map(option => {
                    const active = (picks[group.key] || []).includes(option.key);
                    const override = group.kind === 'variant' && option.priceOverride !== null && option.priceOverride !== undefined;
                    return (
                      <button
                        key={option.key}
                        className={'modifier-option' + (active ? ' active' : '')}
                        onClick={() => toggle(group, option)}
                      >
                        <b>{option.name}</b>
                        <small>
                          {override ? rs(option.priceOverride)
                            : Number(option.priceDelta || 0) > 0 ? '+' + rs(option.priceDelta)
                            : Number(option.priceDelta || 0) < 0 ? '−' + rs(Math.abs(option.priceDelta))
                            : group.kind === 'removal' ? 'Removed' : 'No charge'}
                        </small>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <textarea
              className="receive-notes"
              maxLength={500}
              placeholder="Special instructions (e.g. less oil, no coriander)"
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
            />
            <div className="total"><span>Line price</span><b>{rs(priceWith(item, chosen))}</b></div>
            {!!missing.length && <p className="warn">Choose: {missing.map(g => g.name).join(', ')}</p>}
            <button
              className="checkout"
              disabled={!!missing.length}
              onClick={() => { pushLine(item, chosen, instructions.trim()); setConfiguring(null); }}
            >Add to order</button>
          </section>
        );
      })()}
      <section className="panel order">
        <h2>Current order</h2>
        {cart.length ? cart.map(x => (
          <div className="cart" key={x.sig}>
            <b>
              {x.name}
              {!!x.modifierNames?.length && <small>{x.modifierNames.join(' · ')}</small>}
              {x.specialInstructions && <small>“{x.specialInstructions}”</small>}
            </b>
            <span>
              <button onClick={() => bump(x, -1)}>−</button>
              {' '}{x.qty}{' '}
              <button onClick={() => bump(x, 1)}>+</button>
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
                  items: cart.map(x => ({
                    menuItem: x._id,
                    qty: x.qty,
                    modifiers: x.modifiers?.length ? x.modifiers : undefined,
                    specialInstructions: x.specialInstructions || undefined
                  })),
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
