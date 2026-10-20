'use strict';
/**
 * openvibe-sdk/tips — OpenVibe.Tips: a creator's tip page, tipping (with a message, a TTS line, a media or sound
 * request), receipts, goals, supporters, moderation, overlays and external tips. Money moves through OpenVibe.Billing;
 * this is the product around it. Its /api/v1 honours Idempotency-Key on every POST and PATCH (the same key twice runs
 * once), so the SDK's automatic keys make a retried tip safe. Tokens are for audience openvibe.tips: a person acts on
 * their own things; a service holds one capability per route.
 *
 *   const tips = createTipsClient(createClient({ tokenProvider }));
 *   const page = await tips.profiles.get('goosely');                                   // the public tip page
 *   const { checkout_url } = await tips.tip({ creator: 'goosely', amount: 500, message: 'gg', pay_with: 'checkout' });
 *   await tips.goals.create({ title: 'New mic', target: 20000 });                      // the creator's own
 *   const { interactions, next_cursor } = await tips.interactions.list({ as: 'creator' });
 *
 * Amounts are what Tips states (minor units, cents). Errors are OpenVibeError with Tips' codes (tips.page_off,
 * tips.amount_invalid, idempotency.in_progress …).
 */
const enc = encodeURIComponent;
const CREATOR_RE = /^(me|[A-Za-z0-9_]{1,32})$/;

function createTipsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createTipsClient: pass an openvibe-sdk/core client');
    const call = (opts) => client.json({ service: 'tips', baseUrl, audience: 'openvibe.tips', ...opts });
    const who = (creator) => {
        const c = String(creator || '').replace(/^@/, '');
        if (!CREATOR_RE.test(c)) throw new TypeError('tips: a creator is a username (or "me")');
        return enc(c);
    };
    const id = (v, what) => {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(v || ''))) throw new TypeError(`tips: ${what}`);
        return enc(String(v));
    };
    const post = (path, json, signal) => call({ method: 'POST', path, json: json || {}, signal });

    const profiles = {
        /** A creator's tip page (public when switched on; the owner always). */
        get: (creator, { signal } = {}) => call({ path: `/api/v1/profiles/${who(creator)}`, signal }),
        /** Update your page (`me` creates it): its settings, what supporters may send, minimums. */
        update: (patch, { signal } = {}) => call({ method: 'PATCH', path: '/api/v1/profiles/me', json: patch, signal }),
        /** The owner's totals. */
        totals: (creator = 'me', { signal } = {}) => call({ path: `/api/v1/profiles/${who(creator)}/totals`, signal }),
        /** The sounds a supporter may request. */
        sounds: (creator, { signal } = {}) => call({ path: `/api/v1/profiles/${who(creator)}/sounds`, signal }),
        /** The supporters list (public when the creator shows it; the owner always). */
        supporters: (creator, { signal } = {}) => call({ path: `/api/v1/profiles/${who(creator)}/supporters`, signal }),
    };

    /**
     * Tip a creator → { interaction, checkout_url, checkout_ref } (a checkout_url to complete when paying by checkout).
     * { creator, amount, message?, goal_id?, pay_with: 'credit' | 'checkout', provider?, privacy? }; a service passes
     * `supporter`.
     */
    const tip = (req, { signal } = {}) => post('/api/v1/checkout', req, signal);
    const send = {
        /** A paid chat message. */
        message: (req, { signal } = {}) => post('/api/v1/paid-messages', req, signal),
        /** A paid TTS line: { …, tts: { text, voice } }. */
        tts: (req, { signal } = {}) => post('/api/v1/tts-requests', req, signal),
        /** A paid media request: { …, media: { url } }. */
        media: (req, { signal } = {}) => post('/api/v1/media-requests', req, signal),
        /** A paid sound: { …, sound: { id } } (from profiles.sounds). */
        sound: (req, { signal } = {}) => post('/api/v1/sound-requests', req, signal),
    };

    const interactions = {
        get: (interactionId, { signal } = {}) => call({ path: `/api/v1/interactions/${id(interactionId, 'an interaction id')}`, signal }),
        /** Your receipts, or with { as: 'creator' } the tips you received. */
        list: ({ creator, supporter, as, cursor, signal } = {}) => call({ path: '/api/v1/interactions', query: { creator, supporter, as, cursor }, signal }),
        /** A service records a tip made elsewhere: { creator, provider, provider_ref, amount_cents, supporter_name?, message?, announce? }. */
        recordExternal: (req, { signal } = {}) => post('/api/v1/interactions/external', req, signal),
        hide: (interactionId, { reason, signal } = {}) => post(`/api/v1/interactions/${id(interactionId, 'an interaction id')}/hide`, reason ? { reason } : {}, signal),
        restore: (interactionId, { reason, signal } = {}) => post(`/api/v1/interactions/${id(interactionId, 'an interaction id')}/restore`, reason ? { reason } : {}, signal),
    };

    const goals = {
        list: (creator, { signal } = {}) => call({ path: '/api/v1/goals', query: { creator: String(creator || '').replace(/^@/, '') || undefined }, signal }),
        get: (goalId, { signal } = {}) => call({ path: `/api/v1/goals/${id(goalId, 'a goal id')}`, signal }),
        create: (goal, { signal } = {}) => post('/api/v1/goals', goal, signal),
        update: (goalId, patch, { signal } = {}) => call({ method: 'PATCH', path: `/api/v1/goals/${id(goalId, 'a goal id')}`, json: patch, signal }),
        close: (goalId, { signal } = {}) => post(`/api/v1/goals/${id(goalId, 'a goal id')}/close`, {}, signal),
    };

    const moderation = {
        /** Held, hidden or visible tips: { creator, state: 'held' | 'hidden' | 'visible' | 'all' }. */
        queue: ({ creator, state, signal } = {}) => call({ path: '/api/v1/moderation', query: { creator, state }, signal }),
        log: ({ creator, signal } = {}) => call({ path: '/api/v1/moderation/log', query: { creator }, signal }),
        moderators: {
            list: ({ signal } = {}) => call({ path: '/api/v1/moderators', signal }),
            add: (req, { signal } = {}) => post('/api/v1/moderators', req, signal),
            remove: (subject, { signal } = {}) => post(`/api/v1/moderators/${id(subject, 'a moderator is a subject id')}/remove`, {}, signal),
        },
    };

    const overlays = {
        tokens: {
            list: ({ signal } = {}) => call({ path: '/api/v1/overlay-tokens', signal }),
            create: (req = {}, { signal } = {}) => post('/api/v1/overlay-tokens', req, signal),
            revoke: (tokenId, { signal } = {}) => post(`/api/v1/overlay-tokens/${id(tokenId, 'an overlay token id')}/revoke`, {}, signal),
        },
        configs: {
            list: ({ signal } = {}) => call({ path: '/api/v1/overlay-configs', signal }),
            get: (configId, { signal } = {}) => call({ path: `/api/v1/overlay-configs/${id(configId, 'an overlay config id')}`, signal }),
            create: (config, { signal } = {}) => post('/api/v1/overlay-configs', config, signal),
            update: (configId, patch, { signal } = {}) => call({ method: 'PATCH', path: `/api/v1/overlay-configs/${id(configId, 'an overlay config id')}`, json: patch, signal }),
        },
        /** A test alert on your overlays, with nothing paid. */
        simulate: (req = {}, { signal } = {}) => post('/api/v1/simulate', req, signal),
    };

    const me = {
        /** Your own tips as a download. */
        export: ({ signal } = {}) => call({ path: '/api/v1/me/export', signal }),
        /** Erase your data from your tips (the creator keeps the amounts). */
        erase: ({ signal } = {}) => post('/api/v1/me/erase', {}, signal),
    };

    return { profiles, tip, send, interactions, goals, moderation, overlays, me };
}

module.exports = { createTipsClient };
