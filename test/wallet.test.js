'use strict';
const assert = require('assert');
const { createClient } = require('../src/core');
const { createWalletClient } = require('../src/wallet');

(async () => {
    const calls = []; let retry = true;
    const client = createClient({ token: 'person-token', baseUrls: { billing: 'https://billing.test', inventory: 'https://inventory.test', network: 'https://network.test' },
        credentials: 'include', retries: 1, retryDelayMs: 1, fetch: async (url, init) => {
            calls.push({ url, ...init, json: init.body ? JSON.parse(init.body) : null });
            if (retry && url.endsWith('/buy')) { retry = false; return new Response(JSON.stringify({ detail: 'retry' }), { status: 503 }); }
            if (url.includes('/api/wallet/changes?')) return new Response(JSON.stringify({
                vibes: { net: 12, parts: { earned: 12, spent: 0, received: 0, sent: 0 }, moves: [{ id: 3, delta: 12, part: 'earned' }], cursor: 3 },
                opencoins: { net: -4, parts: { earned: 0, spent: -4, received: 0, sent: 0 }, moves: [{ id: 8, delta: -4, part: 'spent' }], cursor: 8 },
                channel_points: null, state: { vibes: 'open', opencoins: 'open', channel_points: 'needs_streamer' },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } });
    const ov = createWalletClient(client);
    await ov.wallet.get();
    const vibesCursor = 'txn_' + '0'.repeat(25) + '1';
    const changes = await ov.wallet.changes({ since_vibes: vibesCursor, since_opencoins: 7 });
    assert.strictEqual(changes.vibes.net, 12);
    assert.strictEqual(changes.opencoins.net, -4);
    assert.strictEqual(changes.state.channel_points, 'needs_streamer');
    assert(calls.at(-1).url.includes(`since_vibes=${vibesCursor}`));
    assert(calls.at(-1).url.includes('since_opencoins=7'));
    assert(!calls.at(-1).url.includes('subject='));
    await ov.wallet.changes({ streamer: 9, since_channel_points: 21 });
    assert(calls.at(-1).url.includes('since_channel_points=21'));
    await ov.wallet.markRead({ currency: 'channel-points', streamer: 9, cursor: 22 });
    assert.deepStrictEqual(calls.at(-1).json, { currency: 'channel-points', streamer: 9, cursor: 22 });
    await ov.wallet.markRead({ currency: 'vibes', cursor: vibesCursor });
    assert.deepStrictEqual(calls.at(-1).json, { currency: 'vibes', cursor: vibesCursor });
    await ov.wallet.topUp({ provider: 'stripe', amount_cents: 1000, idempotency_key: 'topup-test-01', subject: 'ignored' });
    await ov.vibes.buy({ provider: 'stripe', vibes: 100, idempotency_key: 'vibes-test-01', amount_cents: 1 });
    await ov.store.list();
    const id = 'itd_' + '0'.repeat(25) + '1';
    await ov.store.buy(id, { currency: 'coins', idempotency_key: 'store-test-01', price: 1 });
    await ov.items.list({ limit: 20 });
    await ov.items.equip({ kind: 'live.hat', slot: 'hat', instance_id: null });
    for (const call of calls) {
        assert.strictEqual(call.credentials, 'omit');
        assert.strictEqual(call.headers.get('Authorization'), 'Bearer person-token');
        assert(!call.json || !('price' in call.json) && !('subject' in call.json));
    }
    const vibes = calls.filter((c) => c.url.endsWith('/vibes/buy'));
    assert.strictEqual(vibes.length, 2); assert.deepStrictEqual(vibes[0].json, vibes[1].json);
    assert.strictEqual(vibes[0].headers.get('Idempotency-Key'), null);
    assert(!('amount_cents' in vibes[0].json));
    assert.strictEqual(calls.at(-1).method, 'PUT');
    assert.throws(() => ov.store.buy('../evil', { currency: 'coins', idempotency_key: 'safe-key-01' }));
    assert.throws(() => ov.store.buy(id, { currency: 'USD', idempotency_key: 'safe-key-01' }));
    assert.throws(() => ov.vibes.buy({ provider: 'stripe', vibes: 1.5, idempotency_key: 'safe-key-01' }));
    assert.throws(() => ov.wallet.topUp({ provider: 'stripe', amount_cents: 1000 }));
    assert.throws(() => ov.wallet.changes({ streamer: -1 }));
    assert.throws(() => ov.wallet.changes({ since_vibes: 'someone-else' }));
    assert.throws(() => ov.wallet.markRead({ currency: 'channel-points', cursor: 22 }));
    console.log('wallet facade: routes, personal bearer, no cookies, stable retry keys and no price/subject injection');
})().catch((e) => { console.error(e); process.exitCode = 1; });
