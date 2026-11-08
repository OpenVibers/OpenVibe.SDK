'use strict';
const assert = require('node:assert/strict');
const { createDb } = require('../src/db');
const { createShares } = require('../src/share');
const { inspectEnvelopePrefix } = require('../src/locker/server');
const locker = require('../src/locker');
(async () => {
    const db = createDb({ pglite: true });
    const subject = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' };
    const other = { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR' };
    const person = await locker.generatePersonKeys(), friend = await locker.generatePersonKeys();
    const friendPublic = await locker.exportPersonKeys(friend);
    const ref = { service: 'locker', kind: 'files', id: 'streamed-file' };
    const sealed = await locker.seal(new Uint8Array(9 * 1024 ** 2), { lock: 'people', keys: [{ subject, publicKey: person.ecdhPublic }, { subject: other, publicKey: friend.ecdhPublic }] });
    const prefix = sealed.bytes.subarray(0, sealed.chunkOffset);
    assert.ok(inspectEnvelopePrefix(prefix, sealed.bytes.length).valid);
    assert.equal(inspectEnvelopePrefix(prefix, sealed.bytes.length - 1).valid, false);
    assert.equal(inspectEnvelopePrefix(prefix, sealed.bytes.length + 1).valid, false);
    assert.equal(inspectEnvelopePrefix(prefix.subarray(0, -1), sealed.bytes.length).valid, false);
    const stored = new Map([['upload-1', { prefix, byteLength: sealed.bytes.length }]]);
    let committed = 0, failCommit = false;
    const shares = createShares({ db, network: { json: async (req) => {
        if (req.path.endsWith('/keys')) return friendPublic;
        if (req.path.endsWith('resolve-batch')) return { results: { [subject.id]: { subject, username: 'owner' }, [other.id]: { subject: other, username: 'friend' } } };
        return { subject: other, username: 'friend' };
    } }, events: { publish: async () => {} }, notify: async () => {},
    resolveReseal: async (resource, viewer, receipt) => {
        assert.deepEqual(resource, ref); assert.deepEqual(viewer.subject, subject); return stored.get(receipt);
    }, onResealReference: async (_ref, receipt, tx) => {
        if (failCommit) throw new Error('storage conflict');
        await tx.exec('INSERT INTO attachments(receipt) VALUES ($1)', [receipt]); committed++;
    } });
    await shares.migrate(); await db.exec('CREATE TABLE attachments(receipt text PRIMARY KEY)');
    await shares.register(ref, { owner_subject: subject, lock: 'people', audience: 'people' });
    const member = { subject: other, role: 'viewer', key_slot: sealed.header.slots.people[1] };
    await assert.rejects(() => shares.update({ subject: other }, ref, { envelope_ref: 'upload-1' }), (e) => e.status === 404);
    await assert.rejects(() => shares.update({ subject }, ref, { envelope_ref: 'missing' }), (e) => e.code === 'share.reseal_invalid');
    await assert.rejects(() => shares.update({ subject }, ref, { envelope_ref: 'upload-1', envelope: 'x' }), (e) => e.status === 400);
    failCommit = true;
    await assert.rejects(() => shares.update({ subject }, ref, { members: [member], envelope_ref: 'upload-1' }), /storage conflict/);
    assert.equal(await shares.canView({ subject: other }, ref), false);
    failCommit = false;
    await shares.update({ subject }, ref, { members: [member], envelope_ref: 'upload-1' });
    assert.equal(committed, 1); assert.equal(await shares.canView({ subject: other }, ref), true);
    await assert.rejects(() => shares.update({ subject }, ref, { members: [], envelope_ref: 'upload-1' }), (e) => e.code === 'share.reseal_not_fresh');
    const remaining = await locker.seal('private again', { lock: 'people', keys: [{ subject, publicKey: person.ecdhPublic }] });
    stored.set('upload-2', { prefix: remaining.bytes.subarray(0, remaining.chunkOffset), byteLength: remaining.bytes.length });
    await shares.update({ subject }, ref, { members: [], envelope_ref: 'upload-2' });
    assert.equal(committed, 2); assert.equal(await shares.canView({ subject: other }, ref), false);
    assert.equal(await db.value('SELECT COUNT(*)::int FROM attachments'), 2);
    await db.close(); console.log('share-staged: bounded inspection, authorized receipts, rollback, fresh-key removal');
})().catch((e) => { console.error(e); process.exitCode = 1; });
