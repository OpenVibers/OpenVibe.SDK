'use strict';
/** Media files: multipart shape, credentials, acting user, 404s, public URL helpers. */
const assert = require('node:assert/strict');
const { stubServer, send, run } = require('./helpers');
const { createClient } = require('../src/core');
const { createMediaClient, mediaUrls } = require('../src/media');

/** Split a multipart body into { name, filename, contentType, value } parts. */
function parseMultipart(body, contentType) {
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    assert.ok(boundary, 'multipart boundary in Content-Type');
    const b = boundary[1] || boundary[2];
    const text = body.toString('latin1');
    assert.ok(text.trimEnd().endsWith(`--${b}--`), 'closing boundary');
    return text.split(`--${b}`).slice(1, -1).map((chunk) => {
        const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
        const value = rest.join('\r\n\r\n').replace(/\r\n$/, '');
        const disp = head.match(/content-disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i);
        const type = head.match(/content-type: ([^\r\n]+)/i);
        return { name: disp[1], filename: disp[2], contentType: type && type[1], value };
    });
}

run([
    ['upload sends one multipart `file` part with filename and type, and the app key', async () => {
        const srv = await stubServer((req, res) => send(res, 201, { key: '0123456789ab-hello.txt', app_id: 'demo', url: '/f/0123456789ab-hello.txt', size: 11, mime: 'text/plain' }));
        const media = createMediaClient(createClient({ baseUrls: { media: srv.url } }), { app: 'demo', apiKey: 'app-key-1', publicOrigin: 'https://media.example' });
        const out = await media.files.upload(Buffer.from('hello world'), { filename: 'hello.txt', contentType: 'text/plain', userId: 7 });
        const r = srv.requests[0];
        assert.equal(r.method, 'POST');
        assert.equal(r.url, '/api/v1/demo/files');
        assert.equal(r.headers.authorization, 'Bearer app-key-1');
        assert.match(r.headers['content-type'], /^multipart\/form-data; boundary=/);
        const parts = parseMultipart(r.body, r.headers['content-type']);
        assert.deepEqual(parts.map((p) => p.name), ['user_id', 'file']);
        assert.equal(parts[0].value, '7');
        assert.equal(parts[1].filename, 'hello.txt');
        assert.equal(parts[1].contentType, 'text/plain');
        assert.equal(parts[1].value, 'hello world');
        assert.equal(out.public_url, 'https://media.example/f/0123456789ab-hello.txt');
        await srv.close();
    }],

    ['a Blob/File keeps its own name and type; strings and typed arrays work', async () => {
        const srv = await stubServer((req, res) => send(res, 201, { key: 'k', url: '/f/k' }));
        const media = createMediaClient(createClient({ baseUrls: { media: srv.url }, token: 'svc-token' }), { app: 'live' });
        await media.upload(new File([new Uint8Array([1, 2, 3])], 'clip.bin', { type: 'application/octet-stream' }));
        await media.upload('plain text');
        await media.upload(new Uint8Array([104, 105]), { filename: 'hi.txt' });
        const [a, b, c] = srv.requests.map((r) => parseMultipart(r.body, r.headers['content-type']).find((p) => p.name === 'file'));
        assert.equal(a.filename, 'clip.bin');
        assert.equal(a.contentType, 'application/octet-stream');
        assert.equal(Buffer.from(a.value, 'latin1').toString('hex'), '010203');
        assert.equal(b.filename, 'file');
        assert.equal(b.value, 'plain text');
        assert.equal(c.filename, 'hi.txt');
        assert.equal(srv.requests[0].headers.authorization, 'Bearer svc-token', 'the client token (service token) when there is no app key');
        await assert.rejects(media.upload({ not: 'a file' }), TypeError);
        await srv.close();
    }],

    ['upload retries a transient failure (content-addressed keys dedupe)', async () => {
        const srv = await stubServer((req, res, _b, n) => (n === 1 ? send(res, 503, '') : send(res, 200, { key: 'k', url: '/f/k', deduplicated: true })));
        const media = createMediaClient(createClient({ baseUrls: { media: srv.url }, retryDelayMs: 5 }), { app: 'live', apiKey: 'k' });
        assert.equal((await media.upload('x')).deduplicated, true);
        assert.equal(srv.requests.length, 2);
        assert.equal(parseMultipart(srv.requests[1].body, srv.requests[1].headers['content-type']).find((p) => p.name === 'file').value, 'x');
        await srv.close();
    }],

    ['X-OV-User-Id names the acting user; list/get/delete', async () => {
        const srv = await stubServer((req, res) => {
            if (req.method === 'GET' && req.url.startsWith('/api/v1/live/files?')) return send(res, 200, { files: [{ key: 'a', url: '/f/a' }], used_bytes: 1, quota_bytes: 0, limit: 100, offset: 0 });
            if (req.url.endsWith('/missing')) return send(res, 404, { error: 'File not found' });
            if (req.method === 'GET') return send(res, 200, { key: 'a', url: '/f/a' });
            return send(res, 200, { message: 'File deleted' });
        });
        const media = createMediaClient(createClient({ baseUrls: { media: srv.url } }), { app: 'live', apiKey: 'k', actingUserId: 12 });
        const list = await media.files.list({ limit: 100 });
        assert.equal(list.files[0].public_url, 'https://openvibe.media/f/a');
        assert.equal(srv.requests[0].headers['x-ov-user-id'], '12');
        assert.equal((await media.files.get('a')).key, 'a');
        assert.equal(await media.files.get('missing'), null);
        assert.equal(await media.files.delete('a', { actingUserId: 99 }), true);
        assert.equal(srv.requests.at(-1).headers['x-ov-user-id'], '99');
        assert.equal(await media.files.delete('missing'), false);
        const all = [];
        for await (const f of media.files.iterate()) all.push(f.key);
        assert.deepEqual(all, ['a']);
        await srv.close();
    }],

    ['public URL helpers', async () => {
        const u = mediaUrls();
        assert.equal(u.file('abc-x y.png'), 'https://openvibe.media/f/abc-x%20y.png');
        assert.equal(u.vod(12), 'https://openvibe.media/v/12');
        assert.equal(u.clip('c1'), 'https://openvibe.media/c/c1');
        assert.equal(u.thumbnail('t.jpg'), 'https://openvibe.media/t/t.jpg');
        assert.equal(u.paste('Ab12'), 'https://openvibe.media/p/Ab12');
        assert.equal(u.pasteRaw('Ab12'), 'https://openvibe.media/p/Ab12/raw');
        assert.equal(u.pasteScreenshot('Ab12'), 'https://openvibe.media/p/Ab12/screenshot');
        assert.equal(u.vodTranscript(3), 'https://openvibe.media/v/3/transcript.json');
        assert.equal(u.liveFrame('@ana', { width: 320 }), 'https://openvibe.media/live/%40ana/frame.jpg?w=320');
        assert.equal(u.liveTranscript('whip', { limit: 5, app: 'live' }), 'https://openvibe.media/live/whip/transcript.json?limit=5&app=live');
        assert.equal(mediaUrls('http://127.0.0.1:4100/').absolute('/f/k'), 'http://127.0.0.1:4100/f/k');
        assert.equal(u.absolute('https://cdn.example/x'), 'https://cdn.example/x');
        assert.throws(() => createMediaClient(createClient(), {}), TypeError);
    }],
]);
