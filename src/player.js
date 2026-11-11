'use strict';
/** Browser facade for Shared's portable live player. */
function host() { return typeof window === 'undefined' ? null : window.OVOverlay || null; }
function current() { return host()?.current() || null; }
function handoff(url) { return host()?.handoffUrl(url) || url; }
function on(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (typeof window === 'undefined') return () => {};
    const receive = (event) => listener(event.detail);
    window.addEventListener('openvibe:player', receive);
    return () => window.removeEventListener('openvibe:player', receive);
}
module.exports = { current, handoff, on };
