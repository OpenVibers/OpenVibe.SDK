'use strict';
/**
 * openvibe-sdk/vision: OpenVibe.Vision's JSON API (plan 2026-10-28 §5.8b). Browser-safe: the calls take a Blob,
 * File, ArrayBuffer or typed array, a data URL, or a public image URL, and every answer is the service's own JSON.
 *
 *   const vision = createVisionClient(client);
 *   const { answer } = await vision.ask(png, { question: 'What is on the desk?' });
 *   const alt = await vision.alt(png);                    // { answer: { alt_text, editable, receipt } }
 *   await vision.uiCheck({ url: 'https://openvibe.vision' });
 *   const group = await vision.face.consents();            // the caller's own consent records
 *
 * Who may call what is decided by Vision on every request: an anonymous caller can use the local OCR reader, the
 * UI check and the identity-free face tools; a private tool needs the person's own token; a service token needs the
 * capability its route names (vision.image.ask, vision.text.read, vision.model.compare, vision.alt.write,
 * vision.media.find, vision.receipt.read, vision.product.match, vision.camera.watch, vision.video.moments,
 * vision.face.cast.match). Face matching is refused without an active consent record for that person, and the refusal
 * is the same whether or not the person exists.
 *
 * The MCP endpoint is POST /mcp (Streamable HTTP, protocol 2025-06-18); clients that need a token discover it from
 * /.well-known/oauth-protected-resource, as RFC 9728 says.
 */
const DEFAULT_AUDIENCE = 'openvibe.vision';

const IMAGE_KEYS = new Set(['image', 'image_url']);

function isDataUrl(value) {
    return typeof value === 'string' && value.startsWith('data:image/');
}

function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//.test(value);
}

function toBlob(image, contentType) {
    if (typeof Blob !== 'undefined' && image instanceof Blob) return image;
    if (typeof image === 'string' || image instanceof ArrayBuffer || ArrayBuffer.isView(image)) {
        return new Blob([image], contentType ? { type: contentType } : undefined);
    }
    throw new TypeError('vision: pass a Blob/File, ArrayBuffer, typed array (Buffer), data URL or public image URL');
}

/**
 * The image part of a body. A data URL or a public URL goes as JSON; bytes go as the multipart `image` field, which
 * is what the browser forms and a service upload use. `extra` is merged into the same body.
 */
function bodyFor(image, extra = {}, { filename = 'image', contentType } = {}) {
    if (isDataUrl(image)) return { json: { image, ...extra } };
    if (isHttpUrl(image)) return { json: { image_url: image, ...extra } };
    const form = new FormData();
    for (const [k, v] of Object.entries(extra)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const x of v) form.append(k, String(x));
        else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    form.append('image', toBlob(image, contentType), filename);
    return { form };
}

function createVisionClient(client, { baseUrl, audience = DEFAULT_AUDIENCE } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createVisionClient: an openvibe-sdk core client is required');
    const call = (opts) => client.json({ service: 'vision', baseUrl, audience, ...opts });

    const one = (path, image, extra, opts) => call({ method: 'POST', path, ...bodyFor(image, extra, opts) });

    const face = {
        /** Identity-free count and boxes; no consent, no template. */
        detect: (image, opts) => one('/api/v1/faces/detect', image, {}, opts),
        /** The redacted PNG bytes and the blurred count from X-Faces-Blur. */
        async blur(image, opts) {
            const res = await client.request({ method: 'POST', path: '/api/v1/faces/blur', service: 'vision', baseUrl, audience, responseType: 'arrayBuffer', ...bodyFor(image, {}, opts) });
            return { bytes: res.data, contentType: res.headers.get('content-type'), faceCount: Number(res.headers.get('x-faces-blurred')) };
        },
        texts: () => call({ path: '/api/v1/faces/consents/text' }),
        consents: () => call({ path: '/api/v1/faces/consents' }),
        grant: (feature, body) => call({ method: 'POST', path: `/api/v1/faces/consents/${encodeURIComponent(feature)}`, json: body }),
        revoke: (feature, { channel } = {}) => call({ method: 'DELETE', path: `/api/v1/faces/consents/${encodeURIComponent(feature)}`, query: channel ? { channel } : undefined }),
        /** Enrol with your own token; the matching consent must already be active. */
        enrol: (feature, image, { channel } = {}, opts) => one(`/api/v1/faces/enrol/${encodeURIComponent(feature)}`, image, { channel }, opts),
        verify: (image, opts) => one('/api/v1/faces/verify', image, {}, opts),
        upload: (image, opts) => one('/api/v1/faces/media', image, {}, opts),
        async media(id) {
            const res = await client.request({ path: `/api/v1/faces/media/${encodeURIComponent(id)}`, service: 'vision', baseUrl, audience, responseType: 'arrayBuffer' });
            return { bytes: res.data, contentType: res.headers.get('content-type') };
        },
        find: () => call({ method: 'POST', path: '/api/v1/faces/find', json: {} }),
        tags: () => call({ path: '/api/v1/faces/cast/tags' }),
        cluster: (region) => call({ method: 'POST', path: '/api/v1/faces/library/cluster', json: { region } }),
        groups: () => call({ path: '/api/v1/faces/library/groups' }),
        correct: (action, ids) => call({ method: 'POST', path: '/api/v1/faces/library/correct', json: { action, ids } }),
        /**
         * F1 familiar faces: the camera owner's own library. A named person may stay pending_consent in a strict
         * region until Network's registry says yes (or they accept the private link); only that library is matched.
         */
        familiar: {
            list: () => call({ path: '/api/v1/faces/libraries' }),
            create: (body) => call({ method: 'POST', path: '/api/v1/faces/libraries', json: body }),
            get: (libraryId) => call({ path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}` }),
            update: (libraryId, body) => call({ method: 'PATCH', path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}`, json: body }),
            remove: (libraryId) => call({ method: 'DELETE', path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}` }),
            enroll: (libraryId, image, fields = {}, opts) => one(`/api/v1/faces/libraries/${encodeURIComponent(libraryId)}/enroll`, image, fields, opts),
            match: (libraryId, image, opts) => one(`/api/v1/faces/libraries/${encodeURIComponent(libraryId)}/match`, image, {}, opts),
            people: (libraryId) => call({ path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}/people` }),
            patchPerson: (libraryId, personId, body) => call({ method: 'PATCH', path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}/people/${encodeURIComponent(personId)}`, json: body }),
            removePerson: (libraryId, personId) => call({ method: 'DELETE', path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}/people/${encodeURIComponent(personId)}` }),
            requestConsent: (libraryId, personId) => call({ method: 'POST', path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}/people/${encodeURIComponent(personId)}/request` }),
            checkConsent: (libraryId) => call({ method: 'POST', path: `/api/v1/faces/libraries/${encodeURIComponent(libraryId)}/consent-check` }),
            acceptConsent: (token, body) => call({ method: 'POST', path: `/api/v1/faces/consent-requests/${encodeURIComponent(token)}/accept`, json: body }),
            denyConsent: (token) => call({ method: 'POST', path: `/api/v1/faces/consent-requests/${encodeURIComponent(token)}/deny` }),
        },
    };

    return {
        /** Ask or describe an image: { answer } with the engine, model, provider, route, cost and latency. */
        ask: (image, o = {}, opts) => one('/api/v1/ask', image, pick(o, ['question', 'task', 'mode', 'lang', 'model']), opts),
        describe: (image, o = {}, opts) => one('/api/v1/describe', image, pick(o, ['question', 'task', 'mode', 'lang', 'model']), opts),
        /** Read text locally first; `fallback` asks AI only when the local pass found nothing. */
        ocr: (image, o = {}, opts) => one('/api/v1/ocr', image, pick(o, ['lang', 'fallback', 'model']), opts),
        /** Local OCR against up to three AI hints. */
        compare: (image, o = {}, opts) => one('/api/v1/compare', image, pick(o, ['task', 'question', 'models', 'lang']), opts),
        /** One editable alt-text sentence about the scene; never about a person. */
        alt: (image, opts) => one('/api/v1/alt', image, {}, opts),
        /** Store one scoped CLIP embedding of your own item. */
        index: (image, itemId, { resultUrl } = {}, opts) => one('/api/v1/index', image, { item_id: itemId, result_url: resultUrl }, opts),
        /** Search only the caller's own private index, by words (`q`) or by an example image. */
        find: (query, opts) => (typeof query === 'string' && !isDataUrl(query) && !isHttpUrl(query)
            ? call({ path: '/api/v1/find', query: { q: query } })
            : one('/api/v1/find', query, {}, opts)),
        receipt: (image, o = {}, opts) => one('/api/v1/receipt', image, pick(o, ['fallback']), opts),
        product: (image, o = {}, opts) => one('/api/v1/product', image, pick(o, ['allow_rerank']), opts),
        watch: (image, classes, { previousImage, sourceRef } = {}, opts) => one('/api/v1/watch', image, { classes, previous_image: previousImage, source_ref: sourceRef }, opts),
        moments: (frames, prompts) => call({ method: 'POST', path: '/api/v1/moments', json: { frames, prompts } }),
        uiCheck: (source = {}, opts) => {
            const { image, imageUrl, ...rest } = source;
            if (image !== undefined) return one('/api/v1/ui-check', image, rest, opts);
            if (imageUrl !== undefined) return call({ method: 'POST', path: '/api/v1/ui-check', json: { ...rest, image_url: imageUrl } });
            return call({ method: 'POST', path: '/api/v1/ui-check', json: rest });
        },
        models: () => call({ path: '/api/v1/models' }),
        benchmarks: ({ task, limit } = {}) => call({ path: '/api/v1/benchmarks', query: { task, limit } }),
        answer: (id) => call({ path: `/api/v1/answers/${encodeURIComponent(id)}` }),
        uiCheckById: (id) => call({ path: `/api/v1/ui-checks/${encodeURIComponent(id)}` }),
        /** POST /mcp: a JSON-RPC 2.0 message or batch, answered as the protocol says. */
        mcp: (message, { protocolVersion = '2025-06-18' } = {}) => call({ method: 'POST', path: '/mcp', json: message, headers: { 'MCP-Protocol-Version': protocolVersion } }),
        protectedResource: () => call({ path: '/.well-known/oauth-protected-resource' }),
        face,
    };
}

function pick(o, keys) {
    const out = {};
    for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
    return out;
}

module.exports = { createVisionClient, DEFAULT_AUDIENCE };
