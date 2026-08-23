import {Audit} from '../models/index.js';
import {installAuditChain} from './auditTrail.js';

/**
 * Install the audit hash-chain hook and build the search indexes.
 *
 * The hook is attached to the compiled model, so it must be installed before
 * any audit row is written — hence its position at the head of the startup
 * migrations. Installing it here rather than at import time keeps module
 * loading free of side effects and makes the ordering explicit.
 *
 * Idempotent: `installAuditChain()` guards against a second registration, and
 * `createIndexes()` is a no-op once the indexes exist.
 */
export async function ensureAuditIndexes() {
  installAuditChain();
  await Audit.createIndexes();
  return true;
}
