'use strict';
/**
 * openvibe-sdk/deals — OpenVibe.Deals for apps: the hot and new offers, an offer with its hotness, products and stores
 * (public), and, for the person who authorized the app, posting deals, recording what a price is now, voting,
 * flagging and keeping watches. Routes at https://openvibe.deals/api/v1; tokens for audience openvibe.deals. An app
 * acts only for its on_behalf_of person.
 *
 *   const deals = createDealsClient(createClient({ tokenProvider }));
 *   const { offers } = await deals.offers.list({ sort: 'hot' });                         // public
 *   const { offer } = await deals.offers.submit({ url: 'https://…', title: 'GPU at $299', price: 299, currency: 'USD' });
 *   await deals.offers.observe(offer.id, { price: 279, currency: 'USD', availability: 'in_stock' });
 *   await deals.offers.vote(offers[0].id, 1);
 *   await deals.watches.create({ kind: 'price_below', product: 'rtx-4070', max_price: 450, currency: 'USD' });
 *
 * Capabilities (public since openvibe-contracts 0.208.0): deals.offer.submit (sensitive), deals.offer.update (the
 * person's own offers, and price observations of any active offer), deals.vote.set (sensitive) and .remove,
 * deals.flag.create, deals.watch.create, .read and .delete. Votes and hotness are Deals' own (never from the request);
 * no votes on one's own offer. Submitting, observing, flagging and creating a watch make a new row each time and are
 * never retried on their own; a link already posted answers 409 offer.duplicate with the existing offer.
 */
const enc = encodeURIComponent;
const SORTS = ['hot', 'new'];
const FLAGS = ['expired', 'price_wrong', 'spam', 'duplicate', 'other'];
const WATCHES = ['keyword', 'product', 'price_below', 'search'];

function createDealsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createDealsClient: pass an openvibe-sdk/core client');
    const at = { service: 'deals', baseUrl, audience: 'openvibe.deals' };
    const call = (opts) => client.json({ ...at, ...opts });
    const once = (opts) => call({ ...opts, idempotencyKey: false });
    const offer = (id, rest = '') => {
        if (!id || typeof id !== 'string') throw new TypeError("deals: an offer's id or slug");
        return `/api/v1/offers/${enc(id)}${rest}`;
    };

    return {
        offers: {
            /** Hot (Deals' hot@1 ranking) or new offers, a page at a time (public). */
            list: ({ sort, page, signal } = {}) => {
                if (sort != null && !SORTS.includes(sort)) throw new TypeError("deals.offers.list: sort is 'hot' or 'new'");
                return call({ path: '/api/v1/offers', query: { sort, page }, signal });
            },
            /** By id or slug; a merged offer answers with its canonical one (public). */
            get: (id, { signal } = {}) => call({ path: offer(id), signal }),
            hotness: (id, { signal } = {}) => call({ path: offer(id, '/hotness'), signal }),
            /** Post a deal: url and title, and what the person sees now (price, currency, shipping, condition, availability). */
            submit: (fields, { signal } = {}) => {
                if (!fields || !fields.url || !fields.title) throw new TypeError('deals.offers.submit: url and title');
                return once({ method: 'POST', path: '/api/v1/offers', json: fields, signal });
            },
            /** Edit the person's own offer: title, description, category, expires_at, product. */
            update: (id, patch, { signal } = {}) => call({ method: 'PATCH', path: offer(id), json: patch, idempotent: true, signal }),
            /** What the price is now (a new observation; prices are never edited in place). */
            observe: (id, observation, { signal } = {}) => once({ method: 'POST', path: offer(id, '/observations'), json: observation, signal }),
            /** +1 or -1 for the person (never on their own offer). */
            vote: (id, value, { signal } = {}) => {
                if (value !== 1 && value !== -1) throw new TypeError('deals.offers.vote: 1 or -1');
                return call({ method: 'PUT', path: offer(id, '/vote'), json: { value }, signal });
            },
            unvote: (id, { signal } = {}) => call({ method: 'DELETE', path: offer(id, '/vote'), signal }),
            /** Report a problem: { kind, reason?, duplicate_of? }; one open report per person and offer. */
            flag: (id, { kind, reason, duplicate_of: duplicateOf } = {}, { signal } = {}) => {
                if (!FLAGS.includes(kind)) throw new TypeError(`deals.offers.flag: kind is one of ${FLAGS.join(', ')}`);
                return once({ method: 'POST', path: offer(id, '/flags'), json: { kind, reason, duplicate_of: duplicateOf }, signal });
            },
        },
        products: {
            get: (slug, { signal } = {}) => call({ path: `/api/v1/products/${enc(String(slug))}`, signal }),
        },
        stores: {
            get: (domain, { signal } = {}) => call({ path: `/api/v1/stores/${enc(String(domain))}`, signal }),
        },
        watches: {
            list: ({ signal } = {}) => call({ path: '/api/v1/watches', signal }),
            /** A keyword, product or price-below watch, or a saved search (never notifies). */
            create: (fields, { signal } = {}) => {
                if (!fields || !WATCHES.includes(fields.kind)) throw new TypeError(`deals.watches.create: kind is one of ${WATCHES.join(', ')}`);
                return once({ method: 'POST', path: '/api/v1/watches', json: fields, signal });
            },
            remove: (id, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/watches/${enc(String(id))}`, signal }),
        },
    };
}

module.exports = { createDealsClient };
