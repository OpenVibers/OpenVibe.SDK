'use strict';
/**
 * The observability and problem helpers every service already calls, re-exported and never copied:
 *
 *   createReadiness, skip, safeReason                                    openvibe-shared/ready
 *   createRegistry, instrument, metricsHandler, isLoopbackDirect, releaseInfo   openvibe-shared/metrics
 *   createRelease                                                        openvibe-shared/release
 *   problem, sendProblem                                                 openvibe-contracts (http)
 *
 * The SDK depends on neither package (a service has both), so each name is a getter that requires its package on
 * first use, from the service's own node_modules: the same module instance the service's other code gets. Without
 * the package the getter throws an Error that names it.
 */

const SOURCES = {
    'openvibe-shared/ready': { pkg: 'openvibe-shared', names: ['createReadiness', 'skip', 'safeReason'] },
    'openvibe-shared/metrics': { pkg: 'openvibe-shared', names: ['createRegistry', 'instrument', 'metricsHandler', 'isLoopbackDirect', 'releaseInfo'] },
    'openvibe-shared/release': { pkg: 'openvibe-shared', names: ['createRelease'] },
    'openvibe-contracts': { pkg: 'openvibe-contracts', names: ['problem', 'sendProblem'], pick: (m) => m.http },
};

const loaded = new Map();

function load(spec, name) {
    if (loaded.has(spec)) return loaded.get(spec);
    const { pkg, pick } = SOURCES[spec];
    let mod;
    try {
        mod = require(spec);
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`'${spec}'`)) {
            const e = new Error(`openvibe-sdk/service: ${name} comes from ${spec}; install \`${pkg}\` in the service (the SDK does not depend on it)`);
            e.code = 'sdk.missing_dependency';
            e.package = pkg;
            throw e;
        }
        throw err;
    }
    const out = pick ? pick(mod) : mod;
    loaded.set(spec, out);
    return out;
}

const lazy = {};
for (const [spec, { names }] of Object.entries(SOURCES)) {
    for (const name of names) {
        Object.defineProperty(lazy, name, { enumerable: true, configurable: false, get: () => load(spec, name)[name] });
    }
}

module.exports = lazy;
