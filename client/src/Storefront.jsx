import React, {useEffect, useMemo, useState} from 'react';
import {applyBranding} from './branding.js';

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

const STEPS = ['menu', 'cart', 'details', 'payment', 'paying', 'done'];

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
  const [coupon, setCoupon] = useState('');
  // Only methods the deployment actually has credentials for are offered; a
  // gateway with no keys would send the guest to a dead redirect.
  const [methods, setMethods] = useState(['cod']);
  // Set once a gateway payment is in flight or has resolved.
  const [payment, setPayment] = useState(null);
  // Stable for the life of this cart, so a double-click or a retry after a
  // timeout is deduplicated by the server rather than buying twice.
  /**
   * P2D — tenant branding for the public storefront.
   *
   * Loaded per BRANCH, reusing the existing public tenant-resolution
   * mechanism: the browser knows a branch, the server derives the tenant. A
   * restaurant id is never sent, so a visitor cannot ask for another
   * restaurant's branding.
   */
  const [branding, setBranding] = useState(null);
  const [checkoutKey, setCheckoutKey] = useState(() => `sf-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    publicCall('/public/payment-methods')
      .then(data => setMethods(data.methods || ['cod']))
      .catch(() => setMethods(['cod']));
  }, []);

  // The gateway redirects the browser back to /order/payment/return?ref=...
  // Resolve it against the server, which re-confirms with the provider. The
  // query string is never treated as proof of payment.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (!ref) return;
    const cancelled = params.get('cancelled') === '1';
    setStep('paying');
    setPayment({reference: ref, status: cancelled ? 'cancelling' : 'verifying'});
    const query = new URLSearchParams(window.location.search).toString();
    publicCall(`/public/payments/return?${query}`)
      .then(result => setPayment(result))
      .catch(e => {
        setPayment({reference: ref, status: 'unknown'});
        setError(e.message);
      });
  }, []);

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
        body: JSON.stringify({
          branch: branchId, type, items: cartPayload,
          address: address || undefined, coupon: coupon.trim() || undefined
        })
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
        headers: {'Idempotency-Key': checkoutKey},
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
          ...(coupon.trim() ? {coupon: coupon.trim()} : {}),
          paymentMethod
        })
      });
      setPlaced(result);
      setCart([]);
      setCoupon('');
      // A fresh key for the next order, so the next checkout is not deduped
      // against this one.
      setCheckoutKey(`sf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      if (paymentMethod === 'cod') {
        setStep('done');
      } else {
        // Hand off to the gateway. The server signs/initiates; this only
        // performs the redirect it is told to perform.
        await startGatewayPayment(result.orderNo);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Ask the server to start a gateway payment, then redirect.
   *
   * eSewa needs a browser form POST with server-generated signed fields, so a
   * form is built and submitted. Khalti returns a URL to navigate to. In
   * neither case does this code compute an amount or a signature.
   */
  const startGatewayPayment = async orderNo => {
    const started = await publicCall('/public/payments', {
      method: 'POST',
      body: JSON.stringify({orderNo, phone: guest.phone.trim(), provider: paymentMethod})
    });
    const {redirect} = started;
    if (redirect.method === 'POST') {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = redirect.action;
      for (const [name, value] of Object.entries(redirect.fields || {})) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = String(value);
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } else {
      window.location.assign(redirect.action);
    }
  };

  /**
   * Re-fetched on every branch change, so switching location switches the
   * whole brand. Fails soft: a branding error must never block ordering.
   */
  useEffect(() => {
    if (!branchId) return undefined;
    let live = true;
    fetch(`/api/public/branding?branch=${encodeURIComponent(branchId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(result => {
        if (!live || !result?.branding) return;
        setBranding(result.branding);
        applyBranding(result.branding);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [branchId]);

  const canCheckout = guest.name.trim().length >= 2
    && guest.phone.trim().length >= 7
    && (type !== 'delivery' || address.trim().length >= 5);

  return (
    <div className="storefront">
      <header className="sf-head">
        {/*
          * P2D: was the hard-coded "Order online" / "Fresh from our kitchen".
          * Now the tenant's own copy, with the previous strings as the
          * fallback so an unbranded restaurant looks exactly as it did.
          *
          * React escapes all of this by default, so tenant-controlled text
          * cannot inject markup here.
          */}
        <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
          {branding?.logoUrl && (
            <img src={branding.logoUrl} alt="" style={{maxHeight: '48px', maxWidth: '120px'}}/>
          )}
          <div>
            <h1>{branding?.storefrontTitle || branding?.displayName || 'Order online'}</h1>
            <p>{branding?.storefrontSubtitle || branding?.tagline
              || 'Fresh from our kitchen to your door.'}</p>
          </div>
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

      {branding?.storefrontNotice && (
        <p style={{
          background: '#fff8e5', color: '#805d19', padding: '10px 14px', borderRadius: '8px'
        }}>{branding.storefrontNotice}</p>
      )}

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
          <div className="sf-coupon">
            <input placeholder="Coupon code (optional)" value={coupon}
              onChange={e => setCoupon(e.target.value.toUpperCase())}/>
            <button onClick={refreshQuote}>Apply</button>
          </div>
          {quote && (
            <div className="sf-totals">
              <div><span>Subtotal</span><b>{rs(quote.subtotal)}</b></div>
              {quote.couponDiscount > 0 && (
                <div><span>Discount</span><b>−{rs(quote.couponDiscount)}</b></div>
              )}
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
          {methods.includes('esewa') && (
            <label className="sf-radio">
              <input type="radio" checked={paymentMethod === 'esewa'} onChange={() => setPaymentMethod('esewa')}/>
              eSewa
            </label>
          )}
          {methods.includes('khalti') && (
            <label className="sf-radio">
              <input type="radio" checked={paymentMethod === 'khalti'} onChange={() => setPaymentMethod('khalti')}/>
              Khalti
            </label>
          )}
          {paymentMethod !== 'cod' && (
            <p className="sf-note">
              You will be taken to {paymentMethod === 'esewa' ? 'eSewa' : 'Khalti'} to pay securely.
              Your order reaches the kitchen once the payment is confirmed.
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

      {step === 'paying' && payment && (
        <section className="sf-panel sf-done">
          <h2>
            {payment.paid ? 'Payment received'
              : payment.status === 'verifying' ? 'Confirming your payment…'
              : payment.status === 'cancelled' ? 'Payment cancelled'
              : payment.status === 'expired' ? 'Payment expired'
              : payment.status === 'failed' ? 'Payment failed'
              : 'Payment status'}
          </h2>
          {payment.paid ? (
            <>
              <p>Your order <b>{payment.orderNo}</b> is paid and has gone to the kitchen.</p>
              <div className="sf-totals">
                <div className="sf-grand"><span>Paid</span><b>{rs(payment.amount)}</b></div>
              </div>
            </>
          ) : (
            <p className="sf-note">
              {payment.status === 'verifying'
                ? 'Checking with the payment provider — this only takes a moment.'
                : 'No money has been taken. You can try paying again from the tracking section below.'}
            </p>
          )}
          <p>Reference: <b>{payment.reference}</b></p>
          <button className="sf-primary" onClick={() => {
            window.history.replaceState({}, '', '/order');
            setStep('menu');
            setPayment(null);
            setError('');
          }}>Back to menu</button>
        </section>
      )}

      {step === 'done' && placed && (
        <section className="sf-panel sf-done">
          <h2>Thank you</h2>
          <p>Your order <b>{placed.orderNo}</b> has been sent to the kitchen.</p>
          <p className="sf-note">
            {placed.paymentStatus === 'due_on_delivery'
              ? 'Please have the exact amount ready.'
              : 'Your payment is being confirmed.'}
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
