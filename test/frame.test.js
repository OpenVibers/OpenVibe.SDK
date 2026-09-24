'use strict';
// openvibe-sdk/frame: any app mounts the network's shared navbar, footer, shipped line and themes,
// with its own session endpoints; server-rendered apps get the same markup as strings.
const assert = require('node:assert/strict');
const { mountFrame, frameTags, frameConfig, scriptUrls } = require('../src/frame');

const opts = {
    service: 'myapp',
    brand: { name: 'My App' },
    links: [{ label: 'Docs </script><script>alert(1)</script>', href: '/docs' }],
    menu: { before: [{ label: 'My projects', href: '/projects' }] },
    sessionUrl: '/auth/me', loginUrl: '/auth/login?next={path}', logoutUrl: '/auth/logout?next={path}',
    footer: { updates: '/updates' },
};

// Config mapping
const cfg = frameConfig(opts);
assert.equal(cfg.navbar.service, 'myapp');
assert.equal(cfg.navbar.apiBase, 'https://openvibe.network');
assert.equal(cfg.navbar.logoutUrl, '/auth/logout?next={path}');
assert.deepEqual(cfg.navbar.menu.before[0], { label: 'My projects', href: '/projects' });
assert.equal(cfg.footer.updates, '/updates');
assert.equal(cfg.footer.brandName, 'My App');
assert.equal(frameConfig({ footer: false }).footer, null);
assert.equal(frameConfig({ shipped: false }).footer.shipped, false);

// URLs and base validation
assert.equal(scriptUrls().navbar, 'https://openvibe.network/shared/navbar.js');
assert.equal(scriptUrls({ base: 'http://localhost:4000/' }).footer, 'http://localhost:4000/shared/footer.js');
assert.throws(() => scriptUrls({ base: 'http://evil.example' }), /https origin/);
assert.throws(() => scriptUrls({ base: 'javascript:alert(1)' }), /https origin/);

// SSR tags: the config cannot break out of its <script>
const t = frameTags(opts);
assert.ok(t.head.includes('https://openvibe.network/shared/navbar.js') && t.head.includes('theme-loader.js') && t.head.includes('footer.js'));
assert.equal(t.bodyStart, '<div id="navbar-mount"></div>');
assert.ok(t.bodyEnd.includes('<footer id="ov-footer"></footer>'));
assert.ok(!/<\/script><script>alert/.test(t.bodyEnd), 'a label cannot close the init script');
assert.equal((t.bodyEnd.match(/<\/script>/g) || []).length, 1);
assert.ok(!frameTags({ theme: false }).head.includes('theme-loader'));

// Browser mount with a minimal DOM: scripts "load", globals appear, init receives the config.
function fakeDom() {
    const inits = {};
    const win = {};
    const nodes = [];
    const el = (tag) => {
        const n = { tagName: tag.toUpperCase(), id: '', dataset: {}, attrs: {}, listeners: {}, children: [],
            setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
            appendChild(c) { this.children.push(c); nodes.push(c); if (c.tagName === 'SCRIPT') setImmediate(() => {
                if (c.src.endsWith('navbar.js')) win.OpenVibeNavbar = { init: (x) => { inits.navbar = x; } };
                if (c.src.endsWith('footer.js')) win.OpenVibeFooter = { init: (x) => { inits.footer = x; } };
                (c.listeners.load || []).forEach((f) => f());
            }); return c; },
            insertBefore(c) { nodes.push(c); return c; } };
        return n;
    };
    const doc = {
        head: el('head'), body: el('body'), documentElement: el('html'),
        createElement: el,
        getElementById: (id) => nodes.find((n) => n.id === id) || null,
        querySelector: (sel) => sel.startsWith('#') ? nodes.find((n) => n.id === sel.slice(1)) || null : nodes.find((n) => n.tagName === 'SCRIPT' && sel.includes(n.src)) || null,
    };
    doc.body.firstChild = null;
    return { doc, win, inits, nodes };
}

(async () => {
    const d = fakeDom();
    const r = await mountFrame({ ...opts, document: d.doc, window: d.win });
    assert.ok(r.navbar && r.footer);
    assert.equal(d.inits.navbar.sessionUrl, '/auth/me');
    assert.equal(d.inits.footer.mount, '#ov-footer');
    assert.ok(d.doc.getElementById('navbar-mount') && d.doc.getElementById('ov-footer'), 'mount points created');
    assert.deepEqual(d.nodes.filter((n) => n.tagName === 'SCRIPT').map((n) => n.src.split('/').pop()).sort(), ['footer.js', 'navbar.js', 'theme-loader.js']);

    // A failed load leaves that part null and never throws.
    const d2 = fakeDom();
    d2.doc.head.appendChild = function (c) { d2.nodes.push(c); setImmediate(() => (c.listeners.error || []).forEach((f) => f())); return c; };
    const r2 = await mountFrame({ document: d2.doc, window: d2.win });
    assert.deepEqual(r2, { navbar: null, footer: null });
    await assert.rejects(() => mountFrame({ document: null, window: null }), /browser/);
    console.log('frame: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
