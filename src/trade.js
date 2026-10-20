'use strict';
/**
 * openvibe-sdk/trade — OpenVibe.Trade for apps: instruments with their sourced observations and filings, the sources'
 * freshness (public), and, for the person who authorized the app, their watchlists and alert rules. Routes at
 * https://openvibe.trade/api/v1; tokens for audience openvibe.trade. An app acts only for its on_behalf_of person.
 * Trade states what sources said, with times; it gives no advice.
 *
 *   const trade = createTradeClient(createClient({ tokenProvider }));
 *   const { instrument } = await trade.instruments.resolve('AAPL');                  // CIK, ticker, exact name
 *   const obs = await trade.instruments.observations('AAPL', { metric: 'price', limit: 30 });
 *   const { watchlist } = await trade.watchlists.create({ name: 'Robots' });
 *   await trade.watchlists.add(watchlist.id, 'AAPL');
 *   await trade.alerts.create({ symbol: 'AAPL', kind: 'filing_type', form_types: ['8-K'] });
 *
 * Capabilities (public since openvibe-contracts 0.208.0): trade.instrument.resolve, trade.watchlist.create, .read,
 * .update and .delete, trade.alert.create, .read and .delete. A person's watchlists and alerts are theirs alone
 * (another person's is 404). Creating a watchlist or an alert is never retried on its own. Alerts are delivered as
 * trade.alert.triggered events, never by email.
 */
const enc = encodeURIComponent;
const ALERT_KINDS = ['threshold', 'filing_type', 'new_document'];

function createTradeClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createTradeClient: pass an openvibe-sdk/core client');
    const at = { service: 'trade', baseUrl, audience: 'openvibe.trade' };
    const call = (opts) => client.json({ ...at, ...opts });
    const sym = (s) => {
        if (!s || typeof s !== 'string') throw new TypeError("trade: an instrument's symbol");
        return enc(s);
    };
    const list = (id, rest = '') => {
        if (!id || typeof id !== 'string') throw new TypeError("trade: a watchlist's id");
        return `/api/v1/watchlists/${enc(id)}${rest}`;
    };

    return {
        instruments: {
            /** A ticker, SEC CIK or exact company name → the instrument (several name matches are "ambiguous"). */
            resolve: (q, { kind, signal } = {}) => call({ path: '/api/v1/instruments/resolve', query: { q, kind }, signal }),
            list: ({ limit, offset, signal } = {}) => call({ path: '/api/v1/instruments', query: { limit, offset }, signal }),
            get: (symbol, { signal } = {}) => call({ path: `/api/v1/instruments/${sym(symbol)}`, signal }),
            /** History with freshness, for one metric or all. */
            observations: (symbol, { metric, before, limit, signal } = {}) => call({ path: `/api/v1/instruments/${sym(symbol)}/observations`, query: { metric, before, limit }, signal }),
            documents: (symbol, { limit, offset, signal } = {}) => call({ path: `/api/v1/instruments/${sym(symbol)}/documents`, query: { limit, offset }, signal }),
        },
        /** Every source and how fresh it is. */
        sources: ({ signal } = {}) => call({ path: '/api/v1/sources', signal }),
        watchlists: {
            list: ({ signal } = {}) => call({ path: '/api/v1/watchlists', signal }),
            get: (id, { signal } = {}) => call({ path: list(id), signal }),
            create: ({ name } = {}, { signal } = {}) => {
                if (!name || typeof name !== 'string') throw new TypeError('trade.watchlists.create: a name');
                return call({ method: 'POST', path: '/api/v1/watchlists', json: { name }, idempotencyKey: false, signal });
            },
            rename: (id, name, { signal } = {}) => call({ method: 'PATCH', path: list(id), json: { name }, idempotent: true, signal }),
            add: (id, symbol, { signal } = {}) => call({ method: 'PUT', path: list(id, `/items/${sym(symbol)}`), signal }),
            removeItem: (id, symbol, { signal } = {}) => call({ method: 'DELETE', path: list(id, `/items/${sym(symbol)}`), signal }),
            remove: (id, { signal } = {}) => call({ method: 'DELETE', path: list(id), signal }),
        },
        alerts: {
            list: ({ signal } = {}) => call({ path: '/api/v1/alerts', signal }),
            deliveries: ({ limit, signal } = {}) => call({ path: '/api/v1/alerts/deliveries', query: { limit }, signal }),
            /** threshold (metric, operator, threshold, unit), filing_type (form_types) or new_document, for a symbol. */
            create: (rule, { signal } = {}) => {
                if (!rule || !rule.symbol || !ALERT_KINDS.includes(rule.kind)) throw new TypeError(`trade.alerts.create: a symbol and kind (${ALERT_KINDS.join(', ')})`);
                return call({ method: 'POST', path: '/api/v1/alerts', json: rule, idempotencyKey: false, signal });
            },
            remove: (id, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/alerts/${enc(String(id))}`, signal }),
        },
    };
}

module.exports = { createTradeClient };
