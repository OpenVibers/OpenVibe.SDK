'use strict';
/**
 * openvibe-sdk/cam: the export resolves by name (CJS and ESM), the loader injects the embed once in a fake DOM
 * and resolves to the element class, Node gets a rejection instead of a document crash, and the type file names
 * the runtime exports and the whole element surface.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const cam = require('../src/cam');
const pkg = require('../package.json');

run([
    ['camera settings use the person token and return saved choices', async () => {
        const original = global.fetch;
        const calls = [];
        global.fetch = async (url, options) => {
            calls.push({ url, options });
            return { ok: true, json: async () => ({ facing: 'user', lens: 'main', mic: 'default', resolution: '720', mirror: true, updated_at: null }) };
        };
        try {
            await cam.settings.get({ token: 'person-token' });
            await cam.settings.put({ token: 'person-token', values: { mirror: false } });
            assert.equal(calls[0].url, 'https://openvibe.cam/api/v1/me/camera-settings');
            assert.equal(calls[0].options.method, 'GET');
            assert.equal(calls[1].options.method, 'PUT');
            assert.equal(JSON.parse(calls[1].options.body).mirror, false);
            assert.equal(calls[1].options.headers.Authorization, 'Bearer person-token');
        } finally { global.fetch = original; }
    }],
    ['the entry resolves by name and names the loader and the default script', async () => {
        assert.deepEqual(Object.keys(cam).sort(), ['CAM_KIT_SRC', 'CAM_KIT_SRI', 'OV_CAMERA_SRC', 'defineOvCamera', 'loadCamKit', 'open', 'settings']);
        assert.equal(cam.OV_CAMERA_SRC, 'https://openvibe.cam/embed/ov-camera.js');
        assert.equal(cam.CAM_KIT_SRC, 'https://openvibe.cam/embed/cam-kit.js?v=yqqjh1FiP7a4');
        assert.match(cam.CAM_KIT_SRI, /^sha384-/);
        assert.equal(require('openvibe-sdk/cam'), cam);
        assert.deepEqual(pkg.exports['./cam'], {
            types: './types/cam.d.ts',
            import: './esm/cam.mjs',
            default: './src/cam/index.js',
        });
        const esm = await import('openvibe-sdk/cam');
        assert.equal(esm.default, cam);
        assert.equal(esm.OV_CAMERA_SRC, cam.OV_CAMERA_SRC);
        assert.equal(typeof esm.defineOvCamera, 'function');
        assert.equal(typeof esm.open, 'function');
    }],

    ['in Node it rejects instead of touching a document', async () => {
        assert.equal(typeof global.window, 'undefined');
        await assert.rejects(cam.defineOvCamera(), /needs a browser/);
        await assert.rejects(cam.defineOvCamera({ src: 'https://example.test/ov-camera.js' }), /needs a browser/);
        await assert.rejects(cam.open({ mode: 'video' }), /needs a browser/);
    }],

    ['the recorder loader pins one script and forwards the result', async () => {
        const oldWindow = global.window;
        const oldDocument = global.document;
        const tags = [];
        let kit = null;
        global.window = {};
        global.document = { createElement: () => {
            const listeners = {};
            return { addEventListener: (name, fn) => { listeners[name] = fn; }, remove() {}, listeners };
        }, head: { appendChild: (tag) => {
            tags.push(tag);
            kit = { open: async (options) => ({ mode: options.mode, file: { name: 'clip.webm' } }) };
            global.window.OpenVibeCam = kit;
            queueMicrotask(() => tag.listeners.load());
        } } };
        try {
            const [a, b] = await Promise.all([cam.open({ mode: 'video' }), cam.open({ mode: 'photo' })]);
            assert.equal(tags.length, 1);
            assert.equal(tags[0].src, cam.CAM_KIT_SRC);
            assert.equal(tags[0].integrity, cam.CAM_KIT_SRI);
            assert.equal(tags[0].crossOrigin, 'anonymous');
            assert.equal(a.mode, 'video');
            assert.equal(b.mode, 'photo');
            assert.equal(await cam.loadCamKit(), kit);
        } finally { if (oldWindow === undefined) delete global.window; else global.window = oldWindow; if (oldDocument === undefined) delete global.document; else global.document = oldDocument; }
    }],

    ['a browser gets one <script> per load and the class; a defined element resolves without another', async () => {
        const appended = [];
        const listeners = {};
        let ctor = null;
        const script = {
            dataset: {},
            addEventListener(type, fn) { listeners[type] = fn; },
            remove() { this.removed = true; },
        };
        const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
        const hadDocument = Object.prototype.hasOwnProperty.call(global, 'document');
        const oldWindow = global.window;
        const oldDocument = global.document;
        global.window = { customElements: { get: (name) => (name === 'ov-camera' ? ctor : undefined) } };
        global.document = {
            createElement: () => script,
            head: {
                appendChild: (s) => {
                    appended.push(s.src);
                    ctor = function OvCamera() {};
                    queueMicrotask(() => listeners.load());
                },
            },
            documentElement: { appendChild: () => { throw new Error('head exists; documentElement must not be used'); } },
        };
        try {
            const [a, b] = await Promise.all([cam.defineOvCamera(), cam.defineOvCamera()]);
            assert.equal(appended.length, 1, 'two concurrent calls share one script');
            assert.equal(a, ctor);
            assert.equal(b, ctor);
            assert.equal(script.dataset.ovCamera, '', 'the tag is marked as ours');
            assert.equal(script.async, true);

            const again = await cam.defineOvCamera();
            assert.equal(again, ctor);
            assert.equal(appended.length, 1, 'a defined element needs no second script');

            // A custom src is honoured when the page has not defined the element yet.
            ctor = null;
            const custom = await cam.defineOvCamera({ src: 'https://cdn.example/ov-camera.js' });
            assert.equal(typeof custom, 'function');
            assert.deepEqual(appended, ['https://openvibe.cam/embed/ov-camera.js', 'https://cdn.example/ov-camera.js']);
        } finally {
            if (hadWindow) global.window = oldWindow; else delete global.window;
            if (hadDocument) global.document = oldDocument; else delete global.document;
        }
    }],

    ['the types file names the runtime exports and the element surface', async () => {
        const dts = fs.readFileSync(path.join(ROOT, 'types/cam.d.ts'), 'utf8');
        for (const name of [
            'OV_CAMERA_SRC', 'defineOvCamera', 'DefineOvCameraOptions', 'CAM_KIT_SRC', 'CAM_KIT_SRI', 'CamKitResult', 'CamKitOptions', 'loadCamKit', 'open(options?',
            'OvCameraAttributes', 'OvCameraFacing', 'OvCameraFilter', 'OvCameraTimer', 'OvCameraMode', 'OvCameraUpload',
            'OvCameraElement', 'OvCameraCaptureDetail', 'OvCameraErrorCode', 'OvCameraErrorDetail',
            'OvCameraCaptureEvent', 'OvCameraErrorEvent', 'OvCameraEventMap', 'HTMLElementTagNameMap',
            'start(): Promise<void>', 'stop(): void', 'capture(): Promise<', 'flip(): Promise<OvCameraFacing>',
        ]) assert.ok(dts.includes(name), name);
    }],
]);
