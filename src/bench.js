'use strict';
/** openvibe-sdk/bench: OpenVibe.Bench's JSON API and streamed open dataset. Browser-safe. */
const { isActingSubjectId } = require('./core/ids');
const { OpenVibeError } = require('./core/errors');

const enc = encodeURIComponent;
const path = (part, id) => `/api/v1/${part}/${enc(id)}`;

function createBenchClient(client, defaults = {}) {
    function options(opts = {}, perCall = {}) {
        const acting = perCall.actingSubject !== undefined ? perCall.actingSubject : defaults.actingSubject;
        const headers = { ...opts.headers };
        if (acting) {
            if (!isActingSubjectId(acting)) throw new TypeError('actingSubject must be a usr_… or gst_… subject id');
            headers['X-OV-Subject'] = acting;
        }
        return { service: 'bench', baseUrl: defaults.baseUrl, audience: 'openvibe.bench', ...opts, headers, signal: perCall.signal };
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
                    catch (cause) { throw new OpenVibeError({ code: 'sdk.bad_response', message: `Bench dataset has invalid JSON at line ${line}`, cause }); }
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
            if (data && data.error) throw new OpenVibeError({ code: 'sdk.bad_response', message: data.error.message || 'Bench MCP tools/list failed', detail: data.error.message });
            if (!data || !data.result || !Array.isArray(data.result.tools)) throw new OpenVibeError({ code: 'sdk.bad_response', message: 'Bench MCP tools/list returned no tools' });
            return data.result.tools;
        },
    };
}

module.exports = { createBenchClient };
