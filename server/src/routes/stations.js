import {Router} from 'express';
import {fail as safeFail} from '../services/httpErrors.js';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth, requirePermission} from '../middleware/auth.js';
import {Audit} from '../models/index.js';
import {userRestaurantContext} from '../services/supplierCatalog.js';
import {
  createStation,
  deleteStation,
  listStations,
  setDefaultStation,
  updateStation
} from '../services/stations.js';

const r = Router();
// Phase 25: shared safe error mapper. The local one echoed any error
// verbatim with a 400, leaking driver text and mislabelling server faults.
const fail = safeFail;

const stationSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  categories: z.array(z.string().trim().max(60)).max(50).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional()
}).strict();

// Anyone working a station needs to read the list; only management changes it.
r.get('/kitchen/stations', requirePermission('kds.view'), async (req, res) => {
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    const includeInactive = String(req.query.includeInactive || '') === 'true';
    const stations = await listStations({restaurantId, includeInactive});
    res.json({
      stations: stations.map(s => ({
        id: s._id,
        code: s.code,
        name: s.name,
        categories: s.categories || [],
        sortOrder: s.sortOrder,
        isDefault: Boolean(s.isDefault),
        active: s.active !== false
      })),
      // Flat code list kept for the KDS station picker.
      codes: stations.filter(s => s.active !== false).map(s => s.code)
    });
  } catch (e) {
    fail(res, e);
  }
});

r.post('/kitchen/stations', requirePermission('stations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const input = stationSchema.parse(req.body);
    const {restaurantId} = await userRestaurantContext(req.user);
    let station;
    await session.withTransaction(async () => {
      station = await createStation({restaurantId, input, user: req.user, session});
      await Audit.create([{
        entity: 'kitchen_station', entityId: station._id, restaurant: restaurantId,
        action: 'station_created', after: {code: station.code, name: station.name}, user: req.user.id
      }], {session});
    });
    res.status(201).json(station);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.patch('/kitchen/stations/:id', requirePermission('stations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const patch = stationSchema.partial().parse(req.body);
    const {restaurantId} = await userRestaurantContext(req.user);
    let station;
    await session.withTransaction(async () => {
      station = await updateStation({restaurantId, stationId: req.params.id, patch, user: req.user, session});
      await Audit.create([{
        entity: 'kitchen_station', entityId: station._id, restaurant: restaurantId,
        action: 'station_updated', after: {code: station.code, active: station.active}, user: req.user.id
      }], {session});
    });
    res.json(station);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.post('/kitchen/stations/:id/default', requirePermission('stations.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    let station;
    await session.withTransaction(async () => {
      station = await setDefaultStation({restaurantId, stationId: req.params.id, user: req.user, session});
    });
    res.json(station);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.delete('/kitchen/stations/:id', requirePermission('settings.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {restaurantId} = await userRestaurantContext(req.user);
    let station;
    await session.withTransaction(async () => {
      station = await deleteStation({restaurantId, stationId: req.params.id, session});
    });
    res.json({deactivated: true, station});
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

export default r;
