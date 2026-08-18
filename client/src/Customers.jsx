import React, {useCallback, useEffect, useMemo, useState} from 'react';

/**
 * CRM workspace (Phase 9).
 *
 * Layout is a two-pane console: a searchable customer list on the left, the
 * selected profile on the right. That mirrors how the counter actually works —
 * find the guest by phone while they are talking, then read their history.
 *
 * Customers are restaurant-wide, so the branch filter is an optional narrowing
 * of the home branch rather than a boundary.
 */

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

const shortDate = value => value
  ? new Date(value).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'})
  : '—';

const TIER_COLOURS = {
  bronze: '#a1662f', silver: '#8a94a6', gold: '#c9a227', platinum: '#4b5d78'
};

const EMPTY_FORM = {
  name: '', phone: '', email: '', notes: '', branch: '',
  addresses: [], tags: '',
  preferences: {dietary: 'none', spiceLevel: 'medium', contactPreference: 'phone', marketingOptIn: false}
};

export default function Customers({call, branches = [], user}) {
  const [query, setQuery] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [list, setList] = useState({customers: [], total: 0, pages: 1});
  const [summary, setSummary] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [history, setHistory] = useState(null);
  const [tab, setTab] = useState('profile');
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const isOwner = user?.role === 'owner';
  const isSupervisor = user?.role === 'owner' || user?.role === 'manager';

  const search = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (branchFilter) params.set('branch', branchFilter);
      if (includeInactive) params.set('includeInactive', 'true');
      params.set('page', String(page));
      setList(await call('/customers/search?' + params.toString()));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [call, query, branchFilter, includeInactive, page]);

  // Debounced so typing a phone number does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(search, 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!isSupervisor) return;
    call('/customers/summary' + (branchFilter ? `?branch=${branchFilter}` : ''))
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [call, branchFilter, isSupervisor, notice]);

  const openCustomer = async id => {
    setSelectedId(id);
    setTab('profile');
    setForm(null);
    try {
      const [profile, past] = await Promise.all([
        call(`/customers/${id}`),
        call(`/customers/${id}/history`)
      ]);
      setDetail(profile);
      setHistory(past);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  const refresh = async () => {
    await search();
    if (selectedId) await openCustomer(selectedId);
  };

  const startCreate = () => {
    setSelectedId(null);
    setDetail(null);
    setHistory(null);
    setForm({...EMPTY_FORM, branch: branchFilter || branches[0]?._id || ''});
  };

  const startEdit = () => {
    if (!detail) return;
    setForm({
      name: detail.name || '',
      phone: detail.phone || '',
      email: detail.email || '',
      notes: detail.notes || '',
      branch: detail.branch?._id || detail.branch || '',
      addresses: detail.addresses || [],
      tags: (detail.tags || []).join(', '),
      preferences: {
        dietary: detail.preferences?.dietary || 'none',
        spiceLevel: detail.preferences?.spiceLevel || 'medium',
        contactPreference: detail.preferences?.contactPreference || 'phone',
        marketingOptIn: Boolean(detail.preferences?.marketingOptIn)
      }
    });
  };

  const saveForm = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        ...(form.email.trim() ? {email: form.email.trim()} : {}),
        ...(form.notes.trim() ? {notes: form.notes.trim()} : {}),
        ...(form.branch ? {branch: form.branch} : {}),
        addresses: (form.addresses || []).filter(a => a.address?.trim()),
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        preferences: form.preferences
      };
      if (selectedId) {
        await call(`/customers/${selectedId}`, {method: 'PATCH', body: JSON.stringify(payload)});
        setNotice('Profile updated');
        setForm(null);
        await refresh();
      } else {
        const created = await call('/customers', {method: 'POST', body: JSON.stringify(payload)});
        setNotice('Customer created');
        setForm(null);
        await search();
        await openCustomer(created._id);
      }
    } catch (e) {
      // A duplicate phone is the common case; offer the existing profile.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const adjustLoyalty = async () => {
    const raw = window.prompt('Adjust loyalty points by (use a negative number to deduct):');
    if (raw === null) return;
    const delta = Number(raw);
    if (!Number.isInteger(delta) || delta === 0) return setError('Enter a whole, non-zero number');
    const reason = window.prompt('Reason for this adjustment:') || '';
    try {
      await call(`/customers/${selectedId}/loyalty`, {
        method: 'POST', body: JSON.stringify({delta, reason})
      });
      setNotice('Loyalty points adjusted');
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const toggleActive = async () => {
    const deactivating = detail.active;
    let reason = '';
    if (deactivating) {
      reason = window.prompt('Reason for deactivating this customer:') || '';
      if (!window.confirm('Deactivate this customer? Their order history is kept.')) return;
    }
    try {
      await call(`/customers/${selectedId}/active`, {
        method: 'PATCH', body: JSON.stringify({active: !detail.active, reason})
      });
      setNotice(deactivating ? 'Customer deactivated' : 'Customer reactivated');
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const recalculate = async () => {
    try {
      await call(`/customers/${selectedId}/recalculate`, {method: 'POST'});
      setNotice('Statistics recalculated');
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const stats = detail?.stats || {};

  return (
    <div className="crm">
      <header className="crm-head">
        <div>
          <h1>Customers</h1>
          <p className="crm-sub">
            One profile per guest across every branch of this restaurant.
          </p>
        </div>
        <button className="crm-primary" onClick={startCreate}>+ New customer</button>
      </header>

      {summary && (
        <div className="crm-kpis">
          <Kpi label="Customers" value={summary.customers}/>
          <Kpi label="Active (30 days)" value={summary.activeLast30Days}/>
          <Kpi label="Repeat guests" value={summary.repeatCustomers}/>
          <Kpi label="Lifetime revenue" value={rs(summary.totalSpend)}/>
          <Kpi label="Avg per customer" value={rs(summary.averageSpendPerCustomer)}/>
        </div>
      )}

      {error && <div className="crm-alert crm-error">{error}</div>}
      {notice && <div className="crm-alert crm-ok" onAnimationEnd={() => setNotice('')}>{notice}</div>}

      <div className="crm-body">
        <section className="crm-list">
          <div className="crm-filters">
            <input
              className="crm-search"
              placeholder="Search phone, name, email or ID…"
              value={query}
              onChange={e => { setPage(1); setQuery(e.target.value); }}
            />
            <select value={branchFilter} onChange={e => { setPage(1); setBranchFilter(e.target.value); }}>
              <option value="">All branches</option>
              {branches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
            <label className="crm-check">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={e => { setPage(1); setIncludeInactive(e.target.checked); }}
              />
              Show inactive
            </label>
          </div>

          <div className="crm-count">{list.total} customer{list.total === 1 ? '' : 's'}</div>

          <ul className="crm-rows">
            {list.customers.map(c => (
              <li
                key={c._id}
                className={'crm-row' + (c._id === selectedId ? ' is-active' : '') + (c.active === false ? ' is-inactive' : '')}
                onClick={() => openCustomer(c._id)}
              >
                <div className="crm-row-main">
                  <span className="crm-row-name">{c.name || 'Unnamed guest'}</span>
                  <span className="crm-row-phone">{c.phone}</span>
                </div>
                <div className="crm-row-meta">
                  <span
                    className="crm-tier"
                    style={{background: TIER_COLOURS[c.loyalty?.tier] || '#8a94a6'}}
                  >
                    {c.loyalty?.tier || 'bronze'}
                  </span>
                  <span>{rs(c.stats?.totalSpend)}</span>
                </div>
              </li>
            ))}
            {!list.customers.length && (
              <li className="crm-empty">
                {query ? 'No customer matches that search.' : 'No customers yet.'}
              </li>
            )}
          </ul>

          {list.pages > 1 && (
            <div className="crm-pager">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
              <span>Page {list.page} of {list.pages}</span>
              <button disabled={page >= list.pages} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </section>

        <section className="crm-detail">
          {form && (
            <CustomerForm
              form={form}
              setForm={setForm}
              branches={branches}
              busy={busy}
              editing={Boolean(selectedId)}
              onCancel={() => setForm(null)}
              onSave={saveForm}
            />
          )}

          {!form && detail && (
            <>
              <div className="crm-profile-head">
                <div>
                  <h2>
                    {detail.name || 'Unnamed guest'}
                    {detail.active === false && <span className="crm-flag">Inactive</span>}
                  </h2>
                  <p className="crm-contact">
                    {detail.phone}
                    {detail.email ? ` · ${detail.email}` : ''}
                    {detail.branch?.name ? ` · Home: ${detail.branch.name}` : ''}
                  </p>
                  {!!(detail.tags || []).length && (
                    <div className="crm-tags">
                      {detail.tags.map(t => <span key={t} className="crm-tag">{t}</span>)}
                    </div>
                  )}
                </div>
                <div className="crm-actions">
                  <button onClick={startEdit}>Edit</button>
                  {isSupervisor && <button onClick={adjustLoyalty}>Loyalty</button>}
                  {isSupervisor && <button onClick={recalculate}>Recalculate</button>}
                  {isOwner && (
                    <button className={detail.active ? 'crm-danger' : ''} onClick={toggleActive}>
                      {detail.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </div>
              </div>

              <div className="crm-statgrid">
                <Stat label="Total orders" value={stats.totalOrders || 0}/>
                <Stat label="Completed" value={stats.completedOrders || 0}/>
                <Stat label="Cancelled" value={stats.cancelledOrders || 0}/>
                <Stat label="Lifetime spend" value={rs(stats.totalSpend)}/>
                <Stat label="Average order" value={rs(stats.averageOrderValue)}/>
                <Stat label="Refunded" value={rs(stats.totalRefunded)}/>
                <Stat label="First order" value={shortDate(stats.firstOrderAt)}/>
                <Stat label="Last order" value={shortDate(stats.lastOrderAt)}/>
                <Stat
                  label="Loyalty"
                  value={`${detail.loyalty?.points || 0} pts · ${detail.loyalty?.tier || 'bronze'}`}
                />
              </div>

              <nav className="crm-tabs">
                {['profile', 'orders', 'payments', 'deliveries'].map(t => (
                  <button
                    key={t}
                    className={tab === t ? 'is-active' : ''}
                    onClick={() => setTab(t)}
                  >
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </nav>

              {tab === 'profile' && (
                <div className="crm-panel">
                  <h3>Preferences</h3>
                  <dl className="crm-dl">
                    <dt>Dietary</dt><dd>{detail.preferences?.dietary || 'none'}</dd>
                    <dt>Spice level</dt><dd>{detail.preferences?.spiceLevel || 'medium'}</dd>
                    <dt>Allergies</dt>
                    <dd>{(detail.preferences?.allergies || []).join(', ') || 'None recorded'}</dd>
                    <dt>Contact by</dt><dd>{detail.preferences?.contactPreference || 'phone'}</dd>
                    <dt>Marketing</dt>
                    <dd>{detail.preferences?.marketingOptIn ? 'Opted in' : 'Not opted in'}</dd>
                  </dl>

                  <h3>Addresses</h3>
                  {(detail.addresses || []).length ? (
                    <ul className="crm-addresses">
                      {detail.addresses.map((a, i) => (
                        <li key={i}>
                          <b>{a.label || 'Address'}</b> · {a.address}
                          {a.default && <span className="crm-pill">Default</span>}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="crm-muted">No address on file.</p>}

                  <h3>Notes</h3>
                  <p className={detail.notes ? '' : 'crm-muted'}>
                    {detail.notes || 'No notes recorded.'}
                  </p>
                </div>
              )}

              {tab === 'orders' && (
                <div className="crm-panel">
                  <table className="crm-table">
                    <thead>
                      <tr>
                        <th>Order</th><th>Date</th><th>Branch</th>
                        <th>Type</th><th>Status</th><th className="r">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(history?.orders || []).map(o => (
                        <tr key={o._id} className={o.status === 'cancelled' ? 'is-void' : ''}>
                          <td>{o.orderNo}</td>
                          <td>{shortDate(o.createdAt)}</td>
                          <td>{o.branch?.name || '—'}</td>
                          <td>{o.type}</td>
                          <td><span className={`crm-status is-${o.status}`}>{o.status}</span></td>
                          <td className="r">{rs(o.total)}</td>
                        </tr>
                      ))}
                      {!history?.orders?.length && (
                        <tr><td colSpan={6} className="crm-muted">No orders yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'payments' && (
                <div className="crm-panel">
                  <table className="crm-table">
                    <thead>
                      <tr><th>Order</th><th>Method</th><th>Status</th><th className="r">Amount</th></tr>
                    </thead>
                    <tbody>
                      {(history?.orders || []).flatMap(o =>
                        (o.payments || []).map(p => (
                          <tr key={p._id}>
                            <td>{o.orderNo}</td>
                            <td>{p.method}</td>
                            <td><span className={`crm-status is-${p.status}`}>{p.status}</span></td>
                            <td className="r">{rs(p.amount)}</td>
                          </tr>
                        ))
                      )}
                      {!(history?.orders || []).some(o => o.payments?.length) && (
                        <tr><td colSpan={4} className="crm-muted">No payments recorded.</td></tr>
                      )}
                    </tbody>
                  </table>
                  {!!history?.refunds?.length && (
                    <>
                      <h3>Refunds</h3>
                      <ul className="crm-addresses">
                        {history.refunds.map(rf => (
                          <li key={rf._id}>{rs(rf.amount)} · {rf.reason || 'No reason recorded'}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}

              {tab === 'deliveries' && (
                <div className="crm-panel">
                  <table className="crm-table">
                    <thead><tr><th>Address</th><th>Rider</th><th>Status</th></tr></thead>
                    <tbody>
                      {(history?.deliveries || []).map(d => (
                        <tr key={d._id}>
                          <td>{d.address || '—'}</td>
                          <td>{d.rider?.name || 'Unassigned'}</td>
                          <td><span className={`crm-status is-${d.status}`}>{d.status}</span></td>
                        </tr>
                      ))}
                      {!history?.deliveries?.length && (
                        <tr><td colSpan={3} className="crm-muted">No deliveries yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {!form && !detail && (
            <div className="crm-placeholder">
              <p>Select a customer to see their profile and history.</p>
              <p className="crm-muted">Search by phone number — any format works.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Kpi({label, value}) {
  return (
    <div className="crm-kpi">
      <span className="crm-kpi-label">{label}</span>
      <span className="crm-kpi-value">{value}</span>
    </div>
  );
}

function Stat({label, value}) {
  return (
    <div className="crm-stat">
      <span className="crm-stat-label">{label}</span>
      <span className="crm-stat-value">{value}</span>
    </div>
  );
}

function CustomerForm({form, setForm, branches, busy, editing, onCancel, onSave}) {
  const set = (key, value) => setForm(f => ({...f, [key]: value}));
  const setPref = (key, value) => setForm(f => ({...f, preferences: {...f.preferences, [key]: value}}));

  const addAddress = () => setForm(f => ({
    ...f, addresses: [...(f.addresses || []), {label: '', address: '', default: false}]
  }));
  const setAddress = (index, key, value) => setForm(f => ({
    ...f,
    addresses: f.addresses.map((a, i) => (i === index ? {...a, [key]: value} : a))
  }));
  const removeAddress = index => setForm(f => ({
    ...f, addresses: f.addresses.filter((_, i) => i !== index)
  }));

  const valid = form.name.trim().length >= 1 && form.phone.trim().length >= 7;

  return (
    <div className="crm-form">
      <h2>{editing ? 'Edit customer' : 'New customer'}</h2>

      <div className="crm-fieldrow">
        <label>Name
          <input value={form.name} onChange={e => set('name', e.target.value)}/>
        </label>
        <label>Phone
          <input
            value={form.phone}
            onChange={e => set('phone', e.target.value)}
            placeholder="98XXXXXXXX"
          />
        </label>
      </div>

      <div className="crm-fieldrow">
        <label>Email
          <input value={form.email} onChange={e => set('email', e.target.value)}/>
        </label>
        <label>Home branch
          <select value={form.branch} onChange={e => set('branch', e.target.value)}>
            <option value="">Not set</option>
            {branches.map(b => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
        </label>
      </div>

      <div className="crm-fieldrow">
        <label>Dietary
          <select value={form.preferences.dietary} onChange={e => setPref('dietary', e.target.value)}>
            {['none', 'vegetarian', 'vegan', 'halal', 'jain'].map(v => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label>Spice level
          <select value={form.preferences.spiceLevel} onChange={e => setPref('spiceLevel', e.target.value)}>
            {['none', 'mild', 'medium', 'hot', 'extra-hot'].map(v => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label>Contact by
          <select
            value={form.preferences.contactPreference}
            onChange={e => setPref('contactPreference', e.target.value)}
          >
            {['phone', 'sms', 'email', 'none'].map(v => <option key={v}>{v}</option>)}
          </select>
        </label>
      </div>

      <label className="crm-check">
        <input
          type="checkbox"
          checked={form.preferences.marketingOptIn}
          onChange={e => setPref('marketingOptIn', e.target.checked)}
        />
        Customer has opted in to marketing
      </label>

      <label>Tags (comma separated)
        <input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="vip, corporate"/>
      </label>

      <div className="crm-addressform">
        <div className="crm-addresshead">
          <span>Addresses</span>
          <button type="button" onClick={addAddress}>+ Add</button>
        </div>
        {(form.addresses || []).map((a, i) => (
          <div key={i} className="crm-fieldrow">
            <input
              placeholder="Label"
              value={a.label || ''}
              onChange={e => setAddress(i, 'label', e.target.value)}
            />
            <input
              placeholder="Address"
              value={a.address || ''}
              onChange={e => setAddress(i, 'address', e.target.value)}
            />
            <button type="button" onClick={() => removeAddress(i)}>Remove</button>
          </div>
        ))}
      </div>

      <label>Notes
        <textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)}/>
      </label>

      <div className="crm-formactions">
        <button onClick={onCancel}>Cancel</button>
        <button className="crm-primary" disabled={!valid || busy} onClick={onSave}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create customer'}
        </button>
      </div>
    </div>
  );
}
