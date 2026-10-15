'use strict';
// openvibe-sdk/play: OpenVibe.Play's game services — the routes and audience each call uses, public reads without a token,
// players checked before a request leaves, and a missing title or board as null.
const assert = require('assert');
const { createPlayClient } = require('../src/play');
const { OpenVibeError } = require('../src/core/errors');

(async () => {
    const calls = [];
    let missing = false;
    const client = { json: async (opts) => { calls.push(opts); if (missing) throw new OpenVibeError({ status: 404, code: 'play.not_found', message: 'no' }); return { ok: true }; } };
    const play = createPlayClient(client, { baseUrl: 'http://play.test' });
    const KIM = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

    await play.titles.define('gem-run', { name: 'Gem Run', boards: [{ id: 'high-score', name: 'High score', kind: 'best' }] });
    await play.scores.post('gem-run', { board: 'high-score', ref: 'round-1', entries: [{ player: KIM, name: 'kim', score: 1200 }] });
    await play.achievements.unlock('gem-run', { player: 'guest:abc12345', achievements: ['first-gem'] });
    await play.players.adopt('gem-run', 'abc12345', KIM);
    await play.players.achievements('gem-run', KIM);
    await play.boards.get('gem-run', 'high-score', { period: 'week' });
    await play.titles.list();
    assert.deepStrictEqual(calls.map((c) => [c.method || 'GET', c.path, c.audience || null, c.auth === false]), [
        ['PUT', '/api/v1/titles/gem-run', 'openvibe.play', false],
        ['POST', '/api/v1/titles/gem-run/scores', 'openvibe.play', false],
        ['POST', '/api/v1/titles/gem-run/unlocks', 'openvibe.play', false],
        ['POST', '/api/v1/titles/gem-run/players/abc12345/adopt', 'openvibe.play', false],
        ['GET', `/api/v1/titles/gem-run/players/${KIM}/achievements`, 'openvibe.play', false],
        ['GET', '/api/v1/titles/gem-run/boards/high-score', null, true],
        ['GET', '/api/v1/titles', null, true],
    ]);
    assert.deepStrictEqual(calls[1].json, { board: 'high-score', ref: 'round-1', entries: [{ player: KIM, name: 'kim', score: 1200 }] });
    assert.deepStrictEqual(calls[3].json, { person: KIM });
    assert.deepStrictEqual(calls[5].query, { period: 'week', page: undefined });
    assert.throws(() => play.achievements.unlock('gem-run', { player: 'kim', achievements: ['x'] }), /player/);
    missing = true;
    assert.strictEqual(await play.titles.get('nope'), null);
    assert.strictEqual(await play.boards.get('gem-run', 'nope'), null);
    await assert.rejects(play.titles.define('nope', { name: 'x' }), (e) => e.status === 404, 'a write is not swallowed');
    console.log('play: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
