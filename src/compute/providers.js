'use strict';
const { createHash } = require('node:crypto');
const enc = encodeURIComponent;

/** Provider errors intentionally exclude response bodies (which can contain credentials/user-data). */
async function json(fetch, url, { method = 'GET', headers = {}, body } = {}) {
    const r = await fetch(url, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`provider HTTP ${r.status}`);
    return r.status === 204 ? {} : r.json();
}
const positive = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const quote = (provider, id, region, hourly, currency, ram_mb, extra = {}) => ({ provider, id: String(id), region,
    hourly: positive(hourly) ? Number(hourly) : null, currency, ram_mb: Number(ram_mb) || 0, gpu_mb: 0,
    setup: 0, billing_seconds: 3600, tier: 'partner', ...extra });
function createProviders({ fetch: fetchImpl = globalThis.fetch, config = {}, now = Date.now } = {}) {
    const call = (url, opts) => json(fetchImpl, url, opts);
    const c = (name) => config[name] || {};
    function keyed(name) { if (!c(name).key) throw new Error(`${name}: key required`); }
    const bearer = (name) => c(name).key ? { Authorization: `Bearer ${c(name).key}` } : {};
    const hc = 'https://api.hetzner.cloud/v1';
    const ovh = 'https://eu.api.ovh.com/1.0';
    async function ovhCall(path, method = 'GET', body) {
        const v = c('ovh');
        if (!v.key || !v.application_secret || !v.consumer_key) throw new Error('ovh: application and consumer credentials required');
        const url = ovh + path;
        const timestamp = String(await call(ovh + '/auth/time'));
        const signature = '$1$' + createHash('sha1').update([v.application_secret, v.consumer_key, method, url, body ? JSON.stringify(body) : '', timestamp].join('+')).digest('hex');
        return call(url, { method, body, headers: { 'X-Ovh-Application': v.key, 'X-Ovh-Consumer': v.consumer_key, 'X-Ovh-Timestamp': timestamp, 'X-Ovh-Signature': signature } });
    }
    const providers = {
        hetzner: {
            async quote() {
                // Cloud catalogue requires an API token; no scraped price is substituted.
                keyed('hetzner');
                const r = await call(hc + '/server_types?per_page=50', { headers: bearer('hetzner') });
                return (r.server_types || []).flatMap((s) => (s.prices || []).map((p) => quote('hetzner', s.name, p.location, p.price_hourly.gross, 'EUR', s.memory * 1024,
                    { tier: 'dedicated', cpu: s.cores, source: hc + '/server_types', included_traffic: p.included_traffic, egress_hourly: null })));
            },
            async provision(q, spec) {
                keyed('hetzner');
                if (!spec.image) throw new Error('hetzner: prepared Link image required');
                const r = await call(hc + '/servers', { method: 'POST', headers: bearer('hetzner'), body: { name: spec.label, server_type: q.id, location: q.region,
                    image: spec.image, start_after_create: true, public_net: { enable_ipv4: false, enable_ipv6: true }, labels: { 'openvibe-broker': spec.label } } });
                return { id: String(r.server.id) };
            },
            async health(id) { const r = await call(hc + '/servers/' + enc(id), { headers: bearer('hetzner') }); return r ? { state: r.server.status, deleted: false } : { deleted: true }; },
            async release(id) { keyed('hetzner'); await call(hc + '/servers/' + enc(id), { method: 'DELETE', headers: bearer('hetzner') }); },
        },
        'hetzner-auction': {
            async quote() {
                const url = 'https://www.hetzner.com/_resources/app/data/app/live_data_sb_EUR.json';
                const r = await call(url);
                return (r.server || []).map((s) => quote('hetzner-auction', s.id, s.datacenter, s.price / 730, 'EUR', s.ram_size * 1024,
                    { tier: 'dedicated', monthly: s.price, source: url, provisionable: false, reason: 'dedicated purchase requires reviewed cancellation and setup terms' }));
            },
            async provision() { throw new Error('auction: quote only; dedicated purchase and cancellation terms require review'); },
            async health() { return { state: 'quote-only' }; },
            async release() { throw new Error('auction: no broker-owned purchase'); },
        },
        ovh: {
            async quote() {
                const url = ovh + '/order/catalog/public/cloud?ovhSubsidiary=US';
                const catalog = await call(url);
                // Pricing is a public catalogue. Resource/region fit requires the account's flavor catalogue.
                if (!c('ovh').project || !c('ovh').key) return [];
                const flavors = await ovhCall('/cloud/project/' + enc(c('ovh').project) + '/flavor');
                return flavors.flatMap((f) => {
                    const plan = (catalog.plans || []).find((p) => p.planCode === f.planCodes?.hourly);
                    const price = plan?.pricings?.find((p) => p.interval === 1 && p.mode === 'default');
                    if (!price) return [];
                    return [quote('ovh', f.id, f.region, price.price / 1e8, catalog.locale?.currencyCode || 'USD', f.ram * 1024,
                        { tier: 'dedicated', cpu: f.vcpus, source: url })];
                });
            },
            async provision(q, spec) {
                keyed('ovh'); if (!spec.image) throw new Error('ovh: prepared Link image required');
                const r = await ovhCall('/cloud/project/' + enc(c('ovh').project) + '/instance', 'POST', { name: spec.label, flavorId: q.id, region: q.region, imageId: spec.image, monthlyBilling: false });
                return { id: r.id };
            },
            async health(id) { const r = await ovhCall('/cloud/project/' + enc(c('ovh').project) + '/instance/' + enc(id)); return r ? { state: r.status, deleted: false } : { deleted: true }; },
            async release(id) { await ovhCall('/cloud/project/' + enc(c('ovh').project) + '/instance/' + enc(id), 'DELETE'); },
        },
        vast: {
            async quote(req = {}) {
                const url = 'https://console.vast.ai/api/v0/bundles/';
                const r = await call(url, { method: 'POST', headers: bearer('vast'), body: { type: 'ondemand', rentable: { eq: true }, verified: { eq: true }, gpu_ram: { gte: req.gpu_mb || 1 }, limit: 100 } });
                return (r.offers || []).map((s) => quote('vast', s.id, s.geolocation, s.dph_total, 'USD', s.cpu_ram,
                    { gpu_mb: s.gpu_ram * s.num_gpus, gpu: s.gpu_name, billing_seconds: 1, source: url, tier: 'partner', disk_hourly: s.storage_cost, egress_hourly: null }));
            },
            async provision(q, spec) {
                keyed('vast'); if (!spec.image) throw new Error('vast: image required');
                const r = await call('https://console.vast.ai/api/v0/asks/' + enc(q.id) + '/', { method: 'PUT', headers: bearer('vast'), body: { image: spec.image, label: spec.label, disk: spec.disk_gb || 20, runtype: 'args', args: spec.command || '' } });
                if (!r?.new_contract) throw new Error('vast: create outcome unknown');
                return { id: String(r.new_contract) };
            },
            async health(id) { const r = await call('https://console.vast.ai/api/v0/instances/' + enc(id) + '/', { headers: bearer('vast') }); return r ? { state: (r.instances || r).actual_status, deleted: false } : { deleted: true }; },
            async release(id) { keyed('vast'); await call('https://console.vast.ai/api/v0/instances/' + enc(id) + '/', { method: 'DELETE', headers: bearer('vast') }); },
        },
        runpod: {
            async quote() {
                const url = 'https://api.runpod.io/graphql';
                const r = await call(url, { method: 'POST', body: { query: '{ gpuTypes { id displayName memoryInGb securePrice communityPrice } }' } });
                if (r.errors) throw new Error('runpod: price catalogue unavailable');
                return (r.data?.gpuTypes || []).map((s) => quote('runpod', s.id, 'any', s.securePrice, 'USD', 0,
                    { gpu_mb: s.memoryInGb * 1024, gpu: s.displayName, billing_seconds: 1, source: url, egress_hourly: null }));
            },
            async provision(q, spec) {
                keyed('runpod'); if (!spec.image) throw new Error('runpod: image required');
                const r = await call('https://rest.runpod.io/v1/pods', { method: 'POST', headers: bearer('runpod'), body: { name: spec.label, imageName: spec.image, gpuTypeIds: [q.id], gpuCount: 1,
                    cloudType: 'SECURE', containerDiskInGb: spec.disk_gb || 20, volumeInGb: 0, ...(spec.command ? { dockerStartCmd: spec.command } : {}) } });
                if (!r?.id) throw new Error('runpod: create outcome unknown');
                return { id: r.id };
            },
            async health(id) { const r = await call('https://rest.runpod.io/v1/pods/' + enc(id), { headers: bearer('runpod') }); return r ? { state: r.desiredStatus, deleted: false } : { deleted: true }; },
            async release(id) { keyed('runpod'); await call('https://rest.runpod.io/v1/pods/' + enc(id), { method: 'DELETE', headers: bearer('runpod') }); },
        },
        community: {
            async quote() {
                const url = 'https://ai.openvibe.services/api/v1/community/offers';
                const r = await call(url);
                return (r.offers || []).map((s) => quote('community', s.id || s.offer_id, s.region || 'unknown', s.price_per_hour, 'USD', s.ram_mb,
                    { tier: 'community', gpu_mb: s.gpu_ram_mb || 0, source: url, provisionable: false, reason: 'inference offers are token-priced; not a machine rental' }));
            },
            async provision() { throw new Error('community: use the existing AI offer router or Bot desk lease'); },
            async health() { return { state: 'offer' }; },
            async release() { throw new Error('community: no broker-owned machine'); },
        },
    };
    // Quotes have short leases. Provisioners must re-quote before taking a reservation.
    for (const [name, p] of Object.entries(providers)) {
        const read = p.quote;
        p.quote = async (...args) => (await read(...args)).map((q) => ({ ...q, quoted_at: now(), expires_at: now() + 60000 }));
        p.id = name;
        p.configured = Boolean(c(name).key);
    }
    return providers;
}
module.exports = { createProviders };
