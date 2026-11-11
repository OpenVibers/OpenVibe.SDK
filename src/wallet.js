'use strict';

/** Personal bearer wallet/store facade. Amounts and ownership are enforced by their ledger services. */
function createWalletClient(client, { billingUrl, inventoryUrl, networkUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createWalletClient requires an SDK core client');
    const urls = { billing: billingUrl, inventory: inventoryUrl, network: networkUrl };
    const call = (service, path, opts = {}) => client.json({ service, baseUrl: urls[service],
        audience: `openvibe.${service}`, path, credentials: 'omit', ...opts });
    const key = (v) => {
        if (typeof v !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(v)) throw new TypeError('An idempotency_key of 8–128 letters, digits, dot, colon, underscore or dash is required');
        return v;
    };
    const whole = (v) => { if (!Number.isSafeInteger(v) || v < 1) throw new TypeError('Choose a positive whole amount'); return v; };
    const itemId = (v) => { if (!/^itd_[0-9A-HJKMNP-TV-Z]{26}$/.test(v || '')) throw new TypeError('An item id is an itd_ id'); return encodeURIComponent(v); };
    const cursor = (v) => { if (v != null && !/^[0-9]+$/.test(String(v))) throw new TypeError('cursor is a move id'); return v; };
    const streamer = (v) => { if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError('streamer is a positive user id'); return v; };
    // The BODY key is durable in both services. Retries keep it; the SDK must not add an unrelated header key.
    const write = (service, path, json, { signal } = {}) => call(service, path, { method: 'POST', json,
        idempotencyKey: false, idempotent: true, signal });
    return {
        wallet: {
            get: ({ signal } = {}) => call('billing', '/api/v1/me/wallet', { signal }),
            changes: ({ since_vibes, since_opencoins, since_channel_points, streamer: channel, limit, signal } = {}) => {
                if (limit != null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) throw new TypeError('limit is 1 to 500');
                return call('network', '/api/wallet/changes', { query: {
                    since_vibes: cursor(since_vibes), since_opencoins: cursor(since_opencoins),
                    since_channel_points: cursor(since_channel_points),
                    streamer: channel == null ? undefined : streamer(channel), limit,
                }, signal });
            },
            markRead: ({ currency, cursor: at, streamer: channel }, { signal } = {}) => {
                if (!['vibes', 'opencoins', 'channel-points'].includes(currency)) throw new TypeError('currency is vibes, opencoins or channel-points');
                if (at == null) throw new TypeError('cursor is required');
                if (currency === 'channel-points' && channel == null) throw new TypeError('streamer is required for channel points');
                return call('network', '/api/wallet/changes/read', { method: 'PUT', json: {
                    currency, cursor: cursor(at), ...(currency === 'channel-points' ? { streamer: streamer(channel) } : {}),
                }, signal });
            },
            topUp: ({ provider, amount_cents, idempotency_key }, options) => write('billing', '/api/v1/me/wallet/topups',
                { provider, amount_cents: whole(amount_cents), idempotency_key: key(idempotency_key) }, options),
        },
        vibes: {
            buy: ({ provider, vibes, idempotency_key }, options) => write('billing', '/api/v1/me/vibes/buy',
                { provider, vibes: whole(vibes), idempotency_key: key(idempotency_key) }, options),
        },
        store: {
            list: ({ signal } = {}) => call('inventory', '/api/v1/store', { signal }),
            buy: (id, { currency, idempotency_key }, options) => {
                if (!['coins', 'vibes'].includes(currency)) throw new TypeError('currency is coins or vibes');
                return write('inventory', `/api/v1/store/${itemId(id)}/buy`, { currency, idempotency_key: key(idempotency_key) }, options);
            },
            submit: (id, prices, { signal } = {}) => call('inventory', `/api/v1/store/${itemId(id)}/list`,
                { method: 'POST', json: { prices }, idempotencyKey: false, retries: 0, signal }),
        },
        items: {
            list: ({ cursor, limit, kind, signal } = {}) => call('inventory', '/api/v1/me/items', { query: { cursor, limit, kind }, signal }),
            equip: ({ kind, slot, instance_id }, { signal } = {}) => {
                if (instance_id !== null && !/^inv_[0-9A-HJKMNP-TV-Z]{26}$/.test(instance_id || '')) throw new TypeError('instance_id is an inv_ id, or null to unequip');
                return call('inventory', '/api/v1/me/equipped', { method: 'PUT', json: { kind, slot, instance_id }, signal });
            },
        },
    };
}

module.exports = { createWalletClient };
