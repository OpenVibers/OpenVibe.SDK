'use strict';
const { createClient } = require('../core');
const v = require('./validation');
/** Agent client: optimistic PUT preserves members added by another caller. */
function share({ base, token, fetch } = {}) {
    if (typeof base !== 'string' || !/^https?:\/\//.test(base)) throw new TypeError('share requires base');
    const client = createClient({ token, fetch, retries: 0, autoDiscover: false });
    const call = (path, options = {}) => client.json({ baseUrl: base, path, ...options });
    async function read(path) {
        const response = await client.request({ baseUrl: base, path });
        return { value: response.data, etag: response.headers.get('etag') };
    }
    return {
        sharedWithMe: options => call('/api/v1/shared-with-me', { query: options }),
        people: name => call('/api/v1/share/people', { query: { name } }),
        for(kind, id) {
            v.ref({ service: 'client', kind, id });
            const path = `/api/v1/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/share`;
            const updateMembers = async fn => {
                const { value, etag } = await read(path);
                if (!etag) throw new Error('Sharing server did not provide an ETag');
                const members = value.members.map(({ subject, role, expires_at }) => ({ subject, role, ...(expires_at ? { expires_at } : {}) }));
                return call(path, { method: 'PUT', headers: { 'If-Match': etag }, json: { members: fn(members) } });
            };
            return {
                get: () => call(path),
                update: (input, { ifMatch } = {}) => call(path, { method: 'PUT', json: input, ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}) }),
                setAudience: audience => call(path, { method: 'PUT', json: { audience } }),
                add: (target, { role = 'viewer', expires_at } = {}) => updateMembers(members => {
                    const member = { ...(typeof target === 'string' ? { name: target } : { subject: target }), role, ...(expires_at ? { expires_at } : {}) };
                    return [...members.filter(m => typeof target === 'string' || !v.equal(m.subject, target)), member];
                }),
                remove: subject => updateMembers(members => members.filter(m => !v.equal(m.subject, subject))),
                requestAccess: () => call(path + '/requests', { method: 'POST', json: {} }),
                dismiss: request_id => call(path + '/requests/' + encodeURIComponent(request_id) + '/dismiss', { method: 'POST', json: {} }),
                transfer: (to, { keep_access = false } = {}) => call(path + '/transfer', { method: 'POST', json: { to, keep_access } }),
                accept: transfer_id => call(path + '/transfer/accept', { method: 'POST', json: { transfer_id } }),
                decline: transfer_id => call(path + '/transfer/decline', { method: 'POST', json: { transfer_id } }),
                cancel: transfer_id => call(path + '/transfer/cancel', { method: 'POST', json: { transfer_id } }),
            };
        },
    };
}
module.exports = { share, createShareClient: share };
