import React, {useEffect, useRef, useState} from 'react';
import {connectBranchSocket} from './socket.js';

const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-NP', {maximumFractionDigits: 2});
const remaining = line => Math.max(0, Number(line.orderedQty || 0) - Number(line.receivedQty || 0));
const accepted = line => Math.max(0, Number(line.receivedQty || 0) - Number(line.damagedQty || 0));
const returnable = line => Math.max(0, accepted(line) - Number(line.returnedQty || 0));
const returnLotKey = (poItem, batchId) => `${poItem}:${batchId}`;
const ymd = d => {
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(d));
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};
const todayKathmandu = () => ymd(new Date());
const draftRow = () => ({key: globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2), catalogItem: '', ingredient: '', purchaseQty: 1, qty: 1, price: 0});
const requestKey = () => globalThis.crypto?.randomUUID?.() || `po-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const canReceivePo = s => ['approved', 'sent', 'partially_received'].includes(s);
const poPill = s => ['approved', 'sent', 'partially_received', 'received'].includes(s) ? 'pill ok' : 'pill';
const DAMAGE_REASON_OPTIONS = [
  ['transport_damage', 'Transport damage'],
  ['packaging_damage', 'Packaging damage'],
  ['temperature_abuse', 'Temperature issue'],
  ['spoiled', 'Spoiled'],
  ['expired', 'Expired'],
  ['quality', 'Quality issue'],
  ['wrong_item', 'Wrong item'],
  ['other', 'Other']
];
const damageReasonLabel = value => DAMAGE_REASON_OPTIONS.find(option => option[0] === value)?.[1]
  || (value === 'legacy_unspecified' ? 'Legacy reason unavailable' : String(value || 'Not recorded').replaceAll('_', ' '));

export default function Purchasing({call, user, token}) {
  const locked = user?.role !== 'owner';
  const canManagePurchasing = ['owner', 'manager'].includes(user?.role);
  const [accessibleBranches, setAccessibleBranches] = useState([]);
  const visibleBranches = accessibleBranches;
  const [branchId, setBranchId] = useState('');
  const branch = visibleBranches.find(b => b._id === branchId) || null;
  const [po, setPo] = useState([]);
  const [poPagination, setPoPagination] = useState({page: 1, limit: 25, total: 0, pages: 1});
  const [poSummary, setPoSummary] = useState({subtotal: 0, vat: 0, total: 0, open: 0, pendingApprovals: 0});
  const [poLoading, setPoLoading] = useState(false);
  const [poFilters, setPoFilters] = useState({q: '', supplier: '', status: '', from: '', to: ''});
  const [filterDraft, setFilterDraft] = useState({q: '', supplier: '', status: '', from: '', to: ''});
  const [suppliers, setSuppliers] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [returns, setReturns] = useState([]);
  const [returnOptions, setReturnOptions] = useState({items: [], summary: {returnableQty: 0, availableQty: 0, legacyLines: 0}});
  const [returnOptionsLoading, setReturnOptionsLoading] = useState(false);
  const [approvalHistory, setApprovalHistory] = useState([]);
  const [approvalAction, setApprovalAction] = useState(null);
  const [shortCloseAction, setShortCloseAction] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  const [lines, setLines] = useState({});
  const [retLines, setRetLines] = useState({});
  const [notes, setNotes] = useState('');
  const [returnNotes, setReturnNotes] = useState('');
  const [reason, setReason] = useState('quality');
  const [busy, setBusy] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadedFor, setCatalogLoadedFor] = useState('');
  const [form, setForm] = useState({supplier: '', orderDate: todayKathmandu(), expectedDeliveryDate: '', deliveryAddress: '', notes: ''});
  const [draftLines, setDraftLines] = useState([draftRow()]);
  const [editingPoId, setEditingPoId] = useState('');
  const createRequestKey = useRef(requestKey());
  const receiptRequestKey = useRef(requestKey());
  const returnRequestKey = useRef(requestKey());
  const [success, setSuccess] = useState('');
  const [invoice, setInvoice] = useState({supplier: '', purchaseOrder: '', invoiceNo: '', invoiceDate: todayKathmandu(), dueDate: '', amount: 0, priceIncludesVat: false, vatRate: 13, notes: '', attachmentUrl: ''});
  const invoiceRequestKey = useRef(requestKey());
  const [statementId, setStatementId] = useState('');
  const [statement, setStatement] = useState(null);
  const [invoicePays, setInvoicePays] = useState([]);
  const [payInvoiceId, setPayInvoiceId] = useState('');
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentForm, setPaymentForm] = useState({amount: '', method: 'cash', reference: '', paidAt: todayKathmandu()});
  const paymentRequestKey = useRef(requestKey());
  const [reverseAction, setReverseAction] = useState(null);
  const [report, setReport] = useState(null);
  const [editId, setEditId] = useState('');
  const [edit, setEdit] = useState({invoiceNo: '', purchaseOrder: '', invoiceDate: '', dueDate: '', amount: 0, priceIncludesVat: false, vatRate: 13, notes: '', attachmentUrl: ''});
  const [live, setLive] = useState('connecting');
  const authToken = token || (typeof localStorage !== 'undefined' ? localStorage.token : '');
  const loadSequence = useRef(0);

  const load = () => {
    if (!branch?._id) return Promise.resolve();
    const sequence = ++loadSequence.current;
    const query = new URLSearchParams({
      branch: branch._id,
      page: String(poPagination.page || 1),
      limit: String(poPagination.limit || 25)
    });
    Object.entries(poFilters).forEach(([key, value]) => value && query.set(key, value));
    setPoLoading(true);
    return Promise.all([
      call('/purchase-orders?' + query.toString()),
      call('/supplier-catalog/options'),
      canManagePurchasing ? call('/supplier-invoices?branch=' + branch._id) : Promise.resolve([]),
      canManagePurchasing ? call('/reports/purchasing?branch=' + branch._id) : Promise.resolve(null)
    ]).then(([a, b, d, e]) => {
      if (sequence !== loadSequence.current) return;
      setPo(a.items || (Array.isArray(a) ? a : []));
      setPoPagination(a.pagination || {page: 1, limit: 25, total: a.length || 0, pages: 1});
      setPoSummary(a.summary || {subtotal: 0, vat: 0, total: 0, open: 0, pendingApprovals: 0});
      setSuppliers(b.suppliers || []);
      setIngredients(b.ingredients || []);
      setInvoices(d);
      setReport(e);
    }).catch(e => {
      if (sequence === loadSequence.current) setError(e.message);
    }).finally(() => {
      if (sequence === loadSequence.current) setPoLoading(false);
    });
  };

  useEffect(() => {
    let cancelled = false;
    call('/purchase-order-branches')
      .then(result => {
        if (!cancelled) setAccessibleBranches(Array.isArray(result) ? result : []);
      })
      .catch(err => !cancelled && setError(err.message || 'Could not load purchasing branches'));
    return () => { cancelled = true; };
  }, [user?._id]);

  useEffect(() => {
    if (visibleBranches.length && !visibleBranches.some(item => item._id === branchId)) setBranchId(visibleBranches[0]._id);
    else if (!visibleBranches.length && branchId) setBranchId('');
  }, [visibleBranches, branchId]);

  useEffect(() => { load(); }, [branch?._id, poFilters, poPagination.page]);

  useEffect(() => {
    if (!form.supplier) {
      setCatalog([]);
      setCatalogLoadedFor('');
      return;
    }
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogLoadedFor('');
    call(`/supplier-catalog?supplier=${form.supplier}&limit=200`)
      .then(result => {
        if (cancelled) return;
        setCatalog(result.items || []);
        setCatalogLoadedFor(form.supplier);
      })
      .catch(err => !cancelled && setError(err.message || 'Could not load current supplier catalog'))
      .finally(() => !cancelled && setCatalogLoading(false));
    return () => { cancelled = true; };
  }, [form.supplier]);

  useEffect(() => {
    setPo([]);
    setPoSummary({subtotal: 0, vat: 0, total: 0, open: 0, pendingApprovals: 0});
    setInvoices([]);
    setReport(null);
    setOpenId('');
    setReceipts([]);
    setReturns([]);
    setReturnOptions({items: [], summary: {returnableQty: 0, availableQty: 0, legacyLines: 0}});
    setReturnOptionsLoading(false);
    setApprovalHistory([]);
    setApprovalAction(null);
    setStatement(null);
    setStatementId('');
    setPayInvoiceId('');
    setInvoicePays([]);
    setPaymentLoading(false);
    setPaymentForm({amount: '', method: 'cash', reference: '', paidAt: todayKathmandu()});
    paymentRequestKey.current = requestKey();
    setReverseAction(null);
    setEditId('');
    setInvoice({supplier: '', purchaseOrder: '', invoiceNo: '', invoiceDate: todayKathmandu(), dueDate: '', amount: 0, priceIncludesVat: false, vatRate: 13, notes: '', attachmentUrl: ''});
    invoiceRequestKey.current = requestKey();
    setEditingPoId('');
    setSuccess('');
    setPoPagination(current => current.page === 1 ? current : {...current, page: 1});
  }, [branchId]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const statementIdRef = useRef(statementId);
  statementIdRef.current = statementId;
  const payInvoiceIdRef = useRef(payInvoiceId);
  payInvoiceIdRef.current = payInvoiceId;

  const refreshOpenHistory = async id => {
    if (!id) return;
    setReturnOptionsLoading(true);
    try {
      const [r, ret, approvals, options] = await Promise.all([
        call('/purchase-orders/' + id + '/receipts'),
        call('/purchase-orders/' + id + '/returns'),
        call('/purchase-orders/' + id + '/approval-history'),
        call('/purchase-orders/' + id + '/return-options')
      ]);
      setReceipts(r);
      setReturns(ret);
      setApprovalHistory(approvals);
      setReturnOptions(options);
    } catch {
      /* list reload still ran */
    } finally {
      setReturnOptionsLoading(false);
    }
  };

  useEffect(() => {
    if (live === 'live') return;
    const tick = setInterval(() => loadRef.current(), 8000);
    return () => clearInterval(tick);
  }, [branch?._id, live]);

  useEffect(() => {
    if (!authToken || !branch?._id) return undefined;
    const socket = connectBranchSocket(authToken, branch._id);
    const onUpdate = payload => {
      if (payload?.branch && String(payload.branch) !== String(branch._id)) return;
      loadRef.current();
      if (openIdRef.current && payload.poId && String(payload.poId) === String(openIdRef.current)) {
        refreshOpenHistory(openIdRef.current);
      }
      if (statementIdRef.current && payload.supplierId && String(payload.supplierId) === String(statementIdRef.current)) {
        call('/suppliers/' + statementIdRef.current + '/statement?branch=' + branch._id)
          .then(setStatement)
          .catch(() => {});
      }
      if (payInvoiceIdRef.current && payload.invoiceId && String(payload.invoiceId) === String(payInvoiceIdRef.current)) {
        call('/supplier-invoices/' + payInvoiceIdRef.current + '/payments')
          .then(setInvoicePays)
          .catch(() => {});
      }
    };
    socket.on('connect', () => {
      setLive('live');
      socket.emit('join:branch', branch._id, ack => {
        if (ack && ack.ok === false) setError(ack.message || 'Could not join purchasing room');
      });
      loadRef.current();
    });
    socket.on('disconnect', reason => {
      setLive(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    });
    socket.on('connect_error', () => setLive('reconnecting'));
    socket.on('purchasing:update', onUpdate);
    return () => {
      socket.emit('leave:branch', branch._id);
      socket.off('purchasing:update', onUpdate);
      socket.disconnect();
    };
  }, [authToken, branch?._id]);

  const openReceive = async order => {
    setError('');
    setOpenId(order._id);
    setApprovalAction(null);
    setShortCloseAction(null);
    setApprovalHistory([]);
    setNotes('');
    receiptRequestKey.current = requestKey();
    setLines(Object.fromEntries((order.items || []).map(i => [i._id, {
      receivedQty: 0,
      damagedQty: 0,
      damageReason: '',
      damageNotes: '',
      batchNumber: '',
      expiryDate: ''
    }])));
    setReturnNotes('');
    setReason('quality');
    setRetLines({});
    returnRequestKey.current = requestKey();
    setReturnOptionsLoading(true);
    try {
      const [r, ret, approvals, options] = await Promise.all([
        call('/purchase-orders/' + order._id + '/receipts'),
        call('/purchase-orders/' + order._id + '/returns'),
        call('/purchase-orders/' + order._id + '/approval-history'),
        call('/purchase-orders/' + order._id + '/return-options')
      ]);
      setReceipts(r);
      setReturns(ret);
      setApprovalHistory(approvals);
      setReturnOptions(options);
    } catch (e) {
      setReceipts([]);
      setReturns([]);
      setReturnOptions({items: [], summary: {returnableQty: 0, availableQty: 0, legacyLines: 0}});
      setApprovalHistory([]);
      setError(e.message);
    } finally {
      setReturnOptionsLoading(false);
    }
  };

  const changeDraftLine = (key, patch) => setDraftLines(current => current.map(line => line.key === key ? {...line, ...patch} : line));
  const addDraftLine = () => setDraftLines(current => [...current, draftRow()]);
  const removeDraftLine = key => setDraftLines(current => current.length === 1 ? current : current.filter(line => line.key !== key));
  const resetDraft = () => {
    setEditingPoId('');
    setForm({supplier: '', orderDate: todayKathmandu(), expectedDeliveryDate: '', deliveryAddress: '', notes: ''});
    setDraftLines([draftRow()]);
    createRequestKey.current = requestKey();
  };
  const openDraftEdit = order => {
    setError('');
    setSuccess('');
    setEditingPoId(order._id);
    setForm({
      supplier: order.supplier?._id || order.supplier || '',
      orderDate: ymd(order.orderDate || order.createdAt),
      expectedDeliveryDate: ymd(order.expectedDeliveryDate),
      deliveryAddress: order.deliveryAddress || '',
      notes: order.notes || ''
    });
    setDraftLines((order.items || []).map(item => ({
      key: item._id || requestKey(),
      catalogItem: item.catalogItem?._id || item.catalogItem || '',
      ingredient: item.ingredient?._id || item.ingredient || '',
      purchaseQty: item.purchaseQty || 1,
      qty: item.orderedQty || 1,
      price: item.unitPrice || 0
    })));
    document.querySelector('.po-create-box')?.scrollIntoView({behavior: 'smooth', block: 'start'});
  };

  const create = async e => {
    e.preventDefault();
    if (!branch || !form.supplier || !draftLines.length) return;
    setError('');
    setSuccess('');
    setBusy('create-po');
    try {
      if (!catalogReady) throw new Error('Wait for the supplier terms to finish loading');
      const usesCatalog = catalog.length > 0;
      const items = draftLines.map((line, index) => {
        if (usesCatalog) {
          const mapping = activeCatalog.find(item => item._id === line.catalogItem);
          if (!mapping) throw new Error(`Choose an active catalog item on line ${index + 1}`);
          if (!(Number(line.purchaseQty) > 0)) throw new Error(`Enter a purchase quantity on line ${index + 1}`);
          return {catalogItem: mapping._id, ingredient: mapping.ingredient._id, purchaseQty: Number(line.purchaseQty)};
        }
        const ingredient = ingredients.find(item => item._id === line.ingredient);
        if (!ingredient) throw new Error(`Choose an ingredient on line ${index + 1}`);
        if (!(Number(line.qty) > 0) || !(Number(line.price) > 0)) throw new Error(`Quantity and unit price must be positive on line ${index + 1}`);
        return {ingredient: line.ingredient, orderedQty: Number(line.qty), unit: ingredient.unit || 'each', unitPrice: Number(line.price)};
      });
      const identities = items.map(item => item.catalogItem || item.ingredient);
      if (new Set(identities).size !== identities.length) throw new Error('Each ingredient can appear only once on a purchase order');
      const common = {
        supplier: form.supplier,
        items,
        expectedDeliveryDate: form.expectedDeliveryDate || (editingPoId ? null : undefined),
        deliveryAddress: form.deliveryAddress,
        notes: form.notes
      };
      let saved;
      if (editingPoId) {
        const current = po.find(order => order._id === editingPoId);
        if (!current) throw new Error('This draft is no longer on the current page; refresh and try again');
        saved = await call('/purchase-orders/' + editingPoId, {
          method: 'PATCH',
          body: JSON.stringify({...common, expectedVersion: current.__v})
        });
      } else {
        saved = await call('/purchase-orders', {
          method: 'POST',
          headers: {'Idempotency-Key': createRequestKey.current},
          body: JSON.stringify({...common, branch: branch._id, orderDate: form.orderDate || undefined})
        });
      }
      setSuccess(`${saved.poNo} ${editingPoId ? 'updated' : 'created as a draft'}.`);
      resetDraft();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const receive = async order => {
    const items = (order.items || []).map(i => {
      const row = lines[i._id] || {};
      return {
        itemId: i._id,
        receivedQty: Number(row.receivedQty || 0),
        damagedQty: Number(row.damagedQty || 0),
        damageReason: Number(row.damagedQty || 0) > 0 ? (row.damageReason || undefined) : undefined,
        damageNotes: Number(row.damagedQty || 0) > 0 ? (row.damageNotes?.trim() || undefined) : undefined,
        batchNumber: row.batchNumber || undefined,
        expiryDate: row.expiryDate || undefined
      };
    }).filter(item => item.receivedQty > 0);
    if (!items.length) {
      setError('Enter a received quantity on at least one line');
      return;
    }
    const invalid = items.find(item => !Number.isFinite(item.receivedQty)
      || !Number.isFinite(item.damagedQty)
      || item.damagedQty < 0
      || item.damagedQty > item.receivedQty);
    if (invalid) {
      setError('Damaged quantity must be between zero and the received quantity');
      return;
    }
    const undocumentedDamage = items.find(item => item.damagedQty > 0 && !item.damageReason);
    if (undocumentedDamage) {
      setError('Choose a reason for every line with damaged goods');
      return;
    }
    const unexplainedOther = items.find(item => item.damageReason === 'other' && String(item.damageNotes || '').trim().length < 3);
    if (unexplainedOther) {
      setError('Add at least 3 characters of damage detail when the reason is Other');
      return;
    }
    if (items.some(item => item.expiryDate && !String(item.batchNumber || '').trim())) {
      setError('Enter a batch number for every line with an expiry date');
      return;
    }
    if (items.some(item => item.receivedQty > item.damagedQty && item.expiryDate && item.expiryDate < todayKathmandu())) {
      setError('Expired goods cannot be accepted into usable inventory; record the full quantity as damaged or correct the expiry date');
      return;
    }
    const receivedTotal = items.reduce((sum, item) => sum + item.receivedQty, 0);
    const acceptedTotal = items.reduce((sum, item) => sum + item.receivedQty - item.damagedQty, 0);
    if (typeof globalThis.confirm === 'function'
      && !globalThis.confirm(`Post this receipt? ${receivedTotal} units received; ${acceptedTotal} accepted into usable stock. This inventory movement cannot be edited.`)) return;
    setBusy(order._id);
    setError('');
    setSuccess('');
    try {
      const result = await call('/purchase-orders/' + order._id + '/receive', {
        method: 'POST',
        headers: {'Idempotency-Key': receiptRequestKey.current},
        body: JSON.stringify({items, notes, expectedVersion: order.__v})
      });
      setNotes('');
      await load();
      const fresh = await call('/purchase-orders/' + order._id);
      await openReceive(fresh);
      setSuccess(`${result.receipt.receiptNo} ${result.duplicate ? 'was already posted; no stock was added again' : 'posted successfully'}. Accepted value: ${rs(result.receipt.acceptedValue)}.`);
    } catch (e) {
      setError(e.message || 'Receiving failed');
    } finally {
      setBusy('');
    }
  };

  const postReturn = async order => {
    const items = (returnOptions.items || []).flatMap(option => (option.batches || []).map(batch => ({
      itemId: option.poItem,
      batchId: batch.batchId,
      qty: Number(retLines[returnLotKey(option.poItem, batch.batchId)] || 0),
      availableQty: Number(batch.availableQty || 0)
    }))).filter(item => item.qty > 0);
    if (!items.length) {
      setError('Enter a return quantity for at least one available batch');
      return;
    }
    if (items.some(item => !Number.isFinite(item.qty) || item.qty > item.availableQty)) {
      setError('A return quantity exceeds the currently available quantity in its batch');
      return;
    }
    const excessiveLine = (returnOptions.items || []).find(option => items
      .filter(item => String(item.itemId) === String(option.poItem))
      .reduce((sum, item) => sum + item.qty, 0) > Number(option.returnableQty || 0));
    if (excessiveLine) {
      setError('A return quantity exceeds the accepted stock remaining on its purchase order line');
      return;
    }
    if (reason === 'other' && returnNotes.trim().length < 3) {
      setError('Add at least 3 characters of return detail when the reason is Other');
      return;
    }
    const quantity = items.reduce((sum, item) => sum + item.qty, 0);
    if (typeof globalThis.confirm === 'function'
      && !globalThis.confirm(`Post this supplier return? ${quantity} units will be removed from the selected stock batches. This movement cannot be edited.`)) return;
    setBusy('ret-' + order._id);
    setError('');
    setSuccess('');
    try {
      const result = await call('/purchase-orders/' + order._id + '/returns', {
        method: 'POST',
        headers: {'Idempotency-Key': returnRequestKey.current},
        body: JSON.stringify({
          items: items.map(({itemId, batchId, qty}) => ({itemId, batchId, qty})),
          reason,
          notes: returnNotes.trim() || undefined,
          expectedVersion: order.__v
        })
      });
      setReturnNotes('');
      setRetLines({});
      returnRequestKey.current = requestKey();
      await load();
      const fresh = await call('/purchase-orders/' + order._id);
      await openReceive(fresh);
      setSuccess(`${result.purchaseReturn.returnNo} ${result.duplicate ? 'was already posted; no stock was removed again' : 'posted successfully'} for ${rs(result.purchaseReturn.total)} including VAT.`);
    } catch (e) {
      setError(e.message || 'Return failed');
    } finally {
      setBusy('');
    }
  };

  const createInvoice = async e => {
    e.preventDefault();
    if (!branch) return;
    const amount = Number(invoice.amount || 0);
    if (!(amount > 0)) {
      setError('Invoice amount must be greater than zero');
      return;
    }
    const payload = {
      branch: branch._id,
      supplier: invoice.supplier,
      purchaseOrder: invoice.purchaseOrder || undefined,
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate || undefined,
      dueDate: invoice.dueDate || undefined,
      priceIncludesVat: invoice.priceIncludesVat,
      vatRate: Number(invoice.vatRate),
      notes: invoice.notes.trim() || undefined,
      attachmentUrl: invoice.attachmentUrl.trim() || undefined,
      ...(invoice.priceIncludesVat ? {total: amount} : {subtotal: amount})
    };
    setBusy('create-invoice');
    setError('');
    setSuccess('');
    try {
      const created = await call('/supplier-invoices', {
        method: 'POST',
        headers: {'Idempotency-Key': invoiceRequestKey.current},
        body: JSON.stringify(payload)
      });
      invoiceRequestKey.current = requestKey();
      setInvoice({...invoice, purchaseOrder: '', invoiceNo: '', invoiceDate: todayKathmandu(), dueDate: '', amount: 0, notes: '', attachmentUrl: ''});
      await load();
      setSuccess(`${created.invoiceNo} ${created.duplicate ? 'was already recorded' : 'created'} for ${rs(created.total)}. Matching: ${String(created.matching?.status || 'unlinked').replaceAll('_', ' ')}.`);
      if (statementId === invoice.supplier) await loadStatement(invoice.supplier);
    } catch (err) {
      setError(err.message || 'Invoice creation failed');
    } finally {
      setBusy('');
    }
  };

  const openInvoicePayments = async (inv, preparePayment = false) => {
    setError('');
    setSuccess('');
    const changingInvoice = String(inv._id) !== String(payInvoiceId);
    setPayInvoiceId(inv._id);
    if (changingInvoice) setInvoicePays([]);
    setReverseAction(null);
    if (preparePayment || changingInvoice) {
      setPaymentForm({
        amount: Math.max(0, Number(inv.total || 0) - Number(inv.paidAmount || 0)).toFixed(2),
        method: 'cash',
        reference: '',
        paidAt: todayKathmandu()
      });
      paymentRequestKey.current = requestKey();
    }
    setPaymentLoading(true);
    try {
      setInvoicePays(await call('/supplier-invoices/' + inv._id + '/payments'));
    } catch (e) {
      setInvoicePays([]);
      setError(e.message || 'Could not load invoice payment history');
    } finally {
      setPaymentLoading(false);
    }
  };

  const recordPayment = async event => {
    event.preventDefault();
    const inv = invoices.find(item => item._id === payInvoiceId);
    if (!inv || ['paid', 'void'].includes(inv.status)) return;
    const amount = Number(paymentForm.amount);
    const due = Math.max(0, Number(inv.total || 0) - Number(inv.paidAmount || 0));
    if (!Number.isFinite(amount) || amount <= 0 || amount > due + 0.001) {
      setError(`Enter a payment greater than zero and no more than ${rs(due)}`);
      return;
    }
    if (paymentForm.method !== 'cash' && paymentForm.reference.trim().length < 3) {
      setError('Enter a bank, wallet, or card reference of at least 3 characters');
      return;
    }
    if (typeof globalThis.confirm === 'function'
      && !globalThis.confirm(`Record ${rs(amount)} against ${inv.invoiceNo} by ${paymentForm.method}? This creates an auditable payment entry.`)) return;
    setBusy('pay-' + inv._id);
    setError('');
    setSuccess('');
    try {
      const result = await call('/supplier-invoices/' + inv._id + '/payments', {
        method: 'POST',
        headers: {'Idempotency-Key': paymentRequestKey.current},
        body: JSON.stringify({
          amount,
          method: paymentForm.method,
          reference: paymentForm.reference.trim() || undefined,
          paidAt: paymentForm.paidAt || undefined,
          expectedInvoiceVersion: inv.__v
        })
      });
      paymentRequestKey.current = requestKey();
      setPaymentForm({
        amount: Math.max(0, Number(result.invoice?.total || 0) - Number(result.invoice?.paidAmount || 0)).toFixed(2),
        method: paymentForm.method,
        reference: '',
        paidAt: todayKathmandu()
      });
      setInvoicePays(await call('/supplier-invoices/' + inv._id + '/payments'));
      await load();
      const supplierId = inv.supplier?._id || inv.supplier;
      if (statementId === supplierId) await loadStatement(statementId);
      setSuccess(`${result.payment?.paymentNo || 'Payment'} ${result.duplicate ? 'was already recorded' : 'recorded'} for ${rs(result.payment?.amount || amount)}.`);
    } catch (e) {
      setError(e.message || 'Supplier payment failed');
    } finally {
      setBusy('');
    }
  };

  const requestPaymentReversal = payment => {
    setError('');
    setSuccess('');
    setReverseAction({payment, reason: '', requestKey: requestKey()});
  };

  const reversePayment = async event => {
    event.preventDefault();
    const payment = reverseAction?.payment;
    const reasonText = String(reverseAction?.reason || '').trim();
    const inv = invoices.find(item => item._id === payInvoiceId);
    if (!payment || !inv || reasonText.length < 3) return;
    if (typeof globalThis.confirm === 'function'
      && !globalThis.confirm(`Reverse ${payment.paymentNo || 'this payment'} for ${rs(payment.amount)}? The invoice balance will be restored and the original entry retained.`)) return;
    setBusy('reverse-' + payment._id);
    setError('');
    setSuccess('');
    try {
      const result = await call('/supplier-payments/' + payment._id + '/reverse', {
        method: 'POST',
        headers: {'Idempotency-Key': reverseAction.requestKey},
        body: JSON.stringify({reason: reasonText, expectedInvoiceVersion: inv.__v})
      });
      setReverseAction(null);
      setPaymentForm(current => ({
        ...current,
        amount: Math.max(0, Number(result.invoice?.total || 0) - Number(result.invoice?.paidAmount || 0)).toFixed(2),
        reference: '',
        paidAt: todayKathmandu()
      }));
      setInvoicePays(await call('/supplier-invoices/' + inv._id + '/payments'));
      await load();
      const supplierId = inv.supplier?._id || inv.supplier;
      if (statementId === supplierId) await loadStatement(statementId);
      setSuccess(`${result.payment?.paymentNo || 'Payment'} ${result.duplicate ? 'reversal was already recorded' : 'reversed'}; ${rs(result.payment?.amount || payment.amount)} is due again.`);
    } catch (e) {
      setError(e.message || 'Supplier payment reversal failed');
    } finally {
      setBusy('');
    }
  };

  const loadStatement = async id => {
    if (!id) {
      setStatement(null);
      return;
    }
    setError('');
    try {
      const data = await call('/suppliers/' + id + '/statement' + (branch ? `?branch=${branch._id}` : ''));
      setStatement(data);
    } catch (e) {
      setStatement(null);
      setError(e.message);
    }
  };

  const showInvoicePays = inv => openInvoicePayments(inv, false);

  const openEdit = inv => {
    setError('');
    setEditId(inv._id);
    setEdit({
      invoiceNo: inv.invoiceNo || '',
      purchaseOrder: inv.purchaseOrder?._id || inv.purchaseOrder || '',
      invoiceDate: ymd(inv.invoiceDate),
      dueDate: ymd(inv.dueDate),
      amount: inv.priceIncludesVat ? inv.total || 0 : inv.subtotal || 0,
      priceIncludesVat: Boolean(inv.priceIncludesVat),
      vatRate: Number(inv.vatRate ?? 13),
      notes: inv.notes || '',
      attachmentUrl: inv.attachmentUrl || ''
    });
  };

  const saveEdit = async e => {
    e.preventDefault();
    const current = invoices.find(x => x._id === editId);
    if (!current || current.status === 'void') return;
    const locked = Number(current.paidAmount || 0) > 0 || Number(current.paymentCount || 0) > 0;
    const amount = Number(edit.amount || 0);
    const body = {
      invoiceNo: edit.invoiceNo,
      invoiceDate: edit.invoiceDate || undefined,
      dueDate: edit.dueDate || null,
      notes: edit.notes,
      attachmentUrl: edit.attachmentUrl,
      expectedVersion: current.__v
    };
    if (!locked) {
      body.priceIncludesVat = edit.priceIncludesVat;
      body.vatRate = Number(edit.vatRate);
      if (edit.priceIncludesVat) body.total = amount;
      else body.subtotal = amount;
      const currentPoId = current.purchaseOrder?._id || current.purchaseOrder || '';
      if (String(edit.purchaseOrder || '') !== String(currentPoId)) {
        body.purchaseOrder = edit.purchaseOrder || null;
      }
    }
    setBusy('edit-' + editId);
    setError('');
    try {
      await call('/supplier-invoices/' + editId, {method: 'PATCH', body: JSON.stringify(body)});
      await load();
      if (statementId === (current.supplier?._id || current.supplier)) await loadStatement(statementId);
    } catch (err) {
      setError(err.message || 'Invoice update failed');
    } finally {
      setBusy('');
    }
  };

  const setPoStatus = async (order, status, statusNotes = '') => {
    if (status === 'cancelled' && !window.confirm('Cancel ' + order.poNo + '?')) return;
    setBusy('st-' + order._id);
    setError('');
    setSuccess('');
    try {
      const updated = await call('/purchase-orders/' + order._id + '/status', {
        method: 'PATCH',
        body: JSON.stringify({status, notes: statusNotes.trim() || undefined, expectedVersion: order.__v})
      });
      setApprovalAction(null);
      setSuccess(`${order.poNo} ${status === 'pending' ? 'submitted for approval' : status}.`);
      await load();
      if (openId === order._id) await openReceive(updated);
    } catch (e) {
      setError(e.message || 'Status update failed');
    } finally {
      setBusy('');
    }
  };

  const closeShort = async e => {
    e.preventDefault();
    const order = shortCloseAction?.order;
    const closeReason = String(shortCloseAction?.reason || '').trim();
    if (!order || closeReason.length < 3) return;
    if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`Close ${order.poNo} with its outstanding quantities unreceived? This ends further receiving on the PO.`)) return;
    setBusy('short-' + order._id);
    setError('');
    setSuccess('');
    try {
      const updated = await call('/purchase-orders/' + order._id + '/close-short', {
        method: 'POST',
        headers: {'Idempotency-Key': shortCloseAction.requestKey},
        body: JSON.stringify({reason: closeReason, expectedVersion: order.__v})
      });
      setShortCloseAction(null);
      setSuccess(`${order.poNo} closed short. Outstanding quantities remain visible but cannot be received.`);
      await load();
      if (openId === order._id) await openReceive(updated);
    } catch (err) {
      setError(err.message || 'Could not close the partial purchase order');
    } finally {
      setBusy('');
    }
  };

  const sameUser = actor => String(actor?._id || actor || '') === String(user?._id || user?.id || '');
  const canDecide = order => user?.role === 'owner' || (user?.role === 'manager' && !sameUser(order.createdBy) && !sameUser(order.submittedBy));
  const requestApprovalDecision = (order, status) => {
    setError('');
    setApprovalAction({order, status, notes: ''});
  };

  const voidInvoice = async inv => {
    if (Number(inv.paidAmount || 0) > 0) return;
    if (!window.confirm('Void invoice ' + inv.invoiceNo + '? It will drop off the supplier statement.')) return;
    setBusy('void-' + inv._id);
    setError('');
    try {
      await call('/supplier-invoices/' + inv._id, {method: 'PATCH', body: JSON.stringify({status: 'void', expectedVersion: inv.__v})});
      if (editId === inv._id) setEditId('');
      await load();
      if (statementId === (inv.supplier?._id || inv.supplier)) await loadStatement(statementId);
    } catch (err) {
      setError(err.message || 'Void failed');
    } finally {
      setBusy('');
    }
  };

  const open = po.find(x => x._id === openId);
  const receiptDraft = (open?.items || []).reduce((summary, item) => {
    const row = lines[item._id] || {};
    const receivedQty = Number(row.receivedQty || 0);
    const damagedQty = Number(row.damagedQty || 0);
    if (!(receivedQty > 0)) return summary;
    const acceptedQty = receivedQty - damagedQty;
    return {
      lineCount: summary.lineCount + 1,
      receivedQty: summary.receivedQty + receivedQty,
      damagedQty: summary.damagedQty + damagedQty,
      acceptedQty: summary.acceptedQty + Math.max(0, acceptedQty),
      acceptedValue: summary.acceptedValue + Math.max(0, acceptedQty) * Number(item.unitPrice || 0),
      invalid: summary.invalid
        || damagedQty < 0
        || damagedQty > receivedQty
        || receivedQty > remaining(item)
        || (damagedQty > 0 && !row.damageReason)
        || (row.damageReason === 'other' && String(row.damageNotes || '').trim().length < 3)
        || (row.expiryDate && !String(row.batchNumber || '').trim())
        || (receivedQty > damagedQty && row.expiryDate && row.expiryDate < todayKathmandu())
    };
  }, {lineCount: 0, receivedQty: 0, damagedQty: 0, acceptedQty: 0, acceptedValue: 0, invalid: false});
  const returnDraft = (returnOptions.items || []).reduce((summary, option) => {
    const poLine = (open?.items || []).find(item => String(item._id) === String(option.poItem));
    const selected = (option.batches || []).reduce((lineSummary, batch) => {
      const qty = Number(retLines[returnLotKey(option.poItem, batch.batchId)] || 0);
      return {
        qty: lineSummary.qty + Math.max(0, qty),
        invalid: lineSummary.invalid || !Number.isFinite(qty) || qty < 0 || qty > Number(batch.availableQty || 0)
      };
    }, {qty: 0, invalid: false});
    const subtotal = selected.qty * Number(poLine?.unitPrice || 0);
    const vatRate = Number(poLine?.vatRate ?? 13);
    return {
      lineCount: summary.lineCount + (selected.qty > 0 ? 1 : 0),
      qty: summary.qty + selected.qty,
      subtotal: summary.subtotal + subtotal,
      vat: summary.vat + subtotal * vatRate / 100,
      invalid: summary.invalid || selected.invalid || selected.qty > Number(option.returnableQty || 0)
    };
  }, {lineCount: 0, qty: 0, subtotal: 0, vat: 0, invalid: false});
  const catalogReady = Boolean(form.supplier) && catalogLoadedFor === form.supplier && !catalogLoading;
  const activeCatalog = catalog.filter(item => item.active);
  const supplierUsesCatalog = catalogReady && catalog.length > 0;
  const draftEstimate = draftLines.reduce((totals, line) => {
    if (supplierUsesCatalog) {
      const mapping = activeCatalog.find(item => item._id === line.catalogItem);
      if (!mapping) return totals;
      const quoted = Number(line.purchaseQty || 0) * Number(mapping.currentPrice || 0);
      const rate = Number(mapping.vatRate ?? 13);
      const subtotal = mapping.priceIncludesVat ? quoted / (1 + rate / 100) : quoted;
      return {subtotal: totals.subtotal + subtotal, vat: totals.vat + (mapping.priceIncludesVat ? quoted - subtotal : subtotal * rate / 100)};
    }
    const subtotal = Number(line.qty || 0) * Number(line.price || 0);
    return {subtotal: totals.subtotal + subtotal, vat: totals.vat + subtotal * 0.13};
  }, {subtotal: 0, vat: 0});
  const invoiceRate = Number(invoice.vatRate || 0);
  const invoiceAmount = Number(invoice.amount || 0);
  const invoiceDraftSubtotal = invoice.priceIncludesVat ? invoiceAmount / (1 + invoiceRate / 100) : invoiceAmount;
  const invoiceDraftVat = invoice.priceIncludesVat ? invoiceAmount - invoiceDraftSubtotal : invoiceDraftSubtotal * invoiceRate / 100;
  const invoiceDraftTotal = invoice.priceIncludesVat ? invoiceAmount : invoiceDraftSubtotal + invoiceDraftVat;
  const invoiceableOrders = po.filter(order =>
    ['approved', 'sent', 'partially_received', 'received', 'closed_short'].includes(order.status)
    && (!invoice.supplier || String(order.supplier?._id || order.supplier) === String(invoice.supplier))
  );
  const selectedPaymentInvoice = invoices.find(item => item._id === payInvoiceId);
  const selectedInvoiceDue = selectedPaymentInvoice
    ? Math.max(0, Number(selectedPaymentInvoice.total || 0) - Number(selectedPaymentInvoice.paidAmount || 0))
    : 0;
  const postedPaymentTotal = invoicePays.filter(item => item.status === 'posted').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const reversedPaymentTotal = invoicePays.filter(item => item.status === 'reversed').reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return (
    <section className="panel purchasing-panel">
      <div className="title">
        <div>
          <h2>Purchasing & goods receiving</h2>
          <p>POs start as drafts. Submit, then approve, before stock can be received. Live updates follow this branch. VAT on supplier invoices is 13%.</p>
        </div>
        <div className="kds-toolbar">
          <label className="po-branch-picker">Branch<select value={branchId} disabled={locked || visibleBranches.length < 2} onChange={e => setBranchId(e.target.value)}>
            {!visibleBranches.length && <option value="">No authorized branch</option>}
            {visibleBranches.map(item => <option key={item._id} value={item._id}>{item.name} ({item.code})</option>)}
          </select></label>
          <span className={'kds-live ' + (!branch ? 'off' : live === 'live' ? 'on' : live === 'reconnecting' || live === 'connecting' ? 'wait' : 'off')}>{!branch ? 'Unavailable' : live === 'live' ? 'Live' : live === 'reconnecting' ? 'Reconnecting' : live === 'offline' ? 'Offline' : 'Connecting'}</span>
        </div>
      </div>
      {error && <p className="danger" role="alert">{error} <button type="button" className="po-inline-button" onClick={() => setError('')}>Dismiss</button></p>}
      {success && <p className="po-success" role="status">{success}</p>}
      {!branch && <p className="empty">No active purchasing branch is assigned to this account.</p>}

      {canManagePurchasing && branch && <div className="po-create-box">
        <div className="po-editor-heading">
          <div>
            <strong>{editingPoId ? 'Edit draft purchase order' : 'Create a draft purchase order'}</strong>
            <small>Build one order with multiple lines. Catalog prices, VAT, conversion, MOQ and lead time are enforced again by the server.</small>
          </div>
          {editingPoId && <button type="button" className="po-secondary" onClick={resetDraft}>Cancel edit</button>}
        </div>
        <form className="po-draft-form" onSubmit={create}>
          <div className="po-header-fields">
            <label>Supplier<select required value={form.supplier} onChange={e => { setForm({...form, supplier: e.target.value}); setDraftLines([draftRow()]); }}>
              <option value="">Select supplier</option>
              {suppliers.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
            </select></label>
            <label>Order date<input required disabled={Boolean(editingPoId)} type="date" value={form.orderDate} onChange={e => setForm({...form, orderDate: e.target.value})}/></label>
            <label>Expected delivery<input type="date" min={form.orderDate || undefined} value={form.expectedDeliveryDate} onChange={e => setForm({...form, expectedDeliveryDate: e.target.value})}/></label>
            <label>Delivery address<input maxLength="500" value={form.deliveryAddress} onChange={e => setForm({...form, deliveryAddress: e.target.value})} placeholder={branch?.address || 'Use branch address'}/></label>
          </div>
          <label className="po-notes-field">Order notes<textarea maxLength="1000" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} placeholder="Delivery window, contact person or supplier instructions"/></label>

          {!form.supplier && <div className="po-catalog-note">Choose a supplier to load current purchasing terms.</div>}
          {catalogLoading && <div className="po-catalog-note">Loading active supplier terms…</div>}
          {catalogReady && catalog.length > 0 && activeCatalog.length === 0 && <div className="po-catalog-note blocked">This supplier has catalog records, but none are active. Reactivate a mapping in Supplier Catalog before ordering.</div>}
          {catalogReady && catalog.length === 0 && <div className="po-catalog-note legacy">Legacy supplier: manual base-unit terms remain available until its first catalog mapping is created.</div>}

          <div className="po-draft-lines">
            {draftLines.map((line, index) => {
              const mapping = activeCatalog.find(item => item._id === line.catalogItem);
              const ingredient = mapping?.ingredient || ingredients.find(item => item._id === line.ingredient);
              const quoted = mapping ? Number(line.purchaseQty || 0) * Number(mapping.currentPrice || 0) : Number(line.qty || 0) * Number(line.price || 0);
              return (
                <div className="po-draft-line" key={line.key}>
                  <div className="po-line-number"><strong>Line {index + 1}</strong><button type="button" disabled={draftLines.length === 1} onClick={() => removeDraftLine(line.key)}>Remove</button></div>
                  {supplierUsesCatalog ? <>
                    <label>Catalog item<select required value={line.catalogItem} onChange={e => changeDraftLine(line.key, {catalogItem: e.target.value})}>
                      <option value="">Select supplier item</option>
                      {activeCatalog.map(item => <option key={item._id} value={item._id} disabled={draftLines.some(other => other.key !== line.key && other.catalogItem === item._id)}>{item.ingredient?.name} · {rs(item.currentPrice)}/{item.purchaseUnit}{item.supplierSku ? ` · ${item.supplierSku}` : ''}</option>)}
                    </select></label>
                    <label>Purchase quantity<input required min={mapping?.minOrderQty || 0.000001} step="any" type="number" value={line.purchaseQty} onChange={e => changeDraftLine(line.key, {purchaseQty: e.target.value})}/></label>
                    <div className="po-line-terms">
                      <strong>{mapping ? rs(quoted) : 'Choose an item'}</strong>
                      <small>{mapping ? `${line.purchaseQty || 0} ${mapping.purchaseUnit} = ${(Number(line.purchaseQty || 0) * Number(mapping.conversionFactor)).toLocaleString('en-NP')} ${mapping.baseUnit} · MOQ ${mapping.minOrderQty} · lead ${mapping.leadDays || 0} day(s) · VAT ${mapping.priceIncludesVat ? 'included' : `${mapping.vatRate ?? 13}% extra`}` : 'The server snapshots the current supplier terms.'}</small>
                    </div>
                  </> : <>
                    <label>Ingredient<select required disabled={!catalogReady} value={line.ingredient} onChange={e => changeDraftLine(line.key, {ingredient: e.target.value})}>
                      <option value="">Select ingredient</option>
                      {ingredients.map(item => <option key={item._id} value={item._id} disabled={draftLines.some(other => other.key !== line.key && other.ingredient === item._id)}>{item.name} ({item.unit})</option>)}
                    </select></label>
                    <label>Base quantity<input required min="0.000001" step="any" type="number" value={line.qty} onChange={e => changeDraftLine(line.key, {qty: e.target.value})}/></label>
                    <label>Net price / {ingredient?.unit || 'base unit'}<input required min="0.000001" step="any" type="number" value={line.price} onChange={e => changeDraftLine(line.key, {price: e.target.value})}/></label>
                    <div className="po-line-terms"><strong>{rs(quoted)}</strong><small>Manual terms · 13% VAT added · base inventory unit</small></div>
                  </>}
                </div>
              );
            })}
          </div>
          <div className="po-editor-footer">
            <button type="button" className="po-secondary" disabled={!catalogReady || (supplierUsesCatalog && activeCatalog.length === 0)} onClick={addDraftLine}>+ Add line</button>
            <div className="po-draft-totals"><span>Net {rs(draftEstimate.subtotal)}</span><span>VAT {rs(draftEstimate.vat)}</span><strong>Estimated total {rs(draftEstimate.subtotal + draftEstimate.vat)}</strong></div>
            <button disabled={busy === 'create-po' || !catalogReady || !draftLines.length || (supplierUsesCatalog && activeCatalog.length === 0)}>{busy === 'create-po' ? 'Saving…' : editingPoId ? 'Save draft changes' : 'Create draft PO'}</button>
          </div>
        </form>
      </div>}

      {branch && <>
      <div className="po-list-heading">
        <div><h3>Purchase orders</h3><small>{poPagination.total} result(s) for {branch?.name || 'this branch'}</small></div>
        <button type="button" className="po-secondary" disabled={poLoading} onClick={load}>{poLoading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <form className="po-filters" onSubmit={e => { e.preventDefault(); setPoPagination(current => ({...current, page: 1})); setPoFilters({...filterDraft}); }}>
        <label>Search<input value={filterDraft.q} onChange={e => setFilterDraft({...filterDraft, q: e.target.value})} placeholder="PO number, supplier, notes"/></label>
        <label>Status<select value={filterDraft.status} onChange={e => setFilterDraft({...filterDraft, status: e.target.value})}>
          <option value="">All statuses</option>
          {['draft', 'pending', 'approved', 'rejected', 'sent', 'partially_received', 'received', 'closed_short', 'cancelled'].map(status => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}
        </select></label>
        <label>Supplier<select value={filterDraft.supplier} onChange={e => setFilterDraft({...filterDraft, supplier: e.target.value})}>
          <option value="">All suppliers</option>
          {suppliers.map(item => <option key={item._id} value={item._id}>{item.name}</option>)}
        </select></label>
        <label>From<input type="date" value={filterDraft.from} onChange={e => setFilterDraft({...filterDraft, from: e.target.value})}/></label>
        <label>To<input type="date" min={filterDraft.from || undefined} value={filterDraft.to} onChange={e => setFilterDraft({...filterDraft, to: e.target.value})}/></label>
        <div className="po-filter-actions"><button disabled={poLoading}>Apply</button><button type="button" className="po-secondary" onClick={() => { const empty = {q: '', supplier: '', status: '', from: '', to: ''}; setFilterDraft(empty); setPoPagination(current => ({...current, page: 1})); setPoFilters(empty); }}>Clear</button></div>
      </form>
      <div className="po-summary-grid">
        <article className={poSummary.pendingApprovals ? 'attention' : ''}><small>Awaiting approval</small><strong>{poSummary.pendingApprovals || 0}</strong>{poSummary.pendingApprovals > 0 && <button type="button" onClick={() => { setFilterDraft(current => ({...current, status: 'pending'})); setPoPagination(current => ({...current, page: 1})); setPoFilters(current => ({...current, status: 'pending'})); }}>View queue</button>}</article>
        <article><small>Open orders</small><strong>{poSummary.open || 0}</strong></article>
        <article><small>Net subtotal</small><strong>{rs(poSummary.subtotal)}</strong></article>
        <article><small>VAT</small><strong>{rs(poSummary.vat)}</strong></article>
        <article><small>Gross total</small><strong>{rs(poSummary.total)}</strong></article>
      </div>
      {poLoading && !po.length && <p className="empty">Loading purchase orders…</p>}
      {!poLoading && !po.length && <p className="empty">No purchase orders match these branch filters.</p>}
      {!!po.length && <div className="po-table-wrap"><table className="po-table">
        <thead><tr><th>PO / date</th><th>Supplier</th><th>Lines</th><th>Receiving</th><th>Status</th><th>Financials</th><th>Actions</th></tr></thead>
        <tbody>
          {po.map(x => (
            <tr key={x._id}>
              <td><strong>{x.poNo}</strong><small>{ymd(x.orderDate || x.createdAt)}{x.expectedDeliveryDate ? ` · due ${ymd(x.expectedDeliveryDate)}` : ''}</small></td>
              <td>{x.supplier?.name || 'Unavailable supplier'}</td>
              <td>{x.items?.length || 0}<small>{x.items?.map(i => `${i.ingredient?.name || 'Ingredient'}: ${i.orderedQty} ${i.unit || ''}`).join(' · ')}</small></td>
              <td>{x.items?.map(i => `${i.receivedQty || 0}/${i.orderedQty} ${i.unit || ''}${Number(i.damagedQty || 0) > 0 ? ` · ${i.damagedQty} damaged` : ''}`).join(', ') || 'Not received'}{x.status === 'closed_short' && <small>Closed with {x.items?.reduce((sum, item) => sum + remaining(item), 0)} outstanding</small>}</td>
              <td><span className={poPill(x.status)}>{String(x.status || '').replace('_', ' ')}</span>{x.status === 'pending' && <small>Round {x.approvalRound || 1} · {x.submittedBy?.name ? `by ${x.submittedBy.name}` : 'awaiting decision'}</small>}</td>
              <td><strong>{rs(x.total)}</strong><small>Net {rs(x.subtotal)} · VAT {rs(x.vat)}</small></td>
              <td><div className="po-row-actions">
                {canManagePurchasing && ['draft', 'rejected'].includes(x.status) && <button type="button" className="receive" disabled={!!busy} onClick={() => openDraftEdit(x)}>Edit</button>}
                {canManagePurchasing && ['draft', 'rejected'].includes(x.status) && <button type="button" className="receive" disabled={!!busy} onClick={() => setPoStatus(x, 'pending')}>Submit</button>}
                {canManagePurchasing && x.status === 'pending' && canDecide(x) && <button type="button" className="receive" disabled={!!busy} onClick={() => requestApprovalDecision(x, 'approved')}>Approve</button>}
                {canManagePurchasing && x.status === 'pending' && canDecide(x) && <button type="button" className="kds-cancel" disabled={!!busy} onClick={() => requestApprovalDecision(x, 'rejected')}>Reject</button>}
                {canManagePurchasing && x.status === 'pending' && !canDecide(x) && <small className="po-separation-note">Independent approval required</small>}
                {canManagePurchasing && x.status === 'approved' && <button type="button" className="receive" disabled={!!busy} onClick={() => setPoStatus(x, 'sent')}>Mark sent</button>}
                {canManagePurchasing && ['draft', 'pending', 'approved', 'rejected', 'sent'].includes(x.status) && <button type="button" className="kds-cancel" disabled={!!busy} onClick={() => setPoStatus(x, 'cancelled')}>Cancel</button>}
                {canManagePurchasing && x.status === 'partially_received' && <button type="button" className="kds-cancel" disabled={!!busy} onClick={() => { setError(''); setShortCloseAction({order: x, reason: '', requestKey: requestKey()}); }}>Close short</button>}
                <button type="button" className="receive" disabled={!!busy} onClick={() => openReceive(x)}>{canManagePurchasing && canReceivePo(x.status) ? 'Receive / return' : 'Open'}</button>
              </div></td>
            </tr>
          ))}
        </tbody>
      </table></div>}
      {approvalAction && <form className="po-approval-action" onSubmit={e => {
        e.preventDefault();
        if (approvalAction.status === 'rejected' && approvalAction.notes.trim().length < 3) {
          setError('Enter a rejection reason of at least 3 characters.');
          return;
        }
        setPoStatus(approvalAction.order, approvalAction.status, approvalAction.notes);
      }}>
        <div>
          <span className="eyebrow">Approval decision</span>
          <h3>{approvalAction.status === 'approved' ? 'Approve' : 'Reject'} {approvalAction.order.poNo}</h3>
          <p>{approvalAction.status === 'rejected' ? 'A clear reason is required and will be kept in the approval trail.' : 'An approval comment is optional. Your identity and decision time are recorded automatically.'}</p>
        </div>
        <label>{approvalAction.status === 'rejected' ? 'Rejection reason' : 'Approval comment'}
          <textarea autoFocus required={approvalAction.status === 'rejected'} minLength={approvalAction.status === 'rejected' ? 3 : undefined} maxLength="1000" value={approvalAction.notes} onChange={e => setApprovalAction(current => ({...current, notes: e.target.value}))} placeholder={approvalAction.status === 'rejected' ? 'Explain what must be corrected before resubmission' : 'Optional purchasing note'}/>
        </label>
        <div className="po-approval-buttons">
          <button type="button" className="po-secondary" disabled={!!busy} onClick={() => setApprovalAction(null)}>Keep pending</button>
          <button className={approvalAction.status === 'rejected' ? 'kds-cancel' : 'receive'} disabled={!!busy || (approvalAction.status === 'rejected' && approvalAction.notes.trim().length < 3)}>{busy ? 'Saving…' : `Confirm ${approvalAction.status === 'approved' ? 'approval' : 'rejection'}`}</button>
        </div>
      </form>}
      {shortCloseAction && <form className="po-approval-action po-short-close" onSubmit={closeShort}>
        <div>
          <span className="eyebrow">Receiving exception</span>
          <h3>Close {shortCloseAction.order.poNo} short</h3>
          <p>This permanently stops further receipts on this PO. Received and damaged quantities stay unchanged, and every outstanding line remains visible for audit and reporting.</p>
        </div>
        <label>Why will the supplier not deliver the remainder?
          <textarea autoFocus required minLength="3" maxLength="1000" value={shortCloseAction.reason} onChange={e => setShortCloseAction(current => ({...current, reason: e.target.value}))} placeholder="Example: Supplier confirmed the remaining 20 kg is unavailable"/>
        </label>
        <div className="po-approval-buttons">
          <button type="button" className="po-secondary" disabled={!!busy} onClick={() => setShortCloseAction(null)}>Keep open</button>
          <button className="kds-cancel" disabled={!!busy || shortCloseAction.reason.trim().length < 3}>{busy === 'short-' + shortCloseAction.order._id ? 'Closing…' : 'Confirm short close'}</button>
        </div>
      </form>}
      {poPagination.pages > 1 && <div className="po-pagination">
        <button type="button" className="po-secondary" disabled={poLoading || poPagination.page <= 1} onClick={() => setPoPagination(current => ({...current, page: current.page - 1}))}>Previous</button>
        <span>Page {poPagination.page} of {poPagination.pages}</span>
        <button type="button" className="po-secondary" disabled={poLoading || poPagination.page >= poPagination.pages} onClick={() => setPoPagination(current => ({...current, page: current.page + 1}))}>Next</button>
      </div>}


      {open && (
        <div className="receive-box">
          <h3>{open.poNo} · {String(open.status || '').replace('_', ' ')}</h3>
          <div className="po-approval-meta">
            {open.submittedAt && <article><small>Submitted</small><strong>{open.submittedBy?.name || 'Recorded user'}</strong><span>{new Date(open.submittedAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'})} · round {open.approvalRound || 1}</span></article>}
            {open.approvedAt && <article><small>Approved</small><strong>{open.approvedBy?.name || 'Recorded user'}</strong><span>{new Date(open.approvedAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'})}</span></article>}
            {open.rejectedAt && <article className="rejected"><small>Rejected</small><strong>{open.rejectedBy?.name || 'Recorded user'}</strong><span>{new Date(open.rejectedAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'})}</span></article>}
          </div>
          {open.submissionNote && <p><strong>Submission note:</strong> {open.submissionNote}</p>}
          {open.approvalNote && <p><strong>Approval comment:</strong> {open.approvalNote}</p>}
          {open.rejectionReason && <p className="po-rejection-reason"><strong>Rejection reason:</strong> {open.rejectionReason}</p>}
          {open.shortCloseReason && <p className="po-short-close-note"><strong>Closed short:</strong> {open.shortCloseReason} {open.shortClosedBy?.name ? `— ${open.shortClosedBy.name}` : ''}{open.shortClosedAt ? ` · ${new Date(open.shortClosedAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'})}` : ''}</p>}
          <h3>Approval trail</h3>
          {!approvalHistory.length && <p className="empty">No approval decisions have been recorded yet.</p>}
          {!!approvalHistory.length && <div className="po-approval-timeline">{approvalHistory.map(event => <article key={event.id}>
            <span className={poPill(event.status)}>{event.status}</span>
            <div><strong>{event.actor?.name || 'Recorded user'}</strong><small>{event.actor?.role || 'user'} · {event.at ? new Date(event.at).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'}) : ''}{event.approvalRound ? ` · round ${event.approvalRound}` : ''}</small>{event.note && <p>{event.note}</p>}</div>
          </article>)}</div>}
          {!canReceivePo(open.status) && open.status !== 'received' && (
            <p>{open.status === 'pending' ? 'Waiting for approval. Stock cannot be received yet.' : open.status === 'draft' ? 'Submit this draft for approval before receiving.' : open.status === 'rejected' ? 'Rejected. Resubmit after you correct it.' : open.status === 'closed_short' ? 'This PO was closed short. Outstanding quantities are retained for audit but no further receipts are allowed.' : 'This purchase order is not open for receiving.'}</p>
          )}
          {canReceivePo(open.status) && <p>Enter only quantities physically counted now. Accepted quantity = received − damaged; remaining = ordered − already received. Inventory cost always comes from the approved PO.</p>}
          {canManagePurchasing && canReceivePo(open.status) && <>
          <div className="receipt-toolbar">
            <button type="button" className="po-secondary" disabled={!!busy} onClick={() => setLines(current => Object.fromEntries((open.items || []).map(item => [item._id, {...(current[item._id] || {}), receivedQty: remaining(item), damagedQty: 0, damageReason: '', damageNotes: ''}])))}>Fill all remaining</button>
            <button type="button" className="po-secondary" disabled={!!busy} onClick={() => setLines(current => Object.fromEntries((open.items || []).map(item => [item._id, {...(current[item._id] || {}), receivedQty: 0, damagedQty: 0, damageReason: '', damageNotes: ''}])))}>Clear counts</button>
            <span>Nothing is prefilled—verify the delivery before posting.</span>
          </div>
          <table className="receipt-entry-table">
            <thead><tr><th>Ingredient</th><th>Ordered</th><th>Already in</th><th>Remaining</th><th>Receive now</th><th>Damaged</th><th>Damage reason</th><th>Damage detail</th><th>Accepted</th><th>PO cost</th><th>Accepted value</th><th>Batch</th><th>Expiry</th></tr></thead>
            <tbody>
              {(open.items || []).map(i => {
                const row = lines[i._id] || {receivedQty: 0, damagedQty: 0};
                const rec = Number(row.receivedQty || 0);
                const dmg = Number(row.damagedQty || 0);
                const acceptedNow = Math.max(0, rec - dmg);
                return (
                  <tr key={i._id}>
                    <td>{i.ingredient?.name || 'Ingredient'}<small>{i.ingredient?.code || i.unit}</small></td>
                    <td>{i.orderedQty} {i.unit}</td>
                    <td>{i.receivedQty || 0}</td>
                    <td>{remaining(i)}</td>
                    <td><input aria-label={`Receive ${i.ingredient?.name || 'ingredient'}`} type="number" min="0" max={remaining(i)} value={row.receivedQty} onChange={e => setLines(s => ({...s, [i._id]: {...row, receivedQty: e.target.value}}))}/></td>
                    <td><input aria-label={`Damaged ${i.ingredient?.name || 'ingredient'}`} type="number" min="0" max={Math.max(0, rec)} value={row.damagedQty} onChange={e => setLines(s => ({...s, [i._id]: {...row, damagedQty: e.target.value, ...(Number(e.target.value || 0) > 0 ? {} : {damageReason: '', damageNotes: ''})}}))}/></td>
                    <td><select aria-label={`Damage reason ${i.ingredient?.name || 'ingredient'}`} disabled={!(dmg > 0)} required={dmg > 0} value={row.damageReason || ''} onChange={e => setLines(s => ({...s, [i._id]: {...row, damageReason: e.target.value}}))}>
                      <option value="">Choose reason</option>
                      {DAMAGE_REASON_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select></td>
                    <td><input aria-label={`Damage detail ${i.ingredient?.name || 'ingredient'}`} disabled={!(dmg > 0)} required={row.damageReason === 'other'} minLength={row.damageReason === 'other' ? 3 : undefined} maxLength="500" value={row.damageNotes || ''} onChange={e => setLines(s => ({...s, [i._id]: {...row, damageNotes: e.target.value}}))} placeholder={row.damageReason === 'other' ? 'Required details' : 'Optional detail'}/></td>
                    <td>{acceptedNow}</td>
                    <td>{rs(i.unitPrice)} / {i.unit}</td>
                    <td>{rs(acceptedNow * Number(i.unitPrice || 0))}</td>
                    <td><input maxLength="120" value={row.batchNumber || ''} onChange={e => setLines(s => ({...s, [i._id]: {...row, batchNumber: e.target.value}}))} placeholder="Batch"/></td>
                    <td><input type="date" value={row.expiryDate || ''} onChange={e => setLines(s => ({...s, [i._id]: {...row, expiryDate: e.target.value}}))}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={'receipt-summary' + (receiptDraft.invalid ? ' invalid' : '')}>
            <span><small>Lines</small><strong>{receiptDraft.lineCount}</strong></span>
            <span><small>Received now</small><strong>{receiptDraft.receivedQty}</strong></span>
            <span><small>Accepted</small><strong>{receiptDraft.acceptedQty}</strong></span>
            <span><small>Damaged</small><strong>{receiptDraft.damagedQty}</strong></span>
            <span><small>Stock value</small><strong>{rs(receiptDraft.acceptedValue)}</strong></span>
          </div>
          {receiptDraft.invalid && <p className="danger" role="alert">Check remaining quantities, damage evidence, and batch/expiry details. Expired goods cannot enter usable stock, and every expiry needs a batch number.</p>}
          <input className="receive-notes" maxLength="1000" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Receiving notes (delivery reference, discrepancy, or handover details)"/>
          <button className="receive receipt-post" disabled={!!busy || !receiptDraft.lineCount || receiptDraft.invalid} onClick={() => receive(open)}>{busy === open._id ? 'Posting receipt…' : 'Review and post receipt'}</button>
          </>}

          {canManagePurchasing && (open.items || []).some(i => returnable(i) > 0) && open.status !== 'cancelled' && (
            <div className="purchase-return-box">
              <h3>Return to supplier</h3>
              <p>Select the exact received stock lot being sent back. The server uses the original PO price and VAT for the supplier credit, while inventory is removed at the recorded lot cost.</p>
              {returnOptionsLoading && <p className="empty">Loading currently returnable stock lots…</p>}
              {!returnOptionsLoading && Number(returnOptions.summary?.legacyLines || 0) > 0 && <p className="po-short-close-note">Some older receipts predate durable receipt-lot links. Those rows are clearly recorded as legacy allocations and never presented as exact receipt provenance.</p>}
              {!returnOptionsLoading && !(Number(returnOptions.summary?.availableQty || 0) > 0) && <p className="danger" role="alert">This PO has accepted quantity left, but none remains in eligible on-hand lots. Stock already sold, wasted, transferred, adjusted, or returned cannot be sent back again.</p>}
              {!returnOptionsLoading && Number(returnOptions.summary?.availableQty || 0) > 0 && <>
                <table className="return-entry-table">
                  <thead><tr><th>Ingredient</th><th>PO returnable</th><th>Lot available</th><th>Return now</th><th>Batch / receipt</th><th>Expiry</th><th>Evidence</th><th>Supplier cost</th></tr></thead>
                  <tbody>
                    {(returnOptions.items || []).filter(option => Number(option.returnableQty || 0) > 0).flatMap(option => {
                      const poLine = (open.items || []).find(item => String(item._id) === String(option.poItem));
                      if (!(option.batches || []).length) return [<tr key={'ret-empty-' + option.poItem}>
                        <td>{poLine?.ingredient?.name || 'Ingredient'}</td><td>{option.returnableQty} {poLine?.unit}</td><td colSpan="6">No eligible on-hand lot remains</td>
                      </tr>];
                      return option.batches.map(batch => <tr key={'ret-batch-' + batch.batchId}>
                        <td>{poLine?.ingredient?.name || 'Ingredient'}<small>{poLine?.ingredient?.code || poLine?.unit}</small></td>
                        <td>{option.returnableQty} {poLine?.unit}</td>
                        <td>{batch.availableQty} {batch.unit || poLine?.unit}</td>
                        <td><input aria-label={`Return ${poLine?.ingredient?.name || 'ingredient'} from ${batch.batchNumber || batch.batchId}`} type="number" min="0" max={Math.min(Number(option.returnableQty || 0), Number(batch.availableQty || 0))} value={retLines[returnLotKey(option.poItem, batch.batchId)] || ''} onChange={e => setRetLines(current => ({...current, [returnLotKey(option.poItem, batch.batchId)]: e.target.value}))} placeholder="0"/></td>
                        <td><strong>{batch.batchNumber || 'Unnumbered lot'}</strong><small>{batch.receiptNo || `Lot ${String(batch.batchId).slice(-6)}`}</small></td>
                        <td>{batch.expiryDate ? ymd(batch.expiryDate) : 'No expiry'}<small>{String(batch.expiryStatus || '').replaceAll('_', ' ')}</small></td>
                        <td><span className={batch.allocationSource === 'receipt_batch' ? 'pill ok' : 'pill'}>{batch.allocationSource === 'receipt_batch' ? 'Receipt linked' : 'Legacy allocation'}</span></td>
                        <td>{rs(poLine?.unitPrice)} / {poLine?.unit}</td>
                      </tr>);
                    })}
                  </tbody>
                </table>
                <div className={'receipt-summary return-summary' + (returnDraft.invalid ? ' invalid' : '')}>
                  <span><small>Selected lines</small><strong>{returnDraft.lineCount}</strong></span>
                  <span><small>Return quantity</small><strong>{returnDraft.qty}</strong></span>
                  <span><small>Net credit</small><strong>{rs(returnDraft.subtotal)}</strong></span>
                  <span><small>VAT credit</small><strong>{rs(returnDraft.vat)}</strong></span>
                  <span><small>Total credit</small><strong>{rs(returnDraft.subtotal + returnDraft.vat)}</strong></span>
                </div>
                {returnDraft.invalid && <p className="danger" role="alert">Check each lot quantity and the total returnable amount for its PO line.</p>}
                <select className="receive-notes" value={reason} onChange={e => setReason(e.target.value)}>
                  {['quality', 'wrong_item', 'expired', 'overstock', 'damaged', 'other'].map(x => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
                </select>
                <input className="receive-notes" maxLength="1000" value={returnNotes} onChange={e => setReturnNotes(e.target.value)} placeholder={reason === 'other' ? 'Return details (required)' : 'Return notes (optional)'}/>
                <button className="receive receipt-post" disabled={!!busy || !returnDraft.lineCount || returnDraft.invalid || (reason === 'other' && returnNotes.trim().length < 3)} onClick={() => postReturn(open)}>{String(busy).startsWith('ret-') ? 'Posting return…' : 'Review and post return'}</button>
              </>}
            </div>
          )}

          <h3>Return history</h3>
          {!returns.length && <p className="empty">No returns posted yet.</p>}
          {!!returns.length && (
            <table className="return-history-table">
              <thead><tr><th>Return</th><th>Returned stock evidence</th><th>Reason</th><th>Credit</th><th>Posted by</th><th>When</th></tr></thead>
              <tbody>
                {returns.map(r => (
                  <tr key={r._id}>
                    <td><strong>{r.returnNo}</strong><small>{r.status || 'posted'}</small></td>
                    <td>{r.items?.map(item => `${item.ingredient?.name || 'Ingredient'}: ${item.qty} ${item.unit} · ${item.batchNumber || 'unnumbered lot'}${item.goodsReceipt?.receiptNo ? ` · ${item.goodsReceipt.receiptNo}` : ''} · ${item.allocationSource === 'receipt_batch' ? 'receipt linked' : 'legacy allocation'}`).join(' | ')}</td>
                    <td>{String(r.reason || '').replaceAll('_', ' ')}<small>{r.notes || 'No additional note'}</small></td>
                    <td><strong>{rs(r.total)}</strong><small>Net {rs(r.subtotal)} · VAT {rs(r.vat)}</small></td>
                    <td>{r.returnedBy?.name || 'Recorded user'}<small>{r.returnedBy?.role || ''}</small></td>
                    <td>{r.returnedAt ? new Date(r.returnedAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'}) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Receipt history</h3>
          {!receipts.length && <p className="empty">No receipts posted yet.</p>}
          {!!receipts.length && (
            <table>
              <thead><tr><th>Receipt</th><th>Accepted</th><th>Damaged</th><th>Damage record</th><th>Accepted value</th><th>Batch</th><th>Received by</th><th>Notes</th><th>When</th></tr></thead>
              <tbody>
                {receipts.map(r => (
                  <tr key={r._id}>
                    <td><strong>{r.receiptNo}</strong></td>
                    <td>{r.items?.map(i => i.acceptedQty).join(', ')}</td>
                    <td>{r.items?.map(i => i.damagedQty).join(', ')}</td>
                    <td>{r.items?.filter(i => Number(i.damagedQty || 0) > 0).map(i => `${damageReasonLabel(i.damageReason)} · rejected at receiving${i.damageNotes ? ` · ${i.damageNotes}` : ''}`).join(' | ') || 'No damage'}</td>
                    <td>{rs(r.acceptedValue)}</td>
                    <td>{r.items?.map(i => i.batchNumber || '—').join(', ')}</td>
                    <td>{r.receivedBy?.name || 'Recorded user'}</td>
                    <td>{r.notes || '—'}</td>
                    <td>{r.receivedAt ? new Date(r.receivedAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'}) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      </>}

      {canManagePurchasing && branch && <>
      <h3>Create supplier invoice</h3>
      <p>Record the supplier document in NPR. The server verifies VAT, ownership, duplicate numbers and any linked PO/receipt/return variance.</p>
      <form className="purchaseform" onSubmit={createInvoice}>
        <select required value={invoice.supplier} onChange={e => setInvoice({...invoice, supplier: e.target.value, purchaseOrder: ''})}>
          <option value="">Supplier</option>
          {suppliers.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
        </select>
        <select value={invoice.purchaseOrder} onChange={e => setInvoice({...invoice, purchaseOrder: e.target.value})}>
          <option value="">Unlinked invoice</option>
          {invoiceableOrders.map(x => <option key={x._id} value={x._id}>{x.poNo} · {x.status}</option>)}
        </select>
        <input required maxLength="120" value={invoice.invoiceNo} onChange={e => setInvoice({...invoice, invoiceNo: e.target.value})} placeholder="Supplier invoice no"/>
        <input required type="date" value={invoice.invoiceDate} onChange={e => setInvoice({...invoice, invoiceDate: e.target.value})}/>
        <input type="date" min={invoice.invoiceDate || undefined} value={invoice.dueDate} onChange={e => setInvoice({...invoice, dueDate: e.target.value})} title="Due date"/>
        <input required min="0.01" step="0.01" type="number" value={invoice.amount} onChange={e => setInvoice({...invoice, amount: e.target.value})} placeholder={invoice.priceIncludesVat ? 'Total including VAT Rs.' : 'Subtotal before VAT Rs.'}/>
        <input required min="0" max="100" step="0.01" type="number" value={invoice.vatRate} onChange={e => setInvoice({...invoice, vatRate: e.target.value})} title="VAT rate %"/>
        <label><input type="checkbox" checked={invoice.priceIncludesVat} onChange={e => setInvoice({...invoice, priceIncludesVat: e.target.checked})}/> Amount includes VAT</label>
        <input maxLength="1000" value={invoice.attachmentUrl} onChange={e => setInvoice({...invoice, attachmentUrl: e.target.value})} placeholder="HTTPS attachment URL (optional)"/>
        <input maxLength="1000" value={invoice.notes} onChange={e => setInvoice({...invoice, notes: e.target.value})} placeholder="Notes (optional)"/>
        <button disabled={busy === 'create-invoice'}>{busy === 'create-invoice' ? 'Recording…' : 'Create supplier invoice'}</button>
      </form>
      <p>Net {rs(invoiceDraftSubtotal)} · VAT {invoiceRate}% = {rs(invoiceDraftVat)} · Total {rs(invoiceDraftTotal)}</p>

      <h3>Supplier invoices & payments</h3>
      {!invoices.length && <p className="empty">No supplier invoices have been recorded for this branch.</p>}
      {!!invoices.length && <table>
        <thead><tr><th>Invoice</th><th>Supplier / PO</th><th>Total</th><th>Paid</th><th>Due</th><th>Payment</th><th>Matching</th><th></th></tr></thead>
        <tbody>
          {invoices.map(x => (
            <tr key={x._id}>
              <td><b>{x.invoiceNo}</b><small className="cell-sub">{ymd(x.invoiceDate)}</small></td>
              <td>{x.supplier?.name}<small className="cell-sub">{x.purchaseOrder?.poNo || 'Unlinked'}</small></td>
              <td>{rs(x.total)}</td>
              <td>{rs(x.paidAmount)}</td>
              <td>{rs(x.status === 'void' ? 0 : x.total - x.paidAmount)}</td>
              <td><label className={x.status === 'void' ? 'pill' : 'pill ok'}>{x.status}</label></td>
              <td><label className={['matched', 'unlinked'].includes(x.matching?.status) ? 'pill ok' : 'pill'}>{String(x.matching?.status || 'unlinked').replaceAll('_', ' ')}</label>{x.matching?.status === 'over_billed' && <small className="cell-sub">Variance {rs(x.matching?.varianceTotal)}</small>}</td>
              <td>
                {x.status !== 'paid' && x.status !== 'void' && <button className="receive" onClick={() => openInvoicePayments(x, true)}>Record payment</button>}
                {x.status !== 'void' && <button className="receive" onClick={() => openEdit(x)}>Edit</button>}
                {x.status === 'unpaid' && Number(x.paidAmount || 0) === 0 && <button className="kds-cancel" onClick={() => voidInvoice(x)}>Void</button>}
                <button className="receive" onClick={() => showInvoicePays(x)}>Payments</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>}
      {editId && (() => {
        const current = invoices.find(x => x._id === editId);
        const locked = Number(current?.paidAmount || 0) > 0 || Number(current?.paymentCount || 0) > 0;
        const currentSupplierId = current?.supplier?._id || current?.supplier;
        const editableOrders = po.filter(order =>
          ['approved', 'sent', 'partially_received', 'received', 'closed_short'].includes(order.status)
          && String(order.supplier?._id || order.supplier) === String(currentSupplierId)
        );
        const editAmount = Number(edit.amount || 0);
        const editRate = Number(edit.vatRate || 0);
        const editSubtotal = edit.priceIncludesVat ? editAmount / (1 + editRate / 100) : editAmount;
        const editVat = edit.priceIncludesVat ? editAmount - editSubtotal : editSubtotal * editRate / 100;
        const editTotal = edit.priceIncludesVat ? editAmount : editSubtotal + editVat;
        return (
          <div className="receive-box">
            <h3>Edit invoice {current?.invoiceNo || ''}</h3>
            <p>{locked ? 'Payments exist — amounts stay locked. You can still correct the number, dates, attachment and notes.' : 'Unpaid invoice — number, dates, VAT mode and amount can be corrected with version protection.'}</p>
            <form className="purchaseform" onSubmit={saveEdit}>
              <input required maxLength="120" value={edit.invoiceNo} onChange={e => setEdit({...edit, invoiceNo: e.target.value})} placeholder="Invoice no"/>
              <select disabled={locked} value={edit.purchaseOrder} onChange={e => setEdit({...edit, purchaseOrder: e.target.value})}>
                <option value="">Unlinked invoice</option>
                {editableOrders.map(order => <option key={order._id} value={order._id}>{order.poNo} · {order.status}</option>)}
              </select>
              <input required type="date" value={edit.invoiceDate} onChange={e => setEdit({...edit, invoiceDate: e.target.value})}/>
              <input type="date" min={edit.invoiceDate || undefined} value={edit.dueDate} onChange={e => setEdit({...edit, dueDate: e.target.value})}/>
              <input required min="0.01" step="0.01" type="number" disabled={locked} value={edit.amount} onChange={e => setEdit({...edit, amount: e.target.value})} placeholder={edit.priceIncludesVat ? 'Total Rs.' : 'Subtotal Rs.'}/>
              <input required min="0" max="100" step="0.01" type="number" disabled={locked} value={edit.vatRate} onChange={e => setEdit({...edit, vatRate: e.target.value})} title="VAT rate %"/>
              <label><input type="checkbox" disabled={locked} checked={edit.priceIncludesVat} onChange={e => setEdit({...edit, priceIncludesVat: e.target.checked})}/> Amount includes VAT</label>
              <input maxLength="1000" value={edit.attachmentUrl} onChange={e => setEdit({...edit, attachmentUrl: e.target.value})} placeholder="HTTPS attachment URL"/>
              <button disabled={!!busy}>{String(busy).startsWith('edit-') ? 'Saving…' : 'Save invoice'}</button>
            </form>
            <input className="receive-notes" maxLength="1000" value={edit.notes} onChange={e => setEdit({...edit, notes: e.target.value})} placeholder="Invoice notes"/>
            <p>Net {rs(locked ? current?.subtotal : editSubtotal)} · VAT {locked ? current?.vatRate : editRate}% = {rs(locked ? current?.vat : editVat)} · Total {rs(locked ? current?.total : editTotal)}</p>
          </div>
        );
      })()}
      {payInvoiceId && (
        <div className="receive-box payment-workspace">
          <div className="payment-heading">
            <div>
              <h3>Payments · {selectedPaymentInvoice?.invoiceNo || 'Invoice'}</h3>
              <p>Posted payments reduce the supplier balance. Reversals preserve the original evidence and restore the amount due.</p>
            </div>
            <button type="button" className="po-secondary" onClick={() => { setPayInvoiceId(''); setInvoicePays([]); setReverseAction(null); }}>Close</button>
          </div>
          {selectedPaymentInvoice && <div className="payment-summary">
            <article><small>Invoice total</small><strong>{rs(selectedPaymentInvoice.total)}</strong></article>
            <article><small>Active payments</small><strong>{rs(postedPaymentTotal)}</strong></article>
            <article><small>Balance due</small><strong>{rs(selectedInvoiceDue)}</strong></article>
            <article><small>Reversed history</small><strong>{rs(reversedPaymentTotal)}</strong></article>
          </div>}

          {selectedPaymentInvoice && !['paid', 'void'].includes(selectedPaymentInvoice.status) && (
            <form className="payment-form" onSubmit={recordPayment}>
              <div>
                <h3>Record a payment</h3>
                <p>Payment numbers are assigned automatically. Non-cash methods require a traceable reference.</p>
              </div>
              <label>Amount (NPR)<input required type="number" min="0.01" max={selectedInvoiceDue} step="0.01" value={paymentForm.amount} onChange={e => setPaymentForm({...paymentForm, amount: e.target.value})}/></label>
              <label>Method<select required value={paymentForm.method} onChange={e => setPaymentForm({...paymentForm, method: e.target.value, reference: e.target.value === 'cash' ? '' : paymentForm.reference})}>
                <option value="cash">Cash</option>
                <option value="bank">Bank transfer</option>
                <option value="esewa">eSewa</option>
                <option value="khalti">Khalti</option>
                <option value="card">Card</option>
              </select></label>
              <label>Payment date<input required type="date" min={ymd(selectedPaymentInvoice.invoiceDate)} max={todayKathmandu()} value={paymentForm.paidAt} onChange={e => setPaymentForm({...paymentForm, paidAt: e.target.value})}/></label>
              <label>Reference<input required={paymentForm.method !== 'cash'} minLength={paymentForm.method !== 'cash' ? 3 : undefined} maxLength="200" value={paymentForm.reference} onChange={e => setPaymentForm({...paymentForm, reference: e.target.value})} placeholder={paymentForm.method === 'cash' ? 'Receipt or note (optional)' : 'Bank, wallet, or card reference'}/></label>
              <button disabled={!!busy || !(Number(paymentForm.amount) > 0) || Number(paymentForm.amount) > selectedInvoiceDue + 0.001 || (paymentForm.method !== 'cash' && paymentForm.reference.trim().length < 3)}>{busy === 'pay-' + payInvoiceId ? 'Recording…' : `Review & record ${rs(paymentForm.amount)}`}</button>
            </form>
          )}
          {selectedPaymentInvoice?.status === 'paid' && <p className="po-success">This invoice is fully paid. Its complete transaction history remains below.</p>}
          {selectedPaymentInvoice?.status === 'void' && <p className="danger">Void invoices cannot receive payments.</p>}

          <div className="payment-history-heading">
            <h3>Auditable payment history</h3>
            <span>{invoicePays.length} {invoicePays.length === 1 ? 'entry' : 'entries'}</span>
          </div>
          {paymentLoading && <p className="empty">Loading payment history…</p>}
          {!paymentLoading && !invoicePays.length && <p className="empty">No payments have been recorded on this invoice.</p>}
          {!paymentLoading && !!invoicePays.length && (
            <div className="table-scroll"><table className="payment-history-table">
              <thead><tr><th>Payment</th><th>Paid at</th><th>Method / reference</th><th>Amount</th><th>Status</th><th>Recorded by</th><th>Reversal evidence</th><th></th></tr></thead>
              <tbody>
                {invoicePays.map(p => (
                  <tr key={p._id} className={p.status === 'reversed' ? 'payment-reversed' : ''}>
                    <td><strong>{p.paymentNo || 'Legacy payment'}</strong><small>{p.origin === 'legacy_invoice_balance' ? 'Migrated invoice balance' : p.origin === 'legacy_record' ? 'Migrated record' : 'Recorded payment'}</small></td>
                    <td>{new Date(p.paidAt || p.createdAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'})}</td>
                    <td><strong>{String(p.method || '').replaceAll('_', ' ')}</strong><small>{p.reference || 'No reference'}</small></td>
                    <td>{rs(p.amount)}</td>
                    <td><span className={p.status === 'posted' ? 'pill ok' : 'pill'}>{p.status}</span></td>
                    <td>{p.createdBy?.name || 'Recorded user'}<small>{p.createdBy?.role || ''}</small></td>
                    <td>{p.status === 'reversed' ? <>{p.reversalReason}<small>{p.reversedAt ? new Date(p.reversedAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'}) : ''}{p.reversedBy?.name ? ` · ${p.reversedBy.name}` : ''}</small></> : '—'}</td>
                    <td>{user?.role === 'owner' && p.status === 'posted' && <button type="button" className="kds-cancel" disabled={!!busy} onClick={() => requestPaymentReversal(p)}>Reverse</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {reverseAction && (
            <form className="payment-reversal" onSubmit={reversePayment}>
              <div>
                <p className="eyebrow">Owner authorization</p>
                <h3>Reverse {reverseAction.payment.paymentNo || 'payment'}</h3>
                <p>The original {rs(reverseAction.payment.amount)} entry will stay in history, while the invoice balance becomes due again.</p>
              </div>
              <label>Reason<input autoFocus required minLength="3" maxLength="500" value={reverseAction.reason} onChange={e => setReverseAction({...reverseAction, reason: e.target.value})} placeholder="Why is this payment being reversed?"/></label>
              <div className="payment-reversal-actions">
                <button type="button" className="po-secondary" disabled={!!busy} onClick={() => setReverseAction(null)}>Cancel</button>
                <button type="submit" className="kds-cancel" disabled={!!busy || reverseAction.reason.trim().length < 3}>{busy === 'reverse-' + reverseAction.payment._id ? 'Reversing…' : 'Review & reverse payment'}</button>
              </div>
            </form>
          )}
        </div>
      )}

      <h3>Supplier statement</h3>
      <p>Invoices increase what we owe. Payments reduce it. Amounts are NPR including 13% VAT.</p>
      <select className="kds-branch" value={statementId} onChange={e => { setStatementId(e.target.value); loadStatement(e.target.value); }}>
        <option value="">Choose supplier</option>
        {suppliers.map(x => <option key={x._id} value={x._id}>{x.name}</option>)}
      </select>
      {statement && (
        <div className="receive-box">
          <div className="kpis" style={{marginTop: 12}}>
            <article><small>Invoiced</small><strong>{rs(statement.invoiced)}</strong></article>
            <article><small>Paid</small><strong>{rs(statement.paid)}</strong></article>
            <article><small>Balance due</small><strong>{rs(statement.balance)}</strong></article>
          </div>
          <h3>Statement</h3>
          {!statement.lines?.length && <p className="empty">No invoices or payments for this supplier.</p>}
          {!!statement.lines?.length && (
            <table>
              <thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
              <tbody>
                {statement.lines.map((line, i) => (
                  <tr key={i}>
                    <td>{line.date ? new Date(line.date).toLocaleDateString('en-NP') : ''}</td>
                    <td>{line.type}</td>
                    <td>{line.ref}{line.method ? ` · ${line.method}` : ''}</td>
                    <td>{line.debit ? rs(line.debit) : '—'}</td>
                    <td>{line.credit ? rs(line.credit) : '—'}</td>
                    <td>{rs(line.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>Payment history</h3>
          {!statement.payments?.length && <p className="empty">No supplier payments recorded.</p>}
          {!!statement.payments?.length && (
            <table>
              <thead><tr><th>When</th><th>Payment</th><th>Invoice</th><th>Method</th><th>Amount</th><th>Status / evidence</th></tr></thead>
              <tbody>
                {statement.payments.map(p => (
                  <tr key={p._id} className={p.status === 'reversed' ? 'payment-reversed' : ''}>
                    <td>{new Date(p.paidAt || p.createdAt).toLocaleString('en-NP', {timeZone: 'Asia/Kathmandu'})}</td>
                    <td>{p.paymentNo || 'Legacy payment'}</td>
                    <td>{p.invoice?.invoiceNo || '—'}</td>
                    <td>{p.method}{p.reference ? <small>{p.reference}</small> : null}</td>
                    <td>{rs(p.amount)}</td>
                    <td><span className={p.status === 'posted' ? 'pill ok' : 'pill'}>{p.status || 'posted'}</span>{p.status === 'reversed' && <small>{p.reversalReason || 'Reversed'}{p.reversedBy?.name ? ` · ${p.reversedBy.name}` : ''}</small>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h3>Purchasing report</h3>
      <p>Live branch totals from purchase orders, receipts, returns, invoices and the inventory ledger.</p>
      {!report && <p className="empty">Report loads with the branch.</p>}
      {report && (
        <div className="receive-box">
          <div className="kpis">
            <article><small>PO value</small><strong>{rs(report.purchaseOrders?.orderedValue)}</strong><em>{report.purchaseOrders?.count || 0} operational POs · {report.purchaseOrders?.outstandingQty || 0} outstanding · {report.purchaseOrders?.shortClosedQty || 0} closed short</em></article>
            <article><small>Accepted stock value</small><strong>{rs(report.receipts?.acceptedValue)}</strong><em>Damaged {rs(report.receipts?.damagedValue)}{report.receipts?.damageByReason?.length ? ` · ${report.receipts.damageByReason.map(item => `${damageReasonLabel(item.reason)} ${item.qty}`).join(', ')}` : ''}</em></article>
            <article><small>Returned value</small><strong>{rs(report.returns?.value)}</strong><em>{report.returns?.count || 0} returns</em></article>
            <article><small>Invoice due</small><strong>{rs(report.invoices?.due)}</strong><em>VAT {rs(report.invoices?.vat)}</em></article>
          </div>
          <table>
            <thead><tr><th>Supplier</th><th>POs</th><th>Ordered</th><th>Invoiced</th><th>Paid</th><th>Due</th></tr></thead>
            <tbody>
              {(report.bySupplier || []).map(row => (
                <tr key={row.supplierId || row.name}>
                  <td>{row.name}</td>
                  <td>{row.poCount}</td>
                  <td>{rs(row.orderedValue)}</td>
                  <td>{rs(row.invoiced)}</td>
                  <td>{rs(row.paid)}</td>
                  <td>{rs(row.due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Ledger net stock value {rs(report.ledger?.netStockValue)} · purchases {rs(report.ledger?.purchaseValue)} · returns {rs(report.ledger?.returnValue)}</p>
        </div>
      )}
      </>}
    </section>
  );
}
