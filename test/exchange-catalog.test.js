'use strict';
const assert = require('node:assert/strict');
const { createCatalogSearchClient, ExchangeError } = require('../src/exchange');

(async () => {
    let url;
    const client = createCatalogSearchClient({ fetchImpl: async (input, init) => {
        url = new URL(input);
        assert.equal(init.headers.Authorization, undefined);
        return new Response(JSON.stringify({ q: 'fast coder', count: 0, results: [], quality_unavailable: false }), { status: 200 });
    } });
    const result = await client.search('fast coder', { max_price: 1 });
    assert.equal(result.count, 0);
    assert.equal(url.pathname, '/api/v1/search');
    assert.equal(url.searchParams.get('max_price'), '1');
    assert.equal(url.searchParams.get('q'), 'fast coder');
    await assert.rejects(client.search(null), TypeError);
    const failing = createCatalogSearchClient({ fetchImpl: async () => new Response(JSON.stringify({ error: 'catalog_unavailable' }), { status: 503 }) });
    await assert.rejects(failing.search('vision'), (err) => err instanceof ExchangeError && err.status === 503);
    process.stdout.write('Exchange catalog reader passed\n');
})().catch((err) => { process.stderr.write(String(err.stack || err)); process.exitCode = 1; });
