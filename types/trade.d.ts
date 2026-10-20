/** openvibe-sdk/trade: OpenVibe.Trade — instruments, observations, filings and sources, and the person's watchlists and alerts. */
type Opts = { signal?: AbortSignal };
type TradeJson = Record<string, any>;
export type AlertKind = 'threshold' | 'filing_type' | 'new_document';
export interface AlertRule {
    symbol: string; kind: AlertKind; metric?: string; operator?: 'above' | 'below'; threshold?: string | number; unit?: string;
    currency?: string | null; form_types?: string[] | string;
}
export interface TradeClient {
    instruments: {
        resolve(q: string, opts?: Opts & { kind?: string }): Promise<TradeJson>;
        list(opts?: Opts & { limit?: number; offset?: number }): Promise<TradeJson>;
        get(symbol: string, opts?: Opts): Promise<TradeJson>;
        observations(symbol: string, opts?: Opts & { metric?: string; before?: string; limit?: number }): Promise<TradeJson>;
        documents(symbol: string, opts?: Opts & { limit?: number; offset?: number }): Promise<TradeJson>;
    };
    sources(opts?: Opts): Promise<TradeJson>;
    watchlists: {
        list(opts?: Opts): Promise<TradeJson>;
        get(id: string, opts?: Opts): Promise<TradeJson>;
        create(req: { name: string }, opts?: Opts): Promise<TradeJson>;
        rename(id: string, name: string, opts?: Opts): Promise<TradeJson>;
        add(id: string, symbol: string, opts?: Opts): Promise<TradeJson>;
        removeItem(id: string, symbol: string, opts?: Opts): Promise<TradeJson>;
        remove(id: string, opts?: Opts): Promise<TradeJson>;
    };
    alerts: {
        list(opts?: Opts): Promise<TradeJson>;
        deliveries(opts?: Opts & { limit?: number }): Promise<TradeJson>;
        create(rule: AlertRule, opts?: Opts): Promise<TradeJson>;
        remove(id: string, opts?: Opts): Promise<TradeJson>;
    };
}
export function createTradeClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): TradeClient;
