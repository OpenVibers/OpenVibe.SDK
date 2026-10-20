'use strict';
/**
 * openvibe-sdk/actor — OpenVibe.Actor for apps: hand a task to an AI agent system and follow it, and keep a person's
 * own agents (standing instructions, a schedule, a budget per run, what they remember). Routes at
 * https://openvibe.actor/api/v1; tokens for audience openvibe.actor.
 *
 *   const actor = createActorClient(createClient({ tokenProvider }));
 *   const { agents } = await actor.agents.list();                                          // the agent systems (public)
 *   const plan = await actor.route({ task: 'Summarize this repo', mode: 'cheapest' });     // dry run: which agent, what cost
 *   const task = await actor.tasks.create({ task: 'Summarize …', idempotency_key: 'job-42' });
 *   for await (const e of actor.tasks.events(task.id)) console.log(e.event, e.data);      // until the task ends
 *   const mine = await actor.me.agents.create({ name: 'Morning brief', instructions: '…' });
 *   await actor.me.agents.run(mine.id, { input: 'today' });
 *   await actor.me.agents.memory.add(mine.id, 'I live in Portland');
 *
 * A task is its requester's own (actor.task-create-request@1: task, mode, budget, agent, idempotency_key, webhooks).
 * When it names webhooks, the answer that creates it carries webhook_secret, once. tasks.create is retried only when
 * the body has an idempotency_key (Actor answers a repeat with the first task); the other writes are never retried on
 * their own. A person's agents need the person's own token (an app's or another person's is 404).
 * Errors are OpenVibeError: actor.task.invalid, actor.budget.over_tier, actor.idempotency.conflict (409),
 * actor.webhook.refused, actor.agent.invalid, actor.agent.limit (429), actor.agent.not_found, actor.task.not_found, …
 */
const { parseSSE } = require('./realtime');

const enc = encodeURIComponent;
const ID_RE = {   // Actor's own rules
    task: /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/,
    agent: /^agt_[0-9A-HJKMNP-TV-Z]{26}$/,
    memory: /^mem_[0-9A-HJKMNP-TV-Z]{26}$/,
};

function createActorClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function' || typeof client.request !== 'function') throw new TypeError('createActorClient: pass an openvibe-sdk/core client');
    const at = { service: 'actor', baseUrl, audience: 'openvibe.actor' };
    const call = (opts) => client.json({ ...at, ...opts });
    const once = (opts) => call({ ...opts, idempotencyKey: false });
    const id = (kind, v) => {
        if (!ID_RE[kind].test(String(v || ''))) throw new TypeError(`actor: a${kind === 'agent' ? 'n' : ''} ${kind} id is ${ID_RE[kind].source.slice(1, 5)}…`);
        return enc(String(v));
    };
    const agentPath = (agent, rest = '') => `/api/v1/me/agents/${id('agent', agent)}${rest}`;

    /**
     * A task's events as they happen (SSE: { id, event, data }), the backlog after lastEventId first; it ends when
     * Actor closes the stream after the task's last event. Pass the last id back as lastEventId to pick up again.
     */
    async function* events(taskId, { lastEventId = 0, signal } = {}) {
        const res = await client.request({
            ...at, path: `/api/v1/tasks/${id('task', taskId)}/events`, responseType: 'response', retries: 0, signal,
            headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': String(Number(lastEventId) || 0) },
        });
        for await (const msg of parseSSE(res.data.body)) {
            let data = null;
            try { data = JSON.parse(msg.data); } catch { data = msg.data; }
            const n = Number(msg.id);
            yield { id: Number.isFinite(n) && msg.id !== undefined && msg.id !== '' ? n : null, event: msg.event, data };
        }
    }

    return {
        agents: {
            /** The agent systems a task can go to, with what they are good at and cost (public). */
            list: ({ signal } = {}) => call({ path: '/api/v1/agents', signal }),
        },
        /** A dry run (public): the task's class and the agent and budget Actor would pick, nothing started. */
        route: ({ task, mode, agent } = {}, { signal } = {}) => call({ method: 'POST', path: '/api/v1/route', json: { task, mode, agent }, idempotent: true, signal }),
        tasks: {
            /** Start a task (201, or 200 for an idempotent repeat) → the task (platform.task@1). */
            create: (body, { signal } = {}) => {
                if (!body || typeof body.task !== 'string' || !body.task.trim()) throw new TypeError('actor.tasks.create: task is the instruction in plain words');
                return body.idempotency_key ? call({ method: 'POST', path: '/api/v1/tasks', json: body, idempotent: true, signal }) : once({ method: 'POST', path: '/api/v1/tasks', json: body, signal });
            },
            list: ({ limit, before, signal } = {}) => call({ path: '/api/v1/tasks', query: { limit, before }, signal }),
            get: (taskId, { signal } = {}) => call({ path: `/api/v1/tasks/${id('task', taskId)}`, signal }),
            /** Ask a task to stop (202 while it winds down, 200 once ended); asking twice is harmless. */
            cancel: (taskId, { signal } = {}) => call({ method: 'POST', path: `/api/v1/tasks/${id('task', taskId)}/cancel`, idempotent: true, signal }),
            events,
        },
        me: {
            agents: {
                list: ({ signal } = {}) => call({ path: '/api/v1/me/agents', signal }),
                /** A personal agent: name, instructions, mode, budget_per_run_usd, daily_runs_max, schedule, … */
                create: (agent, { signal } = {}) => once({ method: 'POST', path: '/api/v1/me/agents', json: agent, signal }),
                get: (agent, { signal } = {}) => call({ path: agentPath(agent), signal }),
                update: (agent, patch, { signal } = {}) => call({ method: 'PATCH', path: agentPath(agent), json: patch, idempotent: true, signal }),
                remove: (agent, { signal } = {}) => call({ method: 'DELETE', path: agentPath(agent), signal }),
                /** Run it now with an input → the task it started (follow it with tasks.events). */
                run: (agent, { input } = {}, { signal } = {}) => once({ method: 'POST', path: agentPath(agent, '/run'), json: { input: input == null ? '' : String(input) }, signal }),
                runs: (agent, { limit, before, signal } = {}) => call({ path: agentPath(agent, '/runs'), query: { limit, before }, signal }),
                memory: {
                    list: (agent, { signal } = {}) => call({ path: agentPath(agent, '/memory'), signal }),
                    /** Something for the agent to remember (1–1000 characters). */
                    add: (agent, text, { signal } = {}) => once({ method: 'POST', path: agentPath(agent, '/memory'), json: { text }, signal }),
                    update: (agent, note, text, { signal } = {}) => call({ method: 'PATCH', path: agentPath(agent, `/memory/${id('memory', note)}`), json: { text }, idempotent: true, signal }),
                    remove: (agent, note, { signal } = {}) => call({ method: 'DELETE', path: agentPath(agent, `/memory/${id('memory', note)}`), signal }),
                    /** Forget everything it remembers. */
                    clear: (agent, { signal } = {}) => call({ method: 'DELETE', path: agentPath(agent, '/memory'), signal }),
                },
            },
        },
    };
}

module.exports = { createActorClient };
