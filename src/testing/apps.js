'use strict';
/**
 * OpenVibe.Events' developer-app rules for the mock platform (Node only), as Events implements
 * them (server/apps.js, server/api/*, server/egress.js; capabilities events.app.publish | read |
 * subscribe in openvibe-contracts v0.28.0):
 *
 *   - an app token (sub app:app_<ULID>) is judged on the events.app.* capability of the route only;
 *     sandbox app tokens are accepted on these routes (and nowhere else)
 *   - publish: event_type app.<project_key>.<name…>, source app-<lowercased app ULID>, actor the
 *     app or the user the token acts for; stored with the token's project_id and env
 *   - reads (pull, get, checkpoints): the app's project in the token's env + public first-party
 *     events; every pattern starts with a literal segment, app.* patterns name the own project_key
 *   - subscriptions: the same scope, https endpoints that are not loopback/private/local names
 *   - first-party readers and subscribers never see sandbox events, and see app events only
 *     through a pattern that starts with `app.`; realtime streams neither
 */
const net = require('node:net');
const { projectKey, appSource } = require('../events');

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const APP_SUB_RE = new RegExp(`^app:app_(${ULID})$`);
const ENVS = ['sandbox', 'production'];

/** Events' topic pattern syntax: dot-separated [a-z0-9_]+ or `*` (one or more segments), no `*.*`. */
const PATTERN_RE = /^(\*|[a-z0-9_]+)(\.(\*|[a-z0-9_]+))*$/;
const isValidPattern = (p) => typeof p === 'string' && p.length > 0 && p.length <= 200 && PATTERN_RE.test(p) && !p.includes('*.*');

/** The app principal for verified claims, or { error }. */
function appPrincipal(claims) {
    const m = APP_SUB_RE.exec(String(claims && claims.sub));
    if (!m) return { error: 'not an app token' };
    if (claims.actor_type && claims.actor_type !== 'app') return { error: 'actor_type must be app' };
    const key = projectKey(claims.project_id);
    if (!key) return { error: 'app token without a project_id' };
    const env = claims.env === undefined ? 'production' : claims.env;
    if (!ENVS.includes(env)) return { error: `unknown env ${claims.env}` };
    if (Array.isArray(claims.ns) && claims.ns.length && !claims.ns.includes(claims.project_id)) return { error: 'project_id is not in the token namespaces' };
    return {
        kind: 'app', sub: claims.sub, appId: `app_${m[1]}`, projectId: claims.project_id, projectKey: key,
        source: appSource(`app_${m[1]}`), prefix: `app.${key}.`, env,
        onBehalfOf: typeof claims.on_behalf_of === 'string' ? claims.on_behalf_of : null,
    };
}

/** null when an app may use this pattern, else the reason. */
function patternScopeError(pattern, app) {
    if (!isValidPattern(pattern)) return 'topic patterns are dot-separated segments of [a-z0-9_] or *';
    const [first, second] = pattern.split('.');
    if (first === '*') return 'an app topic pattern must start with a literal segment (e.g. app.<project_key>.* or live.*)';
    if (first === 'app' && second !== app.projectKey) return `app.* patterns must name your project: app.${app.projectKey}.*`;
    return null;
}

/** `stored` is the mock's { seq, event, project_id, env }. */
function visibleToApp(stored, scope) {
    if (stored.project_id) return stored.project_id === scope.projectId && (stored.env || 'production') === scope.env;
    return stored.event.visibility === 'public' && (stored.env || 'production') === 'production';
}

function serviceSees(pattern, stored) {
    if ((stored.env || 'production') !== 'production') return false;
    return !(stored.project_id && !pattern.startsWith('app.'));
}

// ── Endpoints (the syntax half of Events' SSRF guard; the mock does no DNS) ──

// Events' non-public ranges. Where Events looks inside IPv4-mapped, NAT64 and 6to4 addresses, the
// mock refuses those ranges outright (stricter, never looser).
const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['::', 96], ['::ffff:0:0', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
    ['2002::', 16], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, p, 'ipv6');

function isPublicLiteral(host) {
    const family = net.isIP(host);
    return Boolean(family) && !BLOCKED.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

/** { ok, url } or { ok: false, reason } for an app subscription endpoint. */
function checkAppEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return { ok: false, reason: 'endpoint must be a URL of at most 2048 characters' };
    let url;
    try { url = new URL(endpoint); } catch { return { ok: false, reason: 'not a URL' }; }
    if (url.protocol !== 'https:') return { ok: false, reason: 'app endpoints must use https' };
    if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };
    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host.endsWith('.')) return { ok: false, reason: 'trailing-dot hostnames are not allowed' };
    if (net.isIP(host)) return isPublicLiteral(host) ? { ok: true, url } : { ok: false, reason: `${host} is not a public address` };
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        return { ok: false, reason: `${host} is not a public hostname` };
    }
    return { ok: true, url };
}

/** Events' retry_policy check: { ok, value } or { ok: false, reason }. */
function checkRetryPolicy(p) {
    if (p == null) return { ok: true, value: null };
    if (typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'retry_policy must be an object' };
    for (const k of Object.keys(p)) if (!['max_attempts', 'backoff_ms'].includes(k)) return { ok: false, reason: `unknown retry_policy field ${k}` };
    if (p.max_attempts !== undefined && (!Number.isInteger(p.max_attempts) || p.max_attempts < 1 || p.max_attempts > 20)) return { ok: false, reason: 'max_attempts must be 1..20' };
    if (p.backoff_ms !== undefined && (!Array.isArray(p.backoff_ms) || !p.backoff_ms.length || p.backoff_ms.length > 20
        || !p.backoff_ms.every((n) => Number.isInteger(n) && n >= 0 && n <= 86400000))) return { ok: false, reason: 'backoff_ms must be 1..20 integers between 0 and 86400000' };
    return { ok: true, value: Object.keys(p).length ? p : null };
}

module.exports = { appPrincipal, patternScopeError, visibleToApp, serviceSees, isValidPattern, checkAppEndpoint, checkRetryPolicy, APP_SUB_RE };
