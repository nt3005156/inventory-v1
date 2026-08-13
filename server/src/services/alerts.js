import mongoose from 'mongoose';
import {Ingredient} from '../models/index.js';
import {Notification} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {resolveDashboardBranch} from './dashboard.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function resolveBranch(user, branchId) {
  const branch = resolveDashboardBranch(user, branchId);
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branch);
  }
  return branch;
}

export async function listAlerts({branchId, user, unread = true}) {
  const branch = resolveBranch(user, branchId);
  const match = {
    ...(branch ? {branch} : {}),
    ...(unread ? {read: false} : {})
  };
  const rows = await Notification.find(match).sort({createdAt: -1}).limit(200).populate('branch', 'name code');
  const ids = [...new Set(rows.map(n => n.referenceId).filter(Boolean).map(String))];
  const ingredients = ids.length
    ? await Ingredient.find({_id: {$in: ids}}).select('name code unit')
    : [];
  const byId = Object.fromEntries(ingredients.map(i => [String(i._id), i]));

  return rows.map(n => {
    const ing = n.referenceId ? byId[String(n.referenceId)] : null;
    return {
      _id: n._id,
      type: n.type,
      title: n.title,
      body: n.body,
      read: !!n.read,
      branch: n.branch?._id || n.branch,
      branchName: n.branch?.name || '',
      ingredientId: ing?._id || n.referenceId || null,
      ingredientName: ing?.name || '',
      createdAt: n.createdAt,
      source: 'live'
    };
  });
}

export async function markAlertRead({alertId, user}) {
  if (!mongoose.isValidObjectId(alertId)) throw httpError('Invalid alert', 400);
  const alert = await Notification.findById(alertId);
  if (!alert) throw httpError('Alert not found', 404);
  if (alert.branch) assertBranchAccess(user, alert.branch);
  alert.read = true;
  await alert.save();
  return alert;
}

export async function markAlertsRead({branchId, user}) {
  const branch = resolveBranch(user, branchId);
  const match = {read: false, ...(branch ? {branch} : {})};
  const result = await Notification.updateMany(match, {$set: {read: true}});
  return {updated: result.modifiedCount || 0, branch: branch || null};
}
