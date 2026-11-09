'use strict';

/**
 * openvibe-sdk/report — OpenVibe.Report's public JSON API.
 *
 *   const report = createReportClient(client);
 *   const ai = await report.ai.leaderboard({ kind: 'code', limit: 25 });
 *   const mine = await report.me({ days: 30 });                 // the signed-in person's own stats
 *   const theirs = await report.person('goosely');              // only the sections they published
 *   await report.publish({ sites: true, activity: true, made: false, ai: false, money: false });
 *
 * The routes answer the report.me-stats@1 document: the person, the window, the five publish switches and only the
 * sections a source answered for (a source that does not answer leaves its section out, never a zero). `me` and
 * `publish` need the person's own session token; `person` is public and is a 404 when nothing is published. The
 * publish call is a PUT with every switch named, so a request can never leave one to chance.
 */
const REPORT_URL = 'https://openvibe.report';
const DAYS = [7, 30, 90];
const SECTIONS = ['sites', 'activity', 'made', 'ai', 'money'];
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

function windowOf(days) {
    if (days == null) return {};
    if (!DAYS.includes(Number(days))) throw new TypeError(`report.me: days is one of ${DAYS.join(', ')}`);
    return { days: Number(days) };
}

function publishedOf(published) {
    if (!published || typeof published !== 'object' || Array.isArray(published)) throw new TypeError('report.publish: pass the five switches');
    const out = {};
    for (const key of SECTIONS) {
        if (typeof published[key] !== 'boolean') throw new TypeError(`report.publish: ${key} must be true or false`);
        out[key] = published[key];
    }
    return out;
}

function createReportClient(client, { baseUrl = REPORT_URL } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createReportClient: pass an openvibe-sdk/core client');
    const call = (path, query, signal) => client.json({ baseUrl, path, query, signal, service: 'report' });
    return {
        /**
         * The signed-in person's own numbers: sites, activity, what they made, AI and Vibes. Private by default;
         * the switches in the answer say which sections are public.
         */
        me({ days, signal } = {}) {
            return call('/api/v1/me/stats', windowOf(days), signal);
        },
        /** One person's published numbers, by username. Only the sections they made public; 404 when none. */
        person(username, { signal } = {}) {
            if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new TypeError('report.person: a username is 1–32 letters, digits or _');
            return call(`/api/v1/u/${encodeURIComponent(username)}/stats`, null, signal);
        },
        /** Set the five per-section switches and answer the recomputed document (the person's token is required). */
        publish(published, { days, signal } = {}) {
            const switches = publishedOf(published);
            return client.json({
                baseUrl, path: '/api/v1/me/stats/published', method: 'PUT',
                json: { published: switches, ...windowOf(days) }, signal, service: 'report',
            });
        },
        ai: {
            leaderboard(opts = {}, { signal } = {}) { return call('/api/v1/ai/leaderboard', opts, signal); },
            model(id, { signal } = {}) { if (!id) throw new TypeError('report.ai.model: id is required'); return call(`/api/v1/ai/models/${encodeURIComponent(id)}`, null, signal); },
            providers({ signal } = {}) { return call('/api/v1/ai/providers', null, signal); },
            compare(ids, { signal } = {}) { const models = (Array.isArray(ids) ? ids : [ids]).map(String).join(','); return call('/api/v1/ai/compare', { models }, signal); },
            picks({ signal } = {}) { return call('/api/v1/ai/picks', null, signal); },
        },
    };
}
module.exports = { createReportClient, REPORT_URL, DAYS, SECTIONS };
