import {UserSession} from '../models/index.js';

/**
 * Build the UserSession indexes.
 *
 * The schema sets `autoIndex:false` — as every operational model here does —
 * so nothing is created implicitly. Two of these indexes are load-bearing
 * rather than cosmetic:
 *
 *   • `sessionHash` is UNIQUE. Without it a hash collision or a replayed
 *     create could produce two rows for one session id, and revoking one
 *     would leave the other live.
 *   • `expiresAt` is a TTL index. It is what keeps the collection bounded;
 *     without it every login would accumulate a row forever.
 *
 * Idempotent, so it is safe to run on every boot.
 */
export async function ensureSessionIndexes() {
  await UserSession.createIndexes();
  return true;
}
