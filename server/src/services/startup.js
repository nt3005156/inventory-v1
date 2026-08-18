import mongoose from 'mongoose';
import {resolveCorsPolicy, resolveTrustProxy} from './deployment.js';
import {paymentMode, requireProductionPaymentConfig} from './paymentConfig.js';
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
import {ensureIngredientIndexes} from './ingredients.js';
import {ensureRecipeIndexes} from './recipes.js';
import {ensureCustomerIndexes} from './customerMigration.js';

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
  ensureSupplierPaymentIndexes,
  ensureIngredientIndexes,
  ensureRecipeIndexes,
  // Phase 9: backfills restaurant + phoneKey and merges pre-Phase-9
  // per-branch duplicates before the unique index is built.
  ensureCustomerIndexes
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

// Origin parsing and the environment-class rules now live in deployment.js so
// the HTTP layer, the Socket.IO layer and startup validation cannot drift.
export {allowedOrigins as configuredClientOrigins} from './deployment.js';

function validateClientOrigins(env) {
  // Throws in staging/production when CLIENT_URL is missing, wildcarded, or
  // otherwise unusable; returns the allowlist (possibly empty in development).
  return resolveCorsPolicy(env).origins;
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
  // A bad TRUST_PROXY (true/*) silently breaks client-IP detection and rate
  // limiting, so it is a startup failure rather than a runtime surprise.
  resolveTrustProxy(env);
  // Payment mode must be explicit and must never be the vendor's public
  // sandbox secret in production - anyone can forge a callback with it.
  paymentMode(env);
  requireProductionPaymentConfig(env);
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
