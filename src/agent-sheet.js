'use strict';
/** Owner-only agent sheets through Network's fixed cross-site relay. The caller supplies their own Bearer. */
const ACTOR = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEMORY = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;
const CODES = /^[a-z][a-z0-9-]{0,63}$/;

function createAgentSheetClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createAgentSheetClient: pass an SDK core client');
    const id = (value, pattern, kind) => {
        if (!pattern.test(String(value || ''))) throw new TypeError(`invalid ${kind} id`);
        return String(value);
    };
    const path = (agent) => `/api/frame/agents/${id(agent, ACTOR, 'Actor agent')}`;
    const call = (opts) => client.json({ service: 'network', audience: 'openvibe.network', baseUrl, ...opts });
    return {
        sheet: (agent, { signal } = {}) => call({ path: `${path(agent)}/sheet`, signal }),
        codesSheet: (agent, { signal } = {}) => call({ path: `/api/frame/codes-agents/${id(agent, CODES, 'coding agent')}/sheet`, signal }),
        pause: (agent, { signal } = {}) => call({ method: 'PATCH', path: path(agent), json: { status: 'paused' }, signal, idempotent: true }),
        resume: (agent, { signal } = {}) => call({ method: 'PATCH', path: path(agent), json: { status: 'active' }, signal, idempotent: true }),
        memory: {
            add: (agent, text, { signal } = {}) => call({ method: 'POST', path: `${path(agent)}/memory`, json: { text }, signal, idempotent: false }),
            update: (agent, note, text, { signal } = {}) => call({ method: 'PATCH', path: `${path(agent)}/memory/${id(note, MEMORY, 'memory')}`, json: { text }, signal, idempotent: true }),
            remove: (agent, note, { signal } = {}) => call({ method: 'DELETE', path: `${path(agent)}/memory/${id(note, MEMORY, 'memory')}`, signal, idempotent: true }),
        },
    };
}

module.exports = { createAgentSheetClient };
