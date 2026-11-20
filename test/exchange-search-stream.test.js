'use strict';
// exchange.search with stream: true (OpenVibe.AI search v2's Server-Sent Events, sources first): the named events in
// order however the network splits them, the request asks for an event stream with stream: true in the body, a plain
// search still answers JSON, and a refusal before the stream opens throws an ExchangeError.
const assert = require('node:assert/strict');
const { createExchangeClient, ExchangeError } = require('../src/exchange');

const SSE = 'event: results\ndata: {"stage":"first","results":[{"url":"https://a.example/"}]}\n\n'
    + 'event: results\ndata: {"stage":"merged","results":[{"url":"https://a.example/"},{"url":"https://b.example/"}]}\n\n'
    + 'event: answer\ndata: {"answer":{"text":"Yes [1]."}}\n\n'
    + 'event: done\ndata: {"results":[],"receipt":{"engine":"multi","cost_usd":0.001}}\n\n';

(async () => {
    const calls = [];
    let mode = 'sse';
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), accept: init.headers.Accept || init.headers.accept, body: JSON.parse(init.body) });
        if (mode === 'refuse') return new Response(JSON.stringify({ detail: 'depth must be one of instant, fast, standard, deep' }), { status: 422, headers: { 'content-type': 'application/json' } });
        if (mode === 'json') return new Response(JSON.stringify({ results: [{ url: 'https://a.example/' }], receipt: { engine: 'multi' } }), { status: 200, headers: { 'content-type': 'application/json' } });
        const enc = new TextEncoder();
        const parts = [SSE.slice(0, 25), SSE.slice(25, 140), SSE.slice(140)];
        return new Response(new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const exchange = createExchangeClient({ developerKey: 'test', maxRetries: 0, fetchImpl });

    const events = [];
    const stream = await exchange.search('louvre opening hours', { depth: 'standard', output: 'answer', stream: true });
    const it = stream[Symbol.asyncIterator]();
    let step = await it.next();
    while (!step.done) { events.push(step.value); step = await it.next(); }
    assert.deepEqual(events.map((e) => (e.data.stage ? `${e.event}:${e.data.stage}` : e.event)), ['results:first', 'results:merged', 'answer', 'done']);
    assert.equal(events[2].data.answer.text, 'Yes [1].');
    assert.ok(calls[0].url.endsWith('/v1/search'));
    assert.equal(calls[0].accept, 'text/event-stream');
    assert.deepEqual([calls[0].body.q, calls[0].body.stream, calls[0].body.depth], ['louvre opening hours', true, 'standard']);

    mode = 'json';
    const whole = await exchange.search('louvre');
    assert.equal(whole.receipt.engine, 'multi', 'a plain search still answers the whole result');
    assert.equal(calls[1].accept, 'application/json');

    mode = 'refuse';
    await assert.rejects(exchange.search('x', { depth: 'bottomless', stream: true }), (err) => err instanceof ExchangeError && err.status === 422);
    console.log('exchange-search-stream: 3 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
