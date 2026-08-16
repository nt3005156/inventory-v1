import React, {useEffect, useMemo, useState} from 'react';
import {Package, Search, Plus, Pencil, Power, RefreshCw, X, ChefHat} from 'lucide-react';

const rs = v => `Rs. ${Number(v||0).toLocaleString('en-NP', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
const qtyLabel = (qty, unit) => {
  const n = Number(qty||0);
  if(!unit || unit==='g') return (n/1000).toFixed(2)+' kg';
  return n.toLocaleString('en-NP',{maximumFractionDigits:2})+' '+unit;
};

export default function Recipes({call}){
  const [rows, setRows] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [filters, setFilters] = useState({q:'', category:'', active:''});
  const [pagination, setPagination] = useState({page:1, pages:1, total:0});
  const [editing, setEditing] = useState(null);
  const [editVersion, setEditVersion] = useState(0);
  const [form, setForm] = useState({name:'', code:'', category:'main', price:'', packagingCost:0, yield:1, yieldUnit:'serving', recipe:[], description:'', active:true});
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');
  const [branchId, setBranchId] = useState('');

  const query = useMemo(()=>{
    const p=new URLSearchParams({page:String(pagination.page), limit:'30'});
    if(filters.q) p.set('q', filters.q);
    if(filters.category) p.set('category', filters.category);
    if(filters.active) p.set('active', filters.active);
    if(branchId) p.set('branch', branchId);
    return p.toString();
  },[filters, pagination.page, branchId]);

  const load = async()=>{
    setLoading(true); setError('');
    try{
      const [res, opts, branches] = await Promise.all([
        call(`/menu-items?${query}`),
        call('/ingredients?limit=200'),
        call('/branches')
      ]);
      setRows(res.items||[]);
      setPagination(res.pagination||{page:1,pages:1,total:0});
      setIngredients(opts.items||[]);
    }catch(e){ setError(e.message||'Could not load recipes'); }
    finally{ setLoading(false); }
  };

  useEffect(()=>{ load(); },[query]);

  const startEdit = (row)=>{
    setEditing(row._id);
    setEditVersion(row.__v||0);
    setForm({
      name: row.name||'',
      code: row.code||'',
      category: row.category||'main',
      price: row.price||'',
      packagingCost: row.packagingCost||0,
      yield: row.yield||1,
      yieldUnit: row.yieldUnit||'serving',
      recipe: (row.recipe||[]).map(r=>({ingredient: r.ingredient?._id || r.ingredient, qty: r.qty, unit: r.unit || 'g', notes: r.notes||''})),
      description: row.description||'',
      active: row.active!==false
    });
    setError(''); setSuccess('');
    window.scrollTo({top:0, behavior:'smooth'});
  };
  const resetForm = ()=>{
    setEditing(null); setEditVersion(0);
    setForm({name:'', code:'', category:'main', price:'', packagingCost:0, yield:1, yieldUnit:'serving', recipe:[], description:'', active:true});
  };
  const submit = async(e)=>{
    e.preventDefault();
    setBusy(editing?'edit':'create'); setError(''); setSuccess('');
    try{
      const payload = {
        name: form.name,
        code: form.code || undefined,
        category: form.category,
        price: Number(form.price),
        packagingCost: Number(form.packagingCost)||0,
        yield: Number(form.yield)||1,
        yieldUnit: form.yieldUnit,
        recipe: form.recipe.map(r=>({ingredient: r.ingredient, qty: Number(r.qty), unit: r.unit, notes: r.notes})),
        description: form.description || undefined,
        active: form.active
      };
      if(editing){
        const res = await call(`/menu-items/${editing}`, {method:'PATCH', body: JSON.stringify({...payload, expectedVersion: editVersion})});
        setSuccess(`Updated ${res.name} — cost ${rs(res.recipeCost)}`);
      }else{
        const res = await call('/menu-items', {method:'POST', body: JSON.stringify(payload)});
        setSuccess(`Created ${res.name} — cost ${rs(res.recipeCost)}`);
      }
      resetForm();
      await load();
    }catch(err){ setError(err.message||'Save failed'); }
    finally{ setBusy(''); }
  };
  const toggleActive = async(row)=>{
    if(row.active && !confirm(`Deactivate ${row.name}? It will be hidden from POS but history remains.`)) return;
    setBusy(`toggle-${row._id}`); setError('');
    try{
      await call(`/menu-items/${row._id}`, {method:'PATCH', body: JSON.stringify({active: !row.active, expectedVersion: row.__v})});
      setSuccess(row.active ? 'Deactivated' : 'Reactivated');
      await load();
    }catch(e){ setError(e.message); }
    finally{ setBusy(''); }
  };
  const openDetail = async(row)=>{
    try{
      const data = await call(`/menu-items/${row._id}${branchId?`?branch=${branchId}`:''}`);
      setDetail(data);
    }catch(e){ setError(e.message); }
  };
  const addLine = ()=> setForm({...form, recipe:[...form.recipe, {ingredient:'', qty:'', unit:'g', notes:''}]});
  const updateLine = (i, field, val)=>{
    const arr=[...form.recipe];
    arr[i]={...arr[i], [field]: val};
    // auto-set unit to ingredient base unit when ingredient changes
    if(field==='ingredient'){
      const ing = ingredients.find(x=>String(x._id)===String(val));
      if(ing) arr[i].unit = ing.unit || 'g';
    }
    setForm({...form, recipe:arr});
  };
  const removeLine = (i)=> setForm({...form, recipe: form.recipe.filter((_,idx)=>idx!==i)});

  return (
    <section className="panel">
      <div className="title">
        <div>
          <p className="eyebrow">MENU ENGINEERING — PHASE 3B</p>
          <h2>Recipes</h2>
          <p>Menu Item → Recipe → Ingredients → Quantity → Cost. Costs use weighted average inventory (FEFO-ready).</p>
        </div>
        <button onClick={load} disabled={loading}><RefreshCw size={16}/> Refresh</button>
      </div>

      {error && <div className="danger" role="alert">{error} <button onClick={()=>setError('')}><X size={14}/></button></div>}
      {success && <div className="inventory-success">{success} <button onClick={()=>setSuccess('')}><X size={14}/></button></div>}

      <form onSubmit={submit} className="panel" style={{background:'#fafafa', margin:'16px 0', padding:'12px', border:'1px solid #e5e7eb', borderRadius:'8px'}}>
        <h3>{editing ? 'Edit menu item' : 'Add menu item'}</h3>
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px,1fr))', gap:'10px'}}>
          <label>Name<input required value={form.name} onChange={e=>setForm({...form, name:e.target.value})} placeholder="Chicken Biryani"/></label>
          <label>Code<input value={form.code} onChange={e=>setForm({...form, code:e.target.value})} placeholder="CB01" maxLength={30}/></label>
          <label>Category<select value={form.category} onChange={e=>setForm({...form, category:e.target.value})}>{['main','appetizer','side','dessert','beverage','set','other'].map(c=> <option key={c} value={c}>{c}</option>)}</select></label>
          <label>Price (NPR)<input required type="number" step="0.01" value={form.price} onChange={e=>setForm({...form, price:e.target.value})}/></label>
          <label>Packaging cost (NPR)<input type="number" step="0.01" value={form.packagingCost} onChange={e=>setForm({...form, packagingCost:e.target.value})} placeholder="0.00"/></label>
          <label>Yield<input type="number" step="any" value={form.yield} onChange={e=>setForm({...form, yield:e.target.value})}/></label>
          <label>Yield unit<input value={form.yieldUnit} onChange={e=>setForm({...form, yieldUnit:e.target.value})} placeholder="serving"/></label>
          <label style={{gridColumn:'1 / -1'}}>Description<input value={form.description} onChange={e=>setForm({...form, description:e.target.value})} placeholder="Recipe notes"/></label>
        </div>
        <div style={{marginTop:'12px'}}>
          <b>Recipe — Ingredients → Quantity → Cost</b>
          {(form.recipe||[]).map((line,i)=>(
            <div key={i} style={{display:'flex', gap:'8px', marginTop:'8px', alignItems:'center', flexWrap:'wrap', background:'white', padding:'8px', borderRadius:'6px', border:'1px solid #e5e7eb'}}>
              <select required value={line.ingredient} onChange={e=>updateLine(i,'ingredient',e.target.value)} style={{minWidth:'180px'}}>
                <option value="">Select ingredient</option>
                {ingredients.map(ing=> <option key={ing._id} value={ing._id}>{ing.code? `${ing.code} · `:''}{ing.name} ({ing.unit}) — {rs(ing.averageCost||0)}/{ing.unit}</option>)}
              </select>
              <input required type="number" step="any" placeholder="Qty" value={line.qty} onChange={e=>updateLine(i,'qty',e.target.value)} style={{width:'100px'}}/>
              <select value={line.unit} onChange={e=>updateLine(i,'unit',e.target.value)} style={{width:'90px'}}>
                {['g','kg','mg','ml','l','pcs','bag','box','bottle','can','unit','each','pack'].map(u=> <option key={u} value={u}>{u}</option>)}
              </select>
              <input placeholder="notes" value={line.notes||''} onChange={e=>updateLine(i,'notes',e.target.value)} style={{flex:1, minWidth:'120px'}}/>
              <button type="button" onClick={()=>removeLine(i)}><X size={14}/></button>
            </div>
          ))}
          <button type="button" onClick={addLine} style={{marginTop:'8px'}}><Plus size={14}/> Add ingredient</button>
          <small style={{display:'block', opacity:0.6, marginTop:'4px'}}>Quantity in given unit → converted to ingredient base unit for costing (e.g., 0.2 kg flour → 200 g). Cost = Σ(qty_base × avgCost).</small>
        </div>
        <div style={{marginTop:'12px', display:'flex', gap:'8px'}}>
          <button disabled={!!busy} type="submit">{busy ? 'Saving…' : editing ? 'Save changes' : 'Create menu item'}</button>
          {editing && <button type="button" onClick={resetForm}>Cancel</button>}
        </div>
      </form>

      <div style={{display:'flex', gap:'8px', flexWrap:'wrap', margin:'12px 0'}}>
        <div style={{display:'flex', gap:'6px', alignItems:'center'}}><Search size={16}/><input placeholder="Search name/code" value={filters.q} onChange={e=>{setFilters({...filters,q:e.target.value}); setPagination(p=>({...p,page:1}))}} style={{padding:'6px 10px', minWidth:'180px'}}/></div>
        <select value={filters.category} onChange={e=>{setFilters({...filters,category:e.target.value}); setPagination(p=>({...p,page:1}))}}><option value="">All categories</option>{['main','appetizer','side','dessert','beverage','set','other'].map(c=> <option key={c} value={c}>{c}</option>)}</select>
        <select value={filters.active} onChange={e=>{setFilters({...filters,active:e.target.value}); setPagination(p=>({...p,page:1}))}}><option value="">All status</option><option value="true">Active</option><option value="false">Inactive</option></select>
      </div>

      {loading ? <p>Loading recipes…</p> : !rows.length ? <p className="empty">No menu items. Create the first recipe above.</p> :
        <div className="table-scroll">
          <table>
            <thead><tr><th>Code / Name</th><th>Category</th><th>Price</th><th>Recipe Cost</th><th>Packaging</th><th>Food Cost</th><th>Margin</th><th>Food %</th><th>Ingredients</th><th>Yield</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map(r=>(
                <tr key={r._id} style={{opacity: r.active===false?0.6:1}}>
                  <td><b>{r.code || '—'}</b><br/><span>{r.name}</span><small>{r.description||''}</small></td>
                  <td><span className="pill">{r.category}</span></td>
                  <td>{rs(r.price)}</td>
                  <td>{rs(r.recipeCost||0)}<br/><small>{r.ingredientCount|| (r.recipe||[]).length} items</small></td>
                  <td>{rs(r.packagingCost||0)}</td>
                  <td><b>{rs(r.foodCost||0)}</b><br/><small>{rs(r.recipeCost||0)}+{rs(r.packagingCost||0)}</small></td>
                  <td style={{color: (r.margin||0)>=100 ? '#15803d' : '#b45309'}}>{rs(r.margin||0)}</td>
                  <td>{(r.foodCostPercent||0).toFixed(1)}%</td>
                  <td>{(r.recipe||[]).map(line=> <small key={line.ingredient?._id||line.ingredient} style={{display:'block'}}>{line.ingredientName||line.ingredient?.name||'Ingredient'} — {qtyLabel(line.qty, line.unit)}</small>)}</td>
                  <td>{r.yield} {r.yieldUnit}</td>
                  <td><span className={`pill ${r.active?'ok':''}`}>{r.active?'Active':'Inactive'}</span></td>
                  <td>
                    <button title="Detail" onClick={()=>openDetail(r)}><Search size={14}/></button>
                    <button title="Edit" onClick={()=>{const full=r; startEdit(full);}}><Pencil size={14}/></button>
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
          <div className="panel" style={{maxWidth:'760px', width:'90%', maxHeight:'80vh', overflow:'auto'}} onClick={e=>e.stopPropagation()}>
            <div className="title"><div><h2>{detail.name} — {detail.code}</h2><p>{detail.category} • {detail.yield} {detail.yieldUnit} • {detail.active?'Active':'Inactive'}</p></div><button onClick={()=>setDetail(null)}><X size={18}/></button></div>
            <div style={{display:'flex', gap:'12px', flexWrap:'wrap', marginTop:'10px'}}>
              <span style={{background:'#f0fdf4', padding:'8px', borderRadius:'6px'}}><small>Price</small><br/><strong>{rs(detail.price)}</strong></span>
              <span style={{background:'#eff6ff', padding:'8px', borderRadius:'6px'}}><small>Recipe cost</small><br/><strong>{rs(detail.recipeCost)}</strong></span>
              <span style={{background:'#fefce8', padding:'8px', borderRadius:'6px'}}><small>Packaging</small><br/><strong>{rs(detail.packagingCost||0)}</strong></span>
              <span style={{background:'#faf5ff', padding:'8px', borderRadius:'6px'}}><small>Food Cost</small><br/><strong>{rs(detail.foodCost||0)}</strong> <small>{detail.foodCostPercent}%</small></span>
              <span style={{background: (detail.margin||0)>=100 ? '#f0fdf4' : '#fffbeb', padding:'8px', borderRadius:'6px'}}><small>Gross Margin</small><br/><strong>{rs(detail.margin)}</strong> <small>{detail.price?`Price - Food`:`-`}</small></span>
              <span style={{background:'#e0f2fe', padding:'8px', borderRadius:'6px'}}><small>Version</small><br/><strong>V{detail.recipeVersion||1}</strong> <small>{(detail.recipeHistory||[]).length} history</small></span>
            </div>
            {(detail.recipeHistory||[]).length>0 && <div style={{marginTop:'10px', background:'#f8fafc', padding:'8px', borderRadius:'6px', border:'1px solid #e2e8f0'}}><b>Recipe Versions</b><div style={{maxHeight:'120px', overflow:'auto', marginTop:'6px'}}>{detail.recipeHistory.slice().reverse().map(h=> <div key={h.version} style={{display:'flex', justifyContent:'space-between', fontSize:'12px', borderBottom:'1px dotted #cbd5e1', padding:'4px 0'}}><span>V{h.version} — {rs(h.recipeCost)}+{rs(h.packagingCost)}={rs(h.foodCost)} {h.reason||''}</span><span>{h.updatedAt? new Date(h.updatedAt).toLocaleDateString('en-NP'):''}</span></div>)}</div><small>Burger V1 → V2 preserved; old orders keep V1 cost</small></div>}
            <div style={{marginTop:'12px'}}>
              <b>Recipe — Ingredients → Quantity → Cost</b>
              <div style={{marginTop:'6px', display:'grid', gap:'6px'}}>
                {(detail.recipe||[]).map(line=> (
                  <div key={String(line.ingredient?._id||line.ingredient)} style={{display:'flex', justifyContent:'space-between', borderBottom:'1px solid #eee', padding:'8px 0'}}>
                    <span><b>{line.ingredientName||line.ingredient?.name||'Ingredient'}</b> <small>{line.ingredientCode||''} • {line.ingredient?.category||''}</small><br/><small>{qtyLabel(line.qty, line.unit)} → base {line.baseUnit||line.ingredientUnit||line.unit} • {line.notes||''}</small></span>
                    <span style={{textAlign:'right'}}>{rs(line.cost||0)}<br/><small>{rs(line.cost && line.qty ? line.cost/line.qty : 0)}/{line.unit}</small></span>
                  </div>
                ))}
              </div>
              <small style={{opacity:0.6, display:'block', marginTop:'6px'}}>Cost = Σ(quantity in base unit × ingredient averageCost). Uses FEFO-ready valuation; purchase price changes reflect in next recipe cost.</small>
            </div>
            {detail.description && <p style={{marginTop:'10px', opacity:0.7}}>{detail.description}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
