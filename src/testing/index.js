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
 *            /api/v1/checkpoints, /realtime/stream (SSE); deliverEvents() plays the delivery worker
 *   Media    /api/v1/:app/files (developer apps: the tenant is the project id)
 *   Tools    /api/v1/jobs (with { jobs: true })
 * Tokens are real RS256 JWTs signed with a key generated per platform, checked the way the real
 * services check them (audience, capability, namespace, sandbox refusal). It is a fake: no
 * persistence, simplified visibility rules, no Chat. Like the Network, it verifies the PKCE
 * code_verifier whenever the authorization carried a challenge, and requires one from apps.
 */
const crypto = require('node:crypto');
const { b64url, fromB64url, ulid, topicRegex, json, problem, redirect } = require('./util');
const { createDeveloper, DEFAULT_APP_CATALOG } = require('./developer');
const { createJobsService } = require('./jobs');

const DEFAULT_ORIGINS = {
    network: 'https://openvibe.network',
    events: 'https://events.openvibe.network',
    media: 'https://openvibe.media',
    community: 'https://openvibe.community',
    tools: 'https://openvibe.tools',
};

function createMockPlatform(opts = {}) {
    const origins = { ...DEFAULT_ORIGINS, ...opts.origins };
    const issuer = opts.issuer || origins.network;
    const contractsVersion = opts.contractsVersion || '0.26.0';
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
    const files = new Map();          // `${app}|${key}` -> meta
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
        if (e.event.visibility === 'public') return true;
        if (viewer.kind === 'service') return true;
        return e.event.visibility === 'subject' && viewer.kind === 'user' && (e.event.actor.id === viewer.subject || (e.event.subject.type === 'user' && e.event.subject.id === viewer.subject));
    }
    function publishEvent(env, publisher) {
        const dup = events.find((e) => e.event.event_id === env.event_id);
        if (dup) return { event_id: env.event_id, seq: dup.seq, duplicate: true };
        const stored = { seq: ++lastSeq, event: { priority: 'important', visibility: 'internal', ...env }, publisher };
        events.push(stored);
        for (const s of streams) s.push(stored);
        return { event_id: env.event_id, seq: stored.seq, duplicate: false };
    }

    async function eventsService(req, url) {
        const path = url.pathname;
        let r;
        if (path === '/realtime/stream' && req.method === 'GET') return realtimeStream(req, url);
        if (path === '/api/v1/events' && req.method === 'POST') {
            const who = principal(req, 'openvibe.events', 'events.event.publish');
            if (who.res) return who.res;
            const body = await req.json().catch(() => null);
            const batch = body && Array.isArray(body.events) && body.event_id === undefined;
            const items = batch ? body.events : [body];
            for (const e of items) {
                if (!e || !/^evt_[0-9A-HJKMNP-TV-Z]{26}$/.test(e.event_id || '') || !e.event_type || !e.actor || !e.subject || !e.timestamp) return problem(422, 'events.invalid_envelope', 'envelope does not match events.event-envelope@1');
                if (e.source !== who.service) return problem(403, 'events.source_mismatch', `source "${e.source}" is not the calling service "${who.service}"`);
            }
            const results = items.map((e) => publishEvent(e, who.claims.sub));
            return json(results.some((x) => !x.duplicate) ? 201 : 200, batch ? { results } : results[0]);
        }
        if (path === '/api/v1/events' && req.method === 'GET') {
            const who = principal(req, 'openvibe.events', 'events.event.read');
            if (who.res) return who.res;
            const pats = (url.searchParams.get('topic') || '*').split(',').map(topicRegex);
            const after = Number(url.searchParams.get('after_seq') || 0);
            const limit = Number(url.searchParams.get('limit') || 100);
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
                if (pats.some((re) => re.test(e.event.event_type))) out.push({ seq: e.seq, event: e.event });
            }
            if (out.length < limit) cursor = Math.max(cursor, lastSeq);
            return json(200, { ...page, events: out, next_after_seq: cursor, latest_seq: lastSeq });
        }
        if ((r = path.match(/^\/api\/v1\/events\/([^/]+)$/)) && req.method === 'GET') {
            const who = principal(req, 'openvibe.events', 'events.event.read');
            if (who.res) return who.res;
            const e = events.find((x) => x.event.event_id === decodeURIComponent(r[1]));
            return e ? json(200, { seq: e.seq, event: e.event }) : problem(404, 'events.not_found', 'no such event');
        }
        if (path === '/api/v1/checkpoints') {
            const who = principal(req, 'openvibe.events', 'events.event.read');
            if (who.res) return who.res;
            if (req.method === 'GET') {
                const topic = url.searchParams.get('topic');
                return json(200, { consumer: who.service, topic, cursor: checkpoints.get(`${who.service}|${topic}`) || 0 });
            }
            const b = await req.json().catch(() => ({}));
            checkpoints.set(`${who.service}|${b.topic}`, b.cursor);
            return json(200, { consumer: who.service, topic: b.topic, cursor: b.cursor });
        }
        if (path.startsWith('/api/v1/subscriptions')) {
            const who = principal(req, 'openvibe.events', 'events.subscription.manage');
            if (who.res) return who.res;
            const view = (s, withSecret) => ({ id: s.id, consumer: s.consumer, topic_pattern: s.topic_pattern, endpoint: s.endpoint, enabled: s.enabled, retry_policy: s.retry_policy, ...(withSecret ? { secret: s.secret } : {}) });
            if (path === '/api/v1/subscriptions' && req.method === 'POST') {
                const b = await req.json().catch(() => ({}));
                if (!b.topic_pattern || !b.endpoint) return problem(422, 'events.bad_request', 'topic_pattern and endpoint are required');
                const dup = [...subscriptions.values()].find((s) => s.consumer === who.service && s.topic_pattern === b.topic_pattern && s.endpoint === b.endpoint);
                if (dup) return problem(409, 'events.subscription_exists', 'already subscribed');
                const s = {
                    id: `sub_${ulid()}`, consumer: who.service, topic_pattern: b.topic_pattern, endpoint: b.endpoint, enabled: true, retry_policy: b.retry_policy || null,
                    secret: b.secret || `whsec_${crypto.randomBytes(32).toString('hex')}`,
                    cursor: lastSeq, attempts: new Map(),     // deliverEvents(): events published after the subscription
                };
                subscriptions.set(s.id, s);
                return json(201, view(s, true));
            }
            if (path === '/api/v1/subscriptions' && req.method === 'GET') return json(200, { subscriptions: [...subscriptions.values()].filter((s) => s.consumer === who.service).map((s) => view(s)) });
            if ((r = path.match(/^\/api\/v1\/subscriptions\/([^/]+)(?:\/(enable|disable))?$/))) {
                const s = subscriptions.get(decodeURIComponent(r[1]));
                if (!s || s.consumer !== who.service) return problem(404, 'events.not_found', 'no such subscription');
                if (r[2] && req.method === 'POST') s.enabled = r[2] === 'enable';
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
        if (claims && claims.env === 'sandbox' && !(acceptSandbox === true || acceptSandbox.has('openvibe.events'))) return problem(401, 'token.sandbox_refused', 'sandbox tokens are not accepted here');
        const viewer = claims ? (claims.actor_type ? { kind: 'service' } : { kind: 'user', subject: claims.subject_id }) : { kind: 'anonymous' };
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
                if (!re.test(e.event.event_type)) { sub.cursor = e.seq; continue; }
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
    async function media(req, url) {
        const r = url.pathname.match(/^\/api\/v1\/([^/]+)\/files(?:\/([^/]+))?$/);
        if (!r) return json(404, { error: 'Not found' });
        const appId = decodeURIComponent(r[1]);
        const app = mediaApps.get(appId);
        if (!app) return json(404, { error: 'Unknown app' });
        const auth = req.headers.get('authorization') || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const byKey = Boolean(token) && app.apiKey && token === app.apiKey;
        if (!byKey) {
            if (req.method !== 'POST' || r[2]) return json(401, { error: 'Authentication required' });
            const who = principal(req, 'openvibe.media', 'media.object.upload', appId);
            if (who.res) return who.res;
        }
        const actingUser = byKey ? req.headers.get('x-ov-user-id') : null;
        const view = (f) => ({ key: f.key, app_id: f.app_id, user_id: f.user_id, original_name: f.original_name, size: f.size, mime: f.mime, sha256: f.sha256, url: `/f/${f.key}`, created_at: f.created_at });
        if (req.method === 'POST' && !r[2]) {
            const form = await req.formData();
            const file = form.get('file');
            if (!file || typeof file === 'string') return json(400, { error: 'No file uploaded (multipart field: file)' });
            const buf = Buffer.from(await file.arrayBuffer());
            const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
            const name = String(file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
            const key = `${sha256.slice(0, 12)}-${name}`;
            const existing = files.get(`${appId}|${key}`);
            if (existing) return json(200, { ...view(existing), deduplicated: true });
            const f = { key, app_id: appId, user_id: actingUser ?? form.get('user_id') ?? null, original_name: file.name, size: buf.length, mime: file.type || 'application/octet-stream', sha256, created_at: new Date().toISOString(), bytes: buf };
            files.set(`${appId}|${key}`, f);
            return json(201, view(f));
        }
        if (req.method === 'GET' && !r[2]) {
            const all = [...files.values()].filter((f) => f.app_id === appId);
            const limit = Number(url.searchParams.get('limit') || 100);
            const offset = Number(url.searchParams.get('offset') || 0);
            return json(200, { files: all.slice(offset, offset + limit).map(view), used_bytes: all.reduce((n, f) => n + f.size, 0), quota_bytes: 0, limit, offset });
        }
        const f = files.get(`${appId}|${decodeURIComponent(r[2] || '')}`);
        if (!f) return json(404, { error: 'File not found' });
        if (req.method === 'GET') return json(200, view(f));
        if (req.method === 'DELETE') { files.delete(`${appId}|${f.key}`); return json(200, { message: 'File deleted' }); }
        return json(404, { error: 'Not found' });
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
        if (origin === new URL(origins.tools).origin) return jobsService.handle(req, url);
        throw new TypeError(`mock platform: no service at ${origin} (fetch failed)`);
    }

    return {
        fetch: fetchImpl,
        origins,
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
        state: { events, subscriptions, modules, files, users, checkpoints, apps: developer.apps, projects: developer.projects, jobs: jobsService.jobs },
        deliverEvents,
        startDeliveries,
        pruneEvents,
        /** End every open Tools job event stream (clients reconnect with Last-Event-ID). */
        dropJobStreams: () => jobsService.dropStreams(),
        /** Store an event as if a producer had published it (for realtime/pull tests). */
        publishEvent: (env, publisher = 'svc:mock') => publishEvent({ event_id: `evt_${ulid()}`, version: 1, timestamp: new Date().toISOString(), payload: {}, ...env }, publisher),
        /** End every open realtime stream (clients reconnect with Last-Event-ID). */
        dropRealtime() { for (const s of [...streams]) s.close(); },
    };
}

module.exports = { createMockPlatform, DEFAULT_ORIGINS, DEFAULT_APP_CATALOG };
