'use strict';
// openvibe-sdk/food, /actor, /run, /video, /work and /zone through a real core client against one local stub: every
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

const ULID = '01JAB2C3D4E5F6G7H8J9K0MNPQ';
const ids = { plan: `pln_${ULID}`, task: `tsk_${ULID}`, agent: `agt_${ULID}`, mem: `mem_${ULID}`, job: `job_${ULID}`, playlist: `vpl_${ULID}`, app: `wap_${ULID}`, project: `prj_${ULID}`, zone: `zon_${ULID}` };

(async () => {
    const seen = [];
    const attempts = {};
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const svc = req.url.split('/')[1];
            const url = req.url.slice(svc.length + 1);
            seen.push({ svc, method: req.method, url, idem: req.headers['idempotency-key'] || null, project: req.headers['x-ov-project'] || null, lastEvent: req.headers['last-event-id'] || null, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
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
        baseUrls: { food: `${base}/food`, actor: `${base}/actor`, run: `${base}/run`, 'media-hub': `${base}/video`, work: `${base}/work`, zone: `${base}/zone` },
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

        // Each product's token is for its own audience (Video's is the media hub's, openvibe.download).
        assert.deepStrictEqual([...new Set(audiences)].sort(), ['openvibe.actor', 'openvibe.download', 'openvibe.food', 'openvibe.run', 'openvibe.work', 'openvibe.zone']);
        assert.ok(seen.every((x) => x.auth === `Bearer tok-${{ food: 'openvibe.food', actor: 'openvibe.actor', run: 'openvibe.run', video: 'openvibe.download', work: 'openvibe.work', zone: 'openvibe.zone' }[x.svc]}`));

        // Each client needs a core client.
        for (const make of [createFoodClient, createActorClient, createRunClient, createVideoClient, createWorkClient, createZoneClient]) assert.throws(() => make({}), /core client/);
        console.log('product modules (food, actor, run, video, work, zone): all checks passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
