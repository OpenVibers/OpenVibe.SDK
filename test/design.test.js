'use strict';
/**
 * Design: the public design.component@1 registry (paths, a missing component is null, a bad name is refused before a
 * request), and the body the API returns unchanged. The registry needs no token; the icon API still does
 * (test/design-icons.test.js covers the icons).
 */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run } = require('./helpers');
const { createDesignClient } = require('../src/design');

const DEFINITION = {
    schema: 'design.component@1', name: 'sheet', title: 'Sheet', summary: 'A modal task surface.',
    anatomy: [{ part: 'header', role: 'title and close' }], props: { title: 'string' }, states: ['closed', 'open'],
    tokens: ['color.bg.raised'], behaviors: { keyboardAware: true, outsideTapCloses: true, scrollLock: true, reducedMotion: 'Crossfade.' },
    accessibility: { name: 'Sheet', target: '44 × 44', focus: 'Trap focus.' },
    platforms: { web: { module: 'openvibe-shared/kit', markup: 'kit.sheet()', demo: '/components/sheet' },
        android: { toolkit: 'Jetpack Compose', material3: 'SurfaceContainerHigh', specification: 'ModalBottomSheet.' },
        ios: { toolkit: 'SwiftUI', specification: '.sheet.' } },
    examples: [{ title: 'Default', props: { title: 'Add a site' } }],
};

run([
    ['components(): the registry body unchanged; component(name): one definition, null when missing; no token needed', async () => {
        const srv = await stubServer((req, res) => {
            if (req.url === '/api/v1/components') return send(res, 200, { schema: 'design.component@1', components: [DEFINITION], kitComponents: [] });
            if (req.url === '/api/v1/components/sheet') return send(res, 200, { schema: 'design.component@1', component: DEFINITION, examples: DEFINITION.examples });
            return problem(res, 404, 'design.component_not_found', 'No component by that name.');
        });
        const d = createDesignClient({ baseUrl: srv.url });
        const all = await d.components();
        assert.equal(all.components[0].name, 'sheet');
        const one = await d.component('sheet');
        assert.equal(one.component.behaviors.scrollLock, true);
        assert.equal(await d.component('no-such-part'), null);
        assert.equal(srv.requests[0].url, '/api/v1/components');
        assert.equal(srv.requests[0].headers.authorization, undefined, 'no token: none sent');
        assert.equal(srv.requests[1].url, '/api/v1/components/sheet');
        const signed = createDesignClient({ baseUrl: srv.url, accessToken: 'user-jwt' });
        await signed.components();
        assert.equal(srv.requests[3].headers.authorization, 'Bearer user-jwt', 'a token, when given, goes along');
        await assert.rejects(() => d.icons.get('heart'), /needs accessToken/, 'the icon API still needs a token');
        await srv.close();
    }],
    ['a bad name is refused before a request; a server error still throws', async () => {
        const srv = await stubServer((req, res) => send(res, 500, { error: 'boom' }));
        const d = createDesignClient({ baseUrl: srv.url });
        await assert.rejects(() => d.component('Sheet!'), TypeError);
        await assert.rejects(() => d.component('sheet'), (err) => err.status === 500);
        assert.equal(srv.requests.length, 1, 'the bad name made no request');
        assert.throws(() => createDesignClient({ accessToken: '' }), TypeError, 'an empty token is a mistake, not "no token"');
        await srv.close();
    }],
]);
