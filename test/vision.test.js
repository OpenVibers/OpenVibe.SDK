'use strict';
/** openvibe-sdk/vision: the typed calls against a fake Vision server (multipart bytes, data URLs, JSON, binary). */
const assert = require('node:assert/strict');
const { stubServer, send, problem, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createVisionClient, DEFAULT_AUDIENCE } = require('../src/vision');

const ANSWER = {
    answer: {
        id: 'vis_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4', task: 'ask', mode: 'auto', source: 'upload',
        image_sha256: 'a'.repeat(64), image_mime: 'image/png', image_bytes: 11,
        text: 'A desk with a keyboard.', answer: {}, model: 'tesseract', provider: 'local', route: 'local.ocr',
        reason: 'the local OCR reader answered the read task', cost_usd: 0, latency_ms: 12,
        created_at: '2026-10-29T10:00:00.000Z',
    },
    engine: 'local',
};

run([
    ['ask sends bytes as one multipart image and words as JSON', async () => {
        const srv = await stubServer((req, res) => send(res, 201, ANSWER));
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url }, token: 'user-token' }));
        const out = await vision.ask(Buffer.from('hello world'), { question: 'What is on the desk?', task: 'ask' });
        assert.equal(out.answer.text, 'A desk with a keyboard.');
        const r = srv.requests[0];
        assert.equal(r.method, 'POST');
        assert.equal(r.url, '/api/v1/ask');
        assert.equal(r.headers.authorization, 'Bearer user-token');
        assert.match(r.headers['content-type'], /^multipart\/form-data; boundary=/);
        const text = r.body.toString('latin1');
        assert.match(text, /name="image"; filename="image"/);
        assert.match(text, /name="question"\r\n\r\nWhat is on the desk\?/);
        assert.match(text, /hello world/);
        await srv.close();
    }],

    ['a public URL and a data URL go as JSON, never as unverified bytes', async () => {
        const srv = await stubServer((req, res) => send(res, 201, ANSWER));
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url } }));
        await vision.ask('https://example.com/photo.png', { mode: 'local' });
        await vision.ask('data:image/png;base64,iVBORw0KGgo=', { mode: 'local' });
        assert.equal(srv.requests[0].headers['content-type'], 'application/json');
        assert.deepEqual(JSON.parse(srv.requests[0].body), { image_url: 'https://example.com/photo.png', mode: 'local' });
        assert.deepEqual(JSON.parse(srv.requests[1].body), { image: 'data:image/png;base64,iVBORw0KGgo=', mode: 'local' });
        await srv.close();
    }],

    ['OCR, compare and the UI check carry only their own fields', async () => {
        const srv = await stubServer((req, res) => {
            if (req.url === '/api/v1/compare') return send(res, 201, { answer: ANSWER.answer, compare: [{ engine: 'local', ok: true, text: 'hi', cost_usd: 0, latency_ms: 3 }] });
            if (req.url === '/api/v1/ui-check') return send(res, 201, { check: { id: 'vuc_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4', source: 'html', viewport: { w: 1280, h: 800 }, engine: 'static-html', findings: [], created_at: '2026-10-29T10:00:00.000Z' } });
            return send(res, 201, ANSWER);
        });
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url } }));
        await vision.ocr(Buffer.from('png'), { fallback: true, lang: 'eng', model: 'openai:gpt-4o-mini' });
        assert.match(srv.requests[0].body.toString('latin1'), /name="fallback"\r\n\r\ntrue/);
        const compared = await vision.compare(Buffer.from('png'), { task: 'describe', models: ['a', 'b'] });
        assert.equal(compared.compare.length, 1);
        const checked = await vision.uiCheck({ html: '<!doctype html><p>ok</p>', viewport: { w: 1280, h: 800 } });
        assert.equal(checked.check.engine, 'static-html');
        assert.deepEqual(JSON.parse(srv.requests[2].body), { html: '<!doctype html><p>ok</p>', viewport: { w: 1280, h: 800 } });
        await srv.close();
    }],

    ['find searches the caller\'s own index by words', async () => {
        const srv = await stubServer((req, res) => send(res, 200, { answer: { results: [{ item_id: 'media:1', result_url: 'https://openvibe.media/f/x', score: 0.8 }], receipt: { engine: 'local', model: 'CLIP ViT-B/32 q8', cost_usd: 0, ms: 4, confidence: 0.8, retention: 'query not stored' } } }));
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url }, token: 'user-token' }));
        const out = await vision.find('red bike by the pier');
        assert.equal(out.answer.results[0].item_id, 'media:1');
        assert.equal(srv.requests[0].url, '/api/v1/find?q=red+bike+by+the+pier');
        await srv.close();
    }],

    ['face tools use the same endpoint and keep the disposition headers', async () => {
        const srv = await stubServer((req, res) => {
            if (req.url === '/api/v1/faces/blur') {
                res.writeHead(200, { 'Content-Type': 'image/png', 'X-Faces-Blurred': '2' });
                return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            }
            if (req.url === '/api/v1/faces/consents' && req.method === 'GET') return send(res, 200, [{ id: 'fco_01J8Z3Q4R5S6T7V8W9X0Y1Z2A4', feature: 'verify', scope: '', text_version: 'face-verify-2026-10-28', granted_at: '2026-10-29T10:00:00.000Z', revoked_at: null }]);
            return send(res, 201, { feature: 'verify', scope: '', text_version: 'face-verify-2026-10-28', granted_at: '2026-10-29T10:00:00.000Z' });
        });
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url }, token: 'user-token' }));
        const blurred = await vision.face.blur(Buffer.from('png'));
        assert.equal(blurred.faceCount, 2);
        assert.equal(blurred.contentType, 'image/png');
        assert.deepEqual([...new Uint8Array(blurred.bytes)], [0x89, 0x50, 0x4e, 0x47]);
        const granted = await vision.face.grant('verify', { signed_name: 'Ana', text_version: 'face-verify-2026-10-28' });
        assert.equal(granted.feature, 'verify');
        assert.deepEqual(JSON.parse(srv.requests[1].body), { signed_name: 'Ana', text_version: 'face-verify-2026-10-28' });
        const list = await vision.face.consents();
        assert.equal(list[0].revoked_at, null);
        await srv.close();
    }],

    ['a refusal is the service\'s problem details, not a silent empty answer', async () => {
        const srv = await stubServer((req, res) => problem(res, 403, 'faces.consent_required', 'Enable verify consent first.'));
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url }, token: 'user-token', retries: 0 }));
        await assert.rejects(() => vision.face.verify(Buffer.from('png')), (err) => err.status === 403 && err.code === 'faces.consent_required');
        await srv.close();
    }],

    ['MCP and the protected-resource document are plain calls on the same origin', async () => {
        const srv = await stubServer((req, res) => {
            if (req.url === '/.well-known/oauth-protected-resource') return send(res, 200, { resource: 'https://openvibe.vision', authorization_servers: ['https://openvibe.network'], scopes_supported: ['openid'], bearer_methods_supported: ['header'] });
            return send(res, 200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } });
        });
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url } }));
        assert.equal(vision.answer.length, 1);
        const meta = await vision.protectedResource();
        assert.equal(meta.authorization_servers[0], 'https://openvibe.network');
        const out = await vision.mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        assert.equal(out.result.protocolVersion, '2025-06-18');
        assert.equal(srv.requests[1].url, '/mcp');
        assert.equal(srv.requests[1].headers['mcp-protocol-version'], '2025-06-18');
        await srv.close();
    }],

    ['the audience is openvibe.vision', async () => {
        assert.equal(DEFAULT_AUDIENCE, 'openvibe.vision');
        const srv = await stubServer((req, res) => send(res, 200, { ai: false, configured: [], offered: [], local: ['tesseract'], note: 'x' }));
        const seen = [];
        const vision = createVisionClient(createClient({ baseUrls: { vision: srv.url }, getToken: async ({ audience }) => { seen.push(audience); return 'svc-token'; } }));
        await vision.models();
        assert.deepEqual(seen, ['openvibe.vision']);
        await srv.close();
    }],
]);
