'use strict';
/** Pics discovery, private uploads, explicit publication and albums. */
function createPicsClient(client, { baseUrl = 'https://openvibe.pics' } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createPicsClient requires an SDK core client');
    const call = (o) => client.json({ service: 'media-hub', audience: 'openvibe.download', baseUrl, ...o });
    const enc = (v) => encodeURIComponent(String(v));
    const image = (slug) => `/api/v1/images/${enc(slug)}`;
    const upload = (id) => `/api/v1/uploads/${enc(id)}`;
    const album = (slug) => `/api/v1/albums/${enc(slug)}`;
    return {
        gallery: (query = {}) => call({ path: '/api/v1/gallery', query }),
        get: (id) => call({ path: `/api/v1/pictures/${enc(id)}` }),
        mine: (query = {}) => call({ path: '/api/v1/me/images', query }),
        update: (slug, patch) => call({ method: 'PATCH', path: image(slug), json: patch, idempotent: true }),
        publish: (slug, { listed, tags } = {}) => call({ method: 'POST', path: `${image(slug)}/publication`, json: { listed, tags }, idempotent: true }),
        like: (slug, liked = true) => call({ method: liked ? 'PUT' : 'DELETE', path: `${image(slug)}/like`, idempotent: true }),
        remove: (slug) => call({ method: 'DELETE', path: image(slug) }),
        uploads: {
            create: (input) => call({ method: 'POST', path: '/api/v1/uploads', json: input, idempotencyKey: false }),
            get: (id) => call({ path: upload(id) }),
            chunk: (id, offset, bytes) => call({ method: 'PATCH', path: upload(id), headers: { 'content-type': 'application/octet-stream', 'upload-offset': String(offset) }, body: bytes, idempotent: false, retry: false }),
            complete: (id) => call({ method: 'POST', path: `${upload(id)}/complete`, idempotent: true }),
            cancel: (id) => call({ method: 'DELETE', path: upload(id) }),
        },
        albums: {
            list: () => call({ path: '/api/v1/albums' }),
            create: (input) => call({ method: 'POST', path: '/api/v1/albums', json: input, idempotencyKey: false }),
            get: (slug) => call({ path: album(slug) }),
            add: (slug, pictureSlug) => call({ method: 'POST', path: `${album(slug)}/images`, json: { image: pictureSlug }, idempotent: true }),
            removeImage: (slug, pictureSlug) => call({ method: 'DELETE', path: `${album(slug)}/images/${enc(pictureSlug)}` }),
            remove: (slug) => call({ method: 'DELETE', path: album(slug) }),
        },
    };
}
module.exports = { createPicsClient };
