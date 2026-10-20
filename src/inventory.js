'use strict';
/**
 * openvibe-sdk/inventory — OpenVibe.Inventory, the network-wide inventory (ADR-054): kinds, item definitions, what
 * people own and wear, and, for an item's issuer, granting, consuming and revoking. The owner's ask (2026-10-08): "cross
 * site network wide shared multi purpose modular system … through sdk / api". Sites, games and apps define their items
 * here and render what people wear anywhere. Tokens are for audience openvibe.inventory.
 *
 *   const inv = createInventoryClient(createClient({ tokenProvider }));
 *   const { kinds } = await inv.kinds.list();                                        // public
 *   const { equipped } = await inv.equipped(['usr_01…', 'usr_02…']);                 // up to 100, for chat renders
 *   const { definition } = await inv.definitions.create({ kind: 'game:mygame.badge', name: 'First Win', rarity: 'common', art: { emoji: '🏆' } });
 *   await inv.grants.create({ definition_id: definition.id, subject: 'usr_01…', idempotency_key: `win-${matchId}` });
 *   await inv.forPerson('usr_01…').me.equip({ kind: 'live.hat', slot: 'head', instance_id: 'inv_01…' });   // a service acting for a person
 *
 * Only a kind's issuer defines and grants its items (or a grantor it names on one item). A grant is idempotent per
 * idempotency_key: the same key returns the first instance with created: false. Nothing is sold, bought or traded.
 * Errors are OpenVibeError: inventory.supply_exhausted (409), inventory.unknown_kind, inventory.bad_slot,
 * inventory.subject_required, capability.denied, …
 */
const enc = encodeURIComponent;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ID_RE = { definition: /^itd_[0-9A-HJKMNP-TV-Z]{26}$/, instance: /^inv_[0-9A-HJKMNP-TV-Z]{26}$/ };   // Inventory's own rules

function createInventoryClient(client, { baseUrl, subject } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createInventoryClient: pass an openvibe-sdk/core client');
    if (subject != null && !SUBJECT_RE.test(String(subject))) throw new TypeError('createInventoryClient: subject is a usr_ subject id');
    const at = { service: 'inventory', baseUrl, audience: 'openvibe.inventory' };
    // A service acting for a person names them (X-OV-Subject); a person's own token needs nothing.
    const headers = subject ? { 'X-OV-Subject': String(subject) } : undefined;
    const call = (opts) => client.json({ ...at, ...(headers ? { headers } : {}), ...opts });
    const check = (re, v, what) => {
        if (!re.test(String(v || ''))) throw new TypeError(`inventory: ${what}`);
        return enc(String(v));
    };
    const person = (s) => check(SUBJECT_RE, s, 'a person is a usr_ subject id');

    const kinds = {
        /** Every kind: its schema, slots and the surfaces that render it. */
        list: ({ signal } = {}) => call({ path: '/api/v1/kinds', signal }),
        get: (kindId, { signal } = {}) => call({ path: `/api/v1/kinds/${enc(String(kindId))}`, signal }),
    };
    const definitions = {
        /** Published items, by kind and/or issuer. */
        list: ({ kind, issuer, limit, signal } = {}) => call({ path: '/api/v1/definitions', query: { kind, issuer, limit }, signal }),
        get: (id, { signal } = {}) => call({ path: `/api/v1/definitions/${check(ID_RE.definition, id, 'a definition is an itd_ id')}`, signal }),
        /** Define an item of a kind you issue (inventory.definition-request@1). Rarity, attributes and the cap are fixed once published. */
        create: (definition, { signal } = {}) => call({ method: 'POST', path: '/api/v1/definitions', json: definition, idempotencyKey: false, signal }),
        update: (id, patch, { signal } = {}) => call({ method: 'PATCH', path: `/api/v1/definitions/${check(ID_RE.definition, id, 'a definition is an itd_ id')}`, json: patch, signal }),
    };
    const people = {
        /** A person's owned items (public), newest first: { items, next }. */
        items: (s, { kind, cursor, limit, signal } = {}) => call({ path: `/api/v1/people/${person(s)}/items`, query: { kind, cursor, limit }, signal }),
        /** What a person wears: { subject, slots: { '<kind>:<slot>': { instance_id, definition_id, token?, media_id? } } }. */
        equipped: (s, { signal } = {}) => call({ path: `/api/v1/people/${person(s)}/equipped`, signal }),
    };
    /** Up to 100 people's equipped sets in one call (what chat renders use). */
    const equipped = (subjects, { signal } = {}) => {
        const list = [...new Set((subjects || []).map(String))];
        if (list.length > 100) throw new TypeError('inventory.equipped: at most 100 subjects per call');
        list.forEach(person);
        return call({ path: '/api/v1/equipped', query: { subjects: list.join(',') }, signal });
    };
    const me = {
        /** The caller's own items, every state (owned, consumed, revoked). */
        items: ({ kind, cursor, limit, signal } = {}) => call({ path: '/api/v1/me/items', query: { kind, cursor, limit }, signal }),
        /** Wear an item in a slot, or clear the slot with instance_id: null (inventory.equip-request@1). */
        equip: ({ kind, slot, instance_id: instanceId }, { signal } = {}) => {
            if (instanceId !== null) check(ID_RE.instance, instanceId, 'instance_id is an inv_ id, or null to clear the slot');
            return call({ method: 'PUT', path: '/api/v1/me/equipped', json: { kind, slot, instance_id: instanceId }, signal });
        },
    };
    const grants = {
        /** Give a person one of your items → { instance, created }. idempotency_key (8–128 characters) makes a retry safe. */
        create: ({ definition_id: def, subject: to, idempotency_key: key, ...rest }, { signal } = {}) => {
            check(ID_RE.definition, def, 'definition_id is an itd_ id');
            person(to);
            if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new TypeError('inventory.grants.create: idempotency_key is 8 to 128 characters');
            // The body's own key is what Inventory dedupes on, so the call may be retried safely.
            return call({ method: 'POST', path: '/api/v1/grants', json: { ...rest, definition_id: def, subject: to, idempotency_key: key }, idempotent: true, signal });
        },
    };
    const instances = {
        /** Use up an instance you issued (a ticket, a one-time item). */
        consume: (id, { signal } = {}) => call({ method: 'POST', path: `/api/v1/instances/${check(ID_RE.instance, id, 'an instance is an inv_ id')}/consume`, idempotencyKey: false, signal }),
        /** Take one back, with a reason the ledger keeps. */
        revoke: (id, { reason, signal } = {}) => call({ method: 'POST', path: `/api/v1/instances/${check(ID_RE.instance, id, 'an instance is an inv_ id')}/revoke`, json: reason ? { reason: String(reason) } : {}, idempotencyKey: false, signal }),
    };
    return {
        kinds, definitions, people, equipped, me, grants, instances,
        /** The same client acting for one person (sends X-OV-Subject): for a service that holds the route's capability. */
        forPerson: (s) => createInventoryClient(client, { baseUrl, subject: s }),
    };
}

module.exports = { createInventoryClient };
