'use strict';
/**
 * openvibe-sdk/community: OpenVibe.Community pastes (/api/pastes). Browser-safe.
 *
 * Browsers call as the signed-in person (Network ov_token cookie with credentials: 'include', or
 * a Bearer user JWT) or anonymously. First-party services call with a Network service token
 * (audience openvibe.community, community.paste.create / .write / .moderate) and say who they
 * act for:
 *   actingSubject: 'usr_…' | 'gst_…'   -> X-OV-Subject (without it a write is anonymous)
 *   origin: 'ai'                       -> X-OV-Origin: ai (AI output; never attributed to a person,
 *                                         so no subject is sent with it)
 *   sourceRef: { service, type, id }   -> X-OV-Source-Ref (EntityRef, e.g. the stream it came from)
 *   staff: true                        -> X-OV-Staff: 1 (the acting person is staff; needs .moderate)
 * Community ignores X-OV-* headers from browsers.
 *
 * TODO: comments on other content, the forum and Pulse APIs are being added to Community now and
 * are not wrapped yet; paste comments are.
 */
const { isOpenVibeError } = require('./core/errors');
const { isActingSubjectId } = require('./core/ids');
const { paginate, offsetPager } = require('./core/paginate');

const enc = encodeURIComponent;

function actingHeaders({ actingSubject, origin, sourceRef, staff } = {}) {
    const h = {};
    if (origin !== undefined && origin !== null) {
        if (origin !== 'ai' && origin !== 'user') throw new TypeError('origin must be "ai" or "user"');
        h['X-OV-Origin'] = origin;
    }
    if (actingSubject && origin !== 'ai') {
        if (!isActingSubjectId(actingSubject)) throw new TypeError('actingSubject must be a usr_… or gst_… subject id');
        h['X-OV-Subject'] = actingSubject;
    }
    if (sourceRef) h['X-OV-Source-Ref'] = typeof sourceRef === 'string' ? sourceRef : JSON.stringify(sourceRef);
    if (staff) h['X-OV-Staff'] = '1';
    return h;
}

function createCommunityClient(client, defaults = {}) {
    const { baseUrl } = defaults;
    const pick = (o) => ({ actingSubject: o.actingSubject, origin: o.origin, sourceRef: o.sourceRef, staff: o.staff });
    const base = pick(defaults);

    function call(opts, perCall = {}) {
        const acting = { ...base };
        for (const [k, v] of Object.entries(pick(perCall))) if (v !== undefined) acting[k] = v;
        return client.json({
            service: 'community', baseUrl, audience: 'openvibe.community', ...opts,
            headers: { ...actingHeaders(acting), ...opts.headers }, signal: perCall.signal,
        });
    }
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const once = { idempotencyKey: false };     // Community does not dedupe these writes: never repeat them

    const pastes = {
        /** { pastes, total, limit, offset } — query: limit, offset, type, search, sort, origin, username */
        list: (query = {}, o = {}) => call({ path: '/api/pastes', query }, o),
        iterate(query = {}, o = {}) {
            const limit = query.limit || 50;
            return paginate(offsetPager(async (offset) => {
                const page = await pastes.list({ ...query, limit, offset }, o);
                return { items: page.pastes || [], total: page.total };
            }, { limit }), { cursor: query.offset || 0 });
        },
        /** { paste, liked } or null. noView: true does not count a view. */
        get: (slug, { noView, ...o } = {}) => orNull(call({ path: `/api/pastes/${enc(slug)}`, query: { no_view: noView ? '1' : undefined } }, o)),
        /**
         * Text paste: { title?, content, language?, visibility?, burn_after_read?, is_nsfw?, … }.
         * Screenshot paste: { screenshot: Blob|File|Buffer, filename?, title?, visibility? } (multipart).
         * -> { id, slug, url, … }
         */
        create(input = {}, o = {}) {
            if (input.screenshot != null) {
                const { screenshot, filename, contentType, ...fields } = input;
                const form = new FormData();
                for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
                const blob = typeof Blob !== 'undefined' && screenshot instanceof Blob ? screenshot : new Blob([screenshot], { type: contentType || 'image/png' });
                form.append('screenshot', blob, filename || (screenshot && screenshot.name) || 'screenshot.png');
                return call({ method: 'POST', path: '/api/pastes', form, ...once }, o);
            }
            return call({ method: 'POST', path: '/api/pastes', json: input, ...once }, o);
        },
        /** { paste } — owner or staff. */
        update: (slug, patch, o = {}) => call({ method: 'PUT', path: `/api/pastes/${enc(slug)}`, json: patch }, o),
        delete: (slug, o = {}) => call({ method: 'DELETE', path: `/api/pastes/${enc(slug)}` }, o),
        /** A copy of a text paste owned by the caller -> { id, slug, url, … } */
        fork: (slug, o = {}) => call({ method: 'POST', path: `/api/pastes/${enc(slug)}/fork`, json: {}, ...once }, o),
        /** Toggles the caller's like -> { liked, likes }. */
        like: (slug, o = {}) => call({ method: 'POST', path: `/api/pastes/${enc(slug)}/like`, ...once }, o),
        /** Counts a copy -> { copies }. */
        copy: (slug, o = {}) => call({ method: 'POST', path: `/api/pastes/${enc(slug)}/copy`, ...once }, o),
        versions: (slug, o = {}) => call({ path: `/api/pastes/${enc(slug)}/versions` }, o),
        byUser: (username, query = {}, o = {}) => call({ path: `/api/pastes/by-user/${enc(username)}`, query }, o),
        config: (o = {}) => call({ path: '/api/pastes/config' }, o),
        comments: {
            /** { comments, total } */
            list: (slug, query = {}, o = {}) => call({ path: `/api/pastes/${enc(slug)}/comments`, query }, o),
            /** { content, parent_id? } -> { comment } */
            create: (slug, input, o = {}) => call({ method: 'POST', path: `/api/pastes/${enc(slug)}/comments`, json: input, ...once }, o),
            delete: (slug, commentId, o = {}) => call({ method: 'DELETE', path: `/api/pastes/${enc(slug)}/comments/${enc(commentId)}` }, o),
        },
    };

    return {
        pastes,
        /** The same client acting for someone else: as('usr_…') or as({ actingSubject, origin, sourceRef, staff }). */
        as(who) {
            const next = typeof who === 'string' ? { actingSubject: who } : { ...who };
            return createCommunityClient(client, { ...defaults, ...next });
        },
        headers: () => actingHeaders(base),
    };
}

module.exports = { createCommunityClient, actingHeaders };
