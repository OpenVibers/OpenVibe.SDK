'use strict';
/**
 * openvibe-sdk/git — OpenVibe.Git (git.openvibe.codes): repositories, trees, blobs, commits, branches, tags,
 * releases, contributors, insights and stars, the contents write that makes a commit without a clone, clone
 * tokens, and the three ways to get a repository onto a computer.
 *
 *   const git = createGitClient(createClient({ tokenProvider }));
 *   const { repositories } = await git.repos.list({ sort: 'trending', language: 'JavaScript' });
 *   const repo = await git.repos.get('openvibers/openvibe.codes');
 *   const tree = await git.repos.tree(repo.full_name, { ref: 'main', path: 'server' });
 *   const file = await git.repos.blob(repo.full_name, { ref: 'main', path: 'README.md' });   // { text, … }
 *   await git.commits.create(repo.full_name, { branch: 'agent/run-1', message: 'Fix the title', files: [{ path: 'README.md', content: '…' }] });
 *   const { token, command } = await git.tokens.create({ scopes: ['git.repo.write'] });
 *   git.clone(repo.full_name, { to: 'link' });        // Link opens and asks the person to approve the clone
 *
 * A public repository is readable without a token. A contents write, a star and a clone token need a signed-in
 * person's client; a service acts with its own Network token (audience openvibe.git, capability git.repo.write).
 */
const enc = encodeURIComponent;
const FULL_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/;
const SCOPES = ['git.repo.read', 'git.repo.write'];
const SORTS = ['trending', 'pushed', 'stars', 'new'];
const STARTERS = ['empty', 'app', 'static'];

function fullName(full, where) {
    const s = String(full || '').toLowerCase();
    if (!FULL_RE.test(s)) throw new TypeError(`${where}: a repository is owner/name (lower-case)`);
    return s;
}

function createGitClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function' || typeof client.request !== 'function') {
        throw new TypeError('createGitClient: pass an openvibe-sdk/core client');
    }
    const at = { service: 'git', baseUrl, audience: 'openvibe.git' };
    const call = (opts) => client.json({ ...at, ...opts });
    const repo = (full, where) => `/api/v1/repos/${fullName(full, where).split('/').map(enc).join('/')}`;
    const repoAt = (full, tail, where) => `${repo(full, where)}/${tail}`;

    return {
        repos: {
            /** Search and filter: q, language, official, mirror, mine, starred; sort trending|pushed|stars|new. */
            list: ({ q, language, official, mirror, mine, starred, sort, limit, cursor, signal } = {}) => {
                if (sort != null && !SORTS.includes(sort)) throw new TypeError(`git.repos.list: sort is one of ${SORTS.join(', ')}`);
                return call({ path: '/api/v1/repos', query: { q, language, official, mirror, mine, starred, sort, limit, cursor }, signal });
            },
            get: (full, { signal } = {}) => call({ path: repo(full, 'git.repos.get'), signal }),
            /** name, description, visibility, topics, starter (empty|app|static) or mirror_url (a public GitHub URL). */
            create: (fields = {}, { signal } = {}) => {
                if (!fields.name) throw new TypeError('git.repos.create: a name');
                if (fields.starter != null && !STARTERS.includes(fields.starter)) throw new TypeError(`git.repos.create: starter is one of ${STARTERS.join(', ')}`);
                return call({ method: 'POST', path: '/api/v1/repos', json: fields, signal });
            },
            tree: (full, { ref = 'main', path = '', signal } = {}) => call({ path: repoAt(full, 'tree', 'git.repos.tree'), query: { ref, path }, signal }),
            blob: (full, { ref = 'main', path, signal } = {}) => {
                if (!path) throw new TypeError('git.repos.blob: a path');
                return call({ path: repoAt(full, 'blob', 'git.repos.blob'), query: { ref, path }, signal });
            },
            /** The file's bytes as text (a binary file answers with its type and no text). */
            raw: async (full, { ref = 'main', path, signal } = {}) => {
                if (!path) throw new TypeError('git.repos.raw: a path');
                const { data } = await client.request({ ...at, path: repoAt(full, 'raw', 'git.repos.raw'), query: { ref, path }, responseType: 'text', signal });
                return data;
            },
            commits: (full, { ref = 'main', path, limit, cursor, signal } = {}) => call({ path: repoAt(full, 'commits', 'git.repos.commits'), query: { ref, path, limit, cursor }, signal }),
            commit: (full, sha, { diff = false, signal } = {}) => call({ path: repoAt(full, `commit/${enc(String(sha))}`, 'git.repos.commit'), query: { diff }, signal }),
            branches: (full, { signal } = {}) => call({ path: repoAt(full, 'branches', 'git.repos.branches'), signal }),
            tags: (full, { signal } = {}) => call({ path: repoAt(full, 'tags', 'git.repos.tags'), signal }),
            releases: (full, { signal } = {}) => call({ path: repoAt(full, 'releases', 'git.repos.releases'), signal }),
            contributors: (full, { signal } = {}) => call({ path: repoAt(full, 'contributors', 'git.repos.contributors'), signal }),
            insights: (full, { days = 30, signal } = {}) => call({ path: repoAt(full, 'insights', 'git.repos.insights'), query: { days }, signal }),
            /** Star or unstar; true stars, false unstars. */
            star: (full, on = true, { signal } = {}) => call({ method: on ? 'PUT' : 'DELETE', path: repoAt(full, 'star', 'git.repos.star'), idempotent: true, signal }),
            /** Mirror settings: { push_url, push_token } to push every push back to GitHub, or {} to stop. */
            mirror: (full, fields = {}, { signal } = {}) => call({ method: 'POST', path: repoAt(full, 'mirror', 'git.repos.mirror'), json: fields, signal }),
        },

        commits: {
            /**
             * A branch and files in one request, no clone: files [{ path, content, encoding?: 'utf8'|'base64' }].
             * `base` (a branch or sha) makes a new branch from it; without it the branch is the default branch.
             */
            create: (full, { branch, message, files, base, author, signal } = {}) => {
                if (!branch) throw new TypeError('git.commits.create: a branch');
                if (!message) throw new TypeError('git.commits.create: a message');
                if (!Array.isArray(files) || !files.length) throw new TypeError('git.commits.create: at least one file');
                for (const f of files) if (!f || !f.path || f.content == null) throw new TypeError('git.commits.create: every file has a path and content');
                return call({ method: 'POST', path: repoAt(full, 'commits', 'git.commits.create'), json: { branch, message, files, base, author }, signal });
            },
        },

        tokens: {
            /** A clone token for the person (or the service): scopes git.repo.read and/or git.repo.write, hours (default 1). */
            create: ({ scopes = ['git.repo.read'], hours = 1, label, signal } = {}) => {
                const list = Array.isArray(scopes) ? scopes : [scopes];
                if (!list.length || list.some((s) => !SCOPES.includes(s))) throw new TypeError(`git.tokens.create: scopes are ${SCOPES.join(' and ')}`);
                return call({ method: 'POST', path: '/api/v1/tokens', json: { scopes: list, hours, label }, signal });
            },
        },

        /** The three ways onto a computer: https (a clone URL), link (the Link app approves it) or codes. */
        clone: (full, { to = 'https', directory, token } = {}) => {
            const name = fullName(full, 'git.clone');
            const url = `https://git.openvibe.codes/${name}.git`;
            const target = directory ? ` ${directory}` : '';
            if (to === 'https') return { repo: name, url, command: `git clone ${token ? url.replace('https://', `https://x-access-token:${token}@`) : url}${target}` };
            if (to === 'link') return { repo: name, url, command: `git clone ${url}${target}`, href: `openvibe-link://clone?repo=${enc(name)}${directory ? `&directory=${enc(directory)}` : ''}` };
            if (to === 'codes') return { repo: name, url, href: `https://openvibe.codes/new?repo=${enc(name)}` };
            throw new TypeError("git.clone: to is 'https', 'link' or 'codes'");
        },
    };
}

module.exports = { createGitClient, SCOPES, SORTS, STARTERS };
