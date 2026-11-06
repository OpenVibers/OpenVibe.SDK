'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../src/db');
const { createShares, share, shareOpenApi } = require('../src/share');
const contracts = require('openvibe-contracts');
const U = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' };
const V = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR' };
const X = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS' };
const owner = { subject: U }, recipient = { subject: V }, other = { subject: X };
const PEOPLE = {
    [U.id]: { subject: U, username: 'ursula', display_name: 'Ursula', avatar_url: null, banned: false },
    [V.id]: { subject: V, username: 'maticus', display_name: 'Maticus', avatar_url: 'https://cdn.example/avatars/maticus.png', banned: false },
    [X.id]: { subject: X, username: 'xenia', display_name: 'Xenia', avatar_url: null, banned: false },
};
const db = createDb({ pglite: true });
let time = Date.parse('2026-11-06T00:00:00Z'), seq = 0, failHook = false, failNotify = false;
const published = [], notified = [], lookups = [], hooks = [];
const options = { db, now: () => time, nameLimit: 3,
    network: { json: async req => {
        lookups.push(req);
        if (req.path === '/internal/identity/resolve-batch') {
            const results = {};
            for (const id of req.json.subject_ids) results[id] = PEOPLE[id] || null;
            return { results };
        }
        return req.query.username.toLowerCase() === 'maticus' ? { ...PEOPLE[V.id] } : null;
    } },
    events: { publish: async e => {
        assert.equal(contracts.validate(e.event_type, e.payload).valid, true, JSON.stringify(contracts.validate(e.event_type, e.payload).errors));
        assert.equal(contracts.validate('events.event-envelope', e).valid, true, JSON.stringify(contracts.validate('events.event-envelope', e).errors));
        published.push(e);
    } },
    notify: async n => { if (failNotify) throw Error('notification down'); notified.push(n); },
    onOwnerChange: async (ref, from, to, t) => { assert.ok(t.exec); hooks.push(['owner', ref, from, to]); if (failHook) throw Error('hook failed'); },
    onAudienceChange: async (ref, audience, t) => { assert.ok(t.exec); hooks.push(['audience', ref, audience]); if (failHook) throw Error('hook failed'); },
};
const shares = createShares(options);
const fresh = async (audience = 'people') => { const ref = { service: 'community', kind: 'paste', id: `p${++seq}` }; await shares.register(ref, { owner_subject: U, audience }); return ref; };
const denied = (fn, status = 404) => assert.rejects(fn, e => e.status === status);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('migration is repeatable and append-only log rejects all mutation', async () => {
    await shares.migrate(); await shares.migrate(); const ref = await fresh();
    await assert.rejects(db.exec('DELETE FROM share_log'), /append-only/);
    await assert.rejects(db.exec("UPDATE share_log SET action='changed'"), /append-only/);
    await assert.rejects(db.exec('TRUNCATE share_log'), /append-only/);
    assert.equal((await shares.get(owner, ref)).owner_subject.id, U.id);
});
test('every audience and role, anonymous, owner, stranger, staff and missing resource', async () => {
    for (const audience of ['public', 'link', 'people', 'private']) for (const role of ['viewer', 'editor']) {
        const ref = await fresh(audience); await shares.addMembers(owner, ref, [{ subject: V, role }]);
        assert.equal(await shares.canView(null, ref), ['public', 'link'].includes(audience));
        assert.equal(await shares.canEdit(null, ref), false);
        assert.equal(await shares.canView(other, ref), ['public', 'link'].includes(audience));
        assert.equal(await shares.canEdit(other, ref), false);
        assert.equal(await shares.canView(recipient, ref), audience !== 'private');
        assert.equal(await shares.canEdit(recipient, ref), audience === 'people' && role === 'editor');
        assert.equal(await shares.canView(owner, ref), true); assert.equal(await shares.canEdit(owner, ref), true);
        assert.equal(await shares.canView({ ...other, staff: true }, ref), true);
        assert.equal(await shares.canEdit({ ...other, staff: true }, ref), true);
        await denied(() => shares.get(other, ref));
    }
    assert.equal(await shares.canView(owner, { service: 'community', kind: 'paste', id: 'missing' }), false);
    assert.equal(await db.value("SELECT count(*) FROM share_log WHERE action='staff.view'"), 8);
    assert.equal(await db.value("SELECT count(*) FROM share_log WHERE action='staff.edit'"), 8);
});
test('addMembers accepts canonical subject refs as viewers', async () => {
    const ref = await fresh(); await shares.addMembers(owner, ref, [V]);
    assert.equal(await shares.canView(recipient, ref), true); assert.equal(await shares.canEdit(recipient, ref), false);
});
test('nonowner cannot manage ACL or resolve accounts; editor cannot escalate', async () => {
    const ref = await fresh(); await shares.addMembers(owner, ref, [{ subject: V, role: 'editor' }]); const before = lookups.length;
    for (const viewer of [recipient, other]) {
        await denied(() => shares.addMembers(viewer, ref, ['@maticus']));
        await denied(() => shares.setAudience(viewer, ref, 'public'));
        await denied(() => shares.removeMember(viewer, ref, V));
        await denied(() => shares.transfer(viewer, ref, { to: '@maticus' }));
    }
    assert.equal(lookups.length, before);
});
test('member expiry fails closed exactly at expiry and sweep logs and emits once', async () => {
    const ref = await fresh(); await shares.addMembers(owner, ref, [{ subject: V, role: 'editor', expires_at: new Date(time + 1000).toISOString() }]);
    assert.equal(await shares.canEdit(recipient, ref), true); time += 1000;
    assert.equal(await shares.canView(recipient, ref), false); assert.equal(await shares.canEdit(recipient, ref), false);
    assert.equal((await shares.get(owner, ref)).members.length, 0);
    await shares.expireMembers(); const count = await db.value("SELECT count(*) FROM share_log WHERE action='member.removed'");
    await shares.expireMembers(); assert.equal(await db.value("SELECT count(*) FROM share_log WHERE action='member.removed'"), count);
});
test('exact names use Network subject object; unknown, wildcard, malformed and banned fail closed', async () => {
    time += 60000; const ref = await fresh(); await shares.addMembers(owner, ref, ['@maticus']);
    assert.equal(await shares.canView(recipient, ref), true);
    assert.deepEqual(lookups.at(-1).query, { username: 'maticus' }); assert.equal(lookups.at(-1).path, '/internal/identity/resolve');
    await denied(() => shares.addMembers(owner, ref, ['@nobody']), 400);
    const before = lookups.length; await denied(() => shares.addMembers(owner, ref, ['@mat*']), 400); assert.equal(lookups.length, before);
    const broken = createShares({ ...options, network: { json: async () => ({ subject: V.id, username: 'maticus' }) } });
    await denied(() => broken.addMembers(owner, ref, ['@maticus']), 400);
    time += 60000;
    const banned = createShares({ ...options, network: { json: async () => ({ subject: V, username: 'maticus', banned: true }) } });
    await denied(() => banned.addMembers(owner, ref, ['@maticus']), 400);
    const fuzzy = createShares({ ...options, network: { json: async () => ({ subject: V, username: 'maticus-other' }) } });
    await denied(() => fuzzy.addMembers(owner, ref, ['@maticus']), 400);
});
test('per-caller name rate limit is shared across instances and failures; resets by window', async () => {
    time += 60000; const ref = await fresh();
    for (let i = 0; i < 3; i++) await denied(() => shares.addMembers(owner, ref, ['@absent']), 400);
    const before = lookups.length;
    await denied(() => createShares(options).addMembers(owner, ref, ['@maticus']), 429); assert.equal(lookups.length, before);
    await shares.register({ ...ref, id: 'owned-by-v' }, { owner_subject: V, audience: 'people' });
    await denied(() => shares.addMembers(recipient, { ...ref, id: 'owned-by-v' }, ['@absent']), 400);
    time += 60000; await shares.addMembers(owner, ref, ['@maticus']);
});
test('requestAccess notifies owner once, denies anonymous/private/public and resolves on add', async () => {
    const ref = await fresh(); const a = await shares.requestAccess(recipient, ref); const b = await shares.requestAccess(recipient, ref);
    assert.equal(a.id, b.id); await shares.flush({ limit: 1000 });
    const notices = notified.filter(n => n.kind === 'share.access_requested' && n.ref.id === ref.id);
    assert.equal(notices.length, 1); assert.deepEqual(notices[0].to, U); assert.deepEqual(notices[0].actor, V);
    await denied(() => shares.requestAccess(null, ref));
    for (const audience of ['public', 'private', 'link']) { const hiddenRef = await fresh(audience); await denied(() => shares.requestAccess(recipient, hiddenRef)); }
    await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer' }]);
    assert.equal(await db.value('SELECT state FROM share_access_requests WHERE id=$1', [a.id]), 'granted');
});
test('transfer preview only for bound recipient, default removes old access; history logs both directions', async () => {
    const ref = await fresh('private'); const tr = await shares.transfer(owner, ref, { to: V });
    assert.equal(tr.keep_access, false); assert.equal(Date.parse(tr.expires_at) - Date.parse(tr.requested_at), 7 * 86400000);
    assert.equal(await shares.canView(recipient, ref), true); assert.equal(await shares.canEdit(recipient, ref), false);
    assert.equal(await shares.canView(other, ref), false);
    await denied(() => shares.accept(other, ref, tr.id)); await denied(() => shares.accept({ ...other, staff: true }, ref, tr.id));
    await denied(() => shares.decline(other, ref, tr.id)); await denied(() => shares.cancel(recipient, ref, tr.id));
    const accepted = await shares.accept(recipient, ref, tr.id); assert.equal(accepted.state, 'accepted');
    assert.equal(await shares.canView(owner, ref), false); assert.equal(await shares.canEdit(recipient, ref), true);
    assert.deepEqual((await shares.get(recipient, ref)).owner_subject, V);
    assert.equal(await db.value("SELECT count(*) FROM share_log WHERE resource_id=$1 AND action IN ('ownership.outgoing','ownership.incoming')", [ref.id]), 2);
    await denied(() => shares.accept(recipient, ref, tr.id), 409);
});
test('keep_access false removes preexisting membership and true retains only viewer including private', async () => {
    for (const keep_access of [false, true]) for (const audience of ['people', 'private', 'public', 'link']) {
        const ref = await fresh(audience); await shares.addMembers(owner, ref, [{ subject: V, role: 'editor' }]);
        const tr = await shares.transfer(owner, ref, { to: V, keep_access }); await shares.accept(recipient, ref, tr.id);
        assert.equal(await shares.canView(owner, ref), keep_access || ['public', 'link'].includes(audience)); assert.equal(await shares.canEdit(owner, ref), false);
        const state = await shares.get(recipient, ref); assert.equal(state.members.length, keep_access ? 1 : 0);
        if (keep_access) { assert.deepEqual(state.members[0].subject, U); assert.equal(state.members[0].role, 'viewer'); assert.equal(state.audience, audience === 'private' ? 'people' : audience); }
    }
});
test('decline, cancel, expiry keep owner; stale actions cannot consume a newer transfer', async () => {
    for (const action of ['decline', 'cancel', 'expire']) {
        const ref = await fresh('private'); const tr = await shares.transfer(owner, ref, { to: V });
        if (action === 'expire') { time += 7 * 86400000; assert.equal(await shares.canView(recipient, ref), false); await denied(() => shares.accept(recipient, ref, tr.id), 409); await shares.expireMembers(); }
        else await shares[action](action === 'cancel' ? owner : recipient, ref, tr.id);
        assert.equal(await shares.canView(recipient, ref), false); assert.equal(await shares.canEdit(owner, ref), true);
        assert.equal(await db.value('SELECT state FROM share_transfers WHERE id=$1', [tr.id]), { decline: 'declined', cancel: 'cancelled', expire: 'expired' }[action]);
        const next = await shares.transfer(owner, ref, { to: V }); await denied(() => shares.accept(recipient, ref, tr.id), 409);
        await shares.accept(recipient, ref, next.id);
    }
});
test('competing transfer actions serialize and only one ownership change wins', async () => {
    const ref = await fresh(); const tr = await shares.transfer(owner, ref, { to: V });
    await denied(() => shares.transfer(owner, ref, { to: X }), 409);
    const results = await Promise.allSettled([shares.accept(recipient, ref, tr.id), shares.accept(recipient, ref, tr.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('staff may narrow only: private and removals, never widen, add or raise a role', async () => {
    const staff = { ...other, staff: true }, ref = await fresh('public');
    await shares.setAudience(staff, ref, 'private');
    assert.equal((await shares.get(owner, ref)).audience, 'private');
    await denied(() => shares.setAudience(staff, ref, 'people'));
    await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer' }]);
    await shares.removeMember(staff, ref, V);
    assert.equal(await shares.canView(recipient, ref), false);
    await denied(() => shares.addMembers(staff, ref, [{ subject: X, role: 'viewer' }]));
    await shares.addMembers(owner, ref, [{ subject: V, role: 'editor' }]);
    await denied(() => shares.update(staff, ref, { members: [{ subject: V, role: 'viewer' }] }));
    await denied(() => shares.update(staff, ref, { audience: 'public', members: [] }));
    assert.ok(await db.value("SELECT count(*) FROM share_log WHERE resource_id=$1 AND action='staff.manage'", [ref.id]));
    await denied(() => shares.transfer(staff, ref, { to: V }));
});
test('hooks run inside transaction; failure rolls back ACL, ownership, log and deliveries', async () => {
    const ref = await fresh('private'); const tr = await shares.transfer(owner, ref, { to: V });
    const before = await db.value('SELECT count(*) FROM share_log'); const deliveries = await db.value('SELECT count(*) FROM share_deliveries');
    failHook = true;
    await assert.rejects(shares.accept(recipient, ref, tr.id), /hook failed/);
    await assert.rejects(shares.setAudience(owner, ref, 'public'), /hook failed/);
    failHook = false;
    assert.equal((await shares.get(owner, ref)).audience, 'private'); assert.equal(await shares.canEdit(owner, ref), true);
    assert.equal(await db.value('SELECT count(*) FROM share_log'), before); assert.equal(await db.value('SELECT count(*) FROM share_deliveries'), deliveries);
    await shares.accept(recipient, ref, tr.id);
});
test('atomic PUT rejects invalid batch, replaces membership and enforces ETag', async () => {
    const ref = await fresh(); const old = await shares.getWithRevision(owner, ref);
    await denied(() => shares.update(owner, ref, { audience: 'public', members: [{ subject: V, role: 'owner' }] }), 400);
    assert.equal((await shares.get(owner, ref)).audience, 'people');
    await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer' }]);
    await denied(() => shares.update(owner, ref, { members: [] }, { ifMatch: old.etag }), 412);
    await shares.update(owner, ref, { members: [{ subject: X, role: 'editor' }] });
    assert.equal(await shares.canView(recipient, ref), false); assert.equal(await shares.canEdit(other, ref), true);
    await shares.removeMember(owner, ref, X); assert.equal(await shares.canView(other, ref), false);
});
test('shared-with-me is isolated, paginated, excludes hidden/expired memberships, includes pending preview', async () => {
    const ref = await fresh('private'); await shares.addMembers(owner, ref, [{ subject: X, role: 'viewer' }]);
    assert.ok(!(await shares.sharedWithMe(other)).items.some(i => i.ref.id === ref.id));
    const tr = await shares.transfer(owner, ref, { to: X });
    assert.ok((await shares.sharedWithMe(other)).items.some(i => i.ref.id === ref.id && i.transfer.id === tr.id));
    const first = await shares.sharedWithMe(recipient, { limit: 1 }); assert.equal(first.items.length, 1); assert.ok(first.next_cursor);
    const second = await shares.sharedWithMe(recipient, { limit: 1, cursor: first.next_cursor }); assert.notDeepEqual(first.items, second.items);
    assert.equal(contracts.validate('share.list-result', first).valid, true);
    assert.deepEqual((await shares.sharedWithMe(recipient, { service: 'wiki' })).items, []);
    await denied(() => shares.sharedWithMe(null)); await denied(() => shares.sharedWithMe(owner, { cursor: 'junk' }), 400);
});
test('events validate, leak no title/content; failed notification stays durable and retries with same id', async () => {
    const ref = await fresh('people'); await shares.addMembers(owner, ref, [{ subject: X, role: 'viewer' }]);
    failNotify = true; await assert.rejects(shares.flush({ limit: 1000 }), /notification down/); failNotify = false;
    const queued = await db.many("SELECT id FROM share_deliveries WHERE channel='notify' AND delivered_at IS NULL");
    assert.ok(queued.length); await shares.flush({ limit: 1000 });
    assert.ok(notified.some(n => n.delivery_id === queued[0].id));
    for (const event of published) assert.ok(!/"(?:title|content)"/.test(JSON.stringify(event)));
    assert.ok(published.some(e => e.payload.audience === 'private')); assert.ok(published.some(e => e.payload.audience === 'people'));
    assert.equal(await db.value('SELECT count(*) FROM share_deliveries WHERE delivered_at IS NULL'), 0);
});
test('saving unchanged members preserves history and does not notify them again', async () => {
    const ref = await fresh(); await shares.addMembers(owner, ref, [V]);
    const before = (await shares.get(owner, ref)).members[0].added_at;
    const delivered = await db.value('SELECT count(*) FROM share_deliveries');
    time += 1; await shares.update(owner, ref, { members: [{ subject: V, role: 'viewer' }] });
    assert.equal((await shares.get(owner, ref)).members[0].added_at, before);
    assert.equal(await db.value('SELECT count(*) FROM share_deliveries'), delivered);
});
test('grant revocation reasons preserve independent preview/member state and delivery order', async () => {
    const ref = await fresh('people'); await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer' }]);
    const tr = await shares.transfer(owner, ref, { to: V }); await shares.cancel(owner, ref, tr.id);
    assert.equal(await shares.canView(recipient, ref), true);
    await shares.removeMember(owner, ref, V); assert.equal(await shares.canView(recipient, ref), false);
    await shares.flush({ limit: 1000 });
    const events = published.filter(e => e.payload.ref.id === ref.id);
    assert.deepEqual(events.map(e => e.event_type), ['share.granted', 'share.transfer.requested', 'share.revoked', 'share.revoked']);
    assert.equal(events[2].payload.reason, 'transfer_cancelled'); assert.equal(events[2].payload.transfer_id, tr.id);
    assert.equal(events[3].payload.reason, 'member_removed');
});
test('name resolution cannot authorize a former owner after concurrent transfer', async () => {
    time += 60000; const ref = await fresh(); const tr = await shares.transfer(owner, ref, { to: V });
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const waiting = createShares({ ...options, network: { json: async () => { entered(); return new Promise(resolve => { release = resolve; }); } } });
    const adding = waiting.addMembers(owner, ref, ['@maticus']);
    await started; await shares.accept(recipient, ref, tr.id);
    release({ subject: V, username: 'maticus' }); await denied(() => adding);
    assert.equal((await shares.get(recipient, ref)).members.length, 0);
});
test('invalid calendar expiry and unknown audience/role never change ACL', async () => {
    const ref = await fresh();
    await denied(() => shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', expires_at: '2030-02-31T00:00:00Z' }]), 400);
    await denied(() => shares.setAudience(owner, ref, 'unlisted'), 400);
    await denied(() => shares.addMembers(owner, ref, [{ subject: V, role: 'admin' }]), 400);
    assert.equal((await shares.get(owner, ref)).members.length, 0);
});
test('ambient transactions cannot refund name limits or publish uncommitted deliveries', async () => {
    const ref = await fresh(); const before = lookups.length;
    await assert.rejects(db.tx(() => shares.addMembers(owner, ref, ['@absent'])), /outside an ambient transaction/);
    assert.equal(lookups.length, before);
    await assert.rejects(db.tx(() => shares.flush()), /outside an ambient transaction/);
});
test('external event failure retries the same stable event id', async () => {
    const ref = await fresh(); await shares.addMembers(owner, ref, [{ subject: X, role: 'viewer' }]);
    const seen = []; let fail = true;
    const retrying = createShares({ ...options, events: { publish: async e => { seen.push(e.event_id); if (fail) throw Error('delivery interrupted'); } } });
    await assert.rejects(retrying.flush(), /delivery interrupted/); fail = false;
    await retrying.flush(); assert.equal(seen[0], seen[1]);
});
test('HTTP uniform routes, agent client, generic 404, forged subjects and staff flags rejected', async () => {
    const ref = await fresh('private'); const handler = shares.router({ service: 'community', authenticate: req => ({ owner, recipient, other })[(req.headers.authorization || '').replace('Bearer ', '')] || null });
    const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`; const path = `/api/v1/paste/${ref.id}/share`;
    try {
        for (const token of ['other', 'recipient', '']) {
            const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
            assert.equal(res.status, 404); assert.equal(await res.text(), '{"code":"share.not_found","error":"Not found"}');
            assert.equal(res.headers.get('cache-control'), 'private, no-store');
        }
        const forged = await fetch(base + path, { method: 'PUT', headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'public', staff: true, subject: U }) });
        assert.equal(forged.status, 400); assert.equal(await shares.canView(other, ref), false);
        const client = share({ base, token: 'owner' }).for('paste', ref.id);
        time += 60000;
        await assert.rejects(client.add('@nobody'), e => e.status === 400 && e.code === 'share.name_not_found');
        assert.equal((await client.get()).audience, 'private'); await client.setAudience('people');
        time += 60000; await client.add('@maticus'); assert.equal(await shares.canView(recipient, ref), true);
        await client.add('@maticus', { role: 'editor' }); assert.equal(await shares.canEdit(recipient, ref), true);
        await client.remove(V); assert.equal(await shares.canView(recipient, ref), false);
        const remote = share({ base, token: 'recipient' }).for('paste', ref.id);
        const request = await remote.requestAccess(); assert.equal(request.state, 'pending');
        time += 60000;
        const tr = await client.transfer('@maticus', { keep_access: true });
        assert.equal((await remote.accept(tr.transfer.id)).state, 'accepted');
        assert.equal((await remote.get()).owner_subject.id, V.id);
        assert.ok((await share({ base, token: 'owner' }).sharedWithMe()).items.some(i => i.ref.id === ref.id));
        assert.equal(Object.keys(shareOpenApi().paths).length, 9);
    } finally { await new Promise(r => server.close(r)); }
});
test('access checks take no row lock; writes still lock', async () => {
    const ref = await fresh();
    const statements = [];
    const spy = Object.create(db);
    spy.tx = (fn, opts) => db.tx(t => fn(new Proxy(t, { get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args) => { if (typeof args[0] === 'string') statements.push(args[0]); return value.apply(target, args); };
    } })), opts);
    const checked = createShares({ ...options, db: spy });
    statements.length = 0;
    await checked.canView(owner, ref); await checked.canEdit(owner, ref);
    assert.ok(statements.some(q => /FROM shares/.test(q)));
    assert.ok(!statements.some(q => /FROM shares[\s\S]*FOR UPDATE/.test(q)), 'reads must not lock the sharing row');
    statements.length = 0;
    await checked.update(owner, ref, { audience: 'public' });
    assert.ok(statements.some(q => /FROM shares[\s\S]*FOR UPDATE/.test(q)), 'writes keep their lock');
});
test('a member or transfer recipient must be a known, active user subject', async () => {
    const ref = await fresh();
    const guest = { type: 'guest', id: 'gst_01JAB2C3D4E5F6G7H8J9K0MNPQ' };
    const unknown = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0ZZZZ' };
    await denied(() => shares.addMembers(owner, ref, [guest]), 400);
    await denied(() => shares.addMembers(owner, ref, [unknown]), 400);
    await denied(() => shares.transfer(owner, ref, { to: guest }), 400);
    const flagged = flag => createShares({ ...options, network: { json: async req => {
        if (req.path !== '/internal/identity/resolve-batch') return null;
        const results = {};
        for (const id of req.json.subject_ids) results[id] = id === V.id ? { ...PEOPLE[V.id], banned: flag === 'banned', deleted: flag === 'deleted' } : null;
        return { results };
    } } });
    for (const flag of ['banned', 'deleted']) {
        const strict = flagged(flag);
        await denied(() => strict.addMembers(owner, ref, [{ subject: V, role: 'viewer' }]), 400);
        await denied(() => strict.transfer(owner, ref, { to: V }), 400);
    }
    time += 60000;
    const tombstone = createShares({ ...options, network: { json: async () => ({ ...PEOPLE[V.id], deleted: true }) } });
    await denied(() => tombstone.addMembers(owner, ref, ['@maticus']), 400);
});
test('notifications: a new member hears once; role, expiry, removal and the owner\'s own change stay quiet', async () => {
    await shares.flush({ limit: 1000 });
    const ref = await fresh('people');
    const added = () => notified.filter(n => n.kind === 'share.added' && n.ref.id === ref.id).length;
    await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer' }]); await shares.flush({ limit: 1000 });
    assert.equal(added(), 1);
    await shares.update(owner, ref, { members: [{ subject: V, role: 'editor' }] }); await shares.flush({ limit: 1000 });
    assert.equal(added(), 1);
    await shares.update(owner, ref, { audience: 'private' }); await shares.flush({ limit: 1000 });
    assert.equal(added(), 1);
    await shares.removeMember(owner, ref, V); await shares.flush({ limit: 1000 });
    assert.equal(added(), 1);
    await shares.addMembers(owner, ref, [{ subject: V, role: 'viewer', expires_at: new Date(time + 60000).toISOString() }]);
    await shares.flush({ limit: 1000 });
    assert.equal(added(), 2);
});
test('transfer notifications: recipient hears the offer and a cancellation; the owner hears the answer', async () => {
    await shares.flush({ limit: 1000 });
    const ref = await fresh('private');
    const offers = () => notified.filter(n => n.kind === 'share.transfer.requested' && n.ref.id === ref.id);
    const answers = () => notified.filter(n => n.kind === 'share.transfer.answered' && n.ref.id === ref.id);
    const tr = await shares.transfer(owner, ref, { to: V }); await shares.flush({ limit: 1000 });
    assert.equal(offers().length, 1); assert.equal(offers()[0].to.id, V.id);
    await shares.cancel(owner, ref, tr.id); await shares.flush({ limit: 1000 });
    assert.ok(answers().some(n => n.to.id === V.id && n.state === 'cancelled'));
    assert.ok(!answers().some(n => n.to.id === U.id));
    const tr2 = await shares.transfer(owner, ref, { to: V });
    await shares.accept(recipient, ref, tr2.id); await shares.flush({ limit: 1000 });
    assert.ok(answers().some(n => n.to.id === U.id && n.state === 'accepted'));
    assert.ok(!answers().some(n => n.to.id === V.id && n.state === 'accepted'));
    const ref2 = await fresh('private'); const tr3 = await shares.transfer(owner, ref2, { to: V });
    await shares.decline(recipient, ref2, tr3.id); await shares.flush({ limit: 1000 });
    assert.ok(notified.some(n => n.kind === 'share.transfer.answered' && n.ref.id === ref2.id && n.to.id === U.id && n.state === 'declined'));
    const ref3 = await fresh('private'); await shares.transfer(owner, ref3, { to: V });
    time += 7 * 86400000; await shares.expireMembers(); await shares.flush({ limit: 1000 });
    assert.ok(notified.some(n => n.kind === 'share.transfer.answered' && n.ref.id === ref3.id && n.to.id === U.id && n.state === 'expired'));
});
test('PUT notify:false sends no share.added but events still flow', async () => {
    await shares.flush({ limit: 1000 });
    const ref = await fresh('people');
    const added = () => notified.filter(n => n.kind === 'share.added' && n.ref.id === ref.id).length;
    const events = () => published.filter(e => e.payload.ref.id === ref.id).length;
    await shares.update(owner, ref, { members: [{ subject: V, role: 'viewer' }], notify: false });
    await shares.flush({ limit: 1000 });
    assert.equal(added(), 0); assert.equal(events(), 1);
    await denied(() => shares.update(owner, ref, { notify: 'yes' }), 400);
});
test('HTTP answers the sheet: people, you, describe, requests, dismiss and the GET body on writes', async () => {
    time += 60000;
    const ref = await fresh('people');
    await shares.requestAccess(other, ref);
    const staff = { ...other, staff: true };
    const handler = shares.router({ service: 'community',
        describe: r => ({ title: `Paste ${r.id}`, link: `https://community.example/p/${r.id}`, roles: ['viewer', 'editor'] }),
        authenticate: req => ({ owner, recipient, other, staff })[(req.headers.authorization || '').replace('Bearer ', '')] || null });
    const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`, path = `/api/v1/paste/${ref.id}/share`;
    const json = (method, url, token, value) => fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    try {
        const res = await json('GET', path, 'owner'); const view = await res.json(); const etag = res.headers.get('etag');
        assert.equal(res.status, 200);
        assert.equal(view.owner.username, 'ursula'); assert.deepEqual(view.you, { subject: U, role: 'owner' });
        assert.equal(view.title, `Paste ${ref.id}`); assert.equal(view.link, `https://community.example/p/${ref.id}`); assert.deepEqual(view.roles, ['viewer', 'editor']);
        assert.deepEqual(view.audiences, ['public', 'link', 'people', 'private']); assert.equal(view.transferable, true);
        assert.equal(view.requests.length, 1); assert.equal(view.requests[0].username, 'xenia'); assert.ok(view.requests[0].id);
        assert.equal((await (await json('GET', path, 'staff')).json()).you.role, 'staff');
        const put = await json('PUT', path, 'owner', { audience: 'people', members: [{ subject: V, role: 'viewer' }], notify: false });
        const saved = await put.json();
        assert.equal(put.status, 200); assert.ok(put.headers.get('etag')); assert.notEqual(put.headers.get('etag'), etag);
        assert.equal(saved.members.length, 1); assert.equal(saved.members[0].username, 'maticus'); assert.equal(saved.members[0].avatar_url, PEOPLE[V.id].avatar_url);
        const dismissed = await json('POST', `${path}/requests/${view.requests[0].id}/dismiss`, 'owner', {});
        assert.equal(dismissed.status, 200); assert.equal((await dismissed.json()).requests.length, 0);
        assert.equal(await db.value('SELECT state FROM share_access_requests WHERE id=$1', [view.requests[0].id]), 'dismissed');
        const started = await json('POST', `${path}/transfer`, 'owner', { to: { subject: V }, keep_access: true });
        const offer = await started.json();
        assert.equal(started.status, 201); assert.equal(offer.transfer.to.username, 'maticus'); assert.equal(offer.transfer.state, 'pending');
        assert.equal(offer.title, `Paste ${ref.id}`);
        const cancelled = await json('POST', `${path}/transfer/cancel`, 'owner', { transfer_id: offer.transfer.id });
        assert.equal(cancelled.status, 200); const afterCancel = await cancelled.json();
        assert.equal(afterCancel.transfer, undefined); assert.equal(afterCancel.audience, 'people');
        const second = await (await json('POST', `${path}/transfer`, 'owner', { to: { subject: V } })).json();
        const accepted = await json('POST', `${path}/transfer/accept`, 'recipient', { transfer_id: second.transfer.id });
        const answer = await accepted.json();
        assert.equal(accepted.status, 200); assert.equal(answer.state, 'accepted'); assert.equal(answer.id, second.transfer.id); assert.equal(answer.audience, undefined);
        const person = await (await json('GET', `/api/v1/share/people?name=maticus`, 'owner')).json();
        assert.equal(person.person.username, 'maticus'); assert.deepEqual(person.person.subject, V);
        const nobody = await (await json('GET', `/api/v1/share/people?name=nobody`, 'owner')).json();
        assert.equal(nobody.person, null);
        assert.equal((await fetch(base + '/api/v1/share/people?name=maticus')).status, 404);
    } finally { await new Promise(r => server.close(r)); }
});
test('CSRF: cookie writes need X-Requested-With or a same-site marker; bearer is exempt and csrf:false disables it', async () => {
    const ref = await fresh('private');
    const authenticate = req => req.headers.cookie === 'sid=owner' ? owner : ({ owner, recipient, other })[(req.headers.authorization || '').replace('Bearer ', '')] || null;
    const listen = handler => http.createServer(handler);
    const server = listen(shares.router({ service: 'community', authenticate }));
    const loose = listen(shares.router({ service: 'community', authenticate, csrf: false }));
    await new Promise(r => server.listen(0, '127.0.0.1', r)); await new Promise(r => loose.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`, looseBase = `http://127.0.0.1:${loose.address().port}`;
    const path = `/api/v1/paste/${ref.id}/share`;
    const write = (root, headers, value) => fetch(root + path, { method: 'PUT', headers: { Cookie: 'sid=owner', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
    try {
        let res = await write(base, {}, { audience: 'public' });
        assert.equal(res.status, 403); assert.equal((await res.json()).code, 'share.csrf');
        assert.equal((await shares.get(owner, ref)).audience, 'private');
        assert.equal((await write(base, { 'X-Requested-With': 'ov-share' }, { audience: 'public' })).status, 200);
        await shares.setAudience(owner, ref, 'private');
        assert.equal((await write(base, { 'Sec-Fetch-Site': 'same-origin' }, { audience: 'public' })).status, 200);
        await shares.setAudience(owner, ref, 'private');
        res = await fetch(base + path, { method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'public' }) });
        assert.equal(res.status, 200);
        await shares.setAudience(owner, ref, 'private');
        assert.equal((await write(looseBase, {}, { audience: 'public' })).status, 200);
    } finally {
        await new Promise(r => server.close(r)); await new Promise(r => loose.close(r));
    }
});
(async () => {
    let count = 0;
    try { for (const [name, fn] of tests) { await fn(); count++; console.log('ok ' + name); } console.log(`${count} sharing tests passed`); }
    finally { await db.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
