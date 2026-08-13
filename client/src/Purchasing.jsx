import React, {useEffect, useState} from 'react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});
const remaining = line => Math.max(0, Number(line.orderedQty || 0) - Number(line.receivedQty || 0));
const accepted = line => Math.max(0, Number(line.receivedQty || 0) - Number(line.damagedQty || 0));
const returnable = line => Math.max(0, accepted(line) - Number(line.returnedQty || 0));

export default function Purchasing({call, branch}) {
  const [po, setPo] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [returns, setReturns] = useState([]);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  const [lines, setLines] = useState({});
  const [retLines, setRetLines] = useState({});
  const [notes, setNotes] = useState('');
  const [returnNotes, setReturnNotes] = useState('');
  const [reason, setReason] = useState('quality');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({supplier: '', ingredient: '', qty: 1, price: 0});
  const [invoice, setInvoice] = useState({supplier: '', purchaseOrder: '', invoiceNo: '', subtotal: 0});

  const load = () => Promise.all([
    call('/purchase-orders' + (branch ? `?branch=${branch._id}` : '')),
    call('/suppliers'),
    call('/ingredients'),
    call('/supplier-invoices' + (branch ? `?branch=${branch._id}` : ''))
  ]).then(([a, b, c, d]) => {
    setPo(a);
    setSuppliers(b);
    setIngredients(c);
    setInvoices(d);
  }).catch(e => setError(e.message));

  useEffect(() => { load(); }, [branch?._id]);

  const openReceive = async order => {
    setError('');
    setOpenId(order._id);
    setNotes('');
    setLines(Object.fromEntries((order.items || []).map(i => [i._id, {
      receivedQty: remaining(i) || 0,
      damagedQty: 0,
      batchNumber: '',
      expiryDate: ''
    }])));
    setReturnNotes('');
    setReason('quality');
    setRetLines(Object.fromEntries((order.items || []).map(i => [i._id, {qty: 0, batchNumber: ''}])));
    try {
      const [r, ret] = await Promise.all([
        call('/purchase-orders/' + order._id + '/receipts'),
        call('/purchase-orders/' + order._id + '/returns')
      ]);
      setReceipts(r);
      setReturns(ret);
    } catch (e) {
      setReceipts([]);
      setReturns([]);
      setError(e.message);
    }
  };

  const create = async e => {
    e.preventDefault();
    if (!branch) return;
    setError('');
    try {
      const i = ingredients.find(x => x._id === form.ingredient);
      await call('/purchase-orders', {method: 'POST', body: JSON.stringify({
        branch: branch._id,
        supplier: form.supplier,
        items: [{ingredient: form.ingredient, orderedQty: Number(form.qty), unit: i?.unit || 'g', unitPrice: Number(form.price)}],
        total: Number(form.qty) * Number(form.price)
      })});
      setForm({...form, qty: 1, price: 0});
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const receive = async order => {
    const items = (order.items || []).map(i => {
      const row = lines[i._id] || {};
      return {
        itemId: i._id,
        receivedQty: Number(row.receivedQty || 0),
        damagedQty: Number(row.damagedQty || 0),
        unitPrice: i.unitPrice,
        batchNumber: row.batchNumber || undefined,
        expiryDate: row.expiryDate || undefined
      };
    }).filter(x => x.receivedQty > 0);
    if (!items.length) return;
    setBusy(order._id);
    setError('');
    try {
      await call('/purchase-orders/' + order._id + '/receive', {
        method: 'POST',
        headers: {'Idempotency-Key': 'ui-' + order._id + '-' + Date.now()},
        body: JSON.stringify({items, notes})
      });
      setNotes('');
      await load();
      const fresh = await call('/purchase-orders/' + order._id);
      await openReceive(fresh);
    } catch (e) {
      setError(e.message || 'Receiving failed');
    } finally {
      setBusy('');
    }
  };

  const postReturn = async order => {
    const items = (order.items || []).map(i => {
      const row = retLines[i._id] || {};
      return {itemId: i._id, qty: Number(row.qty || 0), unitPrice: i.unitPrice, batchNumber: row.batchNumber || undefined};
    }).filter(x => x.qty > 0);
    if (!items.length) return;
    setBusy('ret-' + order._id);
    setError('');
    try {
      await call('/purchase-orders/' + order._id + '/returns', {
        method: 'POST',
        headers: {'Idempotency-Key': 'ret-' + order._id + '-' + Date.now()},
        body: JSON.stringify({items, reason, notes: returnNotes})
      });
      setReturnNotes('');
      await load();
      const fresh = await call('/purchase-orders/' + order._id);
      await openReceive(fresh);
    } catch (e) {
      setError(e.message || 'Return failed');
    } finally {
      setBusy('');
    }
  };

  const createInvoice = async e => {
    e.preventDefault();
    if (!branch) return;
    const subtotal = Number(invoice.subtotal || 0);
    const vat = Math.round(subtotal * 0.13 * 100) / 100;
    setError('');
    try {
      await call('/supplier-invoices', {method: 'POST', body: JSON.stringify({
        branch: branch._id,
        supplier: invoice.supplier,
        purchaseOrder: invoice.purchaseOrder || undefined,
        invoiceNo: invoice.invoiceNo,
        subtotal,
        vat,
        total: Math.round((subtotal + vat) * 100) / 100
      })});
      setInvoice({supplier: invoice.supplier, purchaseOrder: '', invoiceNo: '', subtotal: 0});
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const pay = async inv => {
    const amount = Number(window.prompt(`Record cash payment in Rs. (due ${rs(inv.total - inv.paidAmount)})`, inv.total - inv.paidAmount));
    if (!amount || amount < 0) return;
    try {
      await call('/supplier-invoices/' + inv._id + '/payments', {method: 'POST', body: JSON.stringify({amount, method: 'cash'})});
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const open = po.find(x => x._id === openId);

  return (
    <section className="panel">
      <h2>Purchasing & goods receiving</h2>
      <p>Partial receipts post accepted stock (received − damaged) to the branch ledger in Rs. VAT on supplier invoices is 13%.</p>
      {error && <p className="danger">{error}</p>}

      <form className="purchaseform" onSubmit={create}>
        <select required value={form.supplier} onChange={e => setForm({...form, supplier: e.target.value})}>
          <option value="">Supplier</option>
          {suppliers.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
        </select>
        <select required value={form.ingredient} onChange={e => setForm({...form, ingredient: e.target.value})}>
          <option value="">Ingredient</option>
          {ingredients.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
        </select>
        <input required min="1" type="number" value={form.qty} onChange={e => setForm({...form, qty: e.target.value})} placeholder="Qty"/>
        <input required min="0" type="number" value={form.price} onChange={e => setForm({...form, price: e.target.value})} placeholder="Unit price"/>
        <button>Create PO</button>
      </form>

      <h3>Purchase orders</h3>
      <table>
        <thead><tr><th>PO</th><th>Supplier</th><th>Received</th><th>Remaining</th><th>Status</th><th>Total</th><th></th></tr></thead>
        <tbody>
          {po.map(x => (
            <tr key={x._id}>
              <td>{x.poNo}</td>
              <td>{x.supplier?.name}</td>
              <td>{x.items?.map(i => `${i.receivedQty}/${i.orderedQty} ${i.unit || ''}`).join(', ')}</td>
              <td>{x.items?.map(i => remaining(i)).join(', ')}</td>
              <td><label className="pill ok">{x.status}</label></td>
              <td>{rs(x.total)}</td>
              <td><button className="receive" onClick={() => openReceive(x)}>{['received', 'cancelled'].includes(x.status) ? 'Open' : 'Receive / return'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <div className="receive-box">
          <h3>Receive {open.poNo}</h3>
          <p>Accepted quantity = received − damaged. Remaining is ordered − already received.</p>
          <table>
            <thead><tr><th>Ingredient</th><th>Ordered</th><th>Already in</th><th>Remaining</th><th>Receive now</th><th>Damaged</th><th>Accepted</th><th>Batch</th><th>Expiry</th></tr></thead>
            <tbody>
              {(open.items || []).map(i => {
                const row = lines[i._id] || {receivedQty: 0, damagedQty: 0};
                const rec = Number(row.receivedQty || 0);
                const dmg = Number(row.damagedQty || 0);
                return (
                  <tr key={i._id}>
                    <td>{i.ingredient?.name || 'Ingredient'}</td>
                    <td>{i.orderedQty} {i.unit}</td>
                    <td>{i.receivedQty || 0}</td>
                    <td>{remaining(i)}</td>
                    <td><input type="number" min="0" max={remaining(i)} value={row.receivedQty} onChange={e => setLines(s => ({...s, [i._id]: {...row, receivedQty: e.target.value}}))}/></td>
                    <td><input type="number" min="0" value={row.damagedQty} onChange={e => setLines(s => ({...s, [i._id]: {...row, damagedQty: e.target.value}}))}/></td>
                    <td>{Math.max(0, rec - dmg)}</td>
                    <td><input value={row.batchNumber || ''} onChange={e => setLines(s => ({...s, [i._id]: {...row, batchNumber: e.target.value}}))} placeholder="Batch"/></td>
                    <td><input type="date" value={row.expiryDate || ''} onChange={e => setLines(s => ({...s, [i._id]: {...row, expiryDate: e.target.value}}))}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <input className="receive-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Receiving notes"/>
          <button className="receive" disabled={!!busy} onClick={() => receive(open)}>{busy ? 'Posting…' : 'Post receipt'}</button>

          {(open.items || []).some(i => returnable(i) > 0) && open.status !== 'cancelled' && (
            <div>
              <h3>Return to supplier</h3>
              <p>Returnable is accepted stock still on this PO (received − damaged − already returned). This deducts usable inventory.</p>
              <table>
                <thead><tr><th>Ingredient</th><th>Accepted</th><th>Already returned</th><th>Returnable</th><th>Return now</th><th>Batch</th></tr></thead>
                <tbody>
                  {(open.items || []).map(i => {
                    const row = retLines[i._id] || {qty: 0};
                    return (
                      <tr key={'ret-' + i._id}>
                        <td>{i.ingredient?.name || 'Ingredient'}</td>
                        <td>{accepted(i)}</td>
                        <td>{i.returnedQty || 0}</td>
                        <td>{returnable(i)}</td>
                        <td><input type="number" min="0" max={returnable(i)} value={row.qty} onChange={e => setRetLines(s => ({...s, [i._id]: {...row, qty: e.target.value}}))}/></td>
                        <td><input value={row.batchNumber || ''} onChange={e => setRetLines(s => ({...s, [i._id]: {...row, batchNumber: e.target.value}}))} placeholder="Batch"/></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <select className="receive-notes" value={reason} onChange={e => setReason(e.target.value)}>
                {['quality', 'wrong_item', 'expired', 'overstock', 'damaged', 'other'].map(x => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
              </select>
              <input className="receive-notes" value={returnNotes} onChange={e => setReturnNotes(e.target.value)} placeholder="Return notes"/>
              <button className="receive" disabled={!!busy} onClick={() => postReturn(open)}>{String(busy).startsWith('ret-') ? 'Posting…' : 'Post return'}</button>
            </div>
          )}

          <h3>Return history</h3>
          {!returns.length && <p className="empty">No returns posted yet.</p>}
          {!!returns.length && (
            <table>
              <thead><tr><th>Return</th><th>Qty</th><th>Reason</th><th>Notes</th><th>When</th></tr></thead>
              <tbody>
                {returns.map(r => (
                  <tr key={r._id}>
                    <td>{r.returnNo}</td>
                    <td>{r.items?.map(i => i.qty).join(', ')}</td>
                    <td>{r.reason}</td>
                    <td>{r.notes || '—'}</td>
                    <td>{r.createdAt ? new Date(r.createdAt).toLocaleString('en-NP') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Receipt history</h3>
          {!receipts.length && <p className="empty">No receipts posted yet.</p>}
          {!!receipts.length && (
            <table>
              <thead><tr><th>Receipt</th><th>Accepted</th><th>Damaged</th><th>Batch</th><th>Notes</th><th>When</th></tr></thead>
              <tbody>
                {receipts.map(r => (
                  <tr key={r._id}>
                    <td>{r.receiptNo}</td>
                    <td>{r.items?.map(i => i.acceptedQty).join(', ')}</td>
                    <td>{r.items?.map(i => i.damagedQty).join(', ')}</td>
                    <td>{r.items?.map(i => i.batchNumber || '—').join(', ')}</td>
                    <td>{r.notes || '—'}</td>
                    <td>{r.createdAt ? new Date(r.createdAt).toLocaleString('en-NP') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h3>Create supplier invoice</h3>
      <form className="purchaseform" onSubmit={createInvoice}>
        <select required value={invoice.supplier} onChange={e => setInvoice({...invoice, supplier: e.target.value})}>
          <option value="">Supplier</option>
          {suppliers.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
        </select>
        <select value={invoice.purchaseOrder} onChange={e => setInvoice({...invoice, purchaseOrder: e.target.value})}>
          <option value="">Link PO (optional)</option>
          {po.map(x => <option key={x._id} value={x._id}>{x.poNo}</option>)}
        </select>
        <input required value={invoice.invoiceNo} onChange={e => setInvoice({...invoice, invoiceNo: e.target.value})} placeholder="Invoice no"/>
        <input required min="0" type="number" value={invoice.subtotal} onChange={e => setInvoice({...invoice, subtotal: e.target.value})} placeholder="Subtotal Rs."/>
        <button>Create invoice + 13% VAT</button>
      </form>
      <p>VAT 13% = {rs(Number(invoice.subtotal || 0) * 0.13)} · Total {rs(Number(invoice.subtotal || 0) * 1.13)}</p>

      <h3>Supplier invoices & payments</h3>
      <table>
        <thead><tr><th>Invoice</th><th>Supplier</th><th>Total</th><th>Paid</th><th>Due</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {invoices.map(x => (
            <tr key={x._id}>
              <td>{x.invoiceNo}</td>
              <td>{x.supplier?.name}</td>
              <td>{rs(x.total)}</td>
              <td>{rs(x.paidAmount)}</td>
              <td>{rs(x.total - x.paidAmount)}</td>
              <td><label className="pill ok">{x.status}</label></td>
              <td>{x.status !== 'paid' && <button className="receive" onClick={() => pay(x)}>Record payment</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
