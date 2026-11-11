'use strict';
/**
 * openvibe-sdk (browser entry): core plus the browser-safe families. No server-only code: no
 * service-token client, no JWT verification, no events publishing, no identity lookups.
 */
const core = require('./src/core');

module.exports = {
    createWalletClient: require('./src/wallet').createWalletClient,
    ...core,
    auth: require('./src/auth/browser'),
    locker: require('./src/locker'),
    registry: require('./src/registry'),
    trust: require('./src/trust'),
    levels: require('./src/levels'),
    modules: require('./src/modules'),
    realtime: require('./src/realtime'),
    media: require('./src/media'),
    composer: require('./src/composer'),
    cam: require('./src/cam'),
    mediaUpload: require('./src/media-upload'),
    ui: require('./src/ui'),
    uiLayout: require('./src/ui-layout'),
    community: require('./src/community'),
    homeFeed: require('./src/home-feed'),
    feed: require('./src/feed'),
    bot: require('./src/bot'),
    search: require('./src/search'),
    bench: require('./src/bench'),
    meme: require('./src/meme'),
    vision: require('./src/vision'),
    themes: require('./src/themes'),
    design: require('./src/design'),
    redact: require('./src/redact'),
    chat: require('./src/chat'),
    ai: require('./src/ai'),
    credentials: require('./src/credentials'),
    jobs: require('./src/jobs'),
    agents: require('./src/agents'),
    tools: require('./src/tools'),
    projects: require('./src/projects'),
    geo: require('./src/geo'),
    history: require('./src/history'),
    userCard: require('./src/user-card'),
    player: require('./src/player'),
    agentSheet: require('./src/agent-sheet'),
};
