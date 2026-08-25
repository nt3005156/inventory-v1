/**
 * P2D — client-side theming.
 *
 * WHY CSS CUSTOM PROPERTIES RATHER THAN REWRITING THE STYLESHEET
 * --------------------------------------------------------------
 * `style.css` contains 205 hard-coded hex colours and no variables. Rewriting
 * all of them to be tenant-driven would be a large, risky change to every
 * screen in the product for a phase whose job is branding, and it would make
 * the diff impossible to review.
 *
 * Instead a small set of custom properties is set on `:root`, and the specific
 * surfaces that should follow the tenant's brand consume them. Screens that
 * were not touched keep their existing appearance exactly. That is deliberate:
 * the brief warns against branding reducing readability, and an operational
 * POS or KDS that suddenly renders in a tenant's chosen pink is a safety
 * problem, not a feature.
 *
 * THE VALUES ARE SERVER-VALIDATED
 * -------------------------------
 * Colours arrive as `#RRGGBB` (validated server-side) and the font arrives as
 * a resolved stack from a server-side allowlist. The client never accepts a
 * raw font-family or a free-form colour, so nothing here can inject CSS.
 * `applyBranding()` re-checks the shape anyway — defence in depth against a
 * compromised or mistaken API response, and it costs one regex.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Product defaults, mirroring the server's `PRODUCT_DEFAULTS`. */
export const DEFAULT_THEME = Object.freeze({
  primaryColor: '#153b33',
  secondaryColor: '#276050',
  accentColor: '#d88b28',
  backgroundColor: '#f6f5f1',
  textColor: '#21312c'
});

/** Only a valid six-digit hex is ever written into a style. */
function safeColor(value, fallback) {
  return typeof value === 'string' && HEX.test(value.trim()) ? value.trim() : fallback;
}

/**
 * A font stack is only accepted if it looks like a plain font list.
 *
 * The server picks it from an allowlist, so this should always pass; it exists
 * so a malformed response cannot inject a declaration terminator.
 */
function safeFontStack(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/[;{}<>()]/.test(value)) return null;
  return value.slice(0, 200);
}

/**
 * Apply a tenant's branding to the document.
 *
 * Sets CSS custom properties, the page title and the favicon. Safe to call
 * repeatedly; each call fully overwrites the previous one so switching tenants
 * cannot leave a stale colour behind.
 */
export function applyBranding(branding, {documentRef = typeof document === 'undefined' ? null : document} = {}) {
  if (!documentRef) return null;
  const theme = {
    primary: safeColor(branding?.primaryColor, DEFAULT_THEME.primaryColor),
    secondary: safeColor(branding?.secondaryColor, DEFAULT_THEME.secondaryColor),
    accent: safeColor(branding?.accentColor, DEFAULT_THEME.accentColor),
    background: safeColor(branding?.backgroundColor, DEFAULT_THEME.backgroundColor),
    text: safeColor(branding?.textColor, DEFAULT_THEME.textColor)
  };

  const root = documentRef.documentElement;
  if (root?.style?.setProperty) {
    root.style.setProperty('--brand-primary', theme.primary);
    root.style.setProperty('--brand-secondary', theme.secondary);
    root.style.setProperty('--brand-accent', theme.accent);
    root.style.setProperty('--brand-background', theme.background);
    root.style.setProperty('--brand-text', theme.text);
    const stack = safeFontStack(branding?.fontStack);
    if (stack) root.style.setProperty('--brand-font', stack);
  }

  // The page title is the tenant's, not the product's.
  const title = typeof branding?.displayName === 'string' ? branding.displayName.slice(0, 80) : null;
  if (title) documentRef.title = title;

  // A favicon is only ever set from an http/https URL the server validated.
  const favicon = branding?.faviconUrl;
  if (typeof favicon === 'string' && /^https?:\/\//i.test(favicon) && documentRef.head) {
    let link = documentRef.querySelector("link[rel='icon']");
    if (!link) {
      link = documentRef.createElement('link');
      link.setAttribute('rel', 'icon');
      documentRef.head.appendChild(link);
    }
    link.setAttribute('href', favicon);
  }

  return theme;
}

/** Initials for a tenant with no logo, so a header is never empty. */
export function brandInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
