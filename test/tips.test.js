'use strict';
// openvibe-sdk/tips: OpenVibe.Tips' /api/v1 through a real core client against a local stub: every route and method,
// an Idempotency-Key on each write (Tips replays the same key once, so a retried tip is safe and is retried), the
// creator and id checks done before any call.
const assert = require('assert');
const http = require('http');
const { createClient } = require('../src/core');
const { createTipsClient } = require('../src/tips');

(async () => {
    const seen = [];
    let tipAttempts = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, idem: req.headers['idempotency-key'] || null, body: body ? JSON.parse(body) : null });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/api/v1/checkout') {
                tipAttempts++;
                if (tipAttempts === 1) return json(503, { type: 'about:blank', title: 'busy', status: 503 });
                return json(201, { interaction: { id: 'int_1' }, checkout_url: 'https://pay.example/x', checkout_ref: 'ref' });
            }
            return json(200, { ok: true });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tips = createTipsClient(createClient({ baseUrls: { tips: base }, token: 'tok', retries: 2, retryDelayMs: 1, maxRetryDelayMs: 2 }));

    try {
        await tips.profiles.get('@goosely');
        await tips.profiles.update({ enabled: true });
        await tips.profiles.totals();
        await tips.profiles.sounds('goosely');
        await tips.profiles.supporters('goosely');
        await tips.send.message({ creator: 'goosely', amount: 100, message: 'hi' });
        await tips.send.tts({ creator: 'goosely', amount: 100, tts: { text: 'hello', voice: 'en' } });
        await tips.send.media({ creator: 'goosely', amount: 100, media: { url: 'https://example.com/v' } });
        await tips.send.sound({ creator: 'goosely', amount: 100, sound: { id: 'snd_1' } });
        await tips.interactions.get('int_1');
        await tips.interactions.list({ as: 'creator', cursor: 'c2' });
        await tips.interactions.recordExternal({ creator: 'goosely', provider: 'kofi', provider_ref: 'k1', amount_cents: 300 });
        await tips.interactions.hide('int_1', { reason: 'spam' });
        await tips.interactions.restore('int_1');
        await tips.goals.list('goosely');
        await tips.goals.get('gol_1');
        await tips.goals.create({ title: 'New mic', target: 20000 });
        await tips.goals.update('gol_1', { title: 'Better mic' });
        await tips.goals.close('gol_1');
        await tips.moderation.queue({ creator: 'goosely', state: 'held' });
        await tips.moderation.log({ creator: 'goosely' });
        await tips.moderation.moderators.list();
        await tips.moderation.moderators.add({ subject: 'usr_x' });
        await tips.moderation.moderators.remove('usr_x');
        await tips.overlays.tokens.list();
        await tips.overlays.tokens.create();
        await tips.overlays.tokens.revoke('ovt_1');
        await tips.overlays.configs.list();
        await tips.overlays.configs.get('ovc_1');
        await tips.overlays.configs.create({ kind: 'alert' });
        await tips.overlays.configs.update('ovc_1', { volume: 50 });
        await tips.overlays.simulate({ kind: 'tip' });
        await tips.me.export();
        await tips.me.erase();
        assert.deepStrictEqual(seen.map((s) => `${s.method} ${s.url}`), [
            'GET /api/v1/profiles/goosely', 'PATCH /api/v1/profiles/me', 'GET /api/v1/profiles/me/totals', 'GET /api/v1/profiles/goosely/sounds',
            'GET /api/v1/profiles/goosely/supporters', 'POST /api/v1/paid-messages', 'POST /api/v1/tts-requests', 'POST /api/v1/media-requests',
            'POST /api/v1/sound-requests', 'GET /api/v1/interactions/int_1', 'GET /api/v1/interactions?as=creator&cursor=c2',
            'POST /api/v1/interactions/external', 'POST /api/v1/interactions/int_1/hide', 'POST /api/v1/interactions/int_1/restore',
            'GET /api/v1/goals?creator=goosely', 'GET /api/v1/goals/gol_1', 'POST /api/v1/goals', 'PATCH /api/v1/goals/gol_1', 'POST /api/v1/goals/gol_1/close',
            'GET /api/v1/moderation?creator=goosely&state=held', 'GET /api/v1/moderation/log?creator=goosely', 'GET /api/v1/moderators', 'POST /api/v1/moderators',
            'POST /api/v1/moderators/usr_x/remove', 'GET /api/v1/overlay-tokens', 'POST /api/v1/overlay-tokens', 'POST /api/v1/overlay-tokens/ovt_1/revoke',
            'GET /api/v1/overlay-configs', 'GET /api/v1/overlay-configs/ovc_1', 'POST /api/v1/overlay-configs', 'PATCH /api/v1/overlay-configs/ovc_1',
            'POST /api/v1/simulate', 'GET /api/v1/me/export', 'POST /api/v1/me/erase',
        ]);
        assert.ok(seen.filter((s) => s.method !== 'GET').every((s) => s.idem), 'every write carries an Idempotency-Key');
        assert.deepStrictEqual(seen[12].body, { reason: 'spam' });

        // A tip retried through a 503 keeps its key: Tips runs it once.
        seen.length = 0;
        const out = await tips.tip({ creator: 'goosely', amount: 500, message: 'gg', pay_with: 'checkout' });
        assert.deepStrictEqual(out, { interaction: { id: 'int_1' }, checkout_url: 'https://pay.example/x', checkout_ref: 'ref' });
        assert.strictEqual(seen.length, 2, 'retried once');
        assert.ok(seen[0].idem && seen[0].idem === seen[1].idem, 'with the same Idempotency-Key');

        assert.throws(() => tips.profiles.get('no spaces here'), /username/);
        assert.throws(() => tips.goals.get('../x'), /goal id/);
        assert.throws(() => createTipsClient({}), /core client/);
        console.log('tips: all checks passed');
    } finally {
        server.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
