'use strict';
/**
 * openvibe-sdk/blog — OpenVibe.Blog for apps: read a blog's published posts and feed, and write posts on a blog the
 * person belongs to: drafts, revisions, publishing (now or scheduled), unpublishing and deleting. Routes at
 * https://openvibe.blog/api/v1; tokens for audience openvibe.blog. A developer app acts only for the person who
 * authorized it (its token's on_behalf_of): Blog refuses any other X-OV-Subject, and sandbox tokens.
 *
 *   const blog = createBlogClient(createClient({ tokenProvider }));
 *   const { posts, total } = await blog.blogs.posts('goosely', { limit: 10 });             // published, public
 *   const { post } = await blog.posts.create('goosely', { title: 'Tonight on stream', body: '…', visibility: 'public' });
 *   await blog.posts.update(post.id, { body: '… (edited)', expected_revision: 1 });         // a new revision
 *   await blog.posts.publish(post.id);                                                     // the latest revision
 *   await blog.posts.schedule(post.id, { at: '2026-10-21T18:00:00Z' });
 *   const feed = await blog.blogs.feed('goosely');                                         // JSON Feed 1.1
 *
 * Capabilities (public since openvibe-contracts 0.206.0): blog.feed.read, blog.post.read, .create, .update, .publish,
 * .unpublish, .schedule and .delete; publishing, unpublishing, scheduling and deleting are sensitive. Creating a post
 * or reverting makes a new one each time and is never retried on its own; publishing, unpublishing, scheduling, edits
 * (Blog keeps an identical edit as the same revision) and deletes are.
 * Errors are OpenVibeError: blog.not_found, blog.forbidden, post.not_found, post.members_only, revision.conflict,
 * revision.expected_required, post.review_required (an AI draft a person has not reviewed), capability.denied,
 * subject.not_delegated, …
 */
const enc = encodeURIComponent;
const POST_ID_RE = /^pst_[0-9A-HJKMNP-TV-Z]{26}$/;   // Blog's own rule
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function createBlogClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createBlogClient: pass an openvibe-sdk/core client');
    const at = { service: 'blog', baseUrl, audience: 'openvibe.blog' };
    const call = (opts) => client.json({ ...at, ...opts });
    const handle = (h) => {
        if (!HANDLE_RE.test(String(h || ''))) throw new TypeError('blog: a blog handle');
        return `/api/v1/blogs/${enc(String(h))}`;
    };
    const post = (id, rest = '') => {
        if (!POST_ID_RE.test(String(id || ''))) throw new TypeError('blog: a post is a pst_ id');
        return `/api/v1/posts/${enc(String(id))}${rest}`;
    };

    return {
        blogs: {
            /** A blog's public profile. */
            get: (h, { signal } = {}) => call({ path: handle(h), signal }),
            /** Its published posts, newest first: { total, posts }; all: true lists drafts too (members, blog.post.read). */
            posts: (h, { limit, offset, all, signal } = {}) => call({ path: `${handle(h)}/posts`, query: { limit, offset, all: all ? '1' : undefined }, signal }),
            /** Its feed as JSON Feed 1.1. */
            feed: (h, { signal } = {}) => call({ path: `${handle(h)}/feed`, signal }),
        },
        posts: {
            /** A draft on a blog the person belongs to (blog.post-create-request@1: title required) → { post, revision }. */
            create: (h, fields, { signal } = {}) => {
                if (!fields || typeof fields.title !== 'string' || !fields.title.trim()) throw new TypeError('blog.posts.create: a title');
                return call({ method: 'POST', path: `${handle(h)}/posts`, json: fields, idempotencyKey: false, signal });
            },
            get: (id, { signal } = {}) => call({ path: post(id), signal }),
            /** Edit: a new revision unless nothing changed ({ post, revision, created }); expected_revision guards a race. */
            update: (id, fields, { signal } = {}) => call({ method: 'PATCH', path: post(id), json: fields, idempotent: true, signal }),
            /** Publish a revision (the latest when omitted). */
            publish: (id, { revision } = {}, { signal } = {}) => call({ method: 'POST', path: post(id, '/publish'), json: { revision }, idempotent: true, signal }),
            unpublish: (id, { signal } = {}) => call({ method: 'POST', path: post(id, '/unpublish'), json: {}, idempotent: true, signal }),
            /** Publish (or unpublish, action: 'unpublish') at a time: { at: ISO 8601, revision?, action? } → { job, created, post }. */
            schedule: (id, { at: when, revision, action } = {}, { signal } = {}) => {
                if (!when || Number.isNaN(Date.parse(when))) throw new TypeError('blog.posts.schedule: at is an ISO 8601 time');
                return call({ method: 'POST', path: post(id, '/schedule'), json: { at: when, revision, action }, idempotent: true, signal });
            },
            cancelSchedule: (id, { signal } = {}) => call({ method: 'DELETE', path: post(id, '/schedule'), signal }),
            /** Make an earlier revision the newest one (a new revision). */
            revert: (id, { to_revision: to, expected_revision: expected } = {}, { signal } = {}) => call({ method: 'POST', path: post(id, '/revert'), json: { to_revision: to, expected_revision: expected }, idempotencyKey: false, signal }),
            remove: (id, { signal } = {}) => call({ method: 'DELETE', path: post(id), signal }),
            revisions: (id, { signal } = {}) => call({ path: post(id, '/revisions'), signal }),
            revision: (id, n, { signal } = {}) => {
                if (!Number.isInteger(Number(n)) || Number(n) < 1) throw new TypeError('blog.posts.revision: a revision number');
                return call({ path: post(id, `/revisions/${Number(n)}`), signal });
            },
        },
    };
}

module.exports = { createBlogClient };
