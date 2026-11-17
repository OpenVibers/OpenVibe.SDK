'use strict';

/**
 * openvibe-sdk/code-mode — an agent writes a script instead of calling tools one at a time (plan §AD.26; the owner,
 * 2026-11-17, sending Cloudflare's Code Mode and Claude Code's: "Analyze and use to improve openvibe"). One sandbox for
 * every OpenVibe service: Actor's loop (tools_search / tools_code), Tools' MCP (run_code over 180+ tools), Codes.
 *
 * The script runs in ./sandbox.js: its own process under Node's permission model (it may read only its own file), code
 * generation from strings off in every realm, no environment, a 64 MB heap, 30 s and 30 calls. Its only ways out are
 * the caller's: `tools.<name>(input)` for each tool named, and each plain function named (`run(id, input)`). The caller
 * decides every call, exactly as if the agent had made it. Only what the script returns (8 KB at most) and its console
 * lines come back.
 *
 *   runCode(code, { tools?, functions?, call, limits? })
 *       call(kind: 'tool'|'function', name, payload) → { ok: true, value }, { ok: false, error }, or the value itself
 *       → { ok, value, logs, calls, ms, error? }
 *   signatureOf(definition)        → "name(input: { url: string; models?: string[] }): Promise<any>" (an OpenAI-shaped
 *                                    function definition or an MCP tool: { name, description, inputSchema })
 *   searchTools(definitions, query, limit?) → [{ name, signature, description }], the best matches first
 *   typeOf(jsonSchema)             → a short TypeScript-like type
 *   LIMITS                         { ms, calls, resultBytes, memMb }
 *
 * Node 22.13 or newer (the permission model's --permission flag).
 */
const path = require('path');
const { fork } = require('child_process');

const SANDBOX = path.join(__dirname, 'sandbox.js');
const LIMITS = Object.freeze({ ms: 30000, calls: 30, resultBytes: 8192, memMb: 64 });
const jsName = (n) => String(n).replace(/[^A-Za-z0-9_$]/g, '_');

function typeOf(schema, depth = 0) {
    const s = schema && typeof schema === 'object' ? schema : {};
    if (Array.isArray(s.enum) && s.enum.length && s.enum.length <= 8) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
    if (t === 'string' || t === 'number' || t === 'boolean') return t;
    if (t === 'integer') return 'number';
    if (t === 'array') return `${typeOf(s.items, depth + 1)}[]`;
    if (t === 'object' || s.properties) {
        if (depth > 2) return 'object';
        const req = new Set(Array.isArray(s.required) ? s.required : []);
        const props = Object.entries(s.properties || {}).slice(0, 24);
        if (!props.length) return 'object';
        return `{ ${props.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${typeOf(v, depth + 1)}`).join('; ')} }`;
    }
    return 'any';
}

/** A definition of either shape: { type: 'function', function: { name, description, parameters } } or an MCP tool. */
const parts = (d) => (d && d.function ? { name: d.function.name, description: d.function.description, schema: d.function.parameters }
    : { name: d && d.name, description: d && d.description, schema: d && (d.inputSchema || d.parameters) });

function signatureOf(def) {
    const p = parts(def);
    return `${jsName(String(p.name || ''))}(input: ${typeOf(p.schema)}): Promise<any>`;
}

function searchTools(defs, query, limit = 12) {
    const words = String(query || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    const scored = (Array.isArray(defs) ? defs : []).map((d) => {
        const p = parts(d);
        const name = String(p.name || '').toLowerCase();
        const text = `${name} ${String(p.description || '').toLowerCase()}`;
        let score = 0;
        for (const w of words) { if (name.includes(w)) score += 3; else if (text.includes(w)) score += 1; }
        return { d, p, score };
    }).filter((x) => !words.length || x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(30, Number(limit) || 12))).map(({ d, p }) => ({
        name: jsName(String(p.name || '')), signature: signatureOf(d), description: String(p.description || '').replace(/\s+/g, ' ').slice(0, 500),
    }));
}

function runCode(code, { tools = [], functions = [], call, limits = {} } = {}) {
    const lim = { ...LIMITS, ...limits };
    const started = Date.now();
    const toolNames = new Map(tools.map((n) => [jsName(n), String(n)]));
    const fnNames = new Set(functions.map(String).filter((f) => /^[A-Za-z_$][A-Za-z0-9_$]{0,60}$/.test(f)));
    return new Promise((resolve) => {
        let calls = 0, settled = false;
        const child = fork(SANDBOX, [], {
            execArgv: ['--permission', `--allow-fs-read=${SANDBOX}`, '--disallow-code-generation-from-strings', `--max-old-space-size=${lim.memMb}`],
            env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
        });
        const finish = (out) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            resolve({ ms: Date.now() - started, calls, ...out });
        };
        const timer = setTimeout(() => finish({ ok: false, error: `the script ran past ${Math.round(lim.ms / 1000)} s and was stopped`, logs: [] }), lim.ms);
        child.on('error', (err) => finish({ ok: false, error: `the sandbox did not start: ${err && err.message}`, logs: [] }));
        child.on('exit', (n) => finish({ ok: false, error: `the sandbox ended (${n}) before the script finished`, logs: [] }));
        child.on('message', async (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.type === 'done') {
                if (!m.ok) return finish({ ok: false, error: String(m.error || 'the script failed'), logs: m.logs || [] });
                const json = String(m.json == null ? 'null' : m.json);
                if (Buffer.byteLength(json) > lim.resultBytes) return finish({ ok: false, error: `the script returned ${Buffer.byteLength(json)} bytes; return less than ${lim.resultBytes} (filter in the script)`, logs: m.logs || [] });
                let value = null;
                try { value = JSON.parse(json); } catch { value = json; }
                return finish({ ok: true, value, logs: m.logs || [] });
            }
            if (m.type !== 'call') return;
            const reply = (o) => { try { child.send({ type: 'result', id: m.id, json: JSON.stringify(o) }); } catch { /* the script is gone */ } };
            const kind = m.kind === 'function' ? 'function' : 'tool';
            const name = kind === 'tool' ? toolNames.get(jsName(m.name)) : (fnNames.has(m.name) ? m.name : null);
            if (!name) return reply({ ok: false, error: `there is no ${kind} ${m.name} here` });
            calls += 1;
            if (calls > lim.calls) return reply({ ok: false, error: `a script makes at most ${lim.calls} calls` });
            let payload;
            try { payload = JSON.parse(String(m.input || 'null')); } catch { return reply({ ok: false, error: 'the input is not JSON' }); }
            if (kind === 'tool' && (!payload || typeof payload !== 'object' || Array.isArray(payload))) return reply({ ok: false, error: 'a tool takes one object' });
            if (kind === 'function' && !Array.isArray(payload)) return reply({ ok: false, error: 'the arguments are not a list' });
            try {
                const out = await call(kind, name, payload);
                // The caller answers { ok: true, value }, { ok: false, error }, or the value itself.
                if (out && typeof out === 'object' && out.ok === false) reply({ ok: false, error: String(out.error || 'it failed') });
                else reply({ ok: true, value: out && typeof out === 'object' && out.ok === true && 'value' in out ? out.value : out });
            } catch (err) {
                reply({ ok: false, error: String((err && err.message) || err).slice(0, 400) });
            }
        });
        child.send({ type: 'run', code: String(code || ''), tools: [...toolNames.values()], functions: [...fnNames] });
    });
}

module.exports = { runCode, signatureOf, searchTools, typeOf, LIMITS };
