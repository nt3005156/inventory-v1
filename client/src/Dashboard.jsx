import React, {useEffect, useState} from 'react';
import {AlertTriangle} from 'lucide-react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 0});

export default function Dashboard({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const owner = user?.role === 'owner';
  const [branchId, setBranchId] = useState(locked ? (assigned || '') : (owner ? '' : (visibleBranches[0]?._id || assigned || '')));
  const [dash, setDash] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!owner && !branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, owner, visibleBranches, branchId]);

  const load = () => {
    setLoading(true);
    setError('');
    const q = branchId ? '?branch=' + encodeURIComponent(branchId) : '';
    Promise.all([call('/dashboard' + q), call('/alerts' + q)])
      .then(([data, rows]) => {
        setDash(data || {});
        setAlerts(Array.isArray(rows) ? rows : []);
      })
      .catch(e => setError(e.message || 'Could not load dashboard'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [branchId]);

  const dismiss = async id => {
    setBusy(id);
    setError('');
    try {
      await call('/alerts/' + id + '/read', {method: 'PATCH'});
      setAlerts(curr => curr.filter(a => a._id !== id));
    } catch (e) {
      setError(e.message || 'Could not dismiss alert');
    } finally {
      setBusy('');
    }
  };

  const dismissAll = async () => {
    setBusy('all');
    setError('');
    try {
      await call('/alerts/read' + (branchId ? '?branch=' + encodeURIComponent(branchId) : ''), {method: 'POST'});
      setAlerts([]);
    } catch (e) {
      setError(e.message || 'Could not clear alerts');
    } finally {
      setBusy('');
    }
  };

  const d = dash || {};
  const branchName = branchId ? (visibleBranches.find(b => b._id === branchId)?.name || 'Branch') : 'All branches';

  return (
    <>
      <div className="title" style={{marginBottom: 16}}>
        <p className="empty" style={{padding: 0, margin: 0}}>Live {branchName} · today · NPR</p>
        <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
          {owner && <option value="">All branches</option>}
          {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
        </select>
      </div>
      {error && <p className="danger">{error}</p>}
      {loading && !dash && <p>Updating live data…</p>}
      <div className="kpis">
        {[['Today’s Revenue', d.revenue], ['Gross Profit', (d.revenue || 0) - (d.cogs || 0)], ['Inventory Value', d.inventoryValue], ['Orders Today', d.orders]].map(([a, b]) => (
          <article key={a}>
            <small>{a}</small>
            <strong>{typeof b === 'number' ? (a.includes('Orders') ? b : rs(b)) : '—'}</strong>
            <em>{a === 'Gross Profit' ? `${d.revenue ? (((d.revenue - d.cogs) / d.revenue) * 100).toFixed(1) : 0}% margin` : a.includes('Orders') ? 'Live tickets today' : 'Live branch ledger'}</em>
          </article>
        ))}
      </div>
      <section className="grid">
        <div className="panel">
          <h2>Stock attention</h2>
          {d.lowStock?.length ? d.lowStock.map(i => (
            <div className="row warn" key={i._id || i.name}>
              <AlertTriangle size={17}/>
              <b>{i.name}</b>
              <span>{(i.stockQty / 1000).toFixed(1)} kg left</span>
            </div>
          )) : <p className="empty">All ingredient levels are healthy.</p>}
        </div>
        <div className="panel">
          <h2>Operations pulse</h2>
          <div className="metric"><span>Food cost</span><b>{d.revenue ? ((d.cogs / d.revenue) * 100).toFixed(1) : 0}%</b></div>
          <div className="metric"><span>Waste written off</span><b>{rs(d.waste)}</b></div>
          <div className="metric"><span>Operating expenses</span><b>{rs(d.expense)}</b></div>
          <div className="metric"><span>Net profit today</span><b>{rs(d.profit)}</b></div>
        </div>
      </section>
    </>
  );
}
