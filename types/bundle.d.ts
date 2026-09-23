/** browser/openvibe-sdk.mjs: one self-contained ES module with the browser-safe subpaths (same shape as the package's browser entry). */
import * as auth from './auth-browser';
import * as registry from './registry';
import * as modules from './modules';
import * as realtime from './realtime';
import * as media from './media';
import * as community from './community';
import * as jobs from './jobs';
import * as tools from './tools';
import * as projects from './projects';
import * as core from './core';

export * from './core';
export * as auth from './auth-browser';
export * as registry from './registry';
export * as modules from './modules';
export * as realtime from './realtime';
export * as media from './media';
export * as community from './community';
export * as jobs from './jobs';
export * as tools from './tools';
export * as projects from './projects';

declare const sdk: typeof core & {
    auth: typeof auth; registry: typeof registry; modules: typeof modules; realtime: typeof realtime;
    media: typeof media; community: typeof community; jobs: typeof jobs; tools: typeof tools; projects: typeof projects;
};
export default sdk;
