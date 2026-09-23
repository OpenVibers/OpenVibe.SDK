'use strict';
/** Client-credentials token client: caching, concurrent sharing, refresh window, audiences, errors. */
const assert = require('node:assert/strict');
const { stubServer, send, run, sleep } = require('./helpers');
const { createServiceTokenClient } = require('../src/auth');
const { createClient } = require('../src/core');

async function tokenServer() {
    let issued = 0;
    const srv = await stubServer(async (req, res, body) => {
        if (req.url !== '/oauth/token') return send(res, 404, { error: 'nope' });
        const p = new URLSearchParams(body.toString());
        if (p.get('client_secret') !== 'shh') return send(res, 401, { error: 'invalid_client', error_description: 'Invalid client credentials' });
        await sleep(20);
        issued++;
        send(res, 200, { access_token: `t${issued}:${p.get('audience')}:${p.get('scope') || ''}`, token_type: 'Bearer', expires_in: 300, scope: p.get('scope') || '' }, { 'Cache-Control': 'no-store' });
    });
    return { srv, issued: () => issued };
}

run([
    ['POSTs client_credentials with audience and scope, caches the token', async () => {
        const { srv, issued } = await tokenServer();
        const tokens = createServiceTokenClient({ network: srv.url, clientId: 'live', clientSecret: 'shh', audience: 'openvibe.events', scope: ['events.event.publish', 'events.event.read'] });
        const t = await tokens.getToken();
        assert.equal(t, 't1:openvibe.events:events.event.publish events.event.read');
        const p = new URLSearchParams(srv.requests[0].body.toString());
        assert.equal(p.get('grant_type'), 'client_credentials');
        assert.equal(p.get('client_id'), 'live');
        assert.equal(srv.requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
        assert.equal(await tokens.getToken(), t);
        assert.deepEqual(await tokens.authHeaders(), { Authorization: `Bearer ${t}` });
        assert.equal(issued(), 1);
        await srv.close();
    }],

    ['concurrent callers share one in-flight request', async () => {
        const { srv, issued } = await tokenServer();
        const tokens = createServiceTokenClient({ tokenUrl: `${srv.url}/oauth/token`, clientId: 'live', clientSecret: 'shh', audience: 'openvibe.network' });
        const all = await Promise.all(Array.from({ length: 8 }, () => tokens.getToken()));
        assert.equal(new Set(all).size, 1);
        assert.equal(issued(), 1);
        await srv.close();
    }],

    ['refreshes 60 s before expiry; invalidate() forces a new token', async () => {
        const { srv, issued } = await tokenServer();
        let clock = 1_000_000;
        const tokens = createServiceTokenClient({ network: srv.url, clientId: 'live', clientSecret: 'shh', audience: 'openvibe.network', now: () => clock });
        const a = await tokens.getToken();
        clock += 239_000;                        // 61 s left: still fresh
        assert.equal(await tokens.getToken(), a);
        clock += 2_000;                          // 59 s left: refresh
        const b = await tokens.getToken();
        assert.notEqual(b, a);
        tokens.invalidate();
        const c = await tokens.getToken();
        assert.notEqual(c, b);
        assert.equal(issued(), 3);
        await srv.close();
    }],

    ['one cache entry per audience (and per-audience scope map)', async () => {
        const { srv, issued } = await tokenServer();
        const tokens = createServiceTokenClient({ network: srv.url, clientId: 'live', clientSecret: 'shh', scope: { 'openvibe.media': 'media.object.upload' } });
        const m = await tokens.getToken({ audience: 'openvibe.media' });
        const e = await tokens.getToken({ audience: 'openvibe.events' });
        assert.match(m, /:openvibe\.media:media\.object\.upload$/);
        assert.match(e, /:openvibe\.events:$/);
        assert.equal(await tokens.getToken({ audience: 'openvibe.media' }), m);
        tokens.invalidate({ audience: 'openvibe.media' });
        assert.notEqual(await tokens.getToken({ audience: 'openvibe.media' }), m);
        assert.equal(await tokens.getToken({ audience: 'openvibe.events' }), e);
        assert.equal(issued(), 3);
        await assert.rejects(createServiceTokenClient({ network: srv.url, clientId: 'x', clientSecret: 'y' }).getToken(), TypeError);
        await srv.close();
    }],

    ['a refused client is an OpenVibeError; a failed fetch is not cached', async () => {
        const { srv } = await tokenServer();
        const bad = createServiceTokenClient({ network: srv.url, clientId: 'live', clientSecret: 'wrong', audience: 'openvibe.network' });
        await assert.rejects(bad.getToken(), (err) => err.name === 'OpenVibeError' && err.code === 'invalid_client' && err.status === 401);
        await assert.rejects(bad.getToken());
        assert.equal(srv.requests.length, 2);
        await srv.close();
    }],

    ['plugged into createClient: each service gets a token for its own audience', async () => {
        const { srv } = await tokenServer();
        const api = await stubServer((req, res) => send(res, 200, { auth: req.headers.authorization }));
        const tokens = createServiceTokenClient({ network: srv.url, clientId: 'live', clientSecret: 'shh' });
        const client = createClient({ baseUrls: { media: api.url, events: api.url }, tokenProvider: tokens });
        assert.match((await client.json({ service: 'media', path: '/' })).auth, /^Bearer t\d:openvibe\.media:/);
        assert.match((await client.json({ service: 'events', path: '/' })).auth, /^Bearer t\d:openvibe\.events:/);
        await srv.close();
        await api.close();
    }],
]);
