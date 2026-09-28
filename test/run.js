#!/usr/bin/env node
/**
 * Runs every test in test/ (the files named *.test.js), each in its own process, and fails if
 * any of them fails. They use local stub servers and the in-process mock platform only; none
 * needs the network or a running service.
 *
 *   npm test                 # everything
 *   npm test -- core pack    # only files whose name contains one of the words
 *   npm test -- --strict     # a skipped test fails the run too (or OV_TEST_STRICT=1)
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and its reasons and not counted as passed, so the summary reads `9/10 test files passed,
 * 1 skipped (…)`; only a run with nothing skipped says `N/N test files passed`. This is the rule of
 * openvibe-shared/test-runner, copied here because the SDK does not depend on openvibe-shared.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const strict = process.argv.includes('--strict') || process.env.OV_TEST_STRICT === '1';
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filters.length || filters.some((w) => f.includes(w)))
    .sort();
const TIMEOUT_MS = 120000;

/** `<label>: skipped (<why>)` on a line of its own (SKIP_RE from openvibe-shared/test-runner). */
const SKIP_RE = /^[ \t]*[\w .,'()/+#-]{1,120}: skipped \((.+)\)[ \t]*$/gm;

/** The skip lines in a test's output, in order, without repeats (skipsIn from openvibe-shared/test-runner). */
function skipsIn(output) {
    const out = [];
    for (const m of String(output || '').matchAll(SKIP_RE)) {
        const line = m[0].trim();
        if (!out.includes(line)) out.push(line);
    }
    return out;
}

function runOne(file) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [path.join(__dirname, file)], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (c) => { output += c; });
        child.stderr.on('data', (c) => { output += c; });
        const timer = setTimeout(() => { output += `\n[run] timed out after ${TIMEOUT_MS}ms`; child.kill('SIGKILL'); }, TIMEOUT_MS);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            const ok = code === 0;
            const skips = ok ? skipsIn(output) : [];
            resolve({ file, ok, state: !ok ? 'fail' : skips.length ? 'skip' : 'pass', skips, code: code ?? signal, ms: Date.now() - started, output });
        });
    });
}

(async () => {
    if (!files.length) { console.error('no test files matched'); process.exit(1); }
    const results = [];
    for (const f of files) {
        const r = await runOne(f);
        results.push(r);
        const mark = r.state === 'pass' ? '✓' : r.state === 'skip' ? '○' : '✗';
        console.log(`${mark} ${r.file.padEnd(32)} ${String(r.ms).padStart(6)}ms${r.state === 'skip' ? `  ${r.skips.join('; ')}` : ''}`);
    }
    const failed = results.filter((r) => r.state === 'fail');
    const skipped = results.filter((r) => r.state === 'skip');
    for (const r of failed) {
        console.log(`\n── ${r.file} (exit ${r.code}) ──`);
        console.log(r.output.split('\n').slice(-60).join('\n'));
    }
    const passed = results.length - failed.length - skipped.length;
    console.log(skipped.length
        ? `\n${passed}/${results.length} test files passed, ${skipped.length} skipped (${skipped.map((r) => `${r.file}: ${r.skips.join('; ')}`).join(' | ')})${strict ? ' — strict: skips fail the run' : ''}`
        : `\n${passed}/${results.length} test files passed`);
    process.exit(failed.length || (strict && skipped.length) ? 1 : 0);
})();
