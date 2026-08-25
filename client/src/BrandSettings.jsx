import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Palette} from 'lucide-react';
import {brandInitials} from './branding.js';

/**
 * P2D — the tenant branding screen.
 *
 * SCOPE DISCIPLINE. The brief warns against "a giant settings page with
 * hundreds of uncontrolled fields", so this is four named sections over a
 * closed field list that mirrors the server's catalogue. Every field here
 * corresponds to something a surface actually renders.
 *
 * NOT A SECURITY BOUNDARY. Fields outside the tenant's plan are disabled and
 * labelled, which is a courtesy so an owner understands why they cannot type
 * in a box. The server refuses the same fields with a 402 regardless of what
 * the browser sends — proven in the backend suite, not here.
 *
 * THE PREVIEW IS PURE. It renders from local form state and issues no request:
 * no invoice is created, no number allocated, nothing is written. That is the
 * P2D-U requirement, and it falls out of the preview being a plain function of
 * the state the user is editing.
 */

const SECTIONS = [
  {
    key: 'identity',
    title: 'Brand identity',
    fields: [
      {key: 'displayName', label: 'Display name', type: 'text', tier: 'core'},
      {key: 'tagline', label: 'Tagline', type: 'text', tier: 'core'},
      {key: 'logoUrl', label: 'Logo URL', type: 'url', tier: 'core'},
      {key: 'faviconUrl', label: 'Favicon URL', type: 'url', tier: 'core'}
    ]
  },
  {
    key: 'colors',
    title: 'Colours and type',
    fields: [
      {key: 'primaryColor', label: 'Primary', type: 'color', tier: 'core'},
      {key: 'secondaryColor', label: 'Secondary', type: 'color', tier: 'core'},
      {key: 'accentColor', label: 'Accent', type: 'color', tier: 'advanced'},
      {key: 'backgroundColor', label: 'Background', type: 'color', tier: 'advanced'},
      {key: 'textColor', label: 'Text', type: 'color', tier: 'advanced'},
      {key: 'fontFamily', label: 'Typeface', type: 'font', tier: 'advanced'}
    ]
  },
  {
    key: 'contact',
    title: 'Contact',
    fields: [
      {key: 'supportEmail', label: 'Support email', type: 'text', tier: 'core'},
      {key: 'supportPhone', label: 'Support phone', type: 'text', tier: 'core'},
      {key: 'websiteUrl', label: 'Website', type: 'url', tier: 'core'},
      {key: 'facebookUrl', label: 'Facebook', type: 'url', tier: 'advanced'},
      {key: 'instagramUrl', label: 'Instagram', type: 'url', tier: 'advanced'}
    ]
  },
  {
    key: 'storefront',
    title: 'Storefront',
    fields: [
      {key: 'storefrontTitle', label: 'Title', type: 'text', tier: 'advanced'},
      {key: 'storefrontSubtitle', label: 'Subtitle', type: 'text', tier: 'advanced'},
      {key: 'storefrontNotice', label: 'Notice', type: 'text', tier: 'advanced'},
      {key: 'storefrontFooter', label: 'Footer', type: 'text', tier: 'advanced'},
      {key: 'orderingInstructions', label: 'Ordering instructions', type: 'text', tier: 'advanced'}
    ]
  },
  {
    key: 'receipt',
    title: 'Receipt',
    fields: [
      {key: 'receiptLogoEnabled', label: 'Show logo on receipts', type: 'boolean', tier: 'core'},
      {key: 'receiptFooter', label: 'Receipt footer', type: 'text', tier: 'core'}
    ]
  },
  {
    key: 'whitelabel',
    title: 'White label',
    fields: [
      {key: 'hideProductBranding', label: 'Hide product branding', type: 'boolean', tier: 'white'}
    ]
  }
];

const FONTS = ['system', 'serif', 'mono', 'rounded', 'condensed'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const TIER_LABEL = {core: null, advanced: 'Professional plan', white: 'Enterprise plan'};

export default function BrandSettings({call}) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await call('/my/restaurant/branding');
      setData(result);
      setForm({...(result.branding || {})});
    } catch (e) {
      setError(e.message);
    }
  }, [call]);

  useEffect(() => { load(); }, [load]);

  /** Unsaved-change detection, so a navigation warning is honest. */
  const dirty = useMemo(() => {
    if (!data) return false;
    return JSON.stringify(form) !== JSON.stringify(data.branding || {});
  }, [form, data]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const warn = event => {
      if (!dirty) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const editable = tier => (tier === 'core' ? true : Boolean(data?.editable?.[tier]));

  const setField = (key, value) => {
    setNotice('');
    setForm(previous => ({...previous, [key]: value}));
  };

  /** Client-side validation mirrors the server's, purely for a fast message. */
  const invalidFields = useMemo(() => {
    const bad = [];
    for (const section of SECTIONS) {
      for (const field of section.fields) {
        const value = form[field.key];
        if (value === undefined || value === null || value === '') continue;
        if (field.type === 'color' && !HEX.test(String(value))) bad.push(field.label);
        if (field.type === 'url' && !/^https?:\/\//i.test(String(value))) bad.push(field.label);
      }
    }
    return bad;
  }, [form]);

  const save = async () => {
    setError('');
    setNotice('');
    if (invalidFields.length) {
      setError(`Check these fields: ${invalidFields.join(', ')}`);
      return;
    }
    setBusy(true);
    try {
      // Only fields the plan permits are sent. The server enforces this too.
      const patch = {};
      for (const section of SECTIONS) {
        for (const field of section.fields) {
          if (!editable(field.tier)) continue;
          const value = form[field.key];
          patch[field.key] = value === undefined || value === '' ? null : value;
        }
      }
      const result = await call('/my/restaurant/branding', {
        method: 'PATCH', body: JSON.stringify(patch)
      });
      setData(previous => ({...previous, branding: result.branding, resolved: result.resolved}));
      setForm({...result.branding});
      setNotice(result.changed?.length
        ? `Saved ${result.changed.length} change${result.changed.length === 1 ? '' : 's'}.`
        : 'No changes to save.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <p className="danger">{error}</p>;
  if (!data) return <p>Loading your brand settings…</p>;

  const preview = {
    displayName: form.displayName || data.identity.name || 'Your restaurant',
    tagline: form.tagline || '',
    logoUrl: HEXOK(form.logoUrl) ? form.logoUrl : null,
    primary: HEX.test(String(form.primaryColor || '')) ? form.primaryColor : '#153b33',
    accent: HEX.test(String(form.accentColor || '')) ? form.accentColor : '#d88b28',
    background: HEX.test(String(form.backgroundColor || '')) ? form.backgroundColor : '#f6f5f1',
    text: HEX.test(String(form.textColor || '')) ? form.textColor : '#21312c',
    receiptFooter: form.receiptFooter || '',
    storefrontTitle: form.storefrontTitle || form.displayName || data.identity.name
  };

  return (
    <div>
      <div style={{display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px'}}>
        <Palette size={20}/>
        <h2 style={{margin: 0}}>Brand &amp; appearance</h2>
      </div>
      <p style={{marginTop: 0}}>
        These settings apply to your storefront, your receipts and this workspace.
      </p>

      {error && <p className="danger">{error}</p>}
      {notice && <p style={{color: '#246e50', fontWeight: 600}}>{notice}</p>}

      <div style={{display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: '20px'}}>
        <div>
          {SECTIONS.map(section => {
            const locked = section.fields.every(field => !editable(field.tier));
            return (
              <div key={section.key} style={{
                border: '1px solid #e5e9e4', borderRadius: '10px', padding: '14px',
                marginBottom: '14px', background: '#fff', opacity: locked ? 0.75 : 1
              }}>
                <h3 style={{margin: '0 0 10px'}}>{section.title}</h3>
                {section.fields.map(field => {
                  const allowed = editable(field.tier);
                  const value = form[field.key];
                  return (
                    <label key={field.key} style={{
                      display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px',
                      fontSize: '13px'
                    }}>
                      <span style={{width: '170px', color: '#617068'}}>
                        {field.label}
                        {!allowed && (
                          <small style={{display: 'block', color: '#926613'}}>
                            {TIER_LABEL[field.tier]}
                          </small>
                        )}
                      </span>
                      {field.type === 'boolean' ? (
                        <input
                          type="checkbox" aria-label={field.label} disabled={!allowed}
                          checked={value === true}
                          onChange={e => setField(field.key, e.target.checked)}
                        />
                      ) : field.type === 'font' ? (
                        <select
                          aria-label={field.label} disabled={!allowed} value={value || 'system'}
                          onChange={e => setField(field.key, e.target.value)}
                        >
                          {FONTS.map(font => <option key={font} value={font}>{font}</option>)}
                        </select>
                      ) : field.type === 'color' ? (
                        <>
                          <input
                            type="color" aria-label={field.label} disabled={!allowed}
                            value={HEX.test(String(value || '')) ? value : '#153b33'}
                            onChange={e => setField(field.key, e.target.value)}
                          />
                          <code style={{fontSize: '11px'}}>{value || '(default)'}</code>
                        </>
                      ) : (
                        <input
                          type="text" aria-label={field.label} disabled={!allowed}
                          value={value || ''} style={{flex: 1}}
                          placeholder={field.type === 'url' ? 'https://…' : ''}
                          onChange={e => setField(field.key, e.target.value)}
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            );
          })}

          <div style={{display: 'flex', gap: '10px', alignItems: 'center'}}>
            <button disabled={busy || !dirty} onClick={save}>
              {busy ? 'Saving…' : 'Save branding'}
            </button>
            {dirty && <span style={{fontSize: '12px', color: '#926613'}}>Unsaved changes</span>}
          </div>
        </div>

        {/* ── previews: pure functions of form state, no requests ── */}
        <div>
          <h3 style={{marginTop: 0}}>Preview</h3>

          <div style={{
            border: '1px solid #e5e9e4', borderRadius: '10px', overflow: 'hidden',
            marginBottom: '14px'
          }}>
            <div style={{background: preview.primary, color: '#fff', padding: '16px'}}>
              <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                {preview.logoUrl
                  ? <img src={preview.logoUrl} alt="" style={{maxHeight: '34px', maxWidth: '90px'}}/>
                  : (
                    <span style={{
                      background: preview.accent, borderRadius: '8px', padding: '6px 10px',
                      fontWeight: 700
                    }}>{brandInitials(preview.displayName)}</span>
                  )}
                <div>
                  <strong style={{fontSize: '16px'}}>{preview.displayName}</strong>
                  {preview.tagline && (
                    <div style={{fontSize: '12px', opacity: 0.85}}>{preview.tagline}</div>
                  )}
                </div>
              </div>
            </div>
            <div style={{background: preview.background, color: preview.text, padding: '14px'}}>
              <strong>{preview.storefrontTitle}</strong>
              <p style={{color: preview.text, opacity: 0.8, fontSize: '12px', margin: '6px 0 0'}}>
                Storefront appearance
              </p>
              <button style={{
                background: preview.accent, color: '#fff', border: 0, borderRadius: '6px',
                padding: '8px 12px', marginTop: '10px', fontWeight: 700
              }}>Order now</button>
            </div>
          </div>

          {/* Receipt preview. Renders locally; issues nothing. */}
          <div style={{
            border: '1px dashed #cbd5cf', borderRadius: '10px', padding: '14px',
            fontFamily: 'monospace', fontSize: '11px', background: '#fff'
          }}>
            <div style={{textAlign: 'center'}}>
              {form.receiptLogoEnabled && preview.logoUrl && (
                <img src={preview.logoUrl} alt="" style={{maxHeight: '30px', marginBottom: '4px'}}/>
              )}
              <div style={{fontWeight: 700}}>{preview.displayName}</div>
              {data.identity.legalName && <div>{data.identity.legalName}</div>}
              {data.identity.address && <div>{data.identity.address}</div>}
              {data.identity.pan && <div>PAN: {data.identity.pan}</div>}
            </div>
            <hr/>
            <div>1 x Sample item — 250.00</div>
            <hr/>
            {preview.receiptFooter && (
              <div style={{textAlign: 'center'}}>{preview.receiptFooter}</div>
            )}
          </div>
          <p style={{fontSize: '11px', color: '#94a3b8'}}>
            Preview only. Nothing is saved and no invoice number is issued.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A URL is only previewed when it is plainly http(s). */
function HEXOK(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}
