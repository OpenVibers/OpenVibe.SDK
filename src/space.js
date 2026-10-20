'use strict';
/**
 * openvibe-sdk/space — OpenVibe.Space for apps and CI: deploy a static site (a tar/tar.gz archive or files with their
 * paths), activate or roll back a deploy, and manage a project's sites, their serving settings, Git source and custom
 * domains. Routes at https://openvibe.space/api/v1; tokens for audience openvibe.space.
 *
 *   const space = createSpaceClient(createClient({ tokenProvider }));                // e.g. an app's client-credentials token
 *   const { deploy } = await space.deploys.uploadArchive(siteId, fs.readFileSync('site.tar.gz'), { activate: true });
 *   await space.deploys.uploadFiles(siteId, [{ path: 'index.html', data: html }, { path: 'css/site.css', data: css }]);
 *   await space.sites.config.set(siteId, { spa: true, headers: { 'X-Frame-Options': 'DENY' } });
 *   await space.deploys.rollback(siteId, { deploy_id: previousDeployId });
 *
 * Capabilities (public since openvibe-contracts 0.209.0): space.deploy.create (sensitive), space.site.config,
 * space.site.manage (sensitive) and space.domain.manage (sensitive). Space also judges each call by the acting
 * principal's project role: an app is a principal of its own and reaches only the projects a person added it to
 * (deployer: deploys; maintainer: + sites, settings, domains; owner: + members). Uploads and creations make a new
 * deploy, site, project or domain each time and are never retried on their own; activating, rolling back, settings
 * and deletes are.
 * Errors are OpenVibeError: project.not_found (also for a project the principal is not in), site.not_found,
 * deploy.not_found, environment.sandbox_token, quota.exceeded, …
 */
const enc = encodeURIComponent;

function createSpaceClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createSpaceClient: pass an openvibe-sdk/core client');
    const at = { service: 'space', baseUrl, audience: 'openvibe.space' };
    const call = (opts) => client.json({ ...at, ...opts });
    const once = (opts) => call({ ...opts, idempotencyKey: false });
    const id = (what, v) => {
        if (!v || typeof v !== 'string') throw new TypeError(`space: a ${what} id`);
        return enc(v);
    };
    const project = (p, rest = '') => `/api/v1/projects/${id('project', p)}${rest}`;
    const site = (s, rest = '') => `/api/v1/sites/${id('site', s)}${rest}`;
    const deploy = (d, rest = '') => `/api/v1/deploys/${id('deploy', d)}${rest}`;
    const flag = (v) => (v ? '1' : undefined);

    /** A tar or tar.gz archive as the request body. */
    const archiveBody = (archive, gzip) => {
        if (archive == null) throw new TypeError('space: the archive (Buffer, Uint8Array, Blob or stream)');
        return { body: archive, headers: { 'Content-Type': gzip ? 'application/gzip' : 'application/x-tar' } };
    };

    return {
        projects: {
            list: ({ signal } = {}) => call({ path: '/api/v1/projects', signal }),
            /** A project owned by the person (an app cannot own one). */
            create: (fields, { signal } = {}) => once({ method: 'POST', path: '/api/v1/projects', json: fields || {}, signal }),
            get: (p, { signal } = {}) => call({ path: project(p), signal }),
            remove: (p, { signal } = {}) => call({ method: 'DELETE', path: project(p), signal }),
            quota: (p, { signal } = {}) => call({ path: project(p, '/quota'), signal }),
            sites: (p, { signal } = {}) => call({ path: project(p, '/sites'), signal }),
            members: {
                /** Add or change a member: a usr_ person or an app:app_… principal, as deployer, maintainer or owner. */
                set: (p, principal, role, { signal } = {}) => {
                    if (!['deployer', 'maintainer', 'owner'].includes(role)) throw new TypeError('space.projects.members.set: role is deployer, maintainer or owner');
                    return call({ method: 'PUT', path: project(p, `/members/${enc(String(principal))}`), json: { role }, signal });
                },
                remove: (p, principal, { signal } = {}) => call({ method: 'DELETE', path: project(p, `/members/${enc(String(principal))}`), signal }),
            },
        },
        sites: {
            create: (p, fields, { signal } = {}) => once({ method: 'POST', path: project(p, '/sites'), json: fields || {}, signal }),
            get: (s, { signal } = {}) => call({ path: site(s), signal }),
            remove: (s, { signal } = {}) => call({ method: 'DELETE', path: site(s), signal }),
            /** Serving settings { headers: { Name: value }, redirects: [...], spa: boolean }; reserved headers are refused. */
            config: {
                get: (s, { signal } = {}) => call({ path: site(s, '/config'), signal }),
                set: (s, config, { signal } = {}) => call({ method: 'PUT', path: site(s, '/config'), json: config, signal }),
                reset: (s, { signal } = {}) => call({ method: 'DELETE', path: site(s, '/config'), signal }),
            },
            /** The Git repository and branch CI deploys come from. */
            source: {
                get: (s, { signal } = {}) => call({ path: site(s, '/source'), signal }),
                set: (s, source, { signal } = {}) => call({ method: 'PUT', path: site(s, '/source'), json: source, signal }),
                remove: (s, { signal } = {}) => call({ method: 'DELETE', path: site(s, '/source'), signal }),
            },
        },
        deploys: {
            list: (s, { signal } = {}) => call({ path: site(s, '/deploys'), signal }),
            get: (d, { signal } = {}) => call({ path: deploy(d), signal }),
            log: (d, { signal } = {}) => call({ path: deploy(d, '/log'), signal }),
            /** Upload a tar.gz (gzip: false for a plain tar) → { deploy, activated, preview, url }. */
            uploadArchive: (s, archive, { activate, preview, root, gzip = true, signal } = {}) => once({
                method: 'POST', path: site(s, '/deploys'), query: { activate: flag(activate), preview: flag(preview), root }, ...archiveBody(archive, gzip), signal,
            }),
            /** Upload files, each { path: 'css/site.css', data, type? } (the path in the site is the part's filename). */
            uploadFiles: (s, files, { activate, preview, root, signal } = {}) => {
                if (!Array.isArray(files) || !files.length) throw new TypeError('space.deploys.uploadFiles: at least one { path, data }');
                const form = new FormData();
                for (const f of files) {
                    if (!f || typeof f.path !== 'string' || !f.path || f.data == null) throw new TypeError('space.deploys.uploadFiles: each file is { path, data, type? }');
                    const blob = typeof Blob !== 'undefined' && f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.type || 'application/octet-stream' });
                    form.append('files', blob, f.path);
                }
                return once({ method: 'POST', path: site(s, '/deploys'), query: { activate: flag(activate), preview: flag(preview), root }, form, signal });
            },
            /** A CI build for a site with a Git source (always a preview): ref and the full commit_sha. */
            uploadSourceBuild: (s, archive, { ref, commit_sha: sha, gzip = true, signal } = {}) => once({
                method: 'POST', path: site(s, '/source/deploys'), query: { ref, commit_sha: sha }, ...archiveBody(archive, gzip), signal,
            }),
            /** Make it the live deploy (one atomic switch); expected_active guards a race. */
            activate: (d, { expected_active: expected, signal } = {}) => call({ method: 'POST', path: deploy(d, '/activate'), json: expected === undefined ? {} : { expected_active: expected }, idempotent: true, signal }),
            /** Back to an earlier ready deploy (deploy_id, else the previous one). */
            rollback: (s, { deploy_id: to, expected_active: expected, signal } = {}) => call({ method: 'POST', path: site(s, '/rollback'), json: { deploy_id: to, expected_active: expected }, idempotent: true, signal }),
            /** Delete a deploy that is not active (maintainer). */
            remove: (d, { signal } = {}) => call({ method: 'DELETE', path: deploy(d), signal }),
        },
        domains: {
            list: (s, { signal } = {}) => call({ path: site(s, '/domains'), signal }),
            /** Add a custom domain (never an OpenVibe one); it is served once its DNS TXT record verifies. */
            add: (s, fields, { signal } = {}) => once({ method: 'POST', path: site(s, '/domains'), json: fields, signal }),
            verify: (dom, { signal } = {}) => call({ method: 'POST', path: `/api/v1/domains/${id('domain', dom)}/verify`, json: {}, idempotent: true, signal }),
            remove: (dom, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/domains/${id('domain', dom)}`, signal }),
        },
    };
}

module.exports = { createSpaceClient };
