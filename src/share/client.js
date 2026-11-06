'use strict';
const { createClient } = require('../core');
const locker = require('../locker');
const v = require('./validation');
/** Network is where a person's public keys live (locker.public-keys@1). */
const DEFAULT_NETWORK = 'https://openvibe.network';
const bytesOf = value => (value instanceof Uint8Array ? value : value && value.bytes);
const base64Of = value => Buffer.from(bytesOf(value)).toString('base64');
/** A content key: 32 bytes, as bytes or base64url (as a link key travels). */
function contentKeyOf(value) {
    if (!value) throw new TypeError('A locked member needs the item\'s content key');
    const bytes = typeof value === 'string'
        ? Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        : bytesOf(value);
    if (!bytes || bytes.length !== 32) throw new TypeError('A content key is 32 bytes, as bytes or base64url');
    return bytes;
}
/** The member fields a save echoes back: the slot travels with its member or the server refuses it. */
const echo = ({ subject, role, expires_at, key_slot }) => ({ subject, role, ...(expires_at ? { expires_at } : {}), ...(key_slot ? { key_slot } : {}) });
/** Agent client: optimistic PUT preserves members added by another caller. */
function share({ base, token, fetch, network = DEFAULT_NETWORK } = {}) {
    if (typeof base !== 'string' || !/^https?:\/\//.test(base)) throw new TypeError('share requires base');
    if (typeof network !== 'string' || !/^https?:\/\//.test(network)) throw new TypeError('share network must be a URL');
    const client = createClient({ token, fetch, retries: 0, autoDiscover: false });
    const call = (path, options = {}) => client.json({ baseUrl: base, path, ...options });
    async function read(path) {
        const response = await client.request({ baseUrl: base, path });
        return { value: response.data, etag: response.headers.get('etag') };
    }
    /** A person's public keys, as anyone may read them. */
    async function keysFor(subject) {
        const found = await client.json({ baseUrl: network, path: `/api/v1/people/${encodeURIComponent(subject.id)}/keys` });
        if (!found || !found.ecdh) throw new Error('That person has no locker key yet');
        return found;
    }
    /** An @name or a subject object, as the canonical subject. */
    async function subjectOf(target) {
        if (typeof target !== 'string') return v.subject(target);
        const { person } = await call('/api/v1/share/people', { query: { name: target } });
        if (!person) throw new Error(`No OpenVibe account is called @${target.replace(/^@/, '')}`);
        return person.subject;
    }
    return {
        sharedWithMe: options => call('/api/v1/shared-with-me', { query: options }),
        people: name => call('/api/v1/share/people', { query: { name } }),
        for(kind, id) {
            v.ref({ service: 'client', kind, id });
            const path = `/api/v1/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/share`;
            const updateMembers = async (fn, { envelope } = {}) => {
                const { value, etag } = await read(path);
                if (!etag) throw new Error('Sharing server did not provide an ETag');
                return call(path, { method: 'PUT', headers: { 'If-Match': etag },
                    json: { members: fn((value.members || []).map(echo)), ...(envelope ? { envelope: base64Of(envelope) } : {}) } });
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
                /** Adds a member to a people-locked item: looks up their key, wraps the content key for it, saves both. */
                addLocked: async (target, { contentKey, role = 'viewer', expires_at } = {}) => {
                    const subject = await subjectOf(target);
                    const found = await keysFor(subject);
                    const key_slot = await locker.wrapFor(contentKeyOf(contentKey), found.ecdh, { subject });
                    return updateMembers(members => [...members.filter(m => !v.equal(m.subject, subject)),
                        { subject, role, ...(expires_at ? { expires_at } : {}), key_slot }]);
                },
                /**
                 * Removes a member from a people-locked item with a re-seal. `envelope` is either the content
                 * already sealed for those who stay, or — with `contentKey` — the item's current envelope, which
                 * is opened and sealed again without that person.
                 */
                removeLocked: async (target, { contentKey, envelope, keys } = {}) => {
                    const subject = await subjectOf(target);
                    const { value, etag } = await read(path);
                    if (!etag) throw new Error('Sharing server did not provide an ETag');
                    const staying = (value.members || []).map(echo).filter(m => !v.equal(m.subject, subject));
                    let sealed = envelope ? bytesOf(envelope) : null;
                    if (contentKey) {
                        if (!sealed) throw new TypeError('removeLocked needs the item\'s current envelope alongside the content key');
                        // The owner keeps their slot: they are not a member, and their key is not in the member list.
                        const recipients = keys || await Promise.all([value.owner_subject, ...staying.map(m => m.subject)]
                            .filter((s, i, all) => all.findIndex(x => v.equal(x, s)) === i)
                            .map(async s => ({ subject: s, publicKey: (await keysFor(s)).ecdh })));
                        const wrapped = await locker.rewrap(sealed, { remove: [subject], keys: recipients,
                            credentials: { contentKey: contentKeyOf(contentKey) } });
                        sealed = wrapped.bytes;
                    }
                    if (!sealed) throw new TypeError('removeLocked needs a re-sealed envelope, or the content key and the current envelope');
                    return call(path, { method: 'PUT', headers: { 'If-Match': etag }, json: { members: staying, envelope: base64Of(sealed) } });
                },
                requestAccess: () => call(path + '/requests', { method: 'POST', json: {} }),
                dismiss: request_id => call(path + '/requests/' + encodeURIComponent(request_id) + '/dismiss', { method: 'POST', json: {} }),
                transfer: (to, { keep_access = false, key_slot } = {}) => call(path + '/transfer', { method: 'POST', json: { to, keep_access, ...(key_slot ? { key_slot } : {}) } }),
                accept: transfer_id => call(path + '/transfer/accept', { method: 'POST', json: { transfer_id } }),
                decline: transfer_id => call(path + '/transfer/decline', { method: 'POST', json: { transfer_id } }),
                cancel: transfer_id => call(path + '/transfer/cancel', { method: 'POST', json: { transfer_id } }),
            };
        },
    };
}
module.exports = { share, createShareClient: share };
