import React, {useEffect, useRef, useState} from 'react';
import {connectBranchSocket} from './socket.js';

const MOVEMENT_TYPES = ['OPENING','PURCHASE','SALE','RECIPE_DEDUCTION','REVERSAL','WASTE','TRANSFER_OUT','TRANSFER_IN','RETURN','ADJUSTMENT'];
const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});
const requestKey = () => globalThis.crypto?.randomUUID?.() || `inventory-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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

function dateLabel(value) {
  if (!value) return 'No expiry';
  return new Date(value).toLocaleDateString('en-NP', {timeZone: 'Asia/Kathmandu', year: 'numeric', month: 'short', day: 'numeric'});
}

function dateTimeLabel(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'});
}

function batchStatusLabel(status) {
  return status === 'no_expiry' ? 'No expiry' : String(status || '').replaceAll('_', ' ');
}

export default function Inventory({call, branches = [], user, token}) {
  const assigned = user?.branch || null;
  const locked = user?.role !== 'owner' && assigned;
  const canManage = ['owner', 'manager'].includes(user?.role);
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [rows, setRows] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [ledgerType, setLedgerType] = useState('');
  const [batches, setBatches] = useState([]);
  const [batchSummary, setBatchSummary] = useState({activeLots: 0, totalQty: 0, expiredQty: 0, expiringQty: 0, noExpiryQty: 0});
  const [batchStatus, setBatchStatus] = useState('');
  const [batchSearch, setBatchSearch] = useState('');
  const [batchPage, setBatchPage] = useState(1);
  const [batchPagination, setBatchPagination] = useState({page: 1, pages: 1, total: 0});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [ingredient, setIngredient] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [adjustBatch, setAdjustBatch] = useState('');
  const [adjustExpiry, setAdjustExpiry] = useState('');
  const adjustmentKey = useRef(requestKey());
  const loadSequence = useRef(0);
  const loadRef = useRef(null);
  const authToken = token || (typeof localStorage !== 'undefined' ? localStorage.token : '');

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    const query = new URLSearchParams();
    if (branchId) query.set('branch', branchId);
    if (batchStatus) query.set('status', batchStatus);
    if (batchSearch.trim()) query.set('q', batchSearch.trim());
    query.set('days', '30');
    query.set('page', String(batchPage));
    query.set('limit', '50');
    const balanceQuery = branchId ? '?branch=' + encodeURIComponent(branchId) : '';
    try {
      const jobs = [call('/inventory' + balanceQuery), call('/inventory/batches?' + query.toString())];
      const movementQuery = new URLSearchParams();
      if (branchId) movementQuery.set('branch', branchId);
      if (ledgerType) movementQuery.set('type', ledgerType);
      if (canManage) jobs.push(call('/inventory/transactions?' + movementQuery.toString()));
      const [balances, batchResult, txs = []] = await Promise.all(jobs);
      if (sequence !== loadSequence.current) return;
      setRows(Array.isArray(balances) ? balances : []);
      setBatches(Array.isArray(batchResult?.items) ? batchResult.items : []);
      setBatchSummary(batchResult?.summary || {});
      setBatchPagination(batchResult?.pagination || {page: 1, pages: 1, total: 0});
      setLedger(Array.isArray(txs) ? txs : []);
    } catch (e) {
      if (sequence === loadSequence.current) setError(e.message || 'Could not load inventory');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };

  loadRef.current = load;

  useEffect(() => {
    setIngredient('');
    setSuccess('');
    load();
  }, [branchId, batchStatus, batchPage, ledgerType]);

  useEffect(() => {
    if (!branchId || !authToken) return undefined;
    let active = true;
    const socket = connectBranchSocket(authToken, branchId);
    const refresh = event => {
      if (String(event?.branch || '') === String(branchId)) loadRef.current?.();
    };
    socket.on('connect', () => {
      socket.timeout(5000).emit('join:branch', branchId, (joinError, ack) => {
        if (!active) return;
        if (joinError || !ack?.ok) {
          setError(ack?.message || 'Could not join inventory room');
          return;
        }
        loadRef.current?.();
      });
    });
    socket.on('inventory:update', refresh);
    return () => {
      active = false;
      socket.emit('leave:branch', branchId);
      socket.off('inventory:update', refresh);
      socket.disconnect();
    };
  }, [authToken, branchId]);

  const adjust = async event => {
    event.preventDefault();
    if (!canManage || !branchId) return;
    const amount = Number(qty);
    if (amount > 0 && adjustExpiry && !adjustBatch.trim()) {
      setError('Enter a batch number when adding stock with an expiry date');
      return;
    }
    setBusy('adjust');
    setError('');
    setSuccess('');
    try {
      await call('/inventory/adjustments', {
        method: 'POST',
        headers: {'Idempotency-Key': adjustmentKey.current},
        body: JSON.stringify({
          branch: branchId,
          ingredient,
          qty: amount,
          reason,
          batchNumber: adjustBatch.trim() || undefined,
          expiryDate: amount > 0 ? adjustExpiry || undefined : undefined
        })
      });
      setQty('');
      setReason('');
      setAdjustBatch('');
      setAdjustExpiry('');
      adjustmentKey.current = requestKey();
      setSuccess('Count adjustment posted to the aggregate and batch ledgers.');
      await load();
    } catch (err) {
      setError(err.message || 'Could not post adjustment');
    } finally {
      setBusy('');
    }
  };

  const totalValue = rows.reduce((sum, item) => sum + Number(item.stockValue || 0), 0);

  return (
    <section className="panel inventory-workspace">
      <div className="title">
        <div>
          <h2>Live ingredient inventory</h2>
          <p>Aggregate on-hand and valuation stay tied to lot-level batch movements. Usable stock excludes expired lots and issues FEFO.</p>
        </div>
        <select className="kds-branch" value={branchId} disabled={!!locked} onChange={event => { setBatchPage(1); setBranchId(event.target.value); }}>
          {!locked && <option value="">All branches</option>}
          {visibleBranches.map(branch => <option key={branch._id} value={branch._id}>{branch.name}</option>)}
        </select>
      </div>
      {error && <p className="danger" role="alert">{error}</p>}
      {success && <p className="inventory-success">{success}</p>}
      {loading && <p>Loading aggregate and batch stock…</p>}
      {!loading && !rows.length && !error && <p className="empty">No ledger balances in this scope.</p>}
      {!loading && !!rows.length && (
        <>
          <div className="inventory-summary-grid">
            <span><small>Ledger value</small><strong>{rs(totalValue)}</strong></span>
            <span><small>Active lots</small><strong>{Number(batchSummary.activeLots || 0)}</strong></span>
            <span className={Number(batchSummary.expiredQty || 0) > 0 ? 'danger-card' : ''}><small>Expired qty</small><strong>{Number(batchSummary.expiredQty || 0).toLocaleString('en-NP')}</strong></span>
            <span className={Number(batchSummary.expiringQty || 0) > 0 ? 'warning-card' : ''}><small>Due in 30 days</small><strong>{Number(batchSummary.expiringQty || 0).toLocaleString('en-NP')}</strong></span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ingredient</th>
                  {!branchId && <th>Branch</th>}
                  <th>On hand</th>
                  <th>Usable</th>
                  <th>Lots</th>
                  <th>Next expiry</th>
                  <th>Avg. cost</th>
                  <th>Value</th>
                  <th>Minimum</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(item => (
                  <tr key={item._id}>
                    <td><b>{item.name}</b><small>{item.code}{item.category ? ` · ${item.category}` : ''}</small></td>
                    {!branchId && <td>{item.branchName || '—'}</td>}
                    <td>{qtyLabel(item.stockQty, item.unit)}</td>
                    <td>{qtyLabel(item.usableQty, item.unit)}{Number(item.expiredQty || 0) > 0 && <small className="batch-expired-note">{qtyLabel(item.expiredQty, item.unit)} expired</small>}</td>
                    <td>{item.batchCount || 0}</td>
                    <td>{dateLabel(item.nearestExpiry)}</td>
                    <td>{item.unit === 'g' || !item.unit ? rs(item.averageCost * 1000) + '/kg' : rs(item.averageCost) + '/' + item.unit}</td>
                    <td>{rs(item.stockValue)}</td>
                    <td>{minLabel(item.minimumStock, item.unit)}</td>
                    <td><label className={'pill ' + item.status}>{item.status === 'ok' ? 'Healthy' : item.status}</label></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="inventory-section-heading">
        <div><h3>Batch &amp; expiry register</h3><p>Active lots are traceable to their source. Expiring means the expiry date is within 30 Kathmandu calendar days.</p></div>
        <form className="inventory-batch-filters" onSubmit={event => { event.preventDefault(); if (batchPage === 1) load(); else setBatchPage(1); }}>
          <input value={batchSearch} onChange={event => setBatchSearch(event.target.value)} placeholder="Batch, ingredient, code"/>
          <select value={batchStatus} onChange={event => { setBatchPage(1); setBatchStatus(event.target.value); }}>
            <option value="">Active lots</option>
            <option value="expired">Expired</option>
            <option value="expiring">Expiring</option>
            <option value="fresh">Fresh</option>
            <option value="no_expiry">No expiry</option>
            <option value="depleted">Depleted</option>
          </select>
          <button type="submit" disabled={loading}>Apply</button>
        </form>
      </div>
      {!loading && !batches.length && <p className="empty">No batches match this view.</p>}
      {!!batches.length && (
        <>
          <div className="table-scroll">
            <table className="batch-register">
              <thead><tr><th>Ingredient</th>{!branchId && <th>Branch</th>}<th>Batch</th><th>Expiry</th><th>Status</th><th>Available</th><th>Received</th><th>Receipt cost</th><th>Source</th></tr></thead>
              <tbody>
                {batches.map(batch => (
                  <tr key={batch._id}>
                    <td><b>{batch.ingredientName}</b><small>{batch.ingredientCode}</small></td>
                    {!branchId && <td>{batch.branchName || '—'}</td>}
                    <td><code>{batch.batchNumber || 'UNTRACKED'}</code></td>
                    <td>{dateLabel(batch.expiryDate)}</td>
                    <td><span className={'pill batch-' + batch.status}>{batchStatusLabel(batch.status)}</span></td>
                    <td>{qtyLabel(batch.quantity, batch.unit)}<small>of {qtyLabel(batch.initialQuantity, batch.unit)}</small></td>
                    <td>{dateTimeLabel(batch.receivedAt)}</td>
                    <td>{rs(batch.unitCost)} / {batch.unit}<small>{rs(batch.stockValue)} remaining</small></td>
                    <td>{String(batch.sourceType || '').replaceAll('_', ' ')}{batch.supplier?.name && <small>{batch.supplier.name}</small>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inventory-pagination">
            <span>Page {batchPagination.page || 1} of {batchPagination.pages || 1} · {Number(batchPagination.total || 0).toLocaleString('en-NP')} lots</span>
            <div>
              <button type="button" disabled={loading || batchPage <= 1} onClick={() => setBatchPage(page => Math.max(1, page - 1))}>Previous</button>
              <button type="button" disabled={loading || batchPage >= Number(batchPagination.pages || 1)} onClick={() => setBatchPage(page => page + 1)}>Next</button>
            </div>
          </div>
        </>
      )}

      {canManage && branchId && (
        <>
          <h3>Count adjustment</h3>
          <p>Positive stock can carry a batch and expiry. Negative stock uses the named batch when supplied; otherwise it removes FEFO and may include expired lots for count reconciliation.</p>
          <form className="purchaseform inventory-adjustment" onSubmit={adjust}>
            <select required value={ingredient} onChange={event => setIngredient(event.target.value)}>
              <option value="">Ingredient</option>
              {rows.map(item => <option key={item._id} value={item.ingredientId}>{item.name} — {qtyLabel(item.stockQty, item.unit)}</option>)}
            </select>
            <input required type="number" step="0.01" value={qty} onChange={event => setQty(event.target.value)} placeholder="Qty change"/>
            <input required minLength={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason"/>
            <input maxLength="120" value={adjustBatch} onChange={event => setAdjustBatch(event.target.value)} placeholder="Batch (optional)"/>
            <input type="date" value={adjustExpiry} onChange={event => setAdjustExpiry(event.target.value)} disabled={Number(qty || 0) < 0}/>
            <button disabled={!!busy}>{busy === 'adjust' ? 'Posting…' : 'Post adjustment'}</button>
          </form>
        </>
      )}

      {canManage && (
        <>
          <div className="inventory-section-heading">
            <div><h3>Ledger movements</h3><p>Every quantity change includes its actor, reason, reference, cost, timestamp and idempotency key.</p></div>
            <select aria-label="Movement type" value={ledgerType} onChange={event => setLedgerType(event.target.value)}>
              <option value="">All movement types</option>
              {MOVEMENT_TYPES.map(type => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}
            </select>
          </div>
          {!ledger.length && !loading && <p className="empty">No ledger movements match this view.</p>}
          {!!ledger.length && (
            <div className="table-scroll">
              <table>
                <thead><tr><th>When</th><th>Type</th><th>Ingredient</th>{!branchId && <th>Branch</th>}<th>Previous</th><th>Change</th><th>New</th><th>Cost</th><th>Actor &amp; reference</th><th>Batch allocation</th><th>Reason &amp; key</th></tr></thead>
                <tbody>
                  {ledger.map(tx => (
                    <tr key={tx._id}>
                      <td>{dateTimeLabel(tx.timestamp || tx.createdAt)}</td>
                      <td><label className="pill">{String(tx.type || '').replaceAll('_', ' ')}</label></td>
                      <td>{tx.name}</td>
                      {!branchId && <td>{tx.branchName || '—'}</td>}
                      <td>{qtyLabel(tx.previousQty, tx.unit)}</td>
                      <td>{signedQty(tx.changeQty, tx.unit)}</td>
                      <td>{qtyLabel(tx.newQty, tx.unit)}</td>
                      <td>{rs(tx.totalCost)}<small>{rs(tx.unitCost)} / {tx.unit}</small></td>
                      <td><b>{tx.userName || tx.userId || 'Unknown actor'}</b><small>{tx.userRole || 'user'} · {tx.referenceType}</small><small><code>{String(tx.referenceId || '')}</code></small></td>
                      <td>{tx.batchMovements?.length ? tx.batchMovements.map((movement, index) => <small key={`${movement.batchId}-${index}`}>{movement.batchNumber || 'UNTRACKED'} · {signedQty(movement.changeQty, tx.unit)}{movement.expiryDate ? ` · ${dateLabel(movement.expiryDate)}` : ''}</small>) : 'No lot allocation'}</td>
                      <td>{tx.reason}<small><code>{tx.idempotencyKey}</code></small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
