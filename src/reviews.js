'use strict';
/**
 * openvibe-sdk/reviews — OpenVibe.Reviews for apps: look up a business, product or place (an entity) by name, URL or
 * product code, read its record (the aggregate with its inputs, the signals with their provenance, the summary) and
 * history, and send a correction to the editors for the person. Routes at https://openvibe.reviews/api/v1; tokens for
 * audience openvibe.reviews. A developer app acts only for the person who authorized it (on_behalf_of).
 *
 *   const reviews = createReviewsClient(createClient({ tokenProvider }));
 *   const hit = await reviews.resolve({ name: 'Blue Star Donuts', url: 'https://bluestardonuts.com' });   // a match or candidates
 *   const { entities } = await reviews.entities.list({ q: 'donuts', limit: 20 });
 *   const page = await reviews.entities.get('blue-star-donuts');                                          // aggregate, signals, summary
 *   await reviews.corrections.submit('blue-star-donuts', { target_type: 'entity', body: 'Closed on Mondays now', evidence_url: 'https://…' });
 *
 * Capabilities (public since openvibe-contracts 0.207.0): reviews.entity.resolve (the reads and resolve) and
 * reviews.correction.submit. Resolving is deterministic: a name alone yields candidates, never a match. A correction
 * goes to the editors' queue; it changes nothing until an editor accepts it, and is never retried on its own.
 * Errors are OpenVibeError: entity.not_found, item.not_found, item.removed (410), reviews.person_required,
 * capability.denied, subject.not_delegated, …
 */
const enc = encodeURIComponent;
const TARGETS = ['entity', 'alias', 'signal', 'summary', 'aggregate'];

function createReviewsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createReviewsClient: pass an openvibe-sdk/core client');
    const at = { service: 'reviews', baseUrl, audience: 'openvibe.reviews' };
    const call = (opts) => client.json({ ...at, ...opts });
    const entity = (ref, rest = '') => {
        if (!ref || typeof ref !== 'string') throw new TypeError("reviews: an entity's ref (its slug or id)");
        return `/api/v1/entities/${enc(ref)}${rest}`;
    };

    return {
        /** Resolve identifiers to an entity (reviews.entity-resolve-request@1): name, url, gtin, sku, mpn, source, external. */
        resolve: (identifiers, { signal } = {}) => {
            if (!identifiers || typeof identifiers !== 'object' || !Object.keys(identifiers).length) throw new TypeError('reviews.resolve: at least one identifier');
            return call({ method: 'POST', path: '/api/v1/resolve', json: identifiers, idempotent: true, signal });
        },
        entities: {
            /** Active entities, or a search with q. */
            list: ({ q, limit, offset, signal } = {}) => call({ path: '/api/v1/entities', query: { q, limit, offset }, signal }),
            /** The entity page's data: the aggregate with its inputs, the signals with provenance, the summary. */
            get: (ref, { signal } = {}) => call({ path: entity(ref), signal }),
            /** Aggregate and summary revisions, merges and the audit trail. */
            history: (ref, { signal } = {}) => call({ path: entity(ref, '/history'), signal }),
            aggregate: (ref, { signal } = {}) => call({ path: entity(ref, '/aggregate'), signal }),
            summaryRevision: (ref, n, { signal } = {}) => {
                if (!Number.isInteger(Number(n)) || Number(n) < 1) throw new TypeError('reviews.entities.summaryRevision: a revision number');
                return call({ path: entity(ref, `/summary/revisions/${Number(n)}`), signal });
            },
        },
        corrections: {
            /** A correction for the editors (reviews.correction-submit-request@1): body required, target_type, target_id, evidence_url. */
            submit: (ref, { body, target_type: type, target_id: targetId, evidence_url: evidence } = {}, { signal } = {}) => {
                if (typeof body !== 'string' || !body.trim()) throw new TypeError('reviews.corrections.submit: the correction text (body)');
                if (type != null && !TARGETS.includes(type)) throw new TypeError(`reviews.corrections.submit: target_type is one of ${TARGETS.join(', ')}`);
                return call({ method: 'POST', path: entity(ref, '/corrections'), json: { body, target_type: type, target_id: targetId, evidence_url: evidence }, idempotencyKey: false, signal });
            },
        },
    };
}

module.exports = { createReviewsClient };
