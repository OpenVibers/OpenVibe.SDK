'use strict';
/**
 * limits: per-actor fixed windows at a capability boundary (roadmap WS-R task 4): each actor is counted apart
 * (service principal, signed-in person, else address), a route's limits replace the defaults window by window, the
 * tightest exceeded window decides Retry-After, refusals are problem+json 429 before the handler runs, a null actor is
 * not counted, and the counters stay bounded.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createActorLimiter, defaultActor } = require('../src/limits');

function call(mw, req) {
    return new Promise((resolve) => {
        const headers = {};
        const res = { statusCode: 200, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, end: (body) => resolve({ status: res.statusCode, headers, body: body ? JSON.parse(body) : null, passed: false }) };
        mw(req, res, () => resolve({ status: 200, passed: true }));
    });
}

run([
    ['the actor: principal, then person, then address', () => {
        assert.equal(defaultActor({ principal: { sub: 'svc:live' }, user: { subject_id: 'usr_x' } }), 'svc:live');
        assert.equal(defaultActor({ principal: { legacy: true }, user: { subject_id: 'usr_x' } }), 'user:usr_x');
        assert.equal(defaultActor({ user: { id: 42 } }), 'user:42');
        assert.equal(defaultActor({ auth: { subject: 'usr_y' } }), 'user:usr_y');
        assert.equal(defaultActor({ ip: '203.0.113.9' }), 'ip:203.0.113.9');
    }],
    ['each actor has its own window; the route decides; 429 before the handler', async () => {
        let t = 1_000_000_000;
        const limits = createActorLimiter({ limits: { minute: 100, hour: 1000 }, now: () => t });
        const mw = limits('media.object.upload', { minute: 2 });
        const a = { principal: { sub: 'svc:live' } };
        const b = { principal: { sub: 'svc:tools' } };
        assert.equal((await call(mw, a)).passed, true);
        assert.equal((await call(mw, a)).passed, true);
        const refused = await call(mw, a);
        assert.equal(refused.status, 429);
        assert.equal(refused.headers['content-type'], 'application/problem+json');
        assert.equal(refused.body.code, 'rate_limited');
        assert.ok(Number(refused.headers['retry-after']) >= 1 && Number(refused.headers['retry-after']) <= 60);
        assert.equal((await call(mw, b)).passed, true, 'another actor is not affected');
        t += 60_000;
        assert.equal((await call(mw, a)).passed, true, 'a new minute');
        assert.deepEqual([limits.stats().limited, limits.stats().allowed], [1, 4]);
    }],
    ['the tightest exceeded window decides Retry-After; a null actor is not counted', async () => {
        let t = 1_000_000_000;
        const limits = createActorLimiter({ limits: { minute: 5, hour: 3 }, now: () => t, actor: (req) => req.who || null });
        const mw = limits('x.y.z');
        for (let i = 0; i < 3; i++) assert.equal((await call(mw, { who: 'p' })).passed, true);
        const r = await call(mw, { who: 'p' });
        assert.equal(r.status, 429);
        assert.ok(Number(r.headers['retry-after']) > 60, 'the hour window, not the minute');
        for (let i = 0; i < 10; i++) assert.equal((await call(mw, {})).passed, true, 'uncounted');
    }],
    ['counters stay bounded; bad windows are refused at setup', async () => {
        const limits = createActorLimiter({ limits: { minute: 1 }, maxActors: 10 });
        const mw = limits('a.b.c');
        for (let i = 0; i < 50; i++) await call(mw, { ip: `198.51.100.${i}` });
        assert.equal(limits.stats().actors, 10);
        assert.throws(() => createActorLimiter({ limits: { week: 1 } }), /unknown window/);
        assert.throws(() => limits(''), /names its capability/);
    }],
]);
