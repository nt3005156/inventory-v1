import React, {useEffect, useMemo, useState} from 'react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {minimumFractionDigits: 2, maximumFractionDigits: 2});

/** Public API helper — deliberately sends no Authorization header. */
async function publicCall(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: {'Content-Type': 'application/json', ...options.headers}
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error(body?.message || 'Something went wrong');
  return body;
}

const STEPS = ['menu', 'cart', 'details', 'payment', 'done'];

export default function Storefront() {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [menu, setMenu] = useState(null);
  const [cart, setCart] = useState([]);
  const [step, setStep] = useState('menu');
  const [type, setType] = useState('delivery');
  const [guest, setGuest] = useState({name: '', phone: '', email: ''});
  const [address, setAddress] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cod');
  const [quote, setQuote] = useState(null);
  const [placed, setPlaced] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState({orderNo: '', phone: '', result: null});

  useEffect(() => {
    publicCall('/public/branches')
      .then(data => {
        setBranches(data.branches || []);
        if (data.branches?.[0]) setBranchId(data.branches[0].id);
      })
      .catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (!branchId) return;
    setMenu(null);
    setCart([]);
    publicCall(`/public/menu?branch=${encodeURIComponent(branchId)}`)
      .then(setMenu)
      .catch(e => setError(e.message));
  }, [branchId]);

  const cartKey = (id, mods) => id + '|' + mods.map(m => m.group + ':' + m.option).sort().join(',');

  const addToCart = (item, mods = []) => {
    const key = cartKey(item.id, mods);
    setCart(current => {
      const found = current.find(line => line.key === key);
      if (found) return current.map(line => line.key === key ? {...line, qty: line.qty + 1} : line);
      return [...current, {key, id: item.id, name: item.name, price: item.price, modifiers: mods, qty: 1}];
    });
  };

  const changeQty = (key, delta) => setCart(current => current
    .map(line => line.key === key ? {...line, qty: line.qty + delta} : line)
    .filter(line => line.qty > 0));

  const cartCount = cart.reduce((sum, line) => sum + line.qty, 0);
  const cartPayload = useMemo(() => cart.map(line => ({
    menuItem: line.id,
    qty: line.qty,
    ...(line.modifiers.length ? {modifiers: line.modifiers} : {})
  })), [cart]);

  // The server prices everything; this only asks it for the current total.
  const refreshQuote = async () => {
    if (!cart.length) return setQuote(null);
    try {
      setQuote(await publicCall('/public/quote', {
        method: 'POST',
        body: JSON.stringify({branch: branchId, type, items: cartPayload, address: address || undefined})
      }));
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { if (step === 'cart' || step === 'payment') refreshQuote(); }, [step, type, cart.length]);

  const placeOrder = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await publicCall('/public/orders', {
        method: 'POST',
        body: JSON.stringify({
          branch: branchId,
          type,
          items: cartPayload,
          customer: {
            name: guest.name.trim(),
            phone: guest.phone.trim(),
            ...(guest.email.trim() ? {email: guest.email.trim()} : {})
          },
          ...(type === 'delivery' ? {address: address.trim()} : {}),
          paymentMethod
        })
      });
      setPlaced(result);
      setCart([]);
      setStep('done');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const canCheckout = guest.name.trim().length >= 2
    && guest.phone.trim().length >= 7
    && (type !== 'delivery' || address.trim().length >= 5);

  return (
    <div className="storefront">
      <header className="sf-head">
        <div>
          <h1>Order online</h1>
          <p>Fresh from our kitchen to your door.</p>
        </div>
        <select value={branchId} onChange={e => setBranchId(e.target.value)}>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </header>

      <nav className="sf-steps">
        {STEPS.slice(0, 4).map((name, index) => (
          <span key={name} className={STEPS.indexOf(step) >= index ? 'on' : ''}>
            {index + 1}. {name === 'details' ? 'Your details' : name[0].toUpperCase() + name.slice(1)}
          </span>
        ))}
      </nav>

      {error && <p className="sf-error">{error}</p>}

      {step === 'menu' && (
        <>
          {!menu && <p>Loading menu…</p>}
          {menu?.categories.map(group => (
            <section key={group.category} className="sf-category">
              <h2>{group.category}</h2>
              <div className="sf-grid">
                {group.items.map(item => (
                  <article key={item.id} className="sf-item">
                    <div>
                      <b>{item.name}</b>
                      {item.description && <small>{item.description}</small>}
                      <strong>{rs(item.price)}</strong>
                    </div>
                    <button onClick={() => addToCart(item)}>Add</button>
                  </article>
                ))}
              </div>
            </section>
          ))}
          {!!cartCount && (
            <button className="sf-primary sf-sticky" onClick={() => setStep('cart')}>
              View cart · {cartCount} item{cartCount === 1 ? '' : 's'}
            </button>
          )}
        </>
      )}

      {step === 'cart' && (
        <section className="sf-panel">
          <h2>Your cart</h2>
          {!cart.length && <p>Your cart is empty.</p>}
          {cart.map(line => (
            <div key={line.key} className="sf-line">
              <span>{line.name}</span>
              <div>
                <button onClick={() => changeQty(line.key, -1)}>−</button>
                <b>{line.qty}</b>
                <button onClick={() => changeQty(line.key, 1)}>+</button>
              </div>
              <span>{rs(line.price * line.qty)}</span>
            </div>
          ))}
          <div className="sf-type">
            <label>
              <input type="radio" checked={type === 'delivery'} onChange={() => setType('delivery')}/> Delivery
            </label>
            <label>
              <input type="radio" checked={type === 'takeaway'} onChange={() => setType('takeaway')}/> Pick-up
            </label>
          </div>
          {quote && (
            <div className="sf-totals">
              <div><span>Subtotal</span><b>{rs(quote.subtotal)}</b></div>
              <div><span>VAT {quote.vatRate}%</span><b>{rs(quote.vat)}</b></div>
              {quote.deliveryFee > 0 && <div><span>Delivery</span><b>{rs(quote.deliveryFee)}</b></div>}
              <div className="sf-grand"><span>Total</span><b>{rs(quote.total)}</b></div>
            </div>
          )}
          <div className="sf-actions">
            <button onClick={() => setStep('menu')}>Back to menu</button>
            <button className="sf-primary" disabled={!cart.length} onClick={() => setStep('details')}>Continue</button>
          </div>
        </section>
      )}

      {step === 'details' && (
        <section className="sf-panel">
          <h2>Your details</h2>
          <label>Name<input value={guest.name} onChange={e => setGuest({...guest, name: e.target.value})}/></label>
          <label>Phone<input value={guest.phone} onChange={e => setGuest({...guest, phone: e.target.value})}/></label>
          <label>Email (optional)<input value={guest.email} onChange={e => setGuest({...guest, email: e.target.value})}/></label>
          {type === 'delivery' && (
            <label>Delivery address
              <textarea value={address} onChange={e => setAddress(e.target.value)} rows={3}/>
            </label>
          )}
          <div className="sf-actions">
            <button onClick={() => setStep('cart')}>Back</button>
            <button className="sf-primary" disabled={!canCheckout} onClick={() => setStep('payment')}>Continue</button>
          </div>
        </section>
      )}

      {step === 'payment' && (
        <section className="sf-panel">
          <h2>Payment</h2>
          <label className="sf-radio">
            <input type="radio" checked={paymentMethod === 'cod'} onChange={() => setPaymentMethod('cod')}/>
            Cash on {type === 'delivery' ? 'delivery' : 'pick-up'}
          </label>
          <label className="sf-radio">
            <input type="radio" checked={paymentMethod === 'esewa'} onChange={() => setPaymentMethod('esewa')}/>
            eSewa
          </label>
          <label className="sf-radio">
            <input type="radio" checked={paymentMethod === 'khalti'} onChange={() => setPaymentMethod('khalti')}/>
            Khalti
          </label>
          {paymentMethod !== 'cod' && (
            <p className="sf-note">
              Your order will be placed and held for payment. Our team will contact you with payment
              instructions — no money is taken now.
            </p>
          )}
          {quote && <div className="sf-totals"><div className="sf-grand"><span>Total</span><b>{rs(quote.total)}</b></div></div>}
          <div className="sf-actions">
            <button onClick={() => setStep('details')}>Back</button>
            <button className="sf-primary" disabled={busy} onClick={placeOrder}>
              {busy ? 'Placing…' : 'Place order'}
            </button>
          </div>
        </section>
      )}

      {step === 'done' && placed && (
        <section className="sf-panel sf-done">
          <h2>Thank you</h2>
          <p>Your order <b>{placed.orderNo}</b> has been sent to the kitchen.</p>
          <p className="sf-note">
            {placed.paymentStatus === 'due_on_delivery'
              ? 'Please have the exact amount ready.'
              : 'We will contact you with payment instructions.'}
          </p>
          <div className="sf-totals"><div className="sf-grand"><span>Total</span><b>{rs(placed.total)}</b></div></div>
          <p>Keep your order number to track it below.</p>
          <button className="sf-primary" onClick={() => { setStep('menu'); setPlaced(null); }}>Order again</button>
        </section>
      )}

      <section className="sf-panel sf-track">
        <h2>Track an order</h2>
        <div className="sf-trackrow">
          <input placeholder="Order number" value={track.orderNo}
            onChange={e => setTrack({...track, orderNo: e.target.value})}/>
          <input placeholder="Phone" value={track.phone}
            onChange={e => setTrack({...track, phone: e.target.value})}/>
          <button
            onClick={async () => {
              setError('');
              try {
                const result = await publicCall(
                  `/public/orders/track?orderNo=${encodeURIComponent(track.orderNo)}&phone=${encodeURIComponent(track.phone)}`
                );
                setTrack(t => ({...t, result}));
              } catch (e) {
                setTrack(t => ({...t, result: null}));
                setError(e.message);
              }
            }}
          >Track</button>
        </div>
        {track.result && (
          <p className="sf-note">
            <b>{track.result.orderNo}</b> · {track.result.status} · {rs(track.result.total)}
          </p>
        )}
      </section>
    </div>
  );
}
