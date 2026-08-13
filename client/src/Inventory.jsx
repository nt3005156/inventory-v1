import React, {useEffect, useState} from 'react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});

function qtyLabel(qty, unit) {
  const n = Number(qty || 0);
  if (unit === 'g' || !unit) return (n / 1000).toFixed(2) + ' kg';
  return n.toLocaleString('en-NP', {maximumFractionDigits: 2}) + ' ' + unit;
}

function minLabel(qty, unit) {
  const n = Number(qty || 0);
  if (unit === 'g' || !unit) return (n / 1000).toFixed(1) + ' kg';
  return n.toLocaleString('en-NP', {maximumFractionDigits: 1}) + ' ' + unit;
}

function signedQty(qty, unit) {
  const n = Number(qty || 0);
  const label = qtyLabel(Math.abs(n), unit);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + label;
}

export default function Inventory({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const canManage = ['owner', 'manager'].includes(user?.role);
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [rows, setRows] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [ingredient, setIngredient] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const load = () => {
    setLoading(true);
    setError('');
    const q = branchId ? '?branch=' + encodeURIComponent(branchId) : '';
    const jobs = [call('/inventory' + q)];
    if (canManage) jobs.push(call('/inventory/transactions' + q));
    Promise.all(jobs)
      .then(([balances, txs]) => {
        setRows(Array.isArray(balances) ? balances : []);
        setLedger(Array.isArray(txs) ? txs : []);
      })
      .catch(e => setError(e.message || 'Could not load inventory'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setIngredient('');
    load();
  }, [branchId]);

  const adjust = async e => {
    e.preventDefault();
    if (!canManage || !branchId) return;
    setBusy('adjust');
    setError('');
    try {
      await call('/inventory/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          branch: branchId,
          ingredient,
          qty: Number(qty),
          reason
        })
      });
      setQty('');
      setReason('');
      load();
    } catch (err) {
      setError(err.message || 'Could not post adjustment');
    } finally {
      setBusy('');
    }
  };

  const totalValue = rows.reduce((s, i) => s + Number(i.stockValue || 0), 0);

  return (
    <section className="panel">
      <div className="title">
        <div>
          <h2>Live ingredient inventory</h2>
          <p>On-hand qty and value from the branch ledger in NPR. Recipe deductions, receipts, waste, transfers and count adjustments update this list.</p>
        </div>
        <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
          {!locked && <option value="">All branches</option>}
          {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
        </select>
      </div>
      {error && <p className="danger">{error}</p>}
      {loading && <p>Loading live stock…</p>}
      {!loading && !rows.length && !error && <p className="empty">No ledger balances at this branch.</p>}
      {!loading && !!rows.length && (
        <>
          <p>Ledger value {rs(totalValue)} · {rows.length} line{rows.length === 1 ? '' : 's'}</p>
          <table>
            <thead>
              <tr>
                <th>Ingredient</th>
                {!branchId && <th>Branch</th>}
                <th>On hand</th>
                <th>Avg. cost</th>
                <th>Value</th>
                <th>Minimum</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(i => (
                <tr key={i._id}>
                  <td><b>{i.name}</b><small>{i.code}{i.category ? ` · ${i.category}` : ''}</small></td>
                  {!branchId && <td>{i.branchName || '—'}</td>}
                  <td>{qtyLabel(i.stockQty, i.unit)}</td>
                  <td>{i.unit === 'g' || !i.unit ? rs(i.averageCost * 1000) + '/kg' : rs(i.averageCost) + '/' + i.unit}</td>
                  <td>{rs(i.stockValue)}</td>
                  <td>{minLabel(i.minimumStock, i.unit)}</td>
                  <td><label className={'pill ' + i.status}>{i.status === 'ok' ? 'Healthy' : i.status}</label></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {canManage && branchId && (
        <>
          <h3>Count adjustment</h3>
          <p>Positive adds stock. Negative writes off stock. Both post an ADJUSTMENT row on this branch ledger.</p>
          <form className="purchaseform" onSubmit={adjust}>
            <select required value={ingredient} onChange={e => setIngredient(e.target.value)}>
              <option value="">Ingredient</option>
              {rows.map(i => <option key={i._id} value={i.ingredientId}>{i.name} — {qtyLabel(i.stockQty, i.unit)}</option>)}
            </select>
            <input required type="number" step="0.01" value={qty} onChange={e => setQty(e.target.value)} placeholder="Qty change"/>
            <input required minLength={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason"/>
            <button disabled={!!busy}>{busy === 'adjust' ? 'Posting…' : 'Post adjustment'}</button>
          </form>
        </>
      )}
      {canManage && (
        <>
          <h3>Ledger movements</h3>
          {!ledger.length && !loading && <p className="empty">No ledger movements for this view.</p>}
          {!!ledger.length && (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Ingredient</th>
                  {!branchId && <th>Branch</th>}
                  <th>Change</th>
                  <th>On hand after</th>
                  <th>Value</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map(t => (
                  <tr key={t._id}>
                    <td>{t.createdAt ? new Date(t.createdAt).toLocaleString('en-NP') : ''}</td>
                    <td><label className="pill">{String(t.type || '').replace('_', ' ')}</label></td>
                    <td>{t.name}</td>
                    {!branchId && <td>{t.branchName || '—'}</td>}
                    <td>{signedQty(t.changeQty, t.unit)}</td>
                    <td>{qtyLabel(t.newQty, t.unit)}</td>
                    <td>{rs(t.totalCost)}</td>
                    <td>{t.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
