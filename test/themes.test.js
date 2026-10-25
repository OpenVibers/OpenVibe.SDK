'use strict';
/**
 * Themes: the account's theme API (paths, bodies, a missing theme is null, display values cleaned), seasons by date
 * (over New Year too), readable text on a colour, painting a theme, and followTheme keeping a page or game in step.
 */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const themes = require('../src/themes');

run([
    ['the account: paths, bodies, null for a missing theme, display cleaned', async () => {
        const srv = await stubServer((req, res) => {
            if (req.url === '/api/themes/nope') return send(res, 404, { error: 'Theme not found' });
            if (req.url === '/api/themes/nord') return send(res, 200, { theme: { id: 'nord', variables: { '--accent': '#88c0d0' } } });
            return send(res, 200, { ok: true });
        });
        const t = themes.createThemesClient(createClient({ baseUrls: { network: srv.url }, token: 'user-jwt' }));
        assert.equal(await t.get('nope'), null);
        assert.equal((await t.get('nord')).id, 'nord');
        await t.catalog({ mode: 'dark' });
        await t.active();
        await t.set('vibe', { custom: { '--accent': '#ff5c8a' } });
        await t.setDisplay({ motion: 'reduced', text: '125', seasonal: 'off', colour: 'red', 'text-extra': 1 });
        await t.seasons({ date: '2026-10-25' });
        const got = srv.requests.slice(2).map((r) => [r.method, r.url, r.body && String(r.body).length ? JSON.parse(String(r.body)) : null]);
        assert.deepEqual(got, [
            ['GET', '/api/themes?mode=dark', null],
            ['GET', '/api/themes/me/active', null],
            ['PUT', '/api/themes/me', { theme_id: 'vibe', custom_variables: { '--accent': '#ff5c8a' } }],
            ['PUT', '/api/themes/me/display', { motion: 'reduced', text: '125', seasonal: 'off' }],
            ['GET', '/api/themes/seasons?date=2026-10-25', null],
        ]);
        assert.equal(srv.requests[0].headers.authorization, 'Bearer user-jwt');
        await srv.close();
    }],
    ['seasons by date, readable text, painting a theme', async () => {
        const seasons = [{ id: 'halloween', theme: 'halloween', from: '10-01', to: '10-31' }, { id: 'ny', theme: 'confetti', from: '12-30', to: '01-02' }];
        assert.equal(themes.seasonOn(new Date(2026, 9, 31), seasons).id, 'halloween');
        assert.equal(themes.seasonOn(new Date(2026, 10, 1), seasons), null);
        assert.equal(themes.seasonOn(new Date(2027, 0, 2), seasons).id, 'ny', 'a season may run over New Year');
        assert.equal(themes.onColor('#ff7a1a'), '#0b0d10');
        assert.equal(themes.onColor('#1d4ed8'), '#ffffff');
        assert.equal(themes.onColor('orange'), null);
        const props = {}; const attrs = {};
        const el = { style: { setProperty: (k, v) => { props[k] = v; } }, setAttribute: (k, v) => { attrs[k] = v; } };
        themes.applyTheme({ '--accent': '#ff7a1a', '--color-scheme': 'dark', color: 'red' }, { root: el });
        assert.deepEqual(props, { '--accent': '#ff7a1a', '--color-scheme': 'dark', '--on-accent': '#0b0d10' }, 'only custom properties, with readable text on the accent');
        assert.equal(attrs['data-theme-mode'], 'dark');
    }],
    ['followTheme: once at once, again on each change (batched), stop() ends it', async () => {
        const listeners = {};
        const attrs = { 'data-theme': 'halloween', 'data-theme-mode': 'dark', 'data-ov-season': 'halloween', 'data-ov-season-mark': 'halloween' };
        let accent = '#ff7a1a';
        const html = { getAttribute: (k) => attrs[k] ?? null };
        const saved = { window: global.window, document: global.document, getComputedStyle: global.getComputedStyle, MutationObserver: global.MutationObserver };
        global.document = { documentElement: html };
        global.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--accent' ? accent : n === '--bg-primary' ? '#0e0a14' : '') });
        global.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() { this.off = true; } };
        global.window = {
            addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
            removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
            OpenVibeThemeLoader: { display: { get: () => ({ motion: 'reduced', text: '112', seasonal: 'on' }) } },
        };
        try {
            const seen = [];
            const stop = themes.followTheme((t) => seen.push(t));
            assert.equal(seen.length, 1, 'called at once');
            assert.deepEqual([seen[0].id, seen[0].mode, seen[0].tokens['--accent'], seen[0].tokens['--bg-primary'], seen[0].season.id, seen[0].seasonMark], ['halloween', 'dark', '#ff7a1a', '#0e0a14', 'halloween', 'halloween']);
            assert.deepEqual([seen[0].display.textScale, seen[0].display.calm], [1.12, true], 'text scale and calm motion for a game');
            accent = '#88c0d0';
            listeners['ov:theme'].forEach((f) => f()); listeners['ov:display'].forEach((f) => f());
            await new Promise((r) => setImmediate(r));
            assert.equal(seen.length, 2, 'two events in one tick: one call');
            assert.equal(seen[1].tokens['--accent'], '#88c0d0', 'read fresh');
            listeners.storage.forEach((f) => f({ key: 'unrelated' }));
            await new Promise((r) => setImmediate(r));
            assert.equal(seen.length, 2, 'other storage keys are ignored');
            stop();
            assert.ok(!(listeners['ov:theme'] || []).length && !(listeners.storage || []).length, 'stop() removes every listener');
        } finally { Object.assign(global, saved); }
    }],
]);
