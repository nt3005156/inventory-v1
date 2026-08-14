import React, {useEffect, useState} from 'react';
import {CircleCheck, LockKeyhole, RotateCcw, TriangleAlert} from 'lucide-react';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});

function previousNepalMonth() {
  const local = new Date(Date.now() + (5 * 60 + 45) * 60000);
  let year = local.getUTCFullYear();
  let month = local.getUTCMonth();
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

export default function MonthClose({call, branches = [], user}) {
  const owner = user?.role === 'owner';
  const assigned = user?.branch || '';
  const locked = !owner;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(locked ? assigned : '');
  const [month, setMonth] = useState(previousNepalMonth());
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
  }, [locked, assigned, branchId]);

  const query = includeMonth => {
    const params = new URLSearchParams();
    if (includeMonth) params.set('month', month);
    if (branchId) params.set('branch', branchId);
    return '?' + params.toString();
  };

  const load = () => {
    if (!month || (locked && !branchId)) return;
    setLoading(true);
    setError('');
    Promise.all([
      call('/month-close/preview' + query(true)),
      call('/month-close' + query(false))
    ]).then(([nextPreview, rows]) => {
      setPreview(nextPreview);
      setHistory(Array.isArray(rows) ? rows : []);
    }).catch(e => setError(e.message || 'Could not load month close'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [month, branchId]);

  const closeMonth = async () => {
    if (!owner || !preview?.ready) return;
    if (!window.confirm(`Close ${month} for ${branchId ? 'this branch' : 'all branches'}? The figures will be locked.`)) return;
    setBusy('close');
    setError('');
    try {
      await call('/month-close', {
        method: 'POST',
        body: JSON.stringify({month, branch: branchId || null, notes})
      });
      setNotes('');
      load();
    } catch (e) {
      setError(e.message || 'Could not close month');
    } finally {
      setBusy('');
    }
  };

  const reopen = async row => {
    if (!owner) return;
    const reason = window.prompt(`Why are you reopening ${row.month} revision ${row.revision}?`);
    if (!reason) return;
    setBusy('reopen-' + row._id);
    setError('');
    try {
      await call(`/month-close/${row._id}/reopen`, {
        method: 'POST',
        body: JSON.stringify({reason})
      });
      load();
    } catch (e) {
      setError(e.message || 'Could not reopen month');
    } finally {
      setBusy('');
    }
  };

  const p = preview?.pnl || {};
  const scopeName = branchId ? (branches.find(b => b._id === branchId)?.name || 'Branch') : 'All branches';

  return (
    <>
      <section className="panel month-close">
        <div className="title">
          <div>
            <h2>Accounting month close</h2>
            <p>Reconcile live orders, purchasing, expenses, waste and the append-only stock ledger. Closed NPR figures stay locked even if operations are edited later.</p>
          </div>
          <div className="month-toolbar">
            <input type="month" value={month} onChange={e => setMonth(e.target.value)}/>
            <select className="kds-branch" value={branchId} disabled={locked} onChange={e => setBranchId(e.target.value)}>
              {owner && <option value="">All branches</option>}
              {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
          </div>
        </div>
        {error && <p className="danger">{error}</p>}
        {loading && !preview && <p>Reconciling month…</p>}
        {preview && (
          <>
            <div className={'close-status ' + (preview.ready ? 'ready' : 'blocked')}>
              {preview.ready ? <CircleCheck size={21}/> : <TriangleAlert size={21}/>} 
              <div>
                <b>{preview.ready ? `${month} is ready to close` : `${month} is not ready to close`}</b>
                <span>{scopeName} · Asia/Kathmandu · {preview.closable ? 'completed period' : 'month still open'}</span>
              </div>
            </div>
            {!!preview.blockers?.length && (
              <div className="close-list danger-list"><b>Resolve before close</b>{preview.blockers.map(x => <span key={x}>{x}</span>)}</div>
            )}
            {!!preview.warnings?.length && (
              <div className="close-list warning-list"><b>Review</b>{preview.warnings.map(x => <span key={x}>{x}</span>)}</div>
            )}
            <div className="kpis">
              <article><small>Revenue</small><strong>{rs(p.revenue)}</strong><em>{p.sales?.orders || 0} orders</em></article>
              <article><small>Recipe COGS</small><strong>{rs(p.cogs)}</strong><em>{p.revenue ? ((p.cogs / p.revenue) * 100).toFixed(1) : 0}% food cost</em></article>
              <article><small>Net profit</small><strong>{rs(p.netProfit)}</strong><em>Waste {rs(p.waste)} · expenses {rs(p.expenses)}</em></article>
              <article><small>Closing inventory</small><strong>{rs(preview.inventory?.closing?.value)}</strong><em>Opening {rs(preview.inventory?.opening?.value)}</em></article>
            </div>
            <div className="close-grid">
              <table>
                <tbody>
                  <tr><td>Gross profit</td><td>{rs(p.grossProfit)}</td></tr>
                  <tr><td>Net stock purchased</td><td>{rs(p.purchases)}</td></tr>
                  <tr><td>VAT collected</td><td>{rs(p.sales?.vat)}</td></tr>
                  <tr><td>Supplier due</td><td>{rs(p.purchasing?.due)}</td></tr>
                </tbody>
              </table>
              <table>
                <tbody>
                  <tr><td>Open orders</td><td>{preview.reconciliation?.openOrders || 0}</td></tr>
                  <tr><td>Open purchase orders</td><td>{preview.reconciliation?.openPurchaseOrders || 0}</td></tr>
                  <tr><td>Unpaid invoices</td><td>{preview.reconciliation?.unpaidInvoices || 0}</td></tr>
                  <tr><td>Untracked balances</td><td>{preview.reconciliation?.untrackedBalances || 0}</td></tr>
                </tbody>
              </table>
            </div>
            {owner ? (
              <div className="close-action">
                <input maxLength="500" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Close notes (optional)"/>
                <button onClick={closeMonth} disabled={!preview.ready || !!busy}>
                  <LockKeyhole size={16}/> {busy === 'close' ? 'Closing…' : `Lock ${month}`}
                </button>
              </div>
            ) : <p className="empty">Managers can reconcile their assigned branch. Only the owner can lock or reopen a month.</p>}
          </>
        )}
      </section>

      <section className="panel" style={{marginTop: 18}}>
        <div className="title"><div><h2>Close history</h2><p>Every correction creates a new revision. Reopened revisions retain their original figures and audit metadata.</p></div></div>
        {!history.length && !loading && <p className="empty">No month has been closed for this scope.</p>}
        {!!history.length && (
          <table>
            <thead><tr><th>Month</th><th>Scope</th><th>Revision</th><th>Status</th><th>Revenue</th><th>Net profit</th><th>Inventory</th><th>Closed by</th><th></th></tr></thead>
            <tbody>
              {history.map(row => (
                <tr key={row._id}>
                  <td><b>{row.month}</b></td>
                  <td>{row.branch?.name || 'All branches'}</td>
                  <td>v{row.revision}</td>
                  <td><label className={'pill close-' + row.status}>{row.status}</label></td>
                  <td>{rs(row.revenue)}</td>
                  <td>{rs(row.netProfit)}</td>
                  <td>{rs(row.closingInventory)}</td>
                  <td>{row.closedBy?.name || '—'}<small className="cell-sub">{row.closedAt ? new Date(row.closedAt).toLocaleString('en-NP') : ''}</small></td>
                  <td>{owner && row.status === 'closed' && <button className="receive" disabled={!!busy} onClick={() => reopen(row)}><RotateCcw size={14}/> {busy === 'reopen-' + row._id ? 'Reopening…' : 'Reopen'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
