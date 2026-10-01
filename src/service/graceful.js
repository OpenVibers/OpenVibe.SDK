'use strict';
/**
 * Graceful stop: the module OpenVibe.Network and OpenVibe.Community each carried a copy of (server/graceful.js), with
 * the options the other services' hand-written shutdowns need. systemd sends SIGTERM on a restart or a deploy; SIGINT
 * does the same by hand. On the first signal:
 *
 *   0. stopping() turns true at once (a readiness check can answer 503 from here on);
 *   1. `stop` steps run in order: timers, pollers and relays stop taking new work (nothing new starts);
 *   2. `beforeDrain(signal)` runs: the last moment the server still takes connections (say goodbye on a socket,
 *      wait for a load balancer to see the readiness flip);
 *   3. the HTTP server stops taking connections, requests in flight are answered with `Connection: close`, idle
 *      keep-alive connections are closed (swept every 50 ms), and open event streams (text/event-stream) are
 *      destroyed: EventSource reconnects on its own, to another process;
 *   4. the requests in flight finish, for at most `drainMs`; whatever is still open then is cut;
 *   5. `close` steps run in order (the outbox relay settles, analytics flush, the database closes), then each of
 *      `handles` is closed;
 *   6. exit(0), or exit(1) when a handle failed to close.
 *
 * A step that throws is logged and the stop goes on. A hard `deadlineMs` bounds the whole stop: past it the process
 * exits with `deadlineExitCode` (1, as Network and Community; the 5 s family and Media exit 0). A second signal while
 * stopping changes nothing. exit is called once.
 */

const DRAIN_MS = 4000;
const DEADLINE_MS = 5000;
const SWEEP_MS = 50;

const EVENT_STREAM = /text\/event-stream/i;

function isEventStream(res) {
    if (EVENT_STREAM.test(String(res.getHeader('content-type') || ''))) return true;
    return typeof res._header === 'string' && /content-type:\s*text\/event-stream/i.test(res._header);
}

/** A handle's way to close: a function, or an object with close() (else stop(), end(), quit()). */
function closer(h) {
    if (typeof h === 'function') return h;
    for (const m of ['close', 'stop', 'end', 'quit']) if (h && typeof h[m] === 'function') return () => h[m]();
    return null;
}

/**
 * gracefulStop({ name, server, stop, close, drainMs, deadlineMs, deadlineExitCode, signals, exit, log, beforeDrain, handles })
 *   -> { stop(signal?): Promise<number>, stopping(): boolean }
 * stop() resolves with the exit code it passed to exit (the deadline's, when that fired first).
 */
function gracefulStop(o = {}) {
    const name = o.name || 'service';
    const server = o.server || null;
    const drainMs = o.drainMs == null ? DRAIN_MS : o.drainMs;
    const deadlineMs = o.deadlineMs == null ? DEADLINE_MS : o.deadlineMs;
    const deadlineExitCode = o.deadlineExitCode == null ? 1 : o.deadlineExitCode;
    const log = o.log || console;
    const exit = o.exit || ((code) => process.exit(code));
    const handles = o.handles == null ? [] : [].concat(o.handles);
    let started = null;

    // Every response in flight, so the stop can mark them Connection: close and destroy event streams.
    const inflight = new Set();
    if (server) {
        server.prependListener('request', (req, res) => {
            if (started && !res.headersSent) res.setHeader('Connection', 'close');
            inflight.add(res);
            res.on('close', () => inflight.delete(res));
        });
    }

    async function step(fn, phase) {
        try { await fn(); } catch (err) { log.warn(`[${name}] stop: ${phase} step failed: ${err && err.message}`); }
    }

    function drain() {
        if (!server) return Promise.resolve(0);
        return new Promise((resolve) => {
            let done = false;
            let sweep = null;
            let timer = null;
            const finish = (cut) => {
                if (done) return;
                done = true;
                clearInterval(sweep);
                clearTimeout(timer);
                resolve(cut);
            };
            server.close(() => finish(0));
            for (const res of inflight) {
                if (isEventStream(res)) res.destroy();
                else if (!res.headersSent) res.setHeader('Connection', 'close');
            }
            // A connection whose response just finished goes idle: close it now rather than after keepAliveTimeout.
            const idle = () => { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); };
            idle();
            sweep = setInterval(idle, SWEEP_MS);
            timer = setTimeout(() => {
                const cut = inflight.size;
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                finish(cut);
            }, drainMs);
        });
    }

    function stop(signal = 'stop') {
        if (started) return started;
        let settle;
        let exited = false;
        started = new Promise((resolve) => { settle = resolve; });
        const finish = (code) => {
            if (exited) return;
            exited = true;
            settle(code);
            exit(code);
        };
        const t0 = Date.now();
        const hard = setTimeout(() => {
            log.error(`[${name}] stop took longer than ${deadlineMs} ms: exiting ${deadlineExitCode}`);
            finish(deadlineExitCode);
        }, deadlineMs);
        // Not unref()'d (Network's copy did): a step stuck on a promise with nothing else alive would let the process
        // drain and exit 0 on its own, and the deadline is what decides the exit code.
        (async () => {
            log.log(`[${name}] ${signal}: stopping (requests in flight get ${drainMs} ms)`);
            for (const fn of o.stop || []) await step(fn, 'stop');
            if (typeof o.beforeDrain === 'function') await step(() => o.beforeDrain(signal), 'beforeDrain');
            const cut = await drain();
            if (cut) log.warn(`[${name}] ${cut} request(s) still open after ${drainMs} ms were cut`);
            for (const fn of o.close || []) await step(fn, 'close');
            let code = 0;
            for (const h of handles) {
                const fn = closer(h);
                if (!fn) continue;
                try { await fn(); } catch (err) { code = 1; log.error(`[${name}] stop: a handle failed to close: ${err && err.message}`); }
            }
            clearTimeout(hard);
            if (exited) return;
            log.log(`[${name}] stopped in ${Date.now() - t0} ms`);
            finish(code);
        })().catch((err) => {     // only a throwing logger lands here
            clearTimeout(hard);
            finish(1);
            if (log !== console) console.error(`[${name}] stop failed:`, err);
        });
        return started;
    }

    if (o.signals !== false) {
        process.on('SIGTERM', () => { stop('SIGTERM'); });   // floating-ok: stop() never rejects
        process.on('SIGINT', () => { stop('SIGINT'); });     // floating-ok: stop() never rejects
    }
    return { stop, stopping: () => !!started };
}

/**
 * Await `promise`, but no longer than `ms` (a best-effort step inside the deadline). A rejection is swallowed:
 * within(3000, mirror.flush()) is "flush if it can", never a reason to stop the stop.
 */
function within(ms, promise) {
    let t = null;
    const timeout = new Promise((r) => { t = setTimeout(r, ms); t.unref(); });
    return Promise.race([Promise.resolve(promise).catch(() => {}), timeout]).finally(() => clearTimeout(t));
}

module.exports = { gracefulStop, within, DRAIN_MS, DEADLINE_MS };
