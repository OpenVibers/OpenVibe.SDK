'use strict';
/**
 * openvibe-sdk/service: the layer every service wrote around the shared observability and problem helpers (Node only).
 *
 *   const svc = require('openvibe-sdk/service');
 *   const ApiError = svc.createServiceError('ApiError');
 *   router.get('/api/posts/:id', svc.run(async (req) => posts.get(req.params.id), 200, { name: 'Blog API' }));
 *   router.post('/api/posts', svc.jsonBody({ limit: '512kb' }), svc.run(create, 201));
 *   app.use(svc.jsonErrors());                                   // opt-in: 404 + error mapping, mounted last
 *   const server = app.listen(port);
 *   svc.gracefulStop({ name: 'Blog', server, stop: [() => worker.stop()], close: [() => outbox.stop(), () => db.close()] });
 *
 * Readiness, metrics, /release.json and the problem body are re-exported from openvibe-shared and
 * openvibe-contracts (./shared.js), loaded on first use. docs/service.md has the adoption recipe per service family.
 */
const shared = require('./shared');
const graceful = require('./graceful');
const errors = require('./errors');

const out = { ...graceful, ...errors };
for (const name of Object.keys(shared)) Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(shared, name));

module.exports = out;
