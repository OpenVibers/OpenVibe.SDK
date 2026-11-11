'use strict';
// openvibe-sdk/quest cardData: the same three Quest reads Live's server makes — today's quest (/daily or /me/daily),
// the public catalog (/quests) and the person's log (/me/quests) — with the catalog kept ten minutes, best-effort
// door figures, and null when the quest itself cannot be read.
const assert = require('node:assert/strict');
const { createQuestClient } = require('../src/quest');

const steps = [
    { id: 'pics', event_type: 'mediahub.picture.uploaded', site: 'openvibe.pics', sentence: 'Upload a picture', href: 'https://openvibe.pics/', count: 1, progress: 1, done: true },
    { id: 'chat', event_type: 'chat.room.message.created', site: 'openvibe.chat', sentence: 'Send a public chat message', href: 'https://openvibe.chat/', count: 1, progress: 0, done: false },
];
const publicQuest = { date: '2026-11-10', title: 'Make something today', story: 'Three small things, across the network.', steps, finished_today: 12 };
const myQuest = { ...publicQuest, steps, progress: 1, streak: 5, completed: false, time_zone: 'Europe/London' };
const catalog = { quests: Array.from({ length: 12 }, (_, i) => ({ id: `q${i}` })), sites: Array.from({ length: 6 }, (_, i) => ({ site: `s${i}` })) };

function fake(overrides = {}) {
    const calls = [];
    const client = {
        json: async (opts) => {
            calls.push(opts);
            const answer = Object.prototype.hasOwnProperty.call(overrides, opts.path) ? overrides[opts.path] : {
                '/api/v1/daily': publicQuest,
                '/api/v1/me/daily': myQuest,
                '/api/v1/quests': catalog,
                '/api/v1/me/quests': {
                    quests: [{ state: 'completed' }, { state: 'completed' }, { state: 'in_progress' }, { state: 'not_started' }],
                    badges: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
                },
                '/api/v1/me/daily/time-zone': { ok: true },
            }[opts.path];
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
    return { quest: createQuestClient(client, { baseUrl: 'http://quest.test' }), calls };
}

(async () => {
    // Signed out: the public quest and the catalog. No person's log and no time-zone write.
    {
        const { quest, calls } = fake();
        const data = await quest.cardData({ timeZone: 'Europe/London' });
        assert.equal(data.signed_in, false);
        assert.equal(data.quest.title, 'Make something today');
        assert.deepEqual(data.more, { quests: 12, sites: 6 });
        assert.deepEqual(calls.map((c) => c.path).sort(), ['/api/v1/daily', '/api/v1/quests']);
        assert.equal(calls.find((c) => c.path === '/api/v1/daily').token, null);
        assert.equal(calls.find((c) => c.path === '/api/v1/quests').token, null);
        assert.equal(calls.find((c) => c.path === '/api/v1/daily').audience, 'openvibe.quest');
        assert.equal(calls.find((c) => c.path === '/api/v1/daily').service, 'quest');
        assert.equal(calls.find((c) => c.path === '/api/v1/daily').baseUrl, 'http://quest.test');
        assert.equal(calls.find((c) => c.path === '/api/v1/daily').timeoutMs, 4500);
    }

    // Signed in: time zone first, then the person's quest and log; the catalog was read once and is reused.
    {
        const { quest, calls } = fake();
        const data = await quest.cardData({ token: 'tok_123', timeZone: 'Europe/London' });
        assert.equal(data.signed_in, true);
        assert.equal(data.quest.streak, 5);
        assert.deepEqual(data.more, { quests: 12, sites: 6, mine: { badges: 3, in_progress: 1, completed: 2 } });
        assert.equal(calls[0].path, '/api/v1/me/daily/time-zone');
        assert.equal(calls[0].method, 'PUT');
        assert.deepEqual(calls[0].json, { time_zone: 'Europe/London' });
        assert.equal(calls[0].idempotencyKey, false);
        assert.ok(calls.every((c) => c.token === 'tok_123'), 'the person token is on every read');
        assert.deepEqual(calls.slice(1).map((c) => c.path).sort(), ['/api/v1/me/daily', '/api/v1/me/quests', '/api/v1/quests']);

        // A second card read reuses the catalog; an invalid time zone is not sent.
        const before = calls.filter((c) => c.path === '/api/v1/quests').length;
        await quest.cardData({ token: 'tok_123', timeZone: 'not a zone' });
        assert.equal(calls.filter((c) => c.path === '/api/v1/quests').length, before, 'catalog cached');
        assert.equal(calls.filter((c) => c.path === '/api/v1/me/daily/time-zone').length, 1, 'invalid zone skipped');
    }

    // The catalog is kept ten minutes, then read again.
    {
        const { quest, calls } = fake();
        const realNow = Date.now;
        let clock = 1_000_000;
        Date.now = () => clock;
        try {
            await quest.cardData();
            assert.equal(calls.filter((c) => c.path === '/api/v1/quests').length, 1);
            clock += 10 * 60 * 1000 - 1;
            await quest.cardData();
            assert.equal(calls.filter((c) => c.path === '/api/v1/quests').length, 1, 'still inside ten minutes');
            clock += 2;
            await quest.cardData();
            assert.equal(calls.filter((c) => c.path === '/api/v1/quests').length, 2, 'one second after ten minutes');
        } finally { Date.now = realNow; }
    }

    // A door figure that fails never costs the card; a failed quest does.
    {
        const catalogDown = fake({ '/api/v1/quests': new Error('down') });
        const data = await catalogDown.quest.cardData({ token: 'tok_123' });
        assert.equal(data.signed_in, true);
        assert.deepEqual(data.more, { mine: { badges: 3, in_progress: 1, completed: 2 } });

        const logDown = fake({ '/api/v1/me/quests': new Error('down') });
        const other = await logDown.quest.cardData({ token: 'tok_123' });
        assert.deepEqual(other.more, { quests: 12, sites: 6 });

        const everythingDown = fake({ '/api/v1/quests': new Error('down'), '/api/v1/me/quests': new Error('down') });
        const bare = await everythingDown.quest.cardData({ token: 'tok_123' });
        assert.deepEqual(bare.more, {});

        const questDown = fake({ '/api/v1/daily': new Error('down') });
        assert.equal(await questDown.quest.cardData(), null);
        const myQuestDown = fake({ '/api/v1/me/daily': new Error('down') });
        assert.equal(await myQuestDown.quest.cardData({ token: 'tok_123' }), null);
    }

    process.stdout.write('quest cardData passed\n');
})().catch((err) => { process.stderr.write(String(err.stack || err) + '\n'); process.exit(1); });
