'use strict';
// openvibe-sdk/vibes: Vibes Pay charges through a local Billing stub, whole-Vibes validation, one
// idempotency key per reference, a token provider that can refresh, and webhook signatures (v2 with
// a replay window, the legacy body-only sha256, constant-time and never throwing on bad input).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stubServer, send, problem, run } = require('./helpers');
const { createVibesClient, VibesError, verifyWebhook, SIGNATURE_TOLERANCE_SEC } = require('../src/vibes');

const hmac = (secret, text) => crypto.createHmac('sha256', String(secret)).update(text).digest('hex');

(async () => {
    let mode = 'ok';
    let tokenN = 0;
    const stub = await stubServer((req, res, body) => {
        if (mode === 'unauthorized' && req.headers.authorization === 'Bearer tok-1') return problem(res, 401, 'token.expired', 'expired');
        if (mode === 'insufficient') return problem(res, 402, 'billing.insufficient_funds', 'not enough Vibes');
        if (mode === 'unavailable') return send(res, 503, { code: 'billing.unavailable' });
        if (req.url === '/api/v1/vibes/charges' && req.method === 'POST') {
            return send(res, 201, { id: 'vch_01TEST', pay_url: 'https://openvibe.network/pay/vch_01TEST', status: 'pending', expires_at: '2030-01-01T00:00:00Z' });
        }
        if (req.url === '/api/v1/vibes/charges/vch_01TEST' && req.method === 'GET') return send(res, 200, { id: 'vch_01TEST', status: 'paid' });
        if (req.url === '/api/v1/vibes/charges/vch_01TEST/refund' && req.method === 'POST') return send(res, 200, { id: 'vch_01TEST', status: 'refunded' });
        return problem(res, 404, 'not_found', 'not found');
    });

    try {
        const vibes = createVibesClient({ appToken: 'app-token', billingUrl: `${stub.url}/` });

        await run([
            ['create: a whole-Vibes charge, the reference as the idempotency key, the app token', async () => {
                const out = await vibes.charges.create({ amount: 50, description: 'Sticker pack: Neon cats', reference: 'order_123', return_url: 'https://myapp.example/thanks' });
                assert.equal(out.id, 'vch_01TEST');
                const call = stub.requests.at(-1);
                assert.equal(call.method, 'POST');
                assert.equal(call.url, '/api/v1/vibes/charges');
                assert.equal(call.headers.authorization, 'Bearer app-token');
                assert.equal(call.headers['idempotency-key'], 'order_123');
                assert.deepEqual(JSON.parse(call.body), { amount: 50, description: 'Sticker pack: Neon cats', reference: 'order_123', return_url: 'https://myapp.example/thanks' });
            }],

            ['get and refund: the id in the path, a reason only when given', async () => {
                assert.equal((await vibes.charges.get('vch_01TEST')).status, 'paid');
                assert.equal(stub.requests.at(-1).url, '/api/v1/vibes/charges/vch_01TEST');
                assert.equal((await vibes.charges.refund('vch_01TEST')).status, 'refunded');
                assert.equal(stub.requests.at(-1).url, '/api/v1/vibes/charges/vch_01TEST/refund');
                assert.deepEqual(JSON.parse(stub.requests.at(-1).body), {});
                await vibes.charges.refund('vch_01TEST', { reason: 'bought twice' });
                assert.deepEqual(JSON.parse(stub.requests.at(-1).body), { reason: 'bought twice' });
            }],

            ['money is an integer: a float, zero or a negative amount never reaches Billing', async () => {
                for (const amount of [1.5, 0, -1, '50', Number.MAX_SAFE_INTEGER + 2]) {
                    await assert.rejects(vibes.charges.create({ amount, description: 'x', reference: 'r' }), TypeError);
                }
                await assert.rejects(vibes.charges.create({ amount: 50, description: ' ', reference: 'r' }), TypeError);
                await assert.rejects(vibes.charges.create({ amount: 50, description: 'x', reference: '' }), TypeError);
                await assert.rejects(vibes.charges.create({ amount: 50, description: 'x', reference: 'r', return_url: 'javascript:alert(1)' }), TypeError);
                assert.equal(stub.requests.filter((r) => r.method === 'POST').length, 3, 'only the three valid calls above were sent');
            }],

            ['a 402 is Billing\'s answer: VibesError with status, code, body and not retryable', async () => {
                mode = 'insufficient';
                await assert.rejects(vibes.charges.create({ amount: 50, description: 'x', reference: 'order_2' }), (err) => err instanceof VibesError
                    && err.status === 402 && err.code === 'billing.insufficient_funds' && err.retryable === false && err.body.code === 'billing.insufficient_funds');
                mode = 'ok';
            }],

            ['a token provider: minted per call (or its headers), and a 401 invalidates and retries once with the same key', async () => {
                tokenN = 0;
                const invalidated = [];
                const provider = {
                    async getToken() { return `tok-${++tokenN}`; },
                    invalidate() { invalidated.push(1); },
                };
                const p = createVibesClient({ tokenProvider: provider, billingUrl: stub.url });
                mode = 'unauthorized';
                await p.charges.create({ amount: 10, description: 'x', reference: 'order_401' });
                const calls = stub.requests.slice(-2);
                assert.deepEqual(calls.map((c) => c.headers.authorization), ['Bearer tok-1', 'Bearer tok-2']);
                assert.deepEqual(calls.map((c) => c.headers['idempotency-key']), ['order_401', 'order_401']);
                assert.equal(invalidated.length, 1);
                mode = 'ok';
                const headers = createVibesClient({ tokenProvider: { authHeaders: async () => ({ Authorization: 'Bearer hdr-token' }) }, billingUrl: stub.url });
                await headers.charges.get('vch_01TEST');
                assert.equal(stub.requests.at(-1).headers.authorization, 'Bearer hdr-token');
                await assert.rejects(createVibesClient({ tokenProvider: { getToken: async () => null }, billingUrl: stub.url }).charges.get('vch_01TEST'), /no token/);
            }],

            ['webhooks.verify: v2 is timestamped and replay-limited; legacy sha256 covers the body alone', async () => {
                const secret = 'whsec_test_not_real';
                const body = JSON.stringify({ type: 'billing.vibes.charge.paid', data: { id: 'vch_01TEST', status: 'paid', reference: 'order_123' } });
                const now = Date.UTC(2026, 10, 4, 12, 0, 0);
                const t = Math.floor(now / 1000);
                const header = `t=${t},v2=${hmac(secret, `${t}.${body}`)}`;
                assert.equal(vibes.webhooks.verify(body, header, secret, { now }), true);
                assert.equal(verifyWebhook(Buffer.from(body), header, secret, { now }), true, 'a Buffer body');
                assert.equal(vibes.webhooks.verify(body, header, secret, { now: now + SIGNATURE_TOLERANCE_SEC * 1000 * 2 }), false, 'stale');
                assert.equal(vibes.webhooks.verify(body, header, secret, { now: now - SIGNATURE_TOLERANCE_SEC * 1000 * 2 }), false, 'from the future');
                assert.equal(vibes.webhooks.verify(`${body} `, header, secret, { now }), false, 'one byte changed');
                assert.equal(vibes.webhooks.verify(body, header, 'another-secret', { now }), false);
                assert.equal(vibes.webhooks.verify(body, `t=${t},v2=${'0'.repeat(64)}`, secret, { now }), false);
                assert.equal(vibes.webhooks.verify(body, '', secret, { now }), false);
                assert.equal(vibes.webhooks.verify(body, 't=x,v2=abc', secret, { now }), false);
                assert.equal(vibes.webhooks.verify(body, null, secret, { now }), false);
                assert.equal(vibes.webhooks.verify(null, header, secret, { now }), false);
                assert.equal(vibes.webhooks.verify(body, header, '', { now }), false);
                assert.equal(vibes.webhooks.verify(body, `sha256=${hmac(secret, body)}`, secret), true, 'the legacy body-only form');
                assert.equal(vibes.webhooks.verify(body, hmac(secret, body), secret), true, 'bare hex');
                assert.throws(() => vibes.webhooks.verify(body, header, secret, { toleranceSec: -1 }), TypeError);
            }],
        ]);
    } finally {
        await stub.close();
    }
    console.log('vibes: ok');
})().catch((err) => { console.error(err); process.exit(1); });
