/**
 * Phase 28 — Docker/Kubernetes secret loading via the `*_FILE` convention.
 *
 * WHY. Passing a secret as an environment variable puts it somewhere it does
 * not belong: `docker inspect` prints it in plain text to anyone on the host
 * with socket access, it is inherited by every child process, and it lands in
 * crash dumps and `/proc/<pid>/environ`. Verified during this phase —
 * `docker inspect` on the API container showed `JWT_SECRET`,
 * `ESEWA_SECRET_KEY` and `KHALTI_SECRET_KEY` in full.
 *
 * Docker secrets and Kubernetes secret volumes both mount the value as a FILE
 * instead. The near-universal convention for consuming that is a parallel
 * `<NAME>_FILE` variable holding the path, which the application reads at
 * startup. That is what this does.
 *
 *   JWT_SECRET=abc...              # works, still supported
 *   JWT_SECRET_FILE=/run/secrets/jwt_secret   # preferred in production
 *
 * The file wins when both are present, and a `_FILE` that points at something
 * unreadable is a STARTUP FAILURE rather than a silent fallback: quietly
 * falling back to a weaker source is how a deployment ends up running on a
 * placeholder secret while the operator believes it is using a real one.
 */
import fs from 'node:fs';

/** Secrets this deployment knows how to load from a file. */
export const FILE_BACKED_SECRETS = Object.freeze([
  'JWT_SECRET',
  'ESEWA_SECRET_KEY',
  'KHALTI_SECRET_KEY',
  'MONGODB_URI'
]);

/**
 * Resolve `<NAME>_FILE` variables into `<NAME>`, in place on the given env.
 *
 * Returns the list of names that were loaded from a file so startup can log
 * WHICH secrets came from where — without ever logging a value.
 */
export function loadFileBackedSecrets(env = process.env, {readFile = fs.readFileSync} = {}) {
  const loaded = [];
  for (const name of FILE_BACKED_SECRETS) {
    const pathKey = `${name}_FILE`;
    const path = String(env[pathKey] || '').trim();
    if (!path) continue;

    let value;
    try {
      value = String(readFile(path, 'utf8'));
    } catch (error) {
      // Loud, not silent. A missing secret file must never fall through to a
      // stale environment variable or an empty string.
      throw new Error(`${pathKey} is set to ${path} but the file could not be read: ${error.code || error.message}`);
    }
    // Trailing newlines are near-universal in secret files (`echo x > f`) and
    // would otherwise corrupt an HMAC key or a connection string.
    value = value.replace(/\r?\n$/, '');
    if (!value) throw new Error(`${pathKey} points at ${path}, which is empty`);

    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
