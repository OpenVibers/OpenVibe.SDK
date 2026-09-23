'use strict';
/**
 * openvibe-sdk/testing (Node): an in-process fake of the platform, so apps can unit-test offline.
 *
 *   const { createMockPlatform } = require('openvibe-sdk/testing');
 *   const platform = createMockPlatform({
 *       clients: { demo: { secret: 's3cret', grants: [{ capability: 'media.object.upload', audience: 'openvibe.media', namespaces: ['demo'] }] } },
 *       apps: { [appId]: { env: 'sandbox', type: 'confidential', secret: 's', grants: ['media.object.upload'] } },
 *       mediaApps: { demo: {} },
 *   });
 *   const client = createClient({ fetch: platform.fetch, tokenProvider: createServiceTokenClient({ clientId: 'demo', clientSecret: 's3cret', fetch: platform.fetch }) });
 *
 * `platform.fetch` answers like the real services at their public origins:
 *   Network  /.well-known/openvibe, /oauth/authorize (auto-consent), /oauth/token (client_credentials,
 *            authorization_code with PKCE, refresh_token; developer apps), /api/.well-known/jwks,
 *            /api/v1/registry/*, /api/v1/projects/*, /api/modules/*, /internal/modules/*,
 *            /internal/identity/*
 *   Events   /api/v1/events (with retention gaps after pruneEvents()), /api/v1/subscriptions,
 *            /api/v1/checkpoints, /realtime/stream (SSE); deliverEvents() plays the delivery worker.
 *            Developer apps as in Events (events.app.publish|read|subscribe, see ./apps.js):
 *            app.<project_key>.* types, source app-<ulid>, actor the app or its on_behalf_of user,
 *            reads scoped to the own project + public first-party events, https endpoints,
 *            sandbox and production never mixed. Not modelled: app quotas, revocation, DNS checks.
 *   Media    /api/v1/:app/files and /f/:key. Developer apps reach /api/v1/<project_id>/files only:
 *            production tenant prj_…, sandbox tenant prj_…-sandbox whose files have signed URLs only
 *   Tools    /api/v1/jobs (with { jobs: true }) at origins.tools and the img., audio. and docs.
 *            satellites (platform.toolsOrigins)
 * Tokens are real RS256 JWTs signed with a key generated per platform, checked the way the real
 * services check them (audience, capability, namespace, sandbox refusal). It is a fake: no
 * persistence, simplified visibility rules, no Chat. Like the Network, it verifies the PKCE
 * code_verifier whenever the authorization carried a challenge, and requires one from apps.
 */
const crypto = require('node:crypto');
const { b64url, fromB64url, ulid, topicRegex, json, problem, redirect } = require('./util');
const { createDeveloper, DEFAULT_APP_CATALOG, PRJ_ID_RE } = require('./developer');
const { createJobsService } = require('./jobs');
const appRules = require('./apps');

const DEFAULT_ORIGINS = {
    network: 'https://openvibe.network',
    events: 'https://events.openvibe.network',
    media: 'https://openvibe.media',
    community: 'https://openvibe.community',
    tools: 'https://openvibe.tools',
};

/** The Tools satellites that run jobs (/api/v1/jobs); the mock answers them too. */
const DEFAULT_TOOLS_SATELLITES = ['https://img.openvibe.tools', 'https://audio.openvibe.tools', 'https://docs.openvibe.tools'];

function createMockPlatform(opts = {}) {
    const origins = { ...DEFAULT_ORIGINS, ...opts.origins };
    const toolsOrigins = [origins.tools, ...(opts.toolsSatellites || DEFAULT_TOOLS_SATELLITES)].map((o) => new URL(o).origin);
    const issuer = opts.issuer || origins.network;
    const contractsVersion = opts.contractsVersion || '0.28.0';
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'mock-1';
    const jwk = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid };
    const jwks = { public_key: publicKey.export({ type: 'spki', format: 'pem' }), algorithm: 'RS256', keys: [jwk] };

    const clients = new Map();
    const users = new Map();          // subject_id -> user
    const codes = new Map();
    const refreshTokens = new Map();
    const modules = new Map();        // `${subject}|${ns}` -> record
    const events = [];                // { seq, event, publisher }, oldest first; pruneEvents() drops the head
    let lastSeq = 0;
    const oldestSeq = () => (events.length ? events[0].seq : lastSeq + 1);
    const subscriptions = new Map();
    const checkpoints = new Map();
    const files = new Map();          // `${tenant}|${key}` -> meta (tenant: app id, prj_…, prj_…-sandbox)
    const mediaTenants = new Map();   // developer-project tenants, created on first use
    const mediaApps = new Map(Object.entries(opts.mediaApps || {}).map(([id, a]) => [id, { apiKey: (a && a.apiKey) || null }]));
    const streams = new Set();
    const stats = { tokenRequests: 0, requests: [], deliveries: [] };
    const acceptSandbox = opts.acceptSandbox === true ? true : new Set(opts.acceptSandbox || []);
    const authorization = { subjectId: null, decision: 'allow' };
    const namespaces = opts.namespaces || [{ namespace: 'demo.prefs', owner: 'demo', version: 1, writers: ['owner', 'user'], publicFields: ['theme'], quotaBytes: 4096, onOwnerRemoved: 'retain-readonly', schema: { type: 'object' } }];
    const capabilities = opts.capabilities || [];

    function sign(claims) {
        const header = { alg: 'RS256', typ: 'JWT', kid };
        const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
        return `${input}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(input), privateKey))}`;
    }
    function decode(token) {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        try {
            const header = JSON.parse(fromB64url(parts[0]));
            if (header.alg !== 'RS256') return null;
            if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, fromB64url(parts[2]))) return null;
            const claims = JSON.parse(fromB64url(parts[1]));
            return claims.exp && claims.exp * 1000 > Date.now() ? claims : null;
        } catch { return null; }
    }
    const now = () => Math.floor(Date.now() / 1000);

    function addClient(id, { secret, grants = [], redirectUris = [] } = {}) {
        clients.set(id, { id, secret, grants: grants.map((g) => (Array.isArray(g) ? { capability: g[0], audience: g[1], namespaces: g[2] || [] } : { namespaces: [], ...g })), redirectUris });
    }
    function addUser(u = {}) {
        const user = { id: u.id ?? users.size + 1, subject_id: u.subject_id || `usr_${ulid()}`, username: u.username || `user${users.size + 1}`, display_name: u.display_name, role: u.role || 'user', legacy: u.legacy || [] };
        users.set(user.subject_id, user);
        return user;
    }
    for (const [id, c] of Object.entries(opts.clients || {})) addClient(id, c);
    for (const u of opts.users || []) addUser(u);

    function signUserToken(user, { expiresInSec = 3600, audience = ['openvibe.live', 'openvibe.tools', 'openvibe.games', 'openvibe.media', 'openvibe.network'] } = {}) {
        const u = typeof user === 'string' ? users.get(user) : user;
        return sign({ sub: u.id, id: u.id, subject_id: u.subject_id, username: u.username, display_name: u.display_name || u.username, role: u.role || 'user', iss: issuer, aud: audience, iat: now(), exp: now() + expiresInSec });
    }
    function signServiceToken(clientId, { audience, capabilities: cap = [], namespaces: ns = [], expiresInSec = 300 } = {}) {
        return sign({ iss: issuer, sub: `svc:${clientId}`, actor_type: 'service', aud: [audience], cap, ns, iat: now(), exp: now() + expiresInSec, jti: `tok_${crypto.randomBytes(8).toString('hex')}` });
    }

    /**
     * An app token signed directly, without the token endpoint (e.g. to test a receiver). A
     * registered app's project and env are used unless given.
     */
    function signAppToken(appId, { audience, capabilities: cap = [], projectId, env, onBehalfOf, expiresInSec = 300 } = {}) {
        const app = developer.apps.get(appId);
        const project = projectId || (app && app.project_id) || `prj_${ulid()}`;
        return sign({
            iss: issuer, sub: `app:${appId}`, actor_type: 'app', aud: [audience], cap, ns: [project], project_id: project,
            env: env || (app && app.environment) || 'sandbox', ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}),
            iat: now(), exp: now() + expiresInSec, jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
        });
    }

    /**
     * { claims, service } of a verified service or app principal, or { res } with the error to
     * answer. App tokens with env=sandbox are refused (401 token.sandbox_refused) unless
     * `acceptSandbox` lists this audience or capability (or is true).
     */
    function principal(req, audience, capability, namespace) {
        const auth = req.headers.get('authorization') || '';
        if (!auth.startsWith('Bearer ')) return { res: problem(401, 'token.missing', 'no token') };
        const claims = decode(auth.slice(7));
        if (!claims || !['service', 'app', 'mod'].includes(claims.actor_type)) return { res: problem(401, 'token.bad_signature', 'not a valid service token') };
        if (!(claims.aud || []).includes(audience)) return { res: problem(401, 'token.wrong_audience', `not for ${audience}`) };
        if (claims.env === 'sandbox' && !(acceptSandbox === true || acceptSandbox.has(audience) || acceptSandbox.has(capability))) {
            return { res: problem(401, 'token.sandbox_refused', 'sandbox tokens are not accepted here') };
        }
        const granted = (claims.cap || []).some((c) => c === capability || (c.endsWith('.*') && capability.startsWith(c.slice(0, -1))));
        if (!granted) return { res: problem(403, 'capability.denied', `${capability} not granted`) };
        if (namespace && claims.ns && claims.ns.length && !claims.ns.some((n) => n === namespace || (n.endsWith('.*') && namespace.startsWith(n.slice(0, -1))))) {
            return { res: problem(403, 'capability.namespace_denied', `namespace ${namespace} not granted`) };
        }
        return { claims, service: String(claims.sub).replace(/^svc:/, '') };
    }
    function userOf(req) {
        const auth = req.headers.get('authorization') || '';
        const claims = auth.startsWith('Bearer ') ? decode(auth.slice(7)) : null;
        return claims && !claims.actor_type ? claims : null;
    }

    const developer = createDeveloper({ opts, issuer, sign, users, addUser, userOf, mediaApps, authorization });
    const jobsService = createJobsService({ opts, decode, principal });

    // ── Network ─────────────────────────────────────────────
    function descriptor() {
        return {
            name: 'OpenVibe (mock)', issuer, jwks_uri: `${origins.network}/api/.well-known/jwks`, token_endpoint: `${origins.network}/oauth/token`,
            openid_configuration: `${origins.network}/oauth/.well-known/openid-configuration`, registry: `${origins.network}/api/v1/registry`,
            contracts: { package: 'openvibe-contracts', version: contractsVersion },
            services: Object.entries(origins).map(([id, origin]) => ({ id, status: 'alpha', origin })),
        };
    }
    const manifests = () => opts.services || Object.entries(origins).map(([id, origin]) => ({
        id, name: `OpenVibe.${id[0].toUpperCase()}${id.slice(1)}`, version: '0.0.0', status: 'alpha', repository: `OpenVibers/OpenVibe.${id}`,
        domains: [new URL(origin).host], publicOrigin: origin, capabilities: capabilities.filter((c) => c.owner === id).map((c) => c.id),
        eventsProduced: [], eventsConsumed: [], namespacesOwned: [], runtime: { status: 'up', checked_at: new Date().toISOString() },
    }));

    async function tokenEndpoint(req) {
        stats.tokenRequests++;
        const p = new URLSearchParams(await req.text());
        const appAnswer = developer.token(p);
        if (appAnswer) return appAnswer;
        const client = clients.get(p.get('client_id') || '');
        if (!client || client.secret !== p.get('client_secret')) return json(401, { error: 'invalid_client', error_description: 'Invalid client credentials' });
        const grant = p.get('grant_type');
        if (grant === 'client_credentials') {
            const aud = p.get('audience');
            if (!aud) return json(400, { error: 'invalid_request', error_description: 'audience is required' });
            const grants = client.grants.filter((g) => g.audience === aud);
            const wanted = p.get('scope') ? p.get('scope').split(/\s+/).filter(Boolean) : null;
            const chosen = wanted ? grants.filter((g) => wanted.includes(g.capability)) : grants;
            if (!chosen.length || (wanted && wanted.length !== chosen.length)) return json(400, { error: 'invalid_scope', error_description: `no grants for ${aud}` });
            const cap = chosen.map((g) => g.capability);
            const token = signServiceToken(client.id, { audience: aud, capabilities: cap, namespaces: [...new Set(chosen.flatMap((g) => g.namespaces))] });
            return json(200, { access_token: token, token_type: 'Bearer', expires_in: 300, scope: cap.join(' ') }, { 'Cache-Control': 'no-store' });
        }
        if (grant === 'authorization_code') {
            const c = codes.get(p.get('code') || '');
            if (!c || c.used || c.clientId !== client.id) return json(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
            if (c.redirectUri !== p.get('redirect_uri')) return json(400, { error: 'invalid_grant', error_description: 'Redirect URI mismatch' });
            if (c.codeChallenge) {
                const v = p.get('code_verifier') || '';
                if (b64url(crypto.createHash('sha256').update(v).digest()) !== c.codeChallenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            }
            c.used = true;
            return issueUserTokens(users.get(c.subjectId), c.scope);
        }
        if (grant === 'refresh_token') {
            const r = refreshTokens.get(p.get('refresh_token') || '');
            if (!r || r.clientId !== client.id) return json(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
            refreshTokens.delete(p.get('refresh_token'));
            return issueUserTokens(users.get(r.subjectId), 'profile theme', client.id);
        }
        return json(400, { error: 'unsupported_grant_type' });

        function issueUserTokens(user, scope, clientId = client.id) {
            const refresh = crypto.randomBytes(24).toString('hex');
            refreshTokens.set(refresh, { clientId, subjectId: user.subject_id });
            return json(200, { access_token: signUserToken(user), refresh_token: refresh, token_type: 'Bearer', expires_in: 86400, scope, user: { id: user.id, username: user.username, subject_id: user.subject_id } });
        }
    }

    /**
     * What the Network does after the account chooser: returns an authorization code. For a
     * developer app it checks what Network checks (registered redirect URI, S256 challenge,
     * sandbox membership) and binds the code to `audience` when one is given.
     */
    function authorize({ clientId, redirectUri, subjectId, codeChallenge, codeChallengeMethod = 'S256', scope, audience } = {}) {
        if (developer.isApp(clientId)) return developer.issueCode({ clientId, redirectUri, subjectId, codeChallenge, codeChallengeMethod, scope, audience });
        if (codeChallenge && codeChallengeMethod !== 'S256') throw new Error('mock authorize: only S256');
        const user = users.get(subjectId) || [...users.values()][0] || addUser();
        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, { clientId, redirectUri, subjectId: user.subject_id, codeChallenge, scope: scope === undefined ? 'profile theme' : scope, used: false });
        return code;
    }

    /** GET /oauth/authorize: consents automatically as setAuthorization()'s person (default: the first user). */
    function authorizeRoute(url) {
        const q = url.searchParams;
        if (developer.isApp(q.get('client_id'))) return developer.authorizeRoute(url);
        const client = clients.get(q.get('client_id') || '');
        const redirectUri = q.get('redirect_uri') || '';
        if (!client) return json(400, { error: 'invalid_request', error_description: 'Unknown client_id' });
        if (!redirectUri || (client.redirectUris.length && !client.redirectUris.includes(redirectUri))) return json(400, { error: 'invalid_request', error_description: 'Invalid redirect_uri' });
        const back = (params) => redirect(redirectUri, { ...params, state: q.get('state') });
        if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
        if (q.get('prompt') === 'none' && !authorization.subjectId && !users.size) return back({ error: 'login_required' });
        if (authorization.decision === 'deny') return back({ error: 'access_denied', error_description: 'the person declined' });
        const code = authorize({
            clientId: client.id, redirectUri, subjectId: authorization.subjectId, codeChallenge: q.get('code_challenge') || undefined,
            codeChallengeMethod: q.get('code_challenge_method') || 'S256', scope: q.get('scope') || undefined,
        });
        return back({ code });
    }

    function projection(u) {
        return u ? { subject: { type: 'user', id: u.subject_id }, network_user_id: u.id, username: u.username, display_name: u.display_name || u.username, avatar_url: null, banned: false } : null;
    }
    function findLegacy(system, type, id) {
        if (system === 'network' && type === 'user') return [...users.values()].find((u) => String(u.id) === String(id)) || null;
        return [...users.values()].find((u) => u.legacy.some((l) => l.system === system && (l.type || 'user') === type && String(l.id) === String(id))) || null;
    }

    function writeModule(subject, ns, data, ifMatch, writer) {
        const def = namespaces.find((n) => n.namespace === ns);
        if (!def) return problem(404, 'modules.unknown_namespace', `no namespace ${ns}`);
        if (writer === 'user' && ifMatch == null) return problem(428, 'modules.revision_required', 'send If-Match');
        const key = `${subject}|${ns}`;
        const cur = modules.get(key);
        const have = cur ? cur.revision : 0;
        if (ifMatch != null && Number(String(ifMatch).replace(/^W\//, '').replace(/"/g, '')) !== have) return problem(412, 'modules.revision_conflict', `revision is ${have}`);
        if (!data || typeof data !== 'object' || Array.isArray(data)) return problem(422, 'modules.invalid_data', 'data must be an object');
        const rec = { subject: { type: 'user', id: subject }, namespace: ns, version: def.version, revision: have + 1, data, updated_at: new Date().toISOString(), updated_by: writer === 'user' ? `user:${subject}` : `svc:${writer}` };
        modules.set(key, rec);
        return json(cur ? 200 : 201, rec, { ETag: `"${rec.revision}"` });
    }

    async function network(req, url) {
        const path = url.pathname;
        const m = (re) => path.match(re);
        let r;
        if (req.method === 'GET' && path === '/.well-known/openvibe') return json(200, descriptor());
        if (req.method === 'POST' && path === '/oauth/token') return tokenEndpoint(req);
        if (req.method === 'GET' && path === '/oauth/authorize') return authorizeRoute(url);
        if (path === '/api/v1/projects' || path.startsWith('/api/v1/projects/')) return developer.projectsApi(req, url);
        if (req.method === 'GET' && path === '/api/.well-known/jwks') return json(200, jwks);
        if (req.method === 'GET' && path.startsWith('/api/v1/registry')) {
            const sub = path.slice('/api/v1/registry'.length);
            const status = url.searchParams.get('status');
            if (sub === '/services') return json(200, { services: manifests().filter((s) => !status || s.status === status), contracts_version: contractsVersion });
            if ((r = sub.match(/^\/services\/([^/]+)$/))) {
                const s = manifests().find((x) => x.id === decodeURIComponent(r[1]));
                return s ? json(200, { ...s, capability_details: capabilities.filter((c) => c.owner === s.id) }) : problem(404, 'registry.unknown_service', 'no such service');
            }
            if (sub === '/capabilities') return json(200, { capabilities: capabilities.filter((c) => !url.searchParams.get('owner') || c.owner === url.searchParams.get('owner')) });
            if ((r = sub.match(/^\/capabilities\/([^/]+)$/))) {
                const c = capabilities.find((x) => x.id === decodeURIComponent(r[1]));
                return c ? json(200, c) : problem(404, 'registry.unknown_capability', 'no such capability');
            }
            if (sub === '/namespaces') return json(200, { namespaces });
            if (sub === '/contracts') return json(200, { version: contractsVersion, contracts: [] });
            if (sub === '/topics') return json(200, { topics: [] });
            if ((r = sub.match(/^\/domains\/([^/]+)$/))) {
                const d = decodeURIComponent(r[1]).toLowerCase();
                const s = manifests().find((x) => (x.domains || []).includes(d));
                return s ? json(200, { domain: d, service: s }) : problem(404, 'registry.unknown_domain', `no service claims ${d}`);
            }
            return problem(404, 'registry.not_found', 'unknown registry path');
        }
        if ((r = m(/^\/api\/modules\/([a-z0-9_.]+)\/public\/([^/]+)$/)) && req.method === 'GET') {
            const def = namespaces.find((n) => n.namespace === r[1]);
            const rec = modules.get(`${r[2]}|${r[1]}`);
            if (!def || !rec) return problem(404, 'modules.not_found', 'no record');
            return json(200, { subject: rec.subject, namespace: rec.namespace, version: rec.version, data: Object.fromEntries(Object.entries(rec.data).filter(([k]) => def.publicFields.includes(k))) });
        }
        if (path === '/api/modules' || path.startsWith('/api/modules/')) {
            const user = userOf(req);
            if (!user) return json(401, { error: 'Authentication required' });
            if (path === '/api/modules') return json(200, { subject: { type: 'user', id: user.subject_id }, modules: [...modules.values()].filter((x) => x.subject.id === user.subject_id), namespaces });
            const ns = decodeURIComponent(path.slice('/api/modules/'.length));
            const key = `${user.subject_id}|${ns}`;
            if (req.method === 'GET') return modules.has(key) ? json(200, modules.get(key), { ETag: `"${modules.get(key).revision}"` }) : problem(404, 'modules.not_found', 'no record yet');
            if (req.method === 'PUT') return writeModule(user.subject_id, ns, (await req.json().catch(() => ({}))).data, req.headers.get('if-match'), 'user');
            if (req.method === 'DELETE') return modules.delete(key) ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
        }
        if ((r = m(/^\/internal\/modules\/([a-z0-9_.]+)\/([A-Za-z0-9_]+)$/))) {
            const cap = req.method === 'GET' ? 'network.modules.read' : 'network.modules.write';
            const who = principal(req, 'openvibe.network', cap, r[1]);
            if (who.res) return who.res;
            if (!users.has(r[2])) return problem(404, req.method === 'GET' ? 'modules.not_found' : 'identity.subject_not_found', 'no such subject');
            const key = `${r[2]}|${r[1]}`;
            if (req.method === 'GET') return modules.has(key) ? json(200, modules.get(key)) : problem(404, 'modules.not_found', 'no record');
            if (req.method === 'PUT') return writeModule(r[2], r[1], (await req.json().catch(() => ({}))).data, req.headers.get('if-match'), who.service);
        }
        if (path === '/internal/identity/resolve' && req.method === 'GET') {
            const who = principal(req, 'openvibe.network', 'identity.subject.resolve');
            if (who.res) return who.res;
            const q = url.searchParams;
            const u = q.get('subject_id') ? users.get(q.get('subject_id')) : findLegacy(q.get('system'), q.get('type') || 'user', q.get('id'));
            return u ? json(200, projection(u)) : problem(404, 'identity.subject_not_found', 'no subject for that id');
        }
        if (path === '/internal/identity/resolve-batch' && req.method === 'POST') {
            const who = principal(req, 'openvibe.network', 'identity.subject.resolve');
            if (who.res) return who.res;
            const b = await req.json().catch(() => ({}));
            const list = b.subject_ids || b.ids || [];
            if (list.length > 500) return problem(413, 'identity.too_many_entries', 'at most 500 per call');
            const results = {};
            for (const id of list) results[id] = projection(b.subject_ids ? users.get(id) : findLegacy(b.system, b.type || 'user', id));
            return json(200, { results });
        }
        return json(404, { error: 'Not found' });
    }

    // ── Events ──────────────────────────────────────────────
    function visible(viewer, e) {
        if (e.project_id || (e.env || 'production') !== 'production') return false;     // never streamed
        if (e.event.visibility === 'public') return true;
        if (viewer.kind === 'service') return true;
        return e.event.visibility === 'subject' && viewer.kind === 'user' && (e.event.actor.id === viewer.subject || (e.event.subject.type === 'user' && e.event.subject.id === viewer.subject));
    }
    function publishEvent(env, publisher, { projectId = null, env: environment = 'production' } = {}) {
        const dup = events.find((e) => e.event.event_id === env.event_id);
        if (dup) return { event_id: env.event_id, seq: dup.seq, duplicate: true };
        const stored = { seq: ++lastSeq, event: { priority: 'important', visibility: 'internal', ...env }, publisher, project_id: projectId, env: environment };
        events.push(stored);
        for (const s of streams) s.push(stored);
        return { event_id: env.event_id, seq: stored.seq, duplicate: false };
    }

    /**
     * Events' appOrService guard: an app token (sub app:…) is judged on `appCap` only (sandbox
     * accepted) and becomes { kind: 'app', … }; anything else must hold `serviceCap`.
     */
    function eventsPrincipal(req, serviceCap, appCap, { requireService = false } = {}) {
        const auth = req.headers.get('authorization') || '';
        const claims = auth.startsWith('Bearer ') ? decode(auth.slice(7)) : null;
        if (claims && /^app:/.test(String(claims.sub))) {
            if (!(claims.aud || []).includes('openvibe.events')) return { res: problem(401, 'token.wrong_audience', 'not for openvibe.events') };
            const app = appRules.appPrincipal(claims);
            if (app.error) return { res: problem(401, 'token.invalid_claims', app.error) };
            if (!appCap || !hasCap(claims, appCap)) return { res: problem(403, 'capability.denied', appCap ? `${appCap} not granted` : 'app tokens are not accepted on this route') };
            return { principal: app, consumer: app.sub };
        }
        const who = principal(req, 'openvibe.events', serviceCap);
        if (who.res) return who;
        const service = /^svc:([a-z][a-z0-9-]{1,39})$/.exec(String(who.claims.sub));
        if (requireService && !service) return { res: problem(403, 'capability.denied', 'only service principals may do this') };
        return { principal: { kind: 'service', sub: who.claims.sub, service: service ? service[1] : null }, consumer: who.service };
    }
    const hasCap = (claims, id) => (claims.cap || []).some((c) => c === id || (c.endsWith('.*') && id.startsWith(c.slice(0, -1))));
    const scopeError = (p, patterns) => {
        if (p.kind !== 'app') return null;
        for (const x of patterns) { const err = appRules.patternScopeError(x, p); if (err) return `${x}: ${err}`; }
        return null;
    };
    /** Does this reader see this stored event (topic match aside)? */
    const readable = (p, stored, pattern) => (p.kind === 'app' ? appRules.visibleToApp(stored, p) : appRules.serviceSees(pattern, stored));

    function checkPublish(e, p) {
        if (!e || typeof e !== 'object' || Array.isArray(e) || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(e.event_id || '') || typeof e.event_type !== 'string'
            || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/.test(e.event_type) || !e.actor || !e.subject || !e.timestamp || !/^[a-z][a-z0-9-]{1,39}$/.test(String(e.source))) {
            return problem(422, 'events.invalid_envelope', 'envelope does not match events.event-envelope@1');
        }
        if (p.kind === 'app') {
            if (e.source !== p.source) return problem(403, 'events.source_mismatch', `source must be your app's "${p.source}", not "${e.source}"`);
            if (!e.event_type.startsWith(p.prefix)) return problem(403, 'events.type_not_allowed', `an app may publish ${p.prefix}<name> only, not ${e.event_type}`);
            const a = e.actor || {};
            if (!((a.type === 'app' && a.id === p.appId) || (p.onBehalfOf && a.type === 'user' && a.id === p.onBehalfOf))) {
                return problem(403, 'events.actor_mismatch', `actor must be { type: 'app', id: '${p.appId}' }${p.onBehalfOf ? ' or the user the token acts for' : ''}`);
            }
            return null;
        }
        if (e.source !== p.service) return problem(403, 'events.source_mismatch', `source "${e.source}" is not the calling service "${p.service}"`);
        if (e.event_type.startsWith('app.')) return problem(403, 'events.type_not_allowed', `${e.source} may not publish app.* events`);
        return null;
    }

    async function eventsService(req, url) {
        const path = url.pathname;
        let r;
        if (path === '/realtime/stream' && req.method === 'GET') return realtimeStream(req, url);
        if (path === '/api/v1/events' && req.method === 'POST') {
            const who = eventsPrincipal(req, 'events.event.publish', 'events.app.publish', { requireService: true });
            if (who.res) return who.res;
            const p = who.principal;
            const body = await req.json().catch(() => null);
            const batch = body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.events) && body.event_id === undefined;
            const items = batch ? body.events : [body];
            if (batch && !items.length) return problem(400, 'events.bad_request', 'events must not be empty');
            for (const [i, e] of items.entries()) {
                const bad = checkPublish(e, p);
                if (bad) return bad;
                if (items.findIndex((x) => x.event_id === e.event_id) !== i) return problem(422, 'events.invalid_envelope', `events[${i}]: event_id repeated within the batch`);
            }
            const meta = p.kind === 'app' ? { projectId: p.projectId, env: p.env } : {};
            const results = items.map((e) => publishEvent(e, p.sub, meta));
            return json(results.some((x) => !x.duplicate) ? 201 : 200, batch ? { results } : results[0]);
        }
        if (path === '/api/v1/events' && req.method === 'GET') {
            const who = eventsPrincipal(req, 'events.event.read', 'events.app.read');
            if (who.res) return who.res;
            const patterns = (url.searchParams.get('topic') || '*').split(',').map((x) => x.trim()).filter(Boolean);
            if (!patterns.length || patterns.length > 20 || !patterns.every(appRules.isValidPattern)) return problem(400, 'events.bad_topic', 'topic must be 1..20 comma-separated patterns');
            const scopeErr = scopeError(who.principal, patterns);
            if (scopeErr) return problem(403, 'events.topic_not_allowed', scopeErr);
            const after = Number(url.searchParams.get('after_seq') || 0);
            const limit = Number(url.searchParams.get('limit') || 100);
            if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) return problem(400, 'events.bad_request', 'after_seq must be >= 0 and limit 1..1000');
            const pats = patterns.map((x) => [x, topicRegex(x)]);
            const out = [];
            const page = {};
            let from = after;
            if (after < oldestSeq() - 1) {                  // retention already pruned part of the range
                page.gap = { from_seq: after + 1, to_seq: oldestSeq() - 1 };
                from = oldestSeq() - 1;
            }
            let cursor = from;
            for (const e of events) {
                if (e.seq <= from) continue;
                if (out.length >= limit) break;
                cursor = e.seq;
                if (pats.some(([x, re]) => re.test(e.event.event_type) && readable(who.principal, e, x))) out.push({ seq: e.seq, event: e.event });
            }
            if (out.length < limit) cursor = Math.max(cursor, lastSeq);
            return json(200, { ...page, events: out, next_after_seq: cursor, latest_seq: lastSeq });
        }
        if ((r = path.match(/^\/api\/v1\/events\/([^/]+)$/)) && req.method === 'GET') {
            const who = eventsPrincipal(req, 'events.event.read', 'events.app.read');
            if (who.res) return who.res;
            const e = events.find((x) => x.event.event_id === decodeURIComponent(r[1]));
            const ok = e && (who.principal.kind === 'app' ? appRules.visibleToApp(e, who.principal) : (e.env || 'production') === 'production');
            return ok ? json(200, { seq: e.seq, event: e.event }) : problem(404, 'events.not_found', 'no such event (or pruned by retention)');
        }
        if (path === '/api/v1/checkpoints') {
            const who = eventsPrincipal(req, 'events.event.read', 'events.app.read');
            if (who.res) return who.res;
            const b = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
            const topic = req.method === 'GET' ? url.searchParams.get('topic') || '' : b.topic;
            if (!appRules.isValidPattern(topic)) return problem(400, 'events.bad_request', 'topic (pattern) is required');
            if (req.method !== 'GET' && (!Number.isInteger(b.cursor) || b.cursor < 0)) return problem(400, 'events.bad_request', 'topic (pattern) and cursor (integer >= 0) are required');
            const scopeErr = scopeError(who.principal, [topic]);
            if (scopeErr) return problem(403, 'events.topic_not_allowed', scopeErr);
            const k = `${who.consumer}|${topic}`;
            if (req.method === 'GET') {
                const cp = checkpoints.get(k);
                return json(200, { consumer: who.consumer, topic, cursor: cp ? cp.cursor : 0, updated_at: cp ? cp.updated_at : null });
            }
            const cp = { cursor: b.cursor, updated_at: new Date().toISOString() };
            checkpoints.set(k, cp);
            return json(200, { consumer: who.consumer, topic, ...cp });
        }
        if (path.startsWith('/api/v1/subscriptions')) {
            const who = eventsPrincipal(req, 'events.subscription.manage', 'events.app.subscribe', { requireService: true });
            if (who.res) return who.res;
            const app = who.principal.kind === 'app' ? who.principal : null;
            const view = (s, withSecret) => ({
                id: s.id, consumer: s.consumer, topic_pattern: s.topic_pattern, endpoint: s.endpoint, enabled: s.enabled, retry_policy: s.retry_policy,
                created_at: s.created_at, updated_at: s.updated_at, ...(s.project_id ? { project_id: s.project_id, env: s.env } : {}), ...(withSecret ? { secret: s.secret } : {}),
            });
            if (path === '/api/v1/subscriptions' && req.method === 'POST') {
                const b = await req.json().catch(() => ({})) || {};
                const pattern = b.topic_pattern ?? b.topic;
                if (!appRules.isValidPattern(pattern)) return problem(422, 'events.bad_topic', 'topic_pattern must be dot-separated segments of [a-z0-9_] or *');
                if (app) {
                    const err = appRules.patternScopeError(pattern, app);
                    if (err) return problem(403, 'events.topic_not_allowed', err);
                }
                let endpoint;
                if (app) {
                    const ep = appRules.checkAppEndpoint(b.endpoint);
                    if (!ep.ok) return problem(422, 'events.endpoint_not_allowed', ep.reason);
                    endpoint = ep.url.toString();
                } else {
                    try { endpoint = new URL(b.endpoint).toString(); } catch { return problem(422, 'events.endpoint_not_allowed', 'endpoint must be an http(s) URL'); }
                }
                if (b.secret !== undefined && (typeof b.secret !== 'string' || b.secret.length < 32 || b.secret.length > 256)) return problem(422, 'events.bad_request', 'secret must be a string of 32..256 characters');
                const rp = appRules.checkRetryPolicy(b.retry_policy);
                if (!rp.ok) return problem(422, 'events.bad_request', rp.reason);
                const dup = [...subscriptions.values()].find((s) => s.consumer === who.consumer && s.topic_pattern === pattern && s.endpoint === endpoint);
                if (dup) return problem(409, 'events.subscription_exists', 'this consumer already subscribes that endpoint to that topic', { subscription_id: dup.id });
                const at = new Date().toISOString();
                const s = {
                    id: `sub_${ulid()}`, consumer: who.consumer, topic_pattern: pattern, endpoint, enabled: true, retry_policy: rp.value,
                    secret: b.secret || `whsec_${crypto.randomBytes(32).toString('hex')}`, created_at: at, updated_at: at,
                    project_id: app ? app.projectId : null, env: app ? app.env : 'production',
                    cursor: lastSeq, attempts: new Map(),     // deliverEvents(): events published after the subscription
                };
                subscriptions.set(s.id, s);
                return json(201, view(s, true));
            }
            if (path === '/api/v1/subscriptions' && req.method === 'GET') return json(200, { subscriptions: [...subscriptions.values()].filter((s) => s.consumer === who.consumer).map((s) => view(s)) });
            if ((r = path.match(/^\/api\/v1\/subscriptions\/([^/]+)(?:\/(enable|disable))?$/))) {
                const s = subscriptions.get(decodeURIComponent(r[1]));
                if (!s || s.consumer !== who.consumer) return problem(404, 'events.not_found', 'no such subscription');
                if (r[2] && req.method === 'POST') { s.enabled = r[2] === 'enable'; s.updated_at = new Date().toISOString(); }
                return json(200, view(s));
            }
        }
        return json(404, { error: 'Not found' });
    }

    function realtimeStream(req, url) {
        const pats = (url.searchParams.get('topics') || '').split(',').filter(Boolean).map(topicRegex);
        if (!pats.length) return problem(400, 'realtime.bad_request', 'topics=<pattern> is required');
        const auth = req.headers.get('authorization') || '';
        const claims = auth.startsWith('Bearer ') ? decode(auth.slice(7)) : null;
        if (auth.startsWith('Bearer ') && !claims) return problem(401, 'token.bad_signature', 'bad token');
        let viewer = { kind: 'anonymous' };
        if (claims && claims.actor_type) {
            // Like Events: principals (apps included) need events.event.read, which apps never hold,
            // and sandbox tokens are refused here.
            const who = principal(req, 'openvibe.events', 'events.event.read');
            if (who.res) return who.res;
            if (/^app:/.test(String(claims.sub)) && claims.env === 'sandbox') return problem(401, 'token.sandbox_refused', 'sandbox tokens are not accepted here');
            viewer = { kind: 'service' };
        } else if (claims) viewer = { kind: 'user', subject: claims.subject_id };
        const raw = req.headers.get('last-event-id') ?? url.searchParams.get('last_event_id');
        const last = raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
        const enc = new TextEncoder();
        let conn;
        const body = new ReadableStream({
            start(controller) {
                const send = (s) => { try { controller.enqueue(enc.encode(s)); } catch { streams.delete(conn); } };
                conn = {
                    lastSeq: last ?? lastSeq,
                    push(e) {
                        if (e.seq <= conn.lastSeq || !pats.some((re) => re.test(e.event.event_type)) || !visible(viewer, e)) return;
                        conn.lastSeq = e.seq;
                        send(`id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, event: e.event })}\n\n`);
                    },
                    close() { streams.delete(conn); try { controller.close(); } catch { /* closed */ } },
                };
                send(`retry: ${opts.realtimeRetryMs ?? 50}\n: connected ${viewer.kind}\n\n`);
                if (last != null) {
                    if (last > lastSeq) {
                        send(`event: gap\ndata: ${JSON.stringify({ reason: 'cursor_ahead', from_seq: lastSeq + 1, to_seq: last, latest_seq: lastSeq })}\n\n`);
                        conn.lastSeq = lastSeq;
                    } else if (last < oldestSeq() - 1) {
                        send(`event: gap\ndata: ${JSON.stringify({ reason: 'retention', from_seq: last + 1, to_seq: oldestSeq() - 1, latest_seq: lastSeq })}\n\n`);
                    }
                    for (const e of events) conn.push(e);
                    conn.lastSeq = Math.max(conn.lastSeq, lastSeq);
                }
                streams.add(conn);
                if (req.signal) req.signal.addEventListener('abort', () => conn.close(), { once: true });
            },
            cancel() { streams.delete(conn); },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }

    // ── Delivery worker ─────────────────────────────────────
    /**
     * deliverEvents({ fetch, subscriptionId, timeoutMs }) plays the Events delivery worker once:
     * for each enabled subscription, POSTs every event published after it was created (in seq
     * order, one at a time) to its endpoint as { event, seq }, signed like Events signs deliveries
     * (X-OpenVibe-Signature: sha256=<HMAC of the raw body with the subscription secret>, plus
     * X-OpenVibe-Event-Id, -Event-Type, -Seq, -Subscription-Id, -Delivery-Attempt, -Hops,
     * traceparent). A 2xx moves on; anything else stops that subscription until the next call,
     * and after retry_policy.max_attempts (default 5) the delivery is dead and skipped.
     * `fetch` defaults to the global fetch, so the endpoint can be a real local HTTP server.
     * -> { delivered, failed, dead, attempts: [{ subscription_id, event_id, seq, attempt, status, outcome, error? }] }
     */
    async function deliverEvents({ fetch: send = opts.deliveryFetch || globalThis.fetch, subscriptionId, timeoutMs = 5000 } = {}) {
        const out = { delivered: 0, failed: 0, dead: 0, attempts: [] };
        for (const sub of subscriptions.values()) {
            if (!sub.enabled || (subscriptionId && sub.id !== subscriptionId)) continue;
            const re = topicRegex(sub.topic_pattern);
            const max = (sub.retry_policy && Number.isInteger(sub.retry_policy.max_attempts) && sub.retry_policy.max_attempts) || 5;
            for (const e of events) {
                if (e.seq <= sub.cursor) continue;
                const wanted = re.test(e.event.event_type) && (sub.project_id
                    ? appRules.visibleToApp(e, { projectId: sub.project_id, env: sub.env })
                    : appRules.serviceSees(sub.topic_pattern, e));
                if (!wanted) { sub.cursor = e.seq; continue; }
                const attempt = (sub.attempts.get(e.event.event_id) || 0) + 1;
                sub.attempts.set(e.event.event_id, attempt);
                const body = JSON.stringify({ event: e.event, seq: e.seq });
                const trace = /^[0-9a-f]{32}$/.test(e.event.trace_id || '') ? e.event.trace_id : crypto.randomBytes(16).toString('hex');
                let status = null;
                let error;
                try {
                    const res = await send(sub.endpoint, {
                        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), body,
                        headers: {
                            'Content-Type': 'application/json', 'User-Agent': 'OpenVibe.Events/mock',
                            'X-OpenVibe-Event-Id': e.event.event_id, 'X-OpenVibe-Event-Type': e.event.event_type, 'X-OpenVibe-Seq': String(e.seq),
                            'X-OpenVibe-Subscription-Id': sub.id, 'X-OpenVibe-Delivery-Attempt': String(attempt), 'X-OpenVibe-Hops': '0',
                            'X-OpenVibe-Signature': `sha256=${crypto.createHmac('sha256', String(sub.secret)).update(body).digest('hex')}`,
                            traceparent: `00-${trace}-${crypto.randomBytes(8).toString('hex')}-01`,
                        },
                    });
                    status = res.status;
                    try { await (res.body && res.body.cancel()); } catch { /* not needed */ }
                } catch (err) {
                    error = err && err.name === 'TimeoutError' ? 'timeout' : String((err && err.message) || err);
                }
                const ok = status >= 200 && status < 300;
                const outcome = ok ? 'delivered' : attempt >= max ? 'dead' : 'retry';
                const rec = { subscription_id: sub.id, event_id: e.event.event_id, seq: e.seq, attempt, status, outcome, ...(error ? { error } : {}) };
                out.attempts.push(rec);
                stats.deliveries.push(rec);
                if (ok) { out.delivered++; sub.cursor = e.seq; continue; }
                if (outcome === 'dead') { out.dead++; sub.cursor = e.seq; continue; }
                out.failed++;
                break;                                        // in order: retry this one next time
            }
        }
        return out;
    }

    /** deliverEvents() every intervalMs until stop() (resolves after the round in flight). */
    function startDeliveries({ intervalMs = 20, ...deliverOpts } = {}) {
        let stopped = false;
        let timer = null;
        let current = Promise.resolve();
        const tick = () => {
            if (stopped) return;
            current = deliverEvents(deliverOpts).catch(() => {}).then(() => { if (!stopped) timer = setTimeout(tick, intervalMs); });
        };
        tick();
        return { async stop() { stopped = true; clearTimeout(timer); await current; } };
    }

    /** Retention: drop every stored event with seq <= throughSeq (pulls and resumes now see a gap). */
    function pruneEvents(throughSeq) {
        let n = 0;
        while (events.length && events[0].seq <= throughSeq) { events.shift(); n++; }
        return n;
    }

    // ── Media files ─────────────────────────────────────────
    // Like OpenVibe.Media's tenantAuth + files routes: upload and delete need media.object.upload,
    // list and meta need media.object.read. A developer app reaches only /api/v1/<its project_id>/,
    // where its token's env picks the tenant: production `prj_…`, sandbox `prj_…-sandbox` (created on
    // first use). Sandbox files are never served publicly: their `url` is a signed, expiring
    // /f/<key>?exp=&sig= URL (`sandbox: true`, `url_expires_at`); GET /f/<key> without a valid
    // signature is 404, like a missing file.
    const mediaQuota = { production: 1024, sandbox: 100, ...opts.mediaQuotaMb };
    const mediaSigningKey = crypto.randomBytes(32);
    const signedUrlTtlS = Math.min(3600, Math.max(30, Number(opts.mediaSignedUrlTtlS) || 300));
    const mediaMac = (key, exp) => crypto.createHmac('sha256', mediaSigningKey).update(`getf\nfile:${key}\n${exp}`).digest('base64url');
    const isSandboxTenant = (tenantId) => { const t = mediaTenants.get(tenantId); return Boolean(t && t.env === 'sandbox'); };
    function mediaTenant(projectId, env) {
        const id = env === 'sandbox' ? `${projectId}-sandbox` : projectId;
        if (!mediaTenants.has(id)) mediaTenants.set(id, { id, project_id: projectId, env, quota_bytes: mediaQuota[env] * 1024 * 1024 });
        return mediaTenants.get(id);
    }
    function fileView(f) {
        const sandbox = isSandboxTenant(f.app_id);
        let signed = null;
        if (sandbox) {
            const exp = Math.floor(Date.now() / 1000) + signedUrlTtlS;
            signed = { url: `${origins.media}/f/${encodeURIComponent(f.key)}?exp=${exp}&sig=${mediaMac(f.key, exp)}`, expires_at: new Date(exp * 1000).toISOString() };
        }
        return {
            key: f.key, app_id: f.app_id, user_id: f.user_id, original_name: f.original_name, size: f.size, mime: f.mime, sha256: f.sha256,
            url: signed ? signed.url : `/f/${f.key}`, ...(sandbox ? { sandbox: true, url_expires_at: signed.expires_at } : {}), created_at: f.created_at,
        };
    }
    const fileByKey = (key) => [...files.values()].find((f) => f.key === key) || null;

    /** { tenant, actingUser } or { res }: the order of Media's tenantAuth. */
    function mediaAuth(req, tenantPath, capability) {
        const auth = req.headers.get('authorization') || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        const projectRoute = PRJ_ID_RE.test(tenantPath);
        const claims = token.split('.').length === 3 ? decode(token) : null;
        const svc = claims && claims.actor_type ? claims : null;
        if (svc && svc.env === 'sandbox' && !projectRoute) {
            return { res: problem(401, 'token.sandbox_refused', 'sandbox tokens are accepted only on developer-project tenant routes (/api/v1/<project_id>/files, /api/v2/<project_id>/objects)') };
        }
        if (svc && !(svc.aud || []).includes('openvibe.media')) return { res: problem(401, 'token.wrong_audience', 'not for openvibe.media') };
        if (svc && (svc.actor_type === 'app' || /^app:/.test(String(svc.sub)))) {
            if (!projectRoute) return { res: problem(403, 'capability.namespace_denied', 'app tokens reach only /<project_id>/ tenants') };
            if (svc.project_id !== tenantPath) return { res: problem(403, 'capability.namespace_denied', `this app token belongs to ${svc.project_id || 'no project'}, not ${tenantPath}`) };
            if (!hasCap(svc, capability)) return { res: problem(403, 'capability.denied', `${capability} not granted`) };
            if (svc.ns && svc.ns.length && !svc.ns.includes(tenantPath)) return { res: problem(403, 'capability.namespace_denied', `namespace ${tenantPath} not granted`) };
            return { tenant: mediaTenant(tenantPath, svc.env === 'sandbox' ? 'sandbox' : 'production'), principal: true };
        }
        if (svc && svc.env === 'sandbox') return { res: problem(401, 'token.sandbox_refused', 'only developer-app sandbox tokens are accepted, on their own project tenant') };
        const app = mediaApps.get(tenantPath);
        if (!app) return { res: json(404, { error: 'Unknown app' }) };
        if (token && app.apiKey && token === app.apiKey) {
            const raw = req.headers.get('x-ov-user-id');
            const n = raw == null || raw === '' ? null : Number(String(raw).trim());
            return { tenant: { id: tenantPath, project_id: null, env: null, quota_bytes: 0 }, actingUser: Number.isInteger(n) && n > 0 ? n : null };
        }
        if (token && [...mediaApps.entries()].some(([id, a]) => id !== tenantPath && a.apiKey && a.apiKey === token)) return { res: json(403, { error: 'API key not valid for this app' }) };
        if (svc) {
            const who = principal(req, 'openvibe.media', capability, tenantPath);
            if (who.res) return who;
            return { tenant: { id: tenantPath, project_id: null, env: null, quota_bytes: 0 }, principal: true };
        }
        return { res: json(401, { error: 'Authentication required' }) };
    }

    async function media(req, url) {
        let r;
        if (req.method === 'GET' && (r = url.pathname.match(/^\/f\/([^/]+)$/))) {
            const f = fileByKey(decodeURIComponent(r[1]));
            if (!f) return json(404, { error: 'Not found' });
            const sandbox = isSandboxTenant(f.app_id);
            if (sandbox) {
                const exp = Number(url.searchParams.get('exp'));
                const sig = Buffer.from(String(url.searchParams.get('sig') || ''));
                const want = Buffer.from(Number.isInteger(exp) ? mediaMac(f.key, exp) : '');
                if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000) || sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return json(404, { error: 'Not found' });
            }
            return new Response(f.bytes, { status: 200, headers: { 'Content-Type': f.mime, 'X-Robots-Tag': 'noindex', 'Cache-Control': sandbox ? 'private, no-store' : 'public, max-age=86400' } });
        }
        r = url.pathname.match(/^\/api\/v1\/([^/]+)\/files(?:\/([^/]+))?$/);
        const routed = r && (req.method === 'GET' || (req.method === 'POST' && !r[2]) || (req.method === 'DELETE' && r[2]));
        if (!routed) return json(404, { error: 'Not found' });
        const capability = req.method === 'GET' ? 'media.object.read' : 'media.object.upload';
        const who = mediaAuth(req, decodeURIComponent(r[1]), capability);
        if (who.res) return who.res;
        const { tenant } = who;
        const mine = () => [...files.values()].filter((f) => f.app_id === tenant.id);
        const used = () => mine().reduce((n, f) => n + f.size, 0);
        if (req.method === 'POST') {
            const form = await req.formData();
            const file = form.get('file');
            if (!file || typeof file === 'string') return json(400, { error: 'No file uploaded (multipart field: file)' });
            const buf = Buffer.from(await file.arrayBuffer());
            if (tenant.quota_bytes > 0 && used() + buf.length > tenant.quota_bytes) return json(413, { error: 'App file quota exceeded', quota_bytes: tenant.quota_bytes, used_bytes: used() });
            const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
            const name = String(file.name || 'file').replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
            // Keys are global; a project tenant's keys carry a tag of the tenant id, like Media's.
            const tag = tenant.project_id ? `${crypto.createHash('sha256').update(`tenant:${tenant.id}`).digest('hex').slice(0, 8)}-` : '';
            const key = `${sha256.slice(0, 12)}-${tag}${name}`;
            const existing = fileByKey(key);
            if (existing) {
                if (existing.app_id !== tenant.id) return json(409, { error: 'Key conflict — rename the file and retry' });
                return json(200, { ...fileView(existing), deduplicated: true });
            }
            const userId = who.actingUser != null ? who.actingUser : (form.get('user_id') ?? null);
            const f = { key, app_id: tenant.id, user_id: userId, original_name: file.name || name, size: buf.length, mime: file.type || 'application/octet-stream', sha256, created_at: new Date().toISOString(), bytes: buf };
            files.set(`${tenant.id}|${key}`, f);
            return json(201, fileView(f));
        }
        if (req.method === 'GET' && !r[2]) {
            const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 1, 1), 500);
            const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
            return json(200, { files: mine().slice(offset, offset + limit).map(fileView), used_bytes: used(), quota_bytes: tenant.quota_bytes, limit, offset });
        }
        const f = files.get(`${tenant.id}|${decodeURIComponent(r[2])}`);
        if (!f) return json(404, { error: 'File not found' });
        if (req.method === 'GET') return json(200, fileView(f));
        if (who.actingUser != null && String(f.user_id) !== String(who.actingUser)) return json(403, { error: 'Not authorized to delete this file' });
        files.delete(`${tenant.id}|${f.key}`);
        return json(200, { message: 'File deleted' });
    }

    // ── Router ──────────────────────────────────────────────
    async function fetchImpl(input, init) {
        const req = input instanceof Request && !init ? input : new Request(input, init);
        const url = new URL(req.url);
        stats.requests.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers) });
        const origin = url.origin;
        if (origin === new URL(origins.network).origin) return network(req, url);
        if (origin === new URL(origins.events).origin) return eventsService(req, url);
        if (origin === new URL(origins.media).origin) return media(req, url);
        if (toolsOrigins.includes(origin)) return jobsService.handle(req, url);
        throw new TypeError(`mock platform: no service at ${origin} (fetch failed)`);
    }

    return {
        fetch: fetchImpl,
        origins,
        /** Every origin that answers /api/v1/jobs: origins.tools and the satellites (img., audio., docs.openvibe.tools). */
        toolsOrigins,
        issuer,
        keys: { privateKey, publicKey, jwks },
        signUserToken,
        signServiceToken,
        addClient,
        addUser,
        authorize,
        /** Who /oauth/authorize signs in as ({ subjectId }) and whether they continue or decline ({ decision: 'deny' }). */
        setAuthorization({ subjectId, decision } = {}) {
            if (subjectId !== undefined) authorization.subjectId = subjectId;
            if (decision !== undefined) authorization.decision = decision === 'deny' ? 'deny' : 'allow';
        },
        /** A developer app (see createDeveloper): -> { id, clientId, projectId, env, type, secret? } */
        addApp: (spec) => developer.addApp(spec),
        addProject: (spec) => developer.addProject(spec).id,
        signAppToken,
        stats,
        state: { events, subscriptions, modules, files, mediaTenants, users, checkpoints, apps: developer.apps, projects: developer.projects, jobs: jobsService.jobs },
        deliverEvents,
        startDeliveries,
        pruneEvents,
        /** End every open Tools job event stream (clients reconnect with Last-Event-ID). */
        dropJobStreams: () => jobsService.dropStreams(),
        /**
         * Store an event as if a producer had published it (for realtime/pull tests). A publisher
         * `app:<id>` of a registered app stores it as that app's event (its project and env);
         * otherwise pass { projectId, env } (env defaults to production).
         */
        publishEvent(env, publisher = 'svc:mock', meta) {
            const app = !meta && /^app:/.test(publisher) ? developer.apps.get(publisher.slice(4)) : null;
            const where = meta || (app ? { projectId: app.project_id, env: app.environment } : undefined);
            return publishEvent({ event_id: `evt_${ulid()}`, version: 1, timestamp: new Date().toISOString(), payload: {}, ...env }, publisher, where);
        },
        /** End every open realtime stream (clients reconnect with Last-Event-ID). */
        dropRealtime() { for (const s of [...streams]) s.close(); },
    };
}

module.exports = { createMockPlatform, DEFAULT_ORIGINS, DEFAULT_TOOLS_SATELLITES, DEFAULT_APP_CATALOG };
