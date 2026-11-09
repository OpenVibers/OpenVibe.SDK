'use strict';

const REPORT_URL = 'https://openvibe.report';
function createReportClient(client, { baseUrl = REPORT_URL } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createReportClient: pass an openvibe-sdk/core client');
    const call = (path, query, signal) => client.json({ baseUrl, path, query, signal, service: 'report' });
    return { ai: {
        leaderboard(opts = {}, { signal } = {}) { return call('/api/v1/ai/leaderboard', opts, signal); },
        model(id, { signal } = {}) { if (!id) throw new TypeError('report.ai.model: id is required'); return call(`/api/v1/ai/models/${encodeURIComponent(id)}`, null, signal); },
        providers({ signal } = {}) { return call('/api/v1/ai/providers', null, signal); },
        compare(ids, { signal } = {}) { const models = (Array.isArray(ids) ? ids : [ids]).map(String).join(','); return call('/api/v1/ai/compare', { models }, signal); },
        picks({ signal } = {}) { return call('/api/v1/ai/picks', null, signal); },
    } };
}
module.exports = { createReportClient, REPORT_URL };
