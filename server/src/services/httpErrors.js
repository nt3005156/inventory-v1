/**
 * Phase 25 — one safe way to turn an error into an HTTP response.
 *
 * Eight routers carried this shape:
 *
 *   const fail = (res, e) => res.status(e.status || 400).json({message: e.message});
 *
 * Two problems, both confirmed by probe:
 *
 * 1. IT LEAKS INTERNALS. Any error without a `.status` — a Mongoose
 *    CastError, a driver failure, a genuine bug — was echoed verbatim to the
 *    caller. A real response from `/menu-items/:id/versions` was
 *    `Cannot read properties of null (reading 'recipeVersion')`, and
 *    `PATCH /suppliers/:id` returned a full serialised ZodError including the
 *    internal schema path. That is free reconnaissance, and stack-shaped
 *    messages are how an attacker maps an unfamiliar backend.
 *
 * 2. IT MISLABELS SERVER FAULTS AS 400. An unexpected exception became "400
 *    Bad Request", blaming the caller for a server bug and hiding real 500s
 *    from monitoring.
 *
 * The rule: an error is only shown to the caller if the application
 * DELIBERATELY raised it, i.e. it carries an explicit `status` below 500.
 * Everything else becomes a generic 500. Validation errors are summarised to
 * the offending field name rather than dumped.
 */

/**
 * Error classes whose raw text describes the DATABASE or a code fault rather
 * than the caller's request. These never reach the client verbatim.
 *
 * `ValidationError` is deliberately NOT here. A Mongoose validation failure is
 * a business rule the schema is enforcing ("a VAT-registered supplier requires
 * a PAN"), and it is the only place some of those rules live — turning it into
 * "Server error" both hides a legitimate 400 and tells the operator nothing.
 * Its field messages are authored in this repository, not by the driver. It is
 * summarised below instead.
 */
const INTERNAL_ERROR_NAMES = new Set([
  'CastError', 'MongoServerError', 'MongoError', 'MongoNetworkError',
  'VersionError', 'StrictModeError', 'TypeError',
  'ReferenceError', 'RangeError', 'SyntaxError'
]);

/**
 * Mongoose validation failure -> 400 with the first field message.
 *
 * The full error stringifies as
 * `Supplier validation failed: pan: A VAT-registered supplier requires a PAN`,
 * which names the model and the internal path. Only the authored message is
 * returned.
 */
function describeValidationError(error) {
  const first = Object.values(error?.errors || {})[0];
  const message = String(first?.message || 'Some details are missing or invalid');
  return {status: 400, message: message.slice(0, 300)};
}

/**
 * Map an error to `{status, message}` without leaking internals.
 *
 * Exported separately from `fail()` so it can be unit-tested directly and
 * reused by the global Express error handler.
 */
export function describeError(error) {
  if (error?.name === 'ZodError') {
    const issue = Array.isArray(error.issues) ? error.issues[0] : null;
    const field = issue?.path?.length ? issue.path.join('.') : null;
    return {
      status: 400,
      message: field ? `Invalid ${field}` : 'Some details are missing or invalid'
    };
  }

  if (error?.name === 'ValidationError') return describeValidationError(error);

  const status = Number(error?.status);
  const deliberate = Number.isInteger(status) && status >= 400 && status < 500;

  if (!deliberate) {
    // No explicit client-error status: treat as a server fault regardless of
    // what the error object claims, and say nothing about it.
    return {status: Number.isInteger(status) && status >= 500 ? status : 500, message: 'Server error'};
  }

  // Deliberate client error, but the text may still have come from the driver
  // rather than from us.
  if (INTERNAL_ERROR_NAMES.has(error?.name)) {
    return {status, message: 'We could not process that request'};
  }

  const message = String(error?.message || 'Request failed');
  return {status, message: message.slice(0, 300)};
}

/** Send a safe error response. Drop-in replacement for the old `fail()`. */
export function fail(res, error) {
  const {status, message} = describeError(error);
  return res.status(status).json({message});
}
