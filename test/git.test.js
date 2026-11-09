'use strict';
/** openvibe-sdk/git: the client's paths, validation and the three ways to a computer. */
const assert = require('node:assert/strict');
const { createGitClient } = require('../src/git');

function fake() {
    const calls = [];
    return {
        calls,
        json: async (opts) => { calls.push(opts); return { ok: true, ...opts }; },
        request: async (opts) => { calls.push(opts); return { data: 'raw text' }; },
    };
}

(async () => {
    let n = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };

    const client = fake();
    const git = createGitClient(client, { baseUrl: 'https://git.openvibe.codes' });

    await git.repos.get('openvibers/openvibe.sdk');
    ok(client.calls.at(-1).path === '/api/v1/repos/openvibers/openvibe.sdk', 'get path');
    ok(client.calls.at(-1).service === 'git' && client.calls.at(-1).audience === 'openvibe.git', 'service and audience');

    await git.repos.tree('OpenVibers/OpenVibe.SDK', { ref: 'main', path: 'server/git' });
    ok(client.calls.at(-1).query.ref === 'main' && client.calls.at(-1).query.path === 'server/git', 'tree query');

    await git.repos.commits('openvibers/openvibe.sdk', { path: 'README.md', limit: 10 });
    ok(client.calls.at(-1).path.endsWith('/commits'), 'commits path');

    await git.repos.star('openvibers/openvibe.sdk', true);
    ok(client.calls.at(-1).method === 'PUT', 'star is PUT');
    await git.repos.star('openvibers/openvibe.sdk', false);
    ok(client.calls.at(-1).method === 'DELETE', 'unstar is DELETE');

    await git.commits.create('openvibers/openvibe.sdk', {
        branch: 'agent/run-1', message: 'Fix it', files: [{ path: 'README.md', content: 'hello' }],
    });
    ok(client.calls.at(-1).method === 'POST' && client.calls.at(-1).path.endsWith('/commits'), 'contents write');
    assert.throws(() => git.commits.create('openvibers/openvibe.sdk', { branch: 'x', message: 'y', files: [] }), /file/); n += 1;

    await git.tokens.create({ scopes: ['git.repo.write'], hours: 2 });
    ok(JSON.stringify(client.calls.at(-1).json) === JSON.stringify({ scopes: ['git.repo.write'], hours: 2, label: undefined }), 'token scopes');
    assert.throws(() => git.tokens.create({ scopes: ['nope'] }), /scopes/); n += 1;

    const https = git.clone('openvibers/openvibe.sdk', { to: 'https' });
    ok(https.command === 'git clone https://git.openvibe.codes/openvibers/openvibe.sdk.git', 'https clone command');
    const withToken = git.clone('openvibers/openvibe.sdk', { to: 'https', token: 'git_abc', directory: 'sdk' });
    ok(withToken.command.includes('x-access-token:git_abc@') && withToken.command.endsWith(' sdk'), 'token clone and folder');
    const link = git.clone('openvibers/openvibe.sdk', { to: 'link', directory: 'code/sdk' });
    ok(link.href.startsWith('openvibe-link://clone?repo=openvibers%2Fopenvibe.sdk') && link.href.includes('directory=code%2Fsdk'), 'Link deep link');
    const codes = git.clone('openvibers/openvibe.sdk', { to: 'codes' });
    ok(codes.href === 'https://openvibe.codes/new?repo=openvibers%2Fopenvibe.sdk', 'Codes link');
    assert.throws(() => git.clone('../etc/passwd'), /owner\/name/); n += 1;

    const raw = await git.repos.raw('openvibers/openvibe.sdk', { path: 'README.md' });
    ok(raw === 'raw text' && client.calls.at(-1).responseType === 'text', 'raw text');
    assert.throws(() => git.repos.get('Not A Repo'), /owner\/name/); n += 1;

    console.log(`git: ${n} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
