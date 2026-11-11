'use strict';
/** openvibe-sdk/sso handoff: mint a ticket for a link, redeem an arrival before first paint. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { run, waitFor } = require('./helpers');
const { createSsoClient, stripHandoffParam, HANDOFF_PARAM } = require('../src/sso');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims) => { const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`; return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`; };
const session = (over = {}) => sign({ sub: 7, id: 7, username: 'ana', iss: ISS, aud: ['openvibe.network', 'openvibe.trade'], iat: now(), exp: now() + 600, ...over });

const TICKET = `ovh_${'t'.repeat(40)}`;
const USED_TICKET = `ovh_${'u'.repeat(40)}`;
const BAD_CODE_TICKET = `ovh_${'b'.repeat(40)}`;

// A stub Network: handoff tickets + redeem, the code exchange, the JWKS.
const net = { tickets: [], redeems: [] };
const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
        if (req.url === '/api/.well-known/jwks') return send(200, { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/api/v1/handoff/tickets') {
            net.tickets.push({ auth: req.headers.authorization, body });
            if (req.headers.authorization !== `Bearer ${net.session}`) return send(401, { error: 'Authentication required' });
            if (body.client_id === 'nope') return send(400, { error: 'invalid_request' });
            return send(200, { ticket: TICKET, expires_at: new Date(Date.now() + 60000).toISOString(), expires_in: 60, client_id: body.client_id });
        }
        if (req.url === '/api/v1/handoff/redeem') {
            net.redeems.push(body);
            if (body.client_secret !== 'secret') return send(401, { error: 'invalid_client' });
            if (body.ticket === TICKET && body.client_id === 'trade') return send(200, { code: 'handoff-code', expires_in: 300 });
            if (body.ticket === BAD_CODE_TICKET) return send(200, { code: 'bad-code', expires_in: 300 });
            return send(400, { error: 'invalid_grant', error_description: 'Unknown or used handoff ticket' });
        }
        if (req.url === '/oauth/token') {
            if (body.client_secret !== 'secret') return send(401, { error: 'invalid_client' });
            if (body.grant_type === 'authorization_code' && body.code === 'handoff-code') {
                return send(200, { access_token: session(), refresh_token: 'rt_handoff', token_type: 'Bearer' });
            }
            return send(400, { error: 'invalid_grant' });
        }
        return send(404, {});
    });
});

function fakeRes() {
    const r = { cookies: {}, cleared: [], statusCode: 200 };
    r.cookie = (k, v, o) => { r.cookies[k] = { v, o }; return r; };
    r.clearCookie = (k) => { r.cleared.push(k); return r; };
    r.redirect = (u) => { r.statusCode = 302; r.location = u; return r; };
    r.status = (s) => { r.statusCode = s; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.send = (b) => { r.body = b; return r; };
    r.type = (t) => { r.contentType = t; return r; };
    r.set = (k, v) => { (r.headers = r.headers || {})[k] = v; return r; };
    return r;
}
const cookieHeader = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
const silent = { warn() {}, error() {}, info() {} };

let sso, base;
run([
    ['handoff param name and strip helper', async () => {
        assert.equal(HANDOFF_PARAM, 'ov_handoff');
        assert.equal(stripHandoffParam('/deals?a=1&ov_handoff=ovh_x#h'), '/deals?a=1#h');
        assert.equal(stripHandoffParam('/deals?ov_handoff=ovh_x'), '/deals');
        assert.equal(stripHandoffParam('/'), '/');
        assert.equal(stripHandoffParam(null), '/');
    }],

    ['mint: 401 without a session, 400 without a destination', async () => {
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
        net.session = session();
        sso = createSsoClient({ site: 'trade', baseUrl: 'https://openvibe.trade', clientId: 'trade', clientSecret: 'secret', networkUrl: ISS, networkInternalUrl: base, issuer: ISS, log: silent });
        let res = fakeRes();
        await sso.handlers.handoffMint({ headers: {}, body: { client_id: 'news', redirect_uri: 'https://openvibe.news/auth/callback' } }, res);
        assert.equal(res.statusCode, 401, 'no session mints nothing');
        res = fakeRes();
        await sso.handlers.handoffMint({ headers: { cookie: cookieHeader({ ov_token: net.session }) }, body: {} }, res);
        assert.equal(res.statusCode, 400, 'no destination is refused');
    }],

    ['mint: forwards the person and the destination, returns the ticket', async () => {
        const res = fakeRes();
        await sso.handlers.handoffMint({ headers: { cookie: cookieHeader({ ov_token: net.session }) }, body: { client_id: 'news', redirect_uri: 'https://openvibe.news/auth/callback' } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.ticket, TICKET);
        assert.equal(res.body.expires_in, 60);
        assert.equal(net.tickets.at(-1).auth, `Bearer ${net.session}`, 'the person’s own token proves the mint');
        assert.equal(net.tickets.at(-1).body.client_id, 'news');
    }],

    ['mint: the Network refusing or silent is a 4xx or 502, never a ticket', async () => {
        let res = fakeRes();
        await sso.handlers.handoffMint({ headers: { cookie: cookieHeader({ ov_token: net.session }) }, body: { client_id: 'nope', redirect_uri: 'https://x.example/cb' } }, res);
        assert.equal(res.statusCode, 400, 'the Network’s refusal is passed through');
        const down = createSsoClient({ site: 'trade', baseUrl: 'https://openvibe.trade', clientId: 'trade', clientSecret: 'secret', networkUrl: 'http://127.0.0.1:1', networkInternalUrl: 'http://127.0.0.1:1', issuer: ISS, log: silent, publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) });
        res = fakeRes();
        await down.handlers.handoffMint({ headers: { cookie: cookieHeader({ ov_token: net.session }) }, body: { client_id: 'news', redirect_uri: 'https://openvibe.news/auth/callback' } }, res);
        assert.equal(res.statusCode, 502, 'an unreachable Network is a 502');
    }],

    ['arrival: no ticket, a bad ticket, a guest, or a live session all pass through untouched', async () => {
        const before = net.redeems.length;
        for (const req of [
            { method: 'GET', query: {}, headers: {}, url: '/deals' },
            { method: 'GET', query: { ov_handoff: 'not-a-ticket' }, headers: {}, url: '/deals?ov_handoff=not-a-ticket' },
            { method: 'GET', query: { ov_handoff: TICKET }, headers: { cookie: cookieHeader({ ov_sso_hint: 'guest' }) }, url: '/' },
            { method: 'GET', query: { ov_handoff: TICKET }, headers: { cookie: cookieHeader({ ov_token: net.session }) }, url: '/' },
            { method: 'POST', query: { ov_handoff: TICKET }, headers: {}, url: '/' },
        ]) {
            let nexted = false;
            const res = fakeRes();
            sso.handoff()(req, res, () => { nexted = true; });
            await waitFor(() => nexted || res.location !== undefined, { timeoutMs: 30000 });
            assert.ok(nexted, `passes through: ${req.url} ${JSON.stringify(req.headers)}`);
            assert.equal(res.location, undefined, 'no redirect when passing through');
        }
        assert.equal(net.redeems.length, before, 'no redeem call for any pass-through');
    }],

    ['arrival: a good ticket signs the browser in and scrubs the address bar', async () => {
        const res = fakeRes();
        let nexted = false;
        sso.handoff()({ method: 'GET', query: { ov_handoff: TICKET }, headers: {}, url: '/deals?a=1&ov_handoff=xx' }, res, () => { nexted = true; });
        await waitFor(() => nexted || res.location !== undefined, { timeoutMs: 30000 });
        assert.equal(nexted, false);
        assert.equal(res.statusCode, 302);
        assert.equal(res.location, '/deals?a=1', 'the ticket leaves the address bar, the rest stays');
        assert.ok(res.cookies.ov_token && res.cookies.ov_token.v.length > 100, 'a session is set');
        assert.equal(res.cookies.ov_sso_hint.v, 'account');
        assert.equal(net.redeems.at(-1).client_id, 'trade', 'redeemed as this site’s own client');
    }],

    ['arrival: a refused or broken handoff renders as a guest on a clean URL', async () => {
        for (const ticket of [USED_TICKET, BAD_CODE_TICKET]) {
            const res = fakeRes();
            let nexted = false;
            sso.handoff()({ method: 'GET', query: { ov_handoff: ticket }, headers: {}, url: `/?ov_handoff=${ticket}` }, res, () => { nexted = true; });
            await waitFor(() => nexted || res.location !== undefined, { timeoutMs: 30000 });
            assert.equal(nexted, false);
            assert.equal(res.location, '/', 'the ticket is scrubbed even on failure');
            assert.equal(res.cookies.ov_token, undefined, 'no session on failure');
        }
        server.close();
    }],
    ['the ESM subpath exports the public handoff helpers', async () => {
        const esm = await import('../esm/sso.mjs');
        assert.equal(esm.HANDOFF_PARAM, 'ov_handoff');
        assert.equal(esm.stripHandoffParam('/deals?ov_handoff=ovh_x&sort=top#list'), '/deals?sort=top#list');
    }],
]);
