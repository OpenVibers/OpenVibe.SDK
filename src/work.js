'use strict';
/**
 * openvibe-sdk/work — OpenVibe.Work for apps: search the job board (listings gathered from public job boards, each
 * linking to the board's own posting), the sources it reads, a person's saved searches, and the applications they
 * track. Routes at https://openvibe.work/api/v1; tokens for audience openvibe.work.
 *
 *   const work = createWorkClient(createClient({ tokenProvider }));
 *   const { jobs, next, facets } = await work.jobs.search({ q: 'node', remote: true });   // public
 *   const { sources } = await work.sources();                                            // public: what Work reads, how often
 *   const app = await work.applications.create({ listing_id: jobs[0].id, status: 'saved' });
 *   await work.applications.update(app.id, { status: 'applied', applied_at: new Date().toISOString() });
 *   await work.savedSearches.create({ q: 'robotics', remote: true });                    // a person's token only
 *
 * Applications are a person's own: their token, or an app holding work.application.manage. Saved searches and the
 * agent's help with an application (`applications.assist`) are the person's alone. Tracking a listing a second time
 * answers the application already tracked (200), so creating one from a listing is retried safely; without a listing
 * it is never retried on its own.
 * Errors are OpenVibeError: work.jobs.cursor_invalid, work.applications.status_invalid, work.applications_full (409),
 * work.applications.not_found, work.saved_searches.empty, work.saved_searches.limit (429),
 * work.saved_searches.person_only, work.actor_unavailable (503), …
 */
const enc = encodeURIComponent;
const APPLICATION_ID_RE = /^wap_[0-9A-HJKMNP-TV-Z]{26}$/;   // Work's own rule
const STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];

function createWorkClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createWorkClient: pass an openvibe-sdk/core client');
    const at = { service: 'work', baseUrl, audience: 'openvibe.work' };
    const call = (opts) => client.json({ ...at, ...opts });
    const application = (id) => {
        if (!APPLICATION_ID_RE.test(String(id || ''))) throw new TypeError('work: an application is a wap_ id');
        return `/api/v1/me/applications/${enc(String(id))}`;
    };
    const status = (s) => {
        if (s != null && !STATUSES.includes(s)) throw new TypeError(`work: status is one of ${STATUSES.join(', ')}`);
        return s;
    };
    const bool = (v) => (v == null ? undefined : String(Boolean(v) && v !== 'false'));

    return {
        jobs: {
            /** Search the listings (public): { jobs, next, count, filters, facets, sources }. Page with cursor = next. */
            search: ({ q, remote, type, location, limit, cursor, signal } = {}) => call({ path: '/api/v1/jobs', query: { q, remote: bool(remote), type, location, limit, cursor }, signal }),
            get: (id, { signal } = {}) => call({ path: `/api/v1/jobs/${enc(String(id))}`, signal }),
        },
        /** The boards Work reads, their terms and attribution, and when each was last fetched (public). */
        sources: ({ signal } = {}) => call({ path: '/api/v1/sources', signal }),
        savedSearches: {
            list: ({ signal } = {}) => call({ path: '/api/v1/saved-searches', signal }),
            /** At least one of q, remote, type or location. */
            create: ({ q, remote, type, location } = {}, { signal } = {}) => call({ method: 'POST', path: '/api/v1/saved-searches', json: { q, remote: bool(remote), type, location }, idempotencyKey: false, signal }),
            remove: (id, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/saved-searches/${enc(String(id))}`, signal }),
        },
        applications: {
            /** The person's tracked applications, newest first: { applications, next }. */
            list: ({ status: st, limit, cursor, signal } = {}) => call({ path: '/api/v1/me/applications', query: { status: status(st), limit, cursor }, signal }),
            /** Track one (work.application-write-request@1): a listing_id, or a title/company/url of your own. */
            create: (fields, { signal } = {}) => {
                if (!fields || typeof fields !== 'object') throw new TypeError('work.applications.create: the application fields');
                status(fields.status);
                return call({ method: 'POST', path: '/api/v1/me/applications', json: fields, ...(fields.listing_id ? { idempotent: true } : { idempotencyKey: false }), signal });
            },
            get: (id, { signal } = {}) => call({ path: application(id), signal }),
            update: (id, patch, { signal } = {}) => {
                status(patch && patch.status);
                return call({ method: 'PATCH', path: application(id), json: patch, idempotent: true, signal });
            },
            remove: (id, { signal } = {}) => call({ method: 'DELETE', path: application(id), signal }),
            /** Ask the person's OpenVibe.Actor agent for help with it (a cover letter, prep): { task_id, task_url }. */
            assist: (id, { ask } = {}, { signal } = {}) => call({ method: 'POST', path: `${application(id)}/assist`, json: { ask }, idempotencyKey: false, signal }),
        },
    };
}

module.exports = { createWorkClient, WORK_APPLICATION_STATUSES: STATUSES };
