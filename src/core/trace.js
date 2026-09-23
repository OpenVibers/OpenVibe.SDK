'use strict';
/**
 * W3C Trace Context (traceparent) propagation, browser-safe.
 * Every SDK call is one span: it continues the caller's trace when one is given (same trace id,
 * new span id) and starts a new trace otherwise.
 */
const { randomHex } = require('./ids');

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parse a traceparent header; null when absent or malformed (all-zero ids are invalid). */
function parseTraceparent(value) {
    const m = typeof value === 'string' && value.trim().toLowerCase().match(TRACEPARENT_RE);
    if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
    return { traceId: m[1], parentId: m[2], flags: m[3] };
}

/** A child span of `parent` (a traceparent string), or the root of a new trace. */
function startSpan(parent) {
    const p = parseTraceparent(parent);
    const traceId = p ? p.traceId : randomHex(16);
    const spanId = randomHex(8);
    const flags = p ? p.flags : '01';
    return { traceId, spanId, parentId: p ? p.parentId : null, traceparent: `00-${traceId}-${spanId}-${flags}` };
}

/**
 * Context to continue from an incoming request's headers (Node IncomingMessage headers, a Fetch
 * Headers object, or a plain object): { traceparent, requestId }.
 */
function contextFromHeaders(headers) {
    const get = (k) => {
        if (!headers) return undefined;
        if (typeof headers.get === 'function') return headers.get(k) ?? undefined;
        return headers[k] ?? headers[k.toLowerCase()];
    };
    const tp = get('traceparent');
    const rid = get('x-openvibe-request-id');
    return {
        traceparent: parseTraceparent(tp) ? String(tp).trim().toLowerCase() : undefined,
        requestId: typeof rid === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(rid) ? rid : undefined,
    };
}

module.exports = { parseTraceparent, startSpan, contextFromHeaders };
