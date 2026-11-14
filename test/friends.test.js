'use strict';
/**
 * The friends client (openvibe-sdk/friends): the person's own circle on OpenVibe.Network and the
 * service read of a person's mutual friends as subjects only (plan §AB.51).
 */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createFriendsClient } = require('../src/friends');

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';

const CIRCLE = {
    subject: ANN,
    friends: [{ subject: BOB }],
    mutual: [{ subject: BOB, username: 'bob', display_name: 'Bob', avatar_url: null, online: true, site: 'openvibe.live', since: '2026-11-14T08:00:00.000Z' }],
    requests: [],
    asked: [],
};

/** A Network stub for the person's own routes and the internal read. */
async function friendsStub() {
    return await stubServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        if (p === '/api/v1/me/friends' && req.method === 'GET') return send(res, 200, CIRCLE);
        const m = p.match(/^\/api\/v1\/me\/friends\/([^/]+)(?:\/(accept))?$/);
        if (m) {
            const name = decodeURIComponent(m[1]);
            if (m[2] === 'accept') return send(res, 200, { changed: true, friend: { subject: name, username: name, display_name: name, active: true, revision: 2, state: 'friends' } });
            if (req.method === 'PUT') return send(res, 201, { changed: true, friend: { subject: name, username: name, display_name: name, active: true, revision: 1, state: 'pending' } });
            if (req.method === 'DELETE') return send(res, 200, { changed: true, friend: { subject: name, username: name, display_name: name, active: false, revision: 2, state: 'none' } });
        }
        if (p === '/internal/friends' && req.method === 'GET') {
            const subject = url.searchParams.get('subject') || '';
            if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) return problem(res, 400, 'friends.bad_subject', 'subject must be a usr_ subject id');
            return send(res, 200, { subject, friends: [BOB] });
        }
        return send(res, 404, { error: 'Not found' });
    });
}

run([
    ['list() reads the whole circle with the person\'s own token', async () => {
        const srv = await friendsStub();
        const friends = createFriendsClient(createClient({ network: srv.url, token: 'user-jwt' }));
        const circle = await friends.list();
        assert.equal(circle.subject, ANN);
        assert.equal(circle.mutual.length, 1);
        assert.equal(circle.mutual[0].username, 'bob');
        assert.deepEqual(circle.requests, []);
        const req = srv.requests.at(-1);
        assert.equal(req.method, 'GET');
        assert.equal(req.url, '/api/v1/me/friends');
        assert.equal(req.headers.authorization, 'Bearer user-jwt');
        await srv.close();
    }],

    ['add, accept and remove reach the Network\'s own routes', async () => {
        const srv = await friendsStub();
        const friends = createFriendsClient(createClient({ network: srv.url, token: 'user-jwt' }));
        const added = await friends.add('bob');
        assert.equal(added.changed, true);
        assert.equal(added.friend.state, 'pending');
        assert.equal(srv.requests.at(-1).method, 'PUT');
        assert.equal(srv.requests.at(-1).url, '/api/v1/me/friends/bob');

        const accepted = await friends.accept(BOB);
        assert.equal(accepted.friend.state, 'friends');
        assert.equal(srv.requests.at(-1).method, 'POST');
        assert.equal(srv.requests.at(-1).url, `/api/v1/me/friends/${BOB}/accept`);

        const removed = await friends.remove('bob');
        assert.equal(removed.friend.active, false);
        assert.equal(srv.requests.at(-1).method, 'DELETE');
        assert.equal(srv.requests.at(-1).url, '/api/v1/me/friends/bob');
        await srv.close();
    }],

    ['a name with a space or a slash is encoded, never pasted into the path', async () => {
        const srv = await friendsStub();
        const friends = createFriendsClient(createClient({ network: srv.url, token: 'user-jwt' }));
        await friends.add('two words');
        assert.equal(srv.requests.at(-1).url, '/api/v1/me/friends/two%20words');
        await friends.add('a/b');
        assert.equal(srv.requests.at(-1).url, '/api/v1/me/friends/a%2Fb');
        await srv.close();
    }],

    ['subjects() reads a person\'s mutual friends as subjects only', async () => {
        const srv = await friendsStub();
        const friends = createFriendsClient(createClient({ network: srv.url, token: 'service-jwt' }));
        const out = await friends.subjects(ANN);
        assert.deepEqual(out, { subject: ANN, friends: [BOB] });
        const req = srv.requests.at(-1);
        assert.equal(req.url, `/internal/friends?subject=${ANN}`);
        assert.equal(req.headers.authorization, 'Bearer service-jwt');
        await srv.close();
    }],

    ['a refusal is an OpenVibeError with the status and the code', async () => {
        const srv = await friendsStub();
        const friends = createFriendsClient(createClient({ network: srv.url, token: 't' }));
        await assert.rejects(friends.subjects('bob'), { status: 400, code: 'friends.bad_subject' });
        await srv.close();
    }],

    ['the ESM entry and the package export resolve by name', async () => {
        const cjs = require('openvibe-sdk/friends');
        const esm = await import('openvibe-sdk/friends');
        assert.equal(typeof cjs.createFriendsClient, 'function');
        assert.equal(esm.default, cjs, 'import and require share one module instance');
    }],

    ['no name is a TypeError, before anything is sent', async () => {
        const srv = await friendsStub();
        const friends = createFriendsClient(createClient({ network: srv.url, token: 't' }));
        assert.throws(() => friends.add(''), TypeError);
        assert.throws(() => friends.add(null), TypeError);
        assert.throws(() => friends.remove(undefined), TypeError);
        assert.equal(srv.requests.length, 0);
        await srv.close();
    }],
]);
