'use strict';
/** The JWKS client: fresh keys, the last good ones through outages, backoff, rotation, a throttled unknown kid. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./helpers');
const { createJwksClient } = require('../src/auth/jwks');

const pub = (kid) => ({ ...crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid });
const K1 = pub('k1'), K2 = pub('k2');

// A fake JWKS endpoint and clock: `doc` is served, or `fail` makes the fetch throw / answer 503.
function world() {
    const w = { t: 1_000_000, doc: { keys: [K1] }, fail: null, fetches: 0, logs: [] };
    w.fetch = async () => {
        w.fetches += 1;
        if (w.fail === 'throw') throw new Error('connect ECONNREFUSED');
        if (w.fail === '503') return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => w.doc };
    };
    w.log = { warn: (m) => w.logs.push(['warn', m]), info: (m) => w.logs.push(['info', m]) };
    w.client = (opts = {}) => createJwksClient('https://net.example/jwks', { fetch: w.fetch, log: w.log, now: () => w.t, ...opts });
    return w;
}
const kids = (keys) => keys.map((k) => k.kid);
const tick = () => new Promise((r) => setImmediate(r));

run([
    ['fresh keys are fetched once and cached', async () => {
        const w = world(), c = w.client();
        assert.deepEqual(kids(await c.keys()), ['k1']);
        await c.keys(); await c.keys();
        assert.equal(w.fetches, 1);
        assert.equal(c.status().ready, true);
    }],

    ['stale keys are served at once while one refresh runs in the background', async () => {
        const w = world(), c = w.client({ ttlMs: 1000 });
        await c.keys();
        w.t += 2000; w.doc = { keys: [K1, K2] };
        assert.deepEqual(kids(await c.keys()), ['k1'], 'the stale keys answer immediately');
        await tick(); await tick();
        assert.equal(w.fetches, 2, 'one background refresh');
        assert.deepEqual(kids(await c.keys()), ['k1', 'k2']);
    }],

    ['a failed refresh keeps the last good keys, backs off, and logs once', async () => {
        const w = world(), c = w.client({ ttlMs: 1000 });
        await c.keys();
        w.t += 2000; w.fail = 'throw';
        assert.deepEqual(kids(await c.keys()), ['k1']);
        await tick(); await tick();
        assert.equal(w.fetches, 2);
        for (let i = 0; i < 5; i++) await c.keys();
        await tick();
        assert.equal(w.fetches, 2, 'no refetch inside the backoff window');
        assert.equal(w.logs.filter(([l]) => l === 'warn').length, 1, 'the failure is logged once, not per request');
        const s = c.status();
        assert.equal(s.ready, true); assert.equal(s.failures, 1); assert.match(s.lastError, /ECONNREFUSED/); assert.ok(s.nextTryAt > w.t);
        // After the backoff it retries; recovery is logged.
        w.t = s.nextTryAt + 1; w.fail = null;
        await c.keys(); await tick(); await tick();
        assert.equal(w.fetches, 3);
        assert.equal(c.status().failures, 0);
        assert.ok(w.logs.some(([l, m]) => l === 'info' && /recovered/.test(m)));
    }],

    ['no keys at all: a 503-class token.no_key, without hammering the endpoint', async () => {
        const w = world(), c = w.client(); w.fail = '503';
        await assert.rejects(c.keys(), { code: 'token.no_key', status: 503 });
        await assert.rejects(c.keys(), { code: 'token.no_key' });
        assert.equal(w.fetches, 1, 'the second call fails fast inside the backoff');
        assert.equal(c.status().ready, false);
    }],

    ['an unknown kid refetches once (a rotation), a flood of them only every 30 s', async () => {
        const w = world(), c = w.client();
        await c.keys();
        w.doc = { keys: [K1, K2] };
        assert.deepEqual(kids(await c.keysForKid('k2')), ['k1', 'k2'], 'a rotation is honoured at once');
        assert.equal(w.fetches, 2);
        for (let i = 0; i < 20; i++) await c.keysForKid(`made-up-${i}`);
        assert.equal(w.fetches, 2, 'twenty garbage kids right after the rotation refetch: none (30 s apart)');
        w.t += 31_000;
        await c.keysForKid('another-made-up');
        for (let i = 0; i < 20; i++) await c.keysForKid(`more-made-up-${i}`);
        assert.equal(w.fetches, 3, 'after 30 s: one refetch for the next flood');
        assert.deepEqual(kids(await c.keysForKid('k1')), ['k1', 'k2'], 'a known kid never refetches');
        assert.equal(w.fetches, 3);
    }],

    ['a malformed entry is skipped; a kid-less legacy document never refetches for a kid', async () => {
        const w = world(); w.doc = { keys: [null, 'x', K1] };
        const c = w.client();
        assert.deepEqual(kids(await c.keys()), ['k1'], 'null and non-objects are skipped, the good key kept');
        const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const w2 = world(); w2.doc = { public_key: publicKey.export({ type: 'spki', format: 'pem' }) };
        const c2 = w2.client();
        await c2.keysForKid('k1'); w2.t += 31_000; await c2.keysForKid('k1');
        assert.equal(w2.fetches, 1, 'no refetch: a document without kids can never name one');
    }],

    ['start() refreshes in the background without holding the process open', async () => {
        const w = world(), c = w.client();
        c.start({ intervalMs: 60_000 });
        await tick(); await tick();
        assert.equal(w.fetches, 1);
        assert.equal(c.status().ready, true);
        c.stop();
    }],
]);
