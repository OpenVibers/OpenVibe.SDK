'use strict';
/**
 * openvibe-sdk/app-signin: "Sign in with OpenVibe" for developer apps — a drop-in router, the same
 * recovery and the same health check as openvibe-sdk/sso 0.73.0, built on the SDK's own auth
 * helpers (authorization code + PKCE, the state check). Nothing here re-implements OAuth.
 *
 *   const { createAppSignIn } = require('openvibe-sdk/app-signin');
 *   const signIn = createAppSignIn({
 *       clientId: 'app_...', clientSecret: '...',       // the app's credentials (never in the browser)
 *       redirectUri: 'https://app.example/auth/callback',
 *       networkUrl: 'https://openvibe.network',
 *       audience: 'openvibe.media',                     // the one audience the token is for
 *       scope: ['media.object.read'],                   // the capability ids to ask for
 *   });
 *   app.use('/auth', signIn.router(express));           // /login /callback /logout /me /health
 *
 * Routes (mounted wherever you like; the redirect URI must match):
 *   GET  /login     → the Network's /oauth/authorize with the audience, the capability ids, a state
 *                     and a PKCE challenge (S256). The state and the verifier stay on the server.
 *   GET  /callback  → the state must match (constant time), the code is exchanged once with the
 *                     secret and the verifier; the app token is verified offline against the
 *                     Network's JWKS and only trusted when it was minted for THIS app
 *                     (sub = app:<clientId>); then on_behalf_of names the person.
 *   GET  /logout    → the session is dropped (the token is revoked, best effort).
 *   GET  /me        → { user: null } or { user: { subject, capabilities, expires_at } }.
 *   GET  /health    → { ok, client: 'ok' | 'invalid' | 'unknown' }: does the Network accept this
 *                     app's credentials? (a code that is never issued; cached 10 minutes)
 *
 * When a sign-in cannot finish: a lost or expired flow (no pending state, or another state) and a
 * code the Network no longer accepts (invalid_grant: used twice, or bound to another verifier)
 * start the sign-in once more by themselves; a second failure shows the same plain page
 * openvibe-sdk/sso shows, with "Try again" and the way back. Neither ever sets a session.
 *
 * The session: pass `session: { get, set, clear }` to keep the state in your own store (the
 * recommended way in production), or leave it out and the SDK keeps it in memory and puts only an
 * opaque id in an httpOnly cookie. Either way the secret, the PKCE verifier and the app token
 * never reach the browser and never appear in a log.
 */
const crypto = require('node:crypto');
const { startAuthorization, readCallback, exchangeCode, verifyAppToken } = require('../auth');
const { failurePage, parseCookies, sanitizeNext } = require('../sso');

const PENDING_TTL_MS = 10 * 60 * 1000;
const HEALTH_CODE = 'ov_app_health_check_never_issued';
const DEFAULT_COOKIE = 'ov_app_sid';
const SESSION_KEY = 'appSignIn';

const trim = (u) => String(u || '').replace(/\/+$/, '');

/** The capability ids to ask for, as the Network takes them (a space-separated string). */
function normalizeScope(scope) {
    if (scope === undefined || scope === null) return undefined;
    const list = Array.isArray(scope) ? scope : String(scope).split(/[\s,]+/);
    const ids = list.map((x) => String(x || '').trim()).filter(Boolean);
    return ids.length ? ids : undefined;
}

function createAppSignIn(opts = {}) {
    const clientId = String(opts.clientId || '');
    const clientSecret = opts.clientSecret ? String(opts.clientSecret) : '';
    const networkUrl = trim(opts.networkUrl || 'https://openvibe.network');
    const redirectUri = String(opts.redirectUri || '');
    const audience = String(opts.audience || 'openvibe.network');
    const scope = normalizeScope(opts.scope !== undefined ? opts.scope : opts.scopes);
    const scopeText = scope ? scope.join(' ') : undefined;
    const appName = String(opts.appName || 'the app');
    const siteName = String(opts.siteName || appName);
    const fetchImpl = opts.fetch || globalThis.fetch;
    const log = opts.log || console;
    const jwks = opts.jwks || (opts.publicKey ? null : `${networkUrl}/api/.well-known/jwks`);
    const issuer = trim(opts.issuer || networkUrl);
    const acceptSandbox = opts.acceptSandbox !== false;
    const baseUrl = trim(opts.baseUrl || (() => { try { return new URL(redirectUri).origin; } catch { return ''; } })());
    const sessionApi = opts.session && typeof opts.session.get === 'function' ? opts.session : null;
    const cookieName = String((opts.cookie && opts.cookie.name) || opts.cookieName || DEFAULT_COOKIE);
    const secure = opts.secureCookies !== undefined ? !!opts.secureCookies : redirectUri.startsWith('https://');
    const cookieMaxAgeMs = (opts.cookie && opts.cookie.maxAge) || 60 * 60 * 1000;
    const sameSite = (opts.cookie && opts.cookie.sameSite) || 'lax';
    const store = new Map();   // the in-memory fallback: an opaque id -> the state (nothing readable in the browser)

    if (!clientId) throw new TypeError('createAppSignIn: clientId is required');
    if (!redirectUri) throw new TypeError('createAppSignIn: redirectUri is required');
    if (!sessionApi && !opts.clientSecret) throw new TypeError('createAppSignIn: a confidential app needs its clientSecret (or a session adapter for a public one)');

    const next = (value) => sanitizeNext(value, { baseUrl, networkUrl });
    const cookieOpts = () => ({ httpOnly: true, sameSite, secure, path: '/', maxAge: Math.floor(cookieMaxAgeMs / 1000) });

    // ── the session state: { pending: { state, verifier, at, next }, auth: { token, subject, ... }, retried } ──
    async function load(req) {
        if (sessionApi) {
            const s = await sessionApi.get(req);
            return (s && typeof s === 'object' && s[SESSION_KEY]) || null;
        }
        const sid = parseCookies(req)[cookieName];
        return (sid && store.get(sid)) || null;
    }
    async function save(req, res, state, { rotate = false } = {}) {
        if (sessionApi) {
            const s = (await sessionApi.get(req)) || {};
            s[SESSION_KEY] = state;
            await sessionApi.set(req, res, s);
            return;
        }
        const current = parseCookies(req)[cookieName];
        let sid = current && store.has(current) ? current : null;
        if (!sid || rotate) {
            if (sid) store.delete(sid);
            sid = crypto.randomBytes(32).toString('base64url');
            res.cookie(cookieName, sid, cookieOpts());
        }
        store.set(sid, state);
    }
    async function drop(req, res) {
        if (sessionApi) {
            if (typeof sessionApi.clear === 'function') await sessionApi.clear(req, res);
            else {
                const s = await sessionApi.get(req);
                if (s && typeof s === 'object') { delete s[SESSION_KEY]; await sessionApi.set(req, res, s); }
            }
            return;
        }
        const sid = parseCookies(req)[cookieName];
        if (sid) store.delete(sid);
        res.clearCookie(cookieName, { path: '/' });
    }

    const explain = (res, status, title, text, retryHref) => {
        if (typeof res.type === 'function') res.type('html');
        if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');
        return res.status(status).send(failurePage({ siteName, title, text, retryHref, backHref: '/' }));
    };
    const loginHref = (target) => `/login${target && target !== '/' ? `?next=${encodeURIComponent(target)}` : ''}`;
    const SIGN_IN_AGAIN = { title: 'Sign-in didn\'t finish', text: 'It took too long, or it started in another tab or app. Start it again and it will go through; your account is fine.' };
    /** A sign-in that can recover starts once more by itself; the second time it shows the page. Never sets a session. */
    async function retryOrExplain(req, res, target, state) {
        const st = state || {};
        if (!st.retried) {
            st.retried = true;
            st.pending = null;
            await save(req, res, st);
            return res.redirect(loginHref(target));
        }
        st.retried = false;
        st.pending = null;
        await save(req, res, st);
        return explain(res, 400, SIGN_IN_AGAIN.title, SIGN_IN_AGAIN.text, loginHref(target));
    }

    /** The verified claims of an app token: null when it is not one, or not ours. */
    async function verify(token) {
        if (!token) return null;
        try {
            const claims = await verifyAppToken(token, { jwks, publicKey: opts.publicKey, issuer, audience, acceptSandbox, fetch: fetchImpl });
            // The token must be minted for THIS app before on_behalf_of means anything.
            if (claims.sub !== `app:${clientId}`) return null;
            return claims;
        } catch (err) {
            if (err && err.code === 'token.no_key') log.warn(`[app-signin] Network keys unavailable: ${err.message}`);
            return null;
        }
    }

    const handlers = {
        /** Start a sign-in: the state and the PKCE verifier stay on the server. */
        async login(req, res) {
            const q = req.query || {};
            const target = next(q.next);
            const { url, state, codeVerifier } = await startAuthorization({
                network: networkUrl, clientId, redirectUri, audience, scope,
            });
            const current = await load(req);
            const state0 = current || {};
            state0.pending = { state, verifier: codeVerifier, at: Date.now(), next: target };
            state0.retried = false;
            await save(req, res, state0);
            return res.redirect(url);
        },

        /** Finish a sign-in: the state must match, the code is exchanged once, the token must be ours. */
        async callback(req, res) {
            const q = req.query || {};
            const current = await load(req);
            const pending = current && current.pending;
            const target = next(pending && pending.next);
            if (q.error) {
                // The person declined, or the Network refused: their decision, not a lost flow.
                const st = current || {};
                st.pending = null;
                await save(req, res, st);
                return explain(res, 400, 'Sign-in was not completed', `The Network answered ${String(q.error).slice(0, 64)}. Nothing was signed in; you can start again.`, loginHref(target));
            }
            if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return retryOrExplain(req, res, target, current);
            let code;
            try {
                const where = req.originalUrl || req.url || `/?${new URLSearchParams(q).toString()}`;
                ({ code } = readCallback(`http://app.invalid${where}`, { expectedState: pending.state }));
            } catch (err) {
                log.warn(`[app-signin] callback refused: ${err && err.code}`);
                if (err && err.code === 'oauth.missing_code') return explain(res, 400, 'Sign-in was not completed', 'The Network sent no authorization code. Nothing was signed in; you can start again.', loginHref(target));
                return retryOrExplain(req, res, target, current);
            }
            try {
                const tokens = await exchangeCode({
                    network: networkUrl, fetch: fetchImpl, clientId, clientSecret,
                    code, codeVerifier: pending.verifier, redirectUri, audience, scope,
                });
                const claims = await verify(tokens.access_token);
                if (!claims || !claims.on_behalf_of) {
                    const st = current || {};
                    st.pending = null;
                    await save(req, res, st);
                    return explain(res, 400, 'Sign-in failed', 'The token does not name a person for this app.', loginHref(target));
                }
                const auth = {
                    token: tokens.access_token,
                    subject: claims.on_behalf_of,
                    app: claims.sub,
                    projectId: claims.project_id || null,
                    env: claims.env || null,
                    capabilities: Array.isArray(claims.cap) ? claims.cap.slice() : (scope ? scope.slice() : []),
                    expiresAt: claims.exp ? claims.exp * 1000 : Date.now() + 5 * 60 * 1000,
                };
                await save(req, res, { pending: null, auth, retried: false }, { rotate: true });
                log.log(`[app-signin] signed in ${auth.subject}`);
                return res.redirect(target);
            } catch (err) {
                // A code the Network no longer accepts (used twice, too old, or bound to another
                // verifier) starts the sign-in once more; a Network that does not answer does not.
                const retryable = err && (err.code === 'oauth.invalid_grant' || err.status === 400 || err.status === 401);
                log.warn(`[app-signin] exchange failed: ${err && err.message}`);
                if (retryable) return retryOrExplain(req, res, target, current);
                return explain(res, 502, 'OpenVibe.Network didn\'t answer', 'Your account is fine: the sign-in service did not reply in time. Try again in a moment.', loginHref(target));
            }
        },

        /** Drop the session; the token is revoked, best effort (app tokens expire in 5 minutes anyway). */
        async logout(req, res) {
            const current = await load(req);
            const token = current && current.auth && current.auth.token;
            await drop(req, res);
            if (token) {
                try {
                    await fetchImpl(`${networkUrl}/oauth/revoke`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, token }),
                        signal: AbortSignal.timeout(3000),
                    });
                } catch { /* optional */ }
            }
            return res.redirect(next((req.query || {}).next));
        },

        /** Who signed in, and what this app may do for them. */
        async me(req, res) {
            const current = await load(req);
            const auth = current && current.auth;
            if (!auth || !auth.token || auth.expiresAt <= Date.now()) return res.json({ user: null });
            const claims = await verify(auth.token);
            if (!claims) return res.json({ user: null });
            return res.json({
                user: {
                    subject: claims.on_behalf_of || auth.subject,
                    app: claims.sub,
                    project_id: claims.project_id || null,
                    env: claims.env || null,
                    capabilities: Array.isArray(claims.cap) ? claims.cap : auth.capabilities,
                    expires_at: new Date(auth.expiresAt).toISOString(),
                },
            });
        },
    };

    let health = null;   // { client, at }: the last check
    /**
     * Does the Network accept this app's credentials? A token request with a code that is never
     * issued: invalid_grant means the id and secret are right, invalid_client that they are not.
     * Cached 10 minutes. → 'ok' | 'invalid' | 'unknown'
     */
    async function checkClient({ force = false } = {}) {
        if (!force && health && Date.now() - health.at < 10 * 60 * 1000) return health.client;
        try {
            const res = await fetchImpl(`${networkUrl}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code', code: HEALTH_CODE, code_verifier: HEALTH_CODE,
                    redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret || '',
                    audience, ...(scopeText ? { scope: scopeText } : {}),
                }).toString(),
                signal: AbortSignal.timeout(10_000),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) health = { client: 'ok', at: Date.now() };
            else if (data.error === 'invalid_client' || data.error === 'unauthorized_client' || res.status === 401) {
                health = { client: 'invalid', at: Date.now() };
                log.error(`[app-signin] the Network refuses this app\'s credentials (${data.error || res.status}): check its client id and secret against the Network's registration`);
            } else health = { client: 'ok', at: Date.now() };   // the grant was refused, but the client was not
        } catch {
            health = { client: 'unknown', at: Date.now() };
        }
        return health.client;
    }
    handlers.health = async (req, res) => {
        const client = await checkClient();
        if (typeof res.set === 'function') res.set('Cache-Control', 'no-store');
        return res.status(client === 'invalid' ? 503 : 200).json({ ok: client !== 'invalid', client });
    };

    /** The router. Pass your express module (the SDK does not depend on it). */
    function router(express) {
        if (!express || typeof express.Router !== 'function') throw new TypeError('appSignIn.router(express): pass the express module');
        const r = express.Router();
        const wrap = (fn) => (req, res, nextFn) => { Promise.resolve(fn(req, res)).catch(nextFn); };
        r.get('/login', wrap(handlers.login));
        r.get('/callback', wrap(handlers.callback));
        r.get('/logout', wrap(handlers.logout));
        r.get('/me', wrap(handlers.me));
        r.get('/health', wrap(handlers.health));
        return r;
    }

    return { router, handlers, verify, checkClient, redirectUri, audience, scope: scope || [], clientId };
}

module.exports = { createAppSignIn, normalizeScope };
