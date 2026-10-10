'use strict';
/**
 * openvibe-sdk/resources — the resource index and the control plane (ADR-048, plan T13 step 2).
 *
 * Every service that owns resources answers GET /api/v1/resources with common.resource-list-result@1
 * pages of common.resource-summary@1 (ADR-048: the index owns that path). A console or operator reads
 * one authority directly, or fans out over several with createResourceIndex, and changes one resource by
 * sending a common.resource-control-request@1 to its authority's control API with createResourceClient.
 * The SDK never writes another service's rows: create, update, delete, start, stop, suspend, resume,
 * resize, rotate, pair, grant, revoke and archive are all control calls the owning authority decides
 * (it checks the caller's capability, applies, and answers common.resource-control-result@1).
 *
 * The authorities are the services that own resources (ADR-048: Actor, Codes, Events, Media, Run,
 * Watch and Zone); OpenVibe.Network's T2 offer registry currently answers the same public
 * /api/v1/resources path and moves to /api/v1/offers in Network's release.
 *
 * OVRN is the one cross-service resource name, ovrn:<service>:<project_id>:<type>/<id>
 * (common.resource-name@1). parseResourceName/resourceName/resourceNameOf reuse openvibe-contracts'
 * contracts.resources helpers (required lazily, only by these three) so this package, like every
 * service, has one parser and one formatter and never splits the name on ':'.
 *
 *   const index = createResourceIndex({ authorities: ['https://media.openvibe.network', …], token });
 *   const { resources, stale } = await index.list({ project: prj.id, kind: 'media.object' });
 *   const media = createResourceClient({ origin: 'https://media.openvibe.network', token });
 *   const result = await media.control({ action: 'delete', project_id: prj.id,
 *       resource: 'ovrn:media:prj_…:object/med_…', idempotency_key: '…' });
 *   result.state;                                    // done | pending | refused | failed
 *
 * Server-only (browser: null): the control plane carries a user or service token and is never shipped
 * to a page.
 */
const { OpenVibeError } = require('./core/errors');
const { newIdempotencyKey } = require('./core/ids');

const trimSlash = (s) => String(s).replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A GET/POST timeout signal, or undefined when none is wanted. */
const timeoutSignal = (ms) => (ms > 0 ? AbortSignal.timeout(ms) : undefined);

/** A retryable HTTP status: pressure or a server-side fault, never the request itself. */
const isRetryableStatus = (status) => status === 408 || status === 425 || status === 429 || status >= 500;

/** The bearer header for a token that is a string, a getter or a token client; no header when there is none. */
function tokenGetter(token) {
    if (typeof token === 'function') return token;
    if (token && typeof token.getToken === 'function') return () => token.getToken();
    if (typeof token === 'string' && token) return () => token;
    return () => null;
}
async function authHeaders(token) {
    const value = await tokenGetter(token)();
    return value ? { Authorization: `Bearer ${value}` } : {};
}

/** A fetch rejection as an OpenVibeError: sdk.timeout when the deadline aborted it, else sdk.network_error. */
function networkError(cause, method, url) {
    const aborted = Boolean(cause) && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
    return new OpenVibeError({
        code: aborted ? 'sdk.timeout' : 'sdk.network_error',
        message: `${method} ${url} failed: ${(cause && cause.message) || 'no response'}`,
        cause, method, url,
    });
}

// ── OVRN: the one resource name (common.resource-name@1) ─────────────────────────────────────────

/** openvibe-contracts' contracts.resources (lib/resources.js), required lazily, only by the name helpers. */
function contractResources() {
    try { return require('openvibe-contracts').resources; }
    catch {
        throw new Error('openvibe-sdk/resources: openvibe-contracts is required for the resource-name helpers (contracts.resources.parse/format/nameOf)');
    }
}

/** ovrn:<service>:<project_id>:<type>/<id> -> its four segments, or null when it is not a resource name. */
function parseResourceName(name) { return contractResources().parse(name); }

/** The four segments -> an OVRN; throws when they do not make a valid one (id prefix, project, type). */
function resourceName(parts) { return contractResources().format(parts); }

/** The OVRN of a common.resource-summary@1 (its kind's second half is the type), or null when it has none. */
function resourceNameOf(summary) { return contractResources().nameOf(summary); }

/**
 * The resource-kind catalog of ADR-048, with each kind's three-letter id prefix. Only the kinds whose
 * prefix is chosen in the pinned openvibe-contracts (ids.PREFIX: media -> med, watch -> wch) are here.
 * The ADR's other kinds are deliberately absent until the step-8 sweep settles them: codes.repo,
 * events.queue and events.subscription have no prefix at all, and actor.actor (act), run.sandbox (run;
 * it collides with the existing run_ AI run ids) and zone.object-zone (zon) are only proposed. No
 * contract schema carries this catalog — it is prose in ADR-048 — so this is not read from contracts.
 */
const RESOURCE_KINDS = Object.freeze([
    Object.freeze({ kind: 'media.object', service: 'media', type: 'object', prefix: 'med' }),
    Object.freeze({ kind: 'watch.watch', service: 'watch', type: 'watch', prefix: 'wch' }),
]);

// ── the resource index: fan out over authorities and merge their pages ───────────────────────────

const INDEX_PATH = '/api/v1/resources';
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10000;
/** The most pages one authority's cursor chain is followed for before it is reported stale. */
const DEFAULT_MAX_PAGES = 1000;

/** An authority's failure, reported instead of thrown so one authority cannot fail the whole index. */
function staleOf(authority, err) {
    return {
        authority,
        status: (err && err.status) || 0,
        code: (err && err.code) || 'sdk.error',
        error: (err && err.message) || String(err),
    };
}

/** A structurally valid common.resource-list-result@1 page. */
function isListResult(body) {
    return Boolean(body) && typeof body === 'object' && Array.isArray(body.resources)
        && (body.next_cursor === null || typeof body.next_cursor === 'string');
}

/** Run fn over items with at most `limit` in flight; results keep the items' order. */
async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    const size = Math.max(1, Math.min(limit, items.length));
    let next = 0;
    const workers = [];
    for (let w = 0; w < size; w++) {
        workers.push((async () => {
            for (;;) {
                const i = next++;
                if (i >= items.length) return;
                results[i] = await fn(items[i], i);
            }
        })());
    }
    await Promise.all(workers);
    return results;
}

/**
 * The read side of the control plane: one index for several authorities. `list()` fans out
 * GET {authority}/api/v1/resources?project=&kind=&owner=&cursor=&limit= with at most `concurrency` requests in
 * flight (`owner` is a subject id, usr_… or agt_…: an authority answers only the resources that subject owns, so a
 * person's own resources, which belong to no project, can be listed without reading everyone's), follows each authority's opaque next_cursor to the end, and merges the pages in authority
 * order. An authority that fails (network, timeout, non-2xx, malformed page) never fails the call: its
 * pages read so far are kept and it is reported in `stale` (`{ authority, status, code, error }`), so a
 * caller can rebuild its read model and try that authority again.
 *
 * A cursor chain that never ends is bounded three ways, so one bad authority cannot hang `list()`:
 * a repeated cursor (a cycle, or the same cursor echoed back) and an empty-string `next_cursor` end the
 * walk, `maxPages` caps the pages read (`sdk.bad_response`), and an optional `maxMs` per-authority
 * deadline reports a walk that outran its budget (`sdk.timeout`). Each bound keeps the pages read so
 * far and reports the authority stale rather than failing the whole index.
 *
 * @param {object} o
 * @param {string[]} o.authorities  base URLs of the services whose index to read
 * @param {string|Function|{getToken(): Promise<string>}} [o.token]  a bearer token, a getter, or a token client
 * @param {Function} [o.fetch]      fetch for the requests (default globalThis.fetch)
 * @param {number} [o.pageLimit]    the per-request `limit` (default 100)
 * @param {number} [o.concurrency]  the most requests in flight at once (default 4)
 * @param {number} [o.timeoutMs]    the per-request timeout (default 10000)
 * @param {number} [o.maxPages]     the most pages per authority before it is reported stale (default 1000)
 * @param {number} [o.maxMs]        an optional per-authority deadline; a walk past it is reported stale
 * @returns {{ authorities: string[], list(opts?): Promise<{resources, stale}>, iterate(opts?): AsyncGenerator }}
 */
function createResourceIndex({
    authorities, token, fetch: fetchImpl = globalThis.fetch,
    pageLimit = DEFAULT_PAGE_LIMIT, concurrency = DEFAULT_CONCURRENCY, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxPages = DEFAULT_MAX_PAGES, maxMs = null,
} = {}) {
    if (!Array.isArray(authorities) || authorities.length === 0) throw new TypeError('createResourceIndex: authorities must be a non-empty array of base URLs');
    if (typeof fetchImpl !== 'function') throw new TypeError('createResourceIndex: a fetch implementation is required');
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('createResourceIndex: concurrency must be a positive integer');
    if (pageLimit != null && (!Number.isInteger(pageLimit) || pageLimit < 1)) throw new TypeError('createResourceIndex: pageLimit must be a positive integer');
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError('createResourceIndex: maxPages must be a positive integer');
    if (maxMs != null && (!Number.isFinite(maxMs) || maxMs <= 0)) throw new TypeError('createResourceIndex: maxMs must be a positive number of milliseconds');
    const bases = authorities.map((a) => trimSlash(a));

    /** One page of an authority's index; a non-2xx or a non-page body throws an OpenVibeError. */
    async function page(authority, { project, kind, owner, cursor, limit }) {
        const query = new URLSearchParams();
        if (project != null) query.set('project', project);
        if (kind != null) query.set('kind', kind);
        if (owner != null) query.set('owner', owner);
        if (cursor != null && cursor !== '') query.set('cursor', cursor);
        if (limit != null) query.set('limit', String(limit));
        const url = `${authority}${INDEX_PATH}${query.toString() ? `?${query}` : ''}`;
        let res;
        try {
            res = await fetchImpl(url, { headers: { Accept: 'application/json', ...(await authHeaders(token)) }, signal: timeoutSignal(timeoutMs) });
        } catch (err) {
            throw networkError(err, 'GET', url);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw OpenVibeError.fromResponse({ status: res.status, body, method: 'GET', url, retryable: isRetryableStatus(res.status) });
        if (!isListResult(body)) throw new OpenVibeError({ code: 'sdk.bad_response', message: `GET ${url} is not a common.resource-list-result@1 page`, method: 'GET', url });
        return body;
    }

    /** Walk one authority's cursor chain, keeping its pages and reporting a failure as stale. */
    async function walk(authority, filter) {
        const resources = [];
        const seen = new Set();
        const startedAt = Date.now();
        const where = `${authority}${INDEX_PATH}`;
        let cursor;
        try {
            for (let pages = 0; ; pages++) {
                if (pages >= maxPages) {
                    throw new OpenVibeError({ code: 'sdk.bad_response', message: `GET ${where} did not end after ${maxPages} pages`, method: 'GET', url: where });
                }
                if (maxMs != null && Date.now() - startedAt > maxMs) {
                    throw new OpenVibeError({ code: 'sdk.timeout', message: `GET ${where} exceeded maxMs (${maxMs} ms)`, method: 'GET', url: where });
                }
                const body = await page(authority, { ...filter, cursor });
                resources.push(...body.resources);
                const next = body.next_cursor;
                if (next == null || next === '') break;                     // null or empty: the end
                if (next === cursor || seen.has(next)) {
                    throw new OpenVibeError({ code: 'sdk.bad_response', message: `GET ${where} cursor repeated (${next})`, method: 'GET', url: where });
                }
                seen.add(next);
                cursor = next;
            }
            return { resources, stale: null };
        } catch (err) {
            return { resources, stale: staleOf(authority, err) };
        }
    }

    /**
     * Every resource of every authority, merged in authority order. `{ resources, stale }`; `stale`
     * lists the authorities this call could not read to the end.
     */
    async function list({ project, kind, owner, limit = pageLimit } = {}) {
        const filter = { project, kind, owner, limit };
        const perAuthority = await mapPool(bases, concurrency, (authority) => walk(authority, filter));
        const resources = [];
        const stale = [];
        for (const r of perAuthority) {
            resources.push(...r.resources);
            if (r.stale) stale.push(r.stale);
        }
        return { resources, stale };
    }

    /** The same resources as list(), one at a time. A stale authority contributes what it answered. */
    async function* iterate(opts) {
        const { resources } = await list(opts);
        yield* resources;
    }

    return { authorities: bases, list, iterate };
}

// ── the control side: one control call to the authority that owns a resource ─────────────────────

const CONTROL_PATH = '/api/v1/resources/control';
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

/** A refused/failed common.resource-control-result@1: a body the authority answered with, not an error. */
function isRefusedOrFailedResult(body) {
    return Boolean(body) && typeof body === 'object'
        && (body.state === 'refused' || body.state === 'failed')
        && (body.problem != null || body.confirmation_required != null);
}

/** The minimal request shape check, used only when openvibe-contracts is not installed. */
function shapeCheckControlRequest(request) {
    const errors = [];
    if (typeof request.action !== 'string' || !request.action) errors.push({ path: '/action', message: 'required' });
    if (typeof request.project_id !== 'string' || !request.project_id) errors.push({ path: '/project_id', message: 'required' });
    if (typeof request.idempotency_key !== 'string' || request.idempotency_key.length < 8) errors.push({ path: '/idempotency_key', message: 'required, 8-200 characters' });
    const names = (request.resource === undefined ? 0 : 1) + (request.resource_kind === undefined ? 0 : 1);
    if (names !== 1) errors.push({ path: '/resource', message: 'exactly one of resource or resource_kind' });
    return { valid: errors.length === 0, errors };
}

/**
 * A common.resource-control-request@1, checked with contracts.resources.checkControlRequest when
 * openvibe-contracts is installed. Only a missing module falls back to the local shape check (create
 * names resource_kind; every other action names resource): any real error the contracts helper throws
 * propagates, so the OVRN parse and the project-tenancy rule are never silently skipped.
 */
function checkControlRequest(request) {
    let contracts;
    try {
        contracts = require('openvibe-contracts');
    } catch (err) {
        if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
        return shapeCheckControlRequest(request);
    }
    return contracts.resources.checkControlRequest(request);
}

/**
 * The write side of the control plane: POST a common.resource-control-request@1 to
 * {origin}/api/v1/resources/control and return the authority's common.resource-control-result@1.
 *
 * A request carries an idempotency_key (one is generated when the caller omits it, `idem_…`); the
 * authority stores the first answer per (caller, project, key), so a transient failure (network,
 * timeout, 408/425/429/5xx) is retried with the SAME key and the same body, up to `retries` times, and
 * an action is never applied twice. `state` is the outcome, not the resource's state: `done`, `pending`,
 * `refused` (carrying a `problem` or `confirmation_required`) or `failed` — all four are returned when
 * the authority sends them with a 2xx, and a refused/failed result with a non-retryable non-2xx (403,
 * 409, 422 …) is returned too, so the caller reads `confirmation_required.confirmation_id` and repeats
 * the request with it once the owner approves. Any other non-2xx answer is an OpenVibeError
 * (problem+json -> code/status); a thrown error carries the request's `idempotencyKey`, so a caller that
 * retries a sensitive action after a timeout or a 5xx reuses the key the authority already saw instead
 * of generating a fresh one that could duplicate the action.
 *
 * @param {object} o
 * @param {string} o.origin          the authority's base URL
 * @param {string|Function|{getToken(): Promise<string>}} [o.token]  a bearer token, a getter, or a token client
 * @param {Function} [o.fetch]       fetch for the POST (default globalThis.fetch)
 * @param {number} [o.timeoutMs]     the per-attempt timeout (default 10000)
 * @param {number} [o.retries]       retries after the first attempt for a transient failure (default 2)
 * @param {number} [o.retryDelayMs]  the base backoff between attempts (default 250; grows linearly)
 * @returns {{ path: string, control(request, opts?): Promise<object> }}
 */
function createResourceClient({
    origin, token, fetch: fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('createResourceClient: a fetch implementation is required');
    const base = trimSlash(origin || '');
    if (!base) throw new TypeError('createResourceClient: origin is required');
    if (!Number.isInteger(retries) || retries < 0) throw new TypeError('createResourceClient: retries must be a non-negative integer');

    async function control(request, { retries: attempts = retries } = {}) {
        if (!request || typeof request !== 'object') throw new TypeError('resourceClient.control: a common.resource-control-request@1 is required');
        const body = { ...request };
        if (body.idempotency_key == null) body.idempotency_key = newIdempotencyKey();
        const check = checkControlRequest(body);
        if (!check.valid) throw new Error(`not a valid common.resource-control-request@1: ${JSON.stringify(check.errors)}`);
        const url = `${base}${CONTROL_PATH}`;
        for (let attempt = 0; ; attempt++) {
            let res;
            try {
                res = await fetchImpl(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders(token)) },
                    body: JSON.stringify(body),
                    signal: timeoutSignal(timeoutMs),
                });
            } catch (err) {
                const netErr = networkError(err, 'POST', url);
                netErr.idempotencyKey = body.idempotency_key;
                if (attempt < attempts) { await sleep(retryDelayMs * (attempt + 1)); continue; }
                throw netErr;
            }
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                const retryable = isRetryableStatus(res.status);
                // ADR-048 does not fix the status for refused/failed: a non-retryable non-2xx may carry
                // the answer, so return it instead of throwing it away. A retryable status retries first.
                if (!retryable && isRefusedOrFailedResult(data)) return data;
                const err = OpenVibeError.fromResponse({ status: res.status, body: data, method: 'POST', url, retryable });
                err.idempotencyKey = body.idempotency_key;
                if (attempt < attempts && retryable) { await sleep(retryDelayMs * (attempt + 1)); continue; }
                throw err;
            }
            if (!data || typeof data !== 'object' || typeof data.state !== 'string') {
                const err = new OpenVibeError({ code: 'sdk.bad_response', message: `POST ${url} is not a common.resource-control-result@1`, method: 'POST', url });
                err.idempotencyKey = body.idempotency_key;
                throw err;
            }
            return data;
        }
    }

    return { path: CONTROL_PATH, control };
}

module.exports = {
    parseResourceName,
    resourceName,
    resourceNameOf,
    RESOURCE_KINDS,
    createResourceIndex,
    createResourceClient,
};
