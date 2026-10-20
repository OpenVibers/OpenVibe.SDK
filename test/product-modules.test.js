'use strict';
// openvibe-sdk/food, /actor, /run, /video, /work, /zone, /blog, /reviews, /wiki, /coupons, /deals, /trade and /space through a real core client against one local stub: every
// route and method, the token audience, which writes are retried (keyed or idempotent) and which never are, the SSE
// followers (Actor's task events, Run's job stream), and the id checks done before any call.
const assert = require('assert');
const http = require('http');
const { createClient } = require('../src/core');
const { createFoodClient } = require('../src/food');
const { createActorClient } = require('../src/actor');
const { createRunClient } = require('../src/run');
const { createVideoClient } = require('../src/video');
const { createWorkClient } = require('../src/work');
const { createZoneClient } = require('../src/zone');
const { createBlogClient } = require('../src/blog');
const { createReviewsClient } = require('../src/reviews');
const { createWikiClient } = require('../src/wiki');
const { createCouponsClient } = require('../src/coupons');
const { createDealsClient } = require('../src/deals');
const { createTradeClient } = require('../src/trade');
const { createSpaceClient } = require('../src/space');

const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const ids = { plan: `pln_${ULID}`, task: `tsk_${ULID}`, agent: `agt_${ULID}`, mem: `mem_${ULID}`, job: `job_${ULID}`, playlist: `vpl_${ULID}`, app: `wap_${ULID}`, project: `prj_${ULID}`, zone: `zon_${ULID}`, post: `pst_${ULID}`, page: `pg_${ULID}`, coupon: `cpn_${ULID}` };

(async () => {
    const seen = [];
    const attempts = {};
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const svc = req.url.split('/')[1];
            const url = req.url.slice(svc.length + 1);
            const type = String(req.headers['content-type'] || '');
            seen.push({ svc, method: req.method, url, type, raw: body, idem: req.headers['idempotency-key'] || null, project: req.headers['x-ov-project'] || null, lastEvent: req.headers['last-event-id'] || null, auth: req.headers.authorization || null, body: body && type.startsWith('application/json') ? JSON.parse(body) : null });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            const key = `${req.method} ${req.url} ${body}`;   // one 503 per distinct request
            attempts[key] = (attempts[key] || 0) + 1;
            // Every write answers 503 once: a write the client may repeat is retried, one it may not is thrown.
            if (req.method !== 'GET' && attempts[key] === 1 && !/stream\/ticket|\/route$/.test(req.url)) return json(503, { type: 'about:blank', title: 'busy', status: 503 });
            if (/\/events$|\/stream$/.test(url)) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('id: 3\nevent: state\ndata: {"state":"running"}\n\n');
                res.write(': keep-alive\n\n');
                res.end('id: 4\nevent: end\ndata: {"state":"succeeded"}\n\n');
                return undefined;
            }
            return json(req.method === 'POST' ? 201 : 200, { ok: true });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const audiences = [];
    const client = createClient({
        baseUrls: { food: `${base}/food`, actor: `${base}/actor`, run: `${base}/run`, 'media-hub': `${base}/video`, work: `${base}/work`, zone: `${base}/zone`, blog: `${base}/blog`, reviews: `${base}/reviews`, wiki: `${base}/wiki`, coupons: `${base}/coupons`, deals: `${base}/deals`, trade: `${base}/trade`, space: `${base}/space` },
        getToken: ({ audience }) => { audiences.push(audience); return `tok-${audience}`; },
        retries: 2, retryDelayMs: 1, maxRetryDelayMs: 2,
    });
    const since = () => { const n = seen.length; return () => seen.slice(n); };
    const busyOnce = async (fn) => assert.rejects(fn, (e) => e.status === 503, 'a write that is never retried surfaces the 503');

    try {
        // ── Food ──────────────────────────────────────────────
        const food = createFoodClient(client);
        let mark = since();
        await food.places({ kind: 'foodbank', lat: 45.5, lon: -122.6, radius: 10 });
        await food.foods.list({ group: 'vegetables', q: 'carrot' });
        await food.foods.get('carrots');
        await food.plans.list({ limit: 5 });
        await food.plans.get(ids.plan);
        await food.pantry.get();
        await food.pantry.set(['rice', 'onions']);                       // PUT: retried
        await busyOnce(() => food.plans.create({ people: 2, days: 7, budget: 80 }));
        await busyOnce(() => food.recipes.suggest({ ask: 'quick', people: 2 }));
        await food.recipes.list();
        assert.deepStrictEqual(mark().map((r) => `${r.method} ${r.url}`), [
            'GET /api/v1/places?kind=foodbank&lat=45.5&lon=-122.6&radius=10', 'GET /api/v1/foods?group=vegetables&q=carrot', 'GET /api/v1/foods/carrots',
            'GET /api/v1/plans?limit=5', `GET /api/v1/plans/${ids.plan}`, 'GET /api/v1/pantry', 'PUT /api/v1/pantry', 'PUT /api/v1/pantry',
            'POST /api/v1/plans', 'POST /api/v1/recipes/suggest', 'GET /api/v1/recipes',
        ]);
        assert.throws(() => food.plans.get('nope'), /pln_/);
        assert.throws(() => food.pantry.set('rice'), /array/);

        // ── Actor ─────────────────────────────────────────────
        const actor = createActorClient(client);
        mark = since();
        await actor.agents.list();
        await actor.route({ task: 'sum it up', mode: 'cheapest' });
        await actor.tasks.create({ task: 'Summarize', idempotency_key: 'job-0042' });   // keyed in the body: retried
        await busyOnce(() => actor.tasks.create({ task: 'Again, unkeyed' }));
        await actor.tasks.list({ limit: 10 });
        await actor.tasks.get(ids.task);
        await actor.tasks.cancel(ids.task);                                             // retried
        const evs = [];
        for await (const e of actor.tasks.events(ids.task, { lastEventId: 2 })) evs.push(e);
        assert.deepStrictEqual(evs, [{ id: 3, event: 'state', data: { state: 'running' } }, { id: 4, event: 'end', data: { state: 'succeeded' } }]);
        await actor.me.agents.list();
        await busyOnce(() => actor.me.agents.create({ name: 'Brief', instructions: 'x' }));
        await actor.me.agents.get(ids.agent);
        await actor.me.agents.update(ids.agent, { status: 'paused' });
        await actor.me.agents.remove(ids.agent);
        await busyOnce(() => actor.me.agents.run(ids.agent, { input: 'today' }));
        await actor.me.agents.runs(ids.agent, { limit: 3 });
        await actor.me.agents.memory.list(ids.agent);
        await busyOnce(() => actor.me.agents.memory.add(ids.agent, 'I live in Portland'));
        await actor.me.agents.memory.update(ids.agent, ids.mem, 'Portland, Oregon');
        await actor.me.agents.memory.remove(ids.agent, ids.mem);
        await actor.me.agents.memory.clear(ids.agent);
        const a = mark();
        assert.deepStrictEqual(a.map((r) => `${r.method} ${r.url}`), [
            'GET /api/v1/agents', 'POST /api/v1/route', 'POST /api/v1/tasks', 'POST /api/v1/tasks', 'POST /api/v1/tasks',
            'GET /api/v1/tasks?limit=10', `GET /api/v1/tasks/${ids.task}`, `POST /api/v1/tasks/${ids.task}/cancel`, `POST /api/v1/tasks/${ids.task}/cancel`,
            `GET /api/v1/tasks/${ids.task}/events`, 'GET /api/v1/me/agents', 'POST /api/v1/me/agents', `GET /api/v1/me/agents/${ids.agent}`,
            `PATCH /api/v1/me/agents/${ids.agent}`, `PATCH /api/v1/me/agents/${ids.agent}`, `DELETE /api/v1/me/agents/${ids.agent}`, `DELETE /api/v1/me/agents/${ids.agent}`,
            `POST /api/v1/me/agents/${ids.agent}/run`, `GET /api/v1/me/agents/${ids.agent}/runs?limit=3`, `GET /api/v1/me/agents/${ids.agent}/memory`,
            `POST /api/v1/me/agents/${ids.agent}/memory`, `PATCH /api/v1/me/agents/${ids.agent}/memory/${ids.mem}`, `PATCH /api/v1/me/agents/${ids.agent}/memory/${ids.mem}`,
            `DELETE /api/v1/me/agents/${ids.agent}/memory/${ids.mem}`, `DELETE /api/v1/me/agents/${ids.agent}/memory/${ids.mem}`,
            `DELETE /api/v1/me/agents/${ids.agent}/memory`, `DELETE /api/v1/me/agents/${ids.agent}/memory`,
        ]);
        assert.strictEqual(a.find((r) => r.url.endsWith('/events')).lastEvent, '2', 'the stream picks up after lastEventId');
        assert.deepStrictEqual(a.find((r) => r.url === `/api/v1/me/agents/${ids.agent}/run`).body, { input: 'today' });
        assert.throws(() => actor.tasks.get('tsk_bad'), /tsk_/);
        assert.throws(() => actor.tasks.create({ task: '  ' }), /instruction/);

        // ── Run ───────────────────────────────────────────────
        const run = createRunClient(client);
        mark = since();
        const submitted = { class: 'function', artifact: { name: 'thumbnailer', version: '1.2.0' }, limits: { wall_ms: 1000, cpu_ms: 500, mem_bytes: 1e8 } };
        await run.jobs.submit(submitted);                                              // keyed by the core client: retried with the same key
        await run.jobs.submit({ ...submitted, idempotency_key: 'thumb-7' });
        await run.jobs.list({ state: 'running', limit: 5 });
        await run.jobs.get(ids.job);
        await run.jobs.cancel(ids.job);
        await run.jobs.streamTicket(ids.job);
        const jobEvents = [];
        for await (const e of run.jobs.events(ids.job)) jobEvents.push(e.event);
        assert.deepStrictEqual(jobEvents, ['state', 'end']);
        await run.forProject(ids.project).jobs.get(ids.job);
        const r = mark();
        assert.deepStrictEqual(r.map((x) => `${x.method} ${x.url}`), [
            'POST /api/v1/jobs', 'POST /api/v1/jobs', 'POST /api/v1/jobs', 'POST /api/v1/jobs', 'GET /api/v1/jobs?state=running&limit=5', `GET /api/v1/jobs/${ids.job}`,
            `POST /api/v1/jobs/${ids.job}/cancel`, `POST /api/v1/jobs/${ids.job}/cancel`, `POST /api/v1/jobs/${ids.job}/stream/ticket`,
            `GET /api/v1/jobs/${ids.job}/stream`, `GET /api/v1/jobs/${ids.job}`,
        ]);
        assert.ok(r[0].idem && r[0].idem === r[1].idem, 'the retried submit repeats its Idempotency-Key');
        assert.deepStrictEqual([r[2].idem, r[3].idem], ['thumb-7', 'thumb-7'], "the body's idempotency_key is the header");
        assert.strictEqual(r[10].project, ids.project, 'forProject names the project');
        assert.strictEqual(r[5].project, null);
        assert.throws(() => run.jobs.list({ state: 'done' }), /state is one of/);
        assert.throws(() => run.jobs.submit({ class: 'function' }), /limits/);
        assert.throws(() => run.forProject('nope'), /prj_/);

        // ── Video ─────────────────────────────────────────────
        const video = createVideoClient(client);
        mark = since();
        await video.playlists.list();
        await busyOnce(() => video.playlists.create({ title: 'Best of', visibility: 'public' }));
        await video.playlists.get(ids.playlist);
        await video.playlists.update(ids.playlist, { title: 'Best of October' });
        await busyOnce(() => video.playlists.items.add(ids.playlist, { kind: 'vod', id: '5579' }));
        await video.playlists.items.reorder(ids.playlist, [{ kind: 'clip', id: 12 }, { kind: 'vod', id: 5579 }]);
        await video.playlists.items.remove(ids.playlist, { kind: 'clip', id: 12 });
        await video.playlists.remove(ids.playlist);
        await video.users.playlists('goosely', { limit: 10 });
        const v = mark();
        assert.deepStrictEqual(v.map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/video/playlists', 'POST /api/v1/video/playlists', `GET /api/v1/video/playlists/${ids.playlist}`,
            `PATCH /api/v1/video/playlists/${ids.playlist}`, `PATCH /api/v1/video/playlists/${ids.playlist}`, `POST /api/v1/video/playlists/${ids.playlist}/items`,
            `PATCH /api/v1/video/playlists/${ids.playlist}/items`, `PATCH /api/v1/video/playlists/${ids.playlist}/items`,
            `DELETE /api/v1/video/playlists/${ids.playlist}/items/clip/12`, `DELETE /api/v1/video/playlists/${ids.playlist}/items/clip/12`,
            `DELETE /api/v1/video/playlists/${ids.playlist}`, `DELETE /api/v1/video/playlists/${ids.playlist}`, 'GET /api/v1/video/users/goosely/playlists?limit=10',
        ]);
        assert.deepStrictEqual(v[5].body, { kind: 'vod', id: 5579 });
        assert.deepStrictEqual(v[6].body, { items: [{ kind: 'clip', id: 12 }, { kind: 'vod', id: 5579 }] });
        assert.throws(() => video.playlists.items.add(ids.playlist, { kind: 'paste', id: 1 }), /'vod' or 'clip'/);
        assert.throws(() => video.playlists.get('pl_1'), /vpl_/);

        // ── Work ──────────────────────────────────────────────
        const work = createWorkClient(client);
        mark = since();
        await work.jobs.search({ q: 'node', remote: true, limit: 20 });
        await work.jobs.get('rok-123');
        await work.sources();
        await work.savedSearches.list();
        await busyOnce(() => work.savedSearches.create({ q: 'robotics', remote: false }));
        await work.savedSearches.remove('ssc_1');
        await work.applications.list({ status: 'applied' });
        await work.applications.create({ listing_id: 'rok-123', status: 'saved' });   // a listing is tracked once: retried
        await busyOnce(() => work.applications.create({ title: 'Robot wrangler', company: 'Acme' }));
        await work.applications.get(ids.app);
        await work.applications.update(ids.app, { status: 'interviewing' });
        await work.applications.remove(ids.app);
        await busyOnce(() => work.applications.assist(ids.app, { ask: 'a cover letter' }));
        const w = mark();
        assert.deepStrictEqual(w.map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/jobs?q=node&remote=true&limit=20', 'GET /api/v1/jobs/rok-123', 'GET /api/v1/sources', 'GET /api/v1/saved-searches',
            'POST /api/v1/saved-searches', 'DELETE /api/v1/saved-searches/ssc_1', 'DELETE /api/v1/saved-searches/ssc_1', 'GET /api/v1/me/applications?status=applied',
            'POST /api/v1/me/applications', 'POST /api/v1/me/applications', 'POST /api/v1/me/applications', `GET /api/v1/me/applications/${ids.app}`,
            `PATCH /api/v1/me/applications/${ids.app}`, `PATCH /api/v1/me/applications/${ids.app}`, `DELETE /api/v1/me/applications/${ids.app}`,
            `DELETE /api/v1/me/applications/${ids.app}`, `POST /api/v1/me/applications/${ids.app}/assist`,
        ]);
        assert.deepStrictEqual(w[4].body, { q: 'robotics', remote: 'false' });
        assert.throws(() => work.applications.update(ids.app, { status: 'hired' }), /status is one of/);
        assert.throws(() => work.applications.get('app_1'), /wap_/);

        // ── Zone ──────────────────────────────────────────────
        const zone = createZoneClient(client);
        mark = since();
        await zone.zones.create(ids.project, { env: 'production', name: 'user-uploads', quota_bytes: 5e10 }, { idempotencyKey: 'zone-create-1' });
        await zone.zones.list(ids.project, { env: 'sandbox', include_deleted: true, limit: 5 });
        await zone.zones.get(ids.zone);
        await zone.zones.update(ids.zone, { quota_bytes: null });
        await zone.zones.remove(ids.zone, { recursive: true });
        await zone.zones.usage(ids.zone);
        const z = mark();
        assert.deepStrictEqual(z.map((x) => `${x.method} ${x.url}`), [
            `POST /api/v1/projects/${ids.project}/zones`, `POST /api/v1/projects/${ids.project}/zones`,
            `GET /api/v1/projects/${ids.project}/zones?env=sandbox&include_deleted=true&limit=5`, `GET /api/v1/zones/${ids.zone}`,
            `PATCH /api/v1/zones/${ids.zone}`, `PATCH /api/v1/zones/${ids.zone}`, `DELETE /api/v1/zones/${ids.zone}?recursive=true`,
            `DELETE /api/v1/zones/${ids.zone}?recursive=true`, `GET /api/v1/zones/${ids.zone}/usage`,
        ]);
        assert.deepStrictEqual([z[0].idem, z[1].idem], ['zone-create-1', 'zone-create-1']);
        assert.deepStrictEqual(z[4].body, { quota_bytes: null }, 'null clears the quota');
        assert.throws(() => zone.zones.create(ids.project, { name: 'x' }), /env is required/);
        assert.throws(() => zone.zones.get('zone_1'), /zon_/);

        // ── Blog ──────────────────────────────────────────────
        const blog = createBlogClient(client);
        mark = since();
        await blog.blogs.get('goosely');
        await blog.blogs.posts('goosely', { limit: 10, all: true });
        await blog.blogs.feed('goosely');
        await busyOnce(() => blog.posts.create('goosely', { title: 'Tonight on stream', body: 'Hi', visibility: 'public' }));
        await blog.posts.get(ids.post);
        await blog.posts.update(ids.post, { body: 'Hi again', expected_revision: 1 });
        await blog.posts.publish(ids.post);
        await blog.posts.unpublish(ids.post);
        await blog.posts.schedule(ids.post, { at: '2026-10-21T18:00:00Z', revision: 2 });
        await blog.posts.cancelSchedule(ids.post);
        await busyOnce(() => blog.posts.revert(ids.post, { to_revision: 1, expected_revision: 2 }));
        await blog.posts.revisions(ids.post);
        await blog.posts.revision(ids.post, 2);
        await blog.posts.remove(ids.post);
        const b = mark();
        const P = `/api/v1/posts/${ids.post}`;
        assert.deepStrictEqual(b.map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/blogs/goosely', 'GET /api/v1/blogs/goosely/posts?limit=10&all=1', 'GET /api/v1/blogs/goosely/feed',
            'POST /api/v1/blogs/goosely/posts', `GET ${P}`, `PATCH ${P}`, `PATCH ${P}`, `POST ${P}/publish`, `POST ${P}/publish`,
            `POST ${P}/unpublish`, `POST ${P}/unpublish`, `POST ${P}/schedule`, `POST ${P}/schedule`, `DELETE ${P}/schedule`,
            `DELETE ${P}/schedule`, `POST ${P}/revert`, `GET ${P}/revisions`, `GET ${P}/revisions/2`, `DELETE ${P}`, `DELETE ${P}`,
        ]);
        assert.deepStrictEqual(b[11].body, { at: '2026-10-21T18:00:00Z', revision: 2 });
        assert.throws(() => blog.posts.get('post_1'), /pst_/);
        assert.throws(() => blog.posts.create('goosely', { body: 'no title' }), /title/);
        assert.throws(() => blog.posts.schedule(ids.post, { at: 'tomorrow' }), /ISO 8601/);

        // ── Reviews ───────────────────────────────────────────
        const reviews = createReviewsClient(client);
        mark = since();
        await reviews.resolve({ name: 'Blue Star Donuts', url: 'https://bluestardonuts.com' });   // a lookup: retried
        await reviews.entities.list({ q: 'donuts', limit: 20 });
        await reviews.entities.get('blue-star-donuts');
        await reviews.entities.history('blue-star-donuts');
        await reviews.entities.aggregate('blue-star-donuts');
        await reviews.entities.summaryRevision('blue-star-donuts', 3);
        await busyOnce(() => reviews.corrections.submit('blue-star-donuts', { target_type: 'entity', body: 'Closed on Mondays now', evidence_url: 'https://example.com/hours' }));
        const rv = mark();
        assert.deepStrictEqual(rv.map((x) => `${x.method} ${x.url}`), [
            'POST /api/v1/resolve', 'POST /api/v1/resolve', 'GET /api/v1/entities?q=donuts&limit=20', 'GET /api/v1/entities/blue-star-donuts',
            'GET /api/v1/entities/blue-star-donuts/history', 'GET /api/v1/entities/blue-star-donuts/aggregate',
            'GET /api/v1/entities/blue-star-donuts/summary/revisions/3', 'POST /api/v1/entities/blue-star-donuts/corrections',
        ]);
        assert.deepStrictEqual(rv[7].body, { body: 'Closed on Mondays now', target_type: 'entity', evidence_url: 'https://example.com/hours' });
        assert.throws(() => reviews.resolve({}), /identifier/);
        assert.throws(() => reviews.corrections.submit('x', { body: 'y', target_type: 'opinion' }), /target_type/);
        assert.throws(() => reviews.corrections.submit('x', { body: ' ' }), /body/);

        // ── Wiki ──────────────────────────────────────────────
        const wiki = createWikiClient(client);
        mark = since();
        await wiki.search('restreaming', { space: 'openvibe', limit: 5 });
        await wiki.spaces.list();
        await wiki.spaces.get('openvibe');
        await wiki.pages.get(ids.page, { revision: 4 });
        await wiki.pages.revisions(ids.page, { limit: 10 });
        await wiki.pages.revision(ids.page, 4);
        await wiki.pages.diff(ids.page, { from: 3, to: 4, mode: 'words' });
        await wiki.pages.citations(ids.page, 4);
        const W = `/api/v1/pages/${ids.page}`;
        assert.deepStrictEqual(mark().map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/search?q=restreaming&space=openvibe&limit=5', 'GET /api/v1/spaces', 'GET /api/v1/spaces/openvibe', `GET ${W}?revision=4`,
            `GET ${W}/revisions?limit=10`, `GET ${W}/revisions/4`, `GET ${W}/diff?from=3&to=4&mode=words`, `GET ${W}/revisions/4/citations`,
        ]);
        assert.throws(() => wiki.search(''), /search for/);
        assert.throws(() => wiki.pages.get('page_1'), /pg_/);
        assert.throws(() => wiki.pages.diff(ids.page, { from: 0, to: 2 }), /revision number/);

        // ── Coupons ───────────────────────────────────────────
        const coupons = createCouponsClient(client);
        mark = since();
        await coupons.merchants.resolve('www.example-store.com');
        await coupons.merchants.get('mer_1');
        await coupons.merchants.coupons('mer_1');
        await coupons.get(ids.coupon);
        await busyOnce(() => coupons.submit({ host: 'example-store.com', code: 'SAVE10', title: '10% off' }));
        await coupons.report(ids.coupon, { outcome: 'failed', reason: 'expired' });   // only the latest counts: retried
        const C = `/api/v1/coupons/${ids.coupon}`;
        const cp = mark();
        assert.deepStrictEqual(cp.map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/merchants/resolve?host=www.example-store.com', 'GET /api/v1/merchants/mer_1', 'GET /api/v1/merchants/mer_1/coupons', `GET ${C}`,
            'POST /api/v1/coupons/submit', `POST ${C}/report`, `POST ${C}/report`,
        ]);
        assert.deepStrictEqual(cp[5].body, { outcome: 'failed', reason: 'expired' });
        assert.throws(() => coupons.submit({ code: 'X', title: 'Y' }), /merchant_id, host or url/);
        assert.throws(() => coupons.report(ids.coupon, { outcome: 'maybe' }), /worked/);
        assert.throws(() => coupons.get('coupon_1'), /cpn_/);

        // ── Deals ─────────────────────────────────────────────
        const deals = createDealsClient(client);
        mark = since();
        await deals.offers.list({ sort: 'hot', page: 2 });
        await deals.offers.get('gpu-299');
        await deals.offers.hotness('gpu-299');
        await busyOnce(() => deals.offers.submit({ url: 'https://shop.example/gpu', title: 'GPU at $299', price: 299, currency: 'USD' }));
        await deals.offers.update('off_1', { title: 'GPU at $279' });
        await busyOnce(() => deals.offers.observe('off_1', { price: 279, currency: 'USD' }));
        await deals.offers.vote('off_2', -1);   // PUT: retried
        await deals.offers.unvote('off_2');
        await busyOnce(() => deals.offers.flag('off_2', { kind: 'expired' }));
        await deals.products.get('rtx-4070');
        await deals.stores.get('shop.example');
        await deals.watches.list();
        await busyOnce(() => deals.watches.create({ kind: 'price_below', product: 'rtx-4070', max_price: 450, currency: 'USD' }));
        await deals.watches.remove('wat_1');
        const dl = mark();
        assert.deepStrictEqual(dl.map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/offers?sort=hot&page=2', 'GET /api/v1/offers/gpu-299', 'GET /api/v1/offers/gpu-299/hotness', 'POST /api/v1/offers',
            'PATCH /api/v1/offers/off_1', 'PATCH /api/v1/offers/off_1', 'POST /api/v1/offers/off_1/observations', 'PUT /api/v1/offers/off_2/vote',
            'PUT /api/v1/offers/off_2/vote', 'DELETE /api/v1/offers/off_2/vote', 'DELETE /api/v1/offers/off_2/vote', 'POST /api/v1/offers/off_2/flags',
            'GET /api/v1/products/rtx-4070', 'GET /api/v1/stores/shop.example', 'GET /api/v1/watches', 'POST /api/v1/watches',
            'DELETE /api/v1/watches/wat_1', 'DELETE /api/v1/watches/wat_1',
        ]);
        assert.deepStrictEqual(dl[7].body, { value: -1 });
        assert.throws(() => deals.offers.vote('off_2', 2), /1 or -1/);
        assert.throws(() => deals.offers.flag('off_2', { kind: 'meh' }), /kind is one of/);
        assert.throws(() => deals.offers.list({ sort: 'top' }), /hot/);

        // ── Trade ─────────────────────────────────────────────
        const trade = createTradeClient(client);
        mark = since();
        await trade.instruments.resolve('AAPL');
        await trade.instruments.list({ limit: 5 });
        await trade.instruments.get('AAPL');
        await trade.instruments.observations('AAPL', { metric: 'price', limit: 30 });
        await trade.instruments.documents('AAPL', { limit: 3 });
        await trade.sources();
        await trade.watchlists.list();
        await busyOnce(() => trade.watchlists.create({ name: 'Robots' }));
        await trade.watchlists.get('wl_1');
        await trade.watchlists.rename('wl_1', 'Robot makers');
        await trade.watchlists.add('wl_1', 'AAPL');
        await trade.watchlists.removeItem('wl_1', 'AAPL');
        await trade.watchlists.remove('wl_1');
        await trade.alerts.list();
        await trade.alerts.deliveries({ limit: 10 });
        await busyOnce(() => trade.alerts.create({ symbol: 'AAPL', kind: 'filing_type', form_types: ['8-K'] }));
        await trade.alerts.remove('alr_1');
        const tr = mark();
        assert.deepStrictEqual(tr.map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/instruments/resolve?q=AAPL', 'GET /api/v1/instruments?limit=5', 'GET /api/v1/instruments/AAPL',
            'GET /api/v1/instruments/AAPL/observations?metric=price&limit=30', 'GET /api/v1/instruments/AAPL/documents?limit=3', 'GET /api/v1/sources',
            'GET /api/v1/watchlists', 'POST /api/v1/watchlists', 'GET /api/v1/watchlists/wl_1', 'PATCH /api/v1/watchlists/wl_1', 'PATCH /api/v1/watchlists/wl_1',
            'PUT /api/v1/watchlists/wl_1/items/AAPL', 'PUT /api/v1/watchlists/wl_1/items/AAPL', 'DELETE /api/v1/watchlists/wl_1/items/AAPL',
            'DELETE /api/v1/watchlists/wl_1/items/AAPL', 'DELETE /api/v1/watchlists/wl_1', 'DELETE /api/v1/watchlists/wl_1', 'GET /api/v1/alerts',
            'GET /api/v1/alerts/deliveries?limit=10', 'POST /api/v1/alerts', 'DELETE /api/v1/alerts/alr_1', 'DELETE /api/v1/alerts/alr_1',
        ]);
        assert.throws(() => trade.alerts.create({ symbol: 'AAPL', kind: 'rumour' }), /kind/);
        assert.throws(() => trade.watchlists.create({}), /name/);

        // ── Space ─────────────────────────────────────────────
        const space = createSpaceClient(client);
        mark = since();
        await space.projects.list();
        await busyOnce(() => space.projects.create({ name: 'my-site' }));
        await space.projects.members.set('prj_1', 'app:app_9', 'deployer');
        await space.projects.sites('prj_1');
        await busyOnce(() => space.sites.create('prj_1', { name: 'docs' }));
        await space.sites.config.set('site_1', { spa: true, headers: { 'X-Frame-Options': 'DENY' } });
        await busyOnce(() => space.deploys.uploadArchive('site_1', Buffer.from('fake tar.gz bytes'), { activate: true }));
        await busyOnce(() => space.deploys.uploadFiles('site_1', [{ path: 'index.html', data: '<h1>Hi</h1>', type: 'text/html' }, { path: 'css/site.css', data: 'h1{}' }], { preview: true }));
        await busyOnce(() => space.deploys.uploadSourceBuild('site_1', Buffer.from('tar'), { ref: 'main', commit_sha: 'a'.repeat(40), gzip: false }));
        await space.deploys.activate('dep_1', { expected_active: null });
        await space.deploys.rollback('site_1', { deploy_id: 'dep_0' });
        await space.deploys.log('dep_1');
        await busyOnce(() => space.domains.add('site_1', { hostname: 'docs.example.com' }));
        await space.domains.verify('dom_1');
        await space.domains.remove('dom_1');
        const sp = mark();
        assert.deepStrictEqual(sp.map((x) => `${x.method} ${x.url}`), [
            'GET /api/v1/projects', 'POST /api/v1/projects', 'PUT /api/v1/projects/prj_1/members/app%3Aapp_9', 'PUT /api/v1/projects/prj_1/members/app%3Aapp_9',
            'GET /api/v1/projects/prj_1/sites', 'POST /api/v1/projects/prj_1/sites', 'PUT /api/v1/sites/site_1/config', 'PUT /api/v1/sites/site_1/config',
            'POST /api/v1/sites/site_1/deploys?activate=1', 'POST /api/v1/sites/site_1/deploys?preview=1',
            `POST /api/v1/sites/site_1/source/deploys?ref=main&commit_sha=${'a'.repeat(40)}`, 'POST /api/v1/deploys/dep_1/activate',
            'POST /api/v1/deploys/dep_1/activate', 'POST /api/v1/sites/site_1/rollback', 'POST /api/v1/sites/site_1/rollback', 'GET /api/v1/deploys/dep_1/log',
            'POST /api/v1/sites/site_1/domains', 'POST /api/v1/domains/dom_1/verify', 'POST /api/v1/domains/dom_1/verify', 'DELETE /api/v1/domains/dom_1',
            'DELETE /api/v1/domains/dom_1',
        ]);
        // Uploads and creations surface the 503 (a second try would be a second deploy); settings, activate, rollback and verify are retried.
        assert.deepStrictEqual(sp[3].body, { role: 'deployer' });
        assert.deepStrictEqual(sp[7].body, { spa: true, headers: { 'X-Frame-Options': 'DENY' } });
        assert.strictEqual(sp[8].type, 'application/gzip', 'an archive is the body, gzip by default');
        assert.strictEqual(sp[8].raw, 'fake tar.gz bytes');
        assert.match(sp[9].type, /^multipart\/form-data; boundary=/);
        assert.match(sp[9].raw, /name="files"; filename="css\/site\.css"/, "each file's path is its part's filename");
        assert.match(sp[9].raw, /<h1>Hi<\/h1>/);
        assert.strictEqual(sp[10].type, 'application/x-tar');
        assert.deepStrictEqual(sp[12].body, { expected_active: null });
        assert.deepStrictEqual(sp[14].body, { deploy_id: 'dep_0' });
        assert.throws(() => space.projects.members.set('prj_1', 'usr_1', 'admin'), /deployer, maintainer or owner/);
        assert.throws(() => space.deploys.uploadFiles('site_1', []), /at least one/);
        assert.throws(() => space.deploys.uploadArchive('site_1'), /archive/);

        // Each product's token is for its own audience (Video's is the media hub's, openvibe.download).
        assert.deepStrictEqual([...new Set(audiences)].sort(), ['openvibe.actor', 'openvibe.blog', 'openvibe.coupons', 'openvibe.deals', 'openvibe.download', 'openvibe.food', 'openvibe.reviews', 'openvibe.run', 'openvibe.space', 'openvibe.trade', 'openvibe.wiki', 'openvibe.work', 'openvibe.zone']);
        assert.ok(seen.every((x) => x.auth === `Bearer tok-${{ food: 'openvibe.food', actor: 'openvibe.actor', run: 'openvibe.run', video: 'openvibe.download', work: 'openvibe.work', zone: 'openvibe.zone', blog: 'openvibe.blog', reviews: 'openvibe.reviews', wiki: 'openvibe.wiki', coupons: 'openvibe.coupons', deals: 'openvibe.deals', trade: 'openvibe.trade', space: 'openvibe.space' }[x.svc]}`));

        // Each client needs a core client.
        for (const make of [createFoodClient, createActorClient, createRunClient, createVideoClient, createWorkClient, createZoneClient, createBlogClient, createReviewsClient, createWikiClient, createCouponsClient, createDealsClient, createTradeClient, createSpaceClient]) assert.throws(() => make({}), /core client/);
        console.log('product modules (food, actor, run, video, work, zone, blog, reviews, wiki, coupons, deals, trade, space): all checks passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
