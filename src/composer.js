'use strict';
/**
 * openvibe-sdk/composer: the shared composer's client, the same on every OpenVibe site.
 *
 *   attachments.upload(file, { onProgress, signal, filename, contentType, xhr })
 *       POST /api/v1/attachments on Media (multipart `file`), through XMLHttpRequest so upload progress is real.
 *       -> composer.attachment@1
 *   attachments.remove(id)
 *       DELETE /api/v1/attachments/<id>; true when it went, false when it was already gone.
 *   composer.prefs.get() / composer.prefs.put(prefs, rev)
 *       GET/PUT /api/v1/me/composer on Network (composer.prefs@1). A PUT sends the revision it read; a stale one is
 *       409 composer.rev_conflict and err.problem.current is the other tab's document.
 *   mentions.search(q, kinds)
 *       GET /api/v1/mentions on Network (composer.mention@1): people the caller follows first, then public people,
 *       repositories from OpenVibe Git, first-party sites. Signed-in only; at most 8.
 *
 * Browser-safe. The composer page calls Network directly for prefs and mentions (every site's connect-src allows it)
 * and Media for the bytes (the site's CSP must allow OPENVIBE_MEDIA_ORIGIN).
 */
const { OpenVibeError, isOpenVibeError } = require('./core/errors');

const MEDIA_ORIGIN = 'https://openvibe.media';
const NETWORK_ORIGIN = 'https://openvibe.network';
const ATTACHMENT_MAX = 300 * 1024 * 1024;
const enc = encodeURIComponent;

function toBlob(file, contentType) {
    if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
    if (typeof file === 'string' || file instanceof ArrayBuffer || ArrayBuffer.isView(file)) {
        return new Blob([file], contentType ? { type: contentType } : undefined);
    }
    throw new TypeError('attachments.upload: pass a File/Blob, ArrayBuffer, typed array (Buffer) or string');
}

function abortError() {
    return new OpenVibeError({ code: 'sdk.aborted', message: 'the upload was aborted' });
}

function createComposerClient(client, { mediaBaseUrl, networkBaseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createComposerClient: an SDK client is required');
    const net = (opts) => client.json({ service: 'network', audience: 'openvibe.network', ...(networkBaseUrl ? { baseUrl: networkBaseUrl } : {}), ...opts });

    /** The Media token for an XHR upload (the XHR cannot borrow the fetch client's request loop). */
    async function mediaToken() {
        const o = client.options || {};
        if (o.token != null) return o.token;
        if (typeof o.getToken === 'function') return (await o.getToken({ service: 'media', audience: 'openvibe.media' })) || null;
        return null;
    }

    const attachments = {
        /**
         * One file -> composer.attachment@1. Progress is the browser's upload progress (XHR), not a guess.
         * `xhr` injects an XMLHttpRequest implementation (tests, a non-browser shell); otherwise the global one.
         */
        upload(file, { onProgress, signal, filename, contentType, xhr } = {}) {
            return new Promise((resolve, reject) => {
                const XHR = xhr || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null);
                if (!XHR) return reject(new OpenVibeError({ code: 'sdk.xhr_unavailable', message: 'attachments.upload needs XMLHttpRequest (pass { xhr })' }));
                let blob;
                try { blob = toBlob(file, contentType); } catch (err) { return reject(err); }
                if (blob.size > ATTACHMENT_MAX) {
                    return reject(new OpenVibeError({ code: 'media.attachment.too_large', status: 413, message: `a file may be at most ${ATTACHMENT_MAX / (1024 * 1024)} MB` }));
                }
                const url = client.url({ service: 'media', ...(mediaBaseUrl ? { baseUrl: mediaBaseUrl } : {}), path: '/api/v1/attachments' });
                Promise.resolve(url).then(async (target) => {
                    if (signal && signal.aborted) return reject(abortError());
                    const fd = new FormData();
                    fd.append('file', blob, filename || (file && file.name) || 'file');
                    const req = new XHR();
                    let settled = false;
                    const finish = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
                    const offAbort = signal && typeof signal.addEventListener === 'function' ? () => signal.removeEventListener('abort', onAbort) : () => {};
                    function onAbort() { try { req.abort(); } catch { /* */ } finish(reject, abortError()); }
                    const cleanup = () => { offAbort(); };
                    req.open('POST', target);
                    req.setRequestHeader('Accept', 'application/json');
                    const token = await mediaToken();
                    if (token) req.setRequestHeader('Authorization', `Bearer ${token}`);
                    if (req.upload && typeof onProgress === 'function') {
                        req.upload.onprogress = (e) => onProgress({ loaded: e.loaded || 0, total: e.total || blob.size, lengthComputable: e.lengthComputable !== false });
                    }
                    req.onload = () => {
                        let body = null;
                        try { body = req.responseText ? JSON.parse(req.responseText) : null; } catch { body = req.responseText || null; }
                        if (req.status >= 200 && req.status < 300) return finish(resolve, body);
                        const err = OpenVibeError.fromResponse({ status: req.status, body, method: 'POST', url: target });
                        if (body && body.current) err.current = body.current;
                        finish(reject, err);
                    };
                    req.onerror = () => finish(reject, new OpenVibeError({ code: 'sdk.network_error', message: 'the upload could not reach Media', method: 'POST', url: target }));
                    req.ontimeout = () => finish(reject, new OpenVibeError({ code: 'sdk.timeout', message: 'the upload timed out', method: 'POST', url: target }));
                    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
                    try { req.send(fd); } catch (err) { finish(reject, err); }
                }).catch(reject);
            });
        },

        /** DELETE /api/v1/attachments/<id>: true when it went, false when it was already gone. */
        async remove(id) {
            if (!id) throw new TypeError('attachments.remove: pass the attachment id');
            try {
                await client.json({ service: 'media', ...(mediaBaseUrl ? { baseUrl: mediaBaseUrl } : {}), audience: 'openvibe.media', method: 'DELETE', path: `/api/v1/attachments/${enc(id)}` });
                return true;
            } catch (err) {
                if (isOpenVibeError(err) && err.status === 404) return false;
                throw err;
            }
        },
    };

    const composer = {
        prefs: {
            /** composer.prefs@1, with its rev. */
            get: () => net({ path: '/api/v1/me/composer' }),
            /**
             * composer.prefs@1 in (rev is the one you read; 0 for a new person), the new document out.
             * A stale rev is 409 composer.rev_conflict with err.problem.current (and err.current).
             */
            put(prefs, rev) {
                if (!prefs || typeof prefs !== 'object') throw new TypeError('composer.prefs.put: pass the prefs object');
                if (!Number.isInteger(rev) || rev < 0) throw new TypeError('composer.prefs.put: pass the revision you read (0 for new)');
                return net({ method: 'PUT', path: '/api/v1/me/composer', json: { ...prefs, rev } });
            },
        },
    };

    const mentions = {
        /** @ menu entries (composer.mention@1[]). kinds: person | repo | site | file; omitted = all. */
        async search(q, kinds) {
            const list = Array.isArray(kinds) ? kinds : (kinds ? String(kinds).split(',') : []);
            const data = await net({ path: '/api/v1/mentions', query: { q: q || undefined, kinds: list.length ? list.join(',') : undefined } });
            return (data && Array.isArray(data.mentions)) ? data.mentions : [];
        },
    };

    return { attachments, composer, mentions, MEDIA_ORIGIN, NETWORK_ORIGIN };
}

module.exports = { createComposerClient, MEDIA_ORIGIN, NETWORK_ORIGIN, ATTACHMENT_MAX };
