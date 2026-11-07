'use strict';
/**
 * openvibe-sdk/menu: menuCard builds a valid frame.menu-card@1 (plain text, the contract's caps, the
 * own-origin/openvibe.* host rule and the optional picture), and menuRoute answers the array with a
 * public cache and CORS * — [] and one log line, never a 500, when the cards cannot be built.
 */
const assert = require('node:assert/strict');
const contracts = require('openvibe-contracts');
const { menuCard, menuRoute, MENU_PATH } = require('../src/menu');

const ORIGIN = 'https://openvibe.games';
const at = Date.parse('2026-11-07T08:00:00Z');
const base = {
    id: 'new-worlds', site: 'games', title: 'New worlds', kind: 'rows', origin: ORIGIN,
    more: { label: 'All worlds', url: 'https://openvibe.games/worlds' },
    items: [
        { title: 'Moon base', meta: 'by Builder', url: 'https://openvibe.games/worlds/a' },
        { title: 'Night run', url: 'https://openvibe.media/t/x.jpg', image: { src: 'https://openvibe.media/t/x.jpg', w: 640, h: 360, alt: 'Night run' } },
    ],
    updatedAt: at,
};

function fakeRes() {
    const headers = {};
    let status = 0;
    let body;
    let ended = false;
    const res = {
        set(k, v) { headers[k.toLowerCase()] = v; return this; },
        status(n) { status = n; return this; },
        json(v) { body = v; ended = true; return this; },
        writeHead(n, h = {}) { status = n; for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v; return this; },
        end(v) { if (v !== undefined) body = JSON.parse(v); ended = true; return this; },
    };
    return { res, headers, status: () => status, body: () => body, ended: () => ended };
}

const check = (card) => assert.ok(contracts.validate('frame.menu-cards@1', [card]).valid, JSON.stringify(contracts.validate('frame.menu-cards@1', [card]).errors));

(async () => {
    const tests = [
        ['menuCard builds a contract-valid card and drops unknown fields', async () => {
            const card = menuCard({ ...base, extra: 'nope', items: [{ ...base.items[0], click: 'x' }, base.items[1]] });
            check(card);
            assert.deepEqual(Object.keys(card), ['id', 'site', 'title', 'kind', 'items', 'more', 'updated_at', 'ttl_s']);
            assert.equal(card.updated_at, '2026-11-07T08:00:00.000Z');
            assert.equal(card.ttl_s, 300);
            assert.deepEqual(Object.keys(card.items[0]), ['title', 'url', 'meta']);
            assert.ok(!('click' in card.items[0]));
            assert.deepEqual(card.items[1].image, { src: 'https://openvibe.media/t/x.jpg', w: 640, h: 360, alt: 'Night run' });
            assert.equal(menuCard({ ...base, kind: undefined }).kind, 'rows');
            assert.equal(menuCard({ ...base, ttlSeconds: 30, items: [] }).ttl_s, 30);
            assert.deepEqual(menuCard({ ...base, items: [], more: undefined }).items, []);
            assert.ok(!('more' in menuCard({ ...base, more: undefined })));
        }],

        ['text is plain and cut to the contract lengths', async () => {
            const card = menuCard({
                ...base,
                title: `<b>New</b>\n\t worlds ${'x'.repeat(100)}`,
                items: [{ title: '<i>Moon</i>\n base ' + 'y'.repeat(120), meta: '<b>by</b> ' + 'z'.repeat(200), url: 'https://openvibe.games/w' }],
            });
            assert.ok(card.title.startsWith('New worlds '));
            assert.equal(card.title.length, 60);
            assert.ok(card.items[0].title.startsWith('Moon base '));
            assert.equal(card.items[0].title.length, 80);
            assert.ok(card.items[0].meta.startsWith('by '));
            assert.equal(card.items[0].meta.length, 120);
            check(card);
            assert.throws(() => menuCard({ ...base, title: ' <b></b> ' }), /title is required/);
        }],

        ['items are capped at the contract maximum (six), and empty is allowed', async () => {
            const many = Array.from({ length: 10 }, (_, i) => ({ title: `World ${i}`, url: `https://openvibe.games/worlds/${i}` }));
            const card = menuCard({ ...base, items: many });
            assert.equal(card.items.length, 6);
            check(card);
            assert.deepEqual(menuCard({ ...base, items: [] }).items, [], 'an empty card is valid; Network skips it');
        }],

        ['urls are https, on the site own origin or an openvibe.* host', async () => {
            assert.ok(menuCard({ ...base, items: [{ title: 'A', url: 'https://openvibe.live/@nova' }] }));
            assert.ok(menuCard({ ...base, items: [{ title: 'A', url: 'https://www.openvibe.games/x' }] }), 'www is the same host');
            assert.throws(() => menuCard({ ...base, items: [{ title: 'A', url: 'https://example.com/x' }] }), /items\[0\]\.url: must be on openvibe\.games or an openvibe\.\* host/);
            assert.throws(() => menuCard({ ...base, items: [{ title: 'A', url: 'http://openvibe.games/x' }] }), /items\[0\]\.url: must be https/);
            assert.throws(() => menuCard({ ...base, items: [{ title: 'A', url: 'https://u:p@openvibe.games/x' }] }), /credentials/);
            assert.throws(() => menuCard({ ...base, items: [{ title: 'A', url: `https://openvibe.games/${'x'.repeat(390)}` }] }), /at most 400/);
            assert.throws(() => menuCard({ ...base, more: { label: 'All', url: 'https://example.com/worlds' } }), /more\.url: must be on openvibe\.games/);
            // No origin and no more: only openvibe.* links can be checked, so a third-party link is refused.
            assert.throws(() => menuCard({ id: base.id, site: base.site, title: base.title, items: [{ title: 'A', url: 'https://example.com/x' }] }), /openvibe\.\* host/);
            // more.url names the site when origin is omitted (a site's "see all" link is its own page).
            assert.ok(menuCard({ id: base.id, site: base.site, title: base.title, more: base.more, items: [{ title: 'A', url: 'https://openvibe.games/x' }] }));
        }],

        ['a picture follows the host rule; one from elsewhere is dropped and the item stays', async () => {
            const card = menuCard({ ...base, items: [
                { title: 'Own', url: 'https://openvibe.games/a', image: { src: 'https://openvibe.games/a.jpg', w: 16, h: 1920 } },
                { title: 'Elsewhere', url: 'https://openvibe.games/b', image: { src: 'https://example.com/b.jpg' } },
                { title: 'Plain http', url: 'https://openvibe.games/c', image: { src: 'http://openvibe.games/c.jpg' } },
            ] });
            assert.deepEqual(card.items[0].image, { src: 'https://openvibe.games/a.jpg', w: 16, h: 1920 });
            assert.ok(!('image' in card.items[1]) && !('image' in card.items[2]), 'a bad picture src is dropped, never a placeholder');
            check(card);
            assert.throws(() => menuCard({ ...base, items: [{ title: 'A', url: 'https://openvibe.games/a', image: { src: 'https://openvibe.games/a.jpg', w: 15 } }] }), /image\.w must be an integer from 16 to 1920/);
            assert.throws(() => menuCard({ ...base, items: [{ title: 'A', url: 'https://openvibe.games/a', image: 'x' }] }), /image must be an object/);
        }],

        ['the card fields themselves are checked, naming the bad one', async () => {
            assert.throws(() => menuCard({ ...base, id: 'Bad' }), /id must match/);
            assert.throws(() => menuCard({ ...base, site: 'not a site' }), /site must match/);
            assert.throws(() => menuCard({ ...base, kind: 'list' }), /kind must be one of/);
            assert.throws(() => menuCard({ ...base, items: 'x' }), /items must be an array/);
            assert.throws(() => menuCard({ ...base, items: [null] }), /items\[0\] must be an object/);
            assert.throws(() => menuCard({ ...base, items: [{ title: ' ', url: 'https://openvibe.games/a' }] }), /items\[0\]\.title is required/);
            assert.throws(() => menuCard({ ...base, more: { label: '', url: 'https://openvibe.games/' } }), /more\.label is required/);
            assert.throws(() => menuCard({ ...base, ttlSeconds: 29 }), /ttlSeconds must be an integer from 30 to 86400/);
            assert.throws(() => menuCard({ ...base, updatedAt: 'not a date' }), /updatedAt must be a date/);
            assert.throws(() => menuCard({ ...base, origin: 'http://openvibe.games' }), /origin must be an https URL/);
        }],

        ['menuRoute answers Express with the cards, a public cache and CORS *', async () => {
            const card = menuCard(base);
            let calls = 0;
            const handler = menuRoute(async () => { calls++; return [card]; }, { maxAgeSeconds: 30 });
            assert.equal(MENU_PATH, '/.well-known/openvibe-menu.json');
            const r = fakeRes();
            assert.equal(await handler({ method: 'GET', url: MENU_PATH }, r.res), true);
            assert.equal(calls, 1);
            assert.equal(r.status(), 200);
            assert.deepEqual(r.body(), [card]);
            assert.equal(r.headers['cache-control'], 'public, max-age=30');
            assert.equal(r.headers['access-control-allow-origin'], '*');
            assert.match(r.headers['content-type'], /application\/json/);
            assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin');
        }],

        ['menuRoute answers node:http the same way, HEAD has no body, other paths return false', async () => {
            const card = menuCard(base);
            const handler = menuRoute(() => [card], { maxAgeSeconds: 60 });
            const r = fakeRes();
            assert.equal(await handler({ method: 'GET', url: `${MENU_PATH}?x=1` }, r.res), true);
            assert.equal(r.status(), 200);
            assert.deepEqual(r.body(), [card]);
            assert.equal(r.headers['cache-control'], 'public, max-age=60');
            const head = fakeRes();
            assert.equal(await handler({ method: 'HEAD', url: MENU_PATH }, head.res), true);
            assert.equal(head.status(), 200);
            assert.equal(head.ended(), true);
            const other = fakeRes();
            assert.equal(await handler({ method: 'GET', url: '/api/frame' }, other.res), false);
            assert.equal(other.ended(), false);
            const post = fakeRes();
            assert.equal(await handler({ method: 'POST', url: MENU_PATH }, post.res), true);
            assert.equal(post.status(), 405);
            // A router mounted at '/' still answers.
            const root = fakeRes();
            assert.equal(await handler({ method: 'GET', url: '/' }, root.res), true);
            assert.equal(root.status(), 200);
        }],

        ['a getCards failure is [] with no-store, never a 500, and logs once', async () => {
            const logged = [];
            const log = { error: (...a) => logged.push(a) };
            let fail = true;
            const card = menuCard(base);
            const handler = menuRoute(async () => { if (fail) throw new Error('db down'); return [card]; }, { log });
            const bad = fakeRes();
            assert.equal(await handler({ method: 'GET', url: MENU_PATH }, bad.res), true);
            assert.equal(bad.status(), 200);
            assert.deepEqual(bad.body(), []);
            assert.equal(bad.headers['access-control-allow-origin'], '*');
            assert.equal(bad.headers['cache-control'], 'no-store');
            const bad2 = fakeRes();
            await handler({ method: 'GET', url: MENU_PATH }, bad2.res);
            assert.equal(logged.length, 1, 'one build failure logs once, not once per request');
            fail = false;
            const good = fakeRes();
            await handler({ method: 'GET', url: MENU_PATH }, good.res);
            assert.equal(good.body()[0].site, 'games');
        }],

        ['an invalid card never reaches the file: it is left out, [] when none is left, logged once', async () => {
            const card = menuCard(base);
            const logged = [];
            const handler = menuRoute(() => [{ ...card, ttl_s: 1 }, card], { log: { error: () => logged.push(1) } });
            const r = fakeRes();
            await handler({ method: 'GET', url: MENU_PATH }, r.res);
            assert.deepEqual(r.body(), [card]);
            assert.equal(logged.length, 1);
            const none = fakeRes();
            await menuRoute(() => [{ ...card, id: 'Bad' }], { log: { error: () => {} } })({ method: 'GET', url: MENU_PATH }, none.res);
            assert.deepEqual(none.body(), []);
            const single = fakeRes();
            await menuRoute(() => card)({ method: 'GET', url: MENU_PATH }, single.res);
            assert.deepEqual(single.body(), [card], 'one card is accepted as a one-card file');
            const notArray = fakeRes();
            await menuRoute(() => 'nope')({ method: 'GET', url: MENU_PATH }, notArray.res);
            assert.deepEqual(notArray.body(), []);
            const tooMany = Array.from({ length: 5 }, (_, i) => menuCard({ ...base, id: `card-${i}` }));
            const capped = fakeRes();
            await menuRoute(() => tooMany)({ method: 'GET', url: MENU_PATH }, capped.res);
            assert.equal(capped.body().length, 3, 'frame.menu-cards@1 allows at most three cards');
        }],

        ['the ESM entry and the package export resolve by name', async () => {
            const esm = await import('openvibe-sdk/menu');
            assert.equal(esm.default, require('../src/menu'));
            assert.equal(typeof esm.menuCard, 'function');
            assert.equal(typeof esm.menuRoute, 'function');
            assert.equal(esm.MENU_PATH, MENU_PATH);
            assert.deepEqual(require('openvibe-sdk/menu'), { MENU_PATH, menuCard, menuRoute });
        }],
    ];
    for (const [name, fn] of tests) {
        await fn();
        console.log(`  ok  ${name}`);
    }
    console.log(`menu: ${tests.length} checks, cards validate against openvibe-contracts ${require('openvibe-contracts/package.json').version}`);
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
