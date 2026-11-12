'use strict';
// openvibe-sdk/frame: any app mounts the network's shared navbar, footer, shipped line and themes,
// with its own session endpoints; server-rendered apps get the same markup as strings.
const assert = require('node:assert/strict');
const { mountFrame, frameTags, frameConfig, scriptUrls, online, createFrameClient } = require('../src/frame');
const { createClient } = require('../src/core');
const { stubServer, send } = require('./helpers');

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
    const frameEsm = await import('../esm/frame.mjs');
    assert.equal(typeof frameEsm.online, 'function', 'the frame ESM subpath exports the online reader');

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

    // The online read: the footer strip's data, asked for this site so its own items come back.
    {
        const calls = [];
        const answer = { members: 3, guests: 4, total: 7, people: [], more: 0, live: null, counts: [], items: [], sites: 56, views_7d: 1200 };
        const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => answer }; };
        assert.deepEqual(await online({ site: 'live', fetch: fakeFetch }), answer);
        assert.equal(calls[0].url, 'https://openvibe.network/api/frame/online?site=live');
        assert.equal(calls[0].init.credentials, 'omit');
        assert.equal(calls[0].init.headers.accept, 'application/json');
        await online({ site: 'not a site!', fetch: fakeFetch });
        assert.equal(calls[1].url, 'https://openvibe.network/api/frame/online', 'an invalid id asks as no site, never in the query');
        await online({ base: 'https://openvibe.network/', site: 'games', fetch: fakeFetch });
        assert.equal(calls[2].url, 'https://openvibe.network/api/frame/online?site=games');
        await assert.rejects(() => online({ fetch: async () => ({ ok: false, status: 503 }) }), /answered 503/);
        await assert.rejects(() => online({ fetch: null }), /needs a fetch/, 'no fetch: a clear error');
        await assert.rejects(() => online({ base: 'http://evil.example', fetch: fakeFetch }), /https origin/);
    }

    // The Frame's data client: the same calls the composer makes, with the person's token.
    {
        const sheet = { task: 'chat', recommended: { model: 'openai/gpt-5-mini', source: 'openvibe' }, choice: { model: 'openai/gpt-5-mini', source: 'openvibe' }, adult: false, groups: [{ id: 'openvibe', title: 'OpenVibe', rows: [{ model: 'openai/gpt-5-mini', source: 'openvibe', name: 'GPT-5 Mini', maker: 'openai', price: null, free: false }] }] };
        const srv = await stubServer((req, res) => {
            const u = new URL(req.url, 'http://x');
            if (u.pathname === '/api/frame/choices') return send(res, 200, sheet);
            if (u.pathname === '/api/frame/query/providers') return send(res, 200, { providers: [{ provider: 'deepseek' }] });
            if (u.pathname === '/api/frame/query') return send(res, 200, { results: [{ title: 'A', url: 'https://example.org/a' }], groups: { web: 1 }, citations: [], route: { cost_usd: 0 }, next_cursor: null });
            if (u.pathname === '/api/frame/ask') return send(res, 202, { run: 'run_x' });
            if (u.pathname === '/api/v1/runs/run_x/events') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                return res.end('id: 1\nevent: RUN_FINISHED\ndata: {"type":"RUN_FINISHED"}\n\n');
            }
            return send(res, 404, {});
        });
        try {
            const frame = createFrameClient(createClient({ baseUrls: { network: srv.url }, token: 'person-token' }));
            assert.deepEqual(await frame.choices('chat'), sheet);
            const found = await frame.query('surf maps', { scopes: ['web', 'openvibe'], depth: 'deep', limit: 5 });
            assert.equal(found.results[0].title, 'A');
            assert.deepEqual(await frame.providers(), { providers: [{ provider: 'deepseek' }] });
            assert.deepEqual(await frame.ask({ text: 'What is it?', sources: ['web'], depth: 'balanced' }), { run: 'run_x' });
            const events = [];
            for await (const ev of frame.events('run_x')) events.push(ev.event);
            assert.deepEqual(events, ['RUN_FINISHED']);
            const hits = srv.requests.map((r) => ({ method: r.method, url: r.url, auth: r.headers.authorization, body: r.body.toString() }));
            assert.equal(hits[0].url, '/api/frame/choices?task=chat');
            assert.equal(hits[0].auth, 'Bearer person-token');
            assert.match(hits[1].url, /^\/api\/frame\/query\?q=surf\+maps&scopes=web%2Copenvibe&depth=deep&limit=5$/);
            assert.equal(hits[2].url, '/api/frame/query/providers');
            assert.equal(hits[3].method, 'POST');
            assert.equal(hits[3].url, '/api/frame/ask');
            assert.match(hits[3].body, /"text":"What is it\?"/);
            assert.throws(() => createFrameClient(null), /SDK client/);
            const f = createFrameClient(createClient({ baseUrls: { network: srv.url } }));
            await assert.rejects(() => f.choices('unreal'), /task is/);
            await assert.rejects(() => f.query(1), /string/);
            await assert.rejects(() => f.ask({}), /text is required/);
        } finally { await srv.close(); }
    }

    console.log('frame: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
