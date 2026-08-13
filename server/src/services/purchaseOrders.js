import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {PurchaseOrder} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export const PO_TRANSITIONS = {
  draft: ['pending', 'cancelled'],
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['sent', 'cancelled'],
  rejected: ['pending', 'cancelled'],
  sent: ['cancelled'],
  partially_received: [],
  received: [],
  cancelled: []
};

export const RECEIVABLE_STATUSES = ['approved', 'sent', 'partially_received'];
export const REPORTABLE_PO_STATUSES = ['approved', 'sent', 'partially_received', 'received'];

export function canReceivePo(status) {
  return RECEIVABLE_STATUSES.includes(status);
}

export function canTransitionPo(from, to) {
  return (PO_TRANSITIONS[from] || []).includes(to);
}

export async function transitionPurchaseOrder({poId, status, notes, user}) {
  if (!mongoose.isValidObjectId(poId)) throw httpError('Invalid purchase order', 400);
  if (!status) throw httpError('Status is required', 400);
  const po = await PurchaseOrder.findById(poId);
  if (!po) throw httpError('Purchase order not found', 404);
  assertBranchAccess(user, po.branch);
  if (!canTransitionPo(po.status, status)) {
    throw httpError(`Invalid purchase order transition from ${po.status} to ${status}`, 409);
  }
  if (status === 'cancelled') {
    const received = (po.items || []).some(i => Number(i.receivedQty || 0) > 0);
    if (received) throw httpError('Cannot cancel a purchase order that has receipts', 409);
  }

  const before = {status: po.status, approvedBy: po.approvedBy, approvalNote: po.approvalNote};
  po.status = status;
  if (status === 'approved') {
    po.approvedBy = user.id;
    po.approvalNote = notes || undefined;
  } else if (status === 'rejected') {
    po.approvedBy = undefined;
    po.approvalNote = notes || undefined;
  } else if (status === 'pending') {
    po.approvedBy = undefined;
    if (notes) po.approvalNote = notes;
  } else if (status === 'cancelled' && notes) {
    po.approvalNote = notes;
  }
  await po.save();
  await Audit.create([{
    entity: 'purchase_order',
    entityId: po._id,
    action: 'po_status',
    before,
    after: {status: po.status, approvedBy: po.approvedBy, approvalNote: po.approvalNote},
    user: user.id
  }]);
  return PurchaseOrder.findById(po._id).populate('supplier items.ingredient approvedBy');
}
