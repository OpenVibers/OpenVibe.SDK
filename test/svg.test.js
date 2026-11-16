'use strict';
// openvibe-sdk/svg (0.176.0): what an SVG may keep, what it may not, and the path reader under it. The cases are
// OpenVibe.Design's (test/typefaces.test.js), where the module came from, plus the shapes its item art and uploads use.
const assert = require('node:assert/strict');
const { sanitize, path, MAX_BYTES } = require('../src/svg');

// A drawing comes back rebuilt: shapes, fills and a viewBox kept.
const good = sanitize('<svg viewBox="0 0 24 24"><g fill="#333"><path d="M4 4 L20 4 L20 20 L4 20 Z"/></g><circle cx="12" cy="12" r="3" fill="#fff"/></svg>');
assert.equal(good.ok, true, good.why);
assert.match(good.svg, /^<svg[^>]*viewBox="0 0 24 24"/);
assert.match(good.svg, /<path d="M4 4L20 4L20 20L4 20Z"\/>|<path d="M4 4 ?L20 4 ?L20 20 ?L4 20 ?Z"\/>/);
assert.match(good.svg, /<circle[^>]*r="3"/);
// Gradients that point at a local id stay (item art uses them).
const grad = sanitize('<svg viewBox="0 0 64 64"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/></svg>');
assert.equal(grad.ok, true, grad.why);
assert.match(grad.svg, /fill="url\(#g\)"/);

// Hostile drawings are refused, never half-kept.
for (const hostile of [
    '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 24 24"><path d="M0 0 L1 1" onclick="alert(1)"/></svg>',
    '<svg viewBox="0 0 24 24"><a href="javascript:alert(1)"><path d="M0 0 L1 1"/></a></svg>',
    '<svg viewBox="0 0 24 24"><image href="https://evil.example/x.png"/></svg>',
    '<svg viewBox="0 0 24 24"><foreignObject><div>x</div></foreignObject></svg>',
    '<svg viewBox="0 0 24 24"><rect width="1" height="1" fill="url(https://evil.example/#x)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 24 24"></svg>',
    '<svg viewBox="0 0 24 24"><style>*{background:url(https://evil.example)}</style></svg>',
    '<svg viewBox="0 0 24 24"><use href="#a"/></svg>',
]) {
    const r = sanitize(hostile);
    assert.equal(r.ok, false, `refused: ${hostile}`);
    assert.equal(typeof r.why, 'string');
}
assert.equal(sanitize('not an svg').ok, false);
assert.equal(sanitize('<svg viewBox="0 0 24 24">' + '<path d="M0 0 L1 1"/>'.repeat(Math.ceil(MAX_BYTES / 20))).ok, false, 'too big');

// The path reader: relative commands and arcs come back absolute, measured.
const p = path.parse('m2 2 l10 0 a5 5 0 0 1 0 10 z');
assert.equal(p.ok, true, p.why);
assert.ok(p.segments.every((s) => ['M', 'L', 'C', 'Q', 'Z'].includes(s.type)), 'absolute M L C Q Z only');
assert.equal(path.closed(p.segments), true);
const box = path.bbox(p.segments);
assert.ok(box.x2 >= 16.9 && box.x2 <= 17.1, `the arc's extent is measured (${box.x2})`);
assert.match(path.toData(p.segments), /^M2 2/);
for (const bad of ['', 'M0 0 L', 'hello']) assert.equal(path.parse(bad).ok, false, `refused: ${JSON.stringify(bad)}`);
console.log('svg: drawings rebuilt from the allowlist, hostile ones refused, path data read absolute');
