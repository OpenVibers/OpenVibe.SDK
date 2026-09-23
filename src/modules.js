'use strict';
/**
 * openvibe-sdk/modules: per-subject module records on OpenVibe.Network (contracts
 * modules.module-record@1). Every write names the revision it read (If-Match); a moved revision
 * is 412 modules.revision_conflict, so two writers never silently overwrite each other.
 * update(ns, fn) does the read-modify-write loop for you. Browser-safe.
 *
 *   user     GET/PUT/DELETE /api/modules/:ns, GET /api/modules, GET /api/modules/:ns/public/:subject
 *   service  GET/PUT /internal/modules/:ns/:subject  (token with network.modules.read / .write for ns)
 */
const { isOpenVibeError, OpenVibeError } = require('./core/errors');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const enc = encodeURIComponent;

function createModulesClient(client, { baseUrl, maxAttempts = 5 } = {}) {
    const call = (opts) => client.json({ service: 'network', baseUrl, audience: 'openvibe.network', ...opts });
    const orNull = (p) => p.catch((err) => { if (isOpenVibeError(err) && err.status === 404) return null; throw err; });
    const ifMatch = (revision) => (revision === undefined || revision === null ? undefined : `"${Number(revision)}"`);

    async function readModifyWrite(read, write, fn, attempts) {
        let last;
        for (let i = 0; i < attempts; i++) {
            const rec = await read();
            const next = await fn(rec ? clone(rec.data) : undefined, rec);
            if (next === undefined) return rec;          // nothing to change
            try {
                return await write(next, rec ? rec.revision : 0);
            } catch (err) {
                if (!(isOpenVibeError(err) && err.status === 412)) throw err;
                last = err;                               // someone else wrote first: read again
            }
        }
        throw last || new OpenVibeError({ code: 'modules.revision_conflict', status: 412, message: 'update gave up' });
    }

    const mine = {
        /** Every record of the signed-in subject: { subject, modules, namespaces }. */
        list: () => call({ path: '/api/modules' }),
        /** The record, or null when there is none yet. */
        get: (ns) => orNull(call({ path: `/api/modules/${enc(ns)}` })),
        /** Replace the data. revision = the one you read (0 for a new record); required for users. */
        put(ns, data, { revision } = {}) {
            if (revision === undefined) throw new TypeError('put: pass { revision } (0 for a new record)');
            return call({ method: 'PUT', path: `/api/modules/${enc(ns)}`, json: { data }, headers: { 'If-Match': ifMatch(revision) } });
        },
        /** true when a record was deleted, false when there was none. */
        async delete(ns) {
            try { await call({ method: 'DELETE', path: `/api/modules/${enc(ns)}` }); return true; } catch (err) {
                if (isOpenVibeError(err) && err.status === 404) return false;
                throw err;
            }
        },
        /** Read, apply fn(data, record) -> newData (undefined = no change), write; retries on 412. */
        update(ns, fn, { attempts = maxAttempts } = {}) {
            return readModifyWrite(() => mine.get(ns), (data, rev) => mine.put(ns, data, { revision: rev }), fn, attempts);
        },
        /** Anyone: only the namespace's public fields. */
        publicGet: (ns, subjectId) => orNull(call({ path: `/api/modules/${enc(ns)}/public/${enc(subjectId)}`, auth: false })),
    };

    const service = {
        get: (ns, subjectId) => orNull(call({ path: `/internal/modules/${enc(ns)}/${enc(subjectId)}` })),
        /** The owning service may write unconditionally (no revision); pass one to guard against races. */
        put: (ns, subjectId, data, { revision } = {}) => call({
            method: 'PUT', path: `/internal/modules/${enc(ns)}/${enc(subjectId)}`, json: { data }, headers: { 'If-Match': ifMatch(revision) },
        }),
        update(ns, subjectId, fn, { attempts = maxAttempts } = {}) {
            return readModifyWrite(() => service.get(ns, subjectId), (data, rev) => service.put(ns, subjectId, data, { revision: rev }), fn, attempts);
        },
    };

    return { ...mine, forSubject: service };
}

module.exports = { createModulesClient };
