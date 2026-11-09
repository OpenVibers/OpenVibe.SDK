'use strict';
/** Public OpenVibe.Design component registry (design.component@1). Browser-safe. */
const NAME = /^[a-z][a-z0-9-]{0,63}$/;

function createDesignClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createDesignClient: pass an openvibe-sdk/core client');
    const call = (path, { signal } = {}) => client.json({ service: 'design', baseUrl, path, signal });
    return {
        /** → { schema: 'design.component@1', components: [definition], kitComponents: [...] } */
        components: (options = {}) => call('/api/v1/components', options),
        /** → { schema, component, examples }; null when no component has this name. */
        component: async (name, options = {}) => {
            if (!NAME.test(String(name || ''))) throw new TypeError('component: pass a registry name (lowercase letters, digits and hyphens)');
            try { return await call(`/api/v1/components/${encodeURIComponent(name)}`, options); }
            catch (error) { if (error && error.status === 404) return null; throw error; }
        },
    };
}

module.exports = { createDesignClient };
