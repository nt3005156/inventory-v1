import React, {useEffect, useState} from 'react';

const STATUS_ACTIONS = {
  booked: [
    {status: 'confirmed', label: 'Confirm'},
    {status: 'seated', label: 'Seat'},
    {status: 'no_show', label: 'No show'}
  ],
  confirmed: [
    {status: 'seated', label: 'Seat'},
    {status: 'no_show', label: 'No show'}
  ],
  seated: [{status: 'completed', label: 'Complete'}],
  completed: [],
  cancelled: [],
  no_show: []
};

/** Today in Kathmandu, as YYYY-MM-DD. */
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

export default function Reservations({call, branches = [], user}) {
  const assigned = user?.branch || null;
  const locked = user?.role === 'staff' && assigned;
  const visibleBranches = locked ? branches.filter(b => b._id === assigned) : branches;

  const [branchId, setBranchId] = useState(visibleBranches[0]?._id || assigned || '');
  const [date, setDate] = useState(today());
  const [data, setData] = useState(null);
  const [tables, setTables] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({
    guestName: '', guestPhone: '', partySize: 2, time: '19:00', durationMinutes: 90, table: '', notes: ''
  });

  useEffect(() => {
    if (locked && assigned && branchId !== assigned) setBranchId(assigned);
    else if (!branchId && visibleBranches[0]) setBranchId(visibleBranches[0]._id);
  }, [assigned, locked, visibleBranches, branchId]);

  const load = () => {
    if (!branchId) return;
    setError('');
    call(`/reservations?branch=${encodeURIComponent(branchId)}&date=${date}`)
      .then(setData)
      .catch(e => setError(e.message || 'Could not load reservations'));
    call(`/tables?branch=${encodeURIComponent(branchId)}`)
      .then(rows => setTables(Array.isArray(rows) ? rows : []))
      .catch(() => setTables([]));
  };

  useEffect(() => { load(); }, [branchId, date]);

  const act = async (reservation, status) => {
    setBusy(reservation._id + status);
    setError('');
    try {
      await call(`/reservations/${reservation._id}/status`, {
        method: 'PATCH', body: JSON.stringify({status})
      });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const cancel = async reservation => {
    const reason = typeof window !== 'undefined' ? window.prompt('Reason for cancelling?') : '';
    if (reason === null) return;
    setBusy(reservation._id + 'cancel');
    setError('');
    try {
      await call(`/reservations/${reservation._id}`, {
        method: 'DELETE', body: JSON.stringify({reason: reason || undefined})
      });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const create = async event => {
    event.preventDefault();
    setBusy('create');
    setError('');
    try {
      await call('/reservations', {
        method: 'POST',
        body: JSON.stringify({
          branch: branchId,
          guestName: form.guestName,
          guestPhone: form.guestPhone,
          partySize: Number(form.partySize),
          date,
          time: form.time,
          durationMinutes: Number(form.durationMinutes),
          table: form.table || null,
          notes: form.notes || undefined
        })
      });
      setForm({...form, guestName: '', guestPhone: '', notes: ''});
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  if (!visibleBranches.length) {
    return (
      <section className="panel">
        <h2>Reservations</h2>
        <p className="empty">No branch is configured. Run the demo seed, then refresh.</p>
      </section>
    );
  }

  const rows = data?.reservations || [];
  const seatable = tables.filter(t => t.active !== false && t.status !== 'disabled');

  return (
    <section className="panel">
      <div className="title">
        <div>
          <h2>Reservations</h2>
          <p>Bookings hold a table for their window only, so the floor stays sellable until the guest is due.</p>
        </div>
        <div className="kds-toolbar">
          <input type="date" className="kds-branch" value={date} onChange={e => setDate(e.target.value)}/>
          <select className="kds-branch" value={branchId} disabled={!!locked} onChange={e => setBranchId(e.target.value)}>
            {visibleBranches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </div>
      </div>

      {error && <p className="danger">{error}</p>}

      {data && (
        <div className="kpis">
          <article><small>Bookings</small><strong>{data.summary.total}</strong><em>{date}</em></article>
          <article><small>Covers</small><strong>{data.summary.covers}</strong><em>guests expected</em></article>
          <article>
            <small>Seated</small>
            <strong>{data.summary.byStatus.seated}</strong>
            <em>{data.summary.byStatus.booked + data.summary.byStatus.confirmed} still due</em>
          </article>
          <article>
            <small>Unassigned</small>
            <strong className={data.summary.unassigned ? 'warn' : ''}>{data.summary.unassigned}</strong>
            <em>{data.summary.byStatus.cancelled} cancelled · {data.summary.byStatus.no_show} no-show</em>
          </article>
        </div>
      )}

      <form className="purchaseform reservation-form" onSubmit={create}>
        <input required placeholder="Guest name" value={form.guestName}
          onChange={e => setForm({...form, guestName: e.target.value})}/>
        <input required placeholder="Phone" value={form.guestPhone}
          onChange={e => setForm({...form, guestPhone: e.target.value})}/>
        <input required type="number" min="1" max="200" placeholder="Party" value={form.partySize}
          onChange={e => setForm({...form, partySize: e.target.value})}/>
        <input required type="time" value={form.time}
          onChange={e => setForm({...form, time: e.target.value})}/>
        <select value={form.table} onChange={e => setForm({...form, table: e.target.value})}>
          <option value="">Table later…</option>
          {seatable.map(t => <option key={t._id} value={t._id}>{t.name} · {t.seats} seats</option>)}
        </select>
        <button disabled={busy === 'create'}>{busy === 'create' ? 'Booking…' : 'Book'}</button>
      </form>

      {!rows.length && !error && <p className="empty">No bookings for {date}.</p>}

      {!!rows.length && (
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Guest</th><th>Party</th><th>Table</th>
              <th>Status</th><th>Reference</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row._id}>
                <td><b>{row.time}</b><small>{row.durationMinutes}m</small></td>
                <td>
                  {row.guestName}
                  <small>{row.guestPhone}</small>
                  {row.notes && <small>“{row.notes}”</small>}
                </td>
                <td>{row.partySize}</td>
                <td>{row.table ? `${row.table.name} · ${row.table.seats}` : <span className="warn">unassigned</span>}</td>
                <td><label className={'pill res-' + row.status}>{row.status.replace('_', ' ')}</label></td>
                <td><small>{row.reference}</small></td>
                <td className="reservation-actions">
                  {(STATUS_ACTIONS[row.status] || []).map(action => (
                    <button
                      key={action.status}
                      className="kds-go"
                      disabled={!!busy}
                      onClick={() => act(row, action.status)}
                    >
                      {busy === row._id + action.status ? '…' : action.label}
                    </button>
                  ))}
                  {['booked', 'confirmed'].includes(row.status) && (
                    <button className="kds-cancel" disabled={!!busy} onClick={() => cancel(row)}>
                      {busy === row._id + 'cancel' ? '…' : 'Cancel'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
