'use strict';
/**
 * openvibe-sdk/codes — OpenVibe.Codes for apps: the person's coding tasks as the Dock's Code tab lists, starts and
 * stops them. Routes at https://openvibe.codes/api/v1; the person's own Network access token.
 *
 *   const codes = createCodesClient(createClient({ tokenProvider }));
 *   const { tasks } = await codes.tasks.list({ limit: 8 });   // running first, codes.task-summary@1
 *   const { id, url } = await codes.tasks.create({ text: 'Add a test.', mode: 'repo', repo: 'octocat/Hello-World' });
 *   await codes.tasks.stop(id);                                // { ok: true }
 *
 * A task is its requester's own: another person's id is 404. Creates are never retried on their own (a retry would
 * start a second task); neither is a stop (a task already ended answers 409). The person token rides every call.
 */
const enc = encodeURIComponent;

const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const MODES = ['create', 'openvibe', 'repo'];
const PRESETS = ['Fast', 'Balanced', 'Deep', 'Council'];

function createCodesClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function' || typeof client.request !== 'function') throw new TypeError('createCodesClient: pass an openvibe-sdk/core client');
    const at = { service: 'codes', baseUrl, audience: 'openvibe.codes' };
    const call = (opts) => client.json({ ...at, ...opts });
    const once = (opts) => call({ ...opts, idempotencyKey: false });
    const id = (v) => {
        if (!TASK.test(String(v || ''))) throw new TypeError('codes: a task id is tsk_…');
        return enc(String(v));
    };

    return {
        tasks: {
            /** The person's latest tasks, running first (codes.task-summary@1). */
            list: ({ limit = 8, signal } = {}) => {
                const n = Number(limit);
                if (!Number.isInteger(n) || n < 1 || n > 50) throw new TypeError('codes.tasks.list: limit is 1-50');
                return call({ path: '/api/v1/me/tasks', query: { limit: n }, signal });
            },
            /** Start one the Dock's way: the words, where it starts, and what it carries. → { id, url }. */
            create: ({ text, mode, repo, attachments, plan, preset } = {}, { signal } = {}) => {
                if (typeof text !== 'string' || !text.trim()) throw new TypeError('codes.tasks.create: text is the instruction in plain words');
                if (!MODES.includes(mode)) throw new TypeError('codes.tasks.create: mode is create, openvibe or repo');
                if (repo != null && (typeof repo !== 'string' || !repo.trim())) throw new TypeError('codes.tasks.create: repo is a repository address');
                if (attachments != null && (!Array.isArray(attachments) || attachments.some((a) => typeof a !== 'string'))) {
                    throw new TypeError('codes.tasks.create: attachments are composer attachment ids');
                }
                if (plan != null && (typeof plan !== 'object' || Array.isArray(plan))) throw new TypeError('codes.tasks.create: plan is a model plan object');
                if (preset != null && !PRESETS.includes(preset)) throw new TypeError('codes.tasks.create: preset is Fast, Balanced, Deep or Council');
                if (plan != null && preset != null) throw new TypeError('codes.tasks.create: choose plan or preset');
                return once({
                    method: 'POST', path: '/api/v1/tasks',
                    json: { text, mode, ...(repo ? { repo } : {}), ...(attachments ? { attachments } : {}),
                        ...(plan ? { plan } : {}), ...(preset ? { preset } : {}) }, signal,
                });
            },
            /** Stop the running attempt; nothing carries it on. → { ok: true }. */
            stop: (taskId, { signal } = {}) => once({ method: 'POST', path: `/api/v1/tasks/${id(taskId)}/stop`, signal }),
        },
        modelPlans: {
            /** The account default and optional project's effective plan. */
            get: ({ project, signal } = {}) => call({ path: '/api/v1/model-plans', ...(project ? { query: { project } } : {}), signal }),
            /** Save an account or project plan; the service validates models and returns its resolved choices. */
            put: (plan, { project, signal } = {}) => {
                if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('codes.modelPlans.put: plan is a model plan object');
                if (project != null && (typeof project !== 'string' || !project.trim())) throw new TypeError('codes.modelPlans.put: project is a project id');
                return once({ method: 'PUT', path: '/api/v1/model-plans', ...(project ? { query: { project } } : {}), json: { plan }, signal });
            },
            /** Copyable Fast, Balanced, Deep and Council plans. */
            presets: ({ signal } = {}) => call({ path: '/api/v1/model-plans/presets', signal }),
        },
    };
}

module.exports = { createCodesClient };
