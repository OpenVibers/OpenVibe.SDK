'use strict';
/**
 * openvibe-sdk/media: OpenVibe.Media files (Media API v1, /api/v1/:app/files), public URL helpers, and
 * createObjectsClient() for the object API v2 (/api/v2/:app/objects: single and multipart uploads,
 * signed links, jobs), see ./objects.js.
 *
 * Credentials: the app's API key (Authorization: Bearer <app key>, server side only; it is a
 * secret), a Network service token for the app's namespace, or a developer app token on its
 * project's tenant (`app` = the project id, prj_…). Tokens need media.object.upload to upload and
 * delete, media.object.read to list and get. Media refuses a user JWT here: a browser uploads
 * through its own app server, which names the user with X-OV-User-Id (the `actingUserId` option).
 * Browser-safe code (FormData/Blob), but the credentials it needs belong on a server.
 *
 * Sandbox app tokens land in the project's sandbox tenant (`<prj_…>-sandbox`, shown as `app_id`),
 * whose files are never served publicly: Media answers them with `sandbox: true`, a signed,
 * expiring `url` and `url_expires_at`. The client adds `signed_url` (that URL) and sets
 * `public_url` to null for them; other files get `public_url` (the absolute `url`).
 */
const { isOpenVibeError } = require('./core/errors');
const { paginate, offsetPager } = require('./core/paginate');
const { createObjectsClient } = require('./objects');

const DEFAULT_PUBLIC_ORIGIN = 'https://openvibe.media';
const enc = encodeURIComponent;

/** Absolute public URLs for Media objects (no auth unless the item is private). */
function mediaUrls(origin = DEFAULT_PUBLIC_ORIGIN) {
    const o = String(origin).replace(/\/+$/, '');
    return {
        origin: o,
        file: (key) => `${o}/f/${enc(key)}`,
        vod: (id) => `${o}/v/${enc(id)}`,
        clip: (id) => `${o}/c/${enc(id)}`,
        thumbnail: (name) => `${o}/t/${enc(name)}`,
        paste: (slug) => `${o}/p/${enc(slug)}`,
        pasteRaw: (slug) => `${o}/p/${enc(slug)}/raw`,
        pasteScreenshot: (slug) => `${o}/p/${enc(slug)}/screenshot`,
        vodTranscript: (id) => `${o}/v/${enc(id)}/transcript.json`,
        liveTranscript: (sel, { limit, app } = {}) => withQuery(`${o}/live/${enc(sel)}/transcript.json`, { limit, app }),
        liveFrame: (sel, { width, app, format } = {}) => withQuery(`${o}/live/${enc(sel)}/frame.jpg`, { w: width, app, format }),
        /** Make a Media-relative path (e.g. an upload's `/f/<key>`) absolute. */
        absolute: (path) => (/^https?:\/\//.test(path) ? path : `${o}${String(path).startsWith('/') ? '' : '/'}${path}`),
    };
}

function withQuery(u, q) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    return qs ? `${u}?${qs}` : u;
}

function toBlob(file, contentType) {
    if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
    if (typeof file === 'string' || file instanceof ArrayBuffer || ArrayBuffer.isView(file)) {
        return new Blob([file], contentType ? { type: contentType } : undefined);
    }
    throw new TypeError('upload: pass a Blob/File, ArrayBuffer, typed array (Buffer) or string');
}

function createMediaClient(client, { app, apiKey, actingUserId, baseUrl, publicOrigin } = {}) {
    if (!app) throw new TypeError('createMediaClient: app (the tenant id, e.g. "live") is required');
    const base = `/api/v1/${enc(app)}`;
    const urls = mediaUrls(publicOrigin || DEFAULT_PUBLIC_ORIGIN);
    const call = (opts, perCall = {}) => {
        const headers = { ...opts.headers };
        const acting = perCall.actingUserId !== undefined ? perCall.actingUserId : actingUserId;
        if (acting != null) headers['X-OV-User-Id'] = String(acting);
        return client.json({ service: 'media', baseUrl, audience: 'openvibe.media', ...(apiKey ? { token: apiKey } : {}), ...opts, headers });
    };
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const withPublic = (meta) => {
        if (!meta || !meta.url) return meta;
        if (meta.sandbox) return { ...meta, public_url: null, signed_url: urls.absolute(meta.url) };
        return { ...meta, public_url: urls.absolute(meta.url) };
    };

    const files = {
        /**
         * Multipart upload (field `file`) -> { key, url, public_url, size, mime, sha256, … }
         * (sandbox files: { sandbox: true, url, url_expires_at, signed_url, public_url: null, … }).
         * Keys are content-addressed, so a repeat upload is deduplicated; retries are safe.
         */
        async upload(file, { filename, contentType, userId, actingUserId: acting, signal } = {}) {
            const blob = toBlob(file, contentType);
            const form = new FormData();
            if (userId != null) form.append('user_id', String(userId));
            form.append('file', blob, filename || (file && file.name) || 'file');
            return withPublic(await call({ method: 'POST', path: `${base}/files`, form, idempotent: true, signal }, { actingUserId: acting }));
        },
        /** { files, used_bytes, quota_bytes, limit, offset } */
        async list({ limit, offset } = {}) {
            const out = await call({ path: `${base}/files`, query: { limit, offset } });
            return { ...out, files: (out.files || []).map(withPublic) };
        },
        /** Async iterator over every file of the app. */
        iterate({ pageSize = 100 } = {}) {
            return paginate(offsetPager(async (offset, limit) => ({ items: (await files.list({ limit, offset })).files }), { limit: pageSize }), { cursor: 0 });
        },
        get: async (key) => withPublic(await orNull(call({ path: `${base}/files/${enc(key)}` }))),
        /** true when deleted, false when there was no such file. */
        async delete(key, { actingUserId: acting } = {}) {
            try { await call({ method: 'DELETE', path: `${base}/files/${enc(key)}` }, { actingUserId: acting }); return true; } catch (err) {
                if (isOpenVibeError(err) && err.status === 404) return false;
                throw err;
            }
        },
    };

    return { app, files, urls, upload: files.upload };
}

module.exports = { createMediaClient, createObjectsClient, mediaUrls, DEFAULT_PUBLIC_ORIGIN };
