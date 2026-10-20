'use strict';
// openvibe-sdk/inventory: OpenVibe.Inventory's /api/v1 (ADR-054) through a real core client against a local stub: the
// public reads, the person's own items and equip, an issuer's definitions, grants (retry-safe on the body's own key),
// consume and revoke, a service acting for a person (X-OV-Subject), and the id checks done before any call.
const assert = require('assert');
const http = require('http');
const { createClient } = require('../src/core');
const { createInventoryClient } = require('../src/inventory');

(async () => {
    const seen = [];
    let grantAttempts = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, subject: req.headers['x-ov-subject'] || null, idem: req.headers['idempotency-key'] || null, body: body ? JSON.parse(body) : null });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/api/v1/grants') {
                grantAttempts++;
                if (grantAttempts === 1) return json(503, { type: 'about:blank', title: 'busy', status: 503 });   // retried: the body's key makes it safe
                return json(201, { instance: { id: 'inv_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, created: true });
            }
            if (req.url === '/api/v1/definitions' && req.method === 'POST') return json(409, { type: 'about:blank', title: 'exhausted', status: 409, code: 'inventory.supply_exhausted' });
            return json(200, { ok: true });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = createClient({ baseUrls: { inventory: base }, token: 'tok', retries: 2, retryDelayMs: 1, maxRetryDelayMs: 2 });
    const inv = createInventoryClient(client);
    const U1 = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', U2 = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';
    const DEF = 'itd_01JAB2C3D4E5F6G7H8J9K0MNPQ', INST = 'inv_01JAB2C3D4E5F6G7H8J9K0MNPQ';

    try {
        await inv.kinds.list();
        await inv.kinds.get('live.hat');
        await inv.definitions.list({ kind: 'live.hat', issuer: 'service:live' });
        await inv.definitions.get(DEF);
        await inv.people.items(U1, { kind: 'live.hat', limit: 10 });
        await inv.people.equipped(U1);
        await inv.equipped([U1, U2, U1]);
        await inv.me.items({ cursor: 'c1' });
        await inv.me.equip({ kind: 'live.hat', slot: 'head', instance_id: INST });
        await inv.me.equip({ kind: 'live.hat', slot: 'head', instance_id: null });
        await inv.definitions.update(DEF, { name: 'Renamed' });
        await inv.instances.consume(INST);
        await inv.instances.revoke(INST, { reason: 'refund' });
        assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), [
            'GET /api/v1/kinds', 'GET /api/v1/kinds/live.hat', 'GET /api/v1/definitions?kind=live.hat&issuer=service%3Alive',
            `GET /api/v1/definitions/${DEF}`, `GET /api/v1/people/${U1}/items?kind=live.hat&limit=10`, `GET /api/v1/people/${U1}/equipped`,
            `GET /api/v1/equipped?subjects=${U1}%2C${U2}`, 'GET /api/v1/me/items?cursor=c1', 'PUT /api/v1/me/equipped', 'PUT /api/v1/me/equipped',
            `PATCH /api/v1/definitions/${DEF}`, `POST /api/v1/instances/${INST}/consume`, `POST /api/v1/instances/${INST}/revoke`,
        ]);
        assert.deepStrictEqual(seen[8].body, { kind: 'live.hat', slot: 'head', instance_id: INST });
        assert.deepStrictEqual(seen[9].body, { kind: 'live.hat', slot: 'head', instance_id: null }, 'null clears the slot');
        assert.deepStrictEqual(seen[12].body, { reason: 'refund' });
        assert.ok(seen.every((s) => s.subject === null), 'a person\'s own client names nobody');

        // Grants: the body's idempotency_key makes a retry safe, so a 503 is retried and the item is granted once.
        seen.length = 0;
        const out = await inv.grants.create({ definition_id: DEF, subject: U1, idempotency_key: 'win-match-42' });
        assert.deepStrictEqual(out, { instance: { id: INST }, created: true });
        assert.strictEqual(seen.length, 2, 'retried once');
        assert.deepStrictEqual(seen[1].body, { definition_id: DEF, subject: U1, idempotency_key: 'win-match-42' });
        assert.throws(() => inv.grants.create({ definition_id: DEF, subject: U1, idempotency_key: 'short' }), /8 to 128/);
        assert.throws(() => inv.grants.create({ definition_id: 'itd_bad', subject: U1, idempotency_key: 'win-match-42' }), /itd_/);

        // A new definition is never retried on its own, and Inventory's code reaches the error.
        seen.length = 0;
        await assert.rejects(inv.definitions.create({ kind: 'game:x.badge', name: 'First Win' }), (err) => err.status === 409 && err.code === 'inventory.supply_exhausted');
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].idem, null);

        // A service acting for a person.
        seen.length = 0;
        await inv.forPerson(U2).me.equip({ kind: 'live.hat', slot: 'head', instance_id: INST });
        assert.strictEqual(seen[0].subject, U2);
        assert.throws(() => inv.forPerson('someone'), /usr_/);

        // Checks before any call.
        assert.throws(() => inv.people.items('../admin'), /usr_/);
        assert.throws(() => inv.equipped(Array.from({ length: 101 }, (_, i) => `usr_01JAB2C3D4E5F6G7H8J9K0M${String(i).padStart(3, '0').replace(/[^0-9A-HJKMNP-TV-Z]/g, 'A')}`)), /100/);
        assert.throws(() => inv.me.equip({ kind: 'live.hat', slot: 'head', instance_id: 'x' }), /inv_/);
        assert.throws(() => createInventoryClient({}), /core client/);
        console.log('inventory: all checks passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
