'use strict';
/**
 * openvibe-sdk/machines — the network's machines hub (plan L34, step M2; Contracts 0.257.0).
 *
 * A person's machines are the network's: Bot stays the registry underneath, and OpenVibe.Network fronts it on
 * openvibe.network/machines for the person and for the apps the person consented to. This module is the hub's API:
 *
 *   // createMachines from the openvibe-sdk/machines entry (CommonJS or ESM)
 *   const machines = createMachines({ networkUrl: 'https://openvibe.network', token: () => sessionToken });
 *
 *   await machines.list();                       → { machines: [machine] }   the person's own machines
 *   await machines.get(id);                      → { machine }
 *   await machines.catalogue();                  → { roles: [role] }         what a machine may do
 *   await machines.pair();                       → { pairing }               a one-time code and the command
 *   await machines.rename(id, 'Studio');         → { machine }
 *   await machines.roles(id, ['codes.worker']);  → { machine }               the whole set, not a change
 *   await machines.revoke(id);                   → { machine }
 *
 * The token is the caller's own: the person's session token, or an app's token holding network.machines.read or
 * network.machines.manage with the person's consent. `token` may return the token or a promise of it.
 *
 * A refusal is an error with the hub's own status and code (`err.status`, `err.code`): 403 capability.denied when
 * the caller holds no capability, 403 capability.owner_denied when the app's consent is gone, 404 when the machine
 * is not the caller's, 422 when a role is not in the catalogue.
 *
 * The machines' own capabilities (a computer, a desk, a model on it) stay where they are: openvibe-sdk/bot's
 * machines.desk() and machines.chat() talk to Bot itself and are unchanged.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** The error a refusal carries: the hub's status and code, so a caller can tell them apart. */
class MachinesError extends Error {
    constructor(status, code, message) {
        super(message || code || `the hub answered ${status}`);
        this.name = 'MachinesError';
        this.status = status;
        this.code = code || 'machines.failed';
    }
}

/**
 * The machines client.
 *   networkUrl  OpenVibe.Network's base URL
 *   token       () => the caller's bearer token (a person session, or an app's consented token)
 *   fetch       the fetch implementation (default globalThis.fetch)
 *   timeoutMs   the deadline of one call (default 10 s)
 */
function createMachines({ networkUrl, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!networkUrl || typeof networkUrl !== 'string') throw new TypeError('createMachines: networkUrl is required');
    if (typeof token !== 'function') throw new TypeError('createMachines: token must be a function returning a bearer token');
    if (typeof fetchImpl !== 'function') throw new TypeError('createMachines: a fetch implementation is required');
    const base = String(networkUrl).replace(/\/+$/, '');

    async function call(method, path, body) {
        const bearer = await token();
        if (!bearer) throw new MachinesError(401, 'token.invalid', 'no token');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${bearer}`, accept: 'application/json',
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: controller.signal,
            });
        } catch (e) {
            clearTimeout(timer);
            const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
            throw new MachinesError(0, aborted ? 'machines.timeout' : 'machines.unreachable', aborted ? `the hub did not answer within ${timeoutMs} ms` : `the hub is not reachable: ${e.message}`);
        }
        clearTimeout(timer);
        const out = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (out && out.code) || `machines.failed`;
            throw new MachinesError(res.status, code, (out && (out.detail || out.error || out.title)) || `the hub answered ${res.status}`);
        }
        return out || {};
    }

    const enc = (id) => encodeURIComponent(String(id == null ? '' : id));

    return {
        /** The caller's machines: { machines }. */
        list: () => call('GET', '/api/v1/machines'),
        /** One machine: { machine }. A machine that is not the caller's is a 404. */
        get: (id) => call('GET', `/api/v1/machines/${enc(id)}`),
        /** The catalogue of roles: { roles } — what a machine may do for the network. */
        catalogue: () => call('GET', '/api/v1/machines/roles'),
        /** A one-time pairing code and the command to run on the machine: { pairing }. */
        pair: () => call('POST', '/api/v1/machines/pairings', {}),
        /** A new name for the machine: { machine }. */
        rename: (id, name) => call('PATCH', `/api/v1/machines/${enc(id)}`, { name: String(name == null ? '' : name) }),
        /** The machine's roles — the whole set, not a change: { machine }. */
        roles: (id, roles) => call('PUT', `/api/v1/machines/${enc(id)}/roles`, { roles: Array.isArray(roles) ? roles : [] }),
        /** The machine is no longer the caller's: { machine }. */
        revoke: (id) => call('POST', `/api/v1/machines/${enc(id)}/revoke`, {}),
    };
}

module.exports = { createMachines, MachinesError, DEFAULT_TIMEOUT_MS };
