'use strict';
/**
 * openvibe-sdk/quest — OpenVibe.Quest for developer apps: quests on your own events (contracts 0.193.0, capability
 * quest.app_quest.manage). Your app publishes its events at OpenVibe.Events as app.<project_key>.<name> (on behalf of
 * the person who did the thing); a quest counts them, and the person gets a badge named for your app. App quests never
 * pay OpenCoins, count production events only, and a project keeps at most 20 active.
 *
 *   const quest = createQuestClient(createClient({ tokenProvider: appTokens }));          // an app token for openvibe.quest
 *   const type = quest.eventType('prj_01JAB…', 'gem.found');                              // 'app.p01jab….gem.found'
 *   await quest.appQuests.define('collector', {
 *       title: 'Collector', why: 'Find five gems.',
 *       steps: [{ event_type: type, count: 5, label: 'Find a gem' }],
 *       badge: { name: 'Gem Collector' }, url: 'https://example.com/play',
 *   });                                                                                    // quest.app-quest@1
 *   await quest.appQuests.list();                                                         // { project_id, max, quests }
 *   await quest.appQuests.retire('collector');                                            // completions and badges stay
 *
 * Errors are OpenVibeError (status, code): quest.app_only (not an app token with a project), quest.foreign_event (a
 * step names another project's events), quest.invalid, quest.limit, capability.denied.
 */
const enc = encodeURIComponent;
const PROJECT_RE = /^prj_([0-9A-HJKMNP-TV-Z]{26})$/;
const NAME_RE = /^[a-z0-9_]+(\.[a-z0-9_]+){0,3}$/;

/** 'prj_01JAB…' → 'p01jab…': the middle segment of the project's own event types (OpenVibe.Events' project key). */
function projectKey(projectId) {
    const m = PROJECT_RE.exec(String(projectId || ''));
    if (!m) throw new TypeError('projectKey: pass a prj_… project id');
    return `p${m[1].toLowerCase()}`;
}

/** The event type an app publishes as `name` ("gem.found"): app.<project_key>.<name>. */
function eventType(projectId, name) {
    if (!NAME_RE.test(String(name || ''))) throw new TypeError('eventType: name is dot-separated segments of [a-z0-9_] (at most four)');
    return `app.${projectKey(projectId)}.${name}`;
}

function createQuestClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createQuestClient: pass an openvibe-sdk/core client');
    const call = (opts) => client.json({ service: 'quest', baseUrl, audience: 'openvibe.quest', ...opts });
    const appQuests = {
        /** Create or replace one of your app's quests (quest.app-quest-request@1) → quest.app-quest@1. */
        define: (slug, quest, { signal } = {}) => call({ method: 'PUT', path: `/api/v1/app-quests/${enc(slug)}`, json: quest, signal, idempotencyKey: false }),
        /** → { project_id, max, quests: [quest.app-quest@1] } */
        list: ({ signal } = {}) => call({ path: '/api/v1/app-quests', signal }),
        /** Retire one: no longer counted or listed; its completions and badges stay. → quest.app-quest@1 */
        retire: (slug, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/app-quests/${enc(slug)}`, signal }),
    };
    return { appQuests, eventType, projectKey };
}

module.exports = { createQuestClient, eventType, projectKey };
