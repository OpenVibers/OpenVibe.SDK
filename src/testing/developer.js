'use strict';
/**
 * Mock developer projects (Network ADR-014): projects, members, apps (app_<ULID> principals),
 * credentials, grants, the /api/v1/projects API, app tokens from /oauth/token, and the app half of
 * /oauth/authorize. Node only; part of createMockPlatform().
 *
 * Deliberate differences from Network, so tests need no staff steps (each is an option):
 *   - sandbox apps get tokens for any audience (`sandboxAudiences` restricts it like
 *     DEV_SANDBOX_AUDIENCES); receivers still refuse them unless `acceptSandbox` opts them in
 *   - projects created through the API start with every catalog capability in their allowance
 *     (`defaultAllowance: []` matches Network's empty default)
 *   - projects declared in options allow sandbox and production apps and any capability
 */
const crypto = require('node:crypto');
const { ULID_RE, ulid, json, problem, redirect, s256 } = require('./util');

const APP_ID_RE = new RegExp(`^app_${ULID_RE.source.slice(1, -1)}$`);
const PRJ_ID_RE = new RegExp(`^prj_${ULID_RE.source.slice(1, -1)}$`);
const PKCE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const TOKEN_TTL_S = 300;
const CODE_TTL_MS = 5 * 60 * 1000;
const RANK = { viewer: 1, developer: 2, admin: 3, owner: 4 };
const ENV_POLICIES = { sandbox: ['sandbox'], 'sandbox+production': ['sandbox', 'production'] };

/** Capabilities that are public + active in openvibe-contracts v0.26.0 (grantable to apps). */
const DEFAULT_APP_CATALOG = [
    'media.object.upload', 'media.object.read', 'tools.job.create', 'tools.job.read', 'tools.job.cancel',
    'games.mod.read', 'games.world.announce', 'games.prop.place',
];

function createDeveloper(ctx) {
    const { opts } = ctx;
    const projects = new Map();
    const apps = new Map();
    const codes = new Map();
    const sandboxAudiences = opts.sandboxAudiences == null ? null : new Set(opts.sandboxAudiences);
    const nowIso = () => new Date().toISOString();

    // ── Catalog ─────────────────────────────────────────────
    function capabilityDef(id) { return (opts.capabilities || []).find((c) => c.id === id) || null; }
    function audienceOf(cap) {
        const def = capabilityDef(cap);
        return `openvibe.${def ? def.owner : String(cap).split('.')[0]}`;
    }
    function catalog() {
        const declared = (opts.capabilities || []).filter((c) => c.visibility === 'public' && (c.status || 'active') === 'active');
        const list = declared.length ? declared : DEFAULT_APP_CATALOG.map((id) => ({ id, owner: id.split('.')[0], visibility: 'public', description: '' }));
        return list.map((c) => ({ id: c.id, owner: c.owner, audience: `openvibe.${c.owner}`, visibility: c.visibility, description: c.description || '', resourceConstraints: c.resourceConstraints, quotaClass: c.quotaClass }));
    }
    const grantable = (cap) => catalog().some((c) => c.id === cap);

    // ── Model ───────────────────────────────────────────────
    function audit(project, actor, action, target, detail = {}) {
        project.audit.push({ id: project.audit.length + 1, at: nowIso(), actor, action, target, detail });
    }

    function addProject({ id, name, owner, environmentPolicy = 'sandbox+production', allowance = '*', members } = {}) {
        const pid = id || `prj_${ulid()}`;
        if (!PRJ_ID_RE.test(pid)) throw new TypeError(`mock platform: project id ${pid} is not prj_<ULID>`);
        if (projects.has(pid)) return projects.get(pid);
        const p = {
            id: pid, name: name || pid, owner: owner || null, environment_policy: environmentPolicy,
            allowance: allowance === '*' ? '*' : new Set(allowance), members: new Map(), open: !members && !owner,
            created_at: nowIso(), archived_at: null, quotas: new Map(), audit: [],
        };
        if (owner) p.members.set(owner, 'owner');
        for (const [subject, role] of Object.entries(members || {})) p.members.set(subject, role);
        projects.set(pid, p);
        // Media keys tenancy by project id; the real Media needs its operators to create the tenant.
        if (ctx.mediaApps && !ctx.mediaApps.has(pid)) ctx.mediaApps.set(pid, { apiKey: null });
        return p;
    }

    function newCredential(app, secret) {
        const c = { id: `crd_${ulid()}`, secret: secret || `ovsec_${crypto.randomBytes(32).toString('base64url')}`, created_at: nowIso(), expires_at: null, revoked_at: null };
        c.hint = c.secret.slice(-4);
        app.credentials.push(c);
        return c;
    }
    function credentialState(c) {
        if (c.revoked_at) return 'revoked';
        if (c.expires_at && Date.parse(c.expires_at) <= Date.now()) return 'expired';
        return c.expires_at ? 'expiring' : 'active';
    }
    const matchSecret = (app, secret) => Boolean(secret) && app.credentials.some((c) => c.secret === secret && ['active', 'expiring'].includes(credentialState(c)));

    /**
     * addApp({ id?, project?, name?, env|environment = 'sandbox', type = 'confidential', secret?,
     *          redirectUris = [], grants = [capability | { capability, audience }] })
     *   -> { id, clientId, projectId, env, type, secret? }   (grants listed here are approved)
     */
    function addApp(spec = {}) {
        const id = spec.id || `app_${ulid()}`;
        if (!APP_ID_RE.test(id)) throw new TypeError(`mock platform: app id ${id} is not app_<ULID>`);
        const project = projects.get(spec.project) || addProject({ id: spec.project });
        const environment = spec.env || spec.environment || 'sandbox';
        const type = spec.type || 'confidential';
        if (!['sandbox', 'production'].includes(environment)) throw new TypeError('mock platform: env is sandbox or production');
        if (!['confidential', 'public'].includes(type)) throw new TypeError('mock platform: type is confidential or public');
        const app = {
            id, project_id: project.id, name: spec.name || id, environment, client_type: type, redirect_uris: [...(spec.redirectUris || [])],
            created_at: nowIso(), revoked_at: null, credentials: [], grants: new Map(),
        };
        const cred = type === 'confidential' ? newCredential(app, spec.secret) : null;
        for (const g of spec.grants || []) {
            const cap = typeof g === 'string' ? g : g.capability;
            app.grants.set(cap, { capability: cap, audience: (typeof g === 'object' && g.audience) || audienceOf(cap), status: 'approved', requested_by: 'mock', requested_at: nowIso(), decided_by: 'mock', decided_at: nowIso() });
        }
        apps.set(id, app);
        return { id, clientId: id, projectId: project.id, env: environment, type, secret: cred ? cred.secret : undefined };
    }

    // opts.projects: { prj_…: { name?, owner?, members?: { usr_…: role }, allowance?: '*' | [], environmentPolicy? } }
    // A project with an owner or members lets only them authorize its sandbox apps.
    for (const [id, spec] of Object.entries(opts.projects || {})) addProject({ ...spec, id });
    for (const [id, spec] of Object.entries(opts.apps || {})) addApp({ ...spec, id });

    // ── Tokens ──────────────────────────────────────────────
    const oauth = (status, error, description) => json(status, { error, error_description: description }, { 'Cache-Control': 'no-store' });

    function usable(clientId) {
        const app = apps.get(String(clientId || ''));
        if (!app || app.revoked_at) return { res: oauth(401, 'invalid_client', 'unknown or revoked app') };
        const project = projects.get(app.project_id);
        if (!project || project.archived_at) return { res: oauth(401, 'invalid_client', 'project archived') };
        if (!ENV_POLICIES[project.environment_policy].includes(app.environment)) return { res: oauth(400, 'unauthorized_client', `${app.environment} apps are not enabled for this project`) };
        return { app, project };
    }

    const inAllowance = (project, cap) => project.allowance === '*' || project.allowance.has(cap);

    function mint({ app, project, audience, scope, limit, onBehalfOf }) {
        const aud = String(audience || '').trim();
        if (!aud || !/^[a-z0-9.-]+$/.test(aud)) return oauth(400, 'invalid_request', 'audience is required');
        if (app.environment === 'sandbox' && sandboxAudiences && !sandboxAudiences.has(aud)) return oauth(400, 'invalid_target', `${aud} does not accept sandbox tokens`);
        const held = [...app.grants.values()].filter((g) => g.status === 'approved' && g.audience === aud && inAllowance(project, g.capability))
            .map((g) => g.capability).filter((c) => !limit || limit.includes(c)).sort();
        const wanted = scope ? String(scope).split(/\s+/).filter(Boolean) : null;
        const missing = wanted ? wanted.filter((w) => !held.includes(w)) : [];
        if (missing.length) return oauth(400, 'invalid_scope', `not granted: ${missing.join(' ')}`);
        const cap = wanted || held;
        if (!cap.length) return oauth(400, 'invalid_scope', `no grants for audience ${aud}`);
        const now = Math.floor(Date.now() / 1000);
        const token = ctx.sign({
            iss: ctx.issuer, sub: `app:${app.id}`, actor_type: 'app', aud: [aud], cap, ns: [project.id], project_id: project.id, env: app.environment,
            ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}), iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
        });
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: cap.join(' ') }, { 'Cache-Control': 'no-store' });
    }

    /** /oauth/token for a registered app client id; null when the client id is not one. */
    function token(p) {
        if (!apps.has(p.get('client_id') || '')) return null;
        const found = usable(p.get('client_id'));
        if (found.res) return found.res;
        const { app, project } = found;
        const secret = p.get('client_secret');
        const authenticate = () => {
            if (app.client_type === 'public') return secret ? oauth(401, 'invalid_client', 'public apps have no client secret') : null;
            return matchSecret(app, secret) ? null : oauth(401, 'invalid_client', 'Invalid client credentials');
        };
        const grant = p.get('grant_type');
        if (grant === 'client_credentials') {
            if (app.client_type !== 'confidential') return oauth(400, 'unauthorized_client', 'public apps use authorization_code with PKCE');
            return authenticate() || mint({ app, project, audience: p.get('audience'), scope: p.get('scope') });
        }
        if (grant === 'authorization_code') {
            const bad = authenticate();
            if (bad) return bad;
            const c = codes.get(p.get('code') || '');
            if (!c || c.appId !== app.id) return oauth(400, 'invalid_grant', 'Invalid authorization code');
            if (c.used) return oauth(400, 'invalid_grant', 'Code already used');
            c.used = true;                                    // single use; a failed check below still burns it
            if (c.expiresAt < Date.now()) return oauth(400, 'invalid_grant', 'Authorization code expired');
            if (c.redirectUri !== (p.get('redirect_uri') || '')) return oauth(400, 'invalid_grant', 'Redirect URI mismatch');
            const v = p.get('code_verifier') || '';
            if (!PKCE_RE.test(v) || s256(v) !== c.codeChallenge) return oauth(400, 'invalid_grant', 'PKCE verification failed');
            if (c.audience && c.audience !== p.get('audience')) return oauth(400, 'invalid_grant', `the code was authorized for ${c.audience}`);
            const authorized = c.scope.length ? c.scope : null;
            const asked = p.get('scope') ? p.get('scope').split(/\s+/).filter(Boolean) : null;
            if (authorized && asked && asked.some((s) => !authorized.includes(s))) return oauth(400, 'invalid_scope', 'scope exceeds what the user authorized');
            return mint({ app, project, audience: p.get('audience'), scope: p.get('scope'), limit: authorized, onBehalfOf: c.subjectId });
        }
        return oauth(400, 'unsupported_grant_type', 'apps use client_credentials or authorization_code');
    }

    // ── Authorization ───────────────────────────────────────
    const isApp = (clientId) => apps.has(String(clientId || ''));

    /** Issue a code for an app, or throw with { status, error } when Network would refuse. */
    function issueCode({ clientId, redirectUri, subjectId, codeChallenge, codeChallengeMethod = 'S256', scope, audience }) {
        const found = usable(clientId);
        if (found.res) throw Object.assign(new Error('unknown or unusable app'), { status: 400, error: 'invalid_request' });
        const { app, project } = found;
        if (!redirectUri || !app.redirect_uris.includes(String(redirectUri))) throw Object.assign(new Error('Invalid redirect_uri'), { status: 400, error: 'invalid_request' });
        if (!codeChallenge || codeChallengeMethod !== 'S256' || !PKCE_RE.test(String(codeChallenge))) {
            throw Object.assign(new Error('apps must send a PKCE code_challenge with code_challenge_method=S256'), { status: 400, error: 'invalid_request' });
        }
        const user = ctx.users.get(subjectId) || [...ctx.users.values()][0] || ctx.addUser();
        if (app.environment === 'sandbox' && !project.open && !project.members.has(user.subject_id)) {
            throw Object.assign(new Error('sandbox apps can only be authorized by members of their project'), { status: 403, error: 'access_denied', redirectable: true });
        }
        const code = crypto.randomBytes(32).toString('hex');
        const list = (Array.isArray(scope) ? scope : String(scope || '').split(/\s+/)).filter(Boolean);
        codes.set(code, { appId: app.id, redirectUri: String(redirectUri), subjectId: user.subject_id, codeChallenge: String(codeChallenge), scope: list, audience: audience || null, expiresAt: Date.now() + CODE_TTL_MS, used: false });
        return code;
    }

    /** GET /oauth/authorize for an app client id (auto-consent as ctx.authorization.subjectId). */
    function authorizeRoute(url) {
        const q = url.searchParams;
        const clientId = q.get('client_id');
        const found = usable(clientId);
        if (found.res) return json(400, { error: 'invalid_request', error_description: 'Unknown client_id' });
        const redirectUri = q.get('redirect_uri') || '';
        if (!found.app.redirect_uris.includes(redirectUri)) return json(400, { error: 'invalid_request', error_description: 'Invalid redirect_uri' });
        const back = (params) => redirect(redirectUri, { ...params, state: q.get('state') });
        if (q.get('response_type') !== 'code') return back({ error: 'unsupported_response_type' });
        if (q.get('prompt') === 'none') return back({ error: 'interaction_required', error_description: 'apps need the person to choose to continue' });
        if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256' || !PKCE_RE.test(q.get('code_challenge'))) {
            return json(400, { error: 'invalid_request', error_description: 'apps must send a PKCE code_challenge with code_challenge_method=S256' });
        }
        if (ctx.authorization.decision === 'deny') return back({ error: 'access_denied', error_description: 'the person declined' });
        try {
            const code = issueCode({
                clientId, redirectUri, subjectId: ctx.authorization.subjectId, codeChallenge: q.get('code_challenge'),
                codeChallengeMethod: q.get('code_challenge_method'), scope: q.get('scope'), audience: q.get('audience'),
            });
            return back({ code });
        } catch (err) {
            return back({ error: err.error || 'server_error', error_description: err.message });
        }
    }

    // ── /api/v1/projects ────────────────────────────────────
    class DevError extends Error { constructor(status, code, detail) { super(detail); this.status = status; this.code = code; } }
    const fail = (status, code, detail) => { throw new DevError(status, code, detail); };

    function access(actor, projectId, { need = 'viewer', staffOk = true, allowArchived = false } = {}) {
        const p = projects.get(projectId);
        const role = p ? p.members.get(actor.subject) || null : null;
        if (!p || (!role && !actor.staff)) fail(404, 'project.not_found', 'no such project');
        if (p.archived_at && !allowArchived) fail(409, 'project.archived', 'project is archived');
        if (role && RANK[role] >= RANK[need]) return { project: p, role };
        if (actor.staff && staffOk) return { project: p, role };
        return fail(403, 'project.forbidden', `needs ${need}`);
    }
    function loadApp(project, appId) {
        const a = apps.get(appId);
        if (!a || a.project_id !== project.id) fail(404, 'app.not_found', 'no such app');
        return a;
    }
    const manageRole = (env) => (env === 'production' ? 'admin' : 'developer');
    const allowanceList = (p) => (p.allowance === '*' ? ['*'] : [...p.allowance].sort());
    function projectView(p, role) {
        return {
            id: p.id, name: p.name, owner: p.owner ? { type: 'user', id: p.owner } : null, role: role || null,
            environment_policy: p.environment_policy, environments: ENV_POLICIES[p.environment_policy], allowance: allowanceList(p),
            created_at: p.created_at, archived_at: p.archived_at,
            counts: { members: p.members.size, apps: [...apps.values()].filter((a) => a.project_id === p.id && !a.revoked_at).length },
        };
    }
    function appView(a) {
        return {
            id: a.id, subject: { type: 'app', id: a.id }, project_id: a.project_id, name: a.name, environment: a.environment, client_id: a.id,
            client_type: a.client_type, redirect_uris: [...a.redirect_uris], created_at: a.created_at, revoked_at: a.revoked_at,
            grants: [...a.grants.values()].filter((g) => g.status === 'approved').map((g) => g.capability).sort(),
        };
    }
    const credentialView = (c) => ({ id: c.id, hint: c.hint, state: credentialState(c), created_at: c.created_at, expires_at: c.expires_at, revoked_at: c.revoked_at });
    const grantView = (a, g) => ({ app_id: a.id, ...g });
    function memberView(subject, role) {
        const u = ctx.users.get(subject);
        return { subject: { type: 'user', id: subject }, username: u ? u.username : null, display_name: u ? (u.display_name || u.username) : null, role };
    }
    const cleanName = (n) => {
        const s = String(n || '').trim();
        if (!s || s.length > 80) fail(422, 'project.invalid', 'name is 1..80 characters');
        return s;
    };

    function setGrant(p, a, g, actor, status) {
        const from = g.status;
        Object.assign(g, { status, decided_by: actor, decided_at: nowIso() });
        audit(p, actor, `grant.${status}`, `app:${a.id}`, { capability: g.capability, from });
    }

    async function projectsApi(req, url) {
        const h = req.headers.get('authorization') || '';
        if (!h.startsWith('Bearer ')) return problem(401, 'auth.required', 'send Authorization: Bearer <Network access token>');
        const user = ctx.userOf(req);
        if (!user) return problem(401, 'auth.invalid', 'not a Network user access token');
        const u = ctx.users.get(user.subject_id);
        const actor = { subject: user.subject_id, staff: (u ? u.role : user.role) === 'admin', label: `user:${user.subject_id}` };
        const path = url.pathname.slice('/api/v1/projects'.length).replace(/\/+$/, '');
        const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
        const m = req.method;
        const body = ['POST', 'PUT', 'PATCH'].includes(m) ? await req.json().catch(() => ({})) || {} : {};
        const ok = (status, out) => json(status, out, { 'Cache-Control': 'private, no-store' });
        try {
            if (!seg.length) {
                if (m === 'GET') {
                    const all = url.searchParams.get('all') === '1' && actor.staff;
                    return ok(200, { projects: [...projects.values()].filter((p) => all || p.members.has(actor.subject)).map((p) => projectView(p, p.members.get(actor.subject))) });
                }
                if (m === 'POST') {
                    const allowance = opts.defaultAllowance === undefined ? catalog().map((c) => c.id) : opts.defaultAllowance;
                    const p = addProject({ name: cleanName(body.name), owner: actor.subject, environmentPolicy: 'sandbox', allowance });
                    audit(p, actor.label, 'project.created', `project:${p.id}`, { name: p.name });
                    return ok(201, projectView(p, 'owner'));
                }
            }
            if (seg[0] === 'catalog' && seg.length === 1 && m === 'GET') return ok(200, { capabilities: catalog() });
            const pid = seg[0];
            if (seg.length === 1) {
                if (m === 'GET') { const { project, role } = access(actor, pid, { allowArchived: true }); return ok(200, projectView(project, role)); }
                if (m === 'PATCH') { const { project, role } = access(actor, pid, { need: 'admin', staffOk: false }); project.name = cleanName(body.name); return ok(200, projectView(project, role)); }
            }
            if (seg.length === 2 && seg[1] === 'archive' && m === 'POST') {
                const { project, role } = access(actor, pid, { need: 'owner' });
                project.archived_at = nowIso();
                for (const a of apps.values()) if (a.project_id === project.id && !a.revoked_at) a.revoked_at = project.archived_at;
                audit(project, actor.label, 'project.archived', `project:${project.id}`);
                return ok(200, projectView(project, role));
            }
            if (seg.length === 2 && seg[1] === 'allowance' && m === 'PUT') {
                if (!actor.staff) fail(403, 'project.forbidden', 'staff only');
                const { project } = access(actor, pid);
                const wanted = (Array.isArray(body.capabilities) ? body.capabilities : []).map(String);
                const bad = wanted.find((c) => !grantable(c));
                if (bad) fail(403, 'grant.not_grantable', `${bad} is not grantable to apps`);
                project.allowance = new Set(wanted);
                const trimmed = [];
                for (const a of apps.values()) {
                    if (a.project_id !== project.id) continue;
                    for (const g of a.grants.values()) {
                        if (wanted.includes(g.capability)) continue;
                        if (g.status === 'approved') { setGrant(project, a, g, actor.label, 'revoked'); trimmed.push({ app_id: a.id, capability: g.capability, to: 'revoked' }); }
                        if (g.status === 'requested') { setGrant(project, a, g, actor.label, 'denied'); trimmed.push({ app_id: a.id, capability: g.capability, to: 'denied' }); }
                    }
                }
                return ok(200, { allowance: allowanceList(project), trimmed });
            }
            if (seg.length === 2 && seg[1] === 'environment-policy' && m === 'PUT') {
                if (!actor.staff) fail(403, 'project.forbidden', 'staff only');
                const { project } = access(actor, pid);
                if (!ENV_POLICIES[body.environment_policy]) fail(422, 'project.invalid', 'environment_policy is sandbox or sandbox+production');
                project.environment_policy = body.environment_policy;
                return ok(200, { environment_policy: project.environment_policy, environments: ENV_POLICIES[project.environment_policy] });
            }
            if (seg[1] === 'members') return members(actor, pid, seg, m, body, ok);
            if (seg[1] === 'apps') return appsRoutes(actor, pid, seg, m, body, ok);
            if (seg[1] === 'quotas') {
                const { project } = access(actor, pid, { allowArchived: true });
                if (seg.length === 2 && m === 'GET') return ok(200, { quotas: [...project.quotas.values()], note: 'quotas are enforced by the service that owns each capability; Network records and exposes them' });
                if (seg.length === 3 && (m === 'PUT' || m === 'DELETE')) {
                    if (!actor.staff) fail(403, 'project.forbidden', 'staff only');
                    if (m === 'DELETE') { if (!project.quotas.delete(seg[2])) fail(404, 'quota.not_found', 'no such quota'); return new Response(null, { status: 204 }); }
                    const q = { capability: seg[2], limit: Number(body.limit), window: body.window, unit: body.unit, enforced_by: audienceOf(seg[2]), updated_at: nowIso() };
                    project.quotas.set(seg[2], q);
                    return ok(200, q);
                }
            }
            if (seg.length === 2 && seg[1] === 'audit' && m === 'GET') {
                const { project } = access(actor, pid, { need: 'admin', allowArchived: true });
                const before = Number(url.searchParams.get('before')) || Infinity;
                const n = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
                const rows = project.audit.filter((e) => e.id < before).reverse().slice(0, n);
                return ok(200, { entries: rows, next_before: rows.length === n ? rows[rows.length - 1].id : null });
            }
            return problem(404, 'not_found', 'no such route');
        } catch (err) {
            if (err instanceof DevError) return problem(err.status, err.code, err.message);
            throw err;
        }
    }

    function members(actor, pid, seg, m, body, ok) {
        if (seg.length === 2 && m === 'GET') {
            const { project } = access(actor, pid, { allowArchived: true });
            return ok(200, { members: [...project.members].map(([s, r]) => memberView(s, r)) });
        }
        if (seg.length === 2 && m === 'POST') {
            const role = String(body.role || '');
            if (!['admin', 'developer', 'viewer'].includes(role)) fail(422, 'member.invalid', 'role is admin, developer or viewer');
            const { project } = access(actor, pid, { need: role === 'admin' ? 'owner' : 'admin', staffOk: false });
            const u = body.subject_id ? ctx.users.get(body.subject_id) : [...ctx.users.values()].find((x) => x.username === body.username);
            if (!u) fail(404, 'member.user_not_found', 'no such user');
            if (project.members.has(u.subject_id)) fail(409, 'member.exists', 'already a member');
            project.members.set(u.subject_id, role);
            audit(project, actor.label, 'member.added', `user:${u.subject_id}`, { role });
            return ok(201, memberView(u.subject_id, role));
        }
        if (seg.length === 3) {
            const { project, role: mine } = access(actor, pid, { allowArchived: m === 'DELETE' });
            const subject = seg[2];
            const theirs = project.members.get(subject);
            if (!theirs) fail(404, 'member.not_found', 'not a member');
            if (m === 'PATCH') {
                const role = String(body.role || '');
                if (!['admin', 'developer', 'viewer'].includes(role)) fail(422, 'member.invalid', 'role is admin, developer or viewer');
                if (theirs === 'owner') fail(409, 'member.owner', 'ownership cannot be changed here');
                const need = role === 'admin' || theirs === 'admin' ? 'owner' : 'admin';
                if (!mine || RANK[mine] < RANK[need]) fail(403, 'project.forbidden', `needs ${need}`);
                project.members.set(subject, role);
                return ok(200, memberView(subject, role));
            }
            if (m === 'DELETE') {
                if (theirs === 'owner') fail(409, 'member.owner', 'the owner cannot leave');
                const self = subject === actor.subject;
                const need = theirs === 'admin' ? 'owner' : 'admin';
                if (!self && (!mine || RANK[mine] < RANK[need])) fail(403, 'project.forbidden', `needs ${need}`);
                project.members.delete(subject);
                audit(project, actor.label, 'member.removed', `user:${subject}`);
                return new Response(null, { status: 204 });
            }
        }
        return problem(404, 'not_found', 'no such route');
    }

    function appsRoutes(actor, pid, seg, m, body, ok) {
        if (seg.length === 2 && m === 'GET') {
            const { project } = access(actor, pid, { allowArchived: true });
            return ok(200, { apps: [...apps.values()].filter((a) => a.project_id === project.id).map(appView) });
        }
        if (seg.length === 2 && m === 'POST') {
            const environment = String(body.environment || 'sandbox');
            if (!['sandbox', 'production'].includes(environment)) fail(422, 'app.invalid', 'environment is sandbox or production');
            const { project } = access(actor, pid, { need: manageRole(environment), staffOk: false });
            if (!ENV_POLICIES[project.environment_policy].includes(environment)) fail(403, 'app.environment_not_allowed', `this project may only have ${ENV_POLICIES[project.environment_policy].join(', ')} apps (staff enable production)`);
            const type = String(body.type || 'confidential');
            if (!['confidential', 'public'].includes(type)) fail(422, 'app.invalid', 'type is confidential or public');
            const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
            for (const r of redirects) {
                let u;
                try { u = new URL(r); } catch { fail(422, 'app.invalid_redirect', `${r} is not a URL`); }
                const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
                if (u.hash || u.username || u.password) fail(422, 'app.invalid_redirect', 'no fragments or credentials in redirect URIs');
                if (u.protocol !== 'https:' && !(local && u.protocol === 'http:' && environment === 'sandbox')) fail(422, 'app.invalid_redirect', 'redirect URIs are https (http://localhost for sandbox apps only)');
            }
            if (type === 'public' && !redirects.length) fail(422, 'app.invalid', 'a public app needs at least one redirect URI');
            const made = addApp({ project: project.id, name: cleanName(body.name), environment, type, redirectUris: redirects });
            const a = apps.get(made.id);
            audit(project, actor.label, 'app.created', `app:${a.id}`, { environment, client_type: type });
            const out = appView(a);
            if (made.secret) {
                const c = a.credentials[0];
                out.credential = { id: c.id, client_secret: c.secret, hint: c.hint, shown_once: true };
            }
            return ok(201, out);
        }
        const { project, role } = access(actor, pid, { allowArchived: true });
        const a = loadApp(project, seg[2]);
        const manage = () => {
            if (!role || RANK[role] < RANK[manageRole(a.environment)]) fail(403, 'project.forbidden', `needs ${manageRole(a.environment)}`);
            if (project.archived_at) fail(409, 'project.archived', 'project is archived');
        };
        if (seg.length === 3) {
            if (m === 'GET') return ok(200, appView(a));
            if (m === 'PATCH') {
                manage();
                if (body.name !== undefined) a.name = cleanName(body.name);
                if (Array.isArray(body.redirect_uris)) a.redirect_uris = body.redirect_uris.map(String);
                return ok(200, appView(a));
            }
            if (m === 'DELETE') {
                if (!actor.staff) manage();
                if (!a.revoked_at) { a.revoked_at = nowIso(); audit(project, actor.label, 'app.revoked', `app:${a.id}`); }
                return ok(200, appView(a));
            }
        }
        if (seg[3] === 'credentials') {
            if (seg.length === 4 && m === 'GET') return ok(200, { credentials: a.credentials.map(credentialView) });
            if (seg.length === 5 && seg[4] === 'rotate' && m === 'POST') {
                manage();
                if (a.revoked_at) fail(409, 'app.revoked', 'app is revoked');
                if (a.client_type !== 'confidential') fail(409, 'credential.public_client', 'public apps have no client secret');
                const overlap = body.overlap_seconds === undefined ? 86400 : Number(body.overlap_seconds);
                if (!Number.isInteger(overlap) || overlap < 0 || overlap > 7 * 86400) fail(422, 'credential.invalid', 'overlap_seconds is an integer from 0 to 604800');
                const until = new Date(Date.now() + overlap * 1000).toISOString();
                const kept = [];
                for (const c of a.credentials) {
                    if (c.revoked_at || credentialState(c) === 'expired') continue;
                    c.expires_at = c.expires_at && c.expires_at < until ? c.expires_at : until;
                    kept.push({ id: c.id, expires_at: c.expires_at });
                }
                const c = newCredential(a);
                audit(project, actor.label, 'credential.rotated', `app:${a.id}`, { credential_id: c.id, overlap_seconds: overlap });
                return ok(201, { credential: { id: c.id, client_secret: c.secret, hint: c.hint, shown_once: true }, previous: kept });
            }
            if (seg.length === 6 && seg[5] === 'revoke' && m === 'POST') {
                if (!actor.staff) manage();
                const c = a.credentials.find((x) => x.id === seg[4]);
                if (!c) fail(404, 'credential.not_found', 'no such credential');
                if (!c.revoked_at) { c.revoked_at = nowIso(); audit(project, actor.label, 'credential.revoked', `app:${a.id}`, { credential_id: c.id }); }
                return ok(200, credentialView(c));
            }
        }
        if (seg[3] === 'grants') {
            if (seg.length === 4 && m === 'GET') return ok(200, { grants: [...a.grants.values()].map((g) => grantView(a, g)) });
            if (seg.length === 4 && m === 'POST') {
                if (!role || RANK[role] < RANK.developer) fail(403, 'project.forbidden', 'needs developer');
                if (a.revoked_at) fail(409, 'app.revoked', 'app is revoked');
                const cap = String(body.capability || '');
                if (!grantable(cap)) fail(403, 'grant.not_grantable', `${cap} is not in the capability catalog for apps`);
                const existing = a.grants.get(cap);
                if (existing && ['approved', 'requested'].includes(existing.status)) return ok(201, grantView(a, existing));
                const now = RANK[role] >= RANK.admin && inAllowance(project, cap);
                const g = { capability: cap, audience: audienceOf(cap), status: now ? 'approved' : 'requested', requested_by: actor.label, requested_at: nowIso(), decided_by: now ? actor.label : null, decided_at: now ? nowIso() : null };
                a.grants.set(cap, g);
                audit(project, actor.label, now ? 'grant.approved' : 'grant.requested', `app:${a.id}`, { capability: cap });
                return ok(201, grantView(a, g));
            }
            const g = a.grants.get(seg[4]);
            if (seg.length === 6 && ['approve', 'deny'].includes(seg[5]) && m === 'POST') {
                if (!role || RANK[role] < RANK.admin) fail(403, 'project.forbidden', 'needs admin');
                if (!g) fail(404, 'grant.not_found', 'no such grant');
                if (seg[5] === 'approve') {
                    if (!inAllowance(project, g.capability)) fail(403, 'grant.beyond_allowance', `${g.capability} is not in this project's allowance`);
                    if (g.status !== 'approved') setGrant(project, a, g, actor.label, 'approved');
                } else {
                    if (g.status !== 'requested') fail(409, 'grant.not_pending', `grant is ${g.status}`);
                    setGrant(project, a, g, actor.label, 'denied');
                }
                return ok(200, grantView(a, g));
            }
            if (seg.length === 5 && m === 'DELETE') {
                if (!actor.staff && (!role || RANK[role] < RANK.admin)) fail(403, 'project.forbidden', 'needs admin');
                if (!g) fail(404, 'grant.not_found', 'no such grant');
                if (g.status !== 'approved') fail(409, 'grant.not_active', `grant is ${g.status}`);
                setGrant(project, a, g, actor.label, 'revoked');
                return ok(200, grantView(a, g));
            }
        }
        return problem(404, 'not_found', 'no such route');
    }

    return { projects, apps, addApp, addProject, token, isApp, issueCode, authorizeRoute, projectsApi, catalog };
}

module.exports = { createDeveloper, DEFAULT_APP_CATALOG, APP_ID_RE, PRJ_ID_RE };
