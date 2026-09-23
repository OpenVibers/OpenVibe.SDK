'use strict';
/**
 * openvibe-sdk/realtime: the browser realtime plane inside OpenVibe.Events (ADR-005), over SSE.
 *
 *   const sub = subscribe(['live.stream.*'], (event, { seq }) => { … }, {
 *       client,                      // or url: 'https://events.openvibe.network'
 *       lastEventId: savedSeq,       // resume after a reload
 *       onGap: (gap) => refetchState(),
 *   });
 *   sub.close();
 *
 * Transport: EventSource when the environment has one and no Bearer token is needed (cookies ride
 * along with withCredentials); otherwise fetch with a streamed body (Node, or a token). Either
 * way it resumes from the last seq it saw (Last-Event-ID), skips anything it already delivered,
 * and reports an `event: gap` (events missed beyond retention or replay limits) through onGap.
 * Browser-safe.
 */
const { OpenVibeError } = require('./core/errors');

const DEFAULT_ORIGIN = 'https://events.openvibe.network';
const FATAL = new Set([400, 401, 403, 404]);
const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function subscribe(topics, onEvent, opts = {}) {
    const list = (Array.isArray(topics) ? topics : String(topics).split(',')).map((t) => String(t).trim()).filter(Boolean);
    if (!list.length) throw new TypeError('subscribe: at least one topic pattern');
    if (typeof onEvent !== 'function') throw new TypeError('subscribe: onEvent must be a function');
    const {
        client, url, baseUrl, lastEventId = null, onGap, onOpen, onError, token, getToken,
        withCredentials = true, transport = 'auto', reconnectDelayMs = 3000, maxReconnectDelayMs = 30000,
    } = opts;
    const fetchImpl = opts.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    const ES = opts.EventSource !== undefined ? opts.EventSource : globalThis.EventSource;

    const state = { lastSeq: lastEventId != null && lastEventId !== '' ? Number(lastEventId) : null, closed: false, transport: null, connected: false };
    const stop = new AbortController();
    let es = null;
    let retryMs = reconnectDelayMs;
    let failures = 0;

    const report = (err) => { if (onError) { try { onError(err); } catch { /* the error hook must not break the loop */ } } };

    function dispatch(type, data, id) {
        if (type === 'gap') {
            let gap = null;
            try { gap = JSON.parse(data); } catch { gap = { reason: 'unknown' }; }
            if (onGap) { try { onGap(gap); } catch (err) { report(err); } }
            return;
        }
        if (type !== 'message' || !data) return;
        let msg;
        try { msg = JSON.parse(data); } catch { report(new OpenVibeError({ code: 'sdk.bad_response', message: 'realtime: undecodable message' })); return; }
        const seq = Number(id !== undefined && id !== '' ? id : msg && msg.seq);
        if (Number.isFinite(seq)) {
            if (state.lastSeq != null && seq <= state.lastSeq) return;      // already delivered
            state.lastSeq = seq;
        }
        try { onEvent(msg && msg.event, { seq }); } catch (err) { report(err); }
    }

    async function streamUrl() {
        let base = url || baseUrl;
        if (!base && client) {
            try { base = await client.origin('events'); } catch { base = DEFAULT_ORIGIN; }
        }
        base = String(base || DEFAULT_ORIGIN).replace(/\/+$/, '');
        const u = new URL(base.endsWith('/realtime/stream') ? base : `${base}/realtime/stream`);
        u.searchParams.set('topics', list.join(','));
        return u;
    }

    // A Bearer token: given here, or the client's own (a service token client, a user JWT).
    const clientAuth = client && client.options && (client.options.token || client.options.getToken) ? client.options : null;
    async function bearer() {
        if (token) return token;
        const fn = getToken || (clientAuth && clientAuth.getToken);
        if (fn) return fn({ service: 'events', audience: client ? client.audienceOf('events') : 'openvibe.events' });
        return clientAuth ? clientAuth.token : null;
    }

    // ── fetch transport ─────────────────────────────────────
    async function runFetch() {
        if (!fetchImpl) throw new TypeError('realtime: no fetch available');
        const u = await streamUrl();
        while (!state.closed) {
            const ctrl = new AbortController();
            const abort = () => ctrl.abort();
            stop.signal.addEventListener('abort', abort, { once: true });
            try {
                const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
                if (state.lastSeq != null) headers['Last-Event-ID'] = String(state.lastSeq);
                const t = await bearer();
                if (t) headers.Authorization = `Bearer ${t}`;
                const init = { headers, signal: ctrl.signal, cache: 'no-store' };
                if (withCredentials) init.credentials = 'include';
                const res = await fetchImpl(u.toString(), init);
                if (!res.ok) {
                    const body = await res.text().catch(() => '');
                    let parsed = body;
                    try { parsed = JSON.parse(body); } catch { /* text */ }
                    const err = OpenVibeError.fromResponse({ status: res.status, body: parsed, method: 'GET', url: u.toString(), retryable: !FATAL.has(res.status) });
                    report(err);
                    if (FATAL.has(res.status)) { state.closed = true; return; }
                } else {
                    failures = 0;
                    state.connected = true;
                    if (onOpen) { try { onOpen(); } catch (err) { report(err); } }
                    await readSse(res.body, dispatch, (ms) => { retryMs = ms; });
                    state.connected = false;
                }
            } catch (err) {
                state.connected = false;
                if (state.closed) return;
                report(err && err.name === 'OpenVibeError' ? err : new OpenVibeError({ code: 'sdk.network_error', retryable: true, message: `realtime: ${err && err.message}`, cause: err }));
            } finally {
                stop.signal.removeEventListener('abort', abort);
            }
            if (state.closed) return;
            failures++;
            await sleep(Math.min(maxReconnectDelayMs, retryMs * 2 ** Math.max(0, failures - 1)), stop.signal);
        }
    }

    // ── EventSource transport ───────────────────────────────
    async function runEventSource() {
        const u = await streamUrl();
        const open = () => {
            if (state.closed) return;
            const target = new URL(u.toString());
            if (state.lastSeq != null) target.searchParams.set('last_event_id', String(state.lastSeq));
            es = new ES(target.toString(), { withCredentials });
            es.onopen = () => { failures = 0; state.connected = true; if (onOpen) { try { onOpen(); } catch (err) { report(err); } } };
            es.onmessage = (m) => dispatch('message', m.data, m.lastEventId);
            es.addEventListener('gap', (m) => dispatch('gap', m.data));
            es.onerror = () => {
                state.connected = false;
                // CONNECTING (0): the browser reconnects by itself and sends Last-Event-ID.
                // CLOSED (2): it gave up (HTTP error); reconnect ourselves from the last seq.
                if (es.readyState === 2 && !state.closed) {
                    report(new OpenVibeError({ code: 'sdk.network_error', retryable: true, message: 'realtime: stream closed' }));
                    failures++;
                    sleep(Math.min(maxReconnectDelayMs, reconnectDelayMs * 2 ** Math.max(0, failures - 1)), stop.signal).then(open);
                }
            };
        };
        open();
    }

    const needsHeader = Boolean(token || getToken || clientAuth);
    const useEs = transport === 'eventsource' || (transport === 'auto' && typeof ES === 'function' && !needsHeader);
    state.transport = useEs ? 'eventsource' : 'fetch';
    const done = (useEs ? runEventSource() : runFetch()).catch((err) => { report(err); });

    return {
        close() {
            state.closed = true;
            stop.abort();
            if (es) { try { es.close(); } catch { /* already closed */ } }
        },
        get lastEventId() { return state.lastSeq; },
        get transport() { return state.transport; },
        get connected() { return state.connected; },
        get closed() { return state.closed; },
        /** Resolves when the fetch loop has ended (after close() or a fatal error). */
        done,
    };
}

/**
 * parseSSE(body, { onRetry }) -> async iterator of { event, data, id } (WHATWG event-stream rules).
 *
 *   for await (const { event, data, id } of parseSSE(res.body)) { … }
 *
 * `body` is a ReadableStream<Uint8Array> (fetch), or any async iterable of Uint8Array/string chunks
 * (a Node stream). `event` defaults to 'message'; `id` is the id field of that event (undefined when
 * it had none); comments are skipped; `retry: <ms>` is passed to onRetry. A line split across chunks,
 * including a \r\n pair, is reassembled. Breaking out of the loop releases the stream.
 */
async function* parseSSE(body, { onRetry } = {}) {
    if (!body || (typeof body.getReader !== 'function' && typeof body[Symbol.asyncIterator] !== 'function')) {
        throw new TypeError('parseSSE: pass a ReadableStream or an async iterable body');
    }
    const decoder = new TextDecoder();
    let buf = '';
    let type = '';
    let data = [];
    let id;
    const out = [];
    const line = (l) => {
        if (l === '') {
            if (data.length || type) out.push({ event: type || 'message', data: data.join('\n'), id });
            type = ''; data = []; id = undefined;
            return;
        }
        if (l[0] === ':') return;
        const i = l.indexOf(':');
        const field = i < 0 ? l : l.slice(0, i);
        let value = i < 0 ? '' : l.slice(i + 1);
        if (value[0] === ' ') value = value.slice(1);
        if (field === 'event') type = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id' && !value.includes('\0')) id = value;
        else if (field === 'retry' && /^\d+$/.test(value) && onRetry) onRetry(Number(value));
    };
    const reader = typeof body.getReader === 'function' ? body.getReader() : null;
    const iter = reader ? null : body[Symbol.asyncIterator]();
    try {
        for (;;) {
            const { value, done } = reader ? await reader.read() : await iter.next();
            if (done) break;
            buf += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
            let m;
            while ((m = /\r\n|\r|\n/.exec(buf))) {
                if (m[0] === '\r' && m.index === buf.length - 1) break;   // a \r\n may be split across chunks
                line(buf.slice(0, m.index));
                buf = buf.slice(m.index + m[0].length);
            }
            while (out.length) yield out.shift();
        }
    } finally {
        if (reader) {
            try { await reader.cancel(); } catch { /* stream already gone */ }
            try { reader.releaseLock(); } catch { /* already released */ }
        } else if (iter && typeof iter.return === 'function') {
            try { await iter.return(); } catch { /* already closed */ }
        }
    }
}

/** The realtime loop's reader: every parsed event goes to dispatch(type, data, id). */
async function readSse(body, dispatch, onRetry) {
    for await (const e of parseSSE(body, { onRetry })) dispatch(e.event, e.data, e.id);
}

function createRealtimeClient(client, defaults = {}) {
    return { subscribe: (topics, onEvent, opts = {}) => subscribe(topics, onEvent, { client, ...defaults, ...opts }) };
}

module.exports = { subscribe, createRealtimeClient, parseSSE, DEFAULT_ORIGIN };
