'use strict';
/**
 * openvibe-sdk/svg — an SVG, cleaned before it is shown or saved (0.176.0; from OpenVibe.Design's server/vectors/svg.js,
 * plan R1 item 8: AI vectors). Every service that takes an SVG (Design's drawings, Media and Pics uploads, Inventory's
 * item art) cleans it the same way.
 *
 *   const { sanitize, path } = require('openvibe-sdk/svg');
 *
 * The model writes an SVG. A browser will run anything in an SVG it is given, so the answer is read here first and
 * rebuilt from scratch out of what a drawing may contain. Nothing the model wrote is trusted: the output is the
 * allowlist below and nothing else.
 *
 *   sanitize(markup) -> { ok: true, svg } | { ok: false, why }
 *
 * What may stay:
 *   - the elements below: the shapes a drawing is made of
 *   - the attributes below: how a shape looks
 *   - one viewBox, so the drawing scales
 *
 * What may not:
 *   - script, style, foreignObject, animate, set, use, image, a, and every other element
 *   - any event handler (onclick), any href, any external reference, any url() that is not a local #id
 *   - entity declarations, CDATA, doctypes, processing instructions
 *   - anything that is not well-formed markup
 */
const path = require('./path');

/** The elements a drawing may be made of, with the spelling SVG gives them. */
const ELEMENTS = new Map([
    ['svg', 'svg'],
    ['g', 'g'],
    ['path', 'path'],
    ['circle', 'circle'],
    ['ellipse', 'ellipse'],
    ['line', 'line'],
    ['polyline', 'polyline'],
    ['polygon', 'polygon'],
    ['rect', 'rect'],
    ['defs', 'defs'],
    ['clippath', 'clipPath'],
    ['mask', 'mask'],
    ['lineargradient', 'linearGradient'],
    ['radialgradient', 'radialGradient'],
    ['stop', 'stop'],
    ['title', 'title'],
    ['desc', 'desc'],
]);

/** The attributes each element may carry. */
const ATTRIBUTES = {
    svg: new Set(['viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'clip-rule', 'opacity', 'color', 'transform', 'xmlns', 'version', 'preserveAspectRatio']),
    g: new Set(['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'clip-rule', 'opacity', 'color', 'transform']),
    path: new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'clip-rule', 'opacity', 'color', 'transform']),
    circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'opacity', 'color', 'transform']),
    ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'opacity', 'color', 'transform']),
    line: new Set(['x1', 'y1', 'x2', 'y2', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'opacity', 'color', 'transform']),
    polyline: new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'opacity', 'color', 'transform']),
    polygon: new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'opacity', 'color', 'transform']),
    rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'opacity', 'color', 'transform']),
    defs: new Set([]),
    clipPath: new Set(['id', 'clipPathUnits', 'transform']),
    mask: new Set(['id', 'maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height']),
    linearGradient: new Set(['id', 'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
    radialGradient: new Set(['id', 'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
    stop: new Set(['offset', 'stop-color', 'stop-opacity']),
    title: new Set([]),
    desc: new Set([]),
};

/** The attributes that are never allowed, whatever the element. */
const NEVER = /^(?:on[a-z]+|href|xlink:href|src|srcset|formaction|action|xmlns:xlink|xml:base|base|content|ping|data|codebase|manifest|profile|usemap|class|style)$/i;

/** The style properties a style attribute may hold. */
const STYLE_PROPERTIES = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color', 'stop-color', 'stop-opacity', 'clip-rule', 'paint-order']);

/** How large an SVG may be. */
const MAX_BYTES = 200000;

const TAG = /<\s*(\/\s*)?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([a-zA-Z_:][a-zA-Z0-9:._-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fail(why) { return { ok: false, why }; }

/**
 * A colour, a number, a length: the values a shape may be drawn with.
 *
 * A value that is merely empty or odd is dropped (the drawing goes on without it). A value that reaches
 * outside the drawing, or that would run something, refuses the drawing: quietly drawing something else
 * than the model meant is worse than saying no.
 */
function safeValue(value) {
    const v = String(value).trim();
    if (!v) return { ok: false, drop: true };
    if (v.length > 300) return { ok: false, drop: true };
    // No url() except a local reference, no javascript:, no expression.
    if (/url\s*\(/i.test(v)) {
        const only = /^url\(\s*['"]?#[A-Za-z][\w:.-]*['"]?\s*\)$/i.test(v);
        if (!only) return { ok: false, why: 'the drawing reaches outside itself' };
    }
    if (/javascript:|expression\s*\(|@import|behavior\s*:|binding\s*:/i.test(v)) return { ok: false, why: 'the drawing carries something a drawing must not carry' };
    if (/[<>&]/.test(v)) return { ok: false, drop: true };
    return { ok: true, value: v };
}

/** A style attribute: only the properties above, and only safe values. */
function safeStyle(value) {
    const parts = String(value).split(';');
    const kept = [];
    for (const part of parts) {
        const idx = part.indexOf(':');
        if (idx < 0) continue;
        const prop = part.slice(0, idx).trim().toLowerCase();
        if (!STYLE_PROPERTIES.has(prop)) continue;
        const val = safeValue(part.slice(idx + 1));
        if (!val.ok) {
            if (val.why) return { ok: false, why: val.why };
            continue;
        }
        kept.push(prop + ':' + val.value);
    }
    return { ok: true, value: kept.join(';') };
}

/** The numbers of a points list: an even run of numbers, nothing else. */
function safePoints(value) {
    const raw = String(value).trim();
    if (!raw || raw.length > 4000) return null;
    const nums = raw.split(/[\s,]+/).filter(Boolean);
    if (nums.length < 4 || nums.length % 2 !== 0) return null;
    for (const n of nums) if (!/^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?$/.test(n)) return null;
    return nums.join(' ');
}

/** The path data of a path: read with the same rules the font uses, so a drawing cannot smuggle anything. */
function safePathData(value) {
    const raw = String(value).trim();
    if (!raw || raw.length > 20000) return null;
    const parsed = path.parse(raw);
    if (!parsed.ok) return null;
    return path.toData(parsed.segments);
}

/** The attributes of one element, read into a plain object, with the ones that are not allowed refused. */
function readAttrs(name, restRaw) {
    const attrs = {};
    for (const a of restRaw.matchAll(ATTR)) {
        const key = a[1].toLowerCase();
        const value = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : a[5]);
        if (key === 'style') {
            const style = safeStyle(value);
            if (!style.ok) return style;
            if (style.value) attrs.style = style.value;
            continue;
        }
        if (NEVER.test(key)) return { ok: false, why: 'the drawing carries a ' + key + ' attribute' };
        if (!ATTRIBUTES[name].has(key)) continue;     // an attribute nobody needs is simply dropped
        if (key === 'd') {
            const d = safePathData(value);
            if (d === null) return { ok: false, why: 'the drawing has a path it cannot read' };
            attrs.d = d;
            continue;
        }
        if (key === 'points') {
            const pts = safePoints(value);
            if (pts === null) return { ok: false, why: 'the drawing has points it cannot read' };
            attrs.points = pts;
            continue;
        }
        const val = safeValue(value);
        if (!val.ok) {
            if (val.why) return { ok: false, why: val.why };
            continue;
        }
        attrs[key] = val.value;
    }
    return { ok: true, attrs };
}

/**
 * Read one SVG. The markup is walked tag by tag; only the elements and attributes on the list are kept, and
 * everything is written back out from scratch, so nothing the model wrote survives unless it was allowed.
 */
function sanitize(markup) {
    const raw = String(markup == null ? '' : markup).trim();
    if (!raw) return fail('the drawing is empty');
    if (raw.length > MAX_BYTES) return fail('the drawing is too large');

    // The things that are never in a drawing, refused before anything is read.
    if (/<!\[CDATA\[|<!ENTITY|<!DOCTYPE|<\?/i.test(raw)) return fail('the drawing carries markup a drawing must not carry');
    if (/javascript:|vbscript:|data:text\/html|<script|<foreignObject|<iframe|<embed|<object|<use\b|<image\b|<animate|<set\b|<audio|<video|<handler/i.test(raw))
        return fail('the drawing carries something a drawing must not carry');

    const out = [];
    const stack = [];
    let rootAttrs = null;
    let viewBox = null;

    for (const m of raw.matchAll(TAG)) {
        const [full, closing, nameRaw, restRaw] = m;
        const lower = nameRaw.toLowerCase();
        const name = ELEMENTS.get(lower);
        if (!name) return fail('a drawing is made of shapes, and this is not one');

        if (closing) {
            // The root's own close is not written out: the root tag is written once, at the end.
            if (name === 'svg' && !stack.length) {
                if (!rootAttrs) return fail('there is no drawing here');
                continue;
            }
            if (!stack.length || stack[stack.length - 1] !== name) return fail('the drawing is not drawn properly');
            stack.pop();
            out.push('</' + name + '>');
            continue;
        }

        const read = readAttrs(name, restRaw);
        if (!read.ok) return read;
        const selfClosing = /\/\s*$/.test(restRaw);
        const parts = Object.keys(read.attrs).map((k) => ' ' + k + '="' + esc(read.attrs[k]) + '"');

        if (name === 'svg') {
            // The root is the one drawing; a second one inside it is not allowed.
            if (rootAttrs) return fail('there is more than one drawing here');
            rootAttrs = parts;
            for (const a of restRaw.matchAll(ATTR)) {
                if (a[1].toLowerCase() !== 'viewbox') continue;
                const box = safeValue(a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : a[5]));
                if (!box.ok) return fail(box.why || 'the drawing has no size');
                viewBox = box.value;
            }
            // The root's own tag is written once, at the end, with its viewBox.
            continue;
        }

        if (selfClosing) out.push('<' + name + parts.join('') + '/>');
        else {
            out.push('<' + name + parts.join('') + '>');
            stack.push(name);
        }
    }

    if (!rootAttrs) return fail('there is no drawing here');
    if (stack.length) return fail('the drawing is not closed');
    if (!viewBox) return fail('the drawing has no size');

    // The root's attributes are read again, on their own, so the viewBox can be required.
    const root = /<\s*svg\b([^>]*)>/i.exec(raw);
    const keep = [];
    for (const a of root[1].matchAll(ATTR)) {
        const key = a[1].toLowerCase();
        const value = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : a[5]);
        if (key === 'viewbox') continue;
        if (key === 'style') {
            const style = safeStyle(value);
            if (!style.ok) return fail(style.why);
            if (style.value) keep.push('style="' + esc(style.value) + '"');
            continue;
        }
        if (NEVER.test(key)) return fail('the drawing carries a ' + key + ' attribute');
        if (!ATTRIBUTES.svg.has(key)) continue;
        const val = safeValue(value);
        if (!val.ok) {
            if (val.why) return fail(val.why);
            continue;
        }
        keep.push(key + '="' + esc(val.value) + '"');
    }

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + esc(viewBox) + '"' + (keep.length ? ' ' + keep.join(' ') : '') + '>' + out.join('') + '</svg>';
    return { ok: true, svg };
}

module.exports = { sanitize, ELEMENTS, ATTRIBUTES, NEVER, MAX_BYTES, safeValue, safeStyle, safePoints, safePathData, path };
