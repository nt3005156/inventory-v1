/**
 * P2H.4 — one way for CLI tools to resolve the database URI.
 *
 * THE DEFECT THIS FIXES, MEASURED. Nine entry points — `src/seed.js` and eight
 * scripts — each did some variation of:
 *
 *     mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/...')
 *
 * None of them called `loadFileBackedSecrets()`. That was harmless while
 * MongoDB was unauthenticated, because the fallback happened to work. The
 * moment authentication was switched on, `npm run seed` inside the container
 * failed with `ECONNREFUSED 127.0.0.1:27017`: `MONGODB_URI` was never set —
 * only `MONGODB_URI_FILE` was — so every tool silently fell back to a
 * localhost URI with no credentials.
 *
 * Worse than the failure is the shape of it. A tool that falls back to an
 * unauthenticated localhost default will, on a developer machine that happens
 * to run a local mongod, quietly operate on the WRONG DATABASE rather than
 * refusing. So this helper resolves the file-backed secret first and then
 * requires a URI, instead of inventing one.
 */
import mongoose from 'mongoose';
import {loadFileBackedSecrets} from './secrets.js';

/**
 * The connection string for a CLI tool, honouring `MONGODB_URI_FILE`.
 *
 * `allowFallback` exists for the few tools that legitimately run against a
 * throwaway local database (tests, local scratch scripts). It is off by
 * default: an operations script that touches production data should fail
 * loudly rather than guess.
 */
export function resolveCliMongoUri({env = process.env, fallback = null} = {}) {
  // Resolve `<NAME>_FILE` into `<NAME>` exactly as the API does at startup.
  loadFileBackedSecrets(env);

  const uri = String(env.MONGODB_URI || env.MONGO_URL || '').trim();
  if (uri) return uri;
  if (fallback) return fallback;

  throw new Error(
    'MONGODB_URI is not set. Set MONGODB_URI, or MONGODB_URI_FILE pointing at '
    + 'a file containing the connection string (see scripts/mongo-bootstrap-auth.sh).'
  );
}

/**
 * Connect a CLI tool to MongoDB.
 *
 * Deliberately thin: it exists so no tool has to remember the secret-file
 * step, not to wrap mongoose.
 */
export async function connectCli({env = process.env, fallback = null, options} = {}) {
  const uri = resolveCliMongoUri({env, fallback});
  await mongoose.connect(uri, options);
  return uri;
}
