'use strict';
/**
 * openvibe-sdk/delivery — platform.delivery-offer@1.
 * Pure construction and validation, no I/O and no dependency at require time.
 *
 *   const { deliveryOffer, validateDeliveryOffer } = require('openvibe-sdk/delivery');
 *   const offer = deliveryOffer({ id, transports, regions, edge, price_per_gb_usd, price_per_request_usd,
 *       cache_rules });
 */

/** The fields platform.delivery-offer@1 requires or allows; null/undefined are stripped. */
function deliveryOffer(fields) {
    const f = fields || {};
    const record = {
        id: f.id,
        transports: f.transports,
        regions: f.regions,
        edge: f.edge,
        node: f.node,
        price_per_gb_usd: f.price_per_gb_usd,
        price_per_request_usd: f.price_per_request_usd,
        cache_rules: f.cache_rules,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/** { ok, errors } for a record against platform.delivery-offer@1. */
function validateDeliveryOffer(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.delivery-offer@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

module.exports = { deliveryOffer, validateDeliveryOffer };
