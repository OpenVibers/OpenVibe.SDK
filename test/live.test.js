'use strict';
// openvibe-sdk/live: OpenVibe.Live's documented routes (discovery, channels, slots, going live, sessions, the content
// feeds) through a real core client against a local stub, and the WHIP exchange: an SDP offer in, the answer and an
// absolute Location out, Live's JSON error code on a refusal, and the client's own token never sent to /whip.
const assert = require('assert');
const http = require('http');
const { createClient } = require('../src/core');
const { createLiveClient } = require('../src/live');

(async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, type: req.headers['content-type'] || null, idem: req.headers['idempotency-key'] || null, body });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url.startsWith('/whip/')) {
                if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
                if (req.url === '/whip/bad-key') { res.writeHead(401, { 'Content-Type': 'application/json', 'X-WHIP-ERROR': 'invalid_stream_key' }); return res.end(JSON.stringify({ error: 'Stream key not recognised', code: 'invalid_stream_key' })); }
                res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/whip/session/abc' });
                return res.end('v=0\r\no=answer\r\n');
            }
            if (req.method === 'POST' && req.url === '/api/streams') return json(201, { stream: { id: 77 }, endpoint: { whipUrlBase: 'x' } });
            // A slot's profile: Live's own ingest (5), OpenRestream's (6), and one with no WHIP address (7).
            if (req.url === '/api/streams/managed/5/profile') return json(200, { managed_stream: { id: 5 }, stream_key: 'sk_live_5', whip_url_base: 'https://whip.example.test/', rtmp_url: 'rtmp://x/live' });
            if (req.url === '/api/streams/managed/6/profile') return json(200, { managed_stream: { id: 6 }, stream_key: null, whip_url_base: null, ingest_authority: 'openre', whip_url: 'https://openre.example.test/whip/k6' });
            if (req.url === '/api/streams/managed/7/profile') return json(200, { managed_stream: { id: 7 }, stream_key: 'sk_live_7', whip_url_base: null });
            return json(200, { ok: true });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = createClient({ baseUrls: { live: base }, token: 'person-token', retries: 2 });
    const live = createLiveClient(client);
    const last = () => seen[seen.length - 1];

    try {
        // Discovery and channels.
        await live.streams.list();
        await live.streams.get(12);
        await live.streams.recentlyOnline();
        await live.channels.get('@goosely');
        await live.content.feed({ type: 'vods', sort: 'new', cursor: 'abc', limit: 30 });
        await live.content.moments({ window: 'week' });
        assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), [
            'GET /api/streams', 'GET /api/streams/12', 'GET /api/streams/recently-online', 'GET /api/streams/channel/goosely',
            'GET /api/content/feed?type=vods&sort=new&cursor=abc&limit=30', 'GET /api/content/moments?window=week',
        ]);
        assert.ok(seen.every((s) => s.auth === 'Bearer person-token'), 'the person\'s token rides along (Live checks the issuer)');
        assert.strictEqual(await live.channels.url('goosely'), `${base}/@goosely`);
        assert.throws(() => live.channels.get('no spaces'), /username/);
        assert.throws(() => live.streams.get('12; DROP'), /number/);

        // Slots, going live, the session.
        seen.length = 0;
        await live.slots.list();
        await live.slots.create({ title: 'Robot cam', streaming_method: 'whip' });
        await live.slots.update(5, { browser_mode: 'screen' });
        await live.slots.regenerateKey(5);
        const went = await live.goLive(5, { title: 'Live now' });
        await live.streams.endpoint(77);
        await live.streams.update(77, { title: 'Still live' });
        await live.streams.heartbeat(77);
        await live.streams.end(77);
        await live.slots.remove(5);
        assert.deepStrictEqual(went, { stream: { id: 77 }, endpoint: { whipUrlBase: 'x' } });
        assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), [
            'GET /api/streams/managed', 'POST /api/streams/managed', 'PUT /api/streams/managed/5', 'POST /api/streams/managed/5/regenerate-key',
            'POST /api/streams', 'GET /api/streams/77/endpoint', 'PUT /api/streams/77', 'POST /api/streams/77/heartbeat', 'DELETE /api/streams/77',
            'DELETE /api/streams/managed/5',
        ]);
        assert.deepStrictEqual(JSON.parse(seen[4].body), { title: 'Live now', managed_stream_id: 5 });
        assert.ok(seen.filter((s) => s.method !== 'GET').every((s) => !s.idem), 'writes carry no idempotency key and are never retried');

        // WHIP: the offer, the answer, the Location; the key as bearer only when given; never the client's token.
        seen.length = 0;
        const url = await live.whip.url('sk_live_123');
        assert.strictEqual(url, `${base}/whip/sk_live_123`);
        const session = await live.whip.publish(live.whip.url('sk_live_123'), 'v=0\r\no=offer\r\n');
        assert.deepStrictEqual(session, { answer: 'v=0\r\no=answer\r\n', location: `${base}/whip/session/abc` });
        assert.deepStrictEqual([last().method, last().type, last().auth, last().body], ['POST', 'application/sdp', null, 'v=0\r\no=offer\r\n']);
        await live.whip.publish(`${base}/whip/5`, 'v=0', { key: 'sk_live_123' });
        assert.strictEqual(last().auth, 'Bearer sk_live_123', 'a slot-id URL sends the key as the bearer');
        await live.whip.end(session.location);
        assert.deepStrictEqual([last().method, last().url, last().auth], ['DELETE', '/whip/session/abc', null]);
        await assert.rejects(live.whip.publish(live.whip.url('bad-key'), 'v=0'), (err) => err.status === 401 && err.code === 'invalid_stream_key');
        assert.strictEqual(seen.filter((s) => s.url === '/whip/bad-key').length, 1, 'a refused offer is not retried');
        await assert.rejects(live.whip.url('../x'), /stream key/);

        // A slot's profile and where it publishes.
        seen.length = 0;
        const prof = await live.slots.profile(5);
        assert.strictEqual(prof.stream_key, 'sk_live_5');
        assert.strictEqual(last().url, '/api/streams/managed/5/profile');
        assert.deepStrictEqual(await live.whip.forSlot(5), { url: 'https://whip.example.test/whip/sk_live_5', key: 'sk_live_5', authority: 'live' });
        assert.deepStrictEqual(await live.whip.forSlot(6), { url: 'https://openre.example.test/whip/k6', key: null, authority: 'openre' });
        await assert.rejects(live.whip.forSlot(7), /no WHIP address/);
        assert.throws(() => live.slots.profile('5/../x'), /slot id/);

        assert.throws(() => createLiveClient({ json() {} }), /core client/);
        console.log('live: all checks passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
