'use strict';
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const player = require('../src/player');

run([
    ['player delegates current and handoff to the shared host', async () => {
        const old = global.window;
        try {
            global.window = { OVOverlay: { current: () => ({ id: 'live', href: 'https://openvibe.live/@test' }), handoffUrl: (url) => `${url}#ovo=card` } };
            assert.equal(player.current().id, 'live');
            assert.equal(player.handoff('https://openvibe.games/'), 'https://openvibe.games/#ovo=card');
        } finally { global.window = old; }
    }],
    ['player events can be unsubscribed', async () => {
        const old = global.window;
        const listeners = new Map();
        try {
            global.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
            const values = [];
            const off = player.on((event) => values.push(event.reason));
            listeners.get('openvibe:player')({ detail: { reason: 'open' } });
            off();
            assert.deepEqual(values, ['open']);
            assert.equal(listeners.size, 0);
        } finally { global.window = old; }
    }],
]);
