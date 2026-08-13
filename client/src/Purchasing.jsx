import React, {useEffect, useRef, useState} from 'react';
import {connectBranchSocket} from './socket.js';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});
const remaining = line => Math.max(0, Number(line.orderedQty || 0) - Number(line.receivedQty || 0));
const accepted = line => Math.max(0, Number(line.receivedQty || 0) - Number(line.damagedQty || 0));
const returnable = line => Math.max(0, accepted(line) - Number(line.returnedQty || 0));
const ymd = d => d ? new Date(d).toISOString().slice(0, 10) : '';
const canReceivePo = s => ['approved', 'sent', 'partially_received'].includes(s);
const poPill = s => ['approved', 'sent', 'partially_received', 'received'].includes(s) ? 'pill ok' : 'pill';

export default function Purchasing({call, branch, token}) {
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
  const [statementId, setStatementId] = useState('');
  const [statement, setStatement] = useState(null);
  const [invoicePays, setInvoicePays] = useState([]);
  const [payInvoiceId, setPayInvoiceId] = useState('');
  const [report, setReport] = useState(null);
  const [editId, setEditId] = useState('');
  const [edit, setEdit] = useState({invoiceNo: '', invoiceDate: '', dueDate: '', subtotal: 0, notes: ''});
  const [live, setLive] = useState('connecting');
  const authToken = token || (typeof localStorage !== 'undefined' ? localStorage.token : '');

  const load = () => Promise.all([
    call('/purchase-orders' + (branch ? `?branch=${branch._id}` : '')),
    call('/suppliers'),
    call('/ingredients'),
    call('/supplier-invoices' + (branch ? `?branch=${branch._id}` : '')),
    call('/reports/purchasing' + (branch ? `?branch=${branch._id}` : ''))
  ]).then(([a, b, c, d, e]) => {
    setPo(a);
    setSuppliers(b);
    setIngredients(c);
    setInvoices(d);
    setReport(e);
  }).catch(e => setError(e.message));

  useEffect(() => { load(); }, [branch?._id]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const statementIdRef = useRef(statementId);
  statementIdRef.current = statementId;
  const payInvoiceIdRef = useRef(payInvoiceId);
  payInvoiceIdRef.current = payInvoiceId;

  const refreshOpenHistory = async id => {
    if (!id) return;
    try {
      const [r, ret] = await Promise.all([
        call('/purchase-orders/' + id + '/receipts'),
        call('/purchase-orders/' + id + '/returns')
      ]);
      setReceipts(r);
      setReturns(ret);
    } catch {
      /* list reload still ran */
    }
  };

  useEffect(() => {
    if (live === 'live') return;
    const tick = setInterval(() => loadRef.current(), 8000);
    return () => clearInterval(tick);
  }, [branch?._id, live]);

  useEffect(() => {
    if (!authToken || !branch?._id) return undefined;
    const socket = connectBranchSocket(authToken, branch._id);
    const onUpdate = payload => {
      if (payload?.branch && String(payload.branch) !== String(branch._id)) return;
      loadRef.current();
      if (openIdRef.current && payload.poId && String(payload.poId) === String(openIdRef.current)) {
        refreshOpenHistory(openIdRef.current);
      }
      if (statementIdRef.current && payload.supplierId && String(payload.supplierId) === String(statementIdRef.current)) {
        call('/suppliers/' + statementIdRef.current + '/statement?branch=' + branch._id)
          .then(setStatement)
          .catch(() => {});
      }
      if (payInvoiceIdRef.current && payload.invoiceId && String(payload.invoiceId) === String(payInvoiceIdRef.current)) {
        call('/supplier-invoices/' + payInvoiceIdRef.current + '/payments')
          .then(setInvoicePays)
          .catch(() => {});
      }
    };
    socket.on('connect', () => {
      setLive('live');
      socket.emit('join:branch', branch._id, ack => {
        if (ack && ack.ok === false) setError(ack.message || 'Could not join purchasing room');
      });
      loadRef.current();
    });
    socket.on('disconnect', reason => {
      setLive(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });
    socket.on('connect_error', () => setLive('reconnecting'));
    socket.on('purchasing:update', onUpdate);
    return () => {
      socket.emit('leave:branch', branch._id);
      socket.off('purchasing:update', onUpdate);
      socket.disconnect();
    };
  }, [authToken, branch?._id]);

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
      if (statementId === invoice.supplier) await loadStatement(invoice.supplier);
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
      if (statementId === (inv.supplier?._id || inv.supplier)) await loadStatement(statementId);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadStatement = async id => {
    if (!id) {
      setStatement(null);
      return;
    }
    setError('');
    try {
      const data = await call('/suppliers/' + id + '/statement' + (branch ? `?branch=${branch._id}` : ''));
      setStatement(data);
    } catch (e) {
      setStatement(null);
      setError(e.message);
    }
  };

  const showInvoicePays = async inv => {
    setError('');
    setPayInvoiceId(inv._id);
    try {
      setInvoicePays(await call('/supplier-invoices/' + inv._id + '/payments'));
    } catch (e) {
      setInvoicePays([]);
      setError(e.message);
    }
  };

  const openEdit = inv => {
    setError('');
    setEditId(inv._id);
    setEdit({
      invoiceNo: inv.invoiceNo || '',
      invoiceDate: ymd(inv.invoiceDate),
      dueDate: ymd(inv.dueDate),
      subtotal: inv.subtotal || 0,
      notes: inv.notes || ''
    });
  };

  const saveEdit = async e => {
    e.preventDefault();
    const current = invoices.find(x => x._id === editId);
    if (!current || current.status === 'void') return;
    const locked = Number(current.paidAmount || 0) > 0;
    const subtotal = Number(edit.subtotal || 0);
    const vat = Math.round(subtotal * 0.13 * 100) / 100;
    const body = {
      invoiceNo: edit.invoiceNo,
      invoiceDate: edit.invoiceDate || undefined,
      dueDate: edit.dueDate || null,
      notes: edit.notes
    };
    if (!locked) {
      body.subtotal = subtotal;
      body.vat = vat;
      body.total = Math.round((subtotal + vat) * 100) / 100;
    }
    setBusy('edit-' + editId);
    setError('');
    try {
      await call('/supplier-invoices/' + editId, {method: 'PATCH', body: JSON.stringify(body)});
      await load();
      if (statementId === (current.supplier?._id || current.supplier)) await loadStatement(statementId);
    } catch (err) {
      setError(err.message || 'Invoice update failed');
    } finally {
      setBusy('');
    }
  };

  const setPoStatus = async (order, status) => {
    let notes;
    if (status === 'rejected') {
      notes = window.prompt('Rejection note (optional)') || undefined;
    } else if (status === 'cancelled' && !window.confirm('Cancel ' + order.poNo + '?')) {
      return;
    }
    setBusy('st-' + order._id);
    setError('');
    try {
      const updated = await call('/purchase-orders/' + order._id + '/status', {
        method: 'PATCH',
        body: JSON.stringify({status, notes})
      });
      await load();
      if (openId === order._id) await openReceive(updated);
    } catch (e) {
      setError(e.message || 'Status update failed');
    } finally {
      setBusy('');
    }
  };

  const voidInvoice = async inv => {
    if (Number(inv.paidAmount || 0) > 0) return;
    if (!window.confirm('Void invoice ' + inv.invoiceNo + '? It will drop off the supplier statement.')) return;
    setBusy('void-' + inv._id);
    setError('');
    try {
      await call('/supplier-invoices/' + inv._id, {method: 'PATCH', body: JSON.stringify({status: 'void'})});
      if (editId === inv._id) setEditId('');
      await load();
      if (statementId === (inv.supplier?._id || inv.supplier)) await loadStatement(statementId);
    } catch (err) {
      setError(err.message || 'Void failed');
    } finally {
      setBusy('');
    }
  };

  const open = po.find(x => x._id === openId);

  return (
    <section className="panel">
      <div className="title">
        <div>
          <h2>Purchasing & goods receiving</h2>
          <p>POs start as drafts. Submit, then approve, before stock can be received. Live updates follow this branch. VAT on supplier invoices is 13%.</p>
        </div>
        <div className="kds-toolbar">
          <span className={'kds-live ' + (live === 'live' ? 'on' : live === 'reconnecting' || live === 'connecting' ? 'wait' : 'off')}>{live === 'live' ? 'Live' : live === 'reconnecting' ? 'Reconnecting' : live === 'offline' ? 'Offline' : 'Connecting'}</span>
        </div>
      </div>
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
              <td><label className={poPill(x.status)}>{String(x.status || '').replace('_', ' ')}</label></td>
              <td>{rs(x.total)}</td>
              <td>
                {['draft', 'rejected'].includes(x.status) && <button className="receive" onClick={() => setPoStatus(x, 'pending')}>Submit</button>}
                {x.status === 'pending' && <button className="receive" onClick={() => setPoStatus(x, 'approved')}>Approve</button>}
                {x.status === 'pending' && <button className="kds-cancel" onClick={() => setPoStatus(x, 'rejected')}>Reject</button>}
                {x.status === 'approved' && <button className="receive" onClick={() => setPoStatus(x, 'sent')}>Mark sent</button>}
                {['draft', 'pending', 'approved', 'rejected', 'sent'].includes(x.status) && <button className="kds-cancel" onClick={() => setPoStatus(x, 'cancelled')}>Cancel</button>}
                <button className="receive" onClick={() => openReceive(x)}>{canReceivePo(x.status) ? 'Receive / return' : 'Open'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <div className="receive-box">
          <h3>{open.poNo} · {String(open.status || '').replace('_', ' ')}</h3>
          {open.approvalNote && <p>Note: {open.approvalNote}</p>}
          {!canReceivePo(open.status) && open.status !== 'received' && (
            <p>{open.status === 'pending' ? 'Waiting for approval. Stock cannot be received yet.' : open.status === 'draft' ? 'Submit this draft for approval before receiving.' : open.status === 'rejected' ? 'Rejected. Resubmit after you correct it.' : 'This purchase order is not open for receiving.'}</p>
          )}
          {canReceivePo(open.status) && <p>Accepted quantity = received − damaged. Remaining is ordered − already received.</p>}
          {canReceivePo(open.status) && <>
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
          </>}

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
              <td>{rs(x.status === 'void' ? 0 : x.total - x.paidAmount)}</td>
              <td><label className={x.status === 'void' ? 'pill' : 'pill ok'}>{x.status}</label></td>
              <td>
                {x.status !== 'paid' && x.status !== 'void' && <button className="receive" onClick={() => pay(x)}>Record payment</button>}
                {x.status !== 'void' && <button className="receive" onClick={() => openEdit(x)}>Edit</button>}
                {x.status === 'unpaid' && Number(x.paidAmount || 0) === 0 && <button className="kds-cancel" onClick={() => voidInvoice(x)}>Void</button>}
                <button className="receive" onClick={() => showInvoicePays(x)}>Payments</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editId && (() => {
        const current = invoices.find(x => x._id === editId);
        const locked = Number(current?.paidAmount || 0) > 0;
        const vat = Math.round(Number(edit.subtotal || 0) * 0.13 * 100) / 100;
        return (
          <div className="receive-box">
            <h3>Edit invoice {current?.invoiceNo || ''}</h3>
            <p>{locked ? 'Payments exist — amounts stay locked. You can still correct the number, dates and notes.' : 'Unpaid invoice — number, dates, notes and amounts (13% VAT) can be changed.'}</p>
            <form className="purchaseform" onSubmit={saveEdit}>
              <input required value={edit.invoiceNo} onChange={e => setEdit({...edit, invoiceNo: e.target.value})} placeholder="Invoice no"/>
              <input type="date" value={edit.invoiceDate} onChange={e => setEdit({...edit, invoiceDate: e.target.value})}/>
              <input type="date" value={edit.dueDate} onChange={e => setEdit({...edit, dueDate: e.target.value})}/>
              <input required min="0" type="number" disabled={locked} value={edit.subtotal} onChange={e => setEdit({...edit, subtotal: e.target.value})} placeholder="Subtotal Rs."/>
              <button disabled={!!busy}>{String(busy).startsWith('edit-') ? 'Saving…' : 'Save invoice'}</button>
            </form>
            <input className="receive-notes" value={edit.notes} onChange={e => setEdit({...edit, notes: e.target.value})} placeholder="Invoice notes"/>
            <p>VAT 13% = {rs(locked ? current?.vat : vat)} · Total {rs(locked ? current?.total : Number(edit.subtotal || 0) + vat)}</p>
          </div>
        );
      })()}
      {payInvoiceId && (
        <div className="receive-box">
          <h3>Invoice payment history</h3>
          {!invoicePays.length && <p className="empty">No payments on this invoice yet.</p>}
          {!!invoicePays.length && (
            <table>
              <thead><tr><th>When</th><th>Method</th><th>Amount</th><th>Reference</th></tr></thead>
              <tbody>
                {invoicePays.map(p => (
                  <tr key={p._id}>
                    <td>{new Date(p.paidAt || p.createdAt).toLocaleString('en-NP')}</td>
                    <td>{p.method}</td>
                    <td>{rs(p.amount)}</td>
                    <td>{p.reference || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h3>Supplier statement</h3>
      <p>Invoices increase what we owe. Payments reduce it. Amounts are NPR including 13% VAT.</p>
      <select className="kds-branch" value={statementId} onChange={e => { setStatementId(e.target.value); loadStatement(e.target.value); }}>
        <option value="">Choose supplier</option>
        {suppliers.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
      </select>
      {statement && (
        <div className="receive-box">
          <div className="kpis" style={{marginTop: 12}}>
            <article><small>Invoiced</small><strong>{rs(statement.invoiced)}</strong></article>
            <article><small>Paid</small><strong>{rs(statement.paid)}</strong></article>
            <article><small>Balance due</small><strong>{rs(statement.balance)}</strong></article>
          </div>
          <h3>Statement</h3>
          {!statement.lines?.length && <p className="empty">No invoices or payments for this supplier.</p>}
          {!!statement.lines?.length && (
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
              <tbody>
                {statement.lines.map((line, i) => (
                  <tr key={i}>
                    <td>{line.date ? new Date(line.date).toLocaleDateString('en-NP') : ''}</td>
                    <td>{line.type}</td>
                    <td>{line.ref}{line.method ? ` · ${line.method}` : ''}</td>
                    <td>{line.debit ? rs(line.debit) : '—'}</td>
                    <td>{line.credit ? rs(line.credit) : '—'}</td>
                    <td>{rs(line.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>Payment history</h3>
          {!statement.payments?.length && <p className="empty">No supplier payments recorded.</p>}
          {!!statement.payments?.length && (
            <table>
              <thead><tr><th>When</th><th>Invoice</th><th>Method</th><th>Amount</th></tr></thead>
              <tbody>
                {statement.payments.map(p => (
                  <tr key={p._id}>
                    <td>{new Date(p.paidAt || p.createdAt).toLocaleString('en-NP')}</td>
                    <td>{p.invoice?.invoiceNo || '—'}</td>
                    <td>{p.method}</td>
                    <td>{rs(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h3>Purchasing report</h3>
      <p>Live branch totals from purchase orders, receipts, returns, invoices and the inventory ledger.</p>
      {!report && <p className="empty">Report loads with the branch.</p>}
      {report && (
        <div className="receive-box">
          <div className="kpis">
            <article><small>PO value</small><strong>{rs(report.purchaseOrders?.orderedValue)}</strong><em>{report.purchaseOrders?.count || 0} open/received POs</em></article>
            <article><small>Accepted stock value</small><strong>{rs(report.receipts?.acceptedValue)}</strong><em>Damaged {rs(report.receipts?.damagedValue)}</em></article>
            <article><small>Returned value</small><strong>{rs(report.returns?.value)}</strong><em>{report.returns?.count || 0} returns</em></article>
            <article><small>Invoice due</small><strong>{rs(report.invoices?.due)}</strong><em>VAT {rs(report.invoices?.vat)}</em></article>
          </div>
          <table>
            <thead><tr><th>Supplier</th><th>POs</th><th>Ordered</th><th>Invoiced</th><th>Paid</th><th>Due</th></tr></thead>
            <tbody>
              {(report.bySupplier || []).map(row => (
                <tr key={row.supplierId || row.name}>
                  <td>{row.name}</td>
                  <td>{row.poCount}</td>
                  <td>{rs(row.orderedValue)}</td>
                  <td>{rs(row.invoiced)}</td>
                  <td>{rs(row.paid)}</td>
                  <td>{rs(row.due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Ledger net stock value {rs(report.ledger?.netStockValue)} · purchases {rs(report.ledger?.purchaseValue)} · returns {rs(report.ledger?.returnValue)}</p>
        </div>
      )}
    </section>
  );
}
