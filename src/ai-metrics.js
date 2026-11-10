'use strict';
// Public measured reads: no bearer token, prompt, person or site identifiers.
function createMetricsClient(call) {
    const root = '/api/v1/exchange/metrics';
    const read = (path, query, opts) => call({ method: 'GET', path: root + path, query, auth: false }, opts);
    const model = (value) => {
        if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(value)) throw new TypeError('metrics: use a catalogue model slug');
        return encodeURIComponent(value);
    };
    return {
        status: (opts = {}) => read('/status', undefined, opts),
        model: (id, query = {}, opts = {}) => read(`/models/${model(id)}`, query, opts),
        compare(query, opts = {}) {
            if (!query || !Array.isArray(query.models) || query.models.length < 1 || query.models.length > 6) throw new TypeError('metrics.compare: choose one to six models');
            query.models.forEach(model);
            return read('/compare', { ...query, models: query.models.join(','), measures: query.measures?.join(',') }, opts);
        },
        leaderboard: (query = {}, opts = {}) => read('/leaderboard', query, opts),
        prices: (id, query = {}, opts = {}) => read(`/prices/${model(id)}`, query, opts),
        providerHealth(provider, opts = {}) {
            if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(provider)) throw new TypeError('metrics.providerHealth: invalid provider');
            return read(`/providers/${encodeURIComponent(provider)}`, undefined, opts);
        },
    };
}
module.exports = { createMetricsClient };
