'use strict';
/** Geo: the registry read without a token, only healthy nodes are candidates, the fastest measured beacon wins
 *  (best of the samples), and without any measurement nearest() falls back to preferRegion and says so. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createGeoClient } = require('../src/geo');

const node = (id, region, status = 'up') => ({ id, name: id, roles: ['edge-probe'], location: { region }, beacon: `https://${id}.test/beacon`, health: { status, checked_at: '2026-09-28T12:00:00Z' }, updated_at: '2026-09-28T12:00:00Z' });
const NODES = [node('oregon-1', 'us-west'), node('fra-1', 'eu-central'), node('sgp-1', 'ap-southeast', 'down'), node('nyc-1', 'us-east', 'degraded')];

async function registry() {
    return stubServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/nodes') {
            const role = u.searchParams.get('role');
            return send(res, 200, { nodes: role === 'gpu' ? [] : NODES, generated_at: '2026-09-28T12:00:00Z' });
        }
        return send(res, 404, {});
    });
}

// A fake fetch on real timers: each beacon answers after its node's latency; fra-1's first sample is slow (DNS + TLS).
function fakeNet(latency, { fail = new Set() } = {}) {
    const seen = {};
    return {
        fetch: async (url) => {
            const id = new URL(url).hostname.split('.')[0];
            seen[id] = (seen[id] || 0) + 1;
            if (fail.has(id)) throw new Error('blocked');
            await new Promise((r) => setTimeout(r, latency[id] + (id === 'fra-1' && seen[id] === 1 ? 200 : 0)));
            return { ok: false, status: 204 };
        },
        seen,
    };
}

run([
    ['nodes() reads the public registry without a token; nearest() measures and picks the fastest healthy node', async () => {
        const srv = await registry();
        const net = fakeNet({ 'oregon-1': 120, 'fra-1': 15, 'nyc-1': 60, 'sgp-1': 1 });
        const geo = createGeoClient(createClient({ token: 'secret', baseUrls: { network: srv.url } }), { fetch: net.fetch, samples: 3 });
        const all = await geo.nodes({ role: 'edge-probe' });
        assert.equal(all.length, 4);
        assert.equal(srv.requests[0].headers.authorization, undefined, 'the registry is public: no token is sent');
        assert.equal(new URL(srv.requests[0].url, 'http://x').searchParams.get('role'), 'edge-probe');
        const best = await geo.nearest({ role: 'edge-probe' });
        assert.deepEqual([best.node.id, best.measured], ['fra-1', true]);
        assert.ok(best.rtt_ms >= 14 && best.rtt_ms < 100, `best of the samples, not the slow first one: ${best.rtt_ms}`);
        assert.equal(net.seen['sgp-1'], undefined, 'a down node is never measured');
        const m = await geo.measure(all.slice(0, 2));
        assert.deepEqual(m.map((x) => x.node.id), ['fra-1', 'oregon-1']);
        assert.equal(await geo.nearest({ role: 'gpu' }), null, 'no node for the role');
        await srv.close();
    }],
    ['nothing measurable: preferRegion, then the first up node, marked measured: false', async () => {
        const srv = await registry();
        const net = fakeNet({}, { fail: new Set(['oregon-1', 'fra-1', 'nyc-1']) });
        const geo = createGeoClient(createClient({ baseUrls: { network: srv.url } }), { fetch: net.fetch, samples: 1 });
        assert.deepEqual(await geo.nearest({ preferRegion: 'us-east' }).then((r) => [r.node.id, r.measured, r.rtt_ms]), ['nyc-1', false, null]);
        assert.equal((await geo.nearest()).node.id, 'oregon-1');
        await srv.close();
    }],
]);
