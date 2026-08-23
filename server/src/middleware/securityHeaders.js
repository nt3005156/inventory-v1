/**
 * Phase 25 — baseline security response headers.
 *
 * Deliberately dependency-free rather than pulling in helmet: this is a JSON
 * API plus one server-rendered HTML receipt, so the useful set is small and
 * writing it out makes each choice reviewable.
 *
 *   X-Content-Type-Options: nosniff
 *       Stops a browser MIME-sniffing a JSON body into HTML, which is how a
 *       reflected value in an API response becomes executable script.
 *
 *   X-Frame-Options / frame-ancestors
 *       The API must never be framed. The receipt is printed, never embedded,
 *       so there is no legitimate framing use to preserve.
 *
 *   Referrer-Policy: no-referrer
 *       API paths carry record ids; do not hand them to third parties on
 *       navigation away.
 *
 *   Content-Security-Policy: default-src 'none'
 *       Correct for JSON — nothing should ever load from an API response. The
 *       receipt route overrides this with its own narrower policy because it
 *       is a real HTML document with an inline <style> block.
 *
 *   Cache-Control: no-store on /api
 *       An authenticated response must not sit in a shared proxy or in the
 *       browser's back/forward cache after sign-out.
 *
 *   Strict-Transport-Security
 *       Production over TLS only. Sending it from a plain-HTTP dev box pins
 *       the browser to https:// and locks developers out of their own machine.
 *
 * Exported as middleware so the production app and the test harness install
 * the SAME implementation — a header set that only exists in production is a
 * header set nothing tests.
 */
export function securityHeaders(env = process.env) {
  return function applySecurityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    );
    if (String(req.path || '').startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    if (env.NODE_ENV === 'production' && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}
