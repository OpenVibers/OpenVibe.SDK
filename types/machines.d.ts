/** openvibe-sdk/machines: the network's machines hub (plan L34; Contracts 0.257.0). */

/** One machine as the hub shows it (network.machine@1). */
export interface Machine {
    /** Bot's device id (dev_…). */
    id: string;
    /** onboard (a robot's machine), bridge or server (a machine that runs its owner's jobs). */
    kind: 'onboard' | 'bridge' | 'server';
    /** Whether the machine is connected to Bot right now. */
    online: boolean;
    /** What the machine does for the network: the ids from the catalogue. */
    roles: string[];
    /** What it does right now: its Codes jobs, its desks, its local models, its robots. */
    running: Array<{ kind: 'codes.jobs' | 'desks' | 'models' | 'robots'; count: number; label?: string }>;
    /** The node principal on Network (nod_…), when it has one. */
    principal_id?: string;
    /** The name the owner gave it. */
    name?: string;
    /** The operating system the machine reports. */
    os?: string;
    /** When the machine was last seen. */
    last_seen_at?: string;
    /** The OpenVibe Node version the machine reports. */
    node_version?: string;
}

/** One role of the catalogue (network.machine-role@1). */
export interface MachineRole {
    id: string;
    name: string;
    /** What the role installs on the machine. */
    installs: string;
    /** What the hub shows for a machine with this role. */
    shows: string;
}

/** A one-time pairing code and the command to run on the machine (network.machine-pairing@1). */
export interface MachinePairing {
    code: string;
    expires_at: string;
    installer: string;
    pairing_id?: string;
}

export interface MachinesClientOptions {
    /** OpenVibe.Network's base URL. */
    networkUrl: string;
    /** The caller's bearer token: the person's session token, or an app's consented token. */
    token: () => string | Promise<string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export interface MachinesClient {
    /** The caller's own machines. */
    list(): Promise<{ machines: Machine[] }>;
    /** One machine; a machine that is not the caller's is a 404. */
    get(id: string): Promise<{ machine: Machine }>;
    /** The catalogue of roles: what a machine may do for the network. */
    catalogue(): Promise<{ roles: MachineRole[] }>;
    /** A one-time pairing code and the command to run on the machine. */
    pair(): Promise<{ pairing: MachinePairing }>;
    /** A new name for the machine. */
    rename(id: string, name: string): Promise<{ machine: Machine }>;
    /** The machine's roles — the whole set, not a change. */
    roles(id: string, roles: string[]): Promise<{ machine: Machine }>;
    /** The machine is no longer the caller's. */
    revoke(id: string): Promise<{ machine: Machine }>;
}

/** A refusal: the hub's own status and code (err.status, err.code). */
export declare class MachinesError extends Error {
    status: number;
    code: string;
}

export declare function createMachines(options: MachinesClientOptions): MachinesClient;
export declare const DEFAULT_TIMEOUT_MS: number;
