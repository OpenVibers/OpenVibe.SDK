'use strict';
/**
 * openvibe-sdk/cam: the OpenVibe camera element, from https://openvibe.cam/embed/ov-camera.js.
 *
 *   In an app: import { defineOvCamera } from the package's cam entry.
 *   await defineOvCamera();
 *   const camera = document.querySelector('ov-camera');
 *   camera.addEventListener('ov-camera:capture', (event) => upload(event.detail.blob));
 *
 * The embed itself is OpenVibe.Cam's framework-free custom element. This loader only injects one
 * <script> per origin (the page may already include it) and resolves to the class once the browser
 * has defined it. Nothing here touches the camera: the element starts only from a click or an
 * explicit start(), and its default upload="off" means a capture never leaves the page.
 *
 *   <ov-camera facing="user" filters="none,mono,warm" timer="3" mode="photo" upload="off"></ov-camera>
 *
 * Browser-only by nature; in Node the call rejects and the module still loads (the types and the
 * pack test import it). Pass `src` to self-host the same element file.
 */
const OV_CAMERA_SRC = 'https://openvibe.cam/embed/ov-camera.js';
const CAM_KIT_SRC = 'https://openvibe.cam/embed/cam-kit.js';
const CAM_KIT_SRI = 'sha384-kD5WfySp7D3rNJliBpLgJRrl4Geks+4EcgSaCIBGX+dZdecjmUVxEjzbcUw2Spp7';

// One promise per src: a second call while the script is in flight gets the same load, never a second tag.
const pending = new Map();
let kitPending = null;

/** Load Cam's in-page recorder once. The pinned script gives the calling site a File. */
function loadCamKit() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.reject(new Error('openvibe-sdk/cam: open() needs a browser.'));
    if (window.OpenVibeCam && typeof window.OpenVibeCam.open === 'function') return Promise.resolve(window.OpenVibeCam);
    if (kitPending) return kitPending;
    kitPending = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = CAM_KIT_SRC;
        script.integrity = CAM_KIT_SRI;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.addEventListener('load', () => {
            if (window.OpenVibeCam && typeof window.OpenVibeCam.open === 'function') resolve(window.OpenVibeCam);
            else reject(new Error('openvibe-sdk/cam: Cam kit loaded without OpenVibeCam.open().'));
        });
        script.addEventListener('error', () => { script.remove(); reject(new Error('openvibe-sdk/cam: could not load the Cam kit.')); });
        (document.head || document.documentElement).appendChild(script);
    }).finally(() => { kitPending = null; });
    return kitPending;
}

/** Open Cam on this page. Resolves to a File and metadata after Use this, or null on cancel. */
function open(options = {}) { return loadCamKit().then((kit) => kit.open(options)); }

/**
 * Inject the <ov-camera> embed once and resolve to the element class.
 * @param {{ src?: string }} [options]
 * @returns {Promise<CustomElementConstructor>}
 */
function defineOvCamera(options = {}) {
    const src = String((options && options.src) || OV_CAMERA_SRC);
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('openvibe-sdk/cam: defineOvCamera() needs a browser with custom elements.'));
    }
    const defined = () => (window.customElements ? window.customElements.get('ov-camera') : undefined);
    const already = defined();
    if (already) return Promise.resolve(already);
    if (pending.has(src)) return pending.get(src);

    const load = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.ovCamera = '';
        script.addEventListener('load', () => {
            const ctor = defined();
            if (ctor) resolve(ctor);
            else reject(new Error(`openvibe-sdk/cam: ${src} loaded but did not define <ov-camera>.`));
        });
        script.addEventListener('error', () => {
            script.remove();
            reject(new Error(`openvibe-sdk/cam: could not load ${src}`));
        });
        (document.head || document.documentElement).appendChild(script);
    }).finally(() => pending.delete(src));

    pending.set(src, load);
    return load;
}

module.exports = { defineOvCamera, OV_CAMERA_SRC, CAM_KIT_SRC, CAM_KIT_SRI, loadCamKit, open };
