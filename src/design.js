'use strict';

/**
 * OpenVibe.Design: the public component registry (design.component@1; no token) and the glyph API (icons; suggest,
 * get, search and export are public, a draft needs a token). Browser-safe.
 */
const DEFAULT_DESIGN_URL = 'https://openvibe.design';
const STYLES = new Set(['thin', 'light', 'regular', 'bold', 'solid', 'duotone']);
// The shape a ground may take, and the corner a square may have (plan AB.29): the same four names Design draws them
// with, so a caller never has to know which service a file came from.
const GROUNDS = new Set(['none', 'circle', 'square', 'squircle']);
const ROUNDINGS = new Set(['none', 'soft', 'round', 'squircle']);
const COMPONENT = /^[a-z][a-z0-9-]{0,63}$/;

function createDesignClient({ accessToken = null, baseUrl = DEFAULT_DESIGN_URL, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (accessToken != null && (typeof accessToken !== 'string' || !accessToken)) throw new TypeError('createDesignClient: accessToken must be a non-empty string');
    if (typeof fetchImpl !== 'function') throw new TypeError('createDesignClient: fetch is unavailable');
    const base = String(baseUrl).replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+$/i.test(base)) throw new TypeError('createDesignClient: baseUrl must be an origin');
    /** A file rather than JSON: the glyph's own SVG (or PNG) with the maker's choices. Public. */
    async function requestFile(path, { accept = 'text/plain', signal } = {}) {
        const response = await fetchImpl(`${base}${path}`, {
            headers: { accept, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
            signal: signal || AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const err = new Error(String(text).trim() || `Design API returned ${response.status}`);
            err.status = response.status;
            throw err;
        }
        return response;
    }
    async function request(path, { method = 'GET', body, signal, open = false } = {}) {
        if (!open && !accessToken) throw new TypeError('createDesignClient: the icon API needs accessToken');
        const response = await fetchImpl(`${base}${path}`, {
            method,
            headers: { accept: 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: signal || AbortSignal.timeout(timeoutMs),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const err = new Error(data.detail || data.message || `Design API returned ${response.status}`);
            err.status = response.status;
            err.code = data.code || null;
            throw err;
        }
        return data;
    }
    const icons = Object.freeze({
        async draft({ name, sentence = '', styles = [...STYLES], sourceSvg = undefined }, { signal } = {}) {
            if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(name || ''))) throw new TypeError('icons.draft: name must be 2–32 lowercase letters, digits or dashes');
            if (!Array.isArray(styles) || !styles.length || styles.some((s) => !STYLES.has(s))) throw new TypeError('icons.draft: styles must be thin, light, regular, bold, solid or duotone');
            return request('/api/v1/glyphs/draft', { method: 'POST', body: { name, sentence, styles, ...(sourceSvg ? { sourceSvg } : {}) }, signal });
        },
        async get(name, { style = 'regular', signal } = {}) {
            if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(name || ''))) throw new TypeError('icons.get: name must be lowercase letters, digits or dashes');
            if (!STYLES.has(style)) throw new TypeError('icons.get: unsupported style');
            return request(`/api/v1/glyphs/${encodeURIComponent(name)}?style=${encodeURIComponent(style)}`, { signal, open: true });
        },
        async search(q, { limit = 24, signal } = {}) {
            const query = String(q || '').trim();
            if (!query) throw new TypeError('icons.search: q is required');
            return request(`/api/v1/glyphs/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(Math.min(Math.max(Number(limit) || 24, 1), 60))}`, { signal, open: true });
        },
        /**
         * The glyph as a file, with the PNG maker's choices: the SVG text, or the PNG bytes.
         *   await design.icons.export({ glyph: 'heart', ground: 'square', rounding: 'round' });
         *   await design.icons.export({ glyph: 'heart', ground: 'square', rounding: 'squircle', format: 'png' });
         * ground picks the shape (none, circle, square, squircle); rounding picks the corner of that square (none,
         * soft, round, squircle). A circle has no corner and ignores it. Public: no token needed.
         */
        async export(input, o = {}) {
            const opts = typeof input === 'string' ? { glyph: input, ...o } : { ...(input || {}) };
            const name = String(opts.glyph || opts.name || '');
            if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new TypeError('icons.export: glyph must be lowercase letters, digits or dashes');
            if (opts.ground != null && !GROUNDS.has(String(opts.ground))) throw new TypeError('icons.export: ground must be none, circle, square or squircle');
            if (opts.rounding != null && !ROUNDINGS.has(String(opts.rounding))) throw new TypeError('icons.export: rounding must be none, soft, round or squircle');
            const format = String(opts.format || 'svg');
            if (format !== 'svg' && format !== 'png') throw new TypeError('icons.export: format must be svg or png');
            const q = new URLSearchParams();
            for (const key of ['ground', 'rounding', 'size', 'scale', 'color', 'stroke', 'pad', 'bg', 'fx', 'style']) {
                const value = opts[key];
                if (value == null || value === '') continue;
                q.set(key, String(value));
            }
            const query = q.toString();
            const response = await requestFile(`/icons/${encodeURIComponent(name)}.${format}${query ? `?${query}` : ''}`, { accept: format === 'png' ? 'image/png' : 'image/svg+xml' });
            if (format === 'png') {
                const bytes = await response.arrayBuffer();
                const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : null;
                return { bytes, contentType: header || 'image/png' };
            }
            return response.text();
        },
        /** The best glyphs for a button's words by meaning; rank asks a small model when the words are new. Public. */
        async suggest(label, { context = '', limit = 8, rank = false, signal } = {}) {
            const words = String(label || '').trim();
            if (!words) throw new TypeError('icons.suggest: label is required');
            const n = Math.min(Math.max(Number(limit) || 8, 1), 24);
            const query = `label=${encodeURIComponent(words)}&limit=${encodeURIComponent(n)}${context ? `&context=${encodeURIComponent(String(context).trim().slice(0, 160))}` : ''}${rank ? '&rank=1' : ''}`;
            return request(`/api/v1/glyphs/suggest?${query}`, { signal, open: true });
        },
    });
    return Object.freeze({
        icons,
        /** The registry: → { schema: 'design.component@1', components: [definition], kitComponents: [...] }. No token. */
        components({ signal } = {}) { return request('/api/v1/components', { signal, open: true }); },
        /** One definition: → { schema, component, examples }, or null when no component has this name. No token. */
        async component(name, { signal } = {}) {
            if (!COMPONENT.test(String(name || ''))) throw new TypeError('component: pass a registry name (lowercase letters, digits and hyphens)');
            try { return await request(`/api/v1/components/${encodeURIComponent(name)}`, { signal, open: true }); }
            catch (error) { if (error && error.status === 404) return null; throw error; }
        },
    });
}

module.exports = { createDesignClient, DEFAULT_DESIGN_URL, GROUNDS, ROUNDINGS };
