'use strict';
/**
 * openvibe-sdk/site: what every OpenVibe site's server was made of, copied from site to site until the consolidation
 * review of 2026-11-16 found the same files in up to 31 repositories. One implementation here; a site passes its own
 * name, patterns and packages (Node only).
 *
 *   const site = require('openvibe-sdk/site');
 *   const keys = site.createKeyStore({ config, name: 'OpenVibe.Blog' });         // the Network's signing key
 *   const api = site.asyncRouter(express.Router());                               // async handlers → next(err)
 *   app.use(site.linkHeader());                                                    // Link: twin + llms.txt
 *   app.get('/openapi.json', site.openapiRoute(app, { title, version, baseUrl, docs, files }));
 *   app.use(site.isoJsonTimes);                                                    // times leave with their zone
 *   site.createTwins({ express, agentLayer, paths }).mountTwins(app, { router, descriptor, baseUrl });
 *
 * docs/site.md has the adoption recipe: replacing a site's own copy with these.
 */
const keys = require('./keys');
const router = require('./router');
const linkHeader = require('./link-header');
const openapi = require('./openapi');
const isoTimes = require('./iso-times');
const twins = require('./twins');

module.exports = { ...keys, ...router, ...linkHeader, ...openapi, ...isoTimes, ...twins };
