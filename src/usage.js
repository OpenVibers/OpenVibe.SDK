'use strict';
/**
 * openvibe-sdk/usage — platform.usage-sample@1, one metered usage reading with retry-safe attribution
 * (T1 Universal Fabric). Pure construction and validation, no I/O and no dependency at require time:
 * `openvibe-contracts` is required lazily by validateUsageSample, the way src/service re-exports its packages.
 *
 *   const { usageSample, usageKey, validateUsageSample } = require('openvibe-sdk/usage');
 *   const record = usageSample({ id, idempotency_key: usageKey('media', 'delivery', 1), service: 'media',
 *       operation: 'deliver', quantity: 1.5, unit: 'GiB' });      // at and source default
 *   validateUsageSample(record);                                    // { ok, errors }
 *
 * No money fields are invented: cost_estimate, free_allowance_used and vibes_charged ride along only when
 * the caller passes them (rating is Billing's). openvibe-sdk/govern builds its onUsage record with usageSample().
 */

/** The fields platform.usage-sample@1 requires or allows, in the schema's order; null/undefined are stripped. */
function usageSample(fields) {
    const f = fields || {};
    const record = {
        id: f.id,
        idempotency_key: f.idempotency_key,
        service: f.service,
        project: f.project,
        subject: f.subject,
        resource: f.resource,
        provider: f.provider,
        node: f.node,
        cell: f.cell,
        region: f.region,
        operation: f.operation,
        quantity: f.quantity,
        unit: f.unit,
        at: f.at == null ? new Date().toISOString() : f.at,
        cost_estimate: f.cost_estimate,
        free_allowance_used: f.free_allowance_used,
        vibes_charged: f.vibes_charged,
        route_epoch: f.route_epoch,
        trace_id: f.trace_id,
        source: f.source == null ? 'openvibe-sdk/usage' : f.source,
    };
    for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
    return record;
}

/** The stable idempotency key of a reading: the service, then each part, joined with ':'. */
function usageKey(service, ...parts) {
    if (typeof service !== 'string' || !service) throw new TypeError('usageKey: service must be a non-empty string');
    const rest = parts.filter((p) => p != null).map(String);
    return rest.length ? [service, ...rest].join(':') : service;
}

/** { ok, errors } for a record against platform.usage-sample@1. A missing openvibe-contracts is never a
 *  claim of validity: ok is false and errors stay empty (nothing was checked). */
function validateUsageSample(record) {
    let contracts = null;
    try { contracts = require('openvibe-contracts'); } catch { /* not installed: nothing to check against */ }
    if (!contracts) return { ok: false, errors: [] };
    const r = contracts.validate('platform.usage-sample@1', record);
    return { ok: Boolean(r.valid), errors: r.errors || [] };
}

module.exports = { usageSample, usageKey, validateUsageSample };
