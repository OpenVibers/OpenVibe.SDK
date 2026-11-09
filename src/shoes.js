'use strict';

/** Open.Shoes public catalogue and size tools. All methods are public reads. */
function createShoesClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createShoesClient: pass an openvibe-sdk/core client');
    const at = { service: 'shoes', baseUrl, audience: 'open.shoes' };
    const call = (opts) => client.json({ ...at, ...opts });
    return {
        products: {
            list: ({ kind, q, size, signal } = {}) => call({ path: '/api/v1/products', query: { kind, q, size }, signal }),
            get: (id, { signal } = {}) => call({ path: `/api/v1/products/${encodeURIComponent(String(id))}`, signal }),
            offers: (id, { signal } = {}) => call({ path: `/api/v1/products/${encodeURIComponent(String(id))}/offers`, signal }),
        },
        tools: {
            laceLength: ({ eyelet_pairs, method, horizontal_cm, vertical_cm, ends_cm, signal } = {}) => call({
                path: '/api/v1/tools/lace-length', query: { eyelet_pairs, method, horizontal_cm, vertical_cm, ends_cm }, signal,
            }),
        },
        sizes: {
            convert: ({ system, size, brand, signal } = {}) => call({ path: '/api/v1/sizes/convert', query: { system, size, brand }, signal }),
        },
    };
}

module.exports = { createShoesClient };
