import React, {useEffect, useState} from 'react';

const WASTE_REASONS = ['expired', 'spoiled', 'burned', 'spilled', 'damaged', 'wrong_preparation', 'customer_return', 'other'];

function qtyLabel(qty, unit) {
  const n = Number(qty || 0);
  if (unit === 'g' || !unit) return (n / 1000).toFixed(2) + ' kg';
  return n.toLocaleString('en-NP', {maximumFractionDigits: 2}) + ' ' + unit;
}

function nextActions(status) {
  if (status === 'requested') return [{next: 'approved', label: 'Approve'}, {next: 'cancelled', label: 'Cancel', danger: true}];
  if (status === 'approved') return [{next: 'in_transit', label: 'Ship'}, {next: 'cancelled', label: 'Cancel', danger: true}];
  if (status === 'in_transit') return [{next: 'received', label: 'Receive'}];
  return [];
}

export default function StockOps({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;
  const canManage = ['owner', 'manager'].includes(user?.role);

  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [items, setItems] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [ingredient, setIngredient] = useState('');
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('spoiled');
  const [destination, setDestination] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const load = () => {
    if (!branchId) return;
    setError('');
    Promise.all([
      call('/inventory/balances?branch=' + branchId),
      call('/branches'),
      call('/transfers?branch=' + branchId)
    ]).then(([balances, allBranches, rows]) => {
      setItems(Array.isArray(balances) ? balances : []);
      setDestinations((allBranches || []).filter(x => x._id !== branchId));
      setTransfers(Array.isArray(rows) ? rows : []);
    }).catch(e => setError(e.message || 'Could not load stock operations'));
  };

  useEffect(() => {
    setIngredient('');
    setDestination('');
    setMessage('');
    load();
  }, [branchId]);

  const waste = async e => {
    e.preventDefault();
    setBusy('waste');
    setError('');
    setMessage('');
    try {
      await call('/waste/record', {
        method: 'POST',
        body: JSON.stringify({branch: branchId, ingredient, qty: Number(qty), reason})
      });
      setMessage('Waste recorded and inventory ledger updated.');
      load();
    } catch (err) {
      setError(err.message || 'Could not record waste');
    } finally {
      setBusy('');
    }
  };

  const requestTransfer = async e => {
    e.preventDefault();
    setBusy('transfer');
    setError('');
    setMessage('');
    try {
      await call('/transfers', {
        method: 'POST',
        body: JSON.stringify({fromBranch: branchId, toBranch: destination, ingredient, qty: Number(qty)})
      });
      setMessage('Transfer request created.');
      load();
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
      load();
    } catch (err) {
      setError(err.message || 'Could not update transfer');
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

  return (
    <section className="panel">
      <div className="title">
        <div>
          <h2>Stock operations</h2>
          <p>Waste writes off branch stock now. Transfers move ledger quantity after approve → ship → receive.</p>
        </div>
        <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
          {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
        </select>
      </div>
      {error && <p className="danger">{error}</p>}
      {message && <p>{message}</p>}
      <div className="stockforms">
        <form onSubmit={waste}>
          <h3>Record waste</h3>
          <select required value={ingredient} onChange={e => setIngredient(e.target.value)}>
            <option value="">Ingredient</option>
            {items.map(x => (
              <option key={x._id} value={x.ingredient?._id}>
                {x.ingredient?.name} — {x.quantity} {x.ingredient?.unit}
              </option>
            ))}
          </select>
          <input type="number" min=".01" step=".01" value={qty} onChange={e => setQty(e.target.value)} />
          <select value={reason} onChange={e => setReason(e.target.value)}>
            {WASTE_REASONS.map(x => <option key={x}>{x}</option>)}
          </select>
          <button disabled={!!busy}>{busy === 'waste' ? 'Recording…' : 'Record waste'}</button>
        </form>
        <form onSubmit={requestTransfer}>
          <h3>Request transfer</h3>
          <select required value={ingredient} onChange={e => setIngredient(e.target.value)}>
            <option value="">Ingredient</option>
            {items.map(x => (
              <option key={'t-' + x._id} value={x.ingredient?._id}>{x.ingredient?.name}</option>
            ))}
          </select>
          <select required value={destination} onChange={e => setDestination(e.target.value)}>
            <option value="">Destination branch</option>
            {destinations.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
          </select>
          <input type="number" min=".01" step=".01" value={qty} onChange={e => setQty(e.target.value)} />
          <button disabled={!!busy}>{busy === 'transfer' ? 'Requesting…' : 'Request transfer'}</button>
        </form>
      </div>
      <h3>Branch transfers</h3>
      {!transfers.length && <p className="empty">No transfer requests for this branch.</p>}
      {!!transfers.length && (
        <table>
          <thead>
            <tr>
              <th>Ingredient</th>
              <th>From</th>
              <th>To</th>
              <th>Qty</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
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
      )}
    </section>
  );
}
