import mongoose from 'mongoose';
import {ensureMonthCloseIndexes} from './monthCloseMigration.js';
import {ensureSupplierCatalogIndexes} from './supplierCatalogMigration.js';
import {ensurePurchaseOrderIndexes} from './purchaseOrderMigration.js';
import {ensureGoodsReceivingIndexes} from './goodsReceivingMigration.js';
import {ensureInventoryBatchIndexes} from './inventoryBatchMigration.js';
import {ensureInventoryLedgerIndexes} from './inventoryLedgerMigration.js';
import {ensurePurchaseReturnIndexes} from './purchaseReturnMigration.js';
import {ensureSupplierInvoiceIndexes} from './supplierInvoiceMigration.js';
import {ensureSupplierPaymentIndexes} from './supplierPaymentMigration.js';
import {ensureStockCountIndexes} from './stockCountMigration.js';
import {ensureStockTransferIndexes} from './stockTransferMigration.js';

const OPERATIONAL_MIGRATIONS = [
  ensureMonthCloseIndexes,
  ensureSupplierCatalogIndexes,
  ensurePurchaseOrderIndexes,
  ensureGoodsReceivingIndexes,
  ensureInventoryLedgerIndexes,
  ensureInventoryBatchIndexes,
  ensureStockCountIndexes,
  ensureStockTransferIndexes,
  ensurePurchaseReturnIndexes,
  ensureSupplierInvoiceIndexes,
  ensureSupplierPaymentIndexes
];

const INSECURE_PRODUCTION_SECRETS = new Set([
  'change-me',
  'dev-secret',
  'replace-me',
  'replace-with-a-long-random-secret',
  'your-jwt-secret'
]);

export async function ensureOperationalIndexes() {
  // These migrations repair historical data as well as indexes. Keep them
  // sequential so later purchasing migrations can depend on earlier invariants.
  for (const migrate of OPERATIONAL_MIGRATIONS) await migrate();
}

export function configuredClientOrigins(env = process.env) {
  return String(env.CLIENT_URL || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function validateClientOrigins(env) {
  const origins = configuredClientOrigins(env);
  if (env.NODE_ENV === 'production' && origins.length === 0) {
    throw new Error('CLIENT_URL is required in production');
  }

  for (const origin of origins) {
    if (origin === '*') throw new Error('CLIENT_URL must list explicit HTTP(S) origins');
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CLIENT_URL contains an invalid origin: ${origin}`);
    }
    const normalized = origin.replace(/\/$/, '');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== normalized) {
      throw new Error(`CLIENT_URL must contain origins only, without paths: ${origin}`);
    }
  }

  return origins;
}

export function validateRuntimeEnvironment(env = process.env) {
  if (!String(env.MONGODB_URI || '').trim()) throw new Error('MONGODB_URI is required');

  const secret = String(env.JWT_SECRET || '').trim();
  if (secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  if (env.NODE_ENV === 'production' && INSECURE_PRODUCTION_SECRETS.has(secret.toLowerCase())) {
    throw new Error('JWT_SECRET must be replaced before production startup');
  }

  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  validateClientOrigins(env);
}

export async function verifyTransactionCapableDatabase(connection = mongoose.connection) {
  if (!connection?.db) throw new Error('MongoDB is not connected');
  const hello = await connection.db.admin().command({hello: 1});
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error('MongoDB must be a replica set or sharded cluster because purchasing operations use transactions');
  }
  if (hello.msg !== 'isdbgrid' && !hello.isWritablePrimary) {
    throw new Error('MongoDB replica set does not currently have a writable primary');
  }
  return hello;
}
