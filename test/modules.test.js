'use strict';
/** User modules: If-Match revisions and update() read-modify-write with retry on 412. */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createModulesClient } = require('../src/modules');

/** A Network stub holding one record, with a hook to make another writer win a race. */
async function modulesStub() {
    const state = { rec: null, raceOnce: 0 };
    const srv = await stubServer((req, res, body) => {
        const m = req.url.match(/^\/(api|internal)\/modules\/([a-z._]+)(?:\/([A-Za-z0-9_]+))?$/);
        if (!m) return send(res, 404, { error: 'Not found' });
        if (req.method === 'GET') return state.rec ? send(res, 200, state.rec, { ETag: `"${state.rec.revision}"` }) : problem(res, 404, 'modules.not_found', 'no record yet');
        if (req.method === 'DELETE') { const had = Boolean(state.rec); state.rec = null; return send(res, had ? 204 : 404, ''); }
        if (state.raceOnce > 0) {                 // someone else writes between our read and our write
            state.raceOnce--;
            state.rec = { ...(state.rec || { namespace: m[2], version: 1, subject: { type: 'user', id: 'usr_x' } }), revision: (state.rec ? state.rec.revision : 0) + 1, data: { ...(state.rec ? state.rec.data : {}), other: true } };
        }
        const want = req.headers['if-match'] === undefined ? undefined : Number(req.headers['if-match'].replace(/"/g, ''));
        const have = state.rec ? state.rec.revision : 0;
        if (want !== undefined && want !== have) return problem(res, 412, 'modules.revision_conflict', `revision is ${have}, not ${want}`);
        state.rec = { subject: { type: 'user', id: 'usr_x' }, namespace: m[2], version: 1, revision: have + 1, data: JSON.parse(body.toString()).data, updated_at: new Date().toISOString() };
        return send(res, have ? 200 : 201, state.rec, { ETag: `"${state.rec.revision}"` });
    });
    return { srv, state };
}

run([
    ['get -> null before the first write; put requires a revision', async () => {
        const { srv } = await modulesStub();
        const modules = createModulesClient(createClient({ network: srv.url, token: 'user-jwt' }));
        assert.equal(await modules.get('chat.preferences'), null);
        assert.throws(() => modules.put('chat.preferences', { a: 1 }), TypeError);
        const rec = await modules.put('chat.preferences', { a: 1 }, { revision: 0 });
        assert.equal(rec.revision, 1);
        assert.equal(srv.requests.at(-1).headers['if-match'], '"0"');
        assert.equal(srv.requests.at(-1).headers.authorization, 'Bearer user-jwt');
        await assert.rejects(modules.put('chat.preferences', { a: 2 }, { revision: 0 }), { status: 412, code: 'modules.revision_conflict' });
        assert.equal(await modules.delete('chat.preferences'), true);
        assert.equal(await modules.delete('chat.preferences'), false);
        await srv.close();
    }],

    ['update() re-reads and reapplies fn after a 412', async () => {
        const { srv, state } = await modulesStub();
        const modules = createModulesClient(createClient({ network: srv.url, token: 't' }));
        await modules.put('chat.preferences', { count: 1 }, { revision: 0 });
        state.raceOnce = 1;
        const seen = [];
        const rec = await modules.update('chat.preferences', (data, record) => {
            seen.push({ data, revision: record && record.revision });
            return { ...data, count: data.count + 1 };
        });
        assert.equal(seen.length, 2, 'fn ran again on the fresh record');
        assert.deepEqual(seen[0], { data: { count: 1 }, revision: 1 });
        assert.deepEqual(seen[1], { data: { count: 1, other: true }, revision: 2 });
        assert.deepEqual(rec.data, { count: 2, other: true }, 'the other writer\'s change survived');
        assert.equal(rec.revision, 3);
        const puts = srv.requests.filter((r) => r.method === 'PUT').map((r) => r.headers['if-match']);
        assert.deepEqual(puts, ['"0"', '"1"', '"2"']);
        await srv.close();
    }],

    ['update() on a missing record writes with If-Match 0; undefined from fn writes nothing', async () => {
        const { srv } = await modulesStub();
        const modules = createModulesClient(createClient({ network: srv.url, token: 't' }));
        const rec = await modules.update('chat.preferences', (data) => ({ fresh: data === undefined }));
        assert.deepEqual(rec.data, { fresh: true });
        const before = srv.requests.length;
        assert.equal((await modules.update('chat.preferences', () => undefined)).revision, 1);
        assert.equal(srv.requests.length, before + 1, 'read only');
        await srv.close();
    }],

    ['update() gives up after `attempts` conflicts with the 412', async () => {
        const { srv, state } = await modulesStub();
        const modules = createModulesClient(createClient({ network: srv.url, token: 't' }));
        state.raceOnce = 10;
        await assert.rejects(modules.update('chat.preferences', (d) => ({ ...d, x: 1 }), { attempts: 3 }), { status: 412 });
        assert.equal(srv.requests.filter((r) => r.method === 'PUT').length, 3);
        await srv.close();
    }],

    ['service side: /internal/modules/:ns/:subject, unconditional or guarded', async () => {
        const { srv, state } = await modulesStub();
        const modules = createModulesClient(createClient({ baseUrls: { network: srv.url }, token: 'svc-token' }));
        const rec = await modules.forSubject.put('live.profile', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', { bio: 'hi' });
        assert.equal(srv.requests[0].url, '/internal/modules/live.profile/usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        assert.equal(srv.requests[0].headers['if-match'], undefined);
        assert.equal(rec.revision, 1);
        state.raceOnce = 1;
        const up = await modules.forSubject.update('live.profile', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', (d) => ({ ...d, bio: 'hello' }));
        assert.equal(up.data.bio, 'hello');
        assert.equal(up.data.other, true);
        assert.equal((await modules.forSubject.get('live.profile', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ')).revision, 3);
        await srv.close();
    }],
]);
