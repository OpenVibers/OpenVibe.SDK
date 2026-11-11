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
            create: ({ text, mode, repo, attachments } = {}, { signal } = {}) => {
                if (typeof text !== 'string' || !text.trim()) throw new TypeError('codes.tasks.create: text is the instruction in plain words');
                if (!MODES.includes(mode)) throw new TypeError('codes.tasks.create: mode is create, openvibe or repo');
                if (repo != null && (typeof repo !== 'string' || !repo.trim())) throw new TypeError('codes.tasks.create: repo is a repository address');
                if (attachments != null && (!Array.isArray(attachments) || attachments.some((a) => typeof a !== 'string'))) {
                    throw new TypeError('codes.tasks.create: attachments are composer attachment ids');
                }
                return once({
                    method: 'POST', path: '/api/v1/tasks',
                    json: { text, mode, ...(repo ? { repo } : {}), ...(attachments ? { attachments } : {}) }, signal,
                });
            },
            /** Stop the running attempt; nothing carries it on. → { ok: true }. */
            stop: (taskId, { signal } = {}) => once({ method: 'POST', path: `/api/v1/tasks/${id(taskId)}/stop`, signal }),
        },
    };
}

module.exports = { createCodesClient };
