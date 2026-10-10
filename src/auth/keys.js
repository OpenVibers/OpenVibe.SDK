'use strict';
/**
 * Server only. The keys a service verifies OpenVibe.Network tokens with, as one object every verifier reads.
 *
 *   const keys = createNetworkKeys({ network: config.networkInternalUrl, publicKey: config.networkPublicKey, log });
 *   keys.start();                                    // at boot (never at module load); keys.stop() at shutdown
 *   await verifyUserToken(token, { ...keys.verifyOptions, issuer, audience });
 *   await verifyServiceToken(token, { ...keys.verifyOptions, issuer, audience, contracts });
 *   keys.loaded()                                    // the readiness check: a token can be verified
 *
 * Two sources:
 *   - a pinned key (`publicKey`: a PEM or a KeyObject, e.g. OV_NETWORK_PUBLIC_KEY): that one key, never fetched;
 *   - otherwise Network's JWKS (`jwksUrl`, or `<network>/api/.well-known/jwks`) through the process-wide JWKS client
 *     (./jwks.js, shared with every verifier that names the same URL): the last good keys through a Network outage,
 *     backoff on failures, and a token naming an unknown kid refetches at once (a rotation), throttled.
 *
 * start() fetches at once and retries every `retryMs` until the first load succeeds (Network may still be booting:
 * the client's own backoff would wait minutes), then refreshes every `refreshMs`. Every timer is unref'd.
 *
 * keysFor(kid) answers [{ kid, key }] for a token type a service checks itself (OpenVibe.Events' realtime tickets):
 * the key the kid names after a rotation refetch, else every loaded key; [] when none has loaded. It never throws.
 *
 * Every service had its own copy of this (a key store with a retry timer and a 6 h refresh, one PEM, no kid): this
 * is the one that stays.
 */
const crypto = require('node:crypto');
const { jwksClient } = require('./jwks');

const RETRY_MS = 30 * 1000;
const REFRESH_MS = 15 * 60 * 1000;

function createNetworkKeys({ network = null, jwksUrl = null, publicKey = null, fetch: fetchImpl, log = null, retryMs = RETRY_MS, refreshMs = REFRESH_MS } = {}) {
    const pinned = publicKey ? (typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey) : null;
    const url = pinned ? null : (jwksUrl || (network ? `${String(network).replace(/\/+$/, '')}/api/.well-known/jwks` : null));
    if (!pinned && !url) throw new TypeError('createNetworkKeys: pass `network` (Network\'s base URL), `jwksUrl` or a pinned `publicKey`');
    const client = url ? jwksClient(url, { ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(log ? { log } : {}) }) : null;
    let retryTimer = null;
    let started = false;

    const loaded = () => Boolean(pinned) || client.status().ready;

    /** One fetch now: the keys, or null when it failed (the client logs the first failure and the recovery). */
    async function refresh() {
        if (!client) return [{ kid: null, key: pinned }];
        try { return await client.refresh(); } catch { return null; }
    }

    /** Start fetching (idempotent). Resolves after the first attempt, loaded or not; retries go on in the background. */
    async function start() {
        if (!client || started) return loaded();
        started = true;
        client.start({ intervalMs: refreshMs });
        const attempt = async () => {
            retryTimer = null;
            await refresh();
            if (started && !loaded()) {
                retryTimer = setTimeout(() => { attempt().catch(() => { /* refresh never throws */ }); }, retryMs);
                if (retryTimer.unref) retryTimer.unref();
            }
        };
        await attempt();
        return loaded();
    }

    function stop() {
        started = false;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        if (client) client.stop();
    }

    async function keysFor(kid) {
        if (pinned) return [{ kid: null, key: pinned }];
        try { return await client.keysForKid(kid || null); } catch { return []; }
    }

    function status() {
        if (pinned) return { source: 'pinned', url: null, ready: true, keys: 1 };
        return { source: 'jwks', ...client.status() };
    }

    // Spread into verifyUserToken / verifyAppToken / verifyServiceToken: the pinned key, or this client.
    const verifyOptions = pinned ? { publicKey: pinned } : { jwks: client };
    return { url, pinned: Boolean(pinned), verifyOptions, loaded, status, start, stop, refresh, keysFor };
}

module.exports = { createNetworkKeys };
