#!/usr/bin/env node
'use strict';
/**
 * asyncify: the mechanical half of moving a service from better-sqlite3 to openvibe-sdk/db (ADR-035).
 *
 *   node asyncify.js --config asyncify.json file.js ...
 *
 * config: {
 *   "stores": ["revisions", ...],        // publishing store property names reached as <x>.<store>.<method>(
 *   "syncStoreMethods": ["..."],         // methods of those stores that stay synchronous
 *   "apis": { "blogs": "server/domain/blogs.js", ... },   // variable/property names that hold a module's API object
 *   "syncNames": ["validHandle", ...],   // functions that stay synchronous even when their module changes
 *   "asyncGlobals": ["tx"]               // extra callee names that are async (e.g. a local tx helper)
 * }
 *
 * Async calls: <stmt>.get/.all/.run(...) where <stmt> is db.prepare(...)/<x>.prepare(...)/q.<name>/<x>.q.<name>;
 * <x>.<store>.<method>(...); store.tx(...) / db.tx(...); calls to functions of these files that became async
 * (fixpoint, across files through `apis`). Each gets `await` (parenthesised when a member access follows), its
 * enclosing function becomes async. A function passed to map/filter/forEach/some/every/find/reduce/sort that would
 * become async is NOT changed: it is reported for a hand fix (an async callback there silently breaks semantics).
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ARRAY_CB = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'reduce', 'sort', 'flatMap']);

function parse(src) {
    return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true });
}

function memberPath(node) {
    const parts = [];
    let n = node;
    while (n) {
        if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') { parts.unshift(n.property.name); n = n.object; continue; }
        if (n.type === 'Identifier') { parts.unshift(n.name); break; }
        if (n.type === 'ThisExpression') { parts.unshift('this'); break; }
        if (n.type === 'CallExpression') { parts.unshift('()'); n = n.callee; continue; }
        return parts.length ? ['?', ...parts] : null;
    }
    return parts;
}

function functionName(fn, parent) {
    if (fn.id) return fn.id.name;
    if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
    if (parent && parent.type === 'Property' && parent.key) return parent.key.name || parent.key.value;
    if (parent && parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression') return parent.left.property.name;
    return null;
}

function analyse(file, src, cfg, asyncNames) {
    const ast = parse(src);
    const ancestors = new Map();
    // parent links
    walk.fullAncestor(ast, (node, _state, anc) => { ancestors.set(node, anc.slice(0, -1)); });
    const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
    const stores = new Set(cfg.stores || []);
    const syncStoreMethods = new Set(cfg.syncStoreMethods || []);
    const apis = cfg.apis || {};
    const syncNames = new Set(cfg.syncNames || []);
    const localAsync = asyncNames.local.get(file) || new Set();

    // Names that hold a prepared statement: const x = db.prepare(...), or { x: db.prepare(...) }.
    const stmtNames = new Set();
    const isPrepare = (n) => n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'prepare';
    walk.full(ast, (n) => {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isPrepare(n.init)) stmtNames.add(n.id.name);
        if (n.type === 'Property' && n.key && isPrepare(n.value)) stmtNames.add(n.key.name || n.key.value);
    });

    // Higher-order helpers (conflictGuard(fn), waitFor(fn), once(id, fn), a route wrapper): when a local function is
    // passed an async function, its calls of that parameter return promises, so they are awaited too.
    const localFns = new Map();
    walk.full(ast, (n) => {
        if (n.type === 'FunctionDeclaration' && n.id) localFns.set(n.id.name, n);
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(n.init.type)) localFns.set(n.id.name, n.init);
    });
    const asyncParamCalls = new Set();
    walk.full(ast, (n) => {
        if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || !localFns.has(n.callee.name)) return;
        const target = localFns.get(n.callee.name);
        n.arguments.forEach((arg, i) => {
            const isAsyncFn = ['FunctionExpression', 'ArrowFunctionExpression'].includes(arg.type) && arg.async;
            const p = target.params[i];
            if (!isAsyncFn || !p || p.type !== 'Identifier') return;
            walk.full(target.body, (c) => { if (c.type === 'CallExpression' && c.callee.type === 'Identifier' && c.callee.name === p.name) asyncParamCalls.add(c); });
        });
    });

    function asyncCall(call) {
        const c = call.callee;
        if (c.type === 'MemberExpression' && !c.computed) {
            const m = c.property.name;
            const obj = c.object;
            const p = memberPath(obj) || [];
            if (['get', 'all', 'run'].includes(m)) {
                if (obj.type === 'CallExpression' && obj.callee.type === 'MemberExpression' && ['prepare', 'pluck'].includes(obj.callee.property.name)) return true;
                if (p.length >= 2 && (p[p.length - 2] === 'q' || p[p.length - 2] === 'stmts' || p[p.length - 2] === 'Q')) return true;
                if (p.length && stmtNames.has(p[p.length - 1])) return true;
            }
            if ((m === 'tx' || m === 'transaction') && p.length && ['store', 'db', 'this'].includes(p[p.length - 1])) return m === 'tx';
            // <x>.<store>.<method>(: a store reached through an object; a bare identifier only when listed in bareStores.
            if (p.length >= 2 && stores.has(p[p.length - 1]) && !syncStoreMethods.has(m)) return true;
            if (p.length === 1 && (cfg.bareStores || []).includes(p[0]) && !syncStoreMethods.has(m)) return true;
            if ((cfg.asyncMethods || []).includes(m)) return true;
            // <api>.<method>( across modules
            const holder = p[p.length - 1];
            if (apis[holder]) {
                const set = asyncNames.api.get(apis[holder]);
                if (set && set.has(m) && !syncNames.has(m)) return true;
            }
            if (p.length && (p[p.length - 1] === 'api' || p[p.length - 1] === 'svc' || p[p.length - 1] === 'self') && localAsync.has(m)) return true;
        }
        if (asyncParamCalls.has(call)) return true;
        if (c.type === 'Identifier') {
            if ((cfg.asyncGlobals || []).includes(c.name)) return true;
            if (localAsync.has(c.name) && !syncNames.has(c.name)) return true;
        }
        return false;
    }

    const edits = [];            // { at, text } insertions
    const manual = [];
    const becameAsync = new Set();
    const newlyAsyncNames = new Set();
    const fnsToAsync = new Set();
    const wrappedMaps = new Set();
    const isFnN = (x) => x && (x.type === 'FunctionDeclaration' || x.type === 'FunctionExpression' || x.type === 'ArrowFunctionExpression');
    const inPromiseArg = (call) => { const p = ancestors.get(call) || []; const up = p[p.length - 1]; return up && up.type === 'CallExpression' && up.arguments[0] === call && up.callee.type === 'MemberExpression' && up.callee.object.name === 'Promise'; };
    /** fn will contain an await: make it async; when it is a .map() callback, wrap that map in (await Promise.all(…)) and
     * make its own enclosing function async too (recursively); another array method's callback needs a person. */
    function makeAsync(fn) {
        if (!fn || fnsToAsync.has(fn)) return;
        fnsToAsync.add(fn);
        const anc = ancestors.get(fn) || [];
        const call = anc[anc.length - 1];
        if (!(call && call.type === 'CallExpression' && call.arguments.includes(fn) && call.callee.type === 'MemberExpression' && ARRAY_CB.has(call.callee.property.name))) return;
        if (call.callee.property.name !== 'map') { manual.push(`${file}:${call.loc.start.line}: a .${call.callee.property.name}() callback becomes async`); return; }
        if (inPromiseArg(call) || wrappedMaps.has(call)) return;
        wrappedMaps.add(call);
        edits.push({ at: call.start, text: '(await Promise.all(' });
        edits.push({ at: call.end, text: '))' });
        makeAsync([...anc].reverse().find((x) => x !== fn && isFnN(x)));
    }
    // An async callback already there whose map result is not awaited as a whole is almost always a bug.
    walk.full(ast, (n) => {
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'map' && isFnN(n.arguments[0]) && n.arguments[0].async && !inPromiseArg(n)) {
            const p = ancestors.get(n) || []; const up = p[p.length - 1];
            if (!(up && up.type === 'VariableDeclarator')) manual.push(`${file}:${n.loc.start.line}: .map(async …) whose promises are not awaited together (Promise.all)`);
        }
    });

    // An async function passed by name to an array method: xs.map(asyncFn) / xs.map(api.asyncMethod) is wrapped in
    // (await Promise.all(…)) like an async callback; any other array method needs a person.
    const isFnNode = (x) => x.type === 'FunctionDeclaration' || x.type === 'FunctionExpression' || x.type === 'ArrowFunctionExpression';
    walk.full(ast, (n) => {
        if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || !ARRAY_CB.has(n.callee.property.name) || !n.arguments[0]) return;
        const arg = n.arguments[0];
        let what = null;
        if (arg.type === 'Identifier' && localAsync.has(arg.name) && !syncNames.has(arg.name)) what = `async function ${arg.name}`;
        if (arg.type === 'MemberExpression' && !arg.computed && arg.object.type === 'Identifier' && apis[arg.object.name]) {
            const set = asyncNames.api.get(apis[arg.object.name]);
            if (set && set.has(arg.property.name) && !syncNames.has(arg.property.name)) what = `async method ${arg.object.name}.${arg.property.name}`;
        }
        if (!what) return;
        const p = ancestors.get(n) || [];
        const up = p[p.length - 1];
        if (n.callee.property.name === 'map' && up && up.type === 'CallExpression' && up.callee.type === 'MemberExpression' && up.callee.object.name === 'Promise') return;
        const outer = [...p].reverse().find(isFnNode);
        if (n.callee.property.name === 'map' && outer && !wrappedMaps.has(n)) {
            wrappedMaps.add(n);
            edits.push({ at: n.start, text: '(await Promise.all(' });
            edits.push({ at: n.end, text: '))' });
            makeAsync(outer);
            return;
        }
        manual.push(`${file}:${n.loc.start.line}: ${what} passed to .${n.callee.property.name}()`);
    });
    // Names awaited as a whole somewhere in the file (await first, await Promise.all([a, b]) excluded).
    const awaitedLater = new Set();
    walk.full(ast, (n) => { if (n.type === 'AwaitExpression' && n.argument && n.argument.type === 'Identifier') awaitedLater.add(n.argument.name); });
    walk.fullAncestor(ast, (node, _s, anc) => {
        if (node.type !== 'CallExpression' || !asyncCall(node)) return;
        const parents = anc.slice(0, -1);
        const parent = parents[parents.length - 1];
        if (parent && parent.type === 'AwaitExpression') return;
        // A promise used as a value stays a promise: p.then/catch/finally, or an element of Promise.all/race/allSettled/any.
        if (parent && parent.type === 'MemberExpression' && parent.object === node && ['then', 'catch', 'finally'].includes(parent.property.name)) return;
        if (parent && parent.type === 'ArrayExpression') {
            const gp = parents[parents.length - 2];
            if (gp && gp.type === 'CallExpression' && gp.callee.type === 'MemberExpression' && gp.callee.object.name === 'Promise') return;
        }
        if (parent && parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression' && parent.callee.object.name === 'Promise') return;
        // const p = asyncCall(); … await p: the promise is started now on purpose and awaited later.
        if (parent && parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier' && awaitedLater.has(parent.id.name)) return;
        // assert.rejects(promise) / doesNotReject(promise) take the promise itself.
        if (parent && parent.type === 'CallExpression' && parent.arguments[0] === node && parent.callee.type === 'MemberExpression' && ['rejects', 'doesNotReject'].includes(parent.callee.property.name)) return;
        // Returned directly from an arrow body or a return statement of an async fn is fine too, but awaiting is harmless.
        const fnIdx = (() => { for (let i = parents.length - 1; i >= 0; i--) if (isFn(parents[i])) return i; return -1; })();
        const fn = fnIdx >= 0 ? parents[fnIdx] : null;
        if (fn) {
            const fnParent = parents[fnIdx - 1];
            const inPromiseAll = (call) => { const p = ancestors.get(call) || []; const up = p[p.length - 1]; return up && up.type === 'CallExpression' && up.arguments[0] === call && up.callee.type === 'MemberExpression' && up.callee.object.name === 'Promise'; };
            if (fnParent && fnParent.type === 'CallExpression' && fnParent.arguments.includes(fn) && fnParent.callee.type === 'MemberExpression' && ARRAY_CB.has(fnParent.callee.property.name)
                && !(fnParent.callee.property.name === 'map' && inPromiseAll(fnParent))) {
                // xs.map(cb) → (await Promise.all(xs.map(async cb))): same order, same length. Other array methods
                // change meaning with an async callback (filter keeps every promise), so they stay for a person.
                const outer = (() => { for (let i = fnIdx - 2; i >= 0; i--) if (isFn(parents[i])) return parents[i]; return null; })();
                if (fnParent.callee.property.name === 'map' && outer) {
                    if (!wrappedMaps.has(fnParent)) {
                        wrappedMaps.add(fnParent);
                        edits.push({ at: fnParent.start, text: '(await Promise.all(' });
                        edits.push({ at: fnParent.end, text: '))' });
                        makeAsync(outer);
                    }
                } else {
                    manual.push(`${file}:${node.loc.start.line}: async call inside a .${fnParent.callee.property.name}() callback`);
                    return;
                }
            }
            makeAsync(fn);
        }
        const wrap = parent && parent.type === 'MemberExpression' && parent.object === node;
        edits.push({ at: node.start, text: wrap ? '(await ' : 'await ' });
        if (wrap) edits.push({ at: node.end, text: ')' });
    });

    for (const fn of fnsToAsync) {
        if (fn.async) continue;
        const anc = ancestors.get(fn) || [];
        const parent = anc[anc.length - 1];
        becameAsync.add(fn);
        const name = functionName(fn, parent);
        if (name) newlyAsyncNames.add(name);
        if (parent && parent.type === 'Property' && (parent.method || parent.kind !== 'init')) edits.push({ at: parent.start, text: 'async ' });
        else if (parent && parent.type === 'MethodDefinition') edits.push({ at: parent.key.start, text: 'async ' });
        else edits.push({ at: fn.start, text: 'async ' });
    }
    return { edits, manual, newlyAsyncNames };
}

function apply(src, edits) {
    // At one position, closing text goes in first so it ends up after what opens there.
    const sorted = edits.slice().sort((a, b) => b.at - a.at || ((a.text[0] === ')' ? 0 : 1) - (b.text[0] === ')' ? 0 : 1)));
    let out = src;
    for (const e of sorted) out = out.slice(0, e.at) + e.text + out.slice(e.at);
    return out;
}

function main() {
    const args = process.argv.slice(2);
    const ci = args.indexOf('--config');
    const cfg = ci >= 0 ? JSON.parse(fs.readFileSync(args[ci + 1], 'utf8')) : {};
    const files = args.filter((a, i) => a.endsWith('.js') && i !== ci + 1).map((f) => path.relative(process.cwd(), path.resolve(f)));
    const asyncNames = { local: new Map(), api: new Map() };
    let manual = [];
    for (let round = 0; round < 12; round++) {
        let changed = false;
        manual = [];
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            let r;
            try { r = analyse(f, src, cfg, asyncNames); } catch (e) { console.error(`${f}: parse error ${e.message}`); process.exitCode = 1; continue; }
            manual.push(...r.manual);
            if (r.edits.length) {
                let next = apply(src, r.edits);
                // An assertion about a function that is async now: assert.throws cannot see a rejection.
                next = next.replace(/(^|[^.\w])assert\.throws\(async /g, '$1await assert.rejects(async ').replace(/(^|[^.\w])assert\.doesNotThrow\(async /g, '$1await assert.doesNotReject(async ');
                try { parse(next); } catch (e) { console.error(`${f}: the edits would break the syntax (${e.message}); left unchanged`); manual.push(`${f}: edits refused (syntax)`); continue; }
                fs.writeFileSync(f, next); changed = true;
            }
            // Every async function of the file (new or already) counts for callers.
            const all = new Set([...(asyncNames.local.get(f) || []), ...r.newlyAsyncNames]);
            // { name: someAsyncFunction } exports the function under another name: that name is async too.
            walk.full(parse(fs.readFileSync(f, 'utf8')), (n) => {
                if (n.type === 'Property' && n.value && n.value.type === 'Identifier' && all.has(n.value.name) && n.key) all.add(n.key.name || n.key.value);
            });
            walk.fullAncestor(parse(fs.readFileSync(f, 'utf8')), (node, _s, anc) => {
                if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.async) {
                    const parent = anc[anc.length - 2];
                    const name = functionName(node, parent);
                    if (name) all.add(name);
                }
            });
            const before = (asyncNames.local.get(f) || new Set()).size;
            asyncNames.local.set(f, all);
            asyncNames.api.set(f, all);
            if (all.size !== before) changed = true;
        }
        if (!changed) break;
    }
    for (const m of [...new Set(manual)]) console.log(`MANUAL ${m}`);
    for (const f of files) console.log(`async ${f}: ${[...(asyncNames.local.get(f) || [])].sort().join(', ')}`);
}

main();
