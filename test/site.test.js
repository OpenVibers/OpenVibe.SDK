'use strict';
/**
 * openvibe-sdk/site: the pieces every site copied (the consolidation review of 2026-11-16). The checks are the sites'
 * own (Food's auth-jwks, Chat's iso-times, Help's link-header, Casino's agent-twins), run against the one copy here.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { run } = require('./helpers');
const site = require('../src/site');

function jwksServer(doc) {
    const seen = [];
    const srv = http.createServer((req, res) => {
        seen.push(req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(doc));
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => srv.close(r)),
    })));
}
function signJwt(claims, privateKey, kid) {
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

run([
    ['createKeyStore: a token signed by the stub JWKS key verifies; a bad one gives a public reason; the log carries the site name', async () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwks = await jwksServer({ keys: [{ ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'k1' }] });
        const warned = [];
        const log = { ...quiet, warn: (...a) => warned.push(a.join(' ')) };
        const config = { networkInternalUrl: jwks.url, networkIssuer: 'https://openvibe.network' };
        const keys = site.createKeyStore({ config, name: 'OpenVibe.Test', log });
        await keys.ensure();
        assert.ok(keys.loaded() && /BEGIN PUBLIC KEY/.test(keys.get()));
        const now = Math.floor(Date.now() / 1000);
        const good = signJwt({ iss: config.networkIssuer, sub: 'usr_demo', username: 'demo', aud: ['openvibe.network'], iat: now, exp: now + 300 }, privateKey, 'k1');
        const v = await keys.verifyUser(good, { issuer: config.networkIssuer, audience: 'openvibe.network' });
        assert.equal(v.ok, true, v.reason);
        assert.equal(v.claims.username, 'demo');
        const bad = await keys.verifyUser(good.slice(0, -4) + 'AAAA', { issuer: config.networkIssuer, audience: 'openvibe.network' });
        assert.equal(bad.ok, false);
        assert.equal(typeof bad.reason, 'string');
        assert.ok(warned.some((w) => w.startsWith('[OpenVibe.Test] user token rejected')), warned.join('\n'));
        assert.ok(/BEGIN PUBLIC KEY/.test(await keys.pemForToken(good)));
        assert.deepEqual([...new Set(jwks.seen)], ['/api/.well-known/jwks']);
        await jwks.close();
    }],

    ['jwksUrl reads both config shapes; publicReason never passes on a key-fetch error', async () => {
        assert.equal(site.jwksUrl({ networkInternalUrl: 'http://n:1/', networkUrl: 'https://x' }), 'http://n:1/api/.well-known/jwks');
        assert.equal(site.jwksUrl({ networkUrl: 'https://openvibe.network' }), 'https://openvibe.network/api/.well-known/jwks');
        assert.equal(site.jwksUrl({ network: { internalUrl: 'http://127.0.0.1:4100', url: 'https://x' } }), 'http://127.0.0.1:4100/api/.well-known/jwks');
        assert.throws(() => site.jwksUrl({}), /names no Network URL/);
        assert.equal(site.publicReason({ code: 'token.no_key', message: 'fetch http://internal failed' }), site.KEY_UNAVAILABLE);
        assert.equal(site.publicReason(new Error('x')), site.DOES_NOT_VERIFY);
        assert.equal(site.publicReason({ code: 'token.expired', message: 'token expired' }), 'token expired');
    }],

    ['asyncRouter: a rejected async handler reaches next(err); error handlers and sync handlers are untouched', async () => {
        const routes = {};
        const fake = {};
        for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) fake[m] = (path, ...hs) => { routes[`${m} ${path}`] = hs; return fake; };
        const r = site.asyncRouter(fake);
        const boom = new Error('boom');
        r.get('/a', async () => { throw boom; });
        r.put('/b', () => { throw boom; });
        const errorHandler = (err, req, res, next) => next(err);
        r.post('/c', errorHandler);
        const got = await new Promise((resolve) => routes['get /a'][0]({}, {}, resolve));
        assert.equal(got, boom);
        assert.equal(await new Promise((resolve) => routes['put /b'][0]({}, {}, resolve)), boom);
        assert.equal(routes['post /c'][0], errorHandler);
        assert.throws(() => site.asyncRouter({}), /express\.Router/);
        const made = site.asyncRouter({ express: { Router: () => ({ ...fake }) } }, { methods: ['get'] });
        assert.equal(typeof made.get, 'function');
    }],

    ['linksOf: a head naming its twin and llms.txt gives the Link header; one that names neither gives none', async () => {
        const head = '<html><head><link rel="alternate" type="text/markdown" href="https://x.test/a.md"><link rel="describedby" href="https://x.test/llms.txt"></head><body></body></html>';
        assert.equal(site.linksOf(head), '<https://x.test/a.md>; rel="alternate"; type="text/markdown", <https://x.test/llms.txt>; rel="describedby"');
        assert.equal(site.linksOf('<html><head></head></html>'), null);
        const res = { statusCode: 200, headers: {}, get(k) { return this.headers[k.toLowerCase()]; }, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, send(b) { this.body = b; return this; } };
        res.headers['content-type'] = 'text/html; charset=utf-8';
        site.linkHeader()({ method: 'GET' }, res, () => {});
        res.send(head);
        assert.match(res.headers.link, /rel="describedby"/);
    }],

    ['openapi: the routes an app mounts become the document, with summaries from the API files\' header comments', async () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovsite-')), 'api.js');
        fs.writeFileSync(file, '/**\n *   GET /things/:id   One thing, by its id\n */\n');
        const nested = { stack: [{ route: { path: '/things/:id', methods: { get: true } } }] };
        const app = { _router: { stack: [
            { route: { path: '/api/health', methods: { get: true } } },
            { regexp: Object.assign(/^\/api\/v1\/?(?=\/|$)/i, { fast_slash: false }), keys: [], handle: nested },
        ] } };
        let body = null;
        const handler = site.openapiRoute(app, { title: 'Test', version: '1.2.3', baseUrl: 'https://x.test/', docs: 'https://x.test/developers', files: [file] });
        handler({}, { set() { return this; }, json(d) { body = d; } });
        assert.equal(body.openapi, '3.1.0');
        assert.deepEqual(Object.keys(body.paths), ['/api/v1/things/{id}']);
        assert.equal(body.paths['/api/v1/things/{id}'].get.summary, 'One thing, by its id');
        assert.equal(body.servers[0].url, 'https://x.test');
    }],

    ['iso times: Chat\'s cases (stored text ↔ ISO, only time-named fields, internal routes untouched)', async () => {
        assert.equal(site.storedTime('2026-11-12T10:00:05.123Z'), '2026-11-12 10:00:05');
        assert.equal(site.storedTime('2026-11-12T12:00:05+02:00'), '2026-11-12 10:00:05');
        assert.equal(site.storedTime('not a time'), null);
        assert.equal(site.isoTime('2026-11-12 05:01:02'), '2026-11-12T05:01:02Z');
        assert.equal(site.isoTime('2026-11-12'), '2026-11-12');
        assert.deepEqual(site.normalizeTimes({ created_at: '2026-11-12 05:01:02', when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12 05:01:02' } }),
            { created_at: '2026-11-12T05:01:02Z', when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12T05:01:02Z' } });
        let sent = null;
        const res = { json: (b) => { sent = b; } };
        site.isoJsonTimes({ path: '/api/x' }, res, () => {});
        res.json({ updated_at: '2026-11-12 05:01:02' });
        assert.equal(sent.updated_at, '2026-11-12T05:01:02Z');
        const internal = { json: (b) => { sent = b; } };
        site.isoJsonTimes({ path: '/internal/x' }, internal, () => {});
        internal.json({ updated_at: '2026-11-12 05:01:02' });
        assert.equal(sent.updated_at, '2026-11-12 05:01:02');
    }],

    ['createTwins: a public page renders its twin signed out; a page outside the pattern has none; express and the agent layer are required', async () => {
        assert.throws(() => site.createTwins({}), /paths must be the RegExp/);
        const t = site.createTwins({ paths: /^\/(?:docs)?$/ });
        assert.throws(() => t.mountTwins({}, {}), /pass \{ express, agentLayer \}/);
        const router = { handle(req, res, next) { if (req.path === '/docs') { res.status(200); res.send(`<html><head></head><body>docs for ${req.viewer.kind}</body></html>`); } else next(); } };
        assert.equal(await t.renderWithRouter(router, '/docs', 'x.test'), '<html><head></head><body>docs for anonymous</body></html>');
        assert.equal(await t.renderWithRouter(router, '/nope', 'x.test'), null);
        // mountTwins with stand-ins: the agent layer receives a render that answers only for the site's pattern
        let render = null;
        const used = [];
        const twins = site.createTwins({
            paths: /^\/(?:docs)?$/,
            express: { Router: () => Object.assign((req, res, next) => next(), { use() {} }) },
            agentLayer: { mount: (_r, o) => { render = o.render; }, linkHeaderTags: (u, l) => ({ head: `<link rel="alternate" type="text/markdown" href="${u}.md">`, header: `<${u}.md>; rel="alternate"; ${l}` }) },
        });
        twins.mountTwins({ use: (fn) => used.push(fn) }, { router, descriptor: {}, baseUrl: 'https://x.test/' });
        assert.equal(used.length, 2);
        assert.equal((await render('/docs')).html.includes('docs for anonymous'), true);
        assert.equal(await render('/elsewhere'), null);
    }],
]);
