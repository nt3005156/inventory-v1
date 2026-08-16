import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CheckCircle2, Clock3, History, PackageSearch, Pencil, Power, RefreshCw, X} from 'lucide-react';

const rs = value => `Rs. ${Number(value || 0).toLocaleString('en-NP', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
const initialSupplierForm = {name: '', contact: '', address: '', paymentTerms: '', reason: ''};
const initialForm = {
  supplier: '',
  ingredient: '',
  supplierSku: '',
  purchaseUnit: 'kg',
  conversionFactor: 1000,
  currentPrice: '',
  priceIncludesVat: false,
  vatRate: 13,
  minOrderQty: 1,
  leadDays: 1,
  reason: ''
};

export default function SupplierCatalog({call, user}) {
  const canManage = ['owner', 'manager'].includes(user?.role);
  const [rows, setRows] = useState([]);
  const [options, setOptions] = useState({suppliers: [], ingredients: []});
  const [suppliers, setSuppliers] = useState([]);
  const [supplierForm, setSupplierForm] = useState(initialSupplierForm);
  const [supplierEditId, setSupplierEditId] = useState('');
  const [supplierEditVersion, setSupplierEditVersion] = useState(0);
  const [supplierLoading, setSupplierLoading] = useState(true);
  const [pagination, setPagination] = useState({page: 1, pages: 1, total: 0});
  const [filters, setFilters] = useState({q: '', supplier: '', active: ''});
  const [form, setForm] = useState(initialForm);
  const [editId, setEditId] = useState('');
  const [editVersion, setEditVersion] = useState(0);
  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const searchTimer = useRef(null);

  const selectedIngredient = options.ingredients.find(item => item._id === form.ingredient);
  const baseUnit = selectedIngredient?.unit || 'inventory unit';
  const activeCount = rows.filter(item => item.active).length;
  const averageLead = rows.length ? rows.reduce((sum, item) => sum + Number(item.leadDays || 0), 0) / rows.length : 0;

  const query = useMemo(() => {
    const params = new URLSearchParams({page: String(pagination.page || 1), limit: '50'});
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.supplier) params.set('supplier', filters.supplier);
    if (filters.active) params.set('active', filters.active);
    return params.toString();
  }, [filters, pagination.page]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await call(`/supplier-catalog?${query}`);
      setRows(result.items || []);
      setPagination(current => ({...current, ...(result.pagination || {})}));
    } catch (err) {
      setError(err.message || 'Could not load supplier catalog');
    } finally {
      setLoading(false);
    }
  };

  const loadMasterData = async () => {
    setSupplierLoading(true);
    try {
      const [nextOptions, directory] = await Promise.all([
        call('/supplier-catalog/options'),
        call('/suppliers?limit=200')
      ]);
      setOptions(nextOptions);
      setSuppliers(directory.items || []);
    } catch (err) {
      setError(err.message || 'Could not load supplier master data');
    } finally {
      setSupplierLoading(false);
    }
  };

  useEffect(() => {
    loadMasterData();
  }, []);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(load, filters.q ? 250 : 0);
    return () => clearTimeout(searchTimer.current);
  }, [query]);

  const updateFilter = (key, value) => {
    setFilters(current => ({...current, [key]: value}));
    setPagination(current => ({...current, page: 1}));
  };

  const resetSupplierForm = () => {
    setSupplierForm(initialSupplierForm);
    setSupplierEditId('');
    setSupplierEditVersion(0);
  };

  const startSupplierEdit = row => {
    setSupplierEditId(row._id);
    setSupplierEditVersion(row.__v);
    setSupplierForm({
      name: row.name || '',
      contact: row.contact || '',
      address: row.address || '',
      paymentTerms: row.paymentTerms || '',
      reason: ''
    });
    setError('');
    setSuccess('');
  };

  const submitSupplier = async event => {
    event.preventDefault();
    setBusy(supplierEditId ? `supplier-${supplierEditId}` : 'supplier-create');
    setError('');
    setSuccess('');
    try {
      if (supplierEditId) {
        await call(`/suppliers/${supplierEditId}`, {
          method: 'PATCH',
          body: JSON.stringify({...supplierForm, expectedVersion: supplierEditVersion})
        });
        setSuccess('Supplier details updated and audited.');
      } else {
        await call('/suppliers', {method: 'POST', body: JSON.stringify(supplierForm)});
        setSuccess('Supplier created and made available to purchasing.');
      }
      resetSupplierForm();
      await Promise.all([loadMasterData(), load()]);
    } catch (err) {
      setError(err.message || 'Supplier update failed');
    } finally {
      setBusy('');
    }
  };

  const toggleSupplier = async row => {
    if (row.active && !window.confirm(`Deactivate ${row.name}? Existing history will remain, but new purchasing selections will exclude this supplier.`)) return;
    setBusy(`supplier-toggle-${row._id}`);
    setError('');
    setSuccess('');
    try {
      await call(`/suppliers/${row._id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          active: !row.active,
          expectedVersion: row.__v,
          reason: row.active ? 'Deactivated from supplier directory' : 'Reactivated from supplier directory'
        })
      });
      setSuccess(row.active ? 'Supplier deactivated.' : 'Supplier reactivated.');
      if (supplierEditId === row._id) resetSupplierForm();
      await Promise.all([loadMasterData(), load()]);
    } catch (err) {
      setError(err.message || 'Could not change supplier status');
    } finally {
      setBusy('');
    }
  };

  const resetForm = () => {
    setForm(initialForm);
    setEditId('');
    setEditVersion(0);
  };

  const startEdit = row => {
    setEditId(row._id);
    setEditVersion(row.__v);
    setForm({
      supplier: row.supplier?._id || row.supplier,
      ingredient: row.ingredient?._id || row.ingredient,
      supplierSku: row.supplierSku || '',
      purchaseUnit: row.purchaseUnit,
      conversionFactor: row.conversionFactor,
      currentPrice: row.currentPrice,
      priceIncludesVat: Boolean(row.priceIncludesVat),
      vatRate: row.vatRate ?? 13,
      minOrderQty: row.minOrderQty || 1,
      leadDays: row.leadDays || 0,
      reason: ''
    });
    setError('');
    setSuccess('');
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  const submit = async event => {
    event.preventDefault();
    setBusy(editId || 'create');
    setError('');
    setSuccess('');
    try {
      const input = {
        ...form,
        conversionFactor: Number(form.conversionFactor),
        currentPrice: Number(form.currentPrice),
        vatRate: Number(form.vatRate),
        minOrderQty: Number(form.minOrderQty),
        leadDays: Number(form.leadDays)
      };
      if (editId) {
        const {supplier, ingredient, ...patch} = input;
        await call(`/supplier-catalog/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify({...patch, expectedVersion: editVersion})
        });
        setSuccess('Catalog terms updated and audited.');
      } else {
        await call('/supplier-catalog', {method: 'POST', body: JSON.stringify(input)});
        setSuccess('Supplier mapping created with opening price history.');
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err.message || 'Catalog update failed');
    } finally {
      setBusy('');
    }
  };

  const toggle = async row => {
    if (row.active && !window.confirm(`Deactivate ${row.ingredient?.name} for ${row.supplier?.name}? New purchase orders will no longer use it.`)) return;
    setBusy(`toggle-${row._id}`);
    setError('');
    setSuccess('');
    try {
      await call(`/supplier-catalog/${row._id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          active: !row.active,
          expectedVersion: row.__v,
          reason: row.active ? 'Deactivated from catalog workspace' : 'Reactivated from catalog workspace'
        })
      });
      setSuccess(row.active ? 'Catalog mapping deactivated.' : 'Catalog mapping reactivated.');
      await load();
    } catch (err) {
      setError(err.message || 'Could not change catalog status');
    } finally {
      setBusy('');
    }
  };

  const showHistory = async row => {
    setHistoryFor(row);
    setHistory([]);
    setHistoryLoading(true);
    setError('');
    try {
      setHistory(await call(`/supplier-catalog/${row._id}/price-history`));
    } catch (err) {
      setError(err.message || 'Could not load price history');
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <section className="supplier-catalog">
      <div className="catalog-hero panel">
        <div>
          <p className="eyebrow">PURCHASING MASTER DATA</p>
          <h2>Supplier ingredient catalog</h2>
          <p>Control supplier SKUs, pack conversions, minimum orders and auditable NPR price history. Active mappings feed new purchase orders.</p>
        </div>
        <button className="secondary-action" onClick={() => Promise.all([load(), loadMasterData()])} disabled={loading || supplierLoading}><RefreshCw size={15}/> Refresh</button>
      </div>

      <div className="catalog-kpis">
        <article><PackageSearch size={18}/><small>Mappings</small><strong>{pagination.total}</strong><span>Restaurant catalog</span></article>
        <article><CheckCircle2 size={18}/><small>Active on page</small><strong>{activeCount}</strong><span>Available to purchasing</span></article>
        <article><Clock3 size={18}/><small>Average lead</small><strong>{averageLead.toFixed(1)} d</strong><span>Current result set</span></article>
      </div>

      {error && <div className="catalog-alert error">{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
      {success && <div className="catalog-alert success">{success}<button onClick={() => setSuccess('')} aria-label="Dismiss message"><X size={15}/></button></div>}

      <div className="panel catalog-list supplier-directory">
        <div className="title">
          <div><h2>Supplier directory</h2><p>Restaurant-owned vendor identity, contact details and payment terms. Deactivation preserves every purchasing record.</p></div>
          <span className="pill ok">{suppliers.filter(item => item.active).length} active</span>
        </div>
        {canManage && <form className="catalog-form" onSubmit={submitSupplier}>
          <div className="title">
            <div><h3>{supplierEditId ? 'Edit supplier' : 'Add supplier'}</h3><p>{supplierEditId ? 'Changes use optimistic version checks and are audited.' : 'Create a supplier before mapping ingredients and purchasing terms.'}</p></div>
            {supplierEditId && <button type="button" className="text-action" onClick={resetSupplierForm}>Cancel edit</button>}
          </div>
          <div className="catalog-form-grid">
            <label>Supplier name<input required maxLength={120} value={supplierForm.name} onChange={event => setSupplierForm({...supplierForm, name: event.target.value})} placeholder="e.g. Kathmandu Fresh Foods"/></label>
            <label>Contact<input maxLength={120} value={supplierForm.contact} onChange={event => setSupplierForm({...supplierForm, contact: event.target.value})} placeholder="Phone, email or contact person"/></label>
            <label>Address<input maxLength={240} value={supplierForm.address} onChange={event => setSupplierForm({...supplierForm, address: event.target.value})} placeholder="Supplier address"/></label>
            <label>Payment terms<input maxLength={120} value={supplierForm.paymentTerms} onChange={event => setSupplierForm({...supplierForm, paymentTerms: event.target.value})} placeholder="e.g. Net 15"/></label>
            <label className="catalog-reason">Reason / reference<input maxLength={240} value={supplierForm.reason} onChange={event => setSupplierForm({...supplierForm, reason: event.target.value})} placeholder="Approval, agreement or change context"/></label>
          </div>
          <button disabled={Boolean(busy)}>{busy ? 'Saving…' : supplierEditId ? 'Save supplier' : 'Create supplier'}</button>
        </form>}
        {supplierLoading ? <div className="catalog-loading">Loading supplier directory…</div> : suppliers.length ? <div className="table-scroll"><table>
          <thead><tr><th>Supplier</th><th>Contact</th><th>Address</th><th>Payment terms</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
          <tbody>{suppliers.map(row => <tr key={row._id} className={!row.active ? 'catalog-inactive' : ''}>
            <td><strong>{row.name}</strong></td>
            <td>{row.contact || 'Not recorded'}</td>
            <td>{row.address || 'Not recorded'}</td>
            <td>{row.paymentTerms || 'Not recorded'}</td>
            <td><span className={`pill ${row.active ? 'ok' : ''}`}>{row.active ? 'Active' : 'Inactive'}</span></td>
            {canManage && <td><div className="catalog-actions"><button type="button" title="Edit supplier" onClick={() => startSupplierEdit(row)}><Pencil size={14}/></button><button type="button" title={row.active ? 'Deactivate supplier' : 'Reactivate supplier'} disabled={busy === `supplier-toggle-${row._id}`} onClick={() => toggleSupplier(row)}><Power size={14}/></button></div></td>}
          </tr>)}</tbody>
        </table></div> : <div className="catalog-empty"><PackageSearch size={28}/><h3>No suppliers yet</h3><p>{canManage ? 'Create the first approved supplier to begin purchasing.' : 'Ask an owner or manager to add an approved supplier.'}</p></div>}
      </div>

      {canManage && <form className="panel catalog-form" onSubmit={submit}>
        <div className="title">
          <div><h2>{editId ? 'Edit purchasing terms' : 'Add supplier mapping'}</h2><p>{editId ? 'Supplier and ingredient stay locked to preserve purchasing history.' : 'Map one restaurant ingredient to one supplier.'}</p></div>
          {editId && <button type="button" className="text-action" onClick={resetForm}>Cancel edit</button>}
        </div>
        <div className="catalog-form-grid">
          <label>Supplier<select required disabled={Boolean(editId)} value={form.supplier} onChange={event => setForm({...form, supplier: event.target.value})}><option value="">Select supplier</option>{options.suppliers.map(item => <option key={item._id} value={item._id}>{item.name}</option>)}</select></label>
          <label>Ingredient<select required disabled={Boolean(editId)} value={form.ingredient} onChange={event => setForm({...form, ingredient: event.target.value})}><option value="">Select ingredient</option>{options.ingredients.map(item => <option key={item._id} value={item._id}>{item.code ? `${item.code} · ` : ''}{item.name} ({item.unit})</option>)}</select></label>
          <label>Supplier SKU<input value={form.supplierSku} maxLength={80} onChange={event => setForm({...form, supplierSku: event.target.value})} placeholder="e.g. KFS-RICE-25"/></label>
          <label>Purchase unit<input required value={form.purchaseUnit} onChange={event => setForm({...form, purchaseUnit: event.target.value})} placeholder="kg, sack, crate"/></label>
          <label>Units received per purchase unit<input required type="number" min="0.000001" step="any" value={form.conversionFactor} onChange={event => setForm({...form, conversionFactor: event.target.value})}/><small>1 {form.purchaseUnit || 'purchase unit'} = {form.conversionFactor || 0} {baseUnit}</small></label>
          <label>Current price (NPR)<input required type="number" min="0.01" step="0.01" value={form.currentPrice} onChange={event => setForm({...form, currentPrice: event.target.value})}/></label>
          <label>Minimum order<input required type="number" min="0.000001" step="any" value={form.minOrderQty} onChange={event => setForm({...form, minOrderQty: event.target.value})}/></label>
          <label>Lead time (days)<input required type="number" min="0" max="365" step="1" value={form.leadDays} onChange={event => setForm({...form, leadDays: event.target.value})}/></label>
          <label>VAT rate %<input required type="number" min="0" max="100" step="0.01" value={form.vatRate} onChange={event => setForm({...form, vatRate: event.target.value})}/></label>
          <label className="catalog-check"><input type="checkbox" checked={form.priceIncludesVat} onChange={event => setForm({...form, priceIncludesVat: event.target.checked})}/> Supplier price includes VAT</label>
          <label className="catalog-reason">Change reason<input value={form.reason} maxLength={240} onChange={event => setForm({...form, reason: event.target.value})} placeholder={editId ? 'Required operational context is recommended' : 'Opening quote or contract reference'}/></label>
        </div>
        <button disabled={Boolean(busy)}>{busy ? 'Saving…' : editId ? 'Save audited changes' : 'Create catalog mapping'}</button>
      </form>}

      <div className="panel catalog-list">
        <div className="title catalog-title">
          <div><h2>Catalog directory</h2><p>Search by supplier, ingredient, category, code, SKU or purchase unit.</p></div>
          <div className="catalog-filters">
            <input value={filters.q} onChange={event => updateFilter('q', event.target.value)} placeholder="Search catalog…"/>
            <select value={filters.supplier} onChange={event => updateFilter('supplier', event.target.value)}><option value="">All suppliers</option>{options.suppliers.map(item => <option key={item._id} value={item._id}>{item.name}</option>)}</select>
            <select value={filters.active} onChange={event => updateFilter('active', event.target.value)}><option value="">All statuses</option><option value="true">Active</option><option value="false">Inactive</option></select>
          </div>
        </div>
        {loading ? <div className="catalog-loading">Loading current supplier terms…</div> : rows.length ? <div className="table-scroll"><table>
          <thead><tr><th>Supplier / SKU</th><th>Ingredient</th><th>Purchase conversion</th><th>Current price</th><th>MOQ / lead</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row._id} className={!row.active ? 'catalog-inactive' : ''}>
            <td><strong>{row.supplier?.name}</strong><small>{row.supplierSku || 'No supplier SKU'}</small></td>
            <td><strong>{row.ingredient?.name}</strong><small>{row.ingredient?.code || row.ingredient?.category || 'Ingredient'}</small></td>
            <td>1 {row.purchaseUnit}<small>= {Number(row.conversionFactor).toLocaleString('en-NP')} {row.baseUnit}</small></td>
            <td><strong>{rs(row.currentPrice)} / {row.purchaseUnit}</strong><small>{Number(row.baseUnitPrice || 0).toLocaleString('en-NP', {maximumFractionDigits: 6})} per {row.baseUnit} · VAT {row.priceIncludesVat ? 'included' : 'excluded'}</small></td>
            <td>{row.minOrderQty} {row.purchaseUnit}<small>{row.leadDays} day lead</small></td>
            <td><span className={`pill ${row.active ? 'ok' : ''}`}>{row.active ? 'Active' : 'Inactive'}</span></td>
            <td><div className="catalog-actions"><button title="Price history" onClick={() => showHistory(row)}><History size={14}/></button>{canManage && <><button title="Edit" onClick={() => startEdit(row)}><Pencil size={14}/></button><button title={row.active ? 'Deactivate' : 'Activate'} disabled={busy === `toggle-${row._id}`} onClick={() => toggle(row)}><Power size={14}/></button></>}</div></td>
          </tr>)}</tbody>
        </table></div> : <div className="catalog-empty"><PackageSearch size={28}/><h3>No matching supplier mappings</h3><p>Adjust the filters or add the first mapping for this restaurant.</p></div>}
        {pagination.pages > 1 && <div className="catalog-pagination"><button disabled={pagination.page <= 1} onClick={() => setPagination(current => ({...current, page: current.page - 1}))}>Previous</button><span>Page {pagination.page} of {pagination.pages}</span><button disabled={pagination.page >= pagination.pages} onClick={() => setPagination(current => ({...current, page: current.page + 1}))}>Next</button></div>}
      </div>

      {historyFor && <div className="catalog-modal-backdrop" onClick={() => setHistoryFor(null)}><section className="catalog-modal panel" onClick={event => event.stopPropagation()}>
        <div className="title"><div><p className="eyebrow">IMMUTABLE PRICE HISTORY</p><h2>{historyFor.ingredient?.name}</h2><p>{historyFor.supplier?.name} · {historyFor.supplierSku || 'No SKU'}</p></div><button className="modal-close" onClick={() => setHistoryFor(null)} aria-label="Close"><X size={18}/></button></div>
        {historyLoading ? <p>Loading price history…</p> : history.length ? <div className="history-timeline">{history.map(entry => <article key={entry._id}><div><strong>{rs(entry.price)} / {entry.purchaseUnit}</strong><small>{new Date(entry.effectiveAt).toLocaleString('en-NP')} · {entry.changedBy?.name || 'Migration/system'}</small></div><p>{entry.reason || 'No reason recorded'}<small>1 {entry.purchaseUnit} = {entry.conversionFactor} {entry.baseUnit} · VAT {entry.priceIncludesVat ? 'included' : 'excluded'}</small></p></article>)}</div> : <p className="empty">No price history was found.</p>}
      </section></div>}
    </section>
  );
}
