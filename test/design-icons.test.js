'use strict';
const assert = require('node:assert/strict');
const { createDesignClient } = require('../src/design');

(async () => {
    const calls = [];
    const client = createDesignClient({ accessToken: 'test-token', fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return { ok: true, async json() { return { glyphs: [], kept: [], refused: [] }; } };
    } });
    await client.icons.draft({ name: 'hot-tub', styles: ['thin', 'solid'], sourceSvg: '<path d="M5 12h14"/>' });
    await client.icons.get('hot-tub', { style: 'duotone' });
    await client.icons.search('hot tub', { limit: 5 });
    await client.icons.suggest('Deep dive', { context: 'a menu', limit: 5, rank: true });
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(calls[0].init.body).styles, ['thin', 'solid']);
    assert.equal(JSON.parse(calls[0].init.body).sourceSvg, '<path d="M5 12h14"/>');
    assert.match(calls[1].url, /\/api\/v1\/glyphs\/hot-tub\?style=duotone$/);
    assert.match(calls[2].url, /\/api\/v1\/glyphs\/search\?q=hot%20tub&limit=5$/);
    assert.match(calls[3].url, /\/api\/v1\/glyphs\/suggest\?label=Deep%20dive&limit=5&context=a%20menu&rank=1$/);
    assert.equal(calls[3].init.headers.authorization, 'Bearer test-token', 'a signed-in suggestion is ranked on the person allowance');
    await assert.rejects(client.icons.get('bad name'), TypeError);
    await assert.rejects(client.icons.suggest('  '), TypeError);
    const esm = await import('../esm/index.mjs');
    assert.equal(typeof esm.design.createDesignClient, 'function', 'the ESM root exposes the Design client');
    // suggest, get and search are public: no token, no Authorization header.
    const pubCalls = [];
    const pub = createDesignClient({ fetchImpl: async (url, init) => { pubCalls.push({ url: String(url), init }); return { ok: true, async json() { return { glyphs: [] }; } }; } });
    await pub.icons.suggest('go live');
    await pub.icons.get('heart');
    await pub.icons.search('gear');
    assert.ok(pubCalls.every((c) => !c.init.headers.authorization), 'public glyph calls carry no token');
    await assert.rejects(pub.icons.draft({ name: 'hot-tub' }), /needs accessToken/);
    const designEsm = await import('../esm/design.mjs');
    const esmClient = designEsm.createDesignClient({ accessToken: 'test-token', fetchImpl: async () => ({ ok: true, async json() { return {}; } }) });
    await esmClient.icons.get('heart', { style: 'bold' });
    console.log('Design SDK icons: draft uses the authenticated API; suggest, get and search are public');
})().catch((err) => { console.error(err); process.exit(1); });
