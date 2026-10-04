'use strict';
/**
 * openvibe-sdk/runtime — platform.runtime-offer@1 and platform.runtime-class@1.
 * Pure construction and validation, no I/O and no dependency at require time.
 *
 *   const { runtimeOffer, runtimeClass, validateRuntimeOffer, validateRuntimeClass } = require('openvibe-sdk/runtime');
 *   const offer = runtimeOffer({ id, kind, region, node, limits, price, availability, constraints });
 *   runtimeClass('function');   // 'function' — a known class
 */

/** The fields platform.runtime-offer@1 requires or allows; null/undefined are stripped. */
function runtimeOffer(fields) {
    const f = fields || {};
    const record = {
        id: f.id,
        kind: f.kind,
        region: f.region,
        node: f.node,
        limits: f.limits,
        price: f.price,
        availability: f.availability,
        constraints: f.constraints,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/** A runtime class is one of the known strings (function, code, browser, linux, desktop, gpu). */
const RUNTIME_CLASSES = ['function', 'code', 'browser', 'linux', 'desktop', 'gpu'];

/** Returns the class when it is a known runtime class, or throws. */
function runtimeClass(value) {
    if (RUNTIME_CLASSES.includes(value)) return value;
    throw new Error(`runtimeClass: unknown class ${JSON.stringify(value)} (expected one of ${RUNTIME_CLASSES.join(', ')})`);
}

/** { ok, errors } for a record against platform.runtime-offer@1. */
function validateRuntimeOffer(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.runtime-offer@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

/** { ok, errors } for a value against platform.runtime-class@1. */
function validateRuntimeClass(value) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.runtime-class@1', value);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

module.exports = { runtimeOffer, runtimeClass, RUNTIME_CLASSES, validateRuntimeOffer, validateRuntimeClass };
