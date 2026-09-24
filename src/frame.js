'use strict';

/**
 * openvibe-sdk/chrome — the OpenVibe network's shared chrome for any app: the universal navbar (one
 * account menu, notifications, the site switcher, sign in and out), the shared footer (network
 * links, legal links, the "shipped X ago" line and an Updates link), the "shipped" views and the
 * theme loader. These are the same files every OpenVibe site runs, served by OpenVibe.Network from
 * the published openvibe-shared release. No dependencies; nothing is bundled into your app.
 *
 * In the browser:
 *
 *   // mountChrome from the openvibe-sdk/chrome entry (CommonJS or ESM)
 *   const { navbar, footer } = await mountChrome({
 *       service: 'myapp',                                          // your app's id (brand + analytics)
 *       brand: { name: 'My App' },                                 // optional brand override
 *       links: [{ label: 'Home', href: '/' }, { label: 'Docs', href: '/docs' }],
 *       menu: { before: [{ label: 'My projects', href: '/projects', icon: 'fa-folder' }] },
 *       sessionUrl: '/auth/me',                                    // your server session ({ user }), optional
 *       loginUrl: '/auth/login?next={path}',                       // {url} full return URL, {path} local path
 *       logoutUrl: '/auth/logout?next={path}',                     // Sign out ends your session too
 *       footer: { links: [{ heading: 'My App', items: [{ name: 'About', url: '/about' }] }], updates: '/updates' },
 *   });
 *
 * Server-rendered apps put chromeTags(opts) in <head>/<body> instead (the same markup this module
 * would inject, as a string; the JSON config is escaped for a <script> element):
 *
 *   // chromeTags from the openvibe-sdk/chrome entry
 *   const t = chromeTags({ service: 'myapp', links: [...] });
 *   html = `<head>${t.head}</head><body>${t.bodyStart}…${t.bodyEnd}</body>`;
 *
 * Your CSP must allow `script-src https://openvibe.network` and `connect-src https://openvibe.network`
 * (the navbar asks /api/auth/me and the notifications there; the shipped line reads
 * /api/v1/changelog). Signed-in state comes from the shared ov_token, else from sessionUrl. For
 * your own users to be recognised across the network, sign them in with OpenVibe (openvibe-sdk/auth).
 * The chrome is progressive: if openvibe.network is unreachable your page still renders.
 */

const DEFAULT_BASE = 'https://openvibe.network';
const FILES = { theme: 'theme-loader.js', navbar: 'navbar.js', footer: 'footer.js', shipped: 'shipped.js' };

function baseOf(base) {
    const b = String(base || DEFAULT_BASE).replace(/\/+$/, '');
    const ok = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(b) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(b);
    if (!ok) throw new TypeError(`openvibe-sdk/chrome: base must be an https origin (or http://localhost for development), got ${base}`);
    return b;
}

/** The script URLs on a base: the release OpenVibe.Network currently serves at /shared/. */
function scriptUrls({ base } = {}) {
    const b = baseOf(base);
    const out = {};
    for (const [k, f] of Object.entries(FILES)) out[k] = `${b}/shared/${f}`;
    return out;
}

/** The navbar and footer configurations mountChrome passes to OpenVibeNavbar.init / OpenVibeFooter.init. */
function chromeConfig(opts = {}) {
    const o = opts || {};
    const b = baseOf(o.base);
    const navbar = {
        service: o.service || 'app',
        apiBase: b,
        ...(o.brand ? { brand: o.brand } : {}),
        ...(Array.isArray(o.links) ? { links: o.links } : {}),
        ...(o.menu ? { menu: o.menu } : {}),
        ...(o.sessionUrl ? { sessionUrl: o.sessionUrl } : {}),
        ...(o.loginUrl ? { loginUrl: o.loginUrl } : {}),
        ...(o.logoutUrl ? { logoutUrl: o.logoutUrl } : {}),
        ...(o.silentLogin ? { silentLogin: o.silentLogin } : {}),
        ...(o.navbar && typeof o.navbar === 'object' ? o.navbar : {}),
    };
    const footer = o.footer === false ? null : {
        service: o.service || 'app',
        mount: '#ov-footer',
        variant: 'full',
        apiBase: b,
        ...(o.brand && o.brand.name ? { brandName: o.brand.name } : {}),
        ...(o.shipped === false ? { shipped: false } : {}),
        ...(o.footer && typeof o.footer === 'object' ? o.footer : {}),
    };
    return { navbar, footer };
}

const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Markup for server-rendered pages: { head, bodyStart, bodyEnd } strings. */
function chromeTags(opts = {}) {
    const urls = scriptUrls(opts);
    const cfg = chromeConfig(opts);
    const head = [
        opts.theme === false ? '' : `<script src="${attr(urls.theme)}" defer></script>`,
        `<script src="${attr(urls.navbar)}" defer></script>`,
        cfg.footer ? `<script src="${attr(urls.footer)}" defer></script>` : '',
    ].filter(Boolean).join('\n');
    const bodyStart = '<div id="navbar-mount"></div>';
    const init = `document.addEventListener('DOMContentLoaded',function(){var c=${jsonForScript(cfg)};`
        + `try{if(window.OpenVibeNavbar)OpenVibeNavbar.init(c.navbar);}catch(e){}`
        + `try{if(c.footer&&window.OpenVibeFooter)OpenVibeFooter.init(c.footer);}catch(e){}});`;
    const bodyEnd = `${cfg.footer ? '<footer id="ov-footer"></footer>\n' : ''}<script>${init}</script>`;
    return { head, bodyStart, bodyEnd, config: cfg, urls };
}

function loadScript(doc, src) {
    return new Promise((resolve) => {
        const existing = doc.querySelector(`script[data-ov-chrome="${src}"]`);
        if (existing) { if (existing.dataset.loaded) resolve(true); else existing.addEventListener('load', () => resolve(true)); return; }
        const s = doc.createElement('script');
        s.src = src;
        s.async = true;
        s.setAttribute('data-ov-chrome', src);
        s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(true); });
        s.addEventListener('error', () => resolve(false));
        (doc.head || doc.documentElement).appendChild(s);
    });
}

/**
 * Browser: load the shared chrome and mount it. Resolves { navbar, footer } (the initialised
 * globals, or null for a part that could not load). Never throws for a network failure.
 */
async function mountChrome(opts = {}) {
    const doc = (opts && opts.document) || (typeof document !== 'undefined' ? document : null);
    const win = (opts && opts.window) || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) throw new Error('openvibe-sdk/chrome: mountChrome runs in a browser; use chromeTags() on the server');
    const urls = scriptUrls(opts);
    const cfg = chromeConfig(opts);
    if (!doc.getElementById('navbar-mount')) {
        const m = doc.createElement('div');
        m.id = 'navbar-mount';
        doc.body.insertBefore(m, doc.body.firstChild);
    }
    if (cfg.footer && !doc.querySelector(cfg.footer.mount)) {
        const f = doc.createElement('footer');
        f.id = String(cfg.footer.mount).replace(/^#/, '');
        doc.body.appendChild(f);
    }
    const loads = [];
    if (opts.theme !== false) loads.push(loadScript(doc, urls.theme));
    const navOk = loadScript(doc, urls.navbar);
    const footOk = cfg.footer ? loadScript(doc, urls.footer) : Promise.resolve(false);
    await Promise.all([...loads, navOk, footOk]);
    let navbar = null;
    let footer = null;
    try { if (win.OpenVibeNavbar) { win.OpenVibeNavbar.init(cfg.navbar); navbar = win.OpenVibeNavbar; } } catch { navbar = null; }
    try { if (cfg.footer && win.OpenVibeFooter) { win.OpenVibeFooter.init(cfg.footer); footer = win.OpenVibeFooter; } } catch { footer = null; }
    return { navbar, footer };
}

module.exports = { mountChrome, chromeTags, chromeConfig, scriptUrls, DEFAULT_BASE };
