'use strict';
/**
 * openvibe-sdk/memory: a person's memory in OpenVibe.AI (plan §V.1, "one memory, on openvibe.my"), for first-party
 * services granted ai.memory.read and ai.memory.write (audience openvibe.ai), always acting for one person (a usr_
 * subject, sent as on_behalf_of).
 *
 *   const memory = createMemoryClient(client);
 *   await memory.remember('usr_…', [{ text: 'Prefers short answers', kind: 'preference' }]);
 *   const { items } = await memory.recall('usr_…', 'how they like answers', { scopes: ['user'] });
 *   const { profile } = await memory.profile('usr_…');
 *
 * - remember: what a service writes is a suggestion the person keeps or lets go on openvibe.my/memory (its confidence
 *   is at most 0.5, and the store redacts secrets and refuses an item that is only a secret). It is written under the
 *   service's own name. Up to 200 items a call.
 * - recall: active items only, in the scopes the service's grant names, at most 8; every read is in the person's read
 *   log (ids, never text).
 * - profile: the scope's short summary, rebuilt by the store at most once an hour.
 * - There is no forget for a service: only the person deletes (MEMORY_PAGE is where they do it).
 */
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS = Object.freeze(['preference', 'fact', 'project_rule', 'procedure', 'decision', 'lesson']);
const MAX_BATCH = 200;
const MEMORY_PAGE = 'https://openvibe.my/memory';

function personOf(who) {
    const p = String(who == null ? '' : who);
    if (!SUBJECT_RE.test(p)) throw new TypeError('openvibe-sdk/memory: the person is a usr_ subject');
    return p;
}

function createMemoryClient(client, defaults = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('openvibe-sdk/memory: createMemoryClient(client) needs an openvibe-sdk client');
    const { baseUrl } = defaults;
    const call = (opts, o = {}) => client.json({ service: 'ai', baseUrl, audience: 'openvibe.ai', ...opts, signal: o.signal });

    /** Suggest notes for the person: [{ text, kind?, scope?, confidence?, person_said? }] or plain strings. → { items, … } */
    async function remember(who, items, o = {}) {
        const person = personOf(who);
        const list = (Array.isArray(items) ? items : [items]).map((x) => (typeof x === 'string' ? { text: x } : x || {}));
        if (!list.length || list.length > MAX_BATCH) throw new TypeError(`openvibe-sdk/memory: remember takes 1 to ${MAX_BATCH} items`);
        const out = list.map((x, i) => {
            const text = String(x.text == null ? '' : x.text).trim();
            if (!text) throw new TypeError(`openvibe-sdk/memory: item ${i} has no text`);
            if (x.kind != null && !KINDS.includes(x.kind)) throw new TypeError(`openvibe-sdk/memory: item ${i}'s kind is one of ${KINDS.join(', ')}`);
            return {
                text,
                scope: String(x.scope || o.scope || 'user'),
                ...(x.kind != null ? { kind: x.kind } : {}),
                ...(x.confidence != null ? { confidence: Number(x.confidence) } : {}),
                // The person said it, in their own words, in their own message (the service checked): the store keeps it
                // active at once instead of as a suggestion (OpenVibe.AI #694). Only `true` counts.
                ...(x.person_said === true ? { person_said: true } : {}),
            };
        });
        return call({ method: 'POST', path: '/api/v1/memory/items:batch', json: { on_behalf_of: person, items: out },
            idempotencyKey: o.idempotencyKey || false }, o);
    }

    /** Notes that match the words, in the granted scopes (default ['user']). → { items, count } */
    async function recall(who, q, o = {}) {
        const person = personOf(who);
        const scopes = (Array.isArray(o.scopes) && o.scopes.length ? o.scopes : ['user']).map(String);
        return call({ method: 'GET', path: '/api/v1/memory/search',
            query: { q: String(q == null ? '' : q).slice(0, 500), scopes: scopes.join(','), on_behalf_of: person } }, o);
    }

    /** The scope's summary (default 'user'). → { profile } */
    async function profile(who, o = {}) {
        const person = personOf(who);
        return call({ method: 'GET', path: '/api/v1/memory/profile', query: { scope: String(o.scope || 'user'), on_behalf_of: person } }, o);
    }

    return { remember, recall, profile };
}

module.exports = { createMemoryClient, KINDS, MAX_BATCH, MEMORY_PAGE };
