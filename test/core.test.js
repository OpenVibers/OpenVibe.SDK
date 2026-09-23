'use strict';
/** Core client: retries, deadlines, idempotency keys, problem errors, traceparent, pagination. */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run, sleep } = require('./helpers');
const { createClient, OpenVibeError, isOpenVibeError, paginate, offsetPager, parseTraceparent } = require('../src/core');

const TP_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;
const fast = { retryDelayMs: 5, maxRetryDelayMs: 20 };

run([
    ['GET is retried on 503 with the same request id and traceparent', async () => {
        const srv = await stubServer((req, res, _b, n) => (n < 3 ? problem(res, 503, 'service.unavailable', 'busy') : send(res, 200, { ok: true })));
        const client = createClient({ baseUrls: { media: srv.url }, ...fast });
        const out = await client.request({ service: 'media', path: '/x' });
        assert.equal(out.data.ok, true);
        assert.equal(out.attempts, 3);
        assert.equal(srv.requests.length, 3);
        const ids = new Set(srv.requests.map((r) => r.headers['x-openvibe-request-id']));
        const tps = new Set(srv.requests.map((r) => r.headers.traceparent));
        assert.equal(ids.size, 1);
        assert.equal(tps.size, 1);
        assert.match([...tps][0], TP_RE);
        assert.equal(out.traceId, parseTraceparent([...tps][0]).traceId);
        assert.equal(srv.requests[0].headers['idempotency-key'], undefined, 'GET needs no key');
        await srv.close();
    }],

    ['a POST gets one Idempotency-Key and keeps it across retries', async () => {
        const srv = await stubServer((req, res, _b, n) => (n === 1 ? send(res, 502, 'bad gateway') : send(res, 201, { id: 7 })));
        const client = createClient({ baseUrls: { media: srv.url }, ...fast });
        const data = await client.json({ service: 'media', method: 'POST', path: '/x', json: { a: 1 } });
        assert.deepEqual(data, { id: 7 });
        assert.equal(srv.requests.length, 2);
        const k1 = srv.requests[0].headers['idempotency-key'];
        assert.match(k1, /^idem_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.equal(srv.requests[1].headers['idempotency-key'], k1);
        assert.equal(srv.requests[0].headers['content-type'], 'application/json');
        assert.equal(srv.requests[0].body.toString(), '{"a":1}');
        await srv.close();
    }],

    ['a caller-supplied key is sent as is and makes the mutation retryable', async () => {
        const srv = await stubServer((req, res, _b, n) => (n === 1 ? send(res, 503, '') : send(res, 200, { ok: 1 })));
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        await client.json({ service: 'x', method: 'POST', path: '/y', idempotencyKey: 'order-42' });
        assert.deepEqual(srv.requests.map((r) => r.headers['idempotency-key']), ['order-42', 'order-42']);
        await srv.close();
    }],

    ['idempotencyKey:false or retries:0 never repeats a mutation', async () => {
        const srv = await stubServer((req, res) => problem(res, 503, 'service.unavailable', 'busy'));
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        await assert.rejects(client.json({ service: 'x', method: 'POST', path: '/a', idempotencyKey: false }), (err) => {
            assert.ok(err instanceof OpenVibeError);
            assert.equal(err.status, 503);
            assert.equal(err.retryable, true);
            return true;
        });
        assert.equal(srv.requests.length, 1);
        assert.equal(srv.requests[0].headers['idempotency-key'], undefined);
        await assert.rejects(client.json({ service: 'x', method: 'PATCH', path: '/b', retries: 0 }));
        assert.equal(srv.requests.length, 2);
        assert.equal(srv.requests[1].headers['idempotency-key'], undefined);
        await srv.close();
    }],

    ['4xx is not retried', async () => {
        const srv = await stubServer((req, res) => problem(res, 400, 'bad.request', 'nope'));
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        await assert.rejects(client.json({ service: 'x', path: '/a' }), { status: 400, code: 'bad.request' });
        assert.equal(srv.requests.length, 1);
        await srv.close();
    }],

    ['Retry-After is honoured on 429', async () => {
        const srv = await stubServer((req, res, _b, n) => (n === 1 ? send(res, 429, { error: 'slow down' }, { 'Retry-After': '0' }) : send(res, 200, { ok: 1 })));
        const client = createClient({ baseUrls: { x: srv.url }, retryDelayMs: 5000 });
        const t0 = Date.now();
        await client.json({ service: 'x', path: '/a' });
        assert.ok(Date.now() - t0 < 1000, 'Retry-After: 0 beats the 5 s backoff');
        await srv.close();
    }],

    ['per-attempt timeout -> sdk.timeout; deadline bounds the whole call', async () => {
        const srv = await stubServer(async (req, res) => { await sleep(300); send(res, 200, { late: true }); });
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        await assert.rejects(client.json({ service: 'x', path: '/slow', timeoutMs: 50, retries: 0 }), (err) => {
            assert.equal(err.code, 'sdk.timeout');
            assert.equal(err.status, 0);
            assert.ok(err.requestId && err.traceId);
            return true;
        });
        const t0 = Date.now();
        await assert.rejects(client.json({ service: 'x', path: '/slow', timeoutMs: 50, retries: 10, deadlineMs: 180 }), (err) => ['sdk.timeout', 'sdk.deadline_exceeded'].includes(err.code));
        assert.ok(Date.now() - t0 < 400, `deadline held (${Date.now() - t0} ms)`);
        await srv.close();
    }],

    ['an abort signal stops the call without retries', async () => {
        const srv = await stubServer(async (req, res) => { await sleep(300); send(res, 200, {}); });
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 30);
        await assert.rejects(client.json({ service: 'x', path: '/a', signal: ctrl.signal }), { code: 'sdk.aborted' });
        assert.equal(srv.requests.length, 1);
        await srv.close();
    }],

    ['connection refused -> retried, then sdk.network_error', async () => {
        const srv = await stubServer((req, res) => send(res, 200, {}));
        const dead = srv.url;
        await srv.close();
        const client = createClient({ baseUrls: { x: dead }, ...fast });
        await assert.rejects(client.json({ service: 'x', path: '/a' }), (err) => err.code === 'sdk.network_error' && err.retryable === true);
    }],

    ['RFC 9457 problem -> OpenVibeError with code/status/detail/requestId/traceId', async () => {
        const srv = await stubServer((req, res) => problem(res, 403, 'capability.denied', 'not granted', { request_id: 'req_server123', trace_id: 'a'.repeat(32), errors: [{ path: '/x', message: 'bad' }] }));
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        const err = await client.json({ service: 'x', path: '/a' }).catch((e) => e);
        assert.ok(isOpenVibeError(err));
        assert.equal(err.code, 'capability.denied');
        assert.equal(err.status, 403);
        assert.equal(err.detail, 'not granted');
        assert.equal(err.requestId, 'req_server123');
        assert.equal(err.traceId, 'a'.repeat(32));
        assert.deepEqual(err.errors, [{ path: '/x', message: 'bad' }]);
        assert.equal(err.problem.code, 'capability.denied');
        assert.equal(err.toJSON().code, 'capability.denied');
        await srv.close();
    }],

    ['legacy { error } and OAuth errors map to stable codes', async () => {
        const srv = await stubServer((req, res) => (req.url === '/legacy' ? send(res, 404, { error: 'File not found' }) : send(res, 401, { error: 'invalid_client', error_description: 'Invalid client credentials' })));
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        const a = await client.json({ service: 'x', path: '/legacy' }).catch((e) => e);
        assert.equal(a.code, 'http.404');
        assert.equal(a.detail, 'File not found');
        assert.equal(a.problem, null);
        const b = await client.json({ service: 'x', path: '/oauth', auth: false }).catch((e) => e);
        assert.equal(b.code, 'invalid_client');
        assert.equal(b.detail, 'Invalid client credentials');
        await srv.close();
    }],

    ['traceparent: continue an incoming trace with a new span; start one otherwise', async () => {
        const srv = await stubServer((req, res) => send(res, 200, {}));
        const client = createClient({ baseUrls: { x: srv.url } });
        const incoming = `00-${'4bf92f3577b34da6a3ce929d0e0e4736'}-${'00f067aa0ba902b7'}-01`;
        await client.withContext({ traceparent: incoming, requestId: 'req_incoming_1' }).json({ service: 'x', path: '/a' });
        const sent = parseTraceparent(srv.requests[0].headers.traceparent);
        assert.equal(sent.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
        assert.notEqual(sent.parentId, '00f067aa0ba902b7');
        assert.equal(srv.requests[0].headers['x-openvibe-request-id'], 'req_incoming_1');

        await client.fromRequest({ headers: { traceparent: incoming } }).json({ service: 'x', path: '/b' });
        assert.equal(parseTraceparent(srv.requests[1].headers.traceparent).traceId, '4bf92f3577b34da6a3ce929d0e0e4736');

        await client.json({ service: 'x', path: '/c' });
        await client.json({ service: 'x', path: '/d' });
        const t3 = parseTraceparent(srv.requests[2].headers.traceparent).traceId;
        const t4 = parseTraceparent(srv.requests[3].headers.traceparent).traceId;
        assert.notEqual(t3, t4, 'unrelated calls start their own traces');
        assert.notEqual(t3, '4bf92f3577b34da6a3ce929d0e0e4736');

        const withGetter = createClient({ baseUrls: { x: srv.url }, traceparent: () => incoming });
        await withGetter.json({ service: 'x', path: '/e' });
        assert.equal(parseTraceparent(srv.requests[4].headers.traceparent).traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
        await srv.close();
    }],

    ['tokens: per-service audience, and a 401 refreshes the token once', async () => {
        let good = 'tok-2';
        const srv = await stubServer((req, res) => (req.headers.authorization === `Bearer ${good}` ? send(res, 200, { ok: 1 }) : problem(res, 401, 'token.expired', 'expired')));
        const seen = [];
        let n = 0;
        const provider = {
            getToken(ctx) { seen.push(ctx); n++; return `tok-${n}`; },
            invalidate(ctx) { seen.push({ invalidated: ctx.audience }); },
        };
        const client = createClient({ baseUrls: { media: srv.url }, tokenProvider: provider, ...fast });
        await client.json({ service: 'media', method: 'POST', path: '/a', idempotencyKey: false });
        assert.deepEqual(seen, [{ service: 'media', audience: 'openvibe.media' }, { invalidated: 'openvibe.media' }, { service: 'media', audience: 'openvibe.media' }]);
        assert.equal(srv.requests.length, 2);
        good = 'never';
        await assert.rejects(client.json({ service: 'media', path: '/b' }), { status: 401 });
        assert.equal(srv.requests.length, 4, 'only one refresh per call');
        const noAuth = await srv.requests.length;
        await client.json({ service: 'media', path: '/c', auth: false }).catch(() => null);
        assert.equal(srv.requests[noAuth].headers.authorization, undefined);
        await srv.close();
    }],

    ['query encoding, 204 bodies, unknown services', async () => {
        const srv = await stubServer((req, res) => (req.url.startsWith('/empty') ? send(res, 204, '') : send(res, 200, { url: req.url })));
        const client = createClient({ baseUrls: { x: `${srv.url}/` }, autoDiscover: false });
        const out = await client.json({ service: 'x', path: '/q', query: { a: 'b c', skip: undefined, no: null, list: ['x', 'y'], flag: true, off: false } });
        assert.equal(out.url, '/q?a=b+c&list=x%2Cy&flag=1');
        assert.equal(await client.json({ service: 'x', path: '/empty' }), null);
        await assert.rejects(client.json({ service: 'nope', path: '/' }), { code: 'sdk.unknown_service' });
        await srv.close();
    }],

    ['paginate + offsetPager walk every page and stop on a short one', async () => {
        const all = Array.from({ length: 23 }, (_, i) => i);
        const calls = [];
        const pager = offsetPager(async (offset, limit) => { calls.push(offset); return { items: all.slice(offset, offset + limit), total: all.length }; }, { limit: 10 });
        const got = [];
        for await (const x of paginate(pager, { cursor: 0 })) got.push(x);
        assert.deepEqual(got, all);
        assert.deepEqual(calls, [0, 10, 20]);
        const firstFive = [];
        for await (const x of paginate(pager, { cursor: 0, maxItems: 5 })) firstFive.push(x);
        assert.deepEqual(firstFive, [0, 1, 2, 3, 4]);
        const cursorPages = [];
        for await (const x of paginate(async (c) => ({ items: [c], next: c < 3 ? c + 1 : null }), { cursor: 1 })) cursorPages.push(x);
        assert.deepEqual(cursorPages, [1, 2, 3]);
    }],

    ["responseType 'response': the raw Response for streams and downloads; errors still throw", async () => {
        let busy = 0;
        const srv = await stubServer((req, res) => {
            if (req.url === '/busy' && ++busy === 1) return problem(res, 503, 'service.unavailable', 'busy');
            if (req.url === '/gone') return problem(res, 404, 'thing.not_found', 'no such thing');
            if (req.url === '/stream') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.write('part one;');
                return setTimeout(() => res.end('part two'), 30);
            }
            if (req.url === '/forever') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.write('start;'); }
            return send(res, 200, Buffer.from([1, 2, 3]), { 'Content-Type': 'application/octet-stream' });
        });
        const client = createClient({ baseUrls: { x: srv.url }, ...fast });
        const out = await client.request({ service: 'x', path: '/file', responseType: 'response' });
        assert.ok(out.data instanceof Response);
        assert.equal(out.response, out.data);
        assert.equal(out.status, 200);
        assert.ok(!out.data.bodyUsed, 'body unread');
        assert.deepEqual([...new Uint8Array(await out.data.arrayBuffer())], [1, 2, 3]);

        // The per-attempt timeout covers the headers only; the body may take longer.
        const slow = await client.json({ service: 'x', path: '/stream', responseType: 'response', timeoutMs: 15 });
        assert.equal(await slow.text(), 'part one;part two');

        const retried = await client.request({ service: 'x', path: '/busy', responseType: 'response' });
        assert.equal(retried.attempts, 2, 'a 503 is retried before any body is handed out');
        await assert.rejects(client.request({ service: 'x', path: '/gone', responseType: 'response' }), (e) => e.code === 'thing.not_found' && e.status === 404, 'error bodies are read into OpenVibeError');

        // The caller's signal still cancels the body after the call returned.
        const ctrl = new AbortController();
        const endless = await client.json({ service: 'x', path: '/forever', responseType: 'response', signal: ctrl.signal });
        const reader = endless.body.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), 'start;');
        setTimeout(() => ctrl.abort(), 10);
        await assert.rejects(reader.read());
        await srv.close();
    }],
]);
