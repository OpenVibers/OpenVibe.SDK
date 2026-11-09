'use strict';

/** Mount the shared OpenVibe progress UI after loading /shared/ov-upload.js and .css. */
function progress(el, options) {
    const upload = globalThis.OVUpload;
    if (!upload || typeof upload.progress !== 'function') throw new Error('ov.ui.progress: load /shared/ov-upload.js first');
    return upload.progress(el, options);
}

module.exports = { progress };
