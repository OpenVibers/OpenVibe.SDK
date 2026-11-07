'use strict';
/**
 * openvibe-sdk/reports — a session report from any harness (the Agent Streams plan, S3/S7).
 *
 * A report is one agent session's story: what was asked, what came out, what it cost, how it ended. This client
 * writes it with the person's own token, so a harness on their machine can report without a service token:
 *
 *   const reports = createReportsClient(createClient({ tokenProvider }));
 *   const { id, url } = await reports.write({
 *       source: 'node', task: { ref: 'run_123', title: 'Fix the login page' },
 *       summary: 'The login page redirects again; the tests are green.',
 *       outcome: 'done', visibility: 'private',
 *   });
 *
 * A report is private by default (the design's rule). The Report service applies the person's default audience when
 * `visibility` is absent and redacts every text field before it stores anything; this client sends only what the
 * caller wrote and never a raw transcript.
 */
const ID_RE = /^rps_[0-9A-HJKMNP-TV-Z]{26}$/;
const SOURCES = ['codes', 'actor', 'desk', 'node'];
const OUTCOMES = ['done', 'stopped', 'failed'];
const VISIBILITIES = ['private', 'unlisted', 'public'];

function text(value, max, what, required = true) {
    if (value == null && !required) return undefined;
    if (typeof value !== 'string' || (!value.trim() && required) || Array.from(value).length > max) {
        throw new TypeError(`reports: ${what} is ${required ? '1–' : '0–'}${max} characters`);
    }
    return value;
}

function num(value, what, { min = 0, max = 1_000_000_000 } = {}) {
    if (value == null) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new TypeError(`reports: ${what} is a number ${min}–${max}`);
    return n;
}

function step(value) {
    const s = value && typeof value === 'object' ? value : {};
    const out = { title: text(s.title, 120, 'a step title'), status: ['started', 'passed', 'failed', 'skipped'].includes(s.status) ? s.status : 'started' };
    if (s.at) out.at = new Date(String(s.at)).toISOString();
    if (s.detail != null) out.detail = text(s.detail, 500, 'a step detail');
    if (s.tests) out.tests = { passed: num(s.tests.passed, 'tests.passed') || 0, failed: num(s.tests.failed, 'tests.failed') || 0 };
    if (s.cost_usd != null) out.cost_usd = num(s.cost_usd, 'cost_usd');
    return out;
}

/** The body of POST /api/v1/me/session-reports, checked before anything leaves the process. */
function cleanReport(report = {}) {
    const r = report || {};
    const task = r.task && typeof r.task === 'object' ? r.task : {};
    const source = SOURCES.includes(r.source) ? r.source : null;
    if (!source) throw new TypeError('reports: source is codes, actor, desk or node');
    const out = {
        source,
        task: { ref: text(task.ref, 200, 'the task ref'), title: text(task.title, 200, 'the task title') },
        summary: text(r.summary, 600, 'the summary'),
    };
    if (task.url) out.task.url = text(task.url, 2048, 'the task URL');
    if (r.outcome !== undefined) out.outcome = OUTCOMES.includes(r.outcome) ? r.outcome : (() => { throw new TypeError('reports: outcome is done, stopped or failed'); })();
    if (r.visibility !== undefined) out.visibility = VISIBILITIES.includes(r.visibility) ? r.visibility : (() => { throw new TypeError('reports: visibility is private, unlisted or public'); })();
    if (r.worked_seconds != null) out.worked_seconds = Math.max(0, Math.round(num(r.worked_seconds, 'worked_seconds') || 0));
    if (r.cost_usd != null) out.cost_usd = num(r.cost_usd, 'cost_usd');
    if (r.started_at) out.started_at = new Date(String(r.started_at)).toISOString();
    if (r.ended_at) out.ended_at = new Date(String(r.ended_at)).toISOString();
    if (Array.isArray(r.timeline)) out.timeline = r.timeline.slice(0, 200).map(step);
    if (Array.isArray(r.outputs)) {
        out.outputs = r.outputs.slice(0, 50).map((o) => ({
            kind: ['pr', 'file', 'page', 'deploy', 'clip', 'vod'].includes(o && o.kind) ? o.kind : 'file',
            title: text(o && o.title, 200, 'an output title'),
            ...(o && o.url ? { url: text(o.url, 2048, 'an output URL') } : {}),
            ...(o && o.state ? { state: text(o.state, 60, 'an output state') } : {}),
        }));
    }
    if (Array.isArray(r.highlights)) out.highlights = r.highlights.slice(0, 20).map((h) => text(h, 500, 'a highlight'));
    if (r.proof && typeof r.proof === 'object') {
        const p = r.proof;
        out.proof = {
            ...(p.tests ? { tests: { passed: num(p.tests.passed, 'proof tests passed') || 0, failed: num(p.tests.failed, 'proof tests failed') || 0 } } : {}),
            ...(Array.isArray(p.screenshots) ? { screenshots: p.screenshots.slice(0, 20).filter((s) => typeof s === 'string') } : {}),
            ...(p.review ? { review: { verdict: text(p.review.verdict, 40, 'the review verdict'), ...(p.review.notes ? { notes: text(p.review.notes, 2000, 'the review notes') } : {}) } } : {}),
        };
    }
    return out;
}

/**
 * createReportsClient(client, { baseUrl }) — POST /api/v1/me/session-reports on OpenVibe.Report with the person's token.
 */
function createReportsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createReportsClient: pass an openvibe-sdk/core client');
    const at = { service: 'report', baseUrl, audience: 'openvibe.report' };
    return {
        /**
         * Write a session report → { id, url, created }. Idempotent per (source, task ref): the same task answers the
         * same report, so a retry never makes a second one. Private unless `visibility` says otherwise.
         *
         * @param {object} report
         * @param {{ signal?: AbortSignal }} [options]
         */
        async write(report, { signal } = {}) {
            // The idempotency key is the task, so the client's own retry cannot create a second report.
            const body = cleanReport(report);
            const key = `report:${body.source}:${body.task.ref}`.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 160);
            return client.json({ ...at, method: 'POST', path: '/api/v1/me/session-reports', json: body, idempotencyKey: key, signal });
        },

        /** One report the caller may see (a public one, or their own), or the 404 problem. */
        async read(id, { signal } = {}) {
            if (!ID_RE.test(String(id || ''))) throw new TypeError('reports: a report id is rps_…');
            return client.json({ ...at, method: 'GET', path: `/api/v1/session-reports/${id}`, signal });
        },
    };
}

module.exports = { createReportsClient, cleanReport };
