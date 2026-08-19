import React, {useCallback, useEffect, useMemo, useState} from 'react';

/**
 * POS management workspace (Phase 14).
 *
 * The POS engine (11A–11F) was entirely API-only: refunds, payment reversal,
 * receipt issuing and split payments had no screen at all. This is the
 * manager's side of the till — find an order, see exactly what was charged,
 * and correct it.
 *
 * Two rules shape everything here:
 *
 *  1. Every amount shown is read from the STORED order and payment records.
 *     Nothing is recalculated in React, so a historical order is never
 *     re-priced against today's menu.
 *  2. The backend is the authority. Buttons are hidden by role for usability,
 *     but every action is authorised server-side and the UI simply reports
 *     what it is told.
 */

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

const stamp = value => value
  ? new Date(value).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  })
  : '—';

const ORDER_STATUSES = [
  'pending', 'confirmed', 'accepted', 'preparing', 'ready',
  'out_for_delivery', 'completed', 'cancelled', 'refunded'
];
const ORDER_TYPES = ['dine-in', 'takeaway', 'counter', 'delivery'];
const PAYMENT_METHODS = ['cash', 'card', 'esewa', 'khalti', 'wallet'];

/** Local-day boundaries, so "today" means the operator's today. */
function dayBounds(value) {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

export default function PosAdmin({call, branches = [], user}) {
  const [branchId, setBranchId] = useState(branches[0]?._id || '');
  const [orders, setOrders] = useState([]);
  const [filters, setFilters] = useState({
    date: new Date().toISOString().slice(0, 10),
    status: '', paymentStatus: '', type: '', method: '', q: ''
  });
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [summary, setSummary] = useState(null);
  const [payments, setPayments] = useState([]);
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState(null);

  const isManager = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const rows = await call(`/orders?branch=${branchId}`);
      setOrders(Array.isArray(rows) ? rows : rows.items || []);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [call, branchId]);

  useEffect(() => { load(); }, [load]);

  /** Filtering is client-side over the branch-scoped list the server returned. */
  const visible = useMemo(() => {
    const [from, to] = dayBounds(filters.date);
    const term = filters.q.trim().toLowerCase();
    return orders.filter(o => {
      const at = new Date(o.createdAt);
      if (filters.date && (at < from || at >= to)) return false;
      if (filters.status && o.status !== filters.status) return false;
      if (filters.type && o.type !== filters.type) return false;
      if (filters.method && o.paymentMethod !== filters.method) return false;
      if (filters.paymentStatus === 'settled' && Number(o.dueAmount || 0) > 0) return false;
      if (filters.paymentStatus === 'due' && Number(o.dueAmount || 0) <= 0) return false;
      if (filters.paymentStatus === 'refunded' && !(Number(o.refundAmount || 0) > 0)) return false;
      if (term) {
        const haystack = [o.orderNo, o.customer?.name, o.customer?.phone, o.invoiceNo]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [orders, filters]);

  const totals = useMemo(() => visible.reduce((acc, o) => ({
    orders: acc.orders + 1,
    gross: acc.gross + Number(o.total || 0),
    vat: acc.vat + Number(o.vat || 0),
    discount: acc.discount + Number(o.discountTotal || 0),
    refunded: acc.refunded + Number(o.refundAmount || 0)
  }), {orders: 0, gross: 0, vat: 0, discount: 0, refunded: 0}), [visible]);

  const openOrder = async id => {
    setSelected(id);
    setReceipt(null);
    setError('');
    try {
      const [order, sum, pays] = await Promise.all([
        call(`/orders/${id}`),
        call(`/orders/${id}/payment-summary`),
        call(`/orders/${id}/payments`)
      ]);
      setDetail(order);
      setSummary(sum);
      setPayments(Array.isArray(pays) ? pays : pays.payments || []);
    } catch (e) {
      setError(e.message);
    }
  };

  const refreshOpen = async () => {
    await load();
    if (selected) await openOrder(selected);
  };

  /** Every financial action funnels through here: one busy flag, one refresh. */
  const act = async (fn, message) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      setNotice(message);
      setDialog(null);
      await refreshOpen();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const takePayment = (amount, method) => act(
    () => call(`/orders/${selected}/payments`, {
      method: 'POST',
      // A stable key per attempt, so a double-click cannot bank twice.
      headers: {'Idempotency-Key': `ui-pay-${selected}-${Date.now()}`},
      body: JSON.stringify({amount: Number(amount), method})
    }),
    'Payment recorded'
  );

  const doRefund = (amount, reason) => act(
    () => call(`/orders/${selected}/refunds`, {
      method: 'POST',
      headers: {'Idempotency-Key': `ui-refund-${selected}-${Date.now()}`},
      body: JSON.stringify({amount: Number(amount), reason})
    }),
    'Refund recorded'
  );

  const doReverse = (paymentId, reason) => act(
    () => call(`/payments/${paymentId}/reverse`, {
      method: 'POST', body: JSON.stringify({reason})
    }),
    'Payment reversed'
  );

  const previewReceipt = async () => {
    setError('');
    try {
      // Preview deliberately does NOT pass issue=true: previewing must never
      // allocate an invoice number.
      setReceipt(await call(`/orders/${selected}/receipt`));
      setNotice('Preview only — no invoice number allocated');
    } catch (e) {
      setError(e.message);
    }
  };

  const issueReceipt = () => act(
    async () => {
      const issued = await call(`/orders/${selected}/receipt?issue=true`);
      setReceipt(issued);
    },
    'Receipt issued'
  );

  const printReceipt = async () => {
    setError('');
    try {
      const html = await call(`/orders/${selected}/receipt?format=html`, {raw: true});
      const w = window.open('', '_blank');
      if (!w) return setError('Allow pop-ups to print the receipt');
      w.document.write(html);
      w.document.close();
      w.focus();
      w.print();
      await refreshOpen();
    } catch (e) {
      setError(e.message);
    }
  };

  const settled = summary ? summary.settled : false;
  const refundable = summary ? Number(summary.refundable || 0) : 0;

  return (
    <div className="pa">
      <header className="pa-head">
        <div>
          <h1>POS management</h1>
          <p className="pa-sub">Find an order, inspect what was charged, and correct it.</p>
        </div>
        <select value={branchId} onChange={e => setBranchId(e.target.value)}>
          {branches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
        </select>
      </header>

      {error && <div className="pa-alert pa-error">{error}</div>}
      {notice && <div className="pa-alert pa-ok" onClick={() => setNotice('')}>{notice}</div>}

      <div className="pa-kpis">
        <Kpi label="Orders" value={totals.orders}/>
        <Kpi label="Gross" value={rs(totals.gross)}/>
        <Kpi label="VAT" value={rs(totals.vat)}/>
        <Kpi label="Discounts" value={rs(totals.discount)}/>
        <Kpi label="Refunded" value={rs(totals.refunded)}/>
      </div>

      <div className="pa-filters">
        <input type="date" value={filters.date}
          onChange={e => setFilters(f => ({...f, date: e.target.value}))}/>
        <input placeholder="Order no, customer, invoice…" value={filters.q}
          onChange={e => setFilters(f => ({...f, q: e.target.value}))}/>
        <select value={filters.status} onChange={e => setFilters(f => ({...f, status: e.target.value}))}>
          <option value="">Any status</option>
          {ORDER_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={filters.paymentStatus}
          onChange={e => setFilters(f => ({...f, paymentStatus: e.target.value}))}>
          <option value="">Any payment</option>
          <option value="settled">Settled</option>
          <option value="due">Outstanding</option>
          <option value="refunded">Refunded</option>
        </select>
        <select value={filters.type} onChange={e => setFilters(f => ({...f, type: e.target.value}))}>
          <option value="">Any type</option>
          {ORDER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filters.method} onChange={e => setFilters(f => ({...f, method: e.target.value}))}>
          <option value="">Any method</option>
          {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div className="pa-body">
        <section className="pa-list">
          {loading && <p className="pa-muted">Loading orders…</p>}
          {!loading && !visible.length && (
            <p className="pa-empty">No orders match these filters.</p>
          )}
          <table className="pa-table">
            <tbody>
              {visible.map(o => (
                <tr key={o._id}
                  className={String(o._id) === String(selected) ? 'is-active' : ''}
                  onClick={() => openOrder(o._id)}>
                  <td>
                    <b>{o.orderNo}</b>
                    <span className="pa-dim">{stamp(o.createdAt)}</span>
                  </td>
                  <td>
                    <span className="pa-dim">{o.type}</span>
                    {o.customer?.name && <span className="pa-dim">{o.customer.name}</span>}
                  </td>
                  <td>
                    <span className={`pa-chip is-${o.status}`}>{o.status.replace(/_/g, ' ')}</span>
                    {Number(o.refundAmount || 0) > 0 && <span className="pa-chip is-refunded">refunded</span>}
                  </td>
                  <td className="r">
                    <b>{rs(o.total)}</b>
                    <span className={'pa-dim' + (Number(o.dueAmount || 0) > 0 ? ' pa-due' : '')}>
                      {Number(o.dueAmount || 0) > 0 ? `${rs(o.dueAmount)} due` : 'settled'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="pa-detail">
          {!detail && <p className="pa-placeholder">Select an order to see its full history.</p>}

          {detail && (
            <>
              <div className="pa-dhead">
                <div>
                  <h2>{detail.orderNo}</h2>
                  <p className="pa-dim">
                    {detail.type}
                    {detail.table?.name ? ` · Table ${detail.table.name}` : ''}
                    {detail.customer?.name ? ` · ${detail.customer.name}` : ''}
                    {detail.invoiceNo ? ` · ${detail.invoiceNo}` : ''}
                  </p>
                </div>
                <span className={`pa-chip is-${detail.status}`}>{detail.status.replace(/_/g, ' ')}</span>
              </div>

              <h3>Items</h3>
              <table className="pa-table pa-items">
                <thead>
                  <tr><th>Item</th><th className="r">Qty</th><th className="r">Unit</th><th className="r">Line</th></tr>
                </thead>
                <tbody>
                  {(detail.items || []).map((it, i) => (
                    <tr key={i}>
                      <td>
                        {it.name}
                        {!!(it.modifiers || []).length && (
                          <div className="pa-mods">
                            {it.modifiers.map((m, j) => (
                              <span key={j} className={'pa-mod' + (m.removed ? ' is-removed' : '')}>
                                {m.removed ? '− ' : ''}{m.name}
                                {Number(m.price) ? ` (${rs(m.price)})` : ''}
                              </span>
                            ))}
                          </div>
                        )}
                        {it.specialInstructions && (
                          <div className="pa-note">“{it.specialInstructions}”</div>
                        )}
                      </td>
                      <td className="r">{it.qty}</td>
                      <td className="r">{rs(it.unitPrice)}</td>
                      <td className="r">{rs(it.lineTotal ?? it.unitPrice * it.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Every figure below is the stored value, never recomputed. */}
              <dl className="pa-totals">
                <dt>Subtotal</dt><dd>{rs(detail.subtotal)}</dd>
                {Number(detail.itemDiscount || 0) > 0 && (
                  <><dt>Line discounts</dt><dd>−{rs(detail.itemDiscount)}</dd></>
                )}
                {Number(detail.manualDiscount || 0) > 0 && (
                  <>
                    <dt>Manual discount</dt>
                    <dd>
                      −{rs(detail.manualDiscount)}
                      {detail.discountReason ? <span className="pa-dim"> {detail.discountReason}</span> : null}
                    </dd>
                  </>
                )}
                {Number(detail.couponDiscount || 0) > 0 && (
                  <>
                    <dt>Coupon {detail.couponCode}</dt>
                    <dd>−{rs(detail.couponDiscount)}</dd>
                  </>
                )}
                {Number(detail.serviceCharge || 0) > 0 && (
                  <><dt>Service charge</dt><dd>{rs(detail.serviceCharge)}</dd></>
                )}
                <dt>VAT ({detail.vatRate}%)</dt><dd>{rs(detail.vat)}</dd>
                {Number(detail.deliveryFee || 0) > 0 && (
                  <><dt>Delivery</dt><dd>{rs(detail.deliveryFee)}</dd></>
                )}
                <dt className="pa-grand">Total</dt><dd className="pa-grand">{rs(detail.total)}</dd>
              </dl>

              {summary && (
                <div className="pa-settle">
                  <span>Paid <b>{rs(summary.paid)}</b></span>
                  <span className={summary.due > 0 ? 'pa-due' : ''}>Due <b>{rs(summary.due)}</b></span>
                  <span>Refunded <b>{rs(summary.refunded)}</b></span>
                  <span>Refundable <b>{rs(summary.refundable)}</b></span>
                </div>
              )}

              <h3>Payments</h3>
              {!payments.length && <p className="pa-muted">No payments recorded.</p>}
              {!!payments.length && (
                <table className="pa-table">
                  <thead>
                    <tr>
                      <th>Method</th><th>When</th><th>Status</th>
                      <th className="r">Amount</th><th/>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map(p => (
                      <tr key={p._id} className={p.status === 'reversed' ? 'is-void' : ''}>
                        <td>
                          {p.method}
                          {p.refundOf && <span className="pa-dim">refund</span>}
                        </td>
                        <td>{stamp(p.createdAt)}</td>
                        <td>
                          <span className={`pa-chip is-${p.status}`}>{p.status}</span>
                          {p.reversalReason && (
                            <div className="pa-note">{p.reversalReason}</div>
                          )}
                        </td>
                        <td className="r">{rs(p.amount)}</td>
                        <td className="r">
                          {/* Reversal is owner-only and only for a live, positive tender. */}
                          {isOwner && p.status === 'paid' && !p.refundOf && Number(p.amount) > 0 && (
                            <button className="pa-danger"
                              onClick={() => setDialog({kind: 'reverse', payment: p})}>
                              Reverse
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="pa-actions">
                {!settled && (
                  <button className="pa-primary" onClick={() => setDialog({kind: 'pay'})}>
                    Take payment
                  </button>
                )}
                {isManager && refundable > 0 && (
                  <button onClick={() => setDialog({kind: 'refund'})}>Refund</button>
                )}
                <button onClick={previewReceipt}>Preview receipt</button>
                {settled && !detail.invoiceNo && (
                  <button className="pa-primary" onClick={() => setDialog({kind: 'issue'})}>
                    Issue invoice
                  </button>
                )}
                {detail.invoiceNo && <button onClick={printReceipt}>Print / reprint</button>}
              </div>

              {receipt && (
                <div className="pa-receipt">
                  <h3>
                    Receipt {receipt.invoiceNo || '(preview — no invoice number)'}
                    {receipt.reprint && <span className="pa-chip is-refunded">REPRINT</span>}
                  </h3>
                  <p className="pa-dim">
                    {receipt.invoiceNo
                      ? `Issued ${stamp(receipt.invoicedAt)} · printed ${receipt.printCount ?? 1}×`
                      : 'Previewing does not allocate an invoice number.'}
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {dialog && (
        <Dialog
          dialog={dialog}
          detail={detail}
          summary={summary}
          busy={busy}
          onClose={() => setDialog(null)}
          onPay={takePayment}
          onRefund={doRefund}
          onReverse={doReverse}
          onIssue={issueReceipt}
        />
      )}
    </div>
  );
}

function Kpi({label, value}) {
  return (
    <div className="pa-kpi">
      <span className="pa-kpi-label">{label}</span>
      <span className="pa-kpi-value">{value}</span>
    </div>
  );
}

/**
 * Confirmation for every financial action.
 *
 * Amounts are validated here for a fast message, but the server re-validates
 * all of it — this form is convenience, not a control.
 */
function Dialog({dialog, detail, summary, busy, onClose, onPay, onRefund, onReverse, onIssue}) {
  const due = Number(summary?.due || 0);
  const refundable = Number(summary?.refundable || 0);
  const [amount, setAmount] = useState(
    dialog.kind === 'pay' ? String(due) : dialog.kind === 'refund' ? String(refundable) : ''
  );
  const [method, setMethod] = useState('cash');
  const [reason, setReason] = useState('');

  const value = Number(amount);
  const payInvalid = dialog.kind === 'pay' && (!(value > 0) || value > due + 1e-9);
  const refundInvalid = dialog.kind === 'refund'
    && (!(value > 0) || value > refundable + 1e-9 || reason.trim().length < 3);
  const reverseInvalid = dialog.kind === 'reverse' && reason.trim().length < 3;

  return (
    <div className="pa-modal" role="dialog" aria-modal="true">
      <div className="pa-modalbox">
        {dialog.kind === 'pay' && (
          <>
            <h3>Take payment</h3>
            <p className="pa-dim">{detail.orderNo} · outstanding {rs(due)}</p>
            <label>Amount
              <input type="number" step="0.01" value={amount}
                onChange={e => setAmount(e.target.value)}/>
            </label>
            <label>Method
              <select value={method} onChange={e => setMethod(e.target.value)}>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            {payInvalid && <p className="pa-hint">Enter an amount between 0 and {rs(due)}.</p>}
            <Actions busy={busy} disabled={payInvalid} label="Take payment"
              onClose={onClose} onGo={() => onPay(value, method)}/>
          </>
        )}

        {dialog.kind === 'refund' && (
          <>
            <h3>Refund</h3>
            <p className="pa-warn">
              This returns money to the customer and cannot be undone.
            </p>
            <p className="pa-dim">{detail.orderNo} · refundable {rs(refundable)}</p>
            <label>Amount
              <input type="number" step="0.01" value={amount}
                onChange={e => setAmount(e.target.value)}/>
            </label>
            <label>Reason
              <input value={reason} onChange={e => setReason(e.target.value)}
                placeholder="Why is this being refunded?"/>
            </label>
            {refundInvalid && (
              <p className="pa-hint">
                Enter an amount up to {rs(refundable)} and a reason of at least 3 characters.
              </p>
            )}
            <Actions busy={busy} disabled={refundInvalid} label="Confirm refund" danger
              onClose={onClose} onGo={() => onRefund(value, reason.trim())}/>
          </>
        )}

        {dialog.kind === 'reverse' && (
          <>
            <h3>Reverse payment</h3>
            <p className="pa-warn">
              Use this only for a till mistake — a wrong tender or amount. The
              original payment stays on the record and the balance reopens. To
              return money to a customer, use Refund instead.
            </p>
            <p className="pa-dim">
              {dialog.payment.method} · {rs(dialog.payment.amount)} · {stamp(dialog.payment.createdAt)}
            </p>
            <label>Reason
              <input value={reason} onChange={e => setReason(e.target.value)}
                placeholder="e.g. charged to cash by mistake"/>
            </label>
            {reverseInvalid && <p className="pa-hint">A reason of at least 3 characters is required.</p>}
            <Actions busy={busy} disabled={reverseInvalid} label="Reverse payment" danger
              onClose={onClose} onGo={() => onReverse(dialog.payment._id, reason.trim())}/>
          </>
        )}

        {dialog.kind === 'issue' && (
          <>
            <h3>Issue tax invoice</h3>
            <p className="pa-warn">
              This allocates a permanent invoice number. It cannot be undone or
              reissued with a different number.
            </p>
            <p className="pa-dim">{detail.orderNo} · {rs(detail.total)}</p>
            <Actions busy={busy} disabled={false} label="Issue invoice"
              onClose={onClose} onGo={onIssue}/>
          </>
        )}
      </div>
    </div>
  );
}

function Actions({busy, disabled, label, danger, onClose, onGo}) {
  return (
    <div className="pa-modalactions">
      <button onClick={onClose} disabled={busy}>Cancel</button>
      <button
        className={danger ? 'pa-danger pa-solid' : 'pa-primary'}
        disabled={disabled || busy}
        onClick={onGo}
      >
        {busy ? 'Working…' : label}
      </button>
    </div>
  );
}
