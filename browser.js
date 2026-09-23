'use strict';
/**
 * openvibe-sdk (browser entry): core plus the browser-safe families. No server-only code: no
 * service-token client, no JWT verification, no events publishing, no identity lookups.
 */
const core = require('./src/core');

module.exports = {
    ...core,
    auth: require('./src/auth/browser'),
    registry: require('./src/registry'),
    modules: require('./src/modules'),
    realtime: require('./src/realtime'),
    media: require('./src/media'),
    community: require('./src/community'),
    jobs: require('./src/jobs'),
    tools: require('./src/tools'),
    projects: require('./src/projects'),
};
