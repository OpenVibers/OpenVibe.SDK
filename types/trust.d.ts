export type TrustAgeBand = 'under_1h' | 'under_1d' | 'under_7d' | 'under_30d' | '30d_plus';

export interface AccountTrustSignals {
    kind: 'account';
    age_band: TrustAgeBand;
    account_age_hours: number;
    account_age_days: number;
    passkey: boolean;
    linked_accounts: number;
    active_30d: boolean;
    email_verified: boolean;
    verified: boolean;
    verified_by: Array<'passkey' | 'linked_account' | '30_days_active'>;
}

export interface GuestTrustSignals {
    kind: 'guest';
    age_band: TrustAgeBand;
    age_hours: number;
    age_days: number;
    sessions?: number;
    networks_seen: number;
    guests_from_same_networks_24h: number;
    banned?: boolean;
    restricted?: boolean;
    converted: boolean;
}

export type TrustSignals = AccountTrustSignals | GuestTrustSignals;
export declare const AGE_BANDS: readonly TrustAgeBand[];

export interface TrustClient {
    me(): Promise<TrustSignals>;
    of(subject: string): Promise<TrustSignals>;
}

export declare function createTrustClient(options: {
    networkUrl?: string;
    getToken: () => string | Promise<string>;
    fetchImpl?: (input: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}): TrustClient;
export declare function isNew(signals: TrustSignals, options: { hours: number }): boolean;
export declare function atLeast(signals: TrustSignals, band: TrustAgeBand): boolean;
