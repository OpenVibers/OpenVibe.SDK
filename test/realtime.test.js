'use strict';
/** Realtime SSE: resume from Last-Event-ID after a drop, dedupe, gap callback, transports. */
const assert = require('node:assert/strict');
const { stubServer, run, waitFor } = require('./helpers');
const { subscribe, createRealtimeClient, parseSSE } = require('../src/realtime');
const { createClient } = require('../src/core');
const { createMockPlatform } = require('../src/testing');

const frame = (seq, type = 'live.stream.started') => `id: ${seq}\ndata: ${JSON.stringify({ seq, event: { event_type: type, event_id: `e${seq}` } })}\n\n`;

run([
    ['resumes with Last-Event-ID after a drop, skips repeats, reports the gap', async () => {
        const connections = [];
        const srv = await stubServer((req, res) => {
            connections.push({ lastEventId: req.headers['last-event-id'], url: req.url, auth: req.headers.authorization });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (connections.length === 1) {
                res.write('retry: 10\n: connected\n\n');
                res.write(frame(1));
                res.write(frame(2).slice(0, 10));              // a frame split across chunks
                setTimeout(() => { res.write(frame(2).slice(10)); res.end(); }, 20);   // then the server drops us
            } else {
                res.write('retry: 10\n\n');
                res.write(frame(2));                            // replayed again: must not be delivered twice
                res.write(`event: gap\ndata: ${JSON.stringify({ reason: 'retention', from_seq: 3, to_seq: 4, latest_seq: 5 })}\n\n`);
                res.write(frame(5));
            }
        });
        const got = [];
        const gaps = [];
        let opens = 0;
        const sub = subscribe(['live.stream.*', 'network.notification.*'], (event, { seq }) => got.push([seq, event.event_id]), {
            url: srv.url, token: 'user-jwt', onGap: (g) => gaps.push(g), onOpen: () => opens++, reconnectDelayMs: 10,
        });
        assert.equal(sub.transport, 'fetch');
        await waitFor(() => got.length === 3);
        assert.deepEqual(got, [[1, 'e1'], [2, 'e2'], [5, 'e5']]);
        assert.deepEqual(gaps, [{ reason: 'retention', from_seq: 3, to_seq: 4, latest_seq: 5 }]);
        assert.equal(connections[0].lastEventId, undefined);
        assert.equal(connections[1].lastEventId, '2');
        assert.equal(connections[0].auth, 'Bearer user-jwt');
        assert.equal(new URL(connections[0].url, 'http://x').searchParams.get('topics'), 'live.stream.*,network.notification.*');
        assert.equal(sub.lastEventId, 5);
        assert.equal(opens, 2);
        sub.close();
        await sub.done;
        await srv.close();
    }],

    ['starts from a saved lastEventId; stops on a fatal 401', async () => {
        const srv = await stubServer((req, res) => {
            res.writeHead(401, { 'Content-Type': 'application/problem+json' });
            res.end(JSON.stringify({ status: 401, code: 'token.bad_signature', detail: 'bad', type: 't', title: 'x' }));
        });
        const errors = [];
        const sub = subscribe('live.*', () => {}, { url: `${srv.url}/realtime/stream`, lastEventId: 41, onError: (e) => errors.push(e), reconnectDelayMs: 10 });
        await sub.done;
        assert.equal(srv.requests[0].headers['last-event-id'], '41');
        assert.ok(srv.requests[0].url.startsWith('/realtime/stream?topics=live.*'));
        assert.equal(errors[0].code, 'token.bad_signature');
        assert.equal(sub.closed, true);
        assert.equal(srv.requests.length, 1, 'no reconnect loop on 401');
        await srv.close();
    }],

    ['EventSource transport: withCredentials, last_event_id, gap events, manual reconnect when CLOSED', async () => {
        const made = [];
        class FakeES {
            constructor(url, init) { this.url = url; this.init = init; this.readyState = 0; this.listeners = {}; made.push(this); }
            addEventListener(type, fn) { this.listeners[type] = fn; }
            close() { this.readyState = 2; this.closedByClient = true; }
        }
        const got = [];
        const gaps = [];
        const sub = subscribe(['live.stream.*'], (event, { seq }) => got.push(seq), { url: 'https://events.example', EventSource: FakeES, onGap: (g) => gaps.push(g), reconnectDelayMs: 5 });
        await waitFor(() => made.length === 1);
        assert.equal(sub.transport, 'eventsource');
        const es = made[0];
        assert.deepEqual(es.init, { withCredentials: true });
        assert.equal(new URL(es.url).searchParams.get('last_event_id'), null);
        es.onopen();
        es.onmessage({ data: JSON.stringify({ seq: 7, event: { event_type: 'live.stream.started' } }), lastEventId: '7' });
        es.onmessage({ data: JSON.stringify({ seq: 7, event: {} }), lastEventId: '7' });
        es.listeners.gap({ data: JSON.stringify({ reason: 'replay_limit', from_seq: 8, to_seq: 9 }) });
        assert.deepEqual(got, [7]);
        assert.equal(gaps[0].reason, 'replay_limit');
        es.readyState = 2;
        es.onerror();
        await waitFor(() => made.length === 2);
        assert.equal(new URL(made[1].url).searchParams.get('last_event_id'), '7');
        sub.close();
        assert.equal(made[1].closedByClient, true);
    }],

    ['against the mock platform: the client finds Events, replays, and follows live events', async () => {
        const platform = createMockPlatform({ realtimeRetryMs: 10 });
        const client = createClient({ fetch: platform.fetch });
        const pub = (type, visibility = 'public') => platform.publishEvent({ event_type: type, source: 'live', visibility, actor: { type: 'service', id: 'live' }, subject: { type: 'stream', id: '1' } });
        pub('live.stream.started');
        pub('live.stream.internal', 'internal');
        pub('live.stream.updated');
        const got = [];
        const realtime = createRealtimeClient(client, { fetch: platform.fetch, reconnectDelayMs: 10 });
        const sub = realtime.subscribe('live.stream.*', (event, { seq }) => got.push([seq, event.event_type]), { lastEventId: 0 });
        await waitFor(() => got.length === 2);
        assert.deepEqual(got, [[1, 'live.stream.started'], [3, 'live.stream.updated']], 'internal events never reach an anonymous browser');
        pub('live.stream.ended');
        await waitFor(() => got.length === 3);
        platform.dropRealtime();
        pub('live.stream.started');
        await waitFor(() => got.length === 4);
        assert.deepEqual(got.map((g) => g[0]), [1, 3, 4, 5]);
        const reconnect = platform.stats.requests.filter((r) => r.url.includes('/realtime/stream')).at(-1);
        assert.equal(reconnect.headers['last-event-id'], '4');
        sub.close();
        await sub.done;
    }],

    ['parseSSE: WHATWG fields, comments, multi-line data, CRLF split across chunks, retry, async iterables', async () => {
        const chunks = [': hello\r', '\nretry: 1500\r\nid: 7\r\nevent: job.progress\r\ndata: {"a":', '1}\r\n\r', '\ndata: line one\ndata: line two\n\nevent: ping\n\nid: 9\ndata:no-space\n\n'];
        const body = new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
        const retries = [];
        const got = [];
        for await (const m of parseSSE(body, { onRetry: (ms) => retries.push(ms) })) got.push(m);
        assert.deepEqual(retries, [1500]);
        assert.deepEqual(got, [
            { event: 'job.progress', data: '{"a":1}', id: '7' },
            { event: 'message', data: 'line one\nline two', id: undefined },
            { event: 'ping', data: '', id: undefined },
            { event: 'message', data: 'no-space', id: '9' },
        ]);
        async function* strings() { yield 'data: a\n'; yield '\ndata: b\n\n'; }
        const fromIterable = [];
        for await (const m of parseSSE(strings())) fromIterable.push(m.data);
        assert.deepEqual(fromIterable, ['a', 'b']);
        await assert.rejects(parseSSE(null).next(), TypeError);
    }],

    ['parseSSE: breaking out cancels the underlying stream', async () => {
        let cancelled = false;
        const body = new ReadableStream({
            pull(c) { c.enqueue(new TextEncoder().encode('data: x\n\n')); },
            cancel() { cancelled = true; },
        });
        for await (const m of parseSSE(body)) { assert.equal(m.data, 'x'); break; }
        assert.equal(cancelled, true);
    }],
]);
