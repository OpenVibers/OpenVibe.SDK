/** browser/openvibe-sdk.mjs: one self-contained ES module with the browser-safe subpaths (same shape as the package's browser entry). */
import * as auth from './auth-browser';
import * as registry from './registry';
import * as modules from './modules';
import * as realtime from './realtime';
import * as media from './media';
import * as community from './community';
import * as bot from './bot';
import * as search from './search';
import * as bench from './bench';
import * as meme from './meme';
import * as vision from './vision';
import * as themes from './themes';
import * as redact from './redact';
import * as chat from './chat';
import * as ai from './ai';
import * as jobs from './jobs';
import * as tools from './tools';
import * as projects from './projects';
import * as geo from './geo';
import * as core from './core';

export * from './core';
export * as auth from './auth-browser';
export * as registry from './registry';
export * as modules from './modules';
export * as realtime from './realtime';
export * as media from './media';
export * as community from './community';
export * as bot from './bot';
export * as search from './search';
export * as bench from './bench';
export * as meme from './meme';
export * as vision from './vision';
export * as themes from './themes';
export * as redact from './redact';
export * as chat from './chat';
export * as ai from './ai';
export * as jobs from './jobs';
export * as tools from './tools';
export * as projects from './projects';
export * as geo from './geo';

declare const sdk: typeof core & {
    auth: typeof auth; registry: typeof registry; modules: typeof modules; realtime: typeof realtime;
    media: typeof media; community: typeof community; bot: typeof bot; search: typeof search; bench: typeof bench; meme: typeof meme; vision: typeof vision; themes: typeof themes; redact: typeof redact; chat: typeof chat; ai: typeof ai; jobs: typeof jobs; tools: typeof tools; projects: typeof projects; geo: typeof geo;
};
export default sdk;
