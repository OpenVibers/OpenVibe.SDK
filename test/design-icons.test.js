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
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(calls[0].init.body).styles, ['thin', 'solid']);
    assert.equal(JSON.parse(calls[0].init.body).sourceSvg, '<path d="M5 12h14"/>');
    assert.match(calls[1].url, /\/api\/v1\/glyphs\/hot-tub\?style=duotone$/);
    assert.match(calls[2].url, /\/api\/v1\/glyphs\/search\?q=hot%20tub&limit=5$/);
    await assert.rejects(client.icons.get('bad name'), TypeError);
    const esm = await import('../esm/index.mjs');
    assert.equal(typeof esm.design.createDesignClient, 'function', 'the ESM root exposes the Design client');
    const designEsm = await import('../esm/design.mjs');
    const esmClient = designEsm.createDesignClient({ accessToken: 'test-token', fetchImpl: async () => ({ ok: true, async json() { return {}; } }) });
    await esmClient.icons.get('heart', { style: 'bold' });
    console.log('Design SDK icons: draft, get and search use the authenticated glyph API');
})().catch((err) => { console.error(err); process.exit(1); });
