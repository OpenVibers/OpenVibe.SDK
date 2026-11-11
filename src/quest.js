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
 * The card any site can show reads today's quest and what waits on Quest, with a person's Network token:
 *   await quest.cardData({ token, timeZone });   // { signed_in, quest, more: { quests, sites, mine } }
 * It makes the same three reads OpenVibe.Live's server makes (/daily or /me/daily, /quests and /me/quests), keeps the
 * catalog ten minutes, and never sends a browser cookie: the site fetches it server-side and passes the token.
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
    const CATALOG_TTL_MS = 10 * 60 * 1000;
    let catalog = null;   // { at, value: { quests, sites } }, the public catalog
    const soft = (p) => p.catch(() => null);   // a door figure never costs the card itself
    const get = (path, token, opts = {}) => call({ path, token, timeoutMs: 4500, ...opts });
    /** How many quests and sites the public catalog has; one read per ten minutes. */
    const counts = async (token) => {
        if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.value;
        const all = await soft(get('/api/v1/quests', token));
        if (!all || !Array.isArray(all.quests)) return null;
        const value = { quests: all.quests.length, sites: Array.isArray(all.sites) ? all.sites.length : 0 };
        catalog = { at: Date.now(), value };
        return value;
    };
    /** A person's badges and quest states, as counts. */
    const mine = async (token) => {
        const me = token ? await soft(get('/api/v1/me/quests', token)) : null;
        if (!me || !Array.isArray(me.quests)) return null;
        return {
            badges: Array.isArray(me.badges) ? me.badges.length : 0,
            in_progress: me.quests.filter((q) => q && q.state === 'in_progress').length,
            completed: me.quests.filter((q) => q && q.state === 'completed').length,
        };
    };
    const withMore = async (result, token) => {
        const [cat, own] = await Promise.all([counts(token), mine(token)]);
        return { ...result, more: { ...(cat || {}), ...(own ? { mine: own } : {}) } };
    };
    const appQuests = {
        /** Create or replace one of your app's quests (quest.app-quest-request@1) → quest.app-quest@1. */
        define: (slug, quest, { signal } = {}) => call({ method: 'PUT', path: `/api/v1/app-quests/${enc(slug)}`, json: quest, signal, idempotencyKey: false }),
        /** → { project_id, max, quests: [quest.app-quest@1] } */
        list: ({ signal } = {}) => call({ path: '/api/v1/app-quests', signal }),
        /** Retire one: no longer counted or listed; its completions and badges stay. → quest.app-quest@1 */
        retire: (slug, { signal } = {}) => call({ method: 'DELETE', path: `/api/v1/app-quests/${enc(slug)}`, signal }),
    };
    /**
     * The daily quest card's data, with the same three Quest reads Live makes. Signed out reads the public today
     * question; a token reads the person's own checklist and can send `timeZone` for their local day. Returns null
     * when the quest itself cannot be read; the catalog and the person's log are best-effort.
     */
    const cardData = async ({ token = null, timeZone = 'UTC' } = {}) => {
        try {
            if (!token) {
                const [quest, extra] = await Promise.all([get('/api/v1/daily', null), withMore({}, null)]);
                return quest && { signed_in: false, quest, ...extra };
            }
            if (timeZone && /^[A-Za-z0-9_+\/-]{1,64}$/.test(timeZone)) {
                await soft(get('/api/v1/me/daily/time-zone', token, {
                    method: 'PUT', json: { time_zone: timeZone }, idempotencyKey: false,
                }));
            }
            const [quest, extra] = await Promise.all([get('/api/v1/me/daily', token), withMore({}, token)]);
            if (!quest) return null;
            return { signed_in: true, quest, ...extra };
        } catch { return null; }
    };
    return {
        appQuests, eventType, projectKey, cardData,
        /** The network-wide quest for today, or a past YYYY-MM-DD date (quest.daily@1). */
        daily: ({ date, signal } = {}) => call({ path: date ? `/api/v1/daily/${enc(date)}` : '/api/v1/daily', signal }),
        /** This signed-in person's guided quest for today (requires a person token). */
        today: ({ signal } = {}) => call({ path: '/api/v1/quests/today', signal }),
        /** The person token's own checklist, completion and streak (quest.daily-progress@1). */
        myDaily: ({ signal } = {}) => call({ path: '/api/v1/me/daily', signal }),
        /** Approved event-backed step types (quest.step-type@1). */
        stepTypes: ({ signal } = {}) => call({ path: '/api/v1/step-types', signal }),
        /** Suggest a step; the app token needs quest.steps.contribute. Review precedes use. */
        contributeStepType: (stepType, { signal } = {}) => call({ method: 'POST', path: '/api/v1/step-types', json: stepType, signal, idempotencyKey: false }),
    };
}

module.exports = { createQuestClient, eventType, projectKey };
