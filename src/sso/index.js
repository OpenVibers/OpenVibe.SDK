'use strict';
/**
 * openvibe-sdk/sso: a site's sign-in with OpenVibe.Network (the OAuth2 client session layer every product site used to
 * copy: Blog, Coupons, Deals, Host, News, Trade). One call gives the routes, the middleware and offline verification.
 *
 *   const { createSsoClient } = require('openvibe-sdk/sso');
 *   const sso = createSsoClient({
 *       site: 'trade',                                   // log prefix and the default extra audience openvibe.trade
 *       baseUrl: 'https://openvibe.trade',               // this site's origin (post-sign-in targets, redirect URI)
 *       clientId, clientSecret,                          // the site's OAuth client in the Network
 *       networkUrl: 'https://openvibe.network', networkInternalUrl: 'http://127.0.0.1:4000',
 *       secureCookies: true,
 *   });
 *   app.use('/auth', sso.router(express));               // /login /callback /fedcm /logout /me /refresh
 *   app.use(sso.optionalAuth());                         // req.user, req.token when a valid session is presented
 *   app.get('/private', sso.requireAuth(), handler);     // 401 JSON without a session
 *
 * Routes (mounted at /auth; the redirect URI is <baseUrl>/auth/callback unless `redirectUri` says otherwise):
 *   GET  /login     → Network /oauth/authorize with state and PKCE (S256); ?silent=1: prompt=none; ?prompt=select_account
 *                     (the chooser) or login (the sign-in form) and ?login_hint=<username> pass through; ?next= a same-site
 *                     path, this site's https origin or the Network's (control characters and backslashes go home)
 *   GET  /callback  → the state is required and compared in constant time; the code is exchanged server-side with the
 *                     client secret and the PKCE verifier; cookies are set; back to `next`
 *   POST /fedcm     → the shared navbar's FedCM assertion (nonce pre-checked) swapped for tokens (jwt-bearer grant)
 *   GET  /logout    → cookies cleared, the refresh token revoked (best effort), hint=guest
 *   GET  /me        → the verified session's profile
 *   POST /refresh   → rotate the tokens with the refresh token
 *   GET  /health    → { ok, client: 'ok' | 'invalid' | 'unknown' }: does the Network accept this site's OAuth client?
 *                     (a token request with a code that cannot exist: invalid_grant means the client is fine,
 *                     invalid_client means its id or secret is wrong; cached 10 minutes; 503 only for 'invalid')
 *
 * When a sign-in cannot finish (0.73.0): a lost or expired flow (the state cookie is gone or does not match) and a code
 * the Network no longer accepts (invalid_grant: used twice, or too old) start the sign-in once more by themselves, with
 * a two-minute ov_oauth_retry cookie so it never loops; neither sets a session. A second failure, a client the Network
 * refuses (invalid_client: a configuration error, logged as one with what to check) and a Network that does not answer
 * show a small page in plain words with "Try again" and "Back to <site>", never a bare line of text.
 * Cookies (host-only): ov_token (the access JWT, SameSite=Lax, readable by the shared navbar), ov_refresh (httpOnly,
 * Path=/auth), ov_sso_hint ('account' / 'guest'), and the short-lived flow cookies on /auth.
 *
 * Verification is offline through the SDK's shared JWKS client (./auth/jwks.js: the last good keys through a Network
 * outage, rotations honoured) and verifyUserToken (issuer, audience, expiry; service principals and typed tokens such as
 * a FedCM assertion are never a session). No express dependency: pass your express module to router().
 */
const crypto = require('node:crypto');
const { verifyUserToken } = require('../auth/jwt');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const HINT_COOKIE = 'ov_sso_hint';
const STATE_COOKIE = 'ov_oauth_state';
const NEXT_COOKIE = 'ov_oauth_next';
const SILENT_COOKIE = 'ov_oauth_silent';
const VERIFIER_COOKIE = 'ov_oauth_verifier';
const FLOW_COOKIES = [STATE_COOKIE, NEXT_COOKIE, SILENT_COOKIE, VERIFIER_COOKIE];
const RETRY_COOKIE = 'ov_oauth_retry';
// A code no sign-in can ever have: the health check presents it and reads which way the Network refuses it.
const HEALTH_CODE = 'ov_health_check_never_issued';

const trim = (u) => String(u || '').replace(/\/+$/, '');

/** The Cookie header as an object (no cookie-parser needed). */
function parseCookies(req) {
    if (req.cookies && typeof req.cookies === 'object') return req.cookies;
    const out = {};
    for (const part of String((req.headers && req.headers.cookie) || '').split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i).trim();
        if (!(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); } }
    }
    return out;
}

/**
 * Only a same-site relative path, this site's own https origin, or the Network's https origin is a post-auth target.
 * Browsers drop tabs and newlines from a URL and read a backslash as "/": "/<TAB>/evil.com" would leave the site, so a
 * next with any control character or backslash goes home.
 */
function sanitizeNext(next, { baseUrl, networkUrl } = {}) {
    if (typeof next !== 'string' || !next) return '/';
    if (/[\u0000-\u001f\u007f\\]/.test(next)) return '/';
    if (/^\/(?!\/)/.test(next)) return next;
    try {
        const u = new URL(next);
        if (u.protocol !== 'https:') return '/';
        const allowed = [baseUrl, networkUrl].map((b) => { try { return new URL(b).hostname; } catch { return null; } }).filter(Boolean);
        if (allowed.includes(u.hostname)) return u.toString();
    } catch { /* fall through */ }
    return '/';
}

/** Append ?key=value to a same-site path or absolute URL, keeping any existing query and hash. */
function withParam(target, key, value) {
    const hashAt = target.indexOf('#');
    const hash = hashAt >= 0 ? target.slice(hashAt) : '';
    const base = hashAt >= 0 ? target.slice(0, hashAt) : target;
    return `${base}${base.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

/** A JWT's payload WITHOUT checking its signature: only to pre-check a FedCM nonce before the Network verifies it. */
function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
    } catch { return null; }
}

/** True when the assertion's `nonce` claim is exactly the nonce the page posted (constant time). */
function fedcmNonceMatches(token, nonce) {
    if (typeof nonce !== 'string' || !nonce || nonce.length > 256) return false;
    const claims = decodeJwtPayload(token);
    if (!claims || typeof claims.nonce !== 'string') return false;
    const a = Buffer.from(claims.nonce), b = Buffer.from(nonce);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The claims a site shows as "the user" (registered claims removed). */
function claimsToUser(claims) {
    if (!claims) return null;
    const { iat, exp, aud, iss, nbf, jti, ...user } = claims;   // eslint-disable-line no-unused-vars
    return user;
}

function sameString(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The page a sign-in that cannot finish shows: what happened in plain words, "Try again" (a fresh sign-in back to where
 * the person was going) and the way back. Self-contained (no script, no font, no request): the theme's colours when the
 * site's page variables are not there, light or dark as the device is.
 */
function failurePage({ siteName, title, text, retryHref, backHref }) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`
        + '<style>:root{--b:#0a0f1c;--c:#131c2e;--t:#e6edf7;--m:#96a7c2;--a:#3b82f6;--l:#1f2d47}@media (prefers-color-scheme:light){:root{--b:#f6f7fb;--c:#fff;--t:#0f172a;--m:#475569;--a:#1d4ed8;--l:#e3e7ef}}'
        + 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--b);color:var(--t);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
        + 'main{box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:28px 24px;border:1px solid var(--l);border-radius:18px;background:var(--c)}'
        + 'h1{margin:0 0 8px;font-size:1.3rem}p{margin:0 0 20px;color:var(--m)}nav{display:flex;flex-wrap:wrap;gap:10px}'
        + 'a{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:999px;font-weight:650;text-decoration:none}'
        + 'a.go{background:var(--a);color:#fff}a.back{color:var(--t);border:1px solid var(--l)}a:focus-visible{outline:3px solid var(--a);outline-offset:2px}</style></head>'
        + `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><nav><a class="go" href="${escapeHtml(retryHref)}">Try again</a><a class="back" href="${escapeHtml(backHref)}">Back to ${escapeHtml(siteName)}</a></nav></main></body></html>`;
}

function createSsoClient(opts = {}) {
    const site = String(opts.site || 'site');
    const baseUrl = trim(opts.baseUrl);
    const networkUrl = trim(opts.networkUrl || 'https://openvibe.network');
    const networkInternalUrl = trim(opts.networkInternalUrl || networkUrl);
    const issuer = trim(opts.issuer || networkUrl);
    const redirectUri = opts.redirectUri || `${baseUrl}/auth/callback`;
    const scope = opts.scope || 'profile';
    const audience = opts.audience || ['openvibe.network', `openvibe.${site}`];
    const jwks = opts.jwks || (opts.publicKey ? null : `${networkInternalUrl}/api/.well-known/jwks`);
    const secure = opts.secureCookies !== false;
    const fetchImpl = opts.fetch || globalThis.fetch;
    const log = opts.log || console;
    const accessMaxAgeMs = opts.accessMaxAgeMs || 24 * 3600e3;
    if (!baseUrl || !opts.clientId) throw new TypeError('createSsoClient: baseUrl and clientId are required');
    const next = (value) => sanitizeNext(value, { baseUrl, networkUrl });
    const siteName = String(opts.siteName || `OpenVibe.${site.charAt(0).toUpperCase()}${site.slice(1)}`);

    /** The verified claims of a session token, or null. Never throws. */
    async function verify(token) {
        if (!token) return null;
        try {
            return await verifyUserToken(token, { jwks, publicKey: opts.publicKey, issuer, audience, log, fetch: fetchImpl });
        } catch (err) {
            if (err && err.code === 'token.no_key') log.warn(`[${site} auth] Network keys unavailable: ${err.message}`);
            return null;
        }
    }

    /** The session token: a Bearer header, else the ov_token cookie. */
    function extractToken(req) {
        const h = String((req.headers && req.headers.authorization) || '');
        if (h.startsWith('Bearer ')) return h.slice(7).trim() || null;
        return parseCookies(req)[ACCESS_COOKIE] || null;
    }

    const cookie = (maxAge, { httpOnly = true, path = '/' } = {}) => ({ sameSite: 'lax', secure, httpOnly, path, ...(maxAge ? { maxAge } : {}) });
    const accessOpts = () => cookie(accessMaxAgeMs, { httpOnly: false });            // the shared navbar reads it
    const refreshOpts = () => cookie(30 * 24 * 3600e3, { path: '/auth' });
    const flowOpts = () => cookie(10 * 60e3, { path: '/auth' });
    const hintOpts = () => cookie(365 * 24 * 3600e3, { httpOnly: false });

    function setSession(res, accessToken, refreshToken) {
        res.cookie(ACCESS_COOKIE, accessToken, accessOpts());
        if (refreshToken) res.cookie(REFRESH_COOKIE, refreshToken, refreshOpts());
        res.cookie(HINT_COOKIE, 'account', hintOpts());
    }
    function clearSession(res) {
        res.clearCookie(ACCESS_COOKIE, { ...accessOpts(), maxAge: undefined });
        res.clearCookie(REFRESH_COOKIE, { ...refreshOpts(), maxAge: undefined });
    }
    const clearFlow = (res) => { for (const c of FLOW_COOKIES) res.clearCookie(c, { path: '/auth' }); };
    const retryOpts = () => cookie(2 * 60e3, { path: '/auth' });
    const loginHref = (target) => `/auth/login${target && target !== '/' ? `?next=${encodeURIComponent(target)}` : ''}`;
    /** A sign-in that can recover starts once more by itself; the second time it shows the page. Never sets a session. */
    function retryOrExplain(req, res, target, page) {
        if (parseCookies(req)[RETRY_COOKIE] !== '1') {
            res.cookie(RETRY_COOKIE, '1', retryOpts());
            return res.redirect(loginHref(target));
        }
        res.clearCookie(RETRY_COOKIE, { path: '/auth' });
        return explain(res, 400, target, page);
    }
    function explain(res, status, target, { title, text }) {
        if (typeof res.type === 'function') res.type('html');
        if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');
        return res.status(status).send(failurePage({ siteName, title, text, retryHref: loginHref(target), backHref: target || '/' }));
    }
    const SIGN_IN_AGAIN = { title: 'Sign-in didn\'t finish', text: 'It took too long, or it started in another tab or app. Start it again and it will go through; your account is fine.' };

    /** A token grant at the Network: the internal URL first, the public one if it cannot be reached. */
    async function tokenGrant(body) {
        let lastErr = null;
        for (const base of [...new Set([networkInternalUrl, networkUrl])]) {
            try {
                const res = await fetchImpl(`${base}/oauth/token`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, ...body }),
                    signal: AbortSignal.timeout(10_000),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    throw Object.assign(new Error(data.error_description || data.error || `token grant failed (${res.status})`), {
                        status: res.status, error: data.error || 'invalid_grant', error_description: data.error_description || null,
                    });
                }
                return data;
            } catch (err) {
                lastErr = err;
                if (err.status && err.status < 500) throw err;   // the grant itself is bad: another base will not help
            }
        }
        throw lastErr || new Error('Network unreachable');
    }

    /** The authorize URL for a sign-in (pure; exported for tests). → { url, state, verifier } */
    function authorizeUrl({ silent = false, prompt = '', loginHint = '' } = {}) {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const state = crypto.randomBytes(24).toString('base64url');
        const u = new URL(`${networkUrl}/oauth/authorize`);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', opts.clientId);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('scope', scope);
        u.searchParams.set('state', state);
        u.searchParams.set('code_challenge', challenge);
        u.searchParams.set('code_challenge_method', 'S256');
        // silent: continue as the account openvibe.network already knows (no chooser); with no Network session either it
        // bounces back with error=login_required and the site stays quiet.
        if (silent) u.searchParams.set('prompt', 'none');
        // "Switch account" (the chooser) and "use another account" (the sign-in form); login_hint names the account the
        // chooser continues as when this browser has it (Network docs/sign-in.md).
        else if (prompt === 'select_account' || prompt === 'login') u.searchParams.set('prompt', prompt);
        const hint = String(loginHint || '').trim();
        if (hint.length <= 64 && /^@?[A-Za-z0-9_.-]+$/.test(hint)) u.searchParams.set('login_hint', hint);
        return { url: u.toString(), state, verifier };
    }

    const handlers = {
        async login(req, res) {
            const q = req.query || {};
            const silent = !!q.silent && q.silent !== '0';
            // Already signed in here? A silent round trip would only hand back the session we have.
            if (silent && await verify(parseCookies(req)[ACCESS_COOKIE])) { clearFlow(res); return res.redirect(next(q.next)); }
            const { url, state, verifier } = authorizeUrl({ silent, prompt: String(q.prompt || ''), loginHint: q.login_hint });
            res.cookie(STATE_COOKIE, state, flowOpts());
            res.cookie(VERIFIER_COOKIE, verifier, flowOpts());
            const target = next(q.next);
            if (target !== '/') res.cookie(NEXT_COOKIE, target, flowOpts()); else res.clearCookie(NEXT_COOKIE, { path: '/auth' });
            if (silent) res.cookie(SILENT_COOKIE, '1', flowOpts()); else res.clearCookie(SILENT_COOKIE, { path: '/auth' });
            return res.redirect(url);
        },

        async callback(req, res) {
            const q = req.query || {};
            const c = parseCookies(req);
            const target = next(c[NEXT_COOKIE]);
            const silent = c[SILENT_COOKIE] === '1';
            if (q.error) {
                clearFlow(res);
                // Silent sign-in found no Network session: back quietly as a guest (?sso=none stops the navbar retrying).
                if (silent || q.error === 'login_required') return res.redirect(withParam(target, 'sso', 'none'));
                return res.redirect(withParam('/', 'auth_error', String(q.error)));
            }
            if (!q.code) return explain(res, 400, target, SIGN_IN_AGAIN);
            const expected = c[STATE_COOKIE], verifier = c[VERIFIER_COOKIE];
            clearFlow(res);
            // The state cookie is required, not only compared when present: skipping the check without it would let a
            // crafted link sign a visitor into someone else's account. A mismatch never sets a session; it starts a fresh
            // sign-in of the visitor's own (once), which is what a lost or expired flow cookie needs.
            if (!sameString(q.state, expected) || !verifier) return retryOrExplain(req, res, target, SIGN_IN_AGAIN);
            try {
                const data = await tokenGrant({ grant_type: 'authorization_code', redirect_uri: redirectUri, code: String(q.code), code_verifier: verifier });
                setSession(res, data.access_token, data.refresh_token);
                res.clearCookie(RETRY_COOKIE, { path: '/auth' });
                health = { client: 'ok', at: Date.now() };
                return res.redirect(target);
            } catch (err) {
                if (err.status === 401 || err.error === 'invalid_client' || err.error === 'unauthorized_client') {
                    health = { client: 'invalid', at: Date.now() };
                    log.error(`[${site} auth] the Network refuses this site's OAuth client (${err.error || err.status}): check its client id and secret (OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET) against the Network's registration`);
                    return explain(res, 500, target, { title: `Sign-in isn't working on ${siteName} right now`, text: 'This is a problem on our side, not with your account, and it has been logged. Please try again a little later.' });
                }
                log.warn(`[${site} auth] code exchange failed: ${err.message}`);
                if (err.status && err.status < 500) return retryOrExplain(req, res, target, SIGN_IN_AGAIN);
                return explain(res, 502, target, { title: 'OpenVibe.Network didn\'t answer', text: 'Your account is fine: the sign-in service did not reply in time. Try again in a moment.' });
            }
        },

        async fedcm(req, res) {
            const { token, nonce } = req.body || {};
            if (typeof token !== 'string' || !token || typeof nonce !== 'string' || !nonce) {
                return res.status(400).json({ error: 'invalid_request', error_description: 'token and nonce are required' });
            }
            if (!fedcmNonceMatches(token, nonce)) return res.status(400).json({ error: 'invalid_request', error_description: 'nonce mismatch' });
            try {
                const data = await tokenGrant({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: token });
                if (!data.access_token) throw Object.assign(new Error('no token'), { status: 401, error: 'invalid_grant' });
                setSession(res, data.access_token, data.refresh_token);
                return res.json({ ok: true, user: data.user || claimsToUser(await verify(data.access_token)) });
            } catch (err) {
                if (err.status && err.status < 500) return res.status(401).json({ error: err.error || 'invalid_grant', error_description: err.error_description || err.message });
                log.error(`[${site} auth] FedCM exchange failed: ${err.message}`);
                return res.status(502).json({ error: 'server_error', error_description: 'OpenVibe.Network could not be reached' });
            }
        },

        async logout(req, res) {
            // Best-effort revocation: the Network's rotating refresh tokens invalidate themselves anyway.
            const refresh = parseCookies(req)[REFRESH_COOKIE];
            if (refresh) {
                try {
                    await fetchImpl(`${networkInternalUrl}/oauth/revoke`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, token: refresh }),
                        signal: AbortSignal.timeout(3000),
                    });
                } catch { /* optional */ }
            }
            clearSession(res);
            res.cookie(HINT_COOKIE, 'guest', hintOpts());
            return res.redirect(next((req.query || {}).next));
        },

        async me(req, res) {
            const claims = await verify(extractToken(req));
            // Signed out answers 200 with no user, as Blog, Community and Wiki do: the shared navbar reads this on every page,
            // and a 401 showed as a failed request in every signed-out visitor's console.
            if (!claims) return res.json({ user: null });
            return res.json({ user: claimsToUser(claims), expires_at: claims.exp ? claims.exp * 1000 : null });
        },

        async refresh(req, res) {
            const refresh = parseCookies(req)[REFRESH_COOKIE];
            if (!refresh) return res.status(401).json({ error: 'No refresh token' });
            try {
                const data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: refresh });
                setSession(res, data.access_token, data.refresh_token);
                return res.json({ token: data.access_token, user: claimsToUser(await verify(data.access_token)) });
            } catch (err) {
                if (err.status && err.status < 500) { clearSession(res); return res.status(401).json({ error: 'The session ended. Please sign in again.' }); }
                log.error(`[${site} auth] refresh failed: ${err.message}`);
                return res.status(502).json({ error: 'OpenVibe.Network could not be reached' });
            }
        },
    };

    let health = null;   // { client, at }: the last check, or the last sign-in's verdict
    /**
     * Does the Network accept this site's OAuth client? A token request with a code no sign-in ever has: invalid_grant
     * means the id and secret are right, invalid_client that they are not. Cached 10 minutes. → 'ok' | 'invalid' | 'unknown'
     */
    async function checkClient({ force = false } = {}) {
        if (!force && health && Date.now() - health.at < 10 * 60e3) return health.client;
        try {
            await tokenGrant({ grant_type: 'authorization_code', redirect_uri: redirectUri, code: HEALTH_CODE, code_verifier: HEALTH_CODE });
            health = { client: 'ok', at: Date.now() };   // a stub that accepts anything: the client is not refused
        } catch (err) {
            const invalid = err.status === 401 || err.error === 'invalid_client' || err.error === 'unauthorized_client';
            health = { client: invalid ? 'invalid' : (err.status && err.status < 500 ? 'ok' : 'unknown'), at: Date.now() };
            if (invalid) log.error(`[${site} auth] the Network refuses this site's OAuth client: check OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET`);
        }
        return health.client;
    }
    handlers.health = async (req, res) => {
        const client = await checkClient();
        if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');
        return res.status(client === 'invalid' ? 503 : 200).json({ ok: client !== 'invalid', client });
    };

    /** The /auth router. Pass your express module (the SDK does not depend on it). */
    function router(express) {
        if (!express || typeof express.Router !== 'function') throw new TypeError('sso.router(express): pass the express module');
        const r = express.Router();
        const wrap = (fn) => (req, res, nextFn) => { Promise.resolve(fn(req, res)).catch(nextFn); };
        const json = express.json({ limit: '16kb', type: 'application/json' });
        const badJson = (err, _req, res, nextFn) => (err ? res.status(400).json({ error: 'invalid_request', error_description: 'Malformed JSON body' }) : nextFn());
        r.get('/login', wrap(handlers.login));
        r.get('/callback', wrap(handlers.callback));
        r.post('/fedcm', (req, res, nextFn) => (req.is && !req.is('application/json') ? res.status(400).json({ error: 'invalid_request', error_description: 'Expected application/json' }) : nextFn()), json, badJson, wrap(handlers.fedcm));
        r.get('/logout', wrap(handlers.logout));
        r.get('/me', wrap(handlers.me));
        r.post('/refresh', wrap(handlers.refresh));
        r.get('/health', wrap(handlers.health));
        return r;
    }

    /** req.user (claims without the registered ones) and req.token when a valid session is presented; never blocks. */
    function optionalAuth() {
        return (req, _res, nextFn) => {
            const token = extractToken(req);
            if (!token) return nextFn();
            verify(token).then((claims) => { if (claims) { req.user = claimsToUser(claims); req.token = token; } nextFn(); }, () => nextFn());
        };
    }

    /** 401 JSON without a valid session; otherwise req.user and req.token as optionalAuth sets them. */
    function requireAuth() {
        const opt = optionalAuth();
        return (req, res, nextFn) => opt(req, res, () => (req.user ? nextFn() : res.status(401).json({ error: 'Sign in required' })));
    }

    return { router, handlers, optionalAuth, requireAuth, verify, extractToken, authorizeUrl, tokenGrant, checkClient, redirectUri, audience };
}

module.exports = {
    createSsoClient, sanitizeNext, withParam, decodeJwtPayload, fedcmNonceMatches, claimsToUser, parseCookies, failurePage,
    COOKIES: Object.freeze({ access: ACCESS_COOKIE, refresh: REFRESH_COOKIE, hint: HINT_COOKIE }),
};
