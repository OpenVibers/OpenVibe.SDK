'use strict';
/** openvibe-sdk/exchange: the public, keyless compute price book. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createExchangeClient, createComputePriceClient, ExchangeError } = require('../src/exchange');

const BOOK = {
    checked_at: '2026-11-11T00:00:00.000Z',
    prices: [
        { id: 'daytona-4090-preemptible', provider: 'daytona', kind: 'gpu', gpu: 'RTX 4090', gpu_mb: 24576, hourly: 0.57, per_second: 0.57 / 3600, interruptible: true, checked_at: '2026-11-11T00:00:00.000Z', expires_at: Date.parse('2026-11-18T00:00:00Z'), source: 'https://www.daytona.io/pricing' },
        { id: 'fly-iad-2x2', provider: 'fly', region: 'iad', kind: 'cpu', cpu: 2, ram_mb: 2048, hourly: 13.39 / 720, per_second: 13.39 / 720 / 3600, checked_at: '2026-11-11T00:00:00.000Z', expires_at: Date.parse('2026-11-18T00:00:00Z'), source: 'https://docs.fly.io/about/pricing' },
    ],
};

run([
    ['createComputePriceClient reads the public book with no key and filters by kind', async () => {
        const server = await stubServer(async (req, res) => {
            assert.equal(req.url, '/api/compute/prices');
            assert.equal(req.headers.authorization, undefined);
            assert.equal(req.headers.accept, 'application/json');
            send(res, 200, BOOK);
        });
        try {
            const compute = createComputePriceClient({ baseUrl: server.url, maxRetries: 0 });
            const all = await compute.computePrices();
            assert.equal(all.checked_at, BOOK.checked_at);
            assert.equal(all.prices.length, 2);
            const gpus = await compute.computePrices({ kind: 'gpu' });
            assert.deepEqual(gpus.prices.map((p) => p.id), ['daytona-4090-preemptible']);
            assert.equal(gpus.checked_at, BOOK.checked_at);
            const cpus = await compute.computePrices({ kind: 'cpu' });
            assert.deepEqual(cpus.prices.map((p) => p.id), ['fly-iad-2x2']);
            await assert.rejects(compute.computePrices({ kind: 'tpu' }), TypeError);
        } finally {
            await server.close();
        }
    }],

    ['the keyed client also reads prices, from Exchange\'s site and without its key', async () => {
        const server = await stubServer(async (req, res) => {
            assert.equal(req.url, '/api/compute/prices');
            assert.equal(req.headers.authorization, undefined);
            send(res, 200, BOOK);
        });
        try {
            const exchange = createExchangeClient({ developerKey: 'dev_key', siteUrl: server.url, maxRetries: 0 });
            const book = await exchange.computePrices({ kind: 'cpu' });
            assert.deepEqual(book.prices.map((p) => p.id), ['fly-iad-2x2']);
            assert.equal(book.checked_at, BOOK.checked_at);
            assert.match(exchange.baseUrl(), /^https:\/\/api\.openvibe\.exchange$/);
        } finally {
            await server.close();
        }
    }],

    ['a refused or broken price book is an ExchangeError, and options are checked', async () => {
        const server = await stubServer(async (req, res) => send(res, 503, { detail: 'compute prices unavailable' }));
        try {
            const compute = createComputePriceClient({ baseUrl: server.url, maxRetries: 0 });
            await assert.rejects(compute.computePrices(), (err) => err instanceof ExchangeError && err.status === 503 && /unavailable/.test(err.message));
            assert.throws(() => createComputePriceClient({ baseUrl: 'nope' }), /baseUrl/);
            assert.throws(() => createExchangeClient({ developerKey: 'k', siteUrl: 'nope' }), /siteUrl/);
        } finally {
            await server.close();
        }
    }],
]);
