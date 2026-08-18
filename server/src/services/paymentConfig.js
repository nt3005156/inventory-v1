/**
 * Payment gateway configuration (Phase 8B).
 *
 * Secrets live only in the environment. Nothing in this file, and nothing
 * committed to the repository, contains a live credential. The eSewa UAT
 * credentials (EPAYTEST / the published test secret) are the vendor's own
 * documented sandbox values and are only ever used when mode is 'sandbox'.
 *
 * A provider is "configured" only when it has the credentials it needs. An
 * unconfigured provider is refused at checkout with a clear message rather
 * than silently producing a broken redirect.
 */
import {resolveEnvironment} from './deployment.js';

export const PAYMENT_PROVIDERS = Object.freeze(['esewa', 'khalti']);

// eSewa's published sandbox credentials. Public, vendor-documented, and
// rejected outright in production by requireProductionPaymentConfig().
const ESEWA_SANDBOX_PRODUCT_CODE = 'EPAYTEST';
const ESEWA_SANDBOX_SECRET = '8gBm/:&EnhH.1/q';

const ESEWA_ENDPOINTS = Object.freeze({
  sandbox: {
    form: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
    status: 'https://rc.esewa.com.np/api/epay/transaction/status/'
  },
  production: {
    form: 'https://epay.esewa.com.np/api/epay/main/v2/form',
    status: 'https://esewa.com.np/api/epay/transaction/status/'
  }
});

const KHALTI_ENDPOINTS = Object.freeze({
  sandbox: {base: 'https://dev.khalti.com'},
  production: {base: 'https://khalti.com'}
});

const clean = value => String(value ?? '').trim();

/**
 * sandbox unless PAYMENT_MODE says otherwise. Production/staging default to
 * production endpoints, so a deployment cannot accidentally take real money
 * against a sandbox account or vice versa without saying so explicitly.
 */
export function paymentMode(env = process.env) {
  const declared = clean(env.PAYMENT_MODE).toLowerCase();
  if (declared) {
    if (!['sandbox', 'production'].includes(declared)) {
      throw new Error(`PAYMENT_MODE must be sandbox or production (received: ${declared})`);
    }
    return declared;
  }
  return resolveEnvironment(env) === 'production' ? 'production' : 'sandbox';
}

/**
 * Absolute base URL the gateway redirects the guest back to. Gateways require
 * absolute URLs, so this cannot be derived from a relative path.
 */
export function paymentReturnBase(env = process.env) {
  const explicit = clean(env.PAYMENT_RETURN_BASE_URL).replace(/\/$/, '');
  if (explicit) return explicit;
  const firstClientOrigin = clean(env.CLIENT_URL).split(',')[0].trim().replace(/\/$/, '');
  return firstClientOrigin || 'http://localhost:5173';
}

export function esewaConfig(env = process.env) {
  const mode = paymentMode(env);
  const sandbox = mode === 'sandbox';
  const productCode = clean(env.ESEWA_MERCHANT_CODE) || (sandbox ? ESEWA_SANDBOX_PRODUCT_CODE : '');
  const secret = clean(env.ESEWA_SECRET_KEY) || (sandbox ? ESEWA_SANDBOX_SECRET : '');
  // Overridable so integration tests can point at a local stub provider and
  // exercise the real HTTP path instead of stubbing our own module out.
  const endpoints = ESEWA_ENDPOINTS[mode];
  return {
    provider: 'esewa',
    mode,
    productCode,
    secret,
    formUrl: clean(env.ESEWA_FORM_URL) || endpoints.form,
    statusUrl: clean(env.ESEWA_STATUS_URL) || endpoints.status,
    configured: Boolean(productCode && secret),
    usingVendorSandboxCredentials: sandbox && !clean(env.ESEWA_SECRET_KEY)
  };
}

export function khaltiConfig(env = process.env) {
  const mode = paymentMode(env);
  const secret = clean(env.KHALTI_SECRET_KEY);
  const base = clean(env.KHALTI_BASE_URL).replace(/\/$/, '') || KHALTI_ENDPOINTS[mode].base;
  return {
    provider: 'khalti',
    mode,
    secret,
    baseUrl: base,
    initiateUrl: `${base}/api/v2/epayment/initiate/`,
    lookupUrl: `${base}/api/v2/epayment/lookup/`,
    // Khalti issues no usable sandbox key by default, so it is only
    // configured when an operator supplies one.
    configured: Boolean(secret)
  };
}

export function providerConfig(provider, env = process.env) {
  if (provider === 'esewa') return esewaConfig(env);
  if (provider === 'khalti') return khaltiConfig(env);
  throw Object.assign(new Error(`Unknown payment provider: ${provider}`), {status: 400});
}

/** Which online payment methods a guest may actually pick right now. */
export function availablePaymentMethods(env = process.env) {
  const methods = ['cod'];
  for (const provider of PAYMENT_PROVIDERS) {
    if (providerConfig(provider, env).configured) methods.push(provider);
  }
  return methods;
}

/**
 * Startup guard. A production deployment must never run on the vendor's public
 * sandbox secret — anyone can forge a callback signature with it.
 */
export function requireProductionPaymentConfig(env = process.env) {
  if (resolveEnvironment(env) !== 'production') return;
  const esewa = esewaConfig(env);
  if (esewa.configured && paymentMode(env) === 'production') {
    if (clean(env.ESEWA_SECRET_KEY) === ESEWA_SANDBOX_SECRET) {
      throw new Error('ESEWA_SECRET_KEY is the published sandbox secret and must not be used in production');
    }
    if (clean(env.ESEWA_MERCHANT_CODE) === ESEWA_SANDBOX_PRODUCT_CODE) {
      throw new Error('ESEWA_MERCHANT_CODE is the sandbox product code and must not be used in production');
    }
  }
  if (resolveEnvironment(env) === 'production' && paymentMode(env) === 'sandbox') {
    throw new Error('PAYMENT_MODE must not be sandbox in production');
  }
}

/**
 * Safe description for /health and logs. Never returns a secret — only whether
 * one is present.
 */
export function describePayments(env = process.env) {
  const esewa = esewaConfig(env);
  const khalti = khaltiConfig(env);
  return {
    mode: paymentMode(env),
    esewa: {configured: esewa.configured, productCode: esewa.configured ? esewa.productCode : null},
    khalti: {configured: khalti.configured},
    methods: availablePaymentMethods(env)
  };
}

/**
 * Redact anything secret-shaped before a gateway payload reaches a log.
 * Signatures and keys are the fields that must never be persisted in logs.
 */
export function redactPaymentPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const redacted = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/secret|signature|authorization|key|token|password/i.test(key)) {
      redacted[key] = '[redacted]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      redacted[key] = redactPaymentPayload(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
