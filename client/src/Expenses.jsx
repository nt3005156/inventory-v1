import React, {useEffect, useState} from 'react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});
const CATEGORIES = ['rent', 'utilities', 'salary', 'marketing', 'maintenance', 'transport', 'packaging', 'insurance', 'other'];
const ymd = d => d ? new Date(d).toISOString().slice(0, 10) : '';

export default function Expenses({call, user}) {
  const canManage = ['owner', 'manager'].includes(user?.role);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({amount: 0, vat: 0, count: 0});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({category: 'rent', description: '', amount: '', date: ymd(new Date())});
  const [editId, setEditId] = useState('');
  const [edit, setEdit] = useState({category: 'rent', description: '', amount: '', date: ''});

  const load = () => {
    setLoading(true);
    setError('');
    call('/expenses')
      .then(data => {
        setRows(Array.isArray(data?.expenses) ? data.expenses : []);
        setSummary({amount: data?.amount || 0, vat: data?.vat || 0, count: data?.count || 0});
      })
      .catch(e => setError(e.message || 'Could not load expenses'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const save = async e => {
    e.preventDefault();
    if (!canManage) return;
    setBusy('create');
    setError('');
    try {
      await call('/expenses', {
        method: 'POST',
        body: JSON.stringify({
          category: form.category,
          description: form.description,
          amount: Number(form.amount),
          date: form.date || undefined
        })
      });
      setForm({category: form.category, description: '', amount: '', date: ymd(new Date())});
      load();
    } catch (err) {
      setError(err.message || 'Could not record expense');
    } finally {
      setBusy('');
    }
  };

  const openEdit = row => {
    setEditId(row._id);
    setEdit({
      category: row.category || 'other',
      description: row.description || '',
      amount: row.amount || 0,
      date: ymd(row.date)
    });
  };

  const saveEdit = async e => {
    e.preventDefault();
    setBusy('edit-' + editId);
    setError('');
    try {
      await call('/expenses/' + editId, {
        method: 'PATCH',
        body: JSON.stringify({
          category: edit.category,
          description: edit.description,
          amount: Number(edit.amount),
          date: edit.date || undefined
        })
      });
      setEditId('');
      load();
    } catch (err) {
      setError(err.message || 'Could not update expense');
    } finally {
      setBusy('');
    }
  };

  const remove = async row => {
    if (!window.confirm('Delete expense ' + (row.description || row.category) + '? It will drop off the live P&L.')) return;
    setBusy('del-' + row._id);
    setError('');
    try {
      await call('/expenses/' + row._id, {method: 'DELETE'});
      if (editId === row._id) setEditId('');
      load();
    } catch (err) {
      setError(err.message || 'Could not delete expense');
    } finally {
      setBusy('');
    }
  };

  const previewVat = amount => Math.round(Number(amount || 0) * 0.13 * 100) / 100;

  return (
    <section className="panel">
      <div className="title">
        <div>
          <h2>Operating expenses</h2>
          <p>Restaurant-wide costs in NPR. Amount hits live P&L. VAT 13% is recorded separately and is not branch-scoped.</p>
        </div>
      </div>
      {error && <p className="danger">{error}</p>}
      <div className="kpis">
        <article><small>Expense amount</small><strong>{rs(summary.amount)}</strong><em>{summary.count || 0} entries</em></article>
        <article><small>VAT 13%</small><strong>{rs(summary.vat)}</strong><em>Recorded, not in net profit</em></article>
        <article><small>Amount + VAT</small><strong>{rs(Number(summary.amount || 0) + Number(summary.vat || 0))}</strong><em>Cash outlay</em></article>
      </div>
      {canManage && (
        <form className="purchaseform" onSubmit={save}>
          <select required value={form.category} onChange={e => setForm({...form, category: e.target.value})}>
            {CATEGORIES.map(x => <option key={x} value={x}>{x}</option>)}
          </select>
          <input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Description"/>
          <input required min="0.01" step="0.01" type="number" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} placeholder="Amount Rs."/>
          <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})}/>
          <button disabled={!!busy}>{busy === 'create' ? 'Saving…' : 'Record expense'}</button>
        </form>
      )}
      {canManage && <p>VAT 13% = {rs(previewVat(form.amount))} · P&L amount {rs(form.amount)}</p>}
      {loading && <p>Loading expenses…</p>}
      {!loading && !rows.length && !error && <p className="empty">No operating expenses recorded yet.</p>}
      {!loading && !!rows.length && (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Description</th>
              <th>Amount</th>
              <th>VAT</th>
              <th>By</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row._id}>
                <td>{row.date ? new Date(row.date).toLocaleDateString('en-NP') : ''}</td>
                <td><label className="pill">{row.category}</label></td>
                <td>{row.description || '—'}</td>
                <td>{rs(row.amount)}</td>
                <td>{rs(row.vat)}</td>
                <td>{row.createdBy?.name || '—'}</td>
                <td>
                  {canManage && <button className="receive" onClick={() => openEdit(row)}>Edit</button>}
                  {canManage && <button className="kds-cancel" disabled={!!busy} onClick={() => remove(row)}>{busy === 'del-' + row._id ? 'Deleting…' : 'Delete'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editId && (
        <div className="receive-box">
          <h3>Edit expense</h3>
          <form className="purchaseform" onSubmit={saveEdit}>
            <select required value={edit.category} onChange={e => setEdit({...edit, category: e.target.value})}>
              {CATEGORIES.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            <input value={edit.description} onChange={e => setEdit({...edit, description: e.target.value})} placeholder="Description"/>
            <input required min="0.01" step="0.01" type="number" value={edit.amount} onChange={e => setEdit({...edit, amount: e.target.value})} placeholder="Amount Rs."/>
            <input type="date" value={edit.date} onChange={e => setEdit({...edit, date: e.target.value})}/>
            <button disabled={!!busy}>{String(busy).startsWith('edit-') ? 'Saving…' : 'Save expense'}</button>
          </form>
          <p>VAT 13% = {rs(previewVat(edit.amount))} · P&L amount {rs(edit.amount)}</p>
        </div>
      )}
    </section>
  );
}
