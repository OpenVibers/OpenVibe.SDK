'use strict';
/**
 * openvibe-sdk/service: gracefulStop against a real http.Server on port 0 (exit injected, no signal handlers), the
 * error helpers' problem+json answers, jsonBody, jsonErrors and the lazy re-exports.
 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { run, sleep, waitFor } = require('./helpers');
const svc = require('../src/service');

const quiet = { log() {}, warn() {}, error() {} };

function recorder() {
    const lines = [];
    return { lines, log: (...a) => lines.push(['log', a.join(' ')]), warn: (...a) => lines.push(['warn', a.join(' ')]), error: (...a) => lines.push(['error', a.join(' ')]) };
}

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** GET/POST with node:http so the Connection header and the socket are visible. */
function request(url, { method = 'GET', agent, headers = {}, body, onResponse } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, agent, headers }, (res) => {
            if (onResponse) onResponse(res);
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the error tests skip */ }

const errorTests = [
    ['run: the return value is the body; refusals are problems with status, code, detail and extra spread', async () => {
        const log = recorder();
        const ApiError = svc.createServiceError('ApiError');
        const o = { name: 'Blog API', log };
        const { server, url } = await listen((req, res) => {
            req.ov = { requestId: 'req_1', traceId: 't'.repeat(32) };
            const routes = {
                '/ok': svc.run(async () => ({ hi: 1 }), 200, o),
                '/created': svc.run(async () => ({ id: 'p1' }), (out) => (out.id ? 201 : 200), o),
                '/missing': svc.run(async () => { throw new ApiError(404, 'post.not_found', 'No such post', { id: 'p1' }); }, 200, o),
                '/boom': svc.run(async () => { throw new Error('db password leaked in message'); }, 200, o),
                '/busy': svc.run(async () => { throw new ApiError(503, 'search.unavailable', 'Try later'); }, 200, o),
                '/bad-gateway': svc.run(async () => { throw new ApiError(502, 'billing.unreachable', 'Billing is down'); }, 200, o),
                '/plain-400': svc.run(async () => { throw Object.assign(new Error('nope'), { status: 400 }); }, 200, o),
                '/self': svc.run(async (rq, rs) => { rs.statusCode = 204; rs.end(); }, 200, o),
                '/nostore': svc.run(async () => ({ me: 1 }), 200, { ...o, noStore: true }),
                '/reviews-log': svc.run(async () => { throw new Error('x'); }, 200, log),
            };
            routes[req.url](req, res);
        });
        try {
            let r = await request(`${url}/ok`);
            assert.equal(r.status, 200);
            assert.deepEqual(r.json, { hi: 1 });
            assert.match(r.headers['content-type'], /^application\/json/);
            assert.equal((await request(`${url}/created`)).status, 201);

            r = await request(`${url}/missing`);
            assert.equal(r.status, 404);
            assert.equal(r.headers['content-type'], 'application/problem+json');
            assert.equal(r.json.code, 'post.not_found');
            assert.equal(r.json.detail, 'No such post');
            assert.equal(r.json.id, 'p1', 'extra is spread by default');
            assert.equal(r.json.request_id, 'req_1');
            assert.equal(r.json.type, 'https://openvibe.network/problems/post.not_found');
            assert.equal(log.lines.length, 0, 'a refusal is not logged');

            r = await request(`${url}/boom`);
            assert.equal(r.status, 500);
            assert.equal(r.json.code, 'internal.error');
            assert.equal(r.json.detail, 'Internal error');
            assert.ok(!r.text.includes('password'));
            assert.equal(log.lines.length, 1);
            assert.match(log.lines[0][1], /^\[Blog API\] Error: db password/);

            r = await request(`${url}/busy`);
            assert.equal(r.status, 503);
            assert.equal(r.json.code, 'search.unavailable');
            assert.equal(r.json.detail, 'Try later');
            assert.equal(log.lines.length, 1, '503 is not logged');
            r = await request(`${url}/bad-gateway`);
            assert.equal(r.status, 502);
            assert.equal(r.json.detail, 'Billing is down', 'only 500 hides the detail');
            assert.equal(log.lines.length, 2, 'other 5xx are logged');

            r = await request(`${url}/plain-400`);
            assert.equal(r.status, 400);
            assert.equal(r.json.code, 'request.invalid');
            assert.equal(r.json.detail, 'nope');

            assert.equal((await request(`${url}/self`)).status, 204);
            r = await request(`${url}/nostore`);
            assert.equal(r.headers['cache-control'], 'private, no-store');
            assert.equal(r.headers.vary, 'Cookie, Authorization');

            r = await request(`${url}/reviews-log`);
            assert.equal(r.status, 500);
            assert.match(log.lines.at(-1)[1], /^\[service\]/, 'a logger as the third argument (Reviews run(fn, status, log))');
        } finally {
            server.close();
        }
    }],

    ['sendError/wrap: extra under details (Tips/VIP), internalCode/internalDetail, map, headers already sent', async () => {
        const TipsError = svc.createServiceError('TipsError');
        const tips = { name: 'Tips', log: quiet, extra: 'details', internalCode: 'tips.internal', internalDetail: 'internal error' };
        const inputError = (e) => (e && e.name === 'ValidationError' ? new TipsError(422, 'tips.invalid', e.message) : null);
        const { server, url } = await listen((req, res) => {
            const routes = {
                '/details': svc.wrap(async () => { throw new TipsError(409, 'tips.conflict', 'Already paid', { tip: 't1' }); }, tips),
                '/details-500': svc.wrap(async () => { throw new TipsError(502, 'tips.upstream', 'Billing', { tip: 't1' }); }, tips),
                '/internal': svc.wrap(async () => { throw new Error('boom'); }, tips),
                '/mapped': svc.wrap(async () => { throw Object.assign(new Error('amount must be positive'), { name: 'ValidationError' }); }, { ...tips, map: inputError }),
                '/sent': svc.wrap(async (rq, rs) => { rs.writeHead(200); rs.write('partial'); throw new Error('late'); }, tips),
                '/reviews': (rq, rs) => svc.sendError(rs, rq, new TipsError(403, 'tips.denied'), quiet),
                '/pg-code': (rq, rs) => svc.sendError(rs, rq, Object.assign(new Error('dup'), { code: '23505' }), quiet),
            };
            routes[req.url](req, res);
            if (req.url === '/sent') setTimeout(() => res.end(), 20);
        });
        try {
            let r = await request(`${url}/details`);
            assert.equal(r.status, 409);
            assert.deepEqual(r.json.details, { tip: 't1' });
            assert.equal(r.json.tip, undefined);
            r = await request(`${url}/details-500`);
            assert.equal(r.json.details, undefined, 'Tips nests extra only below 500');
            r = await request(`${url}/internal`);
            assert.equal(r.json.code, 'tips.internal');
            assert.equal(r.json.detail, 'internal error');
            r = await request(`${url}/mapped`);
            assert.equal(r.status, 422);
            assert.equal(r.json.code, 'tips.invalid');
            r = await request(`${url}/sent`);
            assert.equal(r.status, 200);
            assert.equal(r.text, 'partial');
            r = await request(`${url}/reviews`);
            assert.equal(r.status, 403);
            assert.equal(r.json.code, 'tips.denied');
            assert.equal(r.json.detail, 'tips.denied', 'no detail: the message, which is the code (Reviews)');
            r = await request(`${url}/pg-code`);
            assert.equal(r.status, 500);
            assert.equal(r.json.code, 'internal.error', "an unexpected error's own code never reaches the body");
        } finally {
            server.close();
        }
    }],

    ['createServiceError / asServiceError: the class, other services\' errors, publishing errors and TypeErrors', async () => {
        const ApiError = svc.createServiceError('ApiError');
        const e = new ApiError(404, 'post.not_found', 'No such post');
        assert.ok(e instanceof Error);
        assert.equal(ApiError.name, 'ApiError');
        assert.equal(e.name, 'ApiError');
        assert.deepEqual([e.status, e.code, e.detail, e.message, e.extra], [404, 'post.not_found', 'No such post', 'No such post', null]);
        assert.equal(new ApiError(400, 'x.y').message, 'x.y');
        assert.equal(svc.asServiceError(e), e);
        const other = Object.assign(new Error('Over quota'), { status: 429, code: 'billing.quota' });
        assert.equal(svc.asServiceError(other), other, 'any error with an HTTP status and a code');
        assert.equal(svc.asServiceError(new Error('x')), null);
        assert.equal(svc.asServiceError(Object.assign(new Error('pg'), { code: '23505' })), null);

        const pub = Object.assign(new Error('Stale revision'), { name: 'PublishingError', status: 409, code: 'revision.conflict', expected: 3, current: 4 });
        assert.equal(svc.asServiceError(Object.assign(new Error('x'), { name: 'PublishingError', status: 409 })), null, 'publishing is opt-in');
        const mapped = svc.asServiceError(pub, { publishing: true, ServiceError: ApiError });
        assert.ok(mapped instanceof ApiError);
        assert.deepEqual([mapped.status, mapped.code, mapped.message, mapped.extra], [409, 'revision.conflict', 'Stale revision', { expected: 3, current: 4 }]);
        const te = svc.asServiceError(new TypeError('title must be a string'), { publishing: true });
        assert.deepEqual([te.status, te.code, te.message], [422, 'request.invalid', 'title must be a string']);
        assert.equal(svc.asServiceError(new TypeError("Cannot read properties of undefined (reading 'x')"), { publishing: true }), null, 'a bug stays a 500');
    }],

    ['jsonBody: malformed JSON is 400 request.invalid_json; too large 413; only JSON bodies; strict; gzip; a given parser', async () => {
        const seen = [];
        const small = svc.jsonBody({ limit: 64 });
        const def = svc.jsonBody();
        const given = svc.jsonBody({ parser: (req, res, next) => next(Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed', status: 400 })) });
        const { server, url } = await listen((req, res) => {
            const mw = req.url === '/small' ? small : req.url === '/given' ? given : def;
            mw(req, res, () => { seen.push(req.body); res.end('ok'); });
        });
        const post = (p, body, headers = { 'Content-Type': 'application/json' }) => request(`${url}${p}`, { method: 'POST', body, headers });
        try {
            let r = await post('/', '{"a":');
            assert.equal(r.status, 400);
            assert.equal(r.headers['content-type'], 'application/problem+json');
            assert.equal(r.json.code, 'request.invalid_json');
            assert.equal(r.json.detail, 'Malformed JSON body');
            assert.equal((await post('/', '"just a string"')).json.code, 'request.invalid_json', 'objects and arrays only, as express.json()');

            r = await post('/', '{"a":[1,2]}');
            assert.equal(r.text, 'ok');
            assert.deepEqual(seen.pop(), { a: [1, 2] });
            await post('/', '{"a":1}', { 'Content-Type': 'application/merge-patch+json; charset=utf-8' });
            assert.deepEqual(seen.pop(), { a: 1 });
            await post('/', '', { 'Content-Type': 'application/json' });
            assert.deepEqual(seen.pop(), {});
            await post('/', 'a=1', { 'Content-Type': 'application/x-www-form-urlencoded' });
            assert.deepEqual(seen.pop(), {}, 'not JSON: left for another parser');
            await post('/', zlib.gzipSync('{"z":true}'), { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
            assert.deepEqual(seen.pop(), { z: true });

            r = await post('/small', JSON.stringify({ text: 'x'.repeat(100) }));
            assert.equal(r.status, 413);
            assert.equal(r.json.code, 'request.too_large');
            r = await post('/small', JSON.stringify({ text: 'x'.repeat(100) }), { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
            assert.equal(r.status, 413, 'a chunked body is counted as it arrives');
            r = await post('/', '{}', { 'Content-Type': 'application/json', 'Content-Encoding': 'compress' });
            assert.equal(r.status, 415);

            r = await post('/given', '{');
            assert.equal(r.status, 400);
            assert.equal(r.json.code, 'request.invalid_json');
            assert.throws(() => svc.jsonBody({ limit: 'lots' }), /not a size/);
        } finally {
            server.close();
        }
    }],

    ['jsonErrors: problems under /api/ and /internal/, text/plain for pages', async () => {
        const log = recorder();
        const [notFound, errorHandler] = svc.jsonErrors({ name: 'Bot', log });
        const ApiError = svc.createServiceError('ApiError');
        const errors = {
            '/api/parse': Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed', status: 400 }),
            '/api/big': Object.assign(new Error('x'), { type: 'entity.too.large', status: 413 }),
            '/internal/refused': new ApiError(422, 'bot.refused', 'No'),
            '/api/boom': new Error('boom'),
            '/page/boom': new Error('page boom'),
        };
        const { server, url } = await listen((req, res) => {
            req.path = req.url;
            if (errors[req.url]) return errorHandler(errors[req.url], req, res, () => {});
            return notFound(req, res);
        });
        try {
            let r = await request(`${url}/api/nothing`);
            assert.equal(r.status, 404);
            assert.equal(r.json.code, 'not_found');
            r = await request(`${url}/nothing`);
            assert.equal(r.status, 404);
            assert.match(r.headers['content-type'], /^text\/plain/);
            assert.equal(r.text, 'Not found\n');
            assert.equal((await request(`${url}/api/parse`)).json.code, 'request.invalid_json');
            assert.equal((await request(`${url}/api/big`)).status, 413);
            r = await request(`${url}/internal/refused`);
            assert.deepEqual([r.status, r.json.code, r.json.detail], [422, 'bot.refused', 'No']);
            r = await request(`${url}/api/boom`);
            assert.deepEqual([r.status, r.json.code], [500, 'internal.error']);
            r = await request(`${url}/page/boom`);
            assert.equal(r.status, 500);
            assert.equal(r.text, 'Something went wrong\n');
            assert.equal(log.lines.length, 2);
            assert.equal(svc.jsonErrors({ notFound: false }).length, 1);
        } finally {
            server.close();
        }
    }],
];

run([
    ['gracefulStop: in flight gets Connection: close and finishes, idle keep-alive closed, SSE destroyed, steps in order', async () => {
        const order = [];
        let release;
        const slowGate = new Promise((r) => { release = r; });
        let slowArrived = false;
        let idleSocket = null;
        const { server, url } = await listen((req, res) => {
            if (req.url === '/fast') { idleSocket = req.socket; return res.end('fast'); }
            if (req.url === '/sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.write(': hi\n\n'); }
            slowArrived = true;
            res.on('finish', () => order.push('slow finished'));
            return slowGate.then(() => res.end('done'));
        });
        server.keepAliveTimeout = 65000;
        const exits = [];
        const g = svc.gracefulStop({
            name: 'T', server, signals: false, log: quiet, exit: (c) => exits.push(c),
            stop: [() => order.push('stop 1'), async () => { await sleep(5); order.push('stop 2'); }],
            beforeDrain: (signal) => order.push(`beforeDrain ${signal}`),
            close: [async () => { await sleep(5); order.push('close 1'); }, () => order.push('close 2')],
            handles: { close: async () => order.push('handle') },
        });
        const agent = new http.Agent({ keepAlive: true, maxSockets: 10 });
        try {
            const fast = await request(`${url}/fast`, { agent });
            assert.equal(fast.text, 'fast');
            assert.ok(idleSocket && !idleSocket.destroyed, 'the keep-alive socket is idle and open');
            let sseClosed = false;
            const sseOpen = new Promise((resolve) => {
                const rq = http.get(`${url}/sse`, { agent: false }, (res) => {
                    res.once('data', resolve);
                    res.on('close', () => { sseClosed = true; });
                    res.on('error', () => {});
                });
                rq.on('error', () => { sseClosed = true; });
            });
            await sseOpen;
            const slow = request(`${url}/slow`, { agent: false });
            await waitFor(() => slowArrived);

            assert.equal(g.stopping(), false);
            const stopped = g.stop('SIGTERM');
            assert.equal(g.stopping(), true, 'stopping() turns true at once (a readiness flip)');
            await waitFor(() => idleSocket.destroyed);
            await waitFor(() => sseClosed);
            assert.ok(!order.includes('close 1'), 'close steps wait for the drain');
            release();
            const r = await slow;
            assert.equal(r.text, 'done');
            assert.equal(r.headers.connection, 'close');
            assert.equal(await stopped, 0);
            assert.deepEqual(order, ['stop 1', 'stop 2', 'beforeDrain SIGTERM', 'slow finished', 'close 1', 'close 2', 'handle']);
            assert.deepEqual(exits, [0]);
            assert.equal(server.listening, false);
        } finally {
            agent.destroy();
            server.closeAllConnections();
            server.close();
        }
    }],

    ['gracefulStop: the deadline exits with deadlineExitCode (1 by default, 0 for the 5 s family), once', async () => {
        const { server, url } = await listen(() => { /* never answers */ });
        const exits = [];
        const log = recorder();
        const g = svc.gracefulStop({ name: 'Net', server, signals: false, log, exit: (c) => exits.push(c), drainMs: 300, deadlineMs: 100 });
        const hanging = request(`${url}/hang`, { agent: false }).catch(() => 'cut');
        await sleep(30);
        const t0 = Date.now();
        assert.equal(await g.stop(), 1);
        assert.ok(Date.now() - t0 < 280, 'the deadline, not the drain');
        assert.deepEqual(exits, [1]);
        assert.ok(log.lines.some(([lvl, l]) => lvl === 'error' && /longer than 100 ms: exiting 1/.test(l)));
        assert.equal(await hanging, 'cut', 'the drain cut it later');
        await sleep(50);
        assert.deepEqual(exits, [1], 'exit is called once even when the stop finishes later');

        const exits0 = [];
        const g0 = svc.gracefulStop({ name: 'Blog', signals: false, log: quiet, exit: (c) => exits0.push(c), deadlineMs: 50, deadlineExitCode: 0, stop: [() => new Promise(() => {})] });
        assert.equal(await g0.stop('SIGTERM'), 0);
        assert.deepEqual(exits0, [0]);
    }],

    ['gracefulStop: a drain timeout with no requests does not log a cut', async () => {
        const server = new EventEmitter();
        let closeAllCalls = 0;
        server.close = () => { /* hold the close callback until the drain timeout */ };
        server.closeIdleConnections = () => {};
        server.closeAllConnections = () => { closeAllCalls++; };
        const log = recorder();
        const exits = [];
        const g = svc.gracefulStop({ name: 'T', server, signals: false, log, exit: (c) => exits.push(c), drainMs: 20, deadlineMs: 200 });
        assert.equal(await g.stop(), 0);
        assert.equal(closeAllCalls, 1, 'the drain timeout ran');
        assert.deepEqual(exits, [0]);
        assert.ok(!log.lines.some(([, line]) => /request\(s\).*cut/.test(line)), 'no request was cut');
    }],

    ['gracefulStop: a second signal does not start a second stop', async () => {
        const { server } = await listen((req, res) => res.end());
        const exits = [];
        const log = recorder();
        let steps = 0;
        const g = svc.gracefulStop({ name: 'T', server, signals: false, log, exit: (c) => exits.push(c), stop: [async () => { steps++; await sleep(20); }] });
        const a = g.stop('SIGTERM');
        const b = g.stop('SIGINT');
        assert.equal(a, b);
        assert.equal(await a, 0);
        assert.equal(await g.stop('SIGTERM'), 0);
        assert.equal(steps, 1);
        assert.deepEqual(exits, [0]);
        assert.equal(log.lines.filter(([, l]) => /stopping/.test(l)).length, 1);
    }],

    ['gracefulStop: a failing step is logged and the stop goes on; a handle that fails to close exits 1', async () => {
        const exits = [];
        const log = recorder();
        const closed = [];
        const g = svc.gracefulStop({
            name: 'AI', signals: false, log, exit: (c) => exits.push(c),
            stop: [() => { throw new Error('poller'); }],
            close: [() => closed.push('close step')],
            handles: [() => closed.push('fn'), { close: async () => { throw new Error('db'); } }, { stop: () => closed.push('stop()') }, { quit: async () => closed.push('quit()') }],
        });
        assert.equal(await g.stop(), 1);
        assert.deepEqual(exits, [1]);
        assert.deepEqual(closed, ['close step', 'fn', 'stop()', 'quit()']);
        assert.ok(log.lines.some(([lvl, l]) => lvl === 'warn' && /stop step failed: poller/.test(l)));
        assert.ok(log.lines.some(([lvl, l]) => lvl === 'error' && /handle failed to close: db/.test(l)));
    }],

    ['within: the value, undefined past ms, a rejection swallowed', async () => {
        assert.equal(await svc.within(100, Promise.resolve(7)), 7);
        // within() unrefs its timeout, so keep the test process alive while that timeout is pending.
        const hold = sleep(30);
        assert.equal(await svc.within(20, new Promise(() => {})), undefined);
        await hold;
        assert.equal(await svc.within(100, Promise.reject(new Error('x'))), undefined);
        assert.equal(await svc.within(100, 3), 3);
        assert.deepEqual([svc.DRAIN_MS, svc.DEADLINE_MS], [4000, 5000]);
    }],

    ['privateNoStore keeps an existing Vary', async () => {
        const headers = { vary: 'Accept-Encoding' };
        const res = { getHeader: (k) => headers[k.toLowerCase()], setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
        svc.privateNoStore(res);
        svc.privateNoStore(res);
        assert.equal(headers['cache-control'], 'private, no-store');
        assert.equal(headers.vary, 'Accept-Encoding, Cookie, Authorization');
    }],

    ['re-exports: loaded on first use, the very functions of openvibe-contracts/openvibe-shared, or an error naming the package', async () => {
        const shared = ['createReadiness', 'skip', 'safeReason', 'createRegistry', 'instrument', 'metricsHandler', 'isLoopbackDirect', 'releaseInfo', 'createRelease'];
        for (const n of [...shared, 'problem', 'sendProblem']) assert.ok(Object.keys(svc).includes(n), n);
        let haveShared = true;
        try { require.resolve('openvibe-shared/ready'); } catch { haveShared = false; }
        if (haveShared) {
            assert.equal(svc.createReadiness, require('openvibe-shared/ready').createReadiness);
            assert.equal(svc.instrument, require('openvibe-shared/metrics').instrument);
            assert.equal(svc.createRelease, require('openvibe-shared/release').createRelease);
        } else {
            for (const n of shared) {
                assert.throws(() => svc[n], (e) => e.code === 'sdk.missing_dependency' && e.package === 'openvibe-shared' && /install `openvibe-shared`/.test(e.message), n);
            }
        }
        if (contracts) {
            assert.equal(svc.problem, contracts.http.problem);
            assert.equal(svc.sendProblem, contracts.http.sendProblem);
        }
        const esm = await import(pathToFileURL(path.join(__dirname, '../esm/service.mjs')).href);
        assert.equal(typeof esm.createReadiness, 'function', 'importing the ESM entry loads neither package');
        if (contracts) assert.equal(esm.problem(404, 'x.y').code, 'x.y');
    }],

    ...(contracts ? errorTests : [['error helpers', async () => { console.log('service error helpers: skipped (openvibe-contracts not installed: npm install)'); }]]),
]);
