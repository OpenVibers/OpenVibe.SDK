'use strict';
/**
 * openvibe-sdk/exchange against a fake Exchange and a fake Network: the buyer calls, the seller
 * registration, the retries and the webhook signature.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stubServer, send, problem, run } = require('./helpers');
const { createExchangeClient, ExchangeError, verifyWebhook, SIGNATURE_TOLERANCE_SEC } = require('../src/exchange');

const KEY = 'dev_key_for_tests';
const OWNER = 'usr_' + '0'.repeat(26);
const MACHINE = 'dev_' + '0'.repeat(26);

/** A client pointed at the fake servers, with a backoff short enough for a test. */
function client(exchange, network, options = {}) {
    return createExchangeClient({
        developerKey: KEY,
        baseUrl: exchange.url,
        networkUrl: (network || exchange).url,
        retryBaseMs: 1,
        maxRetries: 3,
        ...options,
    });
}

const completion = {
    id: 'chatcmpl-run_1',
    object: 'chat.completion',
    created: 1760486400,
    model: 'openvibe',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    system_fingerprint: null,
    x_openvibe: { run_id: 'run_1', provider: 'acme', fallback_used: false, cost_usd: 0.001, synthetic: false },
};

run([
    ['chat answers the OpenAI shape', async () => {
        const server = await stubServer(async (req, res, body) => {
            assert.equal(req.url, '/v1/chat/completions');
            assert.equal(req.headers.authorization, 'Bearer ' + KEY);
            send(res, 200, completion);
        });
        try {
            const exchange = client(server);
            const answer = await exchange.chat({ model: 'openvibe', messages: [{ role: 'user', content: 'hi' }] });
            assert.equal(answer.object, 'chat.completion');
            assert.equal(answer.id, 'chatcmpl-run_1');
            assert.equal(answer.usage.total_tokens, 5);
            assert.equal(answer.x_openvibe.run_id, 'run_1');
            const body = JSON.parse(String(server.requests[0].body));
            assert.equal(body.model, 'openvibe');
            assert.equal(body.messages[0].content, 'hi');
        } finally {
            await server.close();
        }
    }],

    ['chat streams the chunks', async () => {
        const server = await stubServer(async (req, res, body) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ id: 'chatcmpl-run_2', object: 'chat.completion.chunk', created: 1, model: 'openvibe', choices: [{ index: 0, delta: { role: 'assistant', content: 'he' }, finish_reason: null }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ id: 'chatcmpl-run_2', object: 'chat.completion.chunk', created: 1, model: 'openvibe', choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: 'stop' }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ id: 'chatcmpl-run_2', object: 'chat.completion.chunk', created: 1, model: 'openvibe', choices: [], x_openvibe: { run_id: 'run_2' } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        });
        try {
            const exchange = client(server);
            const stream = await exchange.chat({ model: 'openvibe', messages: [{ role: 'user', content: 'hi' }], stream: true });
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            assert.equal(chunks.length, 3);
            assert.equal(chunks[0].choices[0].delta.content, 'he');
            assert.equal(chunks[1].choices[0].finish_reason, 'stop');
            assert.equal(chunks[2].x_openvibe.run_id, 'run_2');
            assert.equal(JSON.parse(String(server.requests[0].body)).stream, true);
        } finally {
            await server.close();
        }
    }],

    ['models lists the models', async () => {
        const server = await stubServer(async (req, res, body) => {
            assert.equal(req.url, '/v1/models');
            send(res, 200, { object: 'list', data: [{ id: 'openvibe', object: 'model', created: 1760486400, owned_by: 'openvibe' }] });
        });
        try {
            const answer = await client(server).models();
            assert.equal(answer.object, 'list');
            assert.equal(answer.data[0].id, 'openvibe');
        } finally {
            await server.close();
        }
    }],

    ['offers lists the offers of one model', async () => {
        const server = await stubServer(async (req, res, body) => {
            assert.equal(req.url, '/api/v1/exchange/models/deepseek/deepseek-chat');
            send(res, 200, {
                slug: 'deepseek/deepseek-chat',
                canonical: 'deepseek/deepseek-chat',
                name: 'DeepSeek Chat',
                offers: [
                    { provider: 'acme', model: 'deepseek-chat', trust: 'first-party', price: { in: 0.1, out: 0.2, per: '1M tokens', currency: 'USD' } },
                    { provider: 'home', model: 'deepseek-chat', trust: 'community', price: null },
                ],
            });
        });
        try {
            const offers = await client(server).offers('DeepSeek/DeepSeek-Chat');
            assert.equal(offers.length, 2);
            assert.equal(offers[0].provider, 'acme');
            assert.equal(offers[1].trust, 'community');
        } finally {
            await server.close();
        }
    }],

    ['presets are listed, stored, replaced and deleted', async () => {
        const server = await stubServer(async (req, res, body) => {
            if (req.method === 'GET') return send(res, 200, { presets: [{ name: 'cheapest', policy: { objective: 'cheapest' } }] });
            if (req.method === 'POST') {
                const parsed = JSON.parse(String(body));
                return send(res, 201, { preset: { name: parsed.name, policy: parsed.policy } });
            }
            return send(res, 200, { removed: req.url.split('/').pop() });
        });
        try {
            const exchange = client(server);
            const listed = await exchange.presets.list();
            assert.equal(listed.length, 1);
            assert.equal(listed[0].name, 'cheapest');
            const created = await exchange.presets.create({ name: 'Mine', policy: { objective: 'fastest' } });
            assert.equal(created.name, 'mine');
            const updated = await exchange.presets.update('mine', { policy: { objective: 'balanced' } });
            assert.equal(updated.policy.objective, 'balanced');
            const posts = server.requests.filter((r) => r.method === 'POST');
            assert.equal(posts.length, 2);
            assert.equal(JSON.parse(String(posts[1].body)).name, 'mine');
            await exchange.presets.remove('mine');
            assert.ok(server.requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/presets/mine'));
        } finally {
            await server.close();
        }
    }],

    ['usage reads the public aggregate, or the platform usage for a requester', async () => {
        const server = await stubServer(async (req, res, body) => {
            if (req.url.startsWith('/api/v1/exchange/usage')) {
                assert.equal(req.url, '/api/v1/exchange/usage?days=7');
                return send(res, 200, { generated_at: 'now', days: 7, from: 'a', to: 'b', today: {}, totals: {}, by_day: [], by_model: [], by_product: [] });
            }
            assert.equal(req.url, '/api/v1/usage?requester=svc%3Aacme');
            return send(res, 200, { usage: { requests: 2 } });
        });
        try {
            const exchange = client(server);
            const aggregate = await exchange.usage({ days: 7 });
            assert.equal(aggregate.days, 7);
            const own = await exchange.usage({ requester: 'svc:acme' });
            assert.equal(own.usage.requests, 2);
        } finally {
            await server.close();
        }
    }],

    ['receipt reads one receipt', async () => {
        const server = await stubServer(async (req, res, body) => {
            assert.equal(req.url, '/v1/receipts/rcpt_run_1');
            send(res, 200, { receipt: { id: 'rcpt_run_1', offer: { provider: 'acme', model: 'openvibe' }, tokens: { tokens_in: 3, tokens_out: 2 } } });
        });
        try {
            const receipt = await client(server).receipt('rcpt_run_1');
            assert.equal(receipt.id, 'rcpt_run_1');
            assert.equal(receipt.offer.provider, 'acme');
        } finally {
            await server.close();
        }
    }],

    ['a 429 is retried and then answers', async () => {
        let hits = 0;
        const server = await stubServer(async (req, res, body) => {
            hits++;
            if (hits === 1) return send(res, 429, { error: { message: 'slow down', type: 'rate_limit', code: 'rate_limit' } }, { 'Retry-After': '0' });
            send(res, 200, { object: 'list', data: [] });
        });
        try {
            const answer = await client(server).models();
            assert.equal(answer.object, 'list');
            assert.equal(hits, 2);
        } finally {
            await server.close();
        }
    }],

    ['a 5xx on a write is not retried, and a refusal is not either', async () => {
        const server = await stubServer(async (req, res, body) => {
            if (req.method === 'POST') return send(res, 500, { error: { message: 'boom', type: 'server_error', code: 'internal' } });
            return problem(res, 400, 'input.invalid', 'nope');
        });
        try {
            const exchange = client(server);
            await assert.rejects(() => exchange.chat({ model: 'openvibe', messages: [{ role: 'user', content: 'hi' }] }), (err) => {
                assert.ok(err instanceof ExchangeError);
                assert.equal(err.status, 500);
                assert.equal(err.retryable, true);
                return true;
            });
            assert.equal(server.requests.filter((r) => r.method === 'POST').length, 1);
            await assert.rejects(() => exchange.models(), (err) => {
                assert.equal(err.status, 400);
                assert.equal(err.retryable, false);
                assert.equal(err.code, 'input.invalid');
                return true;
            });
            assert.equal(server.requests.filter((r) => r.method === 'GET').length, 1);
        } finally {
            await server.close();
        }
    }],

    ['an aborted call stops', async () => {
        const server = await stubServer(async (req, res, body) => {
            await new Promise((r) => setTimeout(r, 500));
            send(res, 200, {});
        });
        try {
            const controller = new AbortController();
            const exchange = client(server);
            const call = exchange.models({ signal: controller.signal });
            setTimeout(() => controller.abort(), 20);
            await assert.rejects(() => call, (err) => {
                assert.ok(err instanceof ExchangeError);
                assert.match(err.message, /aborted/);
                return true;
            });
        } finally {
            await server.close();
        }
    }],

    ['the seller registers the offer in the Network registry', async () => {
        const server = await stubServer(async (req, res, body) => {
            if (req.url === '/internal/ai/offers/report') {
                assert.equal(req.headers.authorization, 'Bearer ' + KEY);
                const parsed = JSON.parse(String(body));
                assert.equal(parsed.source, 'sdk');
                assert.equal(parsed.offers.length, 1);
                const offer = parsed.offers[0];
                assert.equal(offer.offer_id, 'ai:' + MACHINE);
                assert.equal(offer.machine_id, MACHINE);
                assert.equal(offer.owner, OWNER);
                assert.deepEqual(offer.models, ['qwen3:32b']);
                assert.deepEqual(offer.hours, { start: '18:00', end: '23:30', tz: 'Europe/Lisbon' });
                assert.equal(offer.concurrency, 2);
                assert.deepEqual(offer.price, { in_per_million: 0, out_per_million: 0 });
                assert.equal(offer.audience, 'everyone');
                assert.equal(offer.ready, true);
                assert.equal(offer.health.status, 'up');
                assert.deepEqual(Object.keys(offer).sort(), ['audience', 'concurrency', 'health', 'hours', 'machine_id', 'models', 'offer_id', 'owner', 'price', 'ready']);
                return send(res, 200, { source: 'sdk', offers: 1, marked_down: 0, generated_at: 'now' });
            }
            if (req.url === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: 'qwen3:32b', object: 'model' }] });
            return problem(res, 404, 'not_found', 'no route');
        });
        try {
            const exchange = client(server);
            const result = await exchange.seller.offer({
                model: 'qwen3:32b',
                price: 0,
                hours: { start: '18:00', end: '23:30', tz: 'Europe/Lisbon' },
                concurrency: 2,
                endpoint: server.url + '/v1',
                machineId: MACHINE,
                owner: OWNER,
            });
            assert.equal(result.report.offers, 1);
            assert.deepEqual(result.endpoint.models, ['qwen3:32b']);
            assert.equal(result.offer.offer_id, 'ai:' + MACHINE);
        } finally {
            await server.close();
        }
    }],

    ['the seller refuses an offer the registry would refuse', async () => {
        const server = await stubServer(async (req, res) => send(res, 200, {}));
        try {
            const exchange = client(server);
            const base = {
                model: 'qwen3:32b',
                price: 0,
                hours: { start: '18:00', end: '23:30', tz: 'UTC' },
                concurrency: 2,
                machineId: MACHINE,
                owner: OWNER,
            };
            await assert.rejects(() => exchange.seller.offer({ ...base, concurrency: 9 }), /concurrency/);
            await assert.rejects(() => exchange.seller.offer({ ...base, hours: { start: '25:00', end: '23:30' } }), /hours/);
            await assert.rejects(() => exchange.seller.offer({ ...base, price: -1 }), /price/);
            await assert.rejects(() => exchange.seller.offer({ ...base, machineId: 'nope' }), /machineId/);
            await assert.rejects(() => exchange.seller.offer({ ...base, audience: 'group' }), /group/);
            assert.equal(server.requests.length, 0);
        } finally {
            await server.close();
        }
    }],

    ['earnings names the owner and verification maps the offers', async () => {
        const server = await stubServer(async (req, res, body) => {
            assert.equal(req.url, '/api/v1/community/sell');
            assert.equal(req.headers['x-ov-subject'], OWNER);
            send(res, 200, {
                owner: OWNER,
                generated_at: 'now',
                offers: [{
                    offer_id: 'ai:' + MACHINE,
                    machine_id: MACHINE,
                    models: ['qwen3:32b'],
                    health: 'up',
                    open_now: true,
                    ready: true,
                    verification: { status: 'verified', canary_passes: 3, canary_failures: 0, spot_runs: 1, spot_failures: 0 },
                    verified: true,
                    reputation: 80,
                    free_only: false,
                    uptime_pct: 99.4,
                }],
                totals: { requests: 4, tokens_in: 10, tokens_out: 20, pending_credits_micro: 0, spendable_credits_micro: 5, self_served_requests: 1 },
            });
        });
        try {
            const exchange = client(server, null, { owner: OWNER });
            const sold = await exchange.seller.earnings();
            assert.equal(sold.totals.spendable_credits_micro, 5);
            const verification = await exchange.seller.verification();
            assert.equal(verification.offers.length, 1);
            assert.equal(verification.offers[0].verified, true);
            assert.equal(verification.offers[0].reputation, 80);
            assert.equal(verification.offers[0].uptime_pct, 99.4);
            assert.equal(verification.offers[0].verification.canary_passes, 3);
        } finally {
            await server.close();
        }
    }],

    ['the seller registers a standalone endpoint on the Exchange, lists it and removes it', async () => {
        const offer = {
            id: 'ep_' + '0'.repeat(26), offer_id: 'endpoint:ep_' + '0'.repeat(26), name: 'my 3090',
            base_url: 'https://my-server.example/v1', models: ['qwen3:32b', 'qwen3:8b'],
            hours: { start: '00:00', end: '23:59', tz: 'Europe/Lisbon' }, concurrency: 2,
            price: { in_per_million: 10, out_per_million: 30 }, audience: 'everyone', group: null,
        };
        const server = await stubServer(async (req, res, body) => {
            assert.equal(req.headers.authorization, 'Bearer ' + KEY);
            if (req.method === 'POST' && req.url === '/api/v1/exchange/seller/offers') {
                const parsed = JSON.parse(String(body));
                assert.deepEqual(parsed, {
                    base_url: 'https://my-server.example/v1', models: ['qwen3:32b', 'qwen3:8b'],
                    price: { in_per_million: 10, out_per_million: 30 },
                    hours: { start: '00:00', end: '23:59', tz: 'Europe/Lisbon' },
                    concurrency: 2, audience: 'everyone',
                });
                return send(res, 201, { offer });
            }
            if (req.method === 'GET' && req.url === '/api/v1/exchange/seller/offers') {
                return send(res, 200, { owner: OWNER, offers: [offer] });
            }
            if (req.method === 'DELETE' && req.url === `/api/v1/exchange/seller/offers/${offer.id}`) {
                return send(res, 200, { id: offer.id, removed: true });
            }
            return problem(res, 404, 'not_found', 'no route');
        });
        try {
            const exchange = client(server);
            const registered = await exchange.seller.offer({
                endpoint: 'https://my-server.example/v1',
                models: ['qwen3:32b', 'qwen3:8b'],
                price: { in_per_million: 10, out_per_million: 30 },
                hours: { start: '00:00', end: '23:59', tz: 'Europe/Lisbon' },
                concurrency: 2,
                probe: false,
            });
            assert.equal(registered.offer.id, offer.id);
            assert.deepEqual(registered.endpoint, { url: 'https://my-server.example/v1', models: null });
            const listed = await exchange.seller.endpointOffers();
            assert.equal(listed.owner, OWNER);
            assert.equal(listed.offers[0].id, offer.id);
            const removed = await exchange.seller.removeEndpointOffer(offer.id);
            assert.deepEqual(removed, { id: offer.id, removed: true });
        } finally {
            await server.close();
        }
    }],

    ['the endpoint form is https only and is not sent when it is refused', async () => {
        const server = await stubServer(async (req, res) => send(res, 200, {}));
        try {
            const exchange = client(server);
            await assert.rejects(() => exchange.seller.offer({
                endpoint: 'http://my-server.example/v1', models: ['qwen3:32b'], price: 0, hours: { start: '00:00', end: '23:59' },
                concurrency: 1, probe: false,
            }), /https/);
            await assert.rejects(() => exchange.seller.offer({
                endpoint: 'https://my-server.example/v1', models: ['qwen3:32b'], price: -1, hours: { start: '00:00', end: '23:59' },
                concurrency: 1, probe: false,
            }), /price/);
            await assert.rejects(() => exchange.seller.offer({
                endpoint: 'https://my-server.example/v1', models: ['qwen3:32b'], price: 0, hours: { start: '25:00', end: '23:59' },
                concurrency: 1, probe: false,
            }), /hours/);
            assert.equal(server.requests.length, 0);
        } finally {
            await server.close();
        }
    }],

    ['a webhook signature is checked in constant time', async () => {
        const secret = 'webhook_secret';
        const body = JSON.stringify({ type: 'exchange.earnings', credits: 12 });
        const stamp = Math.floor(Date.now() / 1000);
        const digest = crypto.createHmac('sha256', secret).update(stamp + '.' + body).digest('hex');
        const header = 't=' + stamp + ',v2=' + digest;
        assert.equal(verifyWebhook(body, header, secret), true);
        assert.equal(verifyWebhook(body, header, 'another_secret'), false);
        assert.equal(verifyWebhook(body + ' ', header, secret), false);
        assert.equal(verifyWebhook(body, header, secret, { now: (stamp + SIGNATURE_TOLERANCE_SEC + 10) * 1000 }), false);
        const legacy = crypto.createHmac('sha256', secret).update(body).digest('hex');
        assert.equal(verifyWebhook(body, 'sha256=' + legacy, secret), true);
        assert.equal(verifyWebhook(body, 'not a signature', secret), false);
        assert.equal(verifyWebhook(null, header, secret), false);
    }],

    ['the client refuses what it cannot do', async () => {
        assert.throws(() => createExchangeClient({}), /developerKey/);
        assert.throws(() => createExchangeClient({ developerKey: 'k', fetchImpl: null }), /fetch/);
        assert.throws(() => createExchangeClient({ developerKey: 'k', baseUrl: 'nope' }), /baseUrl/);
        const exchange = createExchangeClient({ developerKey: 'k' });
        assert.equal(exchange.baseUrl(), 'https://api.openvibe.exchange');
        assert.equal(exchange.networkUrl(), 'https://api.openvibe.network');
        await assert.rejects(() => exchange.receipt(''), /receipt/);
    }],
]);
