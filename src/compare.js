'use strict';
/**
 * openvibe-sdk/compare: OpenVibe.Compare's JSON API and streamed open dataset. Browser-safe.
 *
 * Bench's whole API is mounted inside Compare (plan §X, 11-13: the cutover moved the vhosts and Compare answers
 * Bench's API at https://openvibe.compare/api/v1/…), so this is the client the bench entry was, renamed in one
 * clean cut: no alias, no second entry. The origin moves with it; the API's own audience does not (the service
 * tokens the API inside Compare accepts are still verified for openvibe.bench).
 */
const { isActingSubjectId } = require('./core/ids');
const { OpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;
const path = (part, id) => `/api/v1/${part}/${enc(id)}`;
/** Compare's origin: Bench's API answers here since the 11-13 cutover. */
const DEFAULT_BASE = 'https://openvibe.compare';
/** The audience the API inside Compare verifies service tokens for (Bench's own audience, unchanged by the cut). */
const AUDIENCE = 'openvibe.bench';

/** The origin this client talks to: what the caller set, else the shared client's compare origin, else Compare's own. */
function originOf(client, defaults) {
    if (defaults.baseUrl) return defaults.baseUrl;
    const cfg = client && client.options;
    const urls = cfg && cfg.baseUrls;
    if (urls && urls.compare) return urls.compare;
    return DEFAULT_BASE;
}

function createCompareClient(client, defaults = {}) {
    function options(opts = {}, perCall = {}) {
        const acting = opts.auth === false ? null : perCall.actingSubject !== undefined ? perCall.actingSubject : defaults.actingSubject;
        const headers = { ...opts.headers };
        if (acting) {
            if (!isActingSubjectId(acting)) throw new TypeError('actingSubject must be a usr_… or gst_… subject id');
            headers['X-OV-Subject'] = acting;
        }
        return { service: 'compare', baseUrl: originOf(client, defaults), audience: AUDIENCE, ...opts, headers, signal: perCall.signal };
    }
    const json = (opts, perCall) => client.json(options(opts, perCall));
    const post = (route, body, o) => json({ method: 'POST', path: route, json: body }, o);
    const datasetPath = (kind) => `${path('datasets', kind)}.jsonl`;

    return {
        kinds: {
            list: (o = {}) => json({ path: '/api/v1/kinds' }, o),
            get: (kind, o = {}) => json({ path: path('kinds', kind) }, o),
        },
        tasks: {
            create: (kind, task, o = {}) => post(`${path('kinds', kind)}/tasks`, task, o),
            get: (id, o = {}) => json({ path: path('tasks', id) }, o),
        },
        rounds: {
            create: (taskId, round, o = {}) => post(`${path('tasks', taskId)}/rounds`, round, o),
            get: (id, o = {}) => json({ path: path('rounds', id) }, o),
        },
        entries: {
            submit: (roundId, entry, o = {}) => post(`${path('rounds', roundId)}/entries`, entry, o),
        },
        judgements: {
            next: ({ kind, ...o } = {}) => json({ path: '/api/v1/judgements/next', query: { kind } }, o),
            cast: (roundId, judgement, o = {}) => post(`${path('rounds', roundId)}/judgements`, judgement, o),
        },
        boards: {
            get: (kind, { type, category, period, ...o } = {}) => json({ path: path('boards', kind), query: { type, category, period } }, o),
        },
        ratings: {
            get(kind, { category, signal } = {}) {
                if (typeof kind !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(kind)) throw new TypeError('Use a kind id');
                if (category !== undefined && (typeof category !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(category))) throw new TypeError('Use a task category of at most 80 characters');
                return json({ method: 'GET', auth: false, path: path('ratings', kind), query: { category } }, { signal });
            },
        },
        models: {
            get: (model, o = {}) => json({ path: path('models', model) }, o),
        },
        datasets: {
            get: (kind, o = {}) => client.json(options({ path: datasetPath(kind), responseType: 'text' }, o)),
            async iterate(kind, onLine, o = {}) {
                if (typeof onLine !== 'function') throw new TypeError('onLine must be a function');
                const { response } = await client.request(options({ path: datasetPath(kind), responseType: 'response' }, o));
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let pending = '';
                let line = 0;
                const emit = async (s) => {
                    if (s.endsWith('\r')) s = s.slice(0, -1);
                    if (!s.trim()) return;
                    line++;
                    let value;
                    try { value = JSON.parse(s); }
                    catch (cause) { throw new OpenVibeError({ code: 'sdk.bad_response', message: `Compare dataset has invalid JSON at line ${line}`, cause }); }
                    await onLine(value);
                };
                try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        pending += decoder.decode(value, { stream: true });
                        let pos;
                        while ((pos = pending.indexOf('\n')) !== -1) {
                            await emit(pending.slice(0, pos));
                            pending = pending.slice(pos + 1);
                        }
                    }
                    pending += decoder.decode();
                    await emit(pending);
                } finally { reader.releaseLock(); }
            },
        },
        evals: {
            create: (evaluation, o = {}) => post('/api/v1/evals', evaluation, o),
            get: (id, o = {}) => json({ path: path('evals', id) }, o),
            run: (id, run, o = {}) => post(`${path('evals', id)}/run`, run, o),
            results: (id, o = {}) => json({ path: `${path('evals', id)}/results` }, o),
        },
        async mcpTools(o = {}) {
            const data = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, o);
            if (data && data.error) throw new OpenVibeError({ code: 'sdk.bad_response', message: data.error.message || 'Compare MCP tools/list failed', detail: data.error.message });
            if (!data || !data.result || !Array.isArray(data.result.tools)) throw new OpenVibeError({ code: 'sdk.bad_response', message: 'Compare MCP tools/list returned no tools' });
            return data.result.tools;
        },
    };
}

module.exports = { createCompareClient };
