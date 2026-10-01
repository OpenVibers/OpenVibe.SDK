'use strict';
/**
 * The layer services wrote around the shared problem body (openvibe-contracts http.sendProblem, which this module
 * calls and never copies): the error class, asServiceError, run/wrap/sendError, jsonBody, privateNoStore and the
 * opt-in jsonErrors() terminal middleware. Defaults are Reviews/Wiki sendError's (server/http/common.js):
 *
 *   status    err.status when it is an HTTP error status (400–599), else 500
 *   logged    status >= 500, except 503 (a dependency said "not now": expected, not a bug)
 *   code      err.code, else 'internal.error' at 500 and 'request.invalid' otherwise
 *   detail    'Internal error' at 500 (never the raw message), else err.message
 *   extra     spread into the body (Blog/Trade, Reviews/Wiki); `extra: 'details'` nests it as { details } below 500
 *             (Tips/VIP)
 *
 * Every helper takes the same options bag (run's third argument may also be a logger, as in Reviews):
 *   { name = 'service', log = console, extra = 'spread', internalCode = 'internal.error',
 *     internalDetail = 'Internal error', publishing = false, map, noStore = false }
 * `map(err)` turns a service's own refusals into a ServiceError (Tips' inputError); `publishing` maps the
 * openvibe-publishing errors the way Blog/Trade asApiError does.
 */
const shared = require('./shared');

/** openvibe-contracts http.sendProblem, loaded on first use. */
const sendProblem = (res, status, code, opts) => shared.sendProblem(res, status, code, opts);

const BRAND = Symbol.for('openvibe.serviceError');

/** A refusal with a stable problem code: new (createServiceError('ApiError'))(404, 'post.not_found', detail?, extra?). */
function createServiceError(name = 'ServiceError') {
    const ServiceErrorClass = class extends Error {
        constructor(status, code, detail, extra) {
            super(detail || code);
            this.name = name;
            this.status = status;
            this.code = code;
            this.detail = detail;
            this.extra = extra || null;
        }
    };
    Object.defineProperty(ServiceErrorClass, 'name', { value: name });
    Object.defineProperty(ServiceErrorClass.prototype, BRAND, { value: true });
    return ServiceErrorClass;
}

const ServiceError = createServiceError('ServiceError');

function options(o) {
    if (o && typeof o.error === 'function') return { log: o };
    return o || {};
}

const httpStatus = (s) => Number.isInteger(s) && s >= 400 && s <= 599;

/**
 * The error as a refusal to answer with its own status and code, or null (an unexpected error: a 500).
 * Any error with an HTTP status and a string code is one (every service's own class, a ServiceError).
 */
function asServiceError(err, opts) {
    const o = options(opts);
    if (!err || typeof err !== 'object') return null;
    if (err[BRAND]) return err;
    if (typeof o.map === 'function') {
        const mapped = o.map(err);
        if (mapped) return mapped;
    }
    if (o.publishing) {
        const Make = o.ServiceError || ServiceError;
        if (err.name === 'PublishingError' && Number.isInteger(err.status)) {
            const extra = err.code === 'revision.conflict' ? { expected: err.expected, current: err.current } : null;
            return new Make(err.status, err.code, err.message, extra);
        }
        if (err instanceof TypeError && err.message && !/Cannot read|is not a function|undefined/.test(err.message)) {
            return new Make(422, 'request.invalid', err.message);
        }
    }
    if (httpStatus(err.status) && typeof err.code === 'string' && err.code) return err;
    return null;
}

/** Any error → problem+json on res (nothing when the headers are already out). Returns the body sent, or null. */
function sendError(res, req, err, log, opts) {
    const o = { ...options(log), ...options(opts) };
    const logger = o.log || console;
    const known = asServiceError(err, o);
    const e = known || err;
    const status = known && httpStatus(known.status) ? known.status : (e && httpStatus(e.status) ? e.status : 500);
    if (status >= 500 && status !== 503) logger.error(`[${o.name || 'service'}]`, err && err.stack ? err.stack : err);
    if (res.headersSent) return null;
    const internal = status === 500;
    const code = (e && typeof e.code === 'string' && e.code && (known || !internal) ? e.code : null)
        || (internal ? o.internalCode || 'internal.error' : 'request.invalid');
    const detail = internal ? (o.internalDetail || 'Internal error') : (e && (e.detail || e.message)) || undefined;
    const raw = known && known.extra ? known.extra : null;
    let extra;
    if (raw && o.extra === 'details') extra = status < 500 ? { details: raw } : undefined;
    else if (raw) extra = raw;
    return sendProblem(res, status, code, { detail, ctx: req && req.ov, extra });
}

function sendJson(res, status, body) {
    if (typeof res.status === 'function' && typeof res.json === 'function') return res.status(status).json(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
}

/**
 * A JSON handler: its return value is the body (status a number or (out) => number); undefined means the handler
 * answered itself. Errors become problems through sendError.
 */
function run(fn, status = 200, opts) {
    const o = options(opts);
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out === undefined || res.headersSent) return;
            if (o.noStore) privateNoStore(res);
            sendJson(res, typeof status === 'function' ? status(out) : status, out);
        } catch (err) {
            sendError(res, req, err, o);
        }
    };
}

/** A handler that answers itself (Tips/VIP wrap): a throw or a rejection becomes a problem through sendError. */
function wrap(fn, opts) {
    const o = options(opts);
    return async (req, res, next) => {
        try { await fn(req, res, next); } catch (err) { sendError(res, req, err, o); }
    };
}

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
function bytes(v) {
    if (typeof v === 'number') return v;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(String(v));
    if (!m) throw new TypeError(`jsonBody: limit ${JSON.stringify(v)} is not a size ('512kb', '1mb' or a number of bytes)`);
    return Math.floor(Number(m[1]) * UNITS[(m[2] || 'b').toLowerCase()]);
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/**
 * A JSON body parser whose failures are problems: a malformed body → 400 'request.invalid_json' ('Malformed JSON
 * body'), a body over `limit` → 413 'request.too_large', an encoding it cannot read → 415. Like express.json():
 * only application/json (and +json) bodies, objects and arrays only, an empty body is {}, a body parsed already is
 * left alone. `parser: express.json({ limit })` uses that parser instead and maps its errors the same way.
 */
function jsonBody(opts = {}) {
    const o = options(opts);
    const max = bytes(o.limit == null ? '512kb' : o.limit);
    const fail = (req, res, err) => {
        if (err && (err.type === 'entity.too.large' || err.status === 413)) return sendProblem(res, 413, 'request.too_large', { detail: `The body is larger than ${max} bytes`, ctx: req.ov });
        if (err && err.status === 415) return sendProblem(res, 415, 'request.unsupported_encoding', { detail: err.message, ctx: req.ov });
        return sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov });
    };
    if (typeof o.parser === 'function') {
        return function jsonBodyParser(req, res, next) { o.parser(req, res, (err) => (err ? fail(req, res, err) : next())); };
    }
    return function jsonBodyParser(req, res, next) {
        if (req._body) return next();
        if (req.body === undefined) req.body = {};
        const te = req.headers['transfer-encoding'];
        const len = req.headers['content-length'];
        if (te === undefined && (len === undefined || Number.isNaN(Number(len)))) return next();
        if (!JSON_TYPE.test(String(req.headers['content-type'] || ''))) return next();
        if (len !== undefined && Number(len) > max) return fail(req, res, { type: 'entity.too.large' });
        const enc = String(req.headers['content-encoding'] || 'identity').toLowerCase();
        const zlib = require('node:zlib');
        const decoders = { identity: null, gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
        if (!(enc in decoders)) return fail(req, res, { status: 415, message: `Content-Encoding ${enc} is not supported` });
        const stream = decoders[enc] ? req.pipe(decoders[enc]()) : req;
        const chunks = [];
        let size = 0;
        let done = false;
        const end = (err) => {
            if (done) return;
            done = true;
            if (err) return fail(req, res, err);
            const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
            if (!text.trim()) { req.body = {}; req._body = true; return next(); }
            const first = text.trimStart()[0];
            if (first !== '{' && first !== '[') return fail(req, res, { type: 'entity.parse.failed' });
            try { req.body = JSON.parse(text); } catch { return fail(req, res, { type: 'entity.parse.failed' }); }
            req._body = true;
            return next();
        };
        stream.on('data', (c) => {
            if (done) return;
            size += c.length;
            if (size > max) { end({ type: 'entity.too.large' }); return; }
            chunks.push(c);
        });
        stream.on('end', () => end());
        stream.on('error', () => end({ type: 'entity.parse.failed' }));
        req.on('aborted', () => { done = true; });
        return undefined;
    };
}

function vary(res, field) {
    if (typeof res.vary === 'function') return res.vary(field);
    const have = String(res.getHeader('Vary') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (have.includes('*') || have.some((h) => h.toLowerCase() === field.toLowerCase())) return res;
    res.setHeader('Vary', [...have, field].join(', '));
    return res;
}

/** Private, per-viewer responses: never stored by a shared cache (Cache-Control: private, no-store; Vary: Cookie, Authorization). */
function privateNoStore(res) {
    res.setHeader('Cache-Control', 'private, no-store');
    vary(res, 'Cookie');
    vary(res, 'Authorization');
    return res;
}

/**
 * Opt-in terminal middleware (Bot's server/app.js), mounted last: app.use(jsonErrors()). Under `apiPrefix` (a string or
 * a list; default ['/api/', '/internal/']) a miss is 404 'not_found' and an error a problem: a malformed body 400
 * 'request.invalid_json', too large 413 'request.too_large', a ServiceError (or `map`) its own, anything else
 * through sendError. Elsewhere (pages) the answers are text/plain `notFoundText` / `errorText`. `notFound: false`
 * leaves the 404 out. Returns [notFound, errorHandler], which app.use() takes as is.
 */
function jsonErrors(opts = {}) {
    const o = options(opts);
    const prefixes = [].concat(o.apiPrefix == null ? ['/api/', '/internal/'] : o.apiPrefix);
    const isApi = (req) => prefixes.some((p) => String(req.path || req.url || '').startsWith(p));
    const notFoundText = o.notFoundText || 'Not found\n';
    const errorText = o.errorText || 'Something went wrong\n';
    const text = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(body); };

    function notFound(req, res) {
        if (isApi(req)) return sendProblem(res, 404, 'not_found', { ctx: req.ov });
        return text(res, 404, notFoundText);
    }
    // eslint-disable-next-line no-unused-vars
    function errorHandler(err, req, res, next) {
        const api = isApi(req);
        if (api && !res.headersSent && err && err.type === 'entity.parse.failed') return sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov });
        if (api && !res.headersSent && err && err.type === 'entity.too.large') return sendProblem(res, 413, 'request.too_large', { ctx: req.ov });
        if (api) return sendError(res, req, err, o);
        (o.log || console).error(`[${o.name || 'service'}]`, err && err.stack ? err.stack : err);
        if (res.headersSent) return undefined;
        return text(res, 500, errorText);
    }
    const out = o.notFound === false ? [errorHandler] : [notFound, errorHandler];
    out.notFound = notFound;
    out.errorHandler = errorHandler;
    return out;
}

module.exports = { ServiceError, createServiceError, asServiceError, sendError, run, wrap, jsonBody, privateNoStore, jsonErrors };
