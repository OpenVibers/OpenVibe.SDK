/** OpenVibe.Exchange: the buyer side (chat, models, offers, presets, usage, receipts) and the seller side. */
export declare class ExchangeError extends Error {
    constructor(message: string, init?: { status?: number | null; code?: string | null; body?: unknown; retryAfter?: number | null });
    status: number | null;
    code: string | null;
    body: unknown;
    retryAfter: number | null;
    /** No status, 5xx, 429 or 401. */
    readonly retryable: boolean;
}

/** Where each call goes; a deployment may point another one at these paths. */
export type ExchangePaths = {
    chat?: string;
    models?: string;
    receipts?: string;
    presets?: string;
    catalog?: string;
    catalogModels?: string;
    usage?: string;
    platformUsage?: string;
    sell?: string;
    sellerOffers?: string;
    offerReport?: string;
    offerList?: string;
};

export type ExchangeOptions = {
    /** The Network developer key (Bearer) the buyer side speaks with. */
    developerKey?: string;
    /** The key used on the Network's origin when the seller side reports an offer; defaults to the developer key. */
    networkKey?: string;
    /** The Exchange's origin; default https://api.openvibe.exchange. */
    baseUrl?: string;
    /** The Network's origin, where the user-owned AI offers live; default https://api.openvibe.network. */
    networkUrl?: string;
    fetchImpl?: typeof fetch;
    /** Per request, default 60000. */
    timeoutMs?: number;
    /** How many times a 429 or a 5xx is retried, default 3. */
    maxRetries?: number;
    /** The first backoff before the jitter, in ms; default 250. */
    retryBaseMs?: number;
    /** The seller subject (usr_...), used by the seller side when a call names no other owner. */
    owner?: string;
    paths?: ExchangePaths;
    /** The User-Agent the calls carry. */
    agent?: string;
};

export type ExchangeChatRequest = {
    model: string;
    messages: { role: string; content: string | unknown[] | null; [field: string]: unknown }[];
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    temperature?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    tools?: unknown[];
    tool_choice?: unknown;
    [field: string]: unknown;
};

export type ExchangeUsage = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
};

export type ExchangeChatCompletion = {
    id: string;
    object: 'chat.completion' | string;
    created: number;
    model: string;
    choices: { index: number; message: { role: string; content: string | null; tool_calls?: unknown[] }; finish_reason: string | null }[];
    usage: ExchangeUsage;
    system_fingerprint?: string | null;
    x_openvibe?: { run_id: string; provider?: string; fallback_used?: boolean; cost_usd?: number; synthetic?: boolean };
};

export type ExchangeChatChunk = {
    id: string;
    object: 'chat.completion.chunk' | string;
    created: number;
    model: string;
    choices: { index: number; delta: { role?: string; content?: string | null; tool_calls?: unknown[] }; finish_reason: string | null }[];
    usage?: ExchangeUsage;
    x_openvibe?: { run_id: string; provider?: string; fallback_used?: boolean; cost_usd?: number; synthetic?: boolean };
};

export type ExchangeModel = { id: string; object: 'model' | string; created?: number; owned_by?: string; [field: string]: unknown };

export type ExchangeModelList = { object: 'list'; data: ExchangeModel[] };

export type ExchangeOffer = {
    provider: string;
    provider_name?: string;
    model: string;
    id?: string | null;
    trust: 'community' | 'first-party' | string;
    access?: string;
    free?: boolean;
    price?: { in: number; out: number; cached?: number; per: string; currency: string } | null;
    speed?: { p50_ms: number | null; p95_ms: number | null };
    uptime?: number | null;
    requests_7d?: number;
    requests_today?: number;
    data_policy?: { trains: boolean | null; retention_days: number | null; region: string | null } | null;
    updated_at?: string | null;
    [field: string]: unknown;
};

export type ExchangeModelDoc = {
    slug: string;
    canonical: string;
    name: string;
    family?: string;
    type?: string;
    context?: number | null;
    max_output?: number | null;
    capabilities?: { tools: boolean; json: boolean; vision: boolean; stream: boolean };
    modalities?: string[];
    community?: boolean;
    priced?: boolean;
    offers: ExchangeOffer[];
    [field: string]: unknown;
};

export type ExchangeCatalog = {
    generated_at: string;
    window_days: number;
    count: number;
    families?: { name: string; models: number; offers: number }[];
    models: ExchangeModelDoc[];
};

export type ExchangePresetPolicy = {
    objective?: 'cheapest' | 'fastest' | 'balanced' | 'private';
    floor?: 'fast' | 'balanced' | 'strong' | 'frontier';
    ceiling?: number;
    max_price?: number;
    quantization?: string[];
    region?: string[];
    data_policy?: 'private' | 'anonymized' | 'community';
    community?: boolean;
    adult?: boolean;
    [field: string]: unknown;
};

export type ExchangePreset = {
    name: string;
    description?: string | null;
    policy: ExchangePresetPolicy;
    builtin?: boolean;
    [field: string]: unknown;
};

export type ExchangeUsageAggregate = {
    generated_at: string;
    days: number;
    from: string;
    to: string;
    today: { requests: number; tokens_in: number; tokens_out: number; cost_usd: number };
    totals: { requests: number; tokens_in: number; tokens_out: number; cost_usd: number };
    by_day: { day: string; requests: number; tokens_in: number; tokens_out: number; cost_usd: number }[];
    by_model: { provider: string; model: string | null; requests: number; tokens_in: number; tokens_out: number; cost_usd: number }[];
    by_product: { product: string; requests: number; tokens_in: number; tokens_out: number; cost_usd: number; models?: unknown[] }[];
    [field: string]: unknown;
};

export type ExchangeReceipt = {
    id: string;
    run_id?: string;
    offer?: { provider: string; model: string | null; deployment?: string | null; access?: string; provider_access?: string | null; local?: boolean; community?: 'machine' | 'endpoint' | null };
    price?: { in: number | null; out: number | null; cached?: number | null; source?: string | null };
    tokens?: { tokens_in: number; tokens_out: number; tokens_cached?: number; tokens_cache_write?: number; tokens_reasoning?: number };
    latency_ms?: number | null;
    why?: string[];
    fallbacks?: { offer: string; provider?: string | null; model?: string | null; why?: string | null; status?: string; reason?: string | null }[];
    paid_by?: { paid_by: string; detail?: string | null; fee_rate?: number | null };
    privacy?: { label: string; [field: string]: unknown } | string;
    preset?: string | null;
    created_at?: string;
    [field: string]: unknown;
};

/** The offer document the Network's user-owned AI offers registry validates. */
export type ExchangeOfferDocument = {
    offer_id: string;
    machine_id: string;
    owner: string;
    models: string[];
    hours: { start: string; end: string; tz: string };
    concurrency: number;
    price: { in_per_million: number; out_per_million: number };
    audience: 'everyone' | 'followers' | 'group';
    group?: string;
    ready: boolean;
    health: { status: 'up' | 'degraded' | 'down'; checked_at: string };
};

export type ExchangeOfferInput = {
    /** The model served; models may name several. */
    model?: string;
    models?: string[];
    /** Credits per million tokens: a number for both sides, or {in_per_million, out_per_million}. */
    price: number | { in_per_million?: number; out_per_million?: number; in?: number; out?: number };
    /** The local window the offer is open: {start, end, tz}; start == end is all day. */
    hours: { start: string; end: string; tz?: string };
    /** How many answers may run at once, 1 to 8. */
    concurrency: number;
    /** The OpenAI-compatible server that serves the model. */
    endpoint?: string;
    /** The key the endpoint needs, when it needs one. */
    endpointKey?: string;
    /** The machine the offer belongs to (dev_...). */
    machineId: string;
    /** The owner (usr_...); defaults to the client's owner. */
    owner?: string;
    audience?: 'everyone' | 'followers' | 'group';
    /** The group id, required for the group audience. */
    group?: string;
    ready?: boolean;
    health?: { status: 'up' | 'degraded' | 'down'; checked_at?: string };
    /** The reporter name; the registry keeps one set of offers per source. */
    source?: string;
    /** Whether the endpoint is asked for its model list first; default true. */
    probe?: boolean;
};

export type ExchangeOfferResult = {
    offer: ExchangeOfferDocument;
    report: { source: string; offers: number; marked_down: number; generated_at?: string };
    endpoint: { url: string; models: string[] | null } | null;
};

/** A standalone OpenAI-compatible server registered on the Exchange's public seller API. The key names the owner. */
export type ExchangeEndpointOfferInput = {
    /** The https base URL, e.g. https://my-server.example/v1; /chat/completions is appended. */
    endpoint: string;
    /** The model served; models may name several. */
    model?: string;
    models?: string[];
    /** Credits per million tokens: a number for both sides, or {in_per_million, out_per_million}; 0 volunteers. */
    price: number | { in_per_million: number; out_per_million: number };
    /** The local window the offer is open: {start, end, tz}; start == end is all day. */
    hours: { start: string; end: string; tz?: string };
    /** How many answers may run at once, 1 to 8. */
    concurrency: number;
    audience?: 'everyone' | 'followers' | 'group';
    /** The group id, required for the group audience. */
    group?: string;
    /** A label for the seller's own dashboard. */
    name?: string;
    /** The key the endpoint needs for the probe, when it needs one. AI sends no key. */
    endpointKey?: string;
    /** Whether the endpoint is asked for its model list first; default true. */
    probe?: boolean;
};

export type ExchangeEndpointOffer = {
    id: string;
    offer_id: string;
    name: string | null;
    base_url: string;
    models: string[];
    hours: { start: string; end: string; tz: string };
    concurrency: number;
    price: { in_per_million: number; out_per_million: number };
    audience: 'everyone' | 'followers' | 'group';
    group: string | null;
    created_at?: string;
    updated_at?: string;
    verification?: ExchangeSellerVerification | null;
    reputation?: number;
    free_only?: boolean;
    verified?: boolean;
};

export type ExchangeEndpointOfferResult = {
    offer: ExchangeEndpointOffer;
    endpoint: { url: string; models: string[] | null };
};

export type ExchangeSellerVerification = {
    status: 'new' | 'verified' | 'failed' | 'paused' | string;
    canary_passes: number;
    canary_failures: number;
    spot_runs: number;
    spot_failures: number;
    failure_rate?: number;
    last_canary_at?: string | null;
    last_spot_at?: string | null;
    first_verified_at?: string | null;
    failure_reason?: string | null;
};

export type ExchangeSellerOffer = {
    offer_id: string;
    machine_id: string;
    models: string[];
    hours?: { start: string; end: string; tz: string } | null;
    concurrency?: number | null;
    price?: { in_per_million: number; out_per_million: number };
    audience?: string | null;
    group?: string | null;
    health?: string | null;
    open_now?: boolean | null;
    ready: boolean;
    verification: ExchangeSellerVerification | null;
    verified: boolean;
    reputation: number;
    free_only: boolean;
    uptime_pct?: number | null;
    tokens_per_s?: number | null;
};

export type ExchangeEarnings = {
    owner: string;
    generated_at: string;
    offers: ExchangeSellerOffer[];
    totals: {
        requests: number;
        tokens_in: number;
        tokens_out: number;
        pending_credits_micro: number;
        spendable_credits_micro: number;
        self_served_requests: number;
    };
    kudos?: number;
    note?: string;
    [field: string]: unknown;
};

export type ExchangeClient = {
    /** One chat completion; stream: true answers an async iterable of chunks. */
    chat(body: ExchangeChatRequest, opts?: { signal?: AbortSignal }): Promise<ExchangeChatCompletion | AsyncIterable<ExchangeChatChunk>>;
    /** The models the Exchange can serve. */
    models(opts?: { signal?: AbortSignal }): Promise<ExchangeModelList>;
    /** The offers that serve one model. */
    offers(model: string, opts?: { signal?: AbortSignal }): Promise<ExchangeOffer[]>;
    /** The whole public catalog. */
    catalog(opts?: { signal?: AbortSignal }): Promise<ExchangeCatalog>;
    presets: {
        list(opts?: { signal?: AbortSignal }): Promise<ExchangePreset[]>;
        create(input: { name: string; policy: ExchangePresetPolicy }, opts?: { signal?: AbortSignal }): Promise<ExchangePreset>;
        /** The platform has no PATCH: a preset is stored under its name, so a second POST replaces it. */
        update(name: string, input: { policy: ExchangePresetPolicy }, opts?: { signal?: AbortSignal }): Promise<ExchangePreset>;
        remove(name: string, opts?: { signal?: AbortSignal }): Promise<unknown>;
    };
    /** The public aggregate, or the platform's own usage for a requester. */
    usage(query?: { days?: number; from?: string; to?: string; requester?: string }, opts?: { signal?: AbortSignal }): Promise<ExchangeUsageAggregate | { usage: unknown }>;
    /** The receipt of one answered request. */
    receipt(id: string, opts?: { signal?: AbortSignal }): Promise<ExchangeReceipt>;
    seller: {
        /** Register a Link machine's offer in the Network's user-owned AI offers, or an endpoint with the Exchange. */
        offer(input: ExchangeOfferInput, opts?: { signal?: AbortSignal }): Promise<ExchangeOfferResult>;
        offer(input: ExchangeEndpointOfferInput, opts?: { signal?: AbortSignal }): Promise<ExchangeEndpointOfferResult>;
        /** The caller's own endpoint offers, with their verification. */
        endpointOffers(opts?: { signal?: AbortSignal }): Promise<{ owner: string; offers: ExchangeEndpointOffer[] }>;
        /** Remove one of the caller's endpoint offers. */
        removeEndpointOffer(id: string, opts?: { signal?: AbortSignal }): Promise<{ id: string; removed: boolean }>;
        /** The model list at an OpenAI-compatible endpoint. */
        probe(input: { endpoint: string; key?: string | null }, opts?: { signal?: AbortSignal }): Promise<{ models: string[] }>;
        /** The seller dashboard: the tokens served, the credits earned, the uptime and the verification. */
        earnings(opts?: { owner?: string } & { signal?: AbortSignal }): Promise<ExchangeEarnings>;
        /** The verification, the reputation and the uptime of every offer. */
        verification(opts?: { owner?: string } & { signal?: AbortSignal }): Promise<{ owner: string | null; generated_at: string | null; offers: ExchangeSellerOffer[] }>;
        /** The offers the Network holds, whole. */
        offers(opts?: { owner?: string; source?: string } & { signal?: AbortSignal }): Promise<{ offers: ExchangeOfferDocument[]; count?: number; generated_at?: string }>;
    };
    webhooks: {
        /** Constant-time check of the RAW body against X-OpenVibe-Signature-V2 (or a legacy sha256= header). */
        verify(rawBody: string | Uint8Array | ArrayBufferView, signatureHeader: string, secret: string, opts?: { toleranceSec?: number; now?: number }): boolean;
    };
    baseUrl(): string;
    networkUrl(): string;
};

export declare function createExchangeClient(options?: ExchangeOptions): ExchangeClient;
/** The same check as exchange.webhooks.verify, for a receiver that only verifies webhooks. */
export declare function verifyWebhook(rawBody: string | Uint8Array | ArrayBufferView, signatureHeader: string, secret: string, opts?: { toleranceSec?: number; now?: number }): boolean;
export declare const SIGNATURE_TOLERANCE_SEC: number;
export declare const EXCHANGE_BASE_URL: string;
export declare const NETWORK_BASE_URL: string;
export declare const DEFAULT_PATHS: Required<ExchangePaths>;
export declare const RETRY_STATUS: ReadonlySet<number>;
