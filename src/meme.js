'use strict';
/**
 * openvibe-sdk/meme: OpenVibe.Meme's encyclopedia, trends, analyser, deep dives and generator. Browser-safe
 * (JSON only). A signed-in person reads their own pending work with the client's usual token; public reads need no
 * token.
 *
 *   const meme = createMemeClient(client);
 *   const { entries } = await meme.search({ scope: 'internet', q: 'doge', label: '18+' });
 *   const entry = await meme.entry('doge');
 *   const rising = await meme.trends({ window: 'week' });
 *   const analysis = await meme.analyze({ url: 'https://www.reddit.com/r/memes/comments/abc123/…' });
 *   const job = await meme.research('surprised Pikachu');          // 202, poll researchGet(job.id)
 *   const made = await meme.generate({ template: 'tpl_classic' }); // { media_id, captions, template, … }
 */
const enc = encodeURIComponent;

function queryOf(q = {}) {
    const out = {};
    for (const [key, value] of Object.entries(q)) {
        if (value !== undefined && value !== null && value !== '') out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
}

function createMemeClient(client, defaults = {}) {
    const call = (opts, o = {}) => client.json({ service: 'meme', baseUrl: defaults.baseUrl, audience: 'openvibe.meme', ...opts, signal: o.signal });
    const post = (path, body, o) => call({ method: 'POST', path, json: body }, o);

    return {
        /** GET /api/v1/entries — public entries; filters scope/q/status/label/kind, sort newest|top, window day|week|month, channel stream id. */
        search: (params = {}, o = {}) => call({ path: '/api/v1/entries', query: queryOf({
            scope: params.scope, q: params.q, status: params.status, label: params.label, kind: params.kind,
            sort: params.sort, window: params.window, channel: params.channel, limit: params.limit, cursor: params.cursor,
        }) }, o),
        /** GET /api/v1/entries/:slug — origin, citations, spread, variations, examples, related and revisions. */
        entry: (slug, o = {}) => call({ path: `/api/v1/entries/${enc(slug)}` }, o),
        /** GET /api/v1/entries/:slug/revisions — approved history (staff see pending/rejected too). */
        revisions: (slug, o = {}) => call({ path: `/api/v1/entries/${enc(slug)}/revisions` }, o),
        /** GET /api/v1/trends?window=day|week — rising posts with velocity, new templates and entries. */
        trends: (opts = {}, o = {}) => call({ path: '/api/v1/trends', query: queryOf({ window: opts.window || 'day', limit: opts.limit }) }, o),
        /** POST /api/v1/analyze { url | media_id } — the template, matches, origins, meaning, labels, Reddit spread/tone. */
        analyze: (input = {}, o = {}) => {
            const url = input.url == null ? null : String(input.url);
            const mediaId = input.media_id == null ? (input.mediaId == null ? null : String(input.mediaId)) : String(input.media_id);
            if ((url ? 1 : 0) + (mediaId ? 1 : 0) !== 1) throw new TypeError('analyze: pass exactly one of url or media_id');
            return post('/api/v1/analyze', { ...(url ? { url } : { media_id: mediaId }) }, o);
        },
        /** POST /api/v1/research { topic } — 202 with the job; poll researchGet(id). */
        research: (topic, o = {}) => post('/api/v1/research', { topic: String(topic == null ? '' : topic) }, o),
        researchGet: (id, o = {}) => call({ path: `/api/v1/research/${enc(id)}` }, o),
        saveResearch: (id, o = {}) => post(`/api/v1/research/${enc(id)}/entry`, {}, o),
        /** POST /api/v1/generate { template_slug | topic, lines? } — a rendered PNG in Media and its captions. */
        generate: (input = {}, o = {}) => {
            const template = input.template_slug != null ? input.template_slug : input.template;
            const body = {};
            if (template != null && template !== '') body.template_slug = String(template);
            if (input.topic != null && input.topic !== '') body.topic = String(input.topic);
            if (input.lines !== undefined) body.lines = input.lines;
            if (!body.template_slug && !body.topic) throw new TypeError('generate: pass template or topic');
            return post('/api/v1/generate', body, o);
        },
    };
}

module.exports = { createMemeClient };
