'use strict';

/**
 * OpenVibe.Design: the public component registry (design.component@1; no token) and the glyph API (icons; a token).
 * Browser-safe.
 */
const DEFAULT_DESIGN_URL = 'https://openvibe.design';
const STYLES = new Set(['thin', 'light', 'regular', 'bold', 'solid', 'duotone']);
const COMPONENT = /^[a-z][a-z0-9-]{0,63}$/;

function createDesignClient({ accessToken = null, baseUrl = DEFAULT_DESIGN_URL, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (accessToken != null && (typeof accessToken !== 'string' || !accessToken)) throw new TypeError('createDesignClient: accessToken must be a non-empty string');
    if (typeof fetchImpl !== 'function') throw new TypeError('createDesignClient: fetch is unavailable');
    const base = String(baseUrl).replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+$/i.test(base)) throw new TypeError('createDesignClient: baseUrl must be an origin');
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
            return request(`/api/v1/glyphs/${encodeURIComponent(name)}?style=${encodeURIComponent(style)}`, { signal });
        },
        async search(q, { limit = 24, signal } = {}) {
            const query = String(q || '').trim();
            if (!query) throw new TypeError('icons.search: q is required');
            return request(`/api/v1/glyphs/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(Math.min(Math.max(Number(limit) || 24, 1), 60))}`, { signal });
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

module.exports = { createDesignClient, DEFAULT_DESIGN_URL };
