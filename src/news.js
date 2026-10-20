'use strict';
/**
 * openvibe-sdk/news — OpenVibe.News' published stories for apps: the topics, the stories (published and retracted,
 * newest first) and one story with its numbered sources, timeline and perspectives. Routes at
 * https://openvibe.news/api/v1; public, sent without a token (audience openvibe.news).
 * Writing and the editorial reads (drafts, revisions, clusters, ingestion) are News' editors' (first-party).
 *
 *   const news = createNewsClient(createClient({}));
 *   const { topics } = await news.topics();
 *   const { stories } = await news.stories.list({ topic: 'space', limit: 10 });
 *   const { story } = await news.stories.get(stories[0].id);                   // every paragraph cites its sources
 *
 * A retracted story stays at its URL with its public retraction note. Every story rests on attached sources: News
 * never publishes a paragraph without one.
 */
const enc = encodeURIComponent;

function createNewsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createNewsClient: pass an openvibe-sdk/core client');
    const at = { service: 'news', baseUrl, audience: 'openvibe.news' };
    const call = (opts) => client.json({ ...at, auth: false, ...opts });   // public reads: never a token

    return {
        topics: ({ signal } = {}) => call({ path: '/api/v1/topics', signal }),
        stories: {
            /** Published and retracted stories, newest first, by topic. */
            list: ({ topic, limit, offset, signal } = {}) => call({ path: '/api/v1/stories', query: { topic, limit, offset }, signal }),
            /** One published story by id or slug, with its source table, timeline and perspectives. */
            get: (id, { signal } = {}) => {
                if (!id || typeof id !== 'string') throw new TypeError("news.stories.get: a story's id");
                return call({ path: `/api/v1/stories/${enc(id)}`, signal });
            },
        },
    };
}

module.exports = { createNewsClient };
