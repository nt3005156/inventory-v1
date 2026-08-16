import React, {useEffect, useMemo, useState} from 'react';
import {Package, Search, Plus, Pencil, Power, RefreshCw, X, History, AlertTriangle} from 'lucide-react';

const rs = v => `Rs. ${Number(v||0).toLocaleString('en-NP', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
const qtyLabel = (qty, unit) => {
  const n = Number(qty||0);
  if(unit==='g' || !unit) return (n/1000).toFixed(2)+' kg';
  return n.toLocaleString('en-NP',{maximumFractionDigits:2})+' '+unit;
};

export default function Ingredients({call}){
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [units, setUnits] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [filters, setFilters] = useState({q:'', category:'', unit:'', active:'', supplier:''});
  const [pagination, setPagination] = useState({page:1, pages:1, total:0});
  const [editing, setEditing] = useState(null);
  const [editVersion, setEditVersion] = useState(0);
  const [form, setForm] = useState({name:'', code:'', category:'other', unit:'g', conversions:[], minimumStock:0, reorderQty:0, supplier:'', shelfLifeDays:'', storage:'', description:'', active:true});
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');

  const query = useMemo(()=>{
    const p=new URLSearchParams({page:String(pagination.page), limit:'30'});
    if(filters.q) p.set('q', filters.q);
    if(filters.category) p.set('category', filters.category);
    if(filters.unit) p.set('unit', filters.unit);
    if(filters.active) p.set('active', filters.active);
    if(filters.supplier) p.set('supplier', filters.supplier);
    return p.toString();
  },[filters, pagination.page]);

  const load = async()=>{
    setLoading(true); setError('');
    try{
      const [res, cats, unitRes, sup] = await Promise.all([
        call(`/ingredients?${query}`),
        call('/ingredients/categories'),
        call('/ingredients/units'),
        call('/suppliers?limit=200')
      ]);
      setRows(res.items||[]);
      setPagination(res.pagination||{page:1,pages:1,total:0});
      setCategories(cats.categories||cats||[]);
      setUnits(unitRes.units||[]);
      setSuppliers(sup.items||suppliers);
    }catch(e){ setError(e.message||'Could not load ingredients'); }
    finally{ setLoading(false); }
  };

  useEffect(()=>{ load(); },[query]);

  const startEdit = (row)=>{
    setEditing(row._id);
    setEditVersion(row.__v||0);
    setForm({
      name: row.name||'',
      code: row.code||'',
      category: row.category||'other',
      unit: row.unit||'g',
      conversions: (row.conversions||[]).map(c=>({unit:c.unit, factor:c.factor, description:c.description||''})),
      minimumStock: row.minimumStock||0,
      reorderQty: row.reorderQty||0,
      supplier: row.primarySupplier?._id || row.primarySupplier || row.supplier?._id || row.supplier || '',
      shelfLifeDays: row.shelfLifeDays||'',
      storage: row.storage||'',
      description: row.description||'',
      active: row.active!==false
    });
    setError(''); setSuccess('');
    window.scrollTo({top:0, behavior:'smooth'});
  };
  const resetForm = ()=>{
    setEditing(null); setEditVersion(0);
    setForm({name:'', code:'', category:'other', unit:'g', conversions:[], minimumStock:0, reorderQty:0, supplier:'', shelfLifeDays:'', storage:'', description:'', active:true});
  };

  const submit = async(e)=>{
    e.preventDefault();
    setBusy(editing?'edit':'create'); setError(''); setSuccess('');
    try{
      const payload = {
        ...form,
        code: form.code?.trim() || undefined,
        category: form.category,
        unit: form.unit,
        conversions: form.conversions.length? form.conversions : undefined,
        minimumStock: Number(form.minimumStock)||0,
        reorderQty: Number(form.reorderQty)||0,
        supplier: form.supplier || undefined,
        primarySupplier: form.supplier || undefined,
        shelfLifeDays: form.shelfLifeDays ? Number(form.shelfLifeDays) : undefined,
        storage: form.storage || undefined,
        description: form.description || undefined
      };
      if(editing){
        const res = await call(`/ingredients/${editing}`, {method:'PATCH', body: JSON.stringify({...payload, expectedVersion: editVersion})});
        setSuccess(`Updated ${res.name}`);
      }else{
        const res = await call('/ingredients', {method:'POST', body: JSON.stringify(payload)});
        setSuccess(`Created ${res.name} (${res.code||'no code'})`);
      }
      resetForm();
      await load();
    }catch(err){ setError(err.message||'Save failed'); }
    finally{ setBusy(''); }
  };

  const toggleActive = async(row)=>{
    if(row.active && !confirm(`Deactivate ${row.name}? It will be hidden from new purchasing but history remains.`)) return;
    setBusy(`toggle-${row._id}`); setError('');
    try{
      await call(`/ingredients/${row._id}`, {method:'PATCH', body: JSON.stringify({active: !row.active, expectedVersion: row.__v})});
      setSuccess(row.active ? 'Deactivated' : 'Reactivated');
      await load();
    }catch(e){ setError(e.message); }
    finally{ setBusy(''); }
  };

  const openDetail = async(row)=>{
    setDetail(null);
    try{
      const data = await call(`/ingredients/${row._id}`);
      setDetail(data);
    }catch(e){ setError(e.message); }
  };

  const addConversion = ()=> setForm({...form, conversions:[...form.conversions, {unit:'kg', factor:1000, description:''}]});
  const updateConversion = (i, field, val)=> {
    const arr=[...form.conversions];
    arr[i]={...arr[i], [field]: field==='factor'? Number(val): val};
    setForm({...form, conversions:arr});
  };
  const removeConversion = (i)=> setForm({...form, conversions: form.conversions.filter((_,idx)=>idx!==i)});

  return (
    <section className="panel">
      <div className="title">
        <div>
          <p className="eyebrow">INGREDIENT MASTER — PHASE 3A</p>
          <h2>Ingredients</h2>
          <p>Master data with units, conversions, categories, suppliers and costs. Stock quantities remain ledger-owned.</p>
        </div>
        <button onClick={load} disabled={loading}><RefreshCw size={16}/> Refresh</button>
      </div>

      {error && <div className="danger" role="alert">{error} <button onClick={()=>setError('')}><X size={14}/></button></div>}
      {success && <div className="inventory-success">{success} <button onClick={()=>setSuccess('')}><X size={14}/></button></div>}

      <form onSubmit={submit} className="panel" style={{background:'#fafafa', margin:'16px 0', padding:'12px', border:'1px solid #e5e7eb', borderRadius:'8px'}}>
        <h3>{editing ? 'Edit ingredient' : 'Add ingredient'}</h3>
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px,1fr))', gap:'10px'}}>
          <label>Name<input required value={form.name} onChange={e=>setForm({...form, name:e.target.value})} placeholder="Tomato"/></label>
          <label>Code<input value={form.code} onChange={e=>setForm({...form, code:e.target.value})} placeholder="TOM01" maxLength={30}/></label>
          <label>Category<select value={form.category} onChange={e=>setForm({...form, category:e.target.value})}>{['other','vegetable','fruit','meat','seafood','poultry','dairy','spice','grain','pulse','oil','beverage','bakery','frozen','dry','condiment'].map(c=> <option key={c} value={c}>{c}</option>)}</select></label>
          <label>Base unit<select value={form.unit} onChange={e=>setForm({...form, unit:e.target.value})}>{units.map(u=> <option key={u} value={u}>{u}</option>)}</select></label>
          <label>Minimum stock<input type="number" value={form.minimumStock} onChange={e=>setForm({...form, minimumStock:e.target.value})}/></label>
          <label>Reorder qty<input type="number" value={form.reorderQty} onChange={e=>setForm({...form, reorderQty:e.target.value})}/></label>
          <label>Primary supplier<select value={form.supplier} onChange={e=>setForm({...form, supplier:e.target.value})}><option value="">— none —</option>{suppliers.map(s=> <option key={s._id} value={s._id}>{s.name}</option>)}</select></label>
          <label>Shelf life (days)<input type="number" value={form.shelfLifeDays} onChange={e=>setForm({...form, shelfLifeDays:e.target.value})}/></label>
          <label>Storage<input value={form.storage} onChange={e=>setForm({...form, storage:e.target.value})} placeholder="Cool, dry"/></label>
          <label style={{gridColumn:'1 / -1'}}>Description<input value={form.description} onChange={e=>setForm({...form, description:e.target.value})} placeholder="Usage notes"/></label>
        </div>
        <div style={{marginTop:'10px'}}>
          <b>Conversions (to {form.unit})</b>
          {(form.conversions||[]).map((c,i)=>(
            <div key={i} style={{display:'flex', gap:'8px', marginTop:'6px', alignItems:'center'}}>
              <span>1 {c.unit} =</span>
              <input style={{width:'100px'}} type="number" step="any" value={c.factor} onChange={e=>updateConversion(i,'factor',e.target.value)}/>
              <span>{form.unit}</span>
              <input placeholder="description" value={c.description||''} onChange={e=>updateConversion(i,'description',e.target.value)} style={{flex:1}}/>
              <select value={c.unit} onChange={e=>updateConversion(i,'unit',e.target.value)} style={{width:'120px'}}>{units.map(u=> <option key={u} value={u}>{u}</option>)}</select>
              <button type="button" onClick={()=>removeConversion(i)}><X size={14}/></button>
            </div>
          ))}
          <button type="button" onClick={addConversion} style={{marginTop:'6px'}}><Plus size={14}/> Add conversion</button>
          <small style={{display:'block', opacity:0.6}}>Example: base g, 1 kg =1000 g, 1 bag =5000 g</small>
        </div>
        <div style={{marginTop:'12px', display:'flex', gap:'8px'}}>
          <button disabled={!!busy} type="submit">{busy ? 'Saving…' : editing ? 'Save changes' : 'Create ingredient'}</button>
          {editing && <button type="button" onClick={resetForm}>Cancel</button>}
        </div>
      </form>

      <div style={{display:'flex', gap:'8px', flexWrap:'wrap', margin:'12px 0'}}>
        <div style={{display:'flex', gap:'6px', alignItems:'center'}}><Search size={16}/><input placeholder="Search name/code" value={filters.q} onChange={e=>{setFilters({...filters,q:e.target.value}); setPagination(p=>({...p,page:1}))}} style={{padding:'6px 10px', minWidth:'180px'}}/></div>
        <select value={filters.category} onChange={e=>{setFilters({...filters,category:e.target.value}); setPagination(p=>({...p,page:1}))}}><option value="">All categories</option>{categories.map(c=> <option key={c} value={c}>{c}</option>)}</select>
        <select value={filters.unit} onChange={e=>{setFilters({...filters,unit:e.target.value}); setPagination(p=>({...p,page:1}))}}><option value="">All units</option>{units.map(u=> <option key={u} value={u}>{u}</option>)}</select>
        <select value={filters.active} onChange={e=>{setFilters({...filters,active:e.target.value}); setPagination(p=>({...p,page:1}))}}><option value="">All status</option><option value="true">Active</option><option value="false">Inactive</option></select>
        <select value={filters.supplier} onChange={e=>{setFilters({...filters,supplier:e.target.value}); setPagination(p=>({...p,page:1}))}}><option value="">All suppliers</option>{suppliers.map(s=> <option key={s._id} value={s._id}>{s.name}</option>)}</select>
      </div>

      {loading ? <p>Loading ingredients…</p> : !rows.length ? <p className="empty">No ingredients match. Create the first master record above.</p> :
        <div className="table-scroll">
          <table>
            <thead><tr><th>Code / Name</th><th>Category</th><th>Unit</th><th>Conversions</th><th>Stock & Costs</th><th>Supplier</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map(r=>(
                <tr key={r._id} style={{opacity: r.active===false?0.6:1}}>
                  <td><b>{r.code || '—'}</b><br/><span>{r.name}</span><small>{r.description||''}</small></td>
                  <td><span className="pill">{r.category}</span></td>
                  <td>{r.unit}<br/><small>base {r.baseUnit}</small></td>
                  <td>{(r.conversions||[]).length ? r.conversions.map(c=> <small key={c.unit} style={{display:'block'}}>1 {c.unit}={c.factor} {r.unit}</small>) : <small>—</small>}</td>
                  <td>
                    <small>min {qtyLabel(r.minimumStock, r.unit)} • reorder {qtyLabel(r.reorderQty, r.unit)}</small><br/>
                    <small>avg {rs(r.averageCost||0)}/{r.unit} • last {rs(r.lastPurchasePrice||0)}</small><br/>
                    <small>{r.supplierCount||0} supplier(s) • shelf {r.shelfLifeDays||'—'}d</small>
                  </td>
                  <td>{r.primarySupplier?.name || r.supplier?.name || <small>—</small>}<br/><small>{r.storage||''}</small></td>
                  <td><span className={`pill ${r.active?'ok':''}`}>{r.active?'Active':'Inactive'}</span></td>
                  <td>
                    <button title="Detail" onClick={()=>openDetail(r)}><Search size={14}/></button>
                    <button title="Edit" onClick={()=>startEdit(r)}><Pencil size={14}/></button>
                    <button title={r.active?'Deactivate':'Activate'} onClick={()=>toggleActive(r)} disabled={busy===`toggle-${r._id}`}><Power size={14}/></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      {pagination.pages>1 && <div style={{display:'flex', justifyContent:'space-between', marginTop:'10px'}}><button disabled={pagination.page<=1} onClick={()=>setPagination(p=>({...p,page:p.page-1}))}>Prev</button><span>Page {pagination.page} of {pagination.pages} • {pagination.total} total</span><button disabled={pagination.page>=pagination.pages} onClick={()=>setPagination(p=>({...p,page:p.page+1}))}>Next</button></div>}

      {detail && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:50}} onClick={()=>setDetail(null)}>
          <div className="panel" style={{maxWidth:'720px', width:'90%', maxHeight:'80vh', overflow:'auto'}} onClick={e=>e.stopPropagation()}>
            <div className="title"><div><h2>{detail.name} — {detail.code}</h2><p>{detail.category} • {detail.unit} • {detail.suppliers?.length||0} suppliers</p></div><button onClick={()=>setDetail(null)}><X size={18}/></button></div>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px', marginTop:'10px'}}>
              <div><b>Conversions</b><div>{(detail.conversions||[]).length ? detail.conversions.map(c=> <div key={c.unit}>1 {c.unit} = {c.factor} {detail.unit} {c.description && <small>({c.description})</small>}</div>) : '—'}<small>Base {detail.baseUnit}</small></div></div>
              <div><b>Stock levels</b><div>Min {qtyLabel(detail.minimumStock, detail.unit)} • Reorder {qtyLabel(detail.reorderQty, detail.unit)} • Level {qtyLabel(detail.reorderLevel, detail.unit)}</div><div>Storage: {detail.storage||'—'} • Shelf {detail.shelfLifeDays||'—'}d</div></div>
            </div>
            <div style={{marginTop:'12px'}}><b>Costs</b>
              <div style={{display:'flex', gap:'12px', flexWrap:'wrap', marginTop:'6px'}}>
                <span style={{background:'#f0fdf4', padding:'8px', borderRadius:'6px'}}><small>Avg cost</small><br/><strong>{rs(detail.costs?.averageCost||0)}/{detail.unit}</strong></span>
                <span style={{background:'#eff6ff', padding:'8px', borderRadius:'6px'}}><small>Last purchase</small><br/><strong>{rs(detail.costs?.lastPurchasePrice||0)}</strong></span>
                <span style={{background:'#fefce8', padding:'8px', borderRadius:'6px'}}><small>Standard</small><br/><strong>{rs(detail.costs?.standardCost||0)}</strong></span>
                <span style={{background:'#faf5ff', padding:'8px', borderRadius:'6px'}}><small>Stock</small><br/><strong>{qtyLabel(detail.costs?.stockQty||0, detail.unit)} = {rs(detail.costs?.stockValue||0)}</strong></span>
              </div>
              {!!detail.suppliers?.length && <div style={{marginTop:'10px'}}><b>Suppliers ({detail.suppliers.length})</b>{detail.suppliers.map(s=> <div key={s.catalogId} style={{display:'flex', justifyContent:'space-between', borderBottom:'1px solid #eee', padding:'6px 0'}}><span>{s.supplier?.name} • {s.supplierSku||'no sku'} • 1 {s.purchaseUnit}={s.conversionFactor} {s.baseUnit}</span><span>{rs(s.currentPrice)}/{s.purchaseUnit} ({rs(s.baseUnitPrice)}/{s.baseUnit})</span></div>)}</div>}
              {!!detail.costs?.priceHistory?.length && <div style={{marginTop:'10px'}}><b>Price history</b>{detail.costs.priceHistory.map(h=> <div key={h._id} style={{display:'flex', justifyContent:'space-between', fontSize:'12px', borderBottom:'1px dotted #eee'}}><span>{new Date(h.effectiveAt).toLocaleDateString('en-NP')} {rs(h.price)}/{h.purchaseUnit}</span><span>{h.reason||''}</span></div>)}</div>}
            </div>
            {detail.description && <p style={{marginTop:'10px', opacity:0.7}}>{detail.description}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
