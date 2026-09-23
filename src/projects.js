'use strict';
/**
 * openvibe-sdk/projects: developer projects on OpenVibe.Network (/api/v1/projects, ADR-014), the
 * API the developer portal (OpenVibe.Codes) and your own tooling use. Browser-safe code.
 *
 * Auth: a Network USER access token (Authorization: Bearer). The API reads no cookies, and service
 * or app tokens get 401. Errors are problem+json with stable codes (project.not_found,
 * grant.beyond_allowance, …); a project you are not a member of is 404, never 403.
 *
 *   const projects = createProjectsClient(createClient({ token: userAccessToken }));
 *   const prj = await projects.create({ name: 'My app' });
 *   const app = await projects.apps.create(prj.id, { name: 'server', environment: 'sandbox', type: 'confidential', redirectUris: [] });
 *   app.credential;                              // the secret, returned ONCE: store it now
 *   await projects.grants.request(prj.id, app.id, 'media.object.upload');
 *
 * Secrets appear only in the responses of apps.create() (confidential apps) and
 * credentials.rotate(). Those two calls are never retried: a retry would mint a second secret.
 * Other mutations that Network does not dedupe are not retried either; reads, PUT and DELETE are.
 */
const { isOpenVibeError } = require('./core/errors');
const { paginate } = require('./core/paginate');

const enc = encodeURIComponent;

function createProjectsClient(client, { baseUrl } = {}) {
    const call = (opts) => client.json({ service: 'network', baseUrl, audience: 'openvibe.network', ...opts });
    const once = (opts) => call({ idempotencyKey: false, ...opts });          // never repeated automatically
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const P = (project) => `/api/v1/projects/${enc(project)}`;
    const A = (project, app) => `${P(project)}/apps/${enc(app)}`;

    const members = {
        async list(project) { return (await call({ path: `${P(project)}/members` })).members; },
        /** { username | subjectId, role: 'admin' | 'developer' | 'viewer' } */
        add: (project, { username, subjectId, role } = {}) => once({ method: 'POST', path: `${P(project)}/members`, json: { username, subject_id: subjectId, role } }),
        update: (project, subject, { role } = {}) => once({ method: 'PATCH', path: `${P(project)}/members/${enc(subject)}`, json: { role } }),
        /** Remove a member (or yourself: leave). The owner cannot leave. */
        remove: (project, subject) => call({ method: 'DELETE', path: `${P(project)}/members/${enc(subject)}` }),
    };

    const apps = {
        async list(project) { return (await call({ path: `${P(project)}/apps` })).apps; },
        get: (project, app) => orNull(call({ path: A(project, app) })),
        /**
         * { name, environment: 'sandbox' | 'production', type: 'confidential' | 'public', redirectUris }
         * -> the app; a confidential app also carries `credential` with its secret, shown once.
         */
        create: (project, { name, environment = 'sandbox', type = 'confidential', redirectUris = [] } = {}) => once({
            method: 'POST', path: `${P(project)}/apps`, json: { name, environment, type, redirect_uris: redirectUris },
        }),
        update: (project, app, { name, redirectUris } = {}) => once({ method: 'PATCH', path: A(project, app), json: { name, redirect_uris: redirectUris } }),
        /** Revoke the app: its credentials and pending codes fail at once; issued tokens end within 5 minutes. */
        revoke: (project, app) => call({ method: 'DELETE', path: A(project, app) }),
    };

    const credentials = {
        /** Metadata only (id, last four characters, state, dates): secrets cannot be read back. */
        async list(project, app) { return (await call({ path: `${A(project, app)}/credentials` })).credentials; },
        /** A new secret, returned once. Older secrets keep working for overlapSeconds (Network default 86400). */
        rotate: (project, app, { overlapSeconds } = {}) => once({ method: 'POST', path: `${A(project, app)}/credentials/rotate`, json: { overlap_seconds: overlapSeconds } }),
        revoke: (project, app, credential) => once({ method: 'POST', path: `${A(project, app)}/credentials/${enc(credential)}/revoke` }),
    };

    const grants = {
        async list(project, app) { return (await call({ path: `${A(project, app)}/grants` })).grants; },
        /** Request a capability. Owners and admins get it approved at once when it is inside the allowance. */
        request: (project, app, capability) => once({ method: 'POST', path: `${A(project, app)}/grants`, json: { capability } }),
        approve: (project, app, capability) => once({ method: 'POST', path: `${A(project, app)}/grants/${enc(capability)}/approve` }),
        deny: (project, app, capability) => once({ method: 'POST', path: `${A(project, app)}/grants/${enc(capability)}/deny` }),
        revoke: (project, app, capability) => call({ method: 'DELETE', path: `${A(project, app)}/grants/${enc(capability)}` }),
    };

    const quotas = {
        async list(project) { return (await call({ path: `${P(project)}/quotas` })).quotas; },
        /** Staff only. { limit, window: minute|hour|day|month|total, unit } */
        set: (project, capability, { limit, window, unit } = {}) => call({ method: 'PUT', path: `${P(project)}/quotas/${enc(capability)}`, json: { limit, window, unit } }),
        delete: (project, capability) => call({ method: 'DELETE', path: `${P(project)}/quotas/${enc(capability)}` }),
    };

    /** One page of the audit, newest first: { entries, next_before }. Admins, owners and staff. */
    const audit = (project, { before, limit } = {}) => call({ path: `${P(project)}/audit`, query: { before, limit } });

    return {
        /** Capabilities an app could ever be granted (active + public). */
        async catalog() { return (await call({ path: '/api/v1/projects/catalog' })).capabilities; },
        /** Your projects; staff may pass { all: true }. */
        async list({ all } = {}) { return (await call({ path: '/api/v1/projects', query: { all } })).projects; },
        /** { name } -> the project; you are its owner. A new project is sandbox only. */
        create: ({ name } = {}) => once({ method: 'POST', path: '/api/v1/projects', json: { name } }),
        /** The project with your role, allowance, environments and counts, or null (404 for non-members). */
        get: (project) => orNull(call({ path: P(project) })),
        update: (project, { name } = {}) => once({ method: 'PATCH', path: P(project), json: { name } }),
        /** Irreversible: revokes every app. Owner or staff. */
        archive: (project) => once({ method: 'POST', path: `${P(project)}/archive` }),
        /** Staff only: the capabilities this project's apps may hold -> { allowance, trimmed }. */
        setAllowance: (project, capabilities) => call({ method: 'PUT', path: `${P(project)}/allowance`, json: { capabilities } }),
        /** Staff only: 'sandbox' | 'sandbox+production'. */
        setEnvironmentPolicy: (project, environmentPolicy) => call({ method: 'PUT', path: `${P(project)}/environment-policy`, json: { environment_policy: environmentPolicy } }),
        members,
        apps,
        credentials,
        grants,
        quotas,
        audit,
        /** Every audit entry, newest first, across pages. */
        iterateAudit: (project, { pageSize = 100 } = {}) => paginate(async (before) => {
            const page = await audit(project, { before, limit: pageSize });
            return { items: page.entries || [], next: page.next_before ?? null };
        }, { cursor: undefined }),
    };
}

module.exports = { createProjectsClient };
