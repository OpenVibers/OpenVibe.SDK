import type { OpenVibeClient } from './core';

export interface WalletBalance { label: string; amount: string; currency: 'USD' | 'opencoins' | 'vibes-bits'; scale: 0 | 9; purpose: string; action: string; held?: string; }
export interface Wallet {
    subject: { type: 'user'; id: string }; currency: 'USD'; money_writes_frozen: boolean; used_ai_this_month: boolean;
    balances: { coins: WalletBalance; vibes: WalletBalance; balance: WalletBalance }; bits_per_usd: number;
    recent_activity: Array<{ id: string; at: string; kind: 'coins' | 'vibes' | 'balance'; amount: string; label: string; detail: string; site: string }>;
    checkout: { providers: string[]; vibes: { minimum: number; maximum: number; price_tiers: Array<{ min: number; usd_per_bit: number }> }; topup: { enabled: boolean; amounts_cents: number[]; fee_bps: number | null } };
}
export interface StoreItem { id: string; name: string; description: string; issuer: string; prices: { coins?: number; vibes?: number }; preview: { emoji?: string; token?: string; media_id?: string }; kind: string; slots: string[]; surfaces: Array<{ surface: string; renderer?: string }>; owned: boolean; available: boolean; }
export interface Purchase { id: string; subject: string; item_id: string; name: string; issuer: string; currency: 'coins' | 'vibes'; amount: number; status: 'pending' | 'fulfilled'; instance_id: string | null; payment_id: string | null; }
export interface Checkout { intent: Record<string, unknown>; checkout_url: string | null; }
type Options = { signal?: AbortSignal };
export function createWalletClient(client: OpenVibeClient, options?: { billingUrl?: string; inventoryUrl?: string }): {
    wallet: { get(options?: Options): Promise<Wallet>; topUp(input: { provider: string; amount_cents: number; idempotency_key: string }, options?: Options): Promise<Checkout> };
    vibes: { buy(input: { provider: string; vibes: number; idempotency_key: string }, options?: Options): Promise<Checkout> };
    store: { list(options?: Options): Promise<{ items: StoreItem[] }>; buy(id: string, input: { currency: 'coins' | 'vibes'; idempotency_key: string }, options?: Options): Promise<Purchase>; submit(id: string, prices: { coins?: number; vibes?: number }, options?: Options): Promise<{ definition_id: string; issuer: string; prices: { coins?: number; vibes?: number }; status: 'in_review' }> };
    items: { list(options?: Options & { cursor?: string; limit?: number; kind?: string }): Promise<{ subject: string; instances: import('./inventory').Instance[]; definitions: Record<string, import('./inventory').Definition>; next_cursor: string | null }>; equip(input: { kind: string; slot: string; instance_id: string | null }, options?: Options): Promise<import('./inventory').EquippedSet> };
};
