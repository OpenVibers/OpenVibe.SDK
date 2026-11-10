'use strict';
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { createAiClient } = require('../src/ai');

run([
    ['ov.ai.files attaches privately to Media, lists, reads and removes by Media object id', async () => {
        const calls = [];
        const objects = {
            upload: async (data, opts) => { calls.push(['upload', data, opts]); return { id: 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV', filename: opts.filename, mime_type: opts.mimeType, size_bytes: 3 }; },
            list: async (q) => { calls.push(['list', q]); return { objects: [{ id: 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV', filename: 'a.txt', mime_type: 'text/plain', size_bytes: 3, owner_id: 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV' }], next_cursor: null }; },
            signedUrl: async (id) => ({ url: `https://media.test/${id}` }),
            get: async (id) => ({ id }), delete: async (id) => { calls.push(['delete', id]); return true; },
        };
        const ai = createAiClient({ json: async () => ({}) }, { objectsClient: objects, fetch: async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }) });
        const file = await ai.files.attach('abc', { filename: 'a.txt', mediaType: 'text/plain', subject: 'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV' });
        assert.equal(file.storage.provider, 'media');
        assert.deepEqual(file.access.readers, ['usr_01ARZ3NDEKTSV4RRFFQ69G5FAV']);
        assert.equal(calls[0][2].visibility, 'private');
        assert.equal((await ai.files.list()).files[0].name, 'a.txt');
        assert.deepEqual([...((await ai.files.read(file.id)).bytes)], [1, 2, 3]);
        assert.equal(await ai.files.remove(file.id), true);
    }],
]);
