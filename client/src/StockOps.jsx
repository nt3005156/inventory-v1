import React, {useEffect, useRef, useState} from 'react';
import {connectBranchSocket} from './socket.js';

const requestKey = prefix => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const WASTE_REASONS = ['expired', 'spoiled', 'burned', 'spilled', 'damaged', 'wrong_preparation', 'customer_return', 'other'];
const COUNT_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

function qtyLabel(qty, unit) {
  const n = Number(qty || 0);
  if (unit === 'g' || !unit) return (n / 1000).toFixed(2) + ' kg';
  return n.toLocaleString('en-NP', {maximumFractionDigits: 2}) + ' ' + unit;
}

function signedQty(qty, unit) {
  const n = Number(qty || 0);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${qtyLabel(Math.abs(n), unit)}`;
}

function rs(value) {
  return 'Rs. ' + Number(value || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'}) : '—';
}

function nextActions(status) {
  if (status === 'requested') return [{next: 'approved', label: 'Approve'}, {next: 'cancelled', label: 'Cancel', danger: true}];
  if (status === 'approved') return [{next: 'in_transit', label: 'Ship'}, {next: 'cancelled', label: 'Cancel', danger: true}];
  if (status === 'in_transit') return [{next: 'received', label: 'Receive'}];
  return [];
}

export default function StockOps({call, branches = [], user, token}) {
  const assigned = user?.branch || null;
  const locked = user?.role !== 'owner' && assigned;
  const visibleBranches = locked ? branches.filter(branch => String(branch._id) === String(assigned)) : branches;
  const canManage = ['owner', 'manager'].includes(user?.role);
  const userId = String(user?.id || user?._id || '');

  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [items, setItems] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [ingredient, setIngredient] = useState('');
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('spoiled');
  const [destination, setDestination] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);

  const [counts, setCounts] = useState([]);
  const [countSummary, setCountSummary] = useState({pending: 0});
  const [countFilter, setCountFilter] = useState('');
  const [countScope, setCountScope] = useState('full');
  const [countNotes, setCountNotes] = useState('');
  const [selectedIngredients, setSelectedIngredients] = useState({});
  const [selectedCount, setSelectedCount] = useState(null);
  const [physical, setPhysical] = useState({});
  const [dirtyLines, setDirtyLines] = useState({});
  const [decisionNote, setDecisionNote] = useState('');
  const [history, setHistory] = useState([]);

  const wasteKey = useRef(requestKey('waste'));
  const countCreateKey = useRef(requestKey('stock-count'));
  const decisionKey = useRef(requestKey('stock-count-decision'));
  const loadSequence = useRef(0);
  const loadRef = useRef(null);
  const authToken = token || (typeof localStorage !== 'undefined' ? localStorage.token : '');

  useEffect(() => {
    if (locked && assigned && String(branchId) !== String(assigned)) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const hydrateCount = count => {
    setSelectedCount(count);
    setPhysical(Object.fromEntries((count?.lines || []).map(line => [line._id, line.physicalQty == null ? '' : String(line.physicalQty)])));
    setDirtyLines({});
    setDecisionNote(count?.decisionNote || '');
  };

  const loadHistory = async count => {
    if (!count?._id) return setHistory([]);
    try {
      const rows = await call(`/stock-counts/${count._id}/history`);
      setHistory(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.message || 'Could not load stock count history');
    }
  };

  const openCount = async countOrId => {
    const id = typeof countOrId === 'string' ? countOrId : countOrId?._id;
    if (!id) return;
    setBusy('open-count');
    setError('');
    try {
      const count = await call(`/stock-counts/${id}`);
      hydrateCount(count);
      await loadHistory(count);
    } catch (err) {
      setError(err.message || 'Could not load stock count');
    } finally {
      setBusy('');
    }
  };

  const load = async ({preserveCount = true} = {}) => {
    if (!branchId) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    try {
      const [balances, allBranches, rows, countResult, options] = await Promise.all([
        call('/inventory/balances?branch=' + encodeURIComponent(branchId)),
        call('/branches'),
        call('/transfers?branch=' + encodeURIComponent(branchId)),
        call('/stock-counts?branch=' + encodeURIComponent(branchId)),
        call('/supplier-catalog/options')
      ]);
      if (sequence !== loadSequence.current) return;
      setItems(Array.isArray(balances) ? balances : []);
      setDestinations((allBranches || []).filter(branch => String(branch._id) !== String(branchId)));
      setTransfers(Array.isArray(rows) ? rows : []);
      setCounts(Array.isArray(countResult?.items) ? countResult.items : []);
      setCountSummary(countResult?.summary || {pending: 0});
      setIngredients(Array.isArray(options?.ingredients) ? options.ingredients : []);
      if (preserveCount && selectedCount?._id) {
        const current = countResult?.items?.find(count => String(count._id) === String(selectedCount._id));
        if (current) hydrateCount(current);
      }
    } catch (err) {
      if (sequence === loadSequence.current) setError(err.message || 'Could not load stock operations');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };

  loadRef.current = load;

  useEffect(() => {
    setIngredient('');
    setDestination('');
    setMessage('');
    setSelectedCount(null);
    setHistory([]);
    setPhysical({});
    setDirtyLines({});
    load({preserveCount: false});
  }, [branchId]);

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
        if (joinError || !ack?.ok) setError(ack?.message || 'Could not join stock operations room');
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

  const waste = async event => {
    event.preventDefault();
    setBusy('waste');
    setError('');
    setMessage('');
    try {
      await call('/waste/record', {
        method: 'POST',
        headers: {'Idempotency-Key': wasteKey.current},
        body: JSON.stringify({branch: branchId, ingredient, qty: Number(qty), reason})
      });
      wasteKey.current = requestKey('waste');
      setMessage('Waste recorded and inventory ledger updated.');
      await load();
    } catch (err) {
      setError(err.message || 'Could not record waste');
    } finally {
      setBusy('');
    }
  };

  const requestTransfer = async event => {
    event.preventDefault();
    setBusy('transfer');
    setError('');
    setMessage('');
    try {
      await call('/transfers', {
        method: 'POST',
        body: JSON.stringify({fromBranch: branchId, toBranch: destination, ingredient, qty: Number(qty)})
      });
      setMessage('Transfer request created.');
      await load();
    } catch (err) {
      setError(err.message || 'Could not request transfer');
    } finally {
      setBusy('');
    }
  };

  const act = async (row, status) => {
    setBusy(row._id + status);
    setError('');
    setMessage('');
    try {
      await call('/transfers/' + row._id + '/status', {method: 'PATCH', body: JSON.stringify({status})});
      setMessage(status === 'received' ? 'Transfer received on the destination ledger.' : status === 'in_transit' ? 'Stock left the source branch.' : 'Transfer updated.');
      await load();
    } catch (err) {
      setError(err.message || 'Could not update transfer');
    } finally {
      setBusy('');
    }
  };

  const createCount = async event => {
    event.preventDefault();
    const ingredientIds = Object.keys(selectedIngredients).filter(id => selectedIngredients[id]);
    if (countScope === 'cycle' && !ingredientIds.length) {
      setError('Select at least one ingredient for a cycle count.');
      return;
    }
    setBusy('create-count');
    setError('');
    setMessage('');
    try {
      const count = await call('/stock-counts', {
        method: 'POST',
        headers: {'Idempotency-Key': countCreateKey.current},
        body: JSON.stringify({branch: branchId, scope: countScope, ingredientIds, notes: countNotes})
      });
      countCreateKey.current = requestKey('stock-count');
      setCountNotes('');
      setSelectedIngredients({});
      hydrateCount(count);
      setMessage(`${count.scope === 'full' ? 'Full' : 'Cycle'} count ${count.countNo} created with locked system-stock snapshots.`);
      await load();
      await loadHistory(count);
    } catch (err) {
      setError(err.message || 'Could not create stock count');
    } finally {
      setBusy('');
    }
  };

  const savePhysical = async () => {
    const lines = Object.keys(dirtyLines).map(lineId => ({
      lineId,
      physicalQty: physical[lineId] === '' ? null : Number(physical[lineId])
    }));
    if (!lines.length) {
      setError('Enter or clear at least one physical quantity before saving.');
      return;
    }
    setBusy('save-count');
    setError('');
    setMessage('');
    try {
      const count = await call(`/stock-counts/${selectedCount._id}`, {
        method: 'PATCH',
        body: JSON.stringify({expectedVersion: selectedCount.__v, lines})
      });
      hydrateCount(count);
      setMessage('Physical quantities and variances saved.');
      await load();
      await loadHistory(count);
    } catch (err) {
      setError(err.message || 'Could not save physical count');
    } finally {
      setBusy('');
    }
  };

  const submitCount = async () => {
    if (!globalThis.confirm?.('Submit this count for approval? Physical entries become read-only.')) return;
    setBusy('submit-count');
    setError('');
    setMessage('');
    try {
      const count = await call(`/stock-counts/${selectedCount._id}/submit`, {
        method: 'POST',
        body: JSON.stringify({expectedVersion: selectedCount.__v, note: decisionNote || undefined})
      });
      hydrateCount(count);
      setMessage(`${count.countNo} submitted for independent approval.`);
      await load();
      await loadHistory(count);
    } catch (err) {
      setError(err.message || 'Could not submit stock count');
    } finally {
      setBusy('');
    }
  };

  const decideCount = async decision => {
    if (decision === 'rejected' && decisionNote.trim().length < 3) {
      setError('Enter a rejection reason of at least 3 characters.');
      return;
    }
    const verb = decision === 'approved' ? 'approve and post all non-zero variances to the inventory ledger' : 'reject';
    if (!globalThis.confirm?.(`Confirm that you want to ${verb} this count?`)) return;
    setBusy(`count-${decision}`);
    setError('');
    setMessage('');
    try {
      const count = await call(`/stock-counts/${selectedCount._id}/${decision === 'approved' ? 'approve' : 'reject'}`, {
        method: 'POST',
        headers: {'Idempotency-Key': decisionKey.current},
        body: JSON.stringify({expectedVersion: selectedCount.__v, note: decisionNote || undefined})
      });
      decisionKey.current = requestKey('stock-count-decision');
      hydrateCount(count);
      setMessage(decision === 'approved'
        ? `${count.countNo} approved. ${count.adjustmentTransactions?.length || 0} variance movement(s) posted atomically.`
        : `${count.countNo} rejected with audit evidence.`);
      await load();
      await loadHistory(count);
    } catch (err) {
      setError(err.message || `Could not ${decision === 'approved' ? 'approve' : 'reject'} stock count`);
    } finally {
      setBusy('');
    }
  };

  if (!visibleBranches.length) {
    return (
      <section className="panel">
        <h2>Stock operations</h2>
        <p className="empty">No branch is configured. Run the demo seed, then refresh.</p>
      </section>
    );
  }

  const activeCount = counts.find(count => ['draft', 'submitted'].includes(count.status));
  const visibleCounts = countFilter ? counts.filter(count => count.status === countFilter) : counts;
  const managerSelfApproval = user?.role === 'manager' && selectedCount && [selectedCount.createdBy, selectedCount.submittedBy]
    .some(actor => String(actor?._id || actor || '') === userId);
  const canEditSelected = selectedCount?.status === 'draft'
    && (user?.role === 'owner' || String(selectedCount?.createdBy?._id || selectedCount?.createdBy || '') === userId);
  const allCounted = selectedCount?.lines?.every(line => line.physicalQty != null);

  return (
    <section className="panel stock-ops-workspace">
      <div className="title">
        <div>
          <h2>Stock operations</h2>
          <p>Physical counts require approval and stale-snapshot checks. Waste and transfers remain direct operational ledger workflows.</p>
        </div>
        <select className="kds-branch" value={branchId} disabled={!!locked} onChange={event => setBranchId(event.target.value)}>
          {visibleBranches.map(branch => <option key={branch._id} value={branch._id}>{branch.name}</option>)}
        </select>
      </div>
      {error && <p className="danger stock-ops-alert" role="alert">{error}</p>}
      {message && <p className="inventory-success stock-ops-alert">{message}</p>}
      {loading && <p>Loading branch stock operations…</p>}

      <div className="count-heading">
        <div>
          <p className="eyebrow">CONTROLLED PHYSICAL INVENTORY</p>
          <h3>Stock counts &amp; approval</h3>
          <p>Variance = Physical Count − captured System Stock. Any later movement makes approval stale.</p>
        </div>
        <div className="count-kpis">
          <span><small>Counts shown</small><strong>{counts.length}</strong></span>
          <span className={Number(countSummary.pending || 0) ? 'attention' : ''}><small>Awaiting approval</small><strong>{Number(countSummary.pending || 0)}</strong></span>
        </div>
      </div>

      {!activeCount && (
        <form className="count-create" onSubmit={createCount}>
          <div>
            <label>Count scope
              <select value={countScope} onChange={event => setCountScope(event.target.value)}>
                <option value="full">Full branch inventory</option>
                <option value="cycle">Selected-ingredient cycle count</option>
              </select>
            </label>
            <label>Opening note
              <input maxLength="2000" value={countNotes} onChange={event => setCountNotes(event.target.value)} placeholder="Shift, sheet or count context"/>
            </label>
          </div>
          {countScope === 'cycle' && (
            <fieldset className="count-ingredient-picker">
              <legend>Select ingredients</legend>
              {!ingredients.length && <span>No active ingredients are available.</span>}
              {ingredients.map(item => (
                <label key={item._id}>
                  <input
                    type="checkbox"
                    checked={!!selectedIngredients[item._id]}
                    onChange={event => setSelectedIngredients(current => ({...current, [item._id]: event.target.checked}))}
                  />
                  <span><b>{item.name}</b><small>{item.code || 'No code'} · {item.unit}</small></span>
                </label>
              ))}
            </fieldset>
          )}
          <button disabled={!!busy || !branchId}>{busy === 'create-count' ? 'Capturing snapshots…' : 'Start physical count'}</button>
        </form>
      )}

      {activeCount && !selectedCount && (
        <button type="button" className="count-active-banner" onClick={() => openCount(activeCount)}>
          <span><b>{activeCount.countNo}</b> is {activeCount.status}. Only one active count is allowed for this branch.</span>
          <strong>Open count →</strong>
        </button>
      )}

      {selectedCount && (
        <div className="count-detail">
          <div className="count-detail-head">
            <div>
              <button type="button" className="text-action" onClick={() => { setSelectedCount(null); setHistory([]); }}>← Close detail</button>
              <h3>{selectedCount.countNo}</h3>
              <p>{selectedCount.scope === 'full' ? 'Full branch inventory' : 'Cycle count'} · Captured {dateTime(selectedCount.createdAt)} by {selectedCount.createdBy?.name || 'Unknown actor'}</p>
            </div>
            <span className={'pill count-' + selectedCount.status}>{selectedCount.status}</span>
          </div>

          <div className="count-summary-grid">
            <article><small>Ingredients</small><strong>{selectedCount.lines?.length || 0}</strong></article>
            <article><small>Counted</small><strong>{selectedCount.countedLineCount || 0}</strong></article>
            <article><small>Non-zero variance</small><strong>{selectedCount.varianceLineCount || 0}</strong></article>
            <article className={Number(selectedCount.totalVarianceValue || 0) < 0 ? 'negative' : Number(selectedCount.totalVarianceValue || 0) > 0 ? 'positive' : ''}><small>Variance value</small><strong>{rs(selectedCount.totalVarianceValue)}</strong></article>
          </div>

          <div className="table-scroll">
            <table className="count-lines">
              <thead><tr><th>Ingredient</th><th>System stock</th><th>Physical count</th><th>Variance</th><th>Value variance</th><th>Count evidence</th></tr></thead>
              <tbody>
                {selectedCount.lines?.map(line => {
                  const currentPhysical = physical[line._id];
                  const preview = currentPhysical === '' ? null : Number(currentPhysical) - Number(line.systemQty);
                  return (
                    <tr key={line._id}>
                      <td><b>{line.ingredientName}</b><small>{line.ingredientCode || 'No code'} · snapshot revision {line.balanceVersion}</small></td>
                      <td>{qtyLabel(line.systemQty, line.unit)}</td>
                      <td>
                        {canEditSelected ? (
                          <input
                            aria-label={`Physical quantity for ${line.ingredientName}`}
                            type="number"
                            min="0"
                            step="0.01"
                            value={currentPhysical}
                            onChange={event => {
                              const value = event.target.value;
                              setPhysical(current => ({...current, [line._id]: value}));
                              setDirtyLines(current => ({...current, [line._id]: true}));
                            }}
                          />
                        ) : line.physicalQty == null ? 'Not entered' : qtyLabel(line.physicalQty, line.unit)}
                      </td>
                      <td className={(preview ?? line.varianceQty) < 0 ? 'count-negative' : (preview ?? line.varianceQty) > 0 ? 'count-positive' : ''}>
                        {(preview ?? line.varianceQty) == null ? '—' : signedQty(preview ?? line.varianceQty, line.unit)}
                      </td>
                      <td>{line.varianceValue == null ? '—' : rs(line.varianceValue)}</td>
                      <td>{line.countedBy?.name || '—'}<small>{dateTime(line.countedAt)}</small></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {canEditSelected && (
            <div className="count-draft-actions">
              <p>{allCounted ? 'Every ingredient has a physical quantity. Save any changes, then submit.' : 'Enter every physical quantity, including zero, before submission.'}</p>
              <div>
                <button type="button" className="po-secondary" disabled={!!busy || !Object.keys(dirtyLines).length} onClick={savePhysical}>{busy === 'save-count' ? 'Saving…' : 'Save physical entries'}</button>
                <button type="button" disabled={!!busy || !allCounted || Object.keys(dirtyLines).length > 0} onClick={submitCount}>{busy === 'submit-count' ? 'Submitting…' : 'Submit for approval'}</button>
              </div>
            </div>
          )}

          {selectedCount.status === 'submitted' && canManage && (
            <div className="count-decision">
              <div>
                <h3>Independent count decision</h3>
                <p>{managerSelfApproval ? 'Manager self-approval is blocked. An owner must approve this count.' : 'Approval rechecks every captured ledger revision and posts all variances in one transaction.'}</p>
              </div>
              <label>Decision note / rejection reason
                <textarea value={decisionNote} maxLength="2000" onChange={event => setDecisionNote(event.target.value)} placeholder="Review evidence, discrepancy explanation or rejection reason"/>
              </label>
              <div>
                <button type="button" className="kds-cancel" disabled={!!busy} onClick={() => decideCount('rejected')}>{busy === 'count-rejected' ? 'Rejecting…' : 'Reject'}</button>
                <button type="button" disabled={!!busy || managerSelfApproval} onClick={() => decideCount('approved')}>{busy === 'count-approved' ? 'Approving…' : 'Approve & post variance'}</button>
              </div>
            </div>
          )}

          {['approved', 'rejected'].includes(selectedCount.status) && (
            <div className={'count-final ' + selectedCount.status}>
              <b>{selectedCount.status === 'approved' ? 'Approved' : 'Rejected'} by {selectedCount.approvedBy?.name || selectedCount.rejectedBy?.name || 'Unknown actor'}</b>
              <span>{dateTime(selectedCount.approvedAt || selectedCount.rejectedAt)} · {selectedCount.decisionNote || 'No decision note'}</span>
              {selectedCount.status === 'approved' && <small>{selectedCount.adjustmentTransactions?.length || 0} non-zero variance ledger movement(s)</small>}
            </div>
          )}

          <div className="count-history">
            <h3>Audit history</h3>
            {!history.length && <p className="empty">No audit events are available.</p>}
            {history.map(event => (
              <article key={event._id}>
                <time>{dateTime(event.at)}</time>
                <div><b>{String(event.action || '').replaceAll('_', ' ')}</b><small>{event.actor?.name || 'Unknown actor'} · {event.actor?.role || 'user'}</small>{event.reason && <p>{event.reason}</p>}</div>
              </article>
            ))}
          </div>
        </div>
      )}

      <div className="count-list-heading">
        <div><h3>Count register</h3><p>Branch-scoped lifecycle, actors, variance totals, and decision evidence.</p></div>
        <select value={countFilter} onChange={event => setCountFilter(event.target.value)}>
          <option value="">All statuses</option>
          {COUNT_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
        </select>
      </div>
      {!visibleCounts.length && !loading && <p className="empty">No stock counts match this view.</p>}
      {!!visibleCounts.length && (
        <div className="table-scroll">
          <table className="count-register">
            <thead><tr><th>Count</th><th>Scope</th><th>Status</th><th>Progress</th><th>Variance</th><th>Created</th><th>Decision</th><th></th></tr></thead>
            <tbody>
              {visibleCounts.map(count => (
                <tr key={count._id}>
                  <td><b>{count.countNo}</b><small>{count.createdBy?.name || 'Unknown actor'}</small></td>
                  <td>{count.scope}</td>
                  <td><span className={'pill count-' + count.status}>{count.status}</span></td>
                  <td>{count.countedLineCount || 0} / {count.lines?.length || 0}</td>
                  <td>{count.varianceLineCount || 0} line(s)<small>{rs(count.totalVarianceValue)}</small></td>
                  <td>{dateTime(count.createdAt)}</td>
                  <td>{count.approvedBy?.name || count.rejectedBy?.name || count.submittedBy?.name || 'Draft'}<small>{dateTime(count.approvedAt || count.rejectedAt || count.submittedAt)}</small></td>
                  <td><button type="button" className="receive" disabled={!!busy} onClick={() => openCount(count)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="stock-direct-heading">
        <h3>Direct stock operations</h3>
        <p>Waste posts immediately. Transfers move ledger quantity after approve → ship → receive.</p>
      </div>
      <div className="stockforms">
        <form onSubmit={waste}>
          <h3>Record waste</h3>
          <select required value={ingredient} onChange={event => setIngredient(event.target.value)}>
            <option value="">Ingredient</option>
            {items.map(item => (
              <option key={item._id} value={item.ingredient?._id}>
                {item.ingredient?.name} — {item.quantity} {item.ingredient?.unit}
              </option>
            ))}
          </select>
          <input required type="number" min=".01" step=".01" value={qty} onChange={event => setQty(event.target.value)} />
          <select value={reason} onChange={event => setReason(event.target.value)}>
            {WASTE_REASONS.map(item => <option key={item}>{item}</option>)}
          </select>
          <button disabled={!!busy}>{busy === 'waste' ? 'Recording…' : 'Record waste'}</button>
        </form>
        <form onSubmit={requestTransfer}>
          <h3>Request transfer</h3>
          <select required value={ingredient} onChange={event => setIngredient(event.target.value)}>
            <option value="">Ingredient</option>
            {items.map(item => (
              <option key={'t-' + item._id} value={item.ingredient?._id}>{item.ingredient?.name}</option>
            ))}
          </select>
          <select required value={destination} onChange={event => setDestination(event.target.value)}>
            <option value="">Destination branch</option>
            {destinations.map(item => <option key={item._id} value={item._id}>{item.name}</option>)}
          </select>
          <input required type="number" min=".01" step=".01" value={qty} onChange={event => setQty(event.target.value)} />
          <button disabled={!!busy}>{busy === 'transfer' ? 'Requesting…' : 'Request transfer'}</button>
        </form>
      </div>

      <h3>Branch transfers</h3>
      {!transfers.length && <p className="empty">No transfer requests for this branch.</p>}
      {!!transfers.length && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Ingredient</th><th>From</th><th>To</th><th>Qty</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {transfers.map(row => (
                <tr key={row._id}>
                  <td><b>{row.ingredient?.name || 'Ingredient'}</b></td>
                  <td>{row.fromBranch?.name || '—'}</td>
                  <td>{row.toBranch?.name || '—'}</td>
                  <td>{qtyLabel(row.qty, row.unit || row.ingredient?.unit)}</td>
                  <td><label className={'pill ' + row.status}>{row.status.replace('_', ' ')}</label></td>
                  <td>
                    {canManage && nextActions(row.status).map(action => (
                      <button
                        key={action.next}
                        type="button"
                        className={action.danger ? 'kds-cancel' : 'receive'}
                        disabled={!!busy}
                        onClick={() => act(row, action.next)}
                      >
                        {busy === row._id + action.next ? 'Updating…' : action.label}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
