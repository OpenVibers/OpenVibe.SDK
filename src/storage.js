'use strict';
/**
 * openvibe-sdk/storage — platform.storage-offer@1.
 * Pure construction and validation, no I/O and no dependency at require time.
 *
 *   const { storageOffer, validateStorageOffer } = require('openvibe-sdk/storage');
 *   const offer = storageOffer({ id, class, capacity_gb, price_per_gb_month_usd, price_per_operation_usd,
 *       region, node, durability, lifecycle_rules });
 */

/** The fields platform.storage-offer@1 requires or allows; null/undefined are stripped. */
function storageOffer(fields) {
    const f = fields || {};
    const record = {
        id: f.id,
        class: f.class,
        capacity_gb: f.capacity_gb,
        price_per_gb_month_usd: f.price_per_gb_month_usd,
        price_per_operation_usd: f.price_per_operation_usd,
        region: f.region,
        node: f.node,
        durability: f.durability,
        lifecycle_rules: f.lifecycle_rules,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/** { ok, errors } for a record against platform.storage-offer@1. */
function validateStorageOffer(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.storage-offer@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

module.exports = { storageOffer, validateStorageOffer };
