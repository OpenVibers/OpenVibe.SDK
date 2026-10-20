'use strict';
/**
 * openvibe-sdk/zone — OpenVibe.Zone for apps: a developer project's object zones (named storage spaces in
 * OpenVibe.Media, one set per environment, each with an optional quota) and their usage. Routes at
 * https://openvibe.zone/api/v1; tokens for audience openvibe.zone. Upload into a zone with openvibe-sdk/media's
 * object API.
 *
 *   const zone = createZoneClient(createClient({ tokenProvider }));
 *   const z = await zone.zones.create('prj_01…', { env: 'production', name: 'user-uploads', quota_bytes: 50e9 });
 *   const { zones, next_cursor } = await zone.zones.list('prj_01…', { env: 'production' });
 *   const usage = await zone.zones.usage(z.id);                 // Media's live snapshot and this month's metered series
 *   await zone.zones.update(z.id, { quota_bytes: 100e9 });
 *   await zone.zones.remove(z.id, { recursive: true });         // 202: deleting, with everything in it
 *
 * Who may act on a project: an app of that project holding the route's capability (a sandbox app only in the sandbox),
 * or a person who is a member of it (any role reads; admins and owners change). Anyone else is told the project or
 * zone does not exist. create carries an Idempotency-Key (Zone answers a repeat with the same zone), so it is retried
 * safely. Errors are OpenVibeError: zone.name_taken, zone.name_retired (409), zone.not_empty, zone.held,
 * zone.bad_request, …
 */
const enc = encodeURIComponent;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;   // Zone's own rules
const ZONE_RE = /^zon_[0-9A-HJKMNP-TV-Z]{26}$/;
const ENVS = ['sandbox', 'production'];

function createZoneClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createZoneClient: pass an openvibe-sdk/core client');
    const at = { service: 'zone', baseUrl, audience: 'openvibe.zone' };
    const call = (opts) => client.json({ ...at, ...opts });
    const project = (p) => {
        if (!PROJECT_RE.test(String(p || ''))) throw new TypeError('zone: a project is a prj_ id');
        return `/api/v1/projects/${enc(String(p))}/zones`;
    };
    const zonePath = (z, rest = '') => {
        if (!ZONE_RE.test(String(z || ''))) throw new TypeError('zone: a zone is a zon_ id');
        return `/api/v1/zones/${enc(String(z))}${rest}`;
    };
    const env = (e) => {
        if (e != null && !ENVS.includes(e)) throw new TypeError(`zone: env is ${ENVS.join(' or ')}`);
        return e;
    };

    return {
        zones: {
            /** A new zone (zone.object-zone-create-request@1: env, name, description?, quota_bytes?) → the zone. */
            create: (p, { env: e, name, description, quota_bytes: quota } = {}, { idempotencyKey, signal } = {}) => {
                if (!env(e)) throw new TypeError('zone.zones.create: env is required');
                return call({ method: 'POST', path: project(p), json: { env: e, name, description, quota_bytes: quota }, ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}), signal });
            },
            /** The project's zones: { zones, next_cursor }. */
            list: (p, { env: e, include_deleted: includeDeleted, limit, cursor, signal } = {}) => call({ path: project(p), query: { env: env(e), include_deleted: includeDeleted ? 'true' : undefined, limit, cursor }, signal }),
            /** One zone, with its stored bytes and objects. */
            get: (z, { signal } = {}) => call({ path: zonePath(z), signal }),
            /** Change the description or the quota (null for none). */
            update: (z, { description, quota_bytes: quota } = {}, { signal } = {}) => call({ method: 'PATCH', path: zonePath(z), json: { description, quota_bytes: quota }, idempotent: true, signal }),
            /** Delete it; recursive deletes what it holds too (without it, a zone with objects is zone.not_empty). */
            remove: (z, { recursive = false, signal } = {}) => call({ method: 'DELETE', path: zonePath(z), query: { recursive: recursive ? 'true' : undefined }, signal }),
            /** Media's live snapshot and this month's metered series (requests, egress, byte-hours). */
            usage: (z, { signal } = {}) => call({ path: zonePath(z, '/usage'), signal }),
        },
    };
}

module.exports = { createZoneClient };
