import React, {useEffect, useState} from 'react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});

export default function Analytics({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const owner = user?.role === 'owner';
  const [branchId, setBranchId] = useState(locked ? (assigned || '') : (owner ? '' : (visibleBranches[0]?._id || assigned || '')));
  const [menu, setMenu] = useState([]);
  const [pnl, setPnl] = useState(null);
  const [error, setError] = useState('');
  const branch = visibleBranches.find(b => b._id === branchId) || null;

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!owner && !branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, owner, visibleBranches, branchId]);

  const load = () => {
    setError('');
    const q = branchId ? `?branch=${branchId}` : '';
    Promise.all([
      call('/analytics/menu-engineering' + q),
      call('/reports/pnl' + q)
    ]).then(([m, p]) => {
      setMenu(Array.isArray(m) ? m : []);
      setPnl(p);
    }).catch(e => setError(e.message || 'Could not load analytics'));
  };

  useEffect(() => { load(); }, [branchId]);

  return (
    <>
      <section className="panel">
        <div className="title">
          <div>
            <h2>Live P&L</h2>
            <p>Revenue and food cost from branch orders. Purchases are accepted stock minus returns from the inventory ledger. Waste is written-off stock. Operating expenses are restaurant-wide. Amounts in NPR, VAT 13%.</p>
          </div>
          <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
            {owner && <option value="">All branches</option>}
            {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
        {error && <p className="danger">{error}</p>}
        {!pnl && !error && <p className="empty">P&L loads with the branch.</p>}
        {pnl && (
          <div className="receive-box">
            <div className="kpis">
              <article><small>Revenue</small><strong>{rs(pnl.revenue)}</strong><em>{pnl.sales?.orders || 0} orders · VAT {rs(pnl.sales?.vat)}</em></article>
              <article><small>Food cost</small><strong>{rs(pnl.cogs)}</strong><em>{pnl.revenue ? ((pnl.cogs / pnl.revenue) * 100).toFixed(1) : 0}% of sales</em></article>
              <article><small>Gross profit</small><strong>{rs(pnl.grossProfit)}</strong><em>Sales minus recipe cost</em></article>
              <article><small>Net profit</small><strong>{rs(pnl.netProfit)}</strong><em>After waste {rs(pnl.waste)} and expenses {rs(pnl.expenses)}</em></article>
            </div>
            <table>
              <thead><tr><th>Line</th><th>Amount</th></tr></thead>
              <tbody>
                <tr><td>Order revenue</td><td>{rs(pnl.sales?.revenue)}</td></tr>
                <tr><td>VAT collected</td><td>{rs(pnl.sales?.vat)}</td></tr>
                <tr><td>Discounts</td><td>{rs(pnl.sales?.discounts)}</td></tr>
                <tr><td>Recipe COGS</td><td>{rs(pnl.cogs)}</td></tr>
                <tr><td>Accepted purchases</td><td>{rs(pnl.purchasing?.acceptedValue)}</td></tr>
                <tr><td>Purchase returns</td><td>{rs(pnl.purchasing?.returnedValue)}</td></tr>
                <tr><td>Net stock purchased</td><td>{rs(pnl.purchases)}</td></tr>
                <tr><td>Supplier invoiced</td><td>{rs(pnl.purchasing?.invoiced)}</td></tr>
                <tr><td>Supplier paid / due</td><td>{rs(pnl.purchasing?.paid)} / {rs(pnl.purchasing?.due)}</td></tr>
                <tr><td>Waste written off</td><td>{rs(pnl.waste)}</td></tr>
                <tr><td>Operating expenses</td><td>{rs(pnl.expenses)}</td></tr>
              </tbody>
            </table>
            <p>Source {pnl.source} · {pnl.currency} · branch {branch?.name || 'all'}</p>
          </div>
        )}
      </section>
      <section className="panel" style={{marginTop: 18}}>
        <h2>Menu engineering</h2>
        <p>Kasavan–Smith matrix from live orders (cancelled tickets excluded). Popularity is share of plates sold. Margin is menu price minus current recipe cost, NPR.</p>
        {!menu.length && !error && <p className="empty">No menu items to classify yet.</p>}
        {!!menu.length && (
        <table>
          <thead><tr><th>Menu item</th><th>Sold</th><th>Popularity</th><th>Contribution margin</th><th>Classification</th><th>Recommendation</th></tr></thead>
          <tbody>
            {menu.map(x => (
              <tr key={x.id || x.name}>
                <td><b>{x.name}</b></td>
                <td>{x.soldQty || 0}</td>
                <td>{(Number(x.popularity || 0) * 100).toFixed(1)}%</td>
                <td>{rs(x.margin)}</td>
                <td><label className={'pill ' + String(x.classification || '').toLowerCase()}>{x.classification}</label></td>
                <td>{x.classification === 'Star' ? 'Protect quality and feature it.' : x.classification === 'Dog' ? 'Review recipe or retire.' : 'Test promotion or pricing.'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </section>
    </>
  );
}
