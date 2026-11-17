'use strict';
// openvibe-sdk/code-mode (plan §AD.26): a script calls the caller's tools and functions in a sandbox and returns only what
// it needs; the caller decides every call; the sandbox holds (no require, process, files, network, eval or way out).
const assert = require('node:assert/strict');
const { runCode, signatureOf, searchTools, typeOf, LIMITS } = require('../src/code-mode');

const DEFS = [
    { type: 'function', function: { name: 'audit_page', description: 'Audit a page against the design rules.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    { name: 'dns-lookup', description: 'Look up DNS records.', inputSchema: { type: 'object', properties: { domain: { type: 'string' }, type: { enum: ['A', 'MX'] } }, required: ['domain'] } },
];

(async () => {
    // Signatures for both shapes, search, types.
    assert.equal(signatureOf(DEFS[0]), 'audit_page(input: { url: string }): Promise<any>');
    assert.equal(signatureOf(DEFS[1]), 'dns_lookup(input: { domain: string; type?: "A" | "MX" }): Promise<any>');
    assert.deepEqual(searchTools(DEFS, 'dns records').map((x) => x.name), ['dns_lookup']);
    assert.equal(typeOf({ type: 'array', items: { type: 'integer' } }), 'number[]');
    assert.equal(LIMITS.calls, 30);

    // Tools and functions; the caller sees every call; only the value comes back.
    const seen = [];
    const call = async (kind, name, payload) => {
        seen.push([kind, name, payload]);
        if (kind === 'tool' && name === 'dns-lookup') return { ok: true, value: { records: [`${payload.domain} A 1.2.3.4`] } };
        if (kind === 'tool' && name === 'audit_page') return { findings: [{ id: 'viewport', severity: 'high' }, { id: 'alt', severity: 'low' }] };
        if (kind === 'function' && name === 'run') return { ok: true, value: { tool: payload[0], out: payload[1] } };
        if (kind === 'function' && name === 'find') return { ok: false, error: 'the catalogue is resting' };
        return null;
    };
    const out = await runCode(`
        const a = await tools.audit_page({ url: 'https://x.example/' });
        const d = await tools.dns_lookup({ domain: 'x.example' });
        const r = await run('qr', { text: 'hi' });
        let missing; try { await find('pdf'); } catch (e) { missing = e.message; }
        console.log('done', 3);
        return { high: a.findings.filter((f) => f.severity === 'high').length, dns: d.records[0], ran: r.tool, missing };
    `, { tools: ['audit_page', 'dns-lookup'], functions: ['run', 'find'], call });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(out.value, { high: 1, dns: 'x.example A 1.2.3.4', ran: 'qr', missing: 'the catalogue is resting' });
    assert.deepEqual(out.logs, ['done 3']);
    assert.equal(out.calls, 4);
    assert.deepEqual(seen.map(([k, n]) => `${k}:${n}`), ['tool:audit_page', 'tool:dns-lookup', 'function:run', 'function:find'], 'a hyphened tool keeps its own name for the caller');
    assert.deepEqual(seen[2][2], ['qr', { text: 'hi' }], 'a function gets its arguments as a list');

    // Limits.
    const many = await runCode(`let n = 0; try { for (;;) { await run('x'); n++; } } catch (e) { return [n, e.message]; }`, { functions: ['run'], call, limits: { calls: 4 } });
    assert.deepEqual(many.value, [4, 'a script makes at most 4 calls']);
    const big = await runCode(`return 'x'.repeat(20000)`, { call });
    assert.equal(big.ok, false);
    const slow = await runCode('for (;;) {}', { call, limits: { ms: 2000 } });
    assert.equal(slow.ok, false);
    const none = await runCode('return await tools.drop_tables({})', { tools: ['audit_page'], call });
    assert.match(none.error, /drop_tables is not a function/);

    // The sandbox holds.
    const tries = {
        require: 'return typeof require', process: 'return typeof process', fetch: 'return typeof fetch',
        eval: 'try { return eval("1"); } catch (e) { return "blocked"; }',
        fn: 'try { return new Function("return 1")(); } catch (e) { return "blocked"; }',
        viaTool: 'try { return typeof tools.audit_page.constructor.constructor("return process")(); } catch (e) { return "blocked"; }',
        viaFunction: 'try { return typeof run.constructor.constructor("return process")(); } catch (e) { return "blocked"; }',
        viaPromise: 'try { const p = run("x"); return typeof p.constructor.constructor("return process")(); } catch (e) { return "blocked"; }',
    };
    for (const [k, code] of Object.entries(tries)) {
        const r = await runCode(code, { tools: ['audit_page'], functions: ['run'], call });
        assert.equal(r.ok, true, `${k}: ${r.error}`);
        assert.equal(r.value, ['require', 'process', 'fetch'].includes(k) ? 'undefined' : 'blocked', k);
    }
    console.log('code-mode: tools and functions called by the caller\'s decision, only the value back, limits held, no way out');
})().catch((e) => { console.error(e); process.exit(1); });
