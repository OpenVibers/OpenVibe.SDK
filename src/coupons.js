'use strict';
/**
 * openvibe-sdk/coupons — OpenVibe.Coupons for apps (a browser extension, a shopping bot): which store a site is, its
 * active codes with their evidence, and, for the person who authorized the app, submitting a code and reporting
 * whether one worked. Routes at https://openvibe.coupons/api/v1; tokens for audience openvibe.coupons. An app acts
 * only for its on_behalf_of person.
 *
 *   const coupons = createCouponsClient(createClient({ tokenProvider }));
 *   const { merchant } = await coupons.merchants.resolve('www.example-store.com');   // public data
 *   const { coupons: codes } = await coupons.merchants.coupons(merchant.id);
 *   await coupons.report(codes[0].id, { outcome: 'failed', reason: 'expired' });     // one report a day per code
 *   await coupons.submit({ host: 'example-store.com', code: 'SAVE10', title: '10% off', evidence_url: 'https://…' });
 *
 * Capabilities (public since openvibe-contracts 0.208.0): coupons.merchant.resolve, coupons.coupon.lookup,
 * coupons.coupon.submit (sensitive: a code under the person's name; it starts as status unknown, and a status,
 * confidence or "verified" field is refused) and coupons.report.create. Submitting is never retried on its own;
 * a report is (only the person's latest one counts).
 */
const enc = encodeURIComponent;
const COUPON_ID_RE = /^cpn_[0-9A-HJKMNP-TV-Z]{26}$/;   // Coupons' own rule
const OUTCOMES = ['worked', 'failed'];
const REASONS = ['invalid', 'expired', 'min_spend_not_met', 'not_eligible', 'other'];

function createCouponsClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createCouponsClient: pass an openvibe-sdk/core client');
    const at = { service: 'coupons', baseUrl, audience: 'openvibe.coupons' };
    const call = (opts) => client.json({ ...at, ...opts });
    const coupon = (id) => {
        if (!COUPON_ID_RE.test(String(id || ''))) throw new TypeError('coupons: a coupon is a cpn_ id');
        return `/api/v1/coupons/${enc(String(id))}`;
    };
    const merchant = (id) => {
        if (!id || typeof id !== 'string') throw new TypeError("coupons: a merchant's id");
        return `/api/v1/merchants/${enc(id)}`;
    };

    return {
        merchants: {
            /** The store a hostname belongs to (subdomain rules; never a path rule). */
            resolve: (host, { signal } = {}) => {
                if (!host || typeof host !== 'string') throw new TypeError('coupons.merchants.resolve: a hostname');
                return call({ path: '/api/v1/merchants/resolve', query: { host }, signal });
            },
            get: (id, { signal } = {}) => call({ path: merchant(id), signal }),
            /** Its active codes: status, confidence, report aggregates, restrictions, expiry (or unknown), evidence. */
            coupons: (id, { signal } = {}) => call({ path: `${merchant(id)}/coupons`, signal }),
        },
        get: (id, { signal } = {}) => call({ path: coupon(id), signal }),
        /** A code for a store (by merchant_id, host or url): code and title required, evidence_url recommended. */
        submit: (fields, { signal } = {}) => {
            if (!fields || !fields.code || !fields.title) throw new TypeError('coupons.submit: code and title');
            if (!fields.merchant_id && !fields.host && !fields.url) throw new TypeError('coupons.submit: merchant_id, host or url');
            return call({ method: 'POST', path: '/api/v1/coupons/submit', json: fields, idempotencyKey: false, signal });
        },
        /** Did it work? { outcome: worked | failed, reason? } → the code's aggregates (never who reported). */
        report: (id, { outcome, reason } = {}, { signal } = {}) => {
            if (!OUTCOMES.includes(outcome)) throw new TypeError("coupons.report: outcome is 'worked' or 'failed'");
            if (reason != null && !REASONS.includes(reason)) throw new TypeError(`coupons.report: reason is one of ${REASONS.join(', ')}`);
            return call({ method: 'POST', path: `${coupon(id)}/report`, json: { outcome, reason }, idempotent: true, signal });
        },
    };
}

module.exports = { createCouponsClient };
