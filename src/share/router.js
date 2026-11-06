'use strict';
const v = require('./validation');
function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie', ...headers });
    res.end(JSON.stringify(body));
}
async function body(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) v.fail(415, 'share.json_required', 'JSON required');
    if (req.body !== undefined) {
        if (Buffer.byteLength(JSON.stringify(req.body)) > 65536) v.fail(413, 'share.too_large', 'Request too large');
        return req.body;
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) v.fail(413, 'share.too_large', 'Request too large');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { v.invalid(); }
}
/** Node/Express middleware. authenticate must use verified server credentials, including CSRF checks for cookies. */
function router(shares, { service, authenticate } = {}) {
    v.ref({ service, kind: 'resource', id: 'check' });
    if (typeof authenticate !== 'function') throw new TypeError('router requires authenticate(req)');
    return async function shareRouter(req, res, next) {
        try {
            const url = new URL(req.url, 'http://share.local');
            const listing = url.pathname === '/api/v1/shared-with-me';
            const match = url.pathname.match(/^\/api\/v1\/([^/]+)\/([^/]+)\/share(?:\/(requests|transfer)(?:\/(accept|decline|cancel))?)?$/);
            if (!listing && !match) { if (next) return next(); v.hidden(); }
            const viewer = await authenticate(req);
            if (listing) {
                if (req.method !== 'GET') v.fail(405, 'share.method', 'Method not allowed');
                return send(res, 200, await shares.sharedWithMe(viewer, { service, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50, cursor: url.searchParams.get('cursor') || undefined }));
            }
            let kind, id;
            try { kind = decodeURIComponent(match[1]); id = decodeURIComponent(match[2]); } catch { v.invalid(); }
            const ref = v.ref({ service, kind, id }), endpoint = match[3], action = match[4];
            if (!endpoint && req.method === 'GET') {
                const result = await shares.getWithRevision(viewer, ref);
                return send(res, 200, result.value, { ETag: result.etag });
            }
            if (!endpoint && req.method === 'PUT') return send(res, 200, await shares.update(viewer, ref, await body(req), { ifMatch: req.headers['if-match'] }));
            if (req.method !== 'POST' || !endpoint) v.fail(405, 'share.method', 'Method not allowed');
            const input = await body(req);
            if (endpoint === 'requests' && !action) { v.object(input, []); return send(res, 201, await shares.requestAccess(viewer, ref)); }
            if (endpoint === 'transfer' && !action) {
                v.object(input, ['to', 'keep_access']); return send(res, 201, await shares.transfer(viewer, ref, input));
            }
            if (endpoint === 'transfer' && action) {
                v.object(input, ['transfer_id']); v.uuid(input.transfer_id);
                return send(res, 200, await shares[action](viewer, ref, input.transfer_id));
            }
            v.hidden();
        } catch (err) {
            if (res.headersSent) { res.end(); return; }
            if (err instanceof v.ShareError) return send(res, err.status, { code: err.code, error: err.message });
            // Neither SQL errors nor upstream errors can reveal a private resource or credentials.
            return send(res, 500, { code: 'share.internal', error: 'Sharing unavailable' });
        }
    };
}
module.exports = { router };
