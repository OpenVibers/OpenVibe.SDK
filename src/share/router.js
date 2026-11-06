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
/**
 * Node/Express middleware. authenticate must use verified server credentials. describe(ref) may add { title, link,
 * roles, audiences, transferable }; csrf: false is for a service that already checks CSRF in authenticate.
 */
function router(shares, { service, authenticate, describe, csrf } = {}) {
    v.ref({ service, kind: 'resource', id: 'check' });
    if (typeof authenticate !== 'function') throw new TypeError('router requires authenticate(req)');
    if (describe !== undefined && typeof describe !== 'function') throw new TypeError('router describe must be a function');
    const base = { title: null, link: null, roles: ['viewer'], audiences: ['public', 'link', 'people', 'private'], transferable: true };
    const detail = async ref => ({ ...base, ...(describe ? await describe(ref) : {}) });
    return async function shareRouter(req, res, next) {
        try {
            const url = new URL(req.url, 'http://share.local');
            const path = url.pathname;
            const listing = path === '/api/v1/shared-with-me';
            const people = path === '/api/v1/share/people';
            const match = path.match(/^\/api\/v1\/([^/]+)\/([^/]+)\/share(?:\/(.*))?$/);
            if (!listing && !people && !match) { if (next) return next(); v.hidden(); }
            // Cookie-authenticated writes need a same-site marker; bearer tokens cannot be sent cross-site.
            if (csrf !== false && !['GET', 'HEAD'].includes(req.method) && !req.headers.authorization) {
                const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
                if (req.headers['x-requested-with'] === undefined && !['same-origin', 'same-site'].includes(site)) {
                    return send(res, 403, { code: 'share.csrf', error: 'Cross-site request refused' });
                }
            }
            const viewer = await authenticate(req);
            if (people) {
                if (req.method !== 'GET') v.fail(405, 'share.method', 'Method not allowed');
                if (!viewer) v.hidden();
                const name = url.searchParams.get('name');
                if (!name) v.invalid();
                return send(res, 200, await shares.lookup(viewer, name));
            }
            if (listing) {
                if (req.method !== 'GET') v.fail(405, 'share.method', 'Method not allowed');
                return send(res, 200, await shares.sharedWithMe(viewer, { service, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50, cursor: url.searchParams.get('cursor') || undefined }));
            }
            let kind, id;
            try { kind = decodeURIComponent(match[1]); id = decodeURIComponent(match[2]); } catch { v.invalid(); }
            const ref = v.ref({ service, kind, id }), rest = match[3];
            const view = async (status = 200) => {
                const result = await shares.getWithRevision(viewer, ref);
                return send(res, status, { ...result.value, ...(await detail(ref)) }, { ETag: result.etag });
            };
            if (!rest && req.method === 'GET') return await view();
            if (!rest && req.method === 'PUT') { await shares.update(viewer, ref, await body(req), { ifMatch: req.headers['if-match'] }); return await view(); }
            if (req.method !== 'POST' || !rest) v.fail(405, 'share.method', 'Method not allowed');
            const input = await body(req);
            if (rest === 'requests') { v.object(input, []); return send(res, 201, await shares.requestAccess(viewer, ref)); }
            const dismiss = rest.match(/^requests\/([^/]+)\/dismiss$/);
            if (dismiss) {
                v.object(input, []);
                let requestId; try { requestId = decodeURIComponent(dismiss[1]); } catch { v.invalid(); }
                await shares.dismiss(viewer, ref, requestId);
                return await view();
            }
            if (rest === 'transfer') { v.object(input, ['to', 'keep_access']); await shares.transfer(viewer, ref, input); return await view(201); }
            const answer = rest.match(/^transfer\/(accept|decline|cancel)$/);
            if (answer) {
                v.object(input, ['transfer_id']); v.uuid(input.transfer_id);
                const result = await shares[answer[1]](viewer, ref, input.transfer_id);
                if (answer[1] === 'cancel') return await view();
                // The recipient answered, not the owner: keep the transfer shape its banner expects.
                return send(res, 200, result);
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
