'use strict';
/**
 * openvibe-sdk/consent (L24, 2026-10-31): the client every service uses before it uses a person's content or
 * likeness for AI or data. What this proves:
 *   - an answer is cached for ttlMs and asked again after it, per subject, purpose, kind, client and feature;
 *   - network.consent.changed drops that subject's answers for the purpose at once (and only those);
 *   - every failure is a false answer — network error, timeout, non-200, malformed, a token that cannot be minted —
 *     and a failure is never cached as a yes; it logs at most once a minute;
 *   - filter() batches by 500, keeps input order and drops duplicates;
 *   - mock() answers from a map without the network.
 */
const assert = require('node:assert/strict');
const { stubServer, send, run, sleep } = require('./helpers');
const { createConsent, DEFAULT_TTL_MS, DEFAULT_TIMEOUT_MS, MAX_SUBJECTS } = require('../src/consent');

const ok = (data) => ({
    status: 200,
    body: { purpose: data.purpose, allowed: Object.fromEntries(data.subjects.map((s) => [s, true])), ...(data.kind ? { kind: data.kind } : {}), checked_at: new Date().toISOString() },
});

/** One stub Network whose answers the test steers. */
async function network() {
    const state = { answer: ok, requests: [], token: 'svc-token' };
    const stub = await stubServer(async (req, res, body) => {
        const data = JSON.parse(body.toString() || '{}');
        state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: data });
        const a = state.answer(data, state.requests.length);
        if (!a || a.hang) return await new Promise(() => {});
        if (a.delayMs) await sleep(a.delayMs);
        if (a.badJson) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json'); return; }
        send(res, a.status || 200, a.body === undefined ? '' : a.body);
    });
    return { stub, state };
}

run([
    ['the defaults are the agreed 60 s cache and 2 s timeout', async () => {
        assert.equal(DEFAULT_TTL_MS, 60_000);
        assert.equal(DEFAULT_TIMEOUT_MS, 2_000);
        assert.equal(MAX_SUBJECTS, 500);
    }],

    ['an answer is cached for ttlMs, then asked again', async () => {
        const { stub, state } = await network();
        let clock = 1_000_000;
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token, now: () => clock, fetch: globalThis.fetch });
        try {
            assert.equal(await consent.allowed('usr_a', 'ai.train', { kind: 'vods' }), true);
            assert.equal(await consent.allowed('usr_a', 'ai.train', { kind: 'vods' }), true);
            assert.equal(state.requests.length, 1, 'the second answer comes from the cache');
            // A different kind is a different question.
            await consent.allowed('usr_a', 'ai.train', { kind: 'clips' });
            assert.equal(state.requests.length, 2);
            assert.equal(state.requests[0].body.kind, 'vods');
            // Just before the TTL.
            clock += 59_999;
            await consent.allowed('usr_a', 'ai.train', { kind: 'vods' });
            assert.equal(state.requests.length, 2, 'still cached');
            // At the TTL it is asked again.
            clock += 1;
            await consent.allowed('usr_a', 'ai.train', { kind: 'vods' });
            assert.equal(state.requests.length, 3, 'the TTL expired');
        } finally { await stub.close(); }
    }],

    ['the request is the contract check, with the service token', async () => {
        const { stub, state } = await network();
        const consent = createConsent({ networkUrl: stub.url + '/', token: async () => state.token });
        try {
            await consent.allowed('usr_a', 'face.recognize', { feature: 'verify', client: 'app-one' });
            const r = state.requests[0];
            assert.equal(r.method, 'POST');
            assert.equal(r.url, '/internal/consent/check');
            assert.equal(r.headers.authorization, 'Bearer svc-token');
            assert.deepEqual(r.body, { purpose: 'face.recognize', subjects: ['usr_a'], client: 'app-one', feature: 'verify' });
        } finally { await stub.close(); }
    }],

    ['network.consent.changed drops that subject and purpose, and only those', async () => {
        const { stub, state } = await network();
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token });
        try {
            await consent.allowed('usr_a', 'ai.train');
            await consent.allowed('usr_a', 'data.public');
            await consent.allowed('usr_b', 'ai.train');
            assert.equal(state.requests.length, 3);
            const dropped = consent.onChange({ payload: { subject: 'usr_a', purpose: 'ai.train' } });
            assert.equal(dropped, 1);
            await consent.allowed('usr_a', 'ai.train');
            assert.equal(state.requests.length, 4, 'the revoked purpose is asked again');
            await consent.allowed('usr_a', 'data.public');
            await consent.allowed('usr_b', 'ai.train');
            assert.equal(state.requests.length, 4, 'the other purpose and the other subject stay cached');
            // The bare payload works too, and no fields clears everything.
            consent.onChange({ subject: 'usr_b', purpose: 'ai.train' });
            await consent.allowed('usr_b', 'ai.train');
            assert.equal(state.requests.length, 5);
            assert.ok(consent.onChange(null) >= 2);
            await consent.allowed('usr_a', 'data.public');
            assert.equal(state.requests.length, 6);
        } finally { await stub.close(); }
    }],

    ['an answer started before a change is never cached (the revocation wins)', async () => {
        const { stub, state } = await network();
        state.answer = (data) => ({ delayMs: 40, body: ok(data).body });
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token });
        try {
            const pending = consent.allowed('usr_a', 'ai.train');
            await sleep(10);
            consent.onChange({ payload: { subject: 'usr_a', purpose: 'ai.train' } });
            assert.equal(await pending, true, 'the answer itself is what the Network said');
            state.answer = ok;
            await consent.allowed('usr_a', 'ai.train');   // must ask again: the in-flight answer was not stored
            assert.equal(state.requests.length, 2);
        } finally { await stub.close(); }
    }],

    ['a network error is false, is not cached, and does not throw', async () => {
        const dead = await network();
        const url = dead.stub.url;
        await dead.stub.close();
        const consent = createConsent({ networkUrl: url, token: () => 'svc-token', timeoutMs: 500, log: null });
        assert.equal(await consent.allowed('usr_a', 'ai.train'), false);
        assert.equal(await consent.allowed('usr_a', 'ai.train'), false, 'still false, never an error');
    }],

    ['a timeout (2 s by default, shorter here) is false and not cached', async () => {
        const { stub, state } = await network();
        state.answer = () => ({ hang: true });
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token, timeoutMs: 30, log: null });
        try {
            const t0 = Date.now();
            assert.equal(await consent.allowed('usr_a', 'ai.train'), false);
            assert.ok(Date.now() - t0 < 1500, 'the timeout ended the call');
            state.answer = ok;
            assert.equal(await consent.allowed('usr_a', 'ai.train'), true, 'the failure was not cached');
            assert.equal(state.requests.length, 2);
        } finally { await stub.close(); }
    }],

    ['a token endpoint that never answers is a timeout too', async () => {
        const consent = createConsent({ networkUrl: 'http://127.0.0.1:9', token: () => new Promise(() => {}), timeoutMs: 30, log: null });
        const t0 = Date.now();
        assert.equal(await consent.allowed('usr_a', 'ai.train'), false);
        assert.ok(Date.now() - t0 < 1500, 'the deadline covers the token, not only the socket');
    }],

    ['a non-200 is false and not cached', async () => {
        const { stub, state } = await network();
        state.answer = () => ({ status: 403, body: { code: 'capability.denied' } });
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token, log: null });
        try {
            assert.equal(await consent.allowed('usr_a', 'ai.train'), false);
            state.answer = ok;
            assert.equal(await consent.allowed('usr_a', 'ai.train'), true);
            assert.equal(state.requests.length, 2);
        } finally { await stub.close(); }
    }],

    ['a malformed answer is false and not cached', async () => {
        const { stub, state } = await network();
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token, log: null });
        try {
            state.answer = () => ({ badJson: true });
            assert.equal(await consent.allowed('usr_a', 'ai.train'), false);
            state.answer = () => ({ body: { purpose: 'ai.train', allowed: 'everyone' } });
            assert.equal(await consent.allowed('usr_a', 'ai.train'), false);
            state.answer = () => ({ body: { purpose: 'data.public', allowed: { usr_a: true } } });
            assert.equal(await consent.allowed('usr_a', 'ai.train'), false, 'the purpose must be the one asked');
            state.answer = () => ({ body: { purpose: 'ai.train', allowed: { usr_a: 'yes' } } });
            assert.equal(await consent.allowed('usr_a', 'ai.train'), false, 'a non-boolean is not a yes');
            state.answer = ok;
            assert.equal(await consent.allowed('usr_a', 'ai.train'), true);
            assert.equal(state.requests.length, 5);
        } finally { await stub.close(); }
    }],

    ['a token that cannot be minted is false and not cached', async () => {
        let broken = true;
        const { stub, state } = await network();
        const consent = createConsent({ networkUrl: stub.url, token: () => { if (broken) throw new Error('no token'); return state.token; }, log: null });
        try {
            assert.equal(await consent.allowed('usr_a', 'ai.train'), false);
            broken = false;
            assert.equal(await consent.allowed('usr_a', 'ai.train'), true);
            assert.equal(state.requests.length, 1);
        } finally { await stub.close(); }
    }],

    ['it logs at most once a minute', async () => {
        const { stub, state } = await network();
        let clock = 10_000_000;
        const lines = [];
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token, now: () => clock, log: { warn: (m) => lines.push(m) } });
        try {
            state.answer = () => ({ status: 500, body: {} });
            await consent.allowed('usr_a', 'ai.train', { kind: 'vods' });
            await consent.allowed('usr_a', 'ai.train', { kind: 'clips' });
            await consent.allowed('usr_b', 'ai.train');
            assert.equal(lines.length, 1, 'one warning for three failures in the minute');
            clock += 60_000;
            await consent.allowed('usr_c', 'ai.train');
            assert.equal(lines.length, 2, 'and one more after the minute');
        } finally { await stub.close(); }
    }],

    ['filter batches by 500, keeps input order and drops duplicates', async () => {
        const { stub, state } = await network();
        state.answer = (data) => ({ body: { purpose: data.purpose, allowed: Object.fromEntries(data.subjects.map((s) => [s, Number(s.slice(-3)) % 2 === 0])), checked_at: new Date().toISOString() } });
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token });
        try {
            const subjects = Array.from({ length: 1200 }, (_, i) => `usr_${String(i).padStart(3, '0')}`);
            subjects.splice(3, 0, subjects[0]);   // a duplicate
            const allowed = await consent.filter(subjects, 'ai.train', { kind: 'chat' });
            assert.equal(state.requests.length, 3, '1200 people = 3 checks');
            assert.deepEqual(state.requests.map((r) => r.body.subjects.length), [500, 500, 200]);
            assert.deepEqual(allowed, [...new Set(subjects)].filter((s) => Number(s.slice(-3)) % 2 === 0), 'the allowed subset, in input order');
            // The answers are cached like allowed().
            await consent.filter(subjects.slice(0, 500), 'ai.train', { kind: 'chat' });
            assert.equal(state.requests.length, 3);
        } finally { await stub.close(); }
    }],

    ['mock answers from a map without the network; mock(null) goes live', async () => {
        const { stub, state } = await network();
        const consent = createConsent({ networkUrl: stub.url, token: () => state.token, log: null });
        try {
            consent.mock({ usr_a: ['ai.train', 'data.public'], usr_b: ['face.recognize'] });
            assert.equal(await consent.allowed('usr_a', 'ai.train'), true);
            assert.equal(await consent.allowed('usr_a', 'face.recognize'), false);
            assert.deepEqual(await consent.filter(['usr_a', 'usr_b', 'usr_c'], 'face.recognize'), ['usr_b']);
            assert.equal(state.requests.length, 0, 'the mock never calls the Network');
            consent.mock(null);
            assert.equal(await consent.allowed('usr_a', 'ai.train'), true);
            assert.equal(state.requests.length, 1, 'a miss goes live again');
            assert.throws(() => consent.mock({ usr_a: 'ai.train' }), /array of purposes/);
        } finally { await stub.close(); }
    }],
]);
