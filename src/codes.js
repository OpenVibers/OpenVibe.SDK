'use strict';

/** OpenVibe.Codes plans and tasks, on the same core client as the rest of the SDK. */
function createCodesClient(client, { baseUrl, actingSubject } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createCodesClient: pass an openvibe-sdk/core client');
    const at = { service: 'codes', baseUrl, audience: 'openvibe.codes' };
    const call = (request, options = {}) => client.json({
        ...at, ...request, signal: options.signal,
        ...(actingSubject ? { headers: { 'X-OV-Subject': actingSubject, ...(request.headers || {}) } } : {}),
    });
    const projectQuery = (project) => {
        if (project == null || project === '') return undefined;
        if (typeof project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(project)) throw new TypeError('codes: project must be a project id');
        return { project };
    };
    const taskId = (id) => {
        if (!/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) throw new TypeError('codes: task id must be tsk_ followed by a ULID');
        return encodeURIComponent(id);
    };
    return {
        modelPlans: {
            get: ({ project, signal } = {}) => call({ path: '/api/v1/model-plans', query: projectQuery(project) }, { signal }),
            put: (plan, { project, signal } = {}) => {
                if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('codes.modelPlans.put: plan must be an object');
                return call({ method: 'PUT', path: '/api/v1/model-plans', query: projectQuery(project), json: { plan }, idempotent: true }, { signal });
            },
            presets: ({ signal } = {}) => call({ path: '/api/v1/model-plans/presets', auth: false }, { signal }),
        },
        tasks: {
            create: (body, { signal } = {}) => {
                if (!body || typeof body.repo !== 'string' || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new TypeError('codes.tasks.create: repo and prompt are required');
                if (body.plan && body.preset) throw new TypeError('codes.tasks.create: choose a plan or preset');
                return call({ method: 'POST', path: '/api/v1/tasks', json: body, ...(body.idempotency_key ? { idempotent: true } : { idempotencyKey: false }) }, { signal });
            },
            get: (id, { signal } = {}) => call({ path: `/api/v1/tasks/${taskId(id)}` }, { signal }),
        },
    };
}

module.exports = { createCodesClient };
