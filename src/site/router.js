'use strict';
/**
 * An Express router whose handlers may be async: a rejected promise goes to next(err) (the app's error handler, which
 * logs without request bodies) instead of becoming an unhandled rejection. Error handlers (four arguments) are left as
 * they are.
 *
 * This was server/http/router.js in 27 sites, the same code apart from which methods each one wrapped; every method is
 * wrapped here, which only ever turns an unhandled rejection into a handled one.
 *
 *   const r = asyncRouter(express.Router());                 // or asyncRouter({ express })
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

function wrapHandler(h) {
    if (typeof h !== 'function' || h.length === 4) return h;
    return function asyncHandler(req, res, next) {
        try {
            const out = h(req, res, next);
            if (out && typeof out.catch === 'function') out.catch(next);
        } catch (err) { next(err); }
    };
}

/** routerOrOptions: an Express Router, or { express } to make one. { methods } narrows which methods are wrapped. */
function asyncRouter(routerOrOptions, { methods = METHODS } = {}) {
    let r = routerOrOptions;
    if (!r || typeof r.get !== 'function') {
        const express = r && r.express;
        if (!express || typeof express.Router !== 'function') throw new TypeError('asyncRouter: pass an express.Router() or { express }');
        r = express.Router();
    }
    for (const method of methods) {
        if (typeof r[method] !== 'function') continue;
        const orig = r[method].bind(r);
        r[method] = (path, ...handlers) => orig(path, ...handlers.map(wrapHandler));
    }
    return r;
}

module.exports = { asyncRouter, wrapHandler, ASYNC_METHODS: METHODS };
