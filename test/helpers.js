'use strict';
/** Shared test helpers: a local HTTP stub server and a tiny async test runner. */
const http = require('node:http');

/**
 * stubServer(async (req, res, body) => { … }) -> { url, requests, close }
 * `requests` records { method, url, headers, body } for every call.
 */
async function stubServer(handler) {
    const requests = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const body = Buffer.concat(chunks);
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            try {
                await handler(req, res, body, requests.length);
            } catch (err) {
                if (!res.headersSent) { res.statusCode = 500; res.end(String(err && err.stack)); }
            }
        });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url,
        requests,
        server,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    };
}

function send(res, status, body, headers = {}) {
    const isObj = body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, { ...(isObj ? { 'Content-Type': 'application/json' } : {}), ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
}

function problem(res, status, code, detail, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify({ type: `https://openvibe.network/problems/${code}`, title: 'Error', status, code, detail, error: detail, ...extra }));
}

/** Run named async tests in order; exit 1 on the first failure with its stack. */
async function run(tests) {
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}\n${err && err.stack ? err.stack : err}`);
            process.exit(1);
        }
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 3000, stepMs = 10 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        if (await fn()) return;
        if (Date.now() > end) throw new Error('waitFor: timed out');
        await sleep(stepMs);
    }
}

module.exports = { stubServer, send, problem, run, sleep, waitFor };
