'use strict';
/**
 * openvibe-sdk (Node entry). Everything from ./core at the top level, and each capability family
 * as a namespace. Browser bundles resolve ./browser.js instead (no server-only modules).
 * Prefer the subpaths (openvibe-sdk/media, …) so a bundle only carries what it uses.
 */
const core = require('./src/core');

module.exports = {
    ...core,
    auth: require('./src/auth'),
    registry: require('./src/registry'),
    identity: require('./src/identity'),
    modules: require('./src/modules'),
    events: require('./src/events'),
    realtime: require('./src/realtime'),
    media: require('./src/media'),
    community: require('./src/community'),
    jobs: require('./src/jobs'),
    tools: require('./src/tools'),
    projects: require('./src/projects'),
};
