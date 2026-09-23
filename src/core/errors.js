'use strict';
/**
 * OpenVibeError: one error type for every failed call.
 *
 * Services answer with RFC 9457 problem details (contract errors.problem@1: type, title, status,
 * detail, code, request_id, trace_id). Older routes still answer { error: 'text' } and the OAuth
 * token endpoint answers { error, error_description }; all three become the same shape here, so
 * callers branch on `err.code` and `err.status` only.
 *
 * SDK-side failures use codes in the `sdk.` family: sdk.timeout, sdk.deadline_exceeded,
 * sdk.aborted, sdk.network_error, sdk.unknown_service, sdk.incompatible_contracts, sdk.bad_response.
 */

const CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

class OpenVibeError extends Error {
    constructor({ message, code, status = 0, title, detail, type, requestId, traceId, errors, problem, retryable = false, cause, method, url } = {}) {
        super(message || detail || title || code || 'OpenVibe request failed', cause ? { cause } : undefined);
        this.name = 'OpenVibeError';
        this.code = code || (status ? `http.${status}` : 'sdk.error');
        this.status = status;
        if (title) this.title = title;
        if (detail) this.detail = detail;
        if (type) this.type = type;
        this.requestId = requestId || null;
        this.traceId = traceId || null;
        if (errors) this.errors = errors;
        this.problem = problem || null;
        this.retryable = Boolean(retryable);
        if (method) this.method = method;
        if (url) this.url = url;
    }

    /** Build from an HTTP error response body (problem+json, legacy { error }, OAuth error, or text). */
    static fromResponse({ status, body, requestId, traceId, method, url, retryable = false }) {
        const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
        let code = null;
        if (obj && typeof obj.code === 'string' && obj.code) code = obj.code;
        else if (obj && typeof obj.error === 'string' && CODE_RE.test(obj.error) && obj.error.includes('_')) code = obj.error; // OAuth: invalid_client
        const detail = (obj && (obj.detail || obj.error_description || (typeof obj.error === 'string' ? obj.error : null)))
            || (typeof body === 'string' && body.trim() ? body.trim().slice(0, 500) : null);
        const title = obj && typeof obj.title === 'string' ? obj.title : null;
        return new OpenVibeError({
            message: `${method || 'GET'} ${stripQuery(url)} -> ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`,
            code: code || `http.${status}`,
            status,
            title,
            detail,
            type: obj && obj.type,
            requestId: (obj && obj.request_id) || requestId,
            traceId: (obj && obj.trace_id) || traceId,
            errors: obj && Array.isArray(obj.errors) ? obj.errors : undefined,
            problem: obj && typeof obj.code === 'string' && typeof obj.status === 'number' ? obj : null,
            retryable,
            method,
            url,
        });
    }

    toJSON() {
        return {
            name: this.name, code: this.code, status: this.status, title: this.title, detail: this.detail, type: this.type,
            request_id: this.requestId, trace_id: this.traceId, errors: this.errors, message: this.message,
        };
    }
}

function stripQuery(url) {
    return typeof url === 'string' ? url.split('?')[0] : '';
}

function isOpenVibeError(err) {
    return err instanceof OpenVibeError || Boolean(err && err.name === 'OpenVibeError' && typeof err.code === 'string');
}

module.exports = { OpenVibeError, isOpenVibeError };
