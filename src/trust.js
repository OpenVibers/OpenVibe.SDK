'use strict';

const AGE_BANDS = Object.freeze(['under_1h', 'under_1d', 'under_7d', 'under_30d', '30d_plus']);
const BAND_INDEX = new Map(AGE_BANDS.map((band, index) => [band, index]));

/** Create a direct OpenVibe.Network trust API client. `.of()` requires identity.trust.read. */
function createTrustClient({ networkUrl = 'https://openvibe.network', getToken, fetchImpl = globalThis.fetch } = {}) {
    if (typeof getToken !== 'function') throw new TypeError('createTrustClient: getToken must be a function');
    if (typeof fetchImpl !== 'function') throw new TypeError('createTrustClient: fetch is not available');
    const base = String(networkUrl || '').replace(/\/+$/, '');
    if (!base) throw new TypeError('createTrustClient: networkUrl is required');

    async function read(path) {
        const token = await getToken();
        if (!token) throw new TypeError('createTrustClient: getToken returned no token');
        const response = await fetchImpl(`${base}${path}`, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            const error = new Error(body && (body.detail || body.error) || `Network trust request failed (${response.status})`);
            error.status = response.status;
            error.code = body && (body.code || body.error);
            throw error;
        }
        return body;
    }

    return {
        me() { return read('/api/v1/me/trust'); },
        of(subject) {
            if (typeof subject !== 'string' || !/^(?:usr|gst)_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) {
                throw new TypeError('of: subject must be a usr_… or gst_… id');
            }
            return read(`/api/v1/trust/${encodeURIComponent(subject)}`);
        },
    };
}

/** True when the known whole-hour age is below the supplied threshold. */
function isNew(signals, { hours } = {}) {
    const limit = Number(hours);
    if (!Number.isFinite(limit) || limit < 0) throw new TypeError('isNew: hours must be a non-negative number');
    const age = signals && (signals.kind === 'guest' ? signals.age_hours : signals.account_age_hours);
    return Number.isFinite(Number(age)) && Number(age) < limit;
}

/** Compare an age band against the documented youngest-to-oldest order. */
function atLeast(signals, band) {
    const target = BAND_INDEX.get(band);
    const actual = BAND_INDEX.get(signals && signals.age_band);
    return target !== undefined && actual !== undefined && actual >= target;
}

module.exports = { createTrustClient, isNew, atLeast, AGE_BANDS };
