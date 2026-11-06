'use strict';
/**
 * Locked items in sharing: the lock kind, the per-member key slots, the re-seal on removal, the
 * transfer offer, and the agent client that wraps and re-seals. Real P-256 keys and real people
 * slots, so a slot's thumbprint is checked the way a browser's would be.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../src/db');
const { createShares, share } = require('../src/share');
const locker = require('../src/locker');

const U = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' };
const V = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR' };
const X = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS' };
const owner = { subject: U }, recipient = { subject: V }, other = { subject: X };
const SUBJECTS = { [U.id]: U, [V.id]: V, [X.id]: X };
const PEOPLE = {}, KEYS = {};
const contentKey = new Uint8Array(32).fill(7);
const base64 = bytes => Buffer.from(bytes).toString('base64');
const slotKey = key => key.recipient_key;

const db = createDb({ pglite: true });
let time = Date.parse('2026-11-06T00:00:00Z'), seq = 0;
const hooks = [];
let resealDown = false;
const shares = createShares({
    db, now: () => time, nameLimit: 1000,
    network: { json: async req => {
        if (req.path === '/internal/identity/resolve-batch') {
            const results = {};
            for (const id of req.json.subject_ids) results[id] = PEOPLE[id] || null;
            return { results };
        }
        if (req.path === '/internal/identity/resolve') {
            const found = Object.values(PEOPLE).find(p => p.username.toLowerCase() === String(req.query.username).toLowerCase());
            return found ? { ...found } : null;
        }
        const keys = String(req.path).match(/^\/api\/v1\/people\/([^/]+)\/keys$/);
        if (keys) {
            const found = KEYS[decodeURIComponent(keys[1])];
            if (!found) throw Object.assign(new Error('no keys'), { status: 404 });
            return found;
        }
        throw new Error('unexpected network path ' + req.path);
    } },
    events: { publish: async () => {} },
    notify: async () => {},
    onReseal: async (ref, bytes, tx) => {
        // The member row must still be there while the service stores the re-seal.
        const left = await tx.one("SELECT count(*)::int AS n FROM share_members WHERE service=$1 AND kind=$2 AND resource_id=$3", [ref.service, ref.kind, ref.id]);
        hooks.push({ ref, bytes, members: Number(left.n) });
        if (resealDown) throw new Error('storage down');
    },
});
const fresh = async (lock = 'people') => {
    const ref = { service: 'community', kind: 'paste', id: `l${++seq}` };
    await shares.register(ref, { owner_subject: U, audience: 'people', lock });
    return ref;
};
const bad = (fn, status, code) => assert.rejects(fn, e => e.status === status && (!code || e.code === code));
/** A real people slot for that person's current key. */
const slotFor = id => locker.wrapFor(contentKey, KEYS[id].ecdh, { subject: SUBJECTS[id] });
/** A real people-locked envelope for whoever is named. */
const sealedFor = (ids, key = contentKey) => locker.seal('a note', { lock: 'people', keys: ids.map(id => ({ subject: SUBJECTS[id], publicKey: KEYS[id].ecdh })), contentKey: key });
const makePerson = async (subject, username) => {
    const person = await locker.generatePersonKeys();
    const published = await locker.exportPersonKeys(person);
    PEOPLE[subject.id] = { subject, username, display_name: username, avatar_url: null, banned: false };
    KEYS[subject.id] = { subject, ...published, updated_at: '2026-11-06T00:00:00Z' };
    return person;
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

(async () => {
    const keysOf = { u: await makePerson(U, 'ursula'), v: await makePerson(V, 'maticus'), x: await makePerson(X, 'xenia') };
    await shares.migrate();

    test('a share records its lock, GET answers it, and it is fixed once registered', async () => {
        const ref = await fresh('people');
        assert.equal((await shares.get(owner, ref)).lock, 'people');
        await bad(async () => shares.register(ref, { owner_subject: U, audience: 'people', lock: 'none' }), 409, 'share.exists');
        await bad(async () => shares.register(ref, { owner_subject: U, audience: 'people', lock: 'secret' }), 400, 'share.invalid');
        const open = await fresh('none');
        assert.equal((await shares.get(owner, open)).lock, 'none');
        // A save may echo the lock, never change it.
        await bad(async () => shares.update(owner, ref, { lock: 'none' }), 409, 'share.lock_fixed');
        assert.equal((await shares.update(owner, ref, { lock: 'people', audience: 'people' })).lock, 'people');
    });

    test('a locked item is never public, at registration or later', async () => {
        await bad(async () => shares.register({ service: 'community', kind: 'paste', id: `p${++seq}` },
            { owner_subject: U, audience: 'public', lock: 'people' }), 400, 'share.lock_public');
        const ref = await fresh('people');
        await bad(async () => shares.update(owner, ref, { audience: 'public' }), 400, 'share.lock_public');
        assert.equal((await shares.get(owner, ref)).audience, 'people');
    });

    test('a people-locked item needs a slot for every member, for that person and that key', async () => {
        const ref = await fresh();
        const slot = await slotFor(V.id);
        await bad(async () => shares.addMembers(owner, ref, [{ subject: V, role: 'viewer' }]), 400, 'share.slot_required');
        const theirs = await slotFor(X.id);
        await bad(async () => shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: theirs }]), 400, 'share.invalid');
        // The person changes their key: the slot they handed over is for the key they no longer have.
        await makePerson(V, 'maticus');
        time += 61000;
        await bad(async () => shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: slot }]), 409, 'share.key_changed');
        KEYS[V.id] = { subject: V, ...(await locker.exportPersonKeys(keysOf.v)), updated_at: '2026-11-06T00:00:00Z' };
        time += 61000;
        const added = await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: slot }]);
        assert.deepEqual(added.members[0].key_slot, slot);
        assert.equal(await shares.canView(recipient, ref), true);
    });

    test('a member with no locker key is refused, not assumed', async () => {
        const ref = await fresh();
        const slot = await slotFor(X.id);
        const kept = KEYS[X.id]; delete KEYS[X.id];
        try { await bad(async () => shares.addMembers(owner, ref, [{ subject: X, role: 'viewer', key_slot: slot }]), 409, 'share.no_key'); }
        // The miss is cached for a minute like a hit; let it expire so the next test sees the key again.
        finally { KEYS[X.id] = kept; time += 61000; }
    });

    test('removing somebody is a re-seal refused without an envelope and stored before the member goes', async () => {
        const ref = await fresh();
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]);
        await bad(async () => shares.update(owner, ref, { members: [] }), 400, 'share.reseal_required');
        await bad(async () => shares.update(owner, ref, { members: [], envelope: base64(Buffer.from('not an envelope')) }), 400, 'share.reseal_invalid');
        await bad(async () => shares.update(owner, ref, { members: [], envelope: base64((await sealedFor([U.id, V.id])).bytes) }), 400, 'share.reseal_invalid');
        assert.equal((await shares.get(owner, ref)).members.length, 1);

        const before = hooks.length;
        const sealed = await sealedFor([U.id]);
        const view = await shares.update(owner, ref, { members: [], envelope: base64(sealed.bytes) });
        assert.equal(view.members.length, 0);
        const hook = hooks[before];
        assert.deepEqual(hook.ref, ref);
        assert.equal(hook.members, 1, 'the hook runs before the member row goes');
        assert.equal(Buffer.compare(Buffer.from(hook.bytes), Buffer.from(sealed.bytes)), 0);
        assert.equal(await shares.canView(recipient, ref), false);
        // The same through removeMember, which is the service-side call.
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]);
        await bad(async () => shares.removeMember(owner, ref, V), 400, 'share.reseal_required');
        await shares.removeMember(owner, ref, V, { envelope: base64((await sealedFor([U.id])).bytes) });
        assert.equal((await shares.get(owner, ref)).members.length, 0);
    });

    test('a re-seal that still holds the leaving member\'s slot is refused', async () => {
        const ref = await fresh();
        const slot = await slotFor(V.id);
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: slot }]);
        // The envelope as it was: still holds V's slot.
        await bad(async () => shares.update(owner, ref, { members: [], envelope: base64((await sealedFor([U.id, V.id])).bytes) }), 400, 'share.reseal_invalid');
        assert.equal((await shares.get(owner, ref)).members.length, 1);
    });

    test('a re-seal must be fresh: the envelope already stored is refused', async () => {
        const ref = await fresh();
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]);
        const first = await sealedFor([U.id]);
        await shares.update(owner, ref, { members: [], envelope: base64(first.bytes) });
        // Somebody comes back, and the caller sends the envelope that is already stored: the content key
        // is the one the item had before, so the re-seal proves nothing.
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]);
        await bad(async () => shares.update(owner, ref, { members: [], envelope: base64(first.bytes) }), 400, 'share.reseal_not_fresh');
        assert.equal((await shares.get(owner, ref)).members.length, 1);
        // A new seal has a new nonce base, and it goes through.
        const second = await sealedFor([U.id]);
        assert.notEqual(second.header.nonce_base, first.header.nonce_base);
        assert.equal((await shares.update(owner, ref, { members: [], envelope: base64(second.bytes) })).members.length, 0);
    });

    test('a re-seal that wraps the old content key for a member who stays is refused', async () => {
        const ref = await fresh();
        // The stored envelope, and the member's slot is the one inside it (a member added for that very seal).
        const env = await sealedFor([U.id, V.id]);
        const fromEnvelope = env.header.slots.people.find(slot => slot.subject.id === V.id);
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: fromEnvelope }]);
        await shares.addMembers(owner, ref, [{ subject: X, role: 'viewer', key_slot: await slotFor(X.id) }]);
        // A member with no stored slot (what keep_access leaves) can go without a leaver-slot check, so the
        // only thing left to catch is the wrap V keeps.
        await db.exec("UPDATE share_members SET key_slot=NULL WHERE service='community' AND kind='paste' AND resource_id=$1 AND subject->>'id'=$2", [ref.id, X.id]);
        await bad(async () => shares.update(owner, ref, { members: [{ subject: V, role: 'viewer', key_slot: fromEnvelope }], envelope: base64(env.bytes) }), 400, 'share.reseal_not_fresh');
        assert.equal((await shares.get(owner, ref)).members.length, 2);
    });

    test('a transfer of a people-locked item needs the recipient\'s slot and drops the old owner', async () => {
        const ref = await fresh();
        await bad(async () => shares.transfer(owner, ref, { to: V }), 400, 'share.slot_required');
        const wrong = await slotFor(X.id);
        await bad(async () => shares.transfer(owner, ref, { to: V, key_slot: wrong }), 400, 'share.invalid');
        const offer = await shares.transfer(owner, ref, { to: V, key_slot: await slotFor(V.id) });
        assert.equal(offer.state, 'pending');
        assert.equal((await shares.accept(recipient, ref, offer.id)).state, 'accepted');
        const view = await shares.get(recipient, ref);
        assert.equal(view.owner_subject.id, V.id);
        assert.equal(view.members.length, 0);
        assert.equal(await shares.canView(owner, ref), false);
        // keep_access: the former owner stays a viewer, without a slot until the new owner wraps for them.
        const again = await fresh();
        const kept = await shares.transfer(owner, again, { to: V, keep_access: true, key_slot: await slotFor(V.id) });
        await shares.accept(recipient, again, kept.id);
        const keptView = await shares.get(recipient, again);
        assert.equal(keptView.members.length, 1);
        assert.equal(keptView.members[0].subject.id, U.id);
        assert.equal(keptView.members[0].key_slot, undefined);
        assert.equal(keptView.members[0].fingerprint_changed, true);
        assert.equal(await shares.canView(owner, again), true);
    });

    test('GET answers each member\'s slot, and for the owner the fingerprint and whether the key changed', async () => {
        const ref = await fresh();
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]);
        time += 61000;
        let view = await shares.get(owner, ref);
        assert.equal(slotKey(view.members[0].key_slot), view.members[0].key_slot.recipient_key);
        assert.equal(view.members[0].key_fingerprint, KEYS[V.id].fingerprint);
        assert.equal(view.members[0].fingerprint_changed, false);
        // Staff see the slot, not the owner's warning fields.
        const staff = await shares.get({ ...other, staff: true }, ref);
        assert.equal(staff.members[0].key_fingerprint, undefined);
        // The person changes their key: the old slot is still stored, and the sheet is told.
        KEYS[V.id] = { subject: V, ...(await locker.exportPersonKeys(await locker.generatePersonKeys())), updated_at: '2026-11-07T00:00:00Z' };
        time += 61000;
        view = await shares.get(owner, ref);
        assert.equal(view.members[0].fingerprint_changed, true);
        assert.equal(view.members[0].key_fingerprint, KEYS[V.id].fingerprint);
        KEYS[V.id] = { subject: V, ...(await locker.exportPersonKeys(keysOf.v)), updated_at: '2026-11-06T00:00:00Z' };
        time += 61000;
    });

    test('an unlocked item behaves exactly as before and refuses slots', async () => {
        const ref = await fresh('none');
        await bad(async () => shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]), 400, 'share.key_slot_unexpected');
        await shares.addMembers(owner, ref, ['@maticus']);
        assert.equal((await shares.get(owner, ref)).members[0].key_slot, undefined);
        await shares.removeMember(owner, ref, V);
        assert.equal(await shares.canView(recipient, ref), false);
        const offer = await shares.transfer(owner, ref, { to: V });
        const surplus = await slotFor(V.id);
        await bad(async () => shares.transfer(owner, ref, { to: V, key_slot: surplus }), 400, 'share.key_slot_unexpected');
        await shares.accept(recipient, ref, offer.id);
        assert.equal((await shares.get(recipient, ref)).owner_subject.id, V.id);
    });

    test('a service without the re-seal hook cannot remove somebody from a people-locked item', async () => {
        const ref = await fresh();
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]);
        const hookless = createShares({ db, now: () => time, network: { json: async () => null }, events: { publish: async () => {} }, notify: async () => {} });
        await bad(async () => hookless.update(owner, ref, { members: [], envelope: base64((await sealedFor([U.id])).bytes) }), 409, 'share.reseal_unavailable');
        assert.equal((await shares.get(owner, ref)).members.length, 1);
    });

    test('a failed re-seal store leaves the member and the old envelope in place', async () => {
        const ref = await fresh();
        await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', key_slot: await slotFor(V.id) }]);
        resealDown = true;
        try { await assert.rejects(async () => shares.update(owner, ref, { members: [], envelope: base64((await sealedFor([U.id])).bytes) }), /storage down/); }
        finally { resealDown = false; }
        assert.equal((await shares.get(owner, ref)).members.length, 1, 'a failed store leaves the member in place');
    });

    test('HTTP: the lock cannot be overridden by describe, the slot travels, and the body may carry a re-seal', async () => {
        const handler = shares.router({ service: 'community', authenticate: req => ({ owner, recipient, other })[(req.headers.authorization || '').replace('Bearer ', '')] || null,
            describe: async () => ({ lock: 'none' }) });
        const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
        const ref = await fresh();
        const base = `http://127.0.0.1:${server.address().port}`, path = `/api/v1/paste/${ref.id}/share`;
        try {
            assert.equal((await shares.get(owner, ref)).lock, 'people');
            const res = await fetch(base + path, { headers: { Authorization: 'Bearer owner' } });
            assert.equal(res.status, 200);
            assert.equal((await res.json()).lock, 'people', 'describe cannot claim an item is unlocked');
            const put = (body, headers = {}) => fetch(base + path, { method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
            const slot = await slotFor(V.id);
            assert.equal((await put({ members: [{ subject: V, role: 'viewer', key_slot: slot }] })).status, 200);
            assert.equal((await put({ members: [] })).status, 400);
            // A re-seal is bigger than an ACL edit and is allowed to be; anything else stays at 64 KiB.
            const big = await locker.seal('x'.repeat(90000), { lock: 'people', keys: [{ subject: U, publicKey: KEYS[U.id].ecdh }] });
            assert.ok(big.bytes.length > 65536);
            assert.equal((await put({ members: [], envelope: base64(big.bytes) })).status, 200);
            assert.equal((await put({ members: [], padding: 'x'.repeat(70000) })).status, 413);
        } finally { await new Promise(r => server.close(r)); }
    });

    test('the agent client wraps for a name and re-seals on removal', async () => {
        const shareHandler = shares.router({ service: 'community', authenticate: req => ({ owner, recipient, other })[(req.headers.authorization || '').replace('Bearer ', '')] || null });
        const server = http.createServer((req, res) => {
            const path = new URL(req.url, 'http://x').pathname;
            const keys = path.match(/^\/api\/v1\/people\/([^/]+)\/keys$/);
            if (keys) {
                const found = KEYS[decodeURIComponent(keys[1])];
                if (!found) { res.writeHead(404); res.end('{}'); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(found)); return;
            }
            if (path === '/api/v1/share/people') {
                const name = new URL(req.url, 'http://x').searchParams.get('name').replace(/^@/, '').toLowerCase();
                const person = Object.values(PEOPLE).find(p => p.username === name);
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ person: person || null })); return;
            }
            shareHandler(req, res);
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            const ref = await fresh();
            const client = share({ base, network: base, token: 'owner' }).for('paste', ref.id);
            const added = await client.addLocked('@maticus', { contentKey });
            assert.equal(added.members.length, 1);
            assert.equal(added.members[0].username, 'maticus');
            assert.equal(slotKey(added.members[0].key_slot), (await slotFor(V.id)).recipient_key);
            // The item as it is stored: sealed for the owner and the member.
            const item = await sealedFor([U.id, V.id]);
            const removed = await client.removeLocked('@maticus', { contentKey, envelope: item });
            assert.equal(removed.members.length, 0);
            assert.equal(hooks.at(-1).ref.id, ref.id);
            const stored = hooks.at(-1).bytes;
            assert.notEqual(Buffer.compare(Buffer.from(stored), Buffer.from(item.bytes)), 0, 'a fresh content key, a new envelope');
            assert.deepEqual(locker.inspect(stored).recipients, [await locker.jwkThumbprint(KEYS[U.id].ecdh)]);
            assert.deepEqual([...new Uint8Array(await locker.open(stored, { privateKey: keysOf.u.ecdh.privateKey, subject: U }))], [...Buffer.from('a note')]);
            // And a caller that already re-sealed can hand it over instead.
            await client.addLocked('@maticus', { contentKey });
            const ready = await sealedFor([U.id]);
            const second = await client.removeLocked('@maticus', { envelope: ready });
            assert.equal(second.members.length, 0);
            assert.equal(Buffer.compare(Buffer.from(hooks.at(-1).bytes), Buffer.from(ready.bytes)), 0);
        } finally { await new Promise(r => server.close(r)); }
    });

    let count = 0;
    try { for (const [name, fn] of tests) { await fn(); count++; console.log('ok ' + name); } console.log(`${count} locked-sharing tests passed`); }
    finally { await db.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
