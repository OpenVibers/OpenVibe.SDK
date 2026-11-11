'use strict';
/** Agent run snapshots, AG-UI event streams and approval responses. */
const { OpenVibeError, isOpenVibeError } = require('./core/errors');
const { parseSSE } = require('./realtime');
const enc = encodeURIComponent;
const pause = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
function createAgentsClient(client, { baseUrl, service = 'network', audience = 'openvibe.network' } = {}) {
    const call = (opts) => client.request({ service, baseUrl, audience, ...opts });
    async function run(id, { signal } = {}) {
        if (!id) throw new TypeError('agents.run: id is required');
        try { return (await call({ path: `/api/v1/runs/${enc(id)}`, signal })).data; }
        catch (err) { if (isOpenVibeError(err) && err.status === 404) return null; throw err; }
    }
    async function post(id, approval, { signal } = {}) {
        if (!id) throw new TypeError('agents.post: id is required');
        if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new TypeError('agents.post: approval must be an object');
        return (await call({ method: 'POST', path: `/api/v1/runs/${enc(id)}/approvals`, json: approval, signal })).data;
    }
    async function* events(id, { lastEventId = 0, signal, maxReconnects = 20, reconnectDelayMs = 1000 } = {}) {
        if (!id) throw new TypeError('agents.events: id is required');
        let last = String(lastEventId || '0'), failures = 0, serverRetryMs = 0;
        while (!(signal && signal.aborted)) {
            let delivered = false;
            try {
                const res = await call({ path: `/api/v1/runs/${enc(id)}/events`, responseType: 'response', retries: 0, signal,
                    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': last } });
                if (res.status === 204) return;
                for await (const msg of parseSSE(res.data.body, { onRetry: (ms) => { serverRetryMs = ms; } })) {
                    if (msg.id !== undefined && msg.id !== '') { if (/^\d+$/.test(msg.id) && Number(msg.id) <= Number(last)) continue; last = msg.id; }
                    let data; try { data = JSON.parse(msg.data); } catch { data = null; }
                    delivered = true; failures = 0;
                    yield { id: msg.id ?? null, event: msg.event || (data && data.type) || null, data };
                    if (data && ['RUN_FINISHED', 'RUN_ERROR'].includes(data.type)) return;
                }
            } catch (err) {
                if (signal && signal.aborted) return;
                if (isOpenVibeError(err) && err.status >= 400 && err.status < 500) throw err;
                if (!isOpenVibeError(err) && !['TypeError', 'AbortError'].includes(err && err.name)) throw err;
            }
            failures = delivered ? 0 : failures + 1;
            if (failures > maxReconnects) throw new OpenVibeError({ code: 'sdk.network_error', retryable: true, message: `agents: event stream ${id} failed ${failures} times in a row` });
            const backoffMs = Math.min(reconnectDelayMs * (2 ** Math.max(0, failures - 1)), 30000);
            const waitMs = Math.min(Math.max(backoffMs, serverRetryMs), 30000);
            await pause(waitMs, signal);
        }
    }
    return { run, events, post };
}
module.exports = { createAgentsClient };
