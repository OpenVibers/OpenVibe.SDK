'use strict';
/**
 * openvibe-sdk/play — OpenVibe.Play, the network's game services (achievements, leaderboards and cloud saves, Steamworks-style),
 * for any game: register a title, post scores and unlocks, read a player's achievements. Server-side: a game posts
 * with its own principal's token (audience openvibe.play): a first-party service token, or a developer app's token
 * granted play.title.manage / play.result.write / play.player.read. The principal that registers a title is its only
 * writer; another one is told the title does not exist. Leaderboards and titles are public reads (no token).
 * A developer's sandbox app manages `sandbox-…` titles only (guest players, unlisted, at most 3) and may delete them.
 *
 *   const play = createPlayClient(createClient({ tokenProvider: tokens }));
 *   await play.titles.define('gem-run', {                                  // play.title-definition@1
 *       name: 'Gem Run', url: 'https://example.com/gem-run', summary: 'Collect gems.',
 *       achievements: [{ id: 'first-gem', name: 'First Gem', description: 'Find a gem.' }],
 *       boards: [{ id: 'high-score', name: 'High score', kind: 'best' }],
 *   });
 *   await play.scores.post('gem-run', { board: 'high-score', ref: 'round-42', entries: [{ player: 'usr_…', name: 'kim', score: 1200 }] });
 *   await play.achievements.unlock('gem-run', { player: 'guest:abc12345', achievements: ['first-gem'] });   // → the new ones
 *   await play.players.adopt('gem-run', 'abc12345', 'usr_…');              // a guest signed in: their rows become the person's
 *   await play.players.achievements('gem-run', 'usr_…');                   // play.player-achievements@1
 *   await play.boards.get('gem-run', 'high-score', { period: 'week' });    // public: rank, name, score (never a player id)
 *   await play.saves.put('gem-run', 'usr_…', 'main', { data: { level: 3 }, version: 0 });   // → { slot, version: 1, … }
 *   await play.saves.get('gem-run', 'usr_…', 'main');                      // → { slot, version, data, … } or null
 *   // a stale version is OpenVibeError 409 play.save_conflict: read again, merge, write with the new version
 *
 * Shapes: Contracts play.title-definition@1, play.result-request@1, play.result-response@1, play.title-result@1,
 * play.player-achievements@1. Errors are OpenVibeError (status, code); a missing title or board is null from get().
 */
const { isOpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;
const PLAYER_RE = /^(usr_[0-9A-HJKMNP-TV-Z]{26}|guest:[A-Za-z0-9_-]{8,128})$/;

function createPlayClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createPlayClient: pass an openvibe-sdk/core client');
    const call = (opts) => client.json({ service: 'play', baseUrl, audience: 'openvibe.play', ...opts });
    const open = (opts) => client.json({ service: 'play', baseUrl, auth: false, ...opts });
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const player = (p) => { if (!PLAYER_RE.test(String(p || ''))) throw new TypeError('player: a usr_… subject or guest:<8–128 of A-Z a-z 0-9 _ ->'); return p; };

    return {
        titles: {
            /** Register or update a title you manage (play.title.manage). */
            define: (title, definition, { signal } = {}) => call({ method: 'PUT', path: `/api/v1/titles/${enc(title)}`, json: definition, signal, idempotencyKey: false }),
            /** Public: every title with its achievements and boards. */
            list: ({ signal } = {}) => open({ path: '/api/v1/titles', signal }),
            /** Public: one title, or null. */
            get: (title, { signal } = {}) => orNull(open({ path: `/api/v1/titles/${enc(title)}`, signal })),
            /** Delete a sandbox title you manage, with everything in it (play.title.manage); a production title is kept (409 play.title_kept). */
            remove: (title, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/titles/${enc(title)}`, signal, idempotencyKey: false }),
        },
        scores: {
            /** A round's scores to one board (play.result.write); idempotent by ref, up to 100 entries. */
            post: (title, { board, ref, at, entries }, { signal } = {}) => call({
                method: 'POST', path: `/api/v1/titles/${enc(title)}/scores`, signal, idempotencyKey: false,
                json: { board, ref, ...(at ? { at } : {}), entries: (entries || []).map((e) => ({ ...e, player: player(e.player) })) },
            }),
        },
        achievements: {
            /** Unlock achievements for a player (play.result.write); idempotent, answers the new ones. */
            unlock: (title, { player: who, achievements, at }, { signal } = {}) => call({
                method: 'POST', path: `/api/v1/titles/${enc(title)}/unlocks`, signal, idempotencyKey: false,
                json: { player: player(who), achievements, ...(at ? { at } : {}) },
            }),
        },
        players: {
            /** A guest signed in: their scores and unlocks become the person's (play.result.write). `guest` is the opaque part. */
            adopt: (title, guest, person, { signal } = {}) => call({ method: 'POST', path: `/api/v1/titles/${enc(title)}/players/${enc(guest)}/adopt`, json: { person }, signal, idempotencyKey: false }),
            /** A player's unlocks in a title you manage (play.player.read). */
            achievements: (title, who, { signal } = {}) => call({ path: `/api/v1/titles/${enc(title)}/players/${enc(player(who))}/achievements`, signal }),
        },
        saves: {
            /** Write a player's save slot (play.result.write): any JSON up to 64 KB. `version` is the one you read (0 for a
             *  new slot); a stale one is refused (409 play.save_conflict). Leave it out to overwrite. At most 8 slots. */
            put: (title, who, slot, { data, version } = {}, { signal } = {}) => call({
                method: 'PUT', path: `/api/v1/titles/${enc(title)}/players/${enc(player(who))}/saves/${enc(slot)}`, signal, idempotencyKey: false,
                json: { data, ...(version !== undefined && version !== null ? { version } : {}) },
            }),
            /** One slot with its data (play.player.read), or null when the slot is empty. */
            get: (title, who, slot, { signal } = {}) => orNull(call({ path: `/api/v1/titles/${enc(title)}/players/${enc(player(who))}/saves/${enc(slot)}`, signal })),
            /** A player's slots in your title, without their data (play.player.read). */
            list: (title, who, { signal } = {}) => call({ path: `/api/v1/titles/${enc(title)}/players/${enc(player(who))}/saves`, signal }),
            /** Delete a slot (play.result.write). */
            remove: (title, who, slot, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/titles/${enc(title)}/players/${enc(player(who))}/saves/${enc(slot)}`, signal, idempotencyKey: false }),
        },
        boards: {
            /** Public: a leaderboard page (rank, name, score; never a player id), or null. period: e.g. 'all', 'week'. */
            get: (title, board, { period, page, signal } = {}) => orNull(open({ path: `/api/v1/titles/${enc(title)}/boards/${enc(board)}`, query: { period, page }, signal })),
        },
    };
}

module.exports = { createPlayClient };
