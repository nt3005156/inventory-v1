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

export default function Inventory({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const load = () => {
    setLoading(true);
    setError('');
    const q = branchId ? '?branch=' + encodeURIComponent(branchId) : '';
    call('/inventory' + q)
      .then(data => setRows(Array.isArray(data) ? data : []))
      .catch(e => setError(e.message || 'Could not load inventory'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [branchId]);

  const totalValue = rows.reduce((s, i) => s + Number(i.stockValue || 0), 0);

  return (
    <section className="panel">
      <div className="title">
        <div>
          <h2>Live ingredient inventory</h2>
          <p>On-hand qty and value from the branch ledger in NPR. Recipe deductions and goods receipts update this list.</p>
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
    </section>
  );
}
