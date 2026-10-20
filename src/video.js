'use strict';
/**
 * openvibe-sdk/video — OpenVibe.Video's playlists for apps: a person's or an app's playlists of recordings and clips
 * from openvibe.video (stream recordings and clips from OpenVibe.Live, and uploads), and anyone's public playlists.
 * Routes at https://openvibe.video/api/v1/video; the media hub's tokens are for audience openvibe.download (one
 * service, one audience, shared with the drive).
 *
 *   const video = createVideoClient(createClient({ tokenProvider }));
 *   const { playlist } = await video.playlists.create({ title: 'Best of October', visibility: 'public' });
 *   await video.playlists.items.add(playlist.id, { kind: 'vod', id: 5579 });
 *   await video.playlists.items.add(playlist.id, { kind: 'clip', id: 1203 });
 *   await video.playlists.items.reorder(playlist.id, [{ kind: 'clip', id: 1203 }, { kind: 'vod', id: 5579 }]);
 *   const { playlist: p, items } = await video.playlists.get(playlist.id);   // public and unlisted: anyone
 *   const theirs = await video.users.playlists('goosely');                   // a person's public playlists
 *
 * Visibility is public, unlisted or private; a private playlist is 404 to everyone but its owner. An app's playlists
 * are its own (owner app:…), recorded with its project. Creating a playlist or adding an item makes a new one each
 * time, so neither is retried on its own; changes and deletes are.
 * Errors are OpenVibeError: playlist.not_found, playlist.item_not_found (404), playlist.item_duplicate (409),
 * playlist.invalid (422), capability.denied, user.not_found, …
 */
const enc = encodeURIComponent;
const PLAYLIST_ID_RE = /^vpl_[0-9A-HJKMNP-TV-Z]{26}$/;   // the media hub's own rules
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;
const KINDS = ['vod', 'clip'];

function createVideoClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createVideoClient: pass an openvibe-sdk/core client');
    const at = { service: 'media-hub', baseUrl, audience: 'openvibe.download' };
    const call = (opts) => client.json({ ...at, ...opts });
    const playlist = (id) => {
        if (!PLAYLIST_ID_RE.test(String(id || ''))) throw new TypeError('video: a playlist is a vpl_ id');
        return `/api/v1/video/playlists/${enc(String(id))}`;
    };
    const item = ({ kind, id } = {}) => {
        if (!KINDS.includes(kind)) throw new TypeError("video: an item's kind is 'vod' or 'clip'");
        if (!Number.isInteger(Number(id)) || Number(id) < 1) throw new TypeError("video: an item's id is the recording's or clip's number");
        return { kind, id: Number(id) };
    };

    return {
        playlists: {
            /** The caller's own playlists (a person, or an app with video.playlist.read). */
            list: ({ signal } = {}) => call({ path: '/api/v1/video/playlists', signal }),
            /** { title, description?, visibility? } → { playlist }. */
            create: ({ title, description, visibility } = {}, { signal } = {}) => call({ method: 'POST', path: '/api/v1/video/playlists', json: { title, description, visibility }, idempotencyKey: false, signal }),
            /** One playlist and its items, in order: { playlist (with owner), items: [{ kind, id, position, added_at }] }. */
            get: (id, { signal } = {}) => call({ path: playlist(id), signal }),
            update: (id, patch, { signal } = {}) => call({ method: 'PATCH', path: playlist(id), json: patch, idempotent: true, signal }),
            remove: (id, { signal } = {}) => call({ method: 'DELETE', path: playlist(id), signal }),
            items: {
                add: (id, it, { signal } = {}) => call({ method: 'POST', path: `${playlist(id)}/items`, json: item(it), idempotencyKey: false, signal }),
                /** The full new order: every item, each once → { items }. */
                reorder: (id, items, { signal } = {}) => {
                    if (!Array.isArray(items)) throw new TypeError('video.playlists.items.reorder: items is the full ordered list');
                    return call({ method: 'PATCH', path: `${playlist(id)}/items`, json: { items: items.map(item) }, idempotent: true, signal });
                },
                remove: (id, it, { signal } = {}) => {
                    const { kind, id: itemId } = item(it);
                    return call({ method: 'DELETE', path: `${playlist(id)}/items/${kind}/${itemId}`, signal });
                },
            },
        },
        users: {
            /** A person's public playlists, newest first: { playlists, next_cursor }. */
            playlists: (username, { limit, cursor, signal } = {}) => {
                if (!USERNAME_RE.test(String(username || ''))) throw new TypeError('video.users.playlists: a username');
                return call({ path: `/api/v1/video/users/${enc(String(username))}/playlists`, query: { limit, cursor }, signal });
            },
        },
    };
}

module.exports = { createVideoClient };
