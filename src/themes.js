'use strict';
/**
 * openvibe-sdk/themes: the OpenVibe theme system for any app. A person's theme, display preferences (motion, text size,
 * seasonal themes) and the seasons follow their account to every OpenVibe site; an app reads and changes them here, and
 * a page or a game follows them as they change. Browser-safe.
 *
 * The account (OpenVibe.Network /api/themes):
 *
 *   const themes = createThemesClient(client);                // client from openvibe-sdk/core (the person's sign-in)
 *   const { themes: list } = await themes.catalog({ mode: 'dark' });          // approved themes; seasonal ones carry `season`
 *   const theme = await themes.get('nord');                    // null when missing
 *   const mine = await themes.active();                        // { theme_id, custom_variables, display } (guests: theme_id null)
 *   await themes.set('nord');                                  // or set('vibe', { custom: { '--accent': '#ff5c8a' } })
 *   await themes.setDisplay({ motion: 'reduced', text: '112', seasonal: 'off', scheme: 'auto' });
 *   const { seasons, now } = await themes.seasons();           // what stands in for the default theme when
 *
 * On a page (the theme loader every OpenVibe site runs, openvibe-sdk/frame, paints the theme; this follows it):
 *
 *   const stop = followTheme(({ tokens, mode, display, season }) => {
 *       game.setPalette(tokens['--accent'], tokens['--bg-primary']);   // a canvas or WebGL scene keeps up
 *       game.setCalm(display.motion === 'reduced');                   // no screen shake, fewer particles
 *       game.setUiScale(display.textScale);                           // 1, 1.12 or 1.25
 *   });
 *
 * followTheme calls back once at once and again on every change (another tab, the account's answer, a season starting,
 * a display preference), with the CSS variables on <html> read fresh; stop() ends it. readTheme() is the same snapshot
 * on demand. applyTheme(vars) paints a theme's variables on an element (default <html>) for apps without the loader.
 */
const { isOpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;
// scheme: 'manual' (the picked theme as it is) or 'auto' (its light or dark half, as the device is set).
const DISPLAY_OPTIONS = Object.freeze({ motion: ['auto', 'reduced'], text: ['100', '112', '125'], seasonal: ['on', 'off'], scheme: ['manual', 'auto'] });
/** The tokens every OpenVibe theme sets (the shared names apps style with). */
const TOKENS = Object.freeze(['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-card', '--bg-hover', '--text-primary', '--text-secondary', '--text-muted',
    '--accent', '--accent-light', '--accent-dark', '--accent-strong', '--on-accent', '--on-accent-strong', '--accent-glow', '--border', '--border-light',
    '--success', '--warning', '--danger', '--color-scheme']);

function createThemesClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createThemesClient: pass a client from openvibe-sdk/core');
    const call = (opts, o = {}) => client.json({ service: 'network', baseUrl, ...opts, signal: o.signal });
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const once = { idempotencyKey: false };
    return {
        /** query: mode (dark | light), search, sort (downloads | rating), limit → { themes } */
        catalog: (query = {}, o = {}) => call({ path: '/api/themes', query }, o),
        /** → the theme ({ id, name, slug, mode, variables, tags, … }) or null */
        get: async (idOrSlug, o = {}) => { const d = await orNull(call({ path: `/api/themes/${enc(idOrSlug)}` }, o)); return d ? d.theme : null; },
        /** An openvibe-theme@1 file (import it elsewhere, or submit an edited copy), or null */
        export: (idOrSlug, o = {}) => orNull(call({ path: `/api/themes/${enc(idOrSlug)}/export` }, o)),
        /** The person's theme: { theme_id, custom_variables, display } ({ theme_id: null, guest: true } signed out) */
        active: (o = {}) => call({ path: '/api/themes/me/active' }, o),
        /** Save the person's theme everywhere; custom: their own overrides of its variables (colours, lengths, shadows) */
        set: (themeId, { custom = null } = {}, o = {}) => call({ method: 'PUT', path: '/api/themes/me', json: { theme_id: themeId, custom_variables: custom }, ...once }, o),
        /** motion auto | reduced, text 100 | 112 | 125, seasonal on | off → { display } (unknown values are dropped) */
        setDisplay: (patch = {}, o = {}) => call({ method: 'PUT', path: '/api/themes/me/display', json: cleanDisplay(patch), ...once }, o),
        /** query: date (YYYY-MM-DD) → { seasons: [{ id, name, theme, from, to }], now } */
        seasons: (query = {}, o = {}) => call({ path: '/api/themes/seasons', query }, o),
        /** The person's own submissions, with their review status */
        submissions: (o = {}) => call({ path: '/api/themes/me/submissions' }, o),
        /** Submit a theme ({ name, description?, mode, variables, tags? }): private to its author until approved */
        submit: (theme, o = {}) => call({ method: 'POST', path: '/api/themes', json: theme, ...once }, o),
        /** Submit an openvibe-theme@1 file */
        import: (file, o = {}) => call({ method: 'POST', path: '/api/themes/import', json: file, ...once }, o),
    };
}

function cleanDisplay(d = {}) {
    const out = {};
    for (const k of Object.keys(DISPLAY_OPTIONS)) if (d && DISPLAY_OPTIONS[k].includes(String(d[k]))) out[k] = String(d[k]);
    return out;
}

/** The season for a date ('MM-DD' ranges, both days included, may run over New Year), or null. */
function seasonOn(date, seasons) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return (seasons || []).find((s) => (s.from <= s.to ? md >= s.from && md <= s.to : md >= s.from || md <= s.to)) || null;
}

/** Readable text on a colour: near-black or white, whichever contrasts more (WCAG). null for a colour it cannot read. */
function onColor(c) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
    const lin = (i) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
    return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#0b0d10' : '#ffffff';
}

/** Paint a theme's variables (only --custom-properties) on an element, <html> by default; returns the element. */
function applyTheme(vars, { root } = {}) {
    const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
    if (!el || !vars || typeof vars !== 'object') return el;
    for (const [k, v] of Object.entries(vars)) if (k.startsWith('--') && v != null) el.style.setProperty(k, String(v));
    if (vars['--accent'] && !vars['--on-accent']) { const on = onColor(vars['--accent']); if (on) el.style.setProperty('--on-accent', on); }
    const scheme = vars['--color-scheme'];
    if (scheme === 'light' || scheme === 'dark') { el.style.colorScheme = scheme; el.setAttribute('data-theme-mode', scheme); }
    return el;
}

/**
 * The theme on screen now: { id, mode, tokens: { '--accent': '#…', … }, display: { motion, text, textScale, seasonal, calm },
 * season: { id } | null, seasonMark } — from <html> and the loader (window.OpenVibeThemeLoader) when the page has it.
 */
function readTheme({ root, names = TOKENS } = {}) {
    const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
    const L = typeof window !== 'undefined' ? window.OpenVibeThemeLoader : null;
    const tokens = {};
    if (el && typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(el);
        for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) tokens[n] = v; }
    }
    const raw = (L && L.display && typeof L.display.get === 'function') ? L.display.get() : {};
    const display = { motion: 'auto', text: '100', seasonal: 'on', scheme: 'manual', ...cleanDisplay(raw) };
    let reduced = false;
    try { reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { reduced = false; }
    return {
        id: el ? el.getAttribute('data-theme') : null,
        mode: (el && el.getAttribute('data-theme-mode')) || tokens['--color-scheme'] || 'dark',
        tokens,
        display: { ...display, textScale: Number(display.text) / 100, calm: display.motion === 'reduced' || reduced },
        season: el && el.getAttribute('data-ov-season') ? { id: el.getAttribute('data-ov-season') } : null,
        seasonMark: el ? el.getAttribute('data-ov-season-mark') : null,
    };
}

/** Call fn(readTheme()) now and on every theme, display or season change; returns stop(). */
function followTheme(fn, opts = {}) {
    if (typeof fn !== 'function') throw new TypeError('followTheme: pass a function');
    if (typeof window === 'undefined' || !window.addEventListener) { fn(readTheme(opts)); return () => {}; }
    let queued = false;
    const fire = () => { if (queued) return; queued = true; Promise.resolve().then(() => { queued = false; fn(readTheme(opts)); }); };
    const events = ['ov:theme', 'ov:display', 'ov:season'];
    events.forEach((e) => window.addEventListener(e, fire));
    const onStorage = (e) => { if (e.key === 'ov_theme' || e.key === 'ov_display') fire(); };
    window.addEventListener('storage', onStorage);
    let mo = null;
    try {
        mo = new MutationObserver(fire);
        mo.observe(opts.root || document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-mode', 'data-ov-season', 'data-ov-season-mark', 'data-ov-motion', 'data-ov-text'] });
    } catch { mo = null; }
    fn(readTheme(opts));
    return () => { events.forEach((e) => window.removeEventListener(e, fire)); window.removeEventListener('storage', onStorage); if (mo) mo.disconnect(); };
}

module.exports = { createThemesClient, followTheme, readTheme, applyTheme, seasonOn, onColor, DISPLAY_OPTIONS, TOKENS };
