#!/usr/bin/env node
'use strict';
/**
 * Stream any CLI agent's run on OpenVibe.Live with steps (Agent Streams S7).
 *
 *   OPENVIBE_TOKEN=… node examples/cli-agent-stream.js --title "Fix the login page" -- npm test
 *
 * The same path a Node desk uses: startAgentStream gives the stream and its publish ticket, every line the command
 * writes is a step, and the stream ends with the command's result. Private by default; pass --public to list it.
 */
const { spawn } = require('node:child_process');
const { createClient } = require('../src/core');
const { createStreamsClient } = require('../src/streams');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args.splice(i, 2)[1] : fallback;
};
const title = flag('--title', 'A CLI agent run');
const visibility = args.includes('--public') ? 'public' : 'private';
if (args.includes('--public')) args.splice(args.indexOf('--public'), 1);
const command = args[0] === '--' ? args.slice(1) : args;
if (!command.length) { console.error('usage: cli-agent-stream.js --title "…" [--public] -- <command>'); process.exit(2); }

(async () => {
    if (!process.env.OPENVIBE_TOKEN) { console.error('set OPENVIBE_TOKEN to the person\'s OpenVibe token'); process.exit(2); }
    const baseUrl = String(process.env.OPENVIBE_LIVE_URL || '').trim();
    const streams = createStreamsClient(createClient({ token: process.env.OPENVIBE_TOKEN, ...(baseUrl ? { baseUrls: { live: baseUrl } } : {}) }));
    const { stream, publish } = await streams.startAgentStream({
        title, visibility,
        task: { source: 'node', ref: `cli_${Date.now()}`, title: command.join(' ') },
    });
    const step = async (t, status, extra = {}) => {
        try { return await streams.steps.post(stream.id, { title: t, status, ...extra }, { ticket: publish.ticket }); }
        catch (err) { console.error(`[step] ${err.message}`); }
    };
    await step('Started the command', 'started');
    console.log(`Live: ${stream.page_url}`);
    const child = spawn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
    const line = (status) => (buf) => String(buf).trim().split('\n').slice(0, 3).forEach((t) => t && step(t.slice(0, 120), status));
    child.stdout.on('data', line('started'));
    child.stderr.on('data', line('failed'));
    child.on('close', async (code) => {
        await step(code === 0 ? 'The command passed' : `The command failed (exit ${code})`, code === 0 ? 'passed' : 'failed', { tests: { passed: code === 0 ? 1 : 0, failed: code === 0 ? 0 : 1 } });
        await streams.end(stream.id);
        console.log(`Ended: ${stream.page_url}`);
        process.exit(code || 0);
    });
})().catch((err) => { console.error(`openvibe streams: ${err.message}`); process.exit(1); });
