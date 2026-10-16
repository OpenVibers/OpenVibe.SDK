#!/usr/bin/env node
'use strict';
/**
 * openvibe-download — back a folder up into your OpenVibe.Download drive (openvibe-sdk/download).
 *
 *   OPENVIBE_DOWNLOAD_KEY=ovdl_… openvibe-download sync ~/Documents --to Backups/laptop [--delete] [--dry-run] [--exclude NAME]…
 *   openvibe-download ls [drive/path]
 *   openvibe-download usage
 *
 * Make the key at https://openvibe.download/sync (it is shown once). OPENVIBE_DOWNLOAD_URL points elsewhere (tests).
 * Exit status: 0 done, 1 something failed or the sync was stopped (the drive's daily cap or quota), 2 bad usage.
 */
const { createDownloadClient } = require('../src/download');

const USAGE = `Usage:
  openvibe-download sync <folder> --to <drive/path> [--delete] [--dry-run] [--exclude NAME]...
  openvibe-download ls [drive/path]
  openvibe-download usage

Set OPENVIBE_DOWNLOAD_KEY to a sync key from https://openvibe.download/sync`;

function parse(argv) {
    const out = { _: [], exclude: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--to') out.to = argv[++i];
        else if (a === '--exclude') out.exclude.push(argv[++i]);
        else if (a === '--delete') out.delete = true;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--quiet' || a === '-q') out.quiet = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        else out._.push(a);
    }
    return out;
}

const mb = (n) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

async function main(argv, env = process.env, out = process.stdout, err = process.stderr) {
    let args;
    try { args = parse(argv); } catch (e) { err.write(`${e.message}\n\n${USAGE}\n`); return 2; }
    const [command, target] = args._;
    if (args.help || !command) { out.write(`${USAGE}\n`); return command || args.help ? 0 : 2; }
    const key = env.OPENVIBE_DOWNLOAD_KEY;
    if (!key) { err.write(`OPENVIBE_DOWNLOAD_KEY is not set.\n\n${USAGE}\n`); return 2; }
    const dl = createDownloadClient({ key, baseUrl: env.OPENVIBE_DOWNLOAD_URL || undefined });
    try {
        if (command === 'usage') {
            const u = await dl.usage();
            out.write(`${mb(u.bytes_used)} of ${mb(u.bytes_limit)} stored, ${u.files} files; ${u.uploads_today} uploads today\n`);
            return 0;
        }
        if (command === 'ls') {
            const folderId = target ? await dl.folders.ensurePath(target) : null;
            const page = await dl.files.list({ folderId });
            for (const f of page.folders) out.write(`${f.name}/\n`);
            for (const f of page.files) out.write(`${f.name}\t${mb(f.size)}\n`);
            return 0;
        }
        if (command === 'sync') {
            if (!target || !args.to) { err.write(`sync needs a folder and --to <drive/path>.\n\n${USAGE}\n`); return 2; }
            const report = await dl.sync(target, {
                to: args.to, delete: Boolean(args.delete), dryRun: Boolean(args.dryRun), exclude: args.exclude,
                onEvent: (e) => {
                    if (args.quiet && e.type !== 'error') return;
                    if (e.type === 'upload' || e.type === 'replace') out.write(`${args.dryRun ? 'would send' : e.type === 'replace' ? 'update' : 'send'}  ${e.path} (${mb(e.size)})\n`);
                    else if (e.type === 'delete') out.write(`${args.dryRun ? 'would delete' : 'delete'}  ${e.path}\n`);
                    else if (e.type === 'error') err.write(`failed  ${e.path}: ${e.message}\n`);
                },
            });
            out.write(`${args.dryRun ? 'Dry run: ' : ''}${report.uploaded} new, ${report.replaced} updated, ${report.skipped} unchanged, ${report.deleted} deleted, ${report.failed} failed (${mb(report.bytes)})\n`);
            if (report.stopped) err.write(`Stopped: ${report.stopped.message}\n`);
            return report.failed || report.stopped ? 1 : 0;
        }
        err.write(`unknown command ${command}\n\n${USAGE}\n`);
        return 2;
    } catch (e) {
        err.write(`${e.detail || e.message || e}\n`);
        return 1;
    }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main, parse };
