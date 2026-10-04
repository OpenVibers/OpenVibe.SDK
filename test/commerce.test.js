'use strict';
/** openvibe-sdk/commerce: the shared Billing client (key derivation, retry once on 401, problem+json, retryable). */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createCommerceClient, CommerceError, intentKey, receipt } = require('../src/commerce');

const CONFIG = { billing: { url: 'http://billing.test', audience: 'openvibe.billing', timeoutMs: 5000 }, network: { internalUrl: 'http://net.test' }, oauth: { clientId: 'c', clientSecret: 's' } };
const CAPS = { intent: 'billing.intent.create', transfer: 'billing.transfer.create', subscription: 'billing.subscription.manage', entitlement: 'billing.entitlement.check' };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function rig(responses) {
    const calls = [];
    const invalidated = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const r = responses.shift();
        if (r instanceof Error) throw r;
        return r;
    };
    const mk = (name) => ({ authHeaders: async () => ({ Authorization: `Bearer ${name}` }), invalidate: () => invalidated.push(name) });
    const tokenClients = { intent: mk('intent'), transfer: mk('transfer'), subscription: mk('subscription'), entitlement: mk('entitlement') };
    return { calls, invalidated, client: createCommerceClient(CONFIG, { caps: CAPS, fetchImpl, tokenClients }) };
}

run([
    ['intentKey joins the parts that are set and needs a prefix', async () => {
        assert.equal(intentKey('tip', ['a', null, '', 7, undefined, 'b']), 'tip:a:7:b');
        assert.equal(intentKey('tip', []), 'tip:');
        assert.throws(() => intentKey('', ['a']), TypeError);
        assert.throws(() => intentKey(undefined, ['a']), TypeError);
    }],
    ['receipt stamps the time and strips null fields', async () => {
        const r = receipt('tip.paid', { id: 'x', note: null, n: 0, gone: undefined });
        assert.deepEqual(Object.keys(r), ['kind', 'at', 'id', 'n']);
        assert.equal(r.kind, 'tip.paid');
        assert.equal(new Date(r.at).toISOString(), r.at);
    }],
    ['retryable: no status, 5xx, 429, 401 and billing.frozen; not the other 4xx', async () => {
        const cases = [[{}, true], [{ status: 500 }, true], [{ status: 503 }, true], [{ status: 429 }, true], [{ status: 401 }, true],
            [{ status: 409, code: 'billing.frozen' }, true], [{ status: 400 }, false], [{ status: 402, code: 'billing.insufficient_funds' }, false], [{ status: 404 }, false]];
        for (const [init, want] of cases) assert.equal(new CommerceError('x', init).retryable, want, JSON.stringify(init));
        assert.equal(new CommerceError('x').name, 'CommerceError');
    }],
    ['createIntent builds the purchase and the subscription bodies', async () => {
        const { client, calls } = rig([json(200, { intent: { id: 'i1' }, checkout_url: 'u' }), json(200, { intent: { id: 'i2' } })]);
        assert.deepEqual(await client.createIntent({ provider: 'square', subject: 'u1', bits: 500, successUrl: 's', cancelUrl: 'c', key: 'k1', traceparent: 'tp' }), { intent: { id: 'i1' }, checkout_url: 'u' });
        await client.createIntent({ provider: 'square', kind: 'subscription', subject: 'u1', creator: 'u2', autoRenew: 1, successUrl: 's', cancelUrl: 'c', key: 'k2' });
        assert.equal(calls[0].url, 'http://billing.test/api/v1/intents');
        assert.equal(calls[0].init.method, 'POST');
        assert.deepEqual(JSON.parse(calls[0].init.body), { provider: 'square', kind: 'purchase', subject: { type: 'user', id: 'u1' }, bits: 500, success_url: 's', cancel_url: 'c' });
        assert.equal(calls[0].init.headers['Idempotency-Key'], 'k1');
        assert.equal(calls[0].init.headers.traceparent, 'tp');
        assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
        assert.equal(calls[0].init.headers.Authorization, 'Bearer intent');
        assert.deepEqual(JSON.parse(calls[1].init.body), { provider: 'square', kind: 'subscription', subject: { type: 'user', id: 'u1' }, streamer: { type: 'user', id: 'u2' }, auto_renew: true, success_url: 's', cancel_url: 'c' });
        assert.equal(calls[1].init.headers.traceparent, undefined);
    }],
    ['transfer, refund, subscribe, cancel and reads use their capability, path and body', async () => {
        const { client, calls } = rig(Array.from({ length: 8 }, () => json(200, { ok: true })));
        await client.createTransfer({ from: 'a', to: 'b', amount: 5, kind: 'tip', target: { t: 1 }, message: '', key: 'k' });
        await client.refundTransfer({ txnId: 'txn/1', amount: 5, reason: 'unplayed', key: 'r' });
        await client.subscribeWithCredit({ subscriber: 'a', creator: 'b', key: 's' });
        await client.cancelSubscription({ id: 'sub 1', key: 'c' });
        await client.getSubscription('sub 1');
        await client.listSubscriptions({ streamer: 'b', status: 'active', subscriber: '' });
        await client.entitlement('a b', 'c');
        await client.rates();
        const seen = calls.map((c) => [c.init.method, c.url.replace('http://billing.test', ''), c.init.headers.Authorization]);
        assert.deepEqual(seen, [
            ['POST', '/api/v1/transfers', 'Bearer transfer'],
            ['POST', '/api/v1/transfers/txn%2F1/refund', 'Bearer transfer'],
            ['POST', '/api/v1/subscriptions', 'Bearer subscription'],
            ['POST', '/api/v1/subscriptions/sub%201/cancel', 'Bearer subscription'],
            ['GET', '/api/v1/subscriptions/sub%201', 'Bearer entitlement'],
            ['GET', '/api/v1/subscriptions?streamer=b&status=active', 'Bearer entitlement'],
            ['GET', '/api/v1/entitlements/a%20b?streamer=c', 'Bearer entitlement'],
            ['GET', '/api/v1/rates', 'Bearer entitlement'],
        ]);
        assert.deepEqual(JSON.parse(calls[0].init.body), { from: { type: 'user', id: 'a' }, to: { type: 'user', id: 'b' }, amount: 5, kind: 'tip', target: { t: 1 } });
        assert.deepEqual(JSON.parse(calls[1].init.body), { amount: 5, reason: 'unplayed' });
        assert.deepEqual(JSON.parse(calls[2].init.body), { subscriber: { type: 'user', id: 'a' }, streamer: { type: 'user', id: 'b' }, source: 'credit', auto_renew: true });
        assert.deepEqual(JSON.parse(calls[3].init.body), {});
        for (const i of [4, 5, 6, 7]) { assert.equal(calls[i].init.body, undefined); assert.equal(calls[i].init.headers['Content-Type'], undefined); }
        assert.equal(calls[2].init.headers['Idempotency-Key'], 's');
        assert.equal(calls[4].init.headers['Idempotency-Key'], undefined);
        assert.equal(client.baseUrl(), 'http://billing.test');
    }],
    ['a 401 invalidates the token and retries once with the same Idempotency-Key', async () => {
        const { client, calls, invalidated } = rig([json(401, { code: 'unauthorized' }), json(200, { transaction: { id: 't' } })]);
        const out = await client.createTransfer({ from: 'a', to: 'b', amount: 1, kind: 'tip', key: 'tip:i1' });
        assert.deepEqual(out, { transaction: { id: 't' } });
        assert.equal(calls.length, 2);
        assert.deepEqual(invalidated, ['transfer']);
        assert.equal(calls[0].init.headers['Idempotency-Key'], 'tip:i1');
        assert.equal(calls[1].init.headers['Idempotency-Key'], 'tip:i1');
        assert.equal(calls[1].init.body, calls[0].init.body);
    }],
    ['a second 401 is an error: exactly one retry', async () => {
        const { client, calls } = rig([json(401, { code: 'unauthorized' }), json(401, { code: 'unauthorized', detail: 'still' }), json(200, {})]);
        await assert.rejects(client.rates(), (e) => e instanceof CommerceError && e.status === 401 && e.retryable);
        assert.equal(calls.length, 2);
    }],
    ['problem+json maps to a CommerceError with status, code, body and message', async () => {
        const body = { code: 'billing.insufficient_funds', detail: 'need more', title: 't' };
        const { client } = rig([json(402, body), json(500, { error: 'boom' }), json(404, null)]);
        await assert.rejects(client.rates(), (e) => e instanceof CommerceError && e.status === 402 && e.code === 'billing.insufficient_funds' && e.body === body
            && e.message === 'Billing 402 billing.insufficient_funds: need more' && !e.retryable);
        await assert.rejects(client.rates(), (e) => e.status === 500 && e.code === 'boom' && e.retryable);
        await assert.rejects(client.rates(), (e) => e.status === 404 && e.code === 'http_404' && e.body === null && e.message === 'Billing 404 http_404:');
    }],
    ['a network failure or a token failure has no status and is retryable', async () => {
        const { client } = rig([new Error('ECONNRESET')]);
        await assert.rejects(client.rates(), (e) => e instanceof CommerceError && e.status === null && /unreachable: ECONNRESET/.test(e.message) && e.retryable);
        const bad = createCommerceClient(CONFIG, { caps: CAPS, fetchImpl: async () => json(200, {}), tokenClients: { entitlement: { authHeaders: async () => { throw new Error('no grant'); }, invalidate() {} } } });
        await assert.rejects(bad.rates(), (e) => e.status === null && e.message === 'token (billing.entitlement.check): no grant' && e.retryable);
    }],
    ['tokenClients may be keyed by capability string, and rates can have its own capability', async () => {
        const seen = [];
        const tc = (n) => ({ authHeaders: async () => ({ Authorization: n }), invalidate() {} });
        const client = createCommerceClient(CONFIG, {
            caps: { ...CAPS, rates: 'billing.rates.read' },
            fetchImpl: async (url, init) => { seen.push(init.headers.Authorization); return json(200, {}); },
            tokenClients: { 'billing.rates.read': tc('rates'), 'billing.transfer.create': tc('xfer') },
        });
        await client.rates();
        await client.refundTransfer({ txnId: 't', amount: 1, reason: 'r' });
        assert.deepEqual(seen, ['rates', 'xfer']);
    }],
    ['without tokenClients a serviceAuth client is created lazily per capability with scope = the capability', async () => {
        let contracts = null;
        try { contracts = require('openvibe-contracts'); } catch { /* skipped */ }
        if (!contracts || !contracts.serviceAuth) { console.log('lazy token clients: skipped (openvibe-contracts unavailable)'); return; }
        const scopes = [];
        const fetchImpl = async (url, init) => {
            if (url === 'http://net.test/oauth/token') { scopes.push(String(init.body).match(/scope=([^&]*)/)?.[1]); return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 300 }); }
            return json(200, { ok: true });
        };
        const client = createCommerceClient(CONFIG, { caps: CAPS, fetchImpl });
        await client.entitlement('a');
        await client.entitlement('b');
        await client.createTransfer({ from: 'a', to: 'b', amount: 1, kind: 'tip' });
        assert.deepEqual(scopes.map((s) => decodeURIComponent(s).replace(/\+/g, ' ')), ['billing.entitlement.check', 'billing.transfer.create']);
    }],
    ['the module loads without openvibe-contracts, and caps is required', async () => {
        assert.throws(() => createCommerceClient(CONFIG, {}), TypeError);
        const src = require('node:fs').readFileSync(require.resolve('../src/commerce'), 'utf8');
        assert.ok(!/^const .*require\('openvibe-contracts'\)/m.test(src), 'no top-level require of openvibe-contracts');
    }],
]);
