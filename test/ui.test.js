'use strict';
const assert = require('node:assert/strict');
const sdk = require('../index');

assert.throws(() => sdk.ui.progress({}), /load \/shared\/ov-upload\.js first/);
const expected = { update() {}, destroy() {} };
globalThis.OVUpload = { progress: (el, options) => { assert.equal(el.id, 'p'); assert.equal(typeof options.onRetry, 'function'); return expected; } };
try { assert.equal(sdk.ui.progress({ id: 'p' }, { onRetry() {} }), expected); }
finally { delete globalThis.OVUpload; }
