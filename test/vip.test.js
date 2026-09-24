'use strict';
// openvibe-sdk/vip: the VIP consumer seam, published once (it was copied into Chat, Community and Blog).
// Fails closed on every doubt, retries a refused token once, and the cache converges on membership events.
const assert = require('assert');
const { createVipClient, createVipCache } = require('../src/vip');

const M = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const C = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';

function stubVip() {
    const s = { calls: [], active: true, mode: 'ok', tokens: 0, invalidated: 0 };
    s.fetch = async (url, opts) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(opts.body || '{}');
        s.calls.push({ path, body, auth: opts.headers.Authorization });
        if (s.mode === 'down') throw new Error('ECONNREFUSED');
        if (s.mode === 'refuse-once') { s.mode = 'ok'; return { ok: false, status: 401, json: async () => ({}) }; }
        if (s.mode === 'garbage') return { ok: true, status: 200, json: async () => ({ nonsense: true }) };
        if (path === '/api/v1/entitlements/check') return { ok: true, status: 200, json: async () => ({ status: s.active ? 'active' : 'inactive', active: s.active, product_perks: s.active ? ['badge'] : [] }) };
        if (path === '/api/v1/policies/evaluate') return { ok: true, status: 200, json: async () => ({ allow: s.active, reason: s.active ? 'member' : 'not_member' }) };
        return { ok: false, status: 404, json: async () => ({}) };
    };
    s.tokenClient = { authHeaders: async () => ({ Authorization: `Bearer t${++s.tokens}` }), invalidate: () => { s.invalidated++; } };
    return s;
}

(async () => {
    let n = 0;
    const check = async (name, fn) => { await fn(); n++; };

    await check('entitlement and evaluate answer through the service token', async () => {
        const s = stubVip();
        const vip = createVipClient({ baseUrl: 'http://vip.test/', tokenClient: s.tokenClient, fetch: s.fetch });
        const e = await vip.checkEntitlement({ subject: M, creator: C, product: 'chat' });
        assert.strictEqual(e.active, true);
        assert.deepStrictEqual(s.calls[0].body, { subject: M, creator: C, product: 'chat' });
        assert.strictEqual(s.calls[0].auth, 'Bearer t1');
        const d = await vip.evaluate({ subject: M, resource: { service: 'blog', type: 'post', id: '42' }, owner: C, fallback: { requirement: 'member' } });
        assert.deepStrictEqual([d.allow, d.reason], [true, 'member']);
        assert.strictEqual(await vip.isMember(M, C), true);
    });

    await check('every failure is a denial, never an exception or a yes', async () => {
        for (const mode of ['down', 'garbage']) {
            const s = stubVip(); s.mode = mode;
            const vip = createVipClient({ tokenClient: s.tokenClient, fetch: s.fetch, log: { warn() {} } });
            const d = await vip.evaluate({ subject: M, resource: { service: 'blog', type: 'post', id: '1' }, owner: C });
            assert.strictEqual(d.allow, false, mode);
            const e = await vip.checkEntitlement({ subject: M, creator: C });
            assert.strictEqual(e.active, false, mode);
            assert.strictEqual(await vip.isMember(M, C), false, mode);
        }
    });

    await check('a refused token is invalidated and retried once', async () => {
        const s = stubVip(); s.mode = 'refuse-once';
        const vip = createVipClient({ tokenClient: s.tokenClient, fetch: s.fetch });
        assert.strictEqual((await vip.checkEntitlement({ subject: M, creator: C })).active, true);
        assert.strictEqual(s.invalidated, 1);
        assert.deepStrictEqual(s.calls.map((c) => c.auth), ['Bearer t1', 'Bearer t2']);
    });

    await check('the cache holds a yes for ttlMs and drops it at once on vip.membership.changed', async () => {
        const s = stubVip();
        let t = 1_000_000;
        const cache = createVipCache({ vip: createVipClient({ tokenClient: s.tokenClient, fetch: s.fetch }), ttlMs: 30_000, now: () => t });
        assert.strictEqual((await cache.entitlement({ subject: M, creator: C })).active, true);
        await cache.entitlement({ subject: M, creator: C });
        assert.strictEqual(s.calls.length, 1, 'answered from the cache');
        s.active = false;
        const dropped = cache.handleEvent({ event_type: 'vip.membership.changed', payload: { member: { type: 'user', id: M }, creator: { type: 'user', id: C }, status: 'canceled' } });
        assert.strictEqual(dropped, true);
        assert.strictEqual((await cache.entitlement({ subject: M, creator: C })).active, false, 'revocation converges immediately');
        assert.strictEqual(cache.handleEvent({ event_type: 'something.else', payload: {} }), false);
        t += 31_000;
        assert.ok(cache.bounds && typeof cache.bounds === 'object');
    });

    await check('a signed-out viewer is never a member and costs no call', async () => {
        const s = stubVip();
        const cache = createVipCache({ vip: createVipClient({ tokenClient: s.tokenClient, fetch: s.fetch }) });
        assert.strictEqual((await cache.entitlement({ subject: null, creator: C })).active, false);
        assert.strictEqual(s.calls.length, 0);
    });

    console.log(`vip: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
