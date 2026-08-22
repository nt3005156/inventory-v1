import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth, requirePermission} from '../middleware/auth.js';
import {Audit, Coupon, CouponRedemption} from '../models/index.js';
import {normalizeCouponInput, normalizeCode, validateCoupon} from '../services/discounts.js';
import {userRestaurantContext} from '../services/supplierCatalog.js';
import {ORDER_TYPES} from '../services/pos.js';

const r = Router();
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});

const couponSchema = z.object({
  code: z.string().trim().min(2).max(40),
  description: z.string().trim().max(300).optional(),
  kind: z.enum(['percentage', 'fixed']),
  value: z.number().positive(),
  maxDiscount: z.number().min(0).nullable().optional(),
  minOrderAmount: z.number().min(0).optional(),
  startsAt: z.string().optional().nullable(),
  endsAt: z.string().optional().nullable(),
  usageLimit: z.number().int().min(0).optional(),
  perCustomerLimit: z.number().int().min(0).optional(),
  branches: z.array(z.string()).max(50).optional(),
  menuItems: z.array(z.string()).max(200).optional(),
  orderTypes: z.array(z.enum(ORDER_TYPES)).max(4).optional(),
  active: z.boolean().optional()
}).strict();

// Managing promotions is a management action; redeeming one is not.
r.post('/coupons', requirePermission('coupons.manage'), async (req, res) => {
  try {
    const input = normalizeCouponInput(couponSchema.parse(req.body));
    const {restaurantId} = await userRestaurantContext(req.user);
    const existing = await Coupon.findOne({restaurant: restaurantId, code: input.code});
    if (existing) throw Object.assign(new Error(`Coupon ${input.code} already exists`), {status: 409});
    const coupon = await Coupon.create({...input, restaurant: restaurantId, createdBy: req.user.id});
    await Audit.create({
      entity: 'coupon', entityId: coupon._id, restaurant: restaurantId,
      action: 'coupon_created', after: {code: coupon.code, kind: coupon.kind, value: coupon.value},
      user: req.user.id
    });
    res.status(201).json(coupon);
  } catch (e) {
    fail(res, e);
  }
});

r.get('/coupons', requirePermission('coupons.view'), async (req, res) => {
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    const match = {restaurant: restaurantId};
    if (req.query.active !== undefined && req.query.active !== '') {
      if (!['true', 'false'].includes(String(req.query.active))) throw Object.assign(new Error('Invalid active filter'), {status: 400});
      match.active = String(req.query.active) === 'true';
    }
    if (req.query.code) match.code = normalizeCode(req.query.code);
    res.json(await Coupon.find(match).sort({active: -1, code: 1}).limit(200));
  } catch (e) {
    fail(res, e);
  }
});

r.get('/coupons/:id', requirePermission('coupons.view'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid coupon'), {status: 400});
    const {restaurantId} = await userRestaurantContext(req.user);
    const coupon = await Coupon.findOne({_id: req.params.id, restaurant: restaurantId});
    if (!coupon) throw Object.assign(new Error('Coupon not found'), {status: 404});
    const redemptions = await CouponRedemption.countDocuments({coupon: coupon._id});
    res.json({...coupon.toObject(), redemptions});
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/coupons/:id', requirePermission('coupons.manage'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid coupon'), {status: 400});
    const {restaurantId} = await userRestaurantContext(req.user);
    const coupon = await Coupon.findOne({_id: req.params.id, restaurant: restaurantId});
    if (!coupon) throw Object.assign(new Error('Coupon not found'), {status: 404});
    const patch = couponSchema.partial().parse(req.body);
    const merged = normalizeCouponInput({...coupon.toObject(), ...patch});
    const before = {code: coupon.code, value: coupon.value, active: coupon.active};
    Object.assign(coupon, merged, {updatedBy: req.user.id});
    await coupon.save();
    await Audit.create({
      entity: 'coupon', entityId: coupon._id, restaurant: restaurantId,
      action: 'coupon_updated', before, after: {code: coupon.code, value: coupon.value, active: coupon.active},
      user: req.user.id
    });
    res.json(coupon);
  } catch (e) {
    fail(res, e);
  }
});

// Owners retire coupons rather than deleting them, so redemption history stays intact.
r.delete('/coupons/:id', requirePermission('coupons.delete'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid coupon'), {status: 400});
    const {restaurantId} = await userRestaurantContext(req.user);
    const coupon = await Coupon.findOne({_id: req.params.id, restaurant: restaurantId});
    if (!coupon) throw Object.assign(new Error('Coupon not found'), {status: 404});
    coupon.active = false;
    coupon.updatedBy = req.user.id;
    await coupon.save();
    await Audit.create({
      entity: 'coupon', entityId: coupon._id, restaurant: restaurantId,
      action: 'coupon_deactivated', user: req.user.id
    });
    res.json({deactivated: true, coupon});
  } catch (e) {
    fail(res, e);
  }
});

// Dry-run a code against a prospective order so the till can preview it.
r.post('/coupons/validate', requirePermission('coupons.view'), async (req, res) => {
  try {
    const body = z.object({
      code: z.string().min(1),
      branch: z.string().optional(),
      orderType: z.enum(ORDER_TYPES).optional(),
      customer: z.string().optional(),
      subtotal: z.number().min(0),
      lines: z.array(z.object({menuItem: z.string(), lineNet: z.number().min(0)})).max(100).optional()
    }).strict().parse(req.body);
    const {restaurantId} = await userRestaurantContext(req.user);
    const result = await validateCoupon({
      code: body.code,
      restaurantId,
      branchId: body.branch,
      orderType: body.orderType,
      customerId: body.customer,
      lines: body.lines || [],
      subtotal: body.subtotal
    });
    res.json({
      valid: true,
      code: result.code,
      kind: result.coupon.kind,
      value: result.coupon.value,
      amount: result.amount,
      eligibleNet: result.eligibleNet
    });
  } catch (e) {
    if (e.status === 404 || e.status === 409) {
      return res.status(e.status).json({valid: false, message: e.message});
    }
    fail(res, e);
  }
});

export default r;
