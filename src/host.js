'use strict';
/**
 * openvibe-sdk/host — OpenVibe.Host's public hosting catalog for apps: providers, plans with their prices, promos,
 * offers from the community boards, domain endings with registrar prices (and whether a name is free), and
 * benchmarks people ran with YABS. Routes at https://openvibe.host/api/v1/catalog; all public, sent without a token
 * (audience openvibe.host). Editing the catalog is Host's editors' (first-party).
 *
 *   const host = createHostClient(createClient({}));
 *   const { plans, next_cursor } = await host.plans.list({ kind: 'vps', max_price: 10, currency: 'USD', sort: 'price_per_gb_ram' });
 *   const { provider } = await host.providers.get('linode');
 *   const { check } = await host.domains.check('example.dev');                 // rate-limited per address
 *   const { tld } = await host.domains.tld('dev');                             // every registrar's price for .dev
 *
 * Lists take Host's own filters and refuse any other key (422 host.catalog.invalid): plans kind, min_vcpu,
 * min_ram_mb, min_disk_gb, max_price, currency, location, provider, sort (price, price_per_vcpu, price_per_gb_ram,
 * price_per_gb_disk, checked_at) and cursor; offers sort, currency, max_monthly, source, priced and cursor. They
 * answer a page and its next_cursor. Prices are what each provider or registrar published, with when Host read them.
 */
const enc = encodeURIComponent;

function createHostClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createHostClient: pass an openvibe-sdk/core client');
    const at = { service: 'host', baseUrl, audience: 'openvibe.host' };
    const call = (opts) => client.json({ ...at, auth: false, ...opts });   // public reads: never a token
    const list = (p) => ({ signal, ...query } = {}) => call({ path: `/api/v1/catalog/${p}`, query, signal });
    const one = (p, what) => (key, { signal } = {}) => {
        if (!key || typeof key !== 'string') throw new TypeError(`host: a ${what}`);
        return call({ path: `/api/v1/catalog/${p}/${enc(key)}`, signal });
    };

    return {
        providers: { list: ({ signal } = {}) => call({ path: '/api/v1/catalog/providers', signal }), get: one('providers', "provider's slug") },
        plans: { list: list('plans'), get: one('plans', "plan's id") },
        promos: { list: ({ signal } = {}) => call({ path: '/api/v1/catalog/promos', signal }) },
        offers: { list: list('offers') },
        domains: {
            /** Domain endings and their prices. */
            list: list('domains'),
            /** One ending (without the dot) with every registrar's register, renew and transfer price. */
            tld: one('domains', 'domain ending'),
            /** Is a name registered? (RDAP; rate-limited per address.) */
            check: (name, { signal } = {}) => {
                if (!name || typeof name !== 'string' || !name.includes('.')) throw new TypeError('host.domains.check: a domain name');
                return call({ path: '/api/v1/catalog/domains/check', query: { name }, signal });
            },
        },
        benchmarks: { list: list('benchmarks'), get: one('benchmarks', "benchmark's id") },
    };
}

module.exports = { createHostClient };
