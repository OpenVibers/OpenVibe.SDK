'use strict';
/**
 * Developer-app events: projectKey/appSource/createAppEvents, and the mock platform's Events playing
 * OpenVibe.Events' events.app.* rules (type prefix, source, actor, read and subscription scope, https
 * endpoints, sandbox/production separation, first-party readers, deliveries, realtime).
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createClient } = require('../src/core');
const { createServiceTokenClient } = require('../src/auth');
const { createEventsClient, projectKey, appSource, createAppEvents } = require('../src/events');
const { createMockPlatform } = require('../src/testing');

const P1 = 'prj_01K5WZX7S7Q4D2B8N3M6V1C9TA';
const P2 = 'prj_01K5WZX7S7Q4D2B8N3M6V1C9TB';
const A = 'app_01K5WZX7S7Q4D2B8N3M6V1C9T1';       // P1 sandbox
const A2 = 'app_01K5WZX7S7Q4D2B8N3M6V1C9T2';      // P1 production
const B = 'app_01K5WZX7S7Q4D2B8N3M6V1C9T3';       // P2 sandbox
const R = 'app_01K5WZX7S7Q4D2B8N3M6V1C9T4';       // P1 sandbox, read only
const K1 = 'p01k5wzx7s7q4d2b8n3m6v1c9ta';
const ALL = ['events.app.publish', 'events.app.read', 'events.app.subscribe'];

function setup() {
    const platform = createMockPlatform({
        clients: {
            live: { secret: 'live-secret', grants: [['events.event.publish', 'openvibe.events'], ['events.event.read', 'openvibe.events'], ['events.subscription.manage', 'openvibe.events']] },
        },
        apps: {
            [A]: { project: P1, env: 'sandbox', secret: 'a', grants: ALL },
            [A2]: { project: P1, env: 'production', secret: 'a2', grants: ALL },
            [B]: { project: P2, env: 'sandbox', secret: 'b', grants: ALL },
            [R]: { project: P1, env: 'sandbox', secret: 'r', grants: ['events.app.read'] },
        },
    });
    const clientFor = (id, secret) => createClient({ fetch: platform.fetch, retries: 0, tokenProvider: createServiceTokenClient({ clientId: id, clientSecret: secret, fetch: platform.fetch }) });
    const live = createEventsClient(clientFor('live', 'live-secret'), { source: 'live' });
    return {
        platform, live, clientFor,
        a: createAppEvents(clientFor(A, 'a'), { projectId: P1, appId: A }),
        a2: createAppEvents(clientFor(A2, 'a2'), { projectId: P1, appId: A2 }),
        b: createAppEvents(clientFor(B, 'b'), { projectId: P2, appId: B }),
        r: createAppEvents(clientFor(R, 'r'), { projectId: P1, appId: R }),
    };
}
const order = { event_type: 'order.shipped', subject: { type: 'order', id: 'o1' }, payload: { n: 1 } };
const ids = (page) => page.events.map((e) => e.event.event_id);

run([
    ['projectKey and appSource derive the names Events expects', async () => {
        assert.equal(projectKey('prj_01JAB2C3D4E5F6G7H8J9K0MNPQ'), 'p01jab2c3d4e5f6g7h8j9k0mnpq');
        assert.equal(appSource('app_01JAB2C3D4E5F6G7H8J9K0MNPQ'), 'app-01jab2c3d4e5f6g7h8j9k0mnpq');
        assert.equal(appSource('app:app_01JAB2C3D4E5F6G7H8J9K0MNPQ'), 'app-01jab2c3d4e5f6g7h8j9k0mnpq');
        assert.equal(projectKey('prj_bad'), null);
        assert.equal(projectKey('app_01JAB2C3D4E5F6G7H8J9K0MNPQ'), null);
        assert.equal(appSource('svc:live'), null);
        assert.equal(appSource('app_01jab2c3d4e5f6g7h8j9k0mnpq'), null, 'ids are upper-case ULIDs');
    }],

    ['createAppEvents: ids checked, project-relative names and patterns', async () => {
        const client = createClient({ fetch: () => { throw new Error('no calls'); } });
        assert.throws(() => createAppEvents(client, { projectId: 'prj_x', appId: A }), TypeError);
        assert.throws(() => createAppEvents(client, { projectId: P1, appId: 'svc:live' }), TypeError);
        const ev = createAppEvents(client, { projectId: P1, appId: A });
        assert.equal(ev.projectKey, K1);
        assert.equal(ev.source, appSource(A));
        assert.equal(ev.prefix, `app.${K1}.`);
        assert.equal(ev.topic('order.shipped'), `app.${K1}.order.shipped`);
        assert.equal(ev.topic('*'), `app.${K1}.*`);
        assert.equal(ev.topic(`app.${K1}.order.*`), `app.${K1}.order.*`, 'full names are kept');
        assert.throws(() => ev.topic('app.p01k5wzx7s7q4d2b8n3m6v1c9tb.x'), /another project/);
        const e = ev.prepare({ ...order });
        assert.equal(e.event_type, `app.${K1}.order.shipped`);
        assert.equal(e.source, appSource(A));
        assert.deepEqual(e.actor, { type: 'app', id: A });
        assert.match(e.event_id, /^evt_/);
        assert.deepEqual(ev.prepare({ event_type: 'ping' }).subject, { type: 'app', id: A }, 'subject defaults to the app');
        const user = createAppEvents(client, { projectId: P1, appId: A, onBehalfOf: 'usr_01K5WZX7S7Q4D2B8N3M6V1C9TU' });
        assert.deepEqual(user.prepare({ ...order }).actor, { type: 'user', id: 'usr_01K5WZX7S7Q4D2B8N3M6V1C9TU' });
        assert.throws(() => ev.prepare({ ...order, source: 'live' }), TypeError);
        assert.throws(() => ev.prepare({ ...order, event_type: 'Order.Shipped' }), TypeError);
        assert.throws(() => ev.pull({ platformTopics: ['*'] }), TypeError);
        assert.throws(() => ev.pull({ platformTopics: [`app.${K1}.*`] }), TypeError);
    }],

    ['publish: the app prefix, source and actor; everything else is refused like Events does', async () => {
        const { platform, a, clientFor } = setup();
        const out = await a.publish({ ...order });
        assert.equal(out.duplicate, false);
        const stored = platform.state.events.at(-1);
        assert.equal(stored.event.event_type, `app.${K1}.order.shipped`);
        assert.equal(stored.event.source, appSource(A));
        assert.deepEqual(stored.event.actor, { type: 'app', id: A });
        assert.equal(stored.project_id, P1);
        assert.equal(stored.env, 'sandbox');
        assert.equal(stored.publisher, `app:${A}`);
        assert.equal((await a.publish({ ...order, event_id: stored.event.event_id })).duplicate, true, 'safe to retry');
        assert.equal((await a.publish([{ event_type: 'x.one' }, { event_type: 'x.two' }])).results.length, 2);

        const raw = a.events;             // unscoped: nothing is filled in beyond the source
        const env = (over) => ({ event_type: `app.${K1}.order.shipped`, actor: { type: 'app', id: A }, subject: { type: 'order', id: 'o1' }, ...over });
        await assert.rejects(raw.publish(env({ event_type: 'app.p01k5wzx7s7q4d2b8n3m6v1c9tb.order.shipped' })), { status: 403, code: 'events.type_not_allowed' });
        await assert.rejects(raw.publish(env({ event_type: 'live.stream.started' })), { status: 403, code: 'events.type_not_allowed' });
        await assert.rejects(raw.publish(env({ source: 'live' })), { status: 403, code: 'events.source_mismatch' });
        await assert.rejects(raw.publish(env({ source: appSource(B) })), { status: 403, code: 'events.source_mismatch' });
        await assert.rejects(raw.publish(env({ actor: { type: 'app', id: B } })), { status: 403, code: 'events.actor_mismatch' });
        await assert.rejects(raw.publish(env({ actor: { type: 'user', id: 'usr_01K5WZX7S7Q4D2B8N3M6V1C9TU' } })), { status: 403, code: 'events.actor_mismatch' });

        // The user the token acts for may be the actor.
        const usr = 'usr_01K5WZX7S7Q4D2B8N3M6V1C9TU';
        const obo = createClient({ fetch: platform.fetch, token: platform.signAppToken(A, { audience: 'openvibe.events', capabilities: ['events.app.publish'], onBehalfOf: usr }) });
        assert.equal((await createAppEvents(obo, { projectId: P1, appId: A, onBehalfOf: usr }).publish({ ...order })).duplicate, false);

        // events.app.publish is required; first-party services never publish into app.*.
        const r = createAppEvents(clientFor(R, 'r'), { projectId: P1, appId: R });
        await assert.rejects(r.publish({ ...order }), { status: 403, code: 'capability.denied' });
        const live = createEventsClient(clientFor('live', 'live-secret'), { source: 'live' });
        await assert.rejects(live.publish({ event_type: `app.${K1}.order.shipped`, actor: { type: 'service', id: 'live' }, subject: { type: 'x', id: '1' } }), { status: 403, code: 'events.type_not_allowed' });
        // A first-party capability in an app token is never honoured.
        const sneaky = createClient({ fetch: platform.fetch, token: platform.signAppToken(A, { audience: 'openvibe.events', capabilities: ['events.event.publish', 'events.event.read'] }) });
        await assert.rejects(createEventsClient(sneaky).pull({ topic: `app.${K1}.*` }), { status: 403, code: 'capability.denied' });
    }],

    ['reads: own project in the same env, public first-party events, never another project', async () => {
        const { platform, a, a2, b, r, live } = setup();
        const sbx = await a.publish({ ...order });
        const prod = await a2.publish({ ...order });
        const other = await b.publish({ ...order });
        const pub = platform.publishEvent({ event_type: 'live.stream.started', source: 'live', actor: { type: 'service', id: 'live' }, subject: { type: 'stream', id: '1' }, visibility: 'public' });
        platform.publishEvent({ event_type: 'live.stream.ended', source: 'live', actor: { type: 'service', id: 'live' }, subject: { type: 'stream', id: '1' } });

        assert.deepEqual(ids(await r.pull()), [sbx.event_id], 'another app of the project, same env');
        assert.deepEqual(ids(await a.pull({ topic: 'order.*' })), [sbx.event_id], 'a sandbox app never sees production events');
        assert.deepEqual(ids(await a2.pull()), [prod.event_id], 'a production app never sees sandbox events');
        assert.deepEqual(ids(await b.pull()), [other.event_id]);
        assert.deepEqual(ids(await a.pull({ platformTopics: ['live.*'] })), [sbx.event_id, pub.event_id], 'public first-party only, never internal');
        await assert.rejects(b.events.pull({ topic: `app.${K1}.*` }), { status: 403, code: 'events.topic_not_allowed' });
        await assert.rejects(b.events.pull({ topic: '*' }), { status: 403, code: 'events.topic_not_allowed' });
        await assert.rejects(b.events.pull({ topic: '*.shipped' }), { status: 403, code: 'events.topic_not_allowed' });
        await assert.rejects(b.events.pull({ topic: 'Bad Topic' }), { status: 400, code: 'events.bad_topic' });
        assert.equal((await a.get(sbx.event_id)).event.event_id, sbx.event_id);
        assert.equal(await b.get(sbx.event_id), null, 'another project\'s event does not exist for this app');
        assert.equal(await a2.get(sbx.event_id), null);
        const seen = [];
        for await (const item of a.iterate({ topic: '*', platformTopics: ['live.stream.*'] })) seen.push(item.event.event_id);
        assert.deepEqual(seen, [sbx.event_id, pub.event_id]);

        // First-party readers: never sandbox; app events only through an app.* pattern.
        assert.ok(!(await live.pull({ topic: '*' })).events.some((e) => e.event.event_type.startsWith('app.')));
        assert.deepEqual(ids(await live.pull({ topic: 'app.*' })), [prod.event_id]);
        assert.equal(await live.get(sbx.event_id), null);
        assert.equal((await live.get(prod.event_id)).event.event_id, prod.event_id);

        // Checkpoints are per app and scoped the same way.
        const cp = await a.setCheckpoint('*', 5);
        assert.equal(cp.consumer, `app:${A}`);
        assert.equal(cp.topic, `app.${K1}.*`);
        assert.equal((await a.getCheckpoint('*')).cursor, 5);
        assert.equal((await r.getCheckpoint('*')).cursor, 0, 'another app has its own');
        await assert.rejects(b.events.getCheckpoint(`app.${K1}.*`), { status: 403, code: 'events.topic_not_allowed' });
    }],

    ['subscriptions: own topics, public https endpoints; deliveries keep projects and environments apart', async () => {
        const { platform, a, a2, b, r, live } = setup();
        const sa = await a.subscribe({ endpoint: 'https://hooks.example.com/a' });
        assert.equal(sa.topic_pattern, `app.${K1}.*`);
        assert.equal(sa.consumer, `app:${A}`);
        assert.equal(sa.project_id, P1);
        assert.equal(sa.env, 'sandbox');
        assert.match(sa.secret, /^whsec_/);
        await a.subscriptions.create({ topicPattern: 'order.*', endpoint: 'https://hooks.example.com/orders', secret: 'x'.repeat(32) });
        assert.equal((await a.subscriptions.create({ topicPattern: 'live.*', endpoint: 'https://hooks.example.com/nope' })).topic_pattern, `app.${K1}.live.*`, 'relative: inside the project');
        assert.equal((await a.events.subscriptions.create({ topicPattern: 'live.*', endpoint: 'https://hooks.example.com/public' })).topic_pattern, 'live.*', 'a first-party pattern (public events only)');
        for (const endpoint of ['http://hooks.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://intranet/x', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com./x', 'https://[::1]/x']) {
            await assert.rejects(a.subscribe({ endpoint }), { status: 422, code: 'events.endpoint_not_allowed' }, endpoint);
        }
        await assert.rejects(a.events.subscriptions.create({ topicPattern: '*', endpoint: 'https://hooks.example.com/x' }), { status: 403, code: 'events.topic_not_allowed' });
        await assert.rejects(a.subscribe({ endpoint: 'https://hooks.example.com/a' }), { status: 409, code: 'events.subscription_exists' });
        await assert.rejects(a.subscribe({ endpoint: 'https://hooks.example.com/s', secret: 'short' }), { status: 422 });
        await assert.rejects(r.subscribe({ endpoint: 'https://hooks.example.com/r' }), { status: 403, code: 'capability.denied' });
        await a2.subscribe({ endpoint: 'https://hooks.example.com/prod' });
        await b.subscribe({ endpoint: 'https://hooks.example.com/b' });
        await live.subscribe({ topicPattern: 'app.*', endpoint: 'https://live.openvibe.live/hook' });
        await live.subscribe({ topicPattern: 'live.*', endpoint: 'https://live.openvibe.live/svc-live' });

        assert.equal((await a.subscriptions.list()).length, 4);
        assert.equal((await b.subscriptions.list()).length, 1);
        assert.equal(await b.subscriptions.get(sa.id), null);
        assert.equal(await a2.subscriptions.get(sa.id), null, 'another app of the project cannot see it');
        await assert.rejects(a2.subscriptions.disable(sa.id), { status: 404 });

        const e1 = await a.publish({ ...order });
        const e2 = await a2.publish({ ...order });
        const pub = platform.publishEvent({ event_type: 'live.stream.started', source: 'live', actor: { type: 'service', id: 'live' }, subject: { type: 'stream', id: '1' }, visibility: 'public' });
        const calls = [];
        const round = await platform.deliverEvents({ fetch: async (url, init) => { calls.push({ path: new URL(url).pathname, id: init.headers['X-OpenVibe-Event-Id'] }); return new Response(null, { status: 204 }); } });
        assert.equal(round.failed, 0);
        const at = (p) => calls.filter((c) => c.path === p).map((c) => c.id);
        assert.deepEqual(at('/a'), [e1.event_id], 'own sandbox event only');
        assert.deepEqual(at('/orders'), [e1.event_id]);
        assert.deepEqual(at('/prod'), [e2.event_id], 'a sandbox event never reaches a production subscription');
        assert.deepEqual(at('/b'), [], 'never another project');
        assert.deepEqual(at('/hook'), [e2.event_id], 'first-party app.* subscribers: production app events only');
        assert.deepEqual(at('/svc-live'), [pub.event_id]);
        assert.deepEqual(at('/public'), [pub.event_id], 'an app gets public first-party events');
        assert.deepEqual(at('/nope'), []);
    }],

    ['realtime never streams app events; app tokens are refused there', async () => {
        const { platform, a, a2 } = setup();
        const url = `${platform.origins.events}/realtime/stream?topics=*`;
        const sbx = platform.signAppToken(A, { audience: 'openvibe.events', capabilities: ['events.app.read'] });
        const prod = platform.signAppToken(A2, { audience: 'openvibe.events', capabilities: ['events.app.read'] });
        const refused = await platform.fetch(url, { headers: { authorization: `Bearer ${sbx}` } });
        assert.equal(refused.status, 401);
        assert.equal((await refused.json()).code, 'token.sandbox_refused');
        const denied = await platform.fetch(url, { headers: { authorization: `Bearer ${prod}` } });
        assert.equal(denied.status, 403, 'apps never hold events.event.read');
        assert.equal((await denied.json()).code, 'capability.denied');

        const ctl = new AbortController();
        const res = await platform.fetch(url, { signal: ctl.signal });
        const reader = res.body.getReader();
        await a.publish({ ...order });
        await a2.publish({ ...order });
        const pub = platform.publishEvent({ event_type: 'live.stream.started', source: 'live', actor: { type: 'service', id: 'live' }, subject: { type: 'stream', id: '1' }, visibility: 'public' });
        let text = '';
        while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value);
        const first = JSON.parse(text.split('data: ')[1].split('\n')[0]);
        assert.equal(first.event.event_id, pub.event_id, 'the first thing streamed is the public first-party event');
        ctl.abort();
        platform.dropRealtime();
    }],
]);
