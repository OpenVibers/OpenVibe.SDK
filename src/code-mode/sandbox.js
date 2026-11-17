'use strict';

/**
 * openvibe-sdk/code-mode's sandbox process (plan §AD.26). Forked by ./index.js under Node's permission model (it may
 * read only this file; no other files, processes, workers or addons), with code generation from strings off in every
 * realm (a function from outside the script's context cannot become a way out), no environment and a small heap. It
 * runs one script in a fresh V8 context whose only ways out are the caller's: `tools.<name>(input)` and the plain
 * functions it offers (`run(id, input)`, `find(need)` …). Each call is a message to the parent, which decides whether
 * it happens and answers with JSON text; values cross as JSON text, so nothing of this process's realm reaches the script.
 */
const vm = require('vm');

const pending = new Map();
let seq = 0;
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) { try { delete globalThis[name]; } catch { /* not there */ } }

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,60}$/;

process.on('message', async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'result') {
        const done = pending.get(m.id);
        if (done) { pending.delete(m.id); done(typeof m.json === 'string' ? m.json : JSON.stringify({ ok: false, error: 'no answer' })); }
        return;
    }
    if (m.type !== 'run') return;
    const logs = [];
    let logBytes = 0;
    const bridge = (kind, name, payload) => new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        process.send({ type: 'call', id, kind: String(kind), name: String(name), input: String(payload) });
    });
    const log = (line) => {
        const s = String(line);
        if (logBytes > 4000) return;
        logBytes += s.length;
        logs.push(s.slice(0, 1000));
    };
    try {
        const context = vm.createContext({ __bridge: bridge, __log: log }, { codeGeneration: { strings: false, wasm: false } });
        const tools = Array.isArray(m.tools) ? m.tools.filter((x) => typeof x === 'string' && NAME.test(x)) : [];
        const functions = Array.isArray(m.functions) ? m.functions.filter((x) => typeof x === 'string' && IDENT.test(x)) : [];
        const env = vm.runInContext(`(() => {
            const bridge = __bridge, log = __log;
            delete globalThis.__bridge; delete globalThis.__log;
            const show = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } };
            const answer = async (kind, name, payload) => {
                const r = JSON.parse(await bridge(kind, name, JSON.stringify(payload)));
                if (!r.ok) throw new Error(r.error || (name + ' failed'));
                return r.value;
            };
            const tools = Object.freeze(Object.fromEntries(${JSON.stringify(tools)}.map((n) => [n.replace(/[^A-Za-z0-9_$]/g, '_'), (input) => answer('tool', n, input === undefined ? {} : input)])));
            const fns = Object.freeze(Object.fromEntries(${JSON.stringify(functions)}.map((n) => [n, (...args) => answer('function', n, args)])));
            const say = (...a) => log(a.map(show).join(' '));
            const console = Object.freeze({ log: say, info: say, warn: say, error: say });
            return { tools, fns, console };
        })()`, context, { timeout: 1000 });
        const params = ['tools', 'console', ...functions];
        const main = vm.runInContext(`(async (${params.join(', ')}) => {\n${String(m.code || '')}\n})`, context, { timeout: 1000, filename: 'your-code.js' });
        const value = await main(env.tools, env.console, ...functions.map((f) => env.fns[f]));
        const json = vm.runInContext('(v) => { try { return JSON.stringify(v === undefined ? null : v); } catch (e) { return JSON.stringify(String(v)); } }', context)(value);
        process.send({ type: 'done', ok: true, json, logs });
    } catch (err) {
        process.send({ type: 'done', ok: false, error: String((err && err.message) || err).slice(0, 600), logs });
    }
});
