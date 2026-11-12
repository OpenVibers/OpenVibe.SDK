// openvibe-sdk/frame — the OpenVibe network's the OpenVibe Frame (the shared navbar, footer, "shipped" views and theme loader) for any app.

export interface FrameLink { label: string; href: string; icon?: string; active?: boolean }
export interface FrameMenuItem { label: string; href?: string; icon?: string; onClick?: () => void; danger?: boolean; external?: boolean }
export interface FrameFooterConfig {
    links?: Array<{ heading: string; items: Array<{ name: string; url: string }> }>;
    variant?: 'full' | 'compact';
    /** This app's update log; default: https://openvibe.network/updates?site=<host>. */
    updates?: string;
    mount?: string;
    [key: string]: unknown;
}
export interface FrameOptions {
    /** Your app's id (brand and analytics). */
    service?: string;
    brand?: { name?: string; sub?: string; tld?: string; icon?: string; variant?: string };
    links?: FrameLink[];
    menu?: { before?: FrameMenuItem[]; after?: FrameMenuItem[] };
    /** Same-origin endpoint answering { user } for your server session. */
    sessionUrl?: string;
    /** Sign-in URL; {url} = full return URL, {path} = its local path. */
    loginUrl?: string;
    /** Sign-out URL, so your server session ends too; {url} / {path} as for loginUrl. */
    logoutUrl?: string;
    silentLogin?: string;
    /** Footer options, or false for no footer. */
    footer?: FrameFooterConfig | false;
    /** false: no "shipped X ago" line in the footer. */
    shipped?: boolean;
    /** false: do not load the shared theme loader. */
    theme?: boolean;
    /** Where the Frame is served (default https://openvibe.network). */
    base?: string;
    /** Extra navbar options passed through to OpenVibeNavbar.init. */
    navbar?: Record<string, unknown>;
    document?: unknown;
    window?: unknown;
}
export interface FrameConfig { navbar: Record<string, unknown>; footer: Record<string, unknown> | null }
export interface FrameUrls { theme: string; navbar: string; footer: string; shipped: string }

/** One person the network may name: only when their presence setting lets others see them online. */
export interface FrameOnlinePerson { name: string; username: string; avatar: string | null; site: string | null }
/** A count that opens what it counts, or a site's own strip item (a number or a fixed line). */
export interface FrameOnlineItem { label: string; icon: string; link: string; value?: number; line?: string }
/** GET <base>/api/frame/online — who was on the network in the last thirty minutes. A guest is a number only. */
export interface FrameOnline {
    updated: string | null;
    members: number | null;
    guests: number | null;
    total: number | null;
    people: FrameOnlinePerson[];
    more: number;
    live: { channels: number; watching: number; first: Array<{ name: string; url: string }> } | null;
    counts: Array<{ id?: string; label: string; value: number; icon: string; url: string }>;
    items: FrameOnlineItem[];
    sites: number | null;
    views_7d: number | null;
}

export const DEFAULT_BASE: string;
export function scriptUrls(opts?: { base?: string }): FrameUrls;
export function frameConfig(opts?: FrameOptions): FrameConfig;
export function frameTags(opts?: FrameOptions): { head: string; bodyStart: string; bodyEnd: string; config: FrameConfig; urls: FrameUrls };
export function mountFrame(opts?: FrameOptions): Promise<{ navbar: unknown | null; footer: unknown | null }>;
/** The footer strip's read; `site` (the calling site's Frame id) brings that site's own items. */
export function online(opts?: { base?: string; site?: string; signal?: AbortSignal; fetch?: typeof fetch }): Promise<FrameOnline>;

// ── the Frame's data client (composer-post-ask-do.md, R1) ────────────────────────────────────────────────────────
import type { AgentEvent, AgentRun } from './agents';

export interface FrameModelPrice { in: number | null; out: number | null; unit: 'USD per 1M tokens' }
export interface FrameChoiceRow {
    model: string;
    source: 'openvibe' | 'keys' | 'machines' | 'plans';
    machine?: string;
    name: string;
    maker: string | null;
    price: FrameModelPrice | null;
    free: boolean;
    speed?: number;
    score?: number;
    url?: string;
    /** true only for an 18+ model the person opted into; those are absent otherwise. */
    adult?: boolean;
}
export interface FrameChoicesGroup { id: 'openvibe' | 'keys' | 'machines' | 'plans'; title: string; rows: FrameChoiceRow[]; note?: string }
export interface FrameChoice { model: string; source: 'openvibe' | 'keys' | 'machines'; machine?: string }
export interface FrameChoices {
    task: 'chat' | 'agent' | 'code' | 'image' | 'research';
    recommended: FrameChoice;
    choice: FrameChoice;
    adult: boolean;
    groups: FrameChoicesGroup[];
}
/** GET /api/frame/query — Search's fabric answer, unchanged (search.fabric-result@1). */
export interface FrameQueryResult { results: Array<Record<string, unknown>>; groups: Record<string, number>; citations: Array<Record<string, unknown>>; route: Record<string, unknown>; next_cursor: string | null; [key: string]: unknown }
export interface FrameQueryOptions { scopes?: string[] | string; freshness?: string; depth?: string; limit?: number; cursor?: string; owner?: string; type?: string; site?: string; signal?: AbortSignal }
export interface FrameAskBody {
    text: string;
    model?: string | FrameChoice;
    refs?: Array<{ kind: string; id: string; title?: string; url?: string }>;
    files?: Array<string | { id?: string; media_id?: string }>;
    sources?: Array<'web' | 'openvibe' | 'mine' | 'page'>;
    depth?: 'quick' | 'balanced' | 'deep';
    context?: { site?: string; url?: string; title?: string; kind?: string; id?: string; text?: string };
}
export interface FrameRun { run: string }
export interface FrameRunSnapshot { run: { id: string; status: 'running' | 'succeeded' | 'failed'; created_at: string; finished_at: string | null; answer: string | null; citations: Array<{ n: number; title: string; url: string; site: string | null }> | null; model: string | null; error: { code: string; message: string } | null } }
export interface FrameClient {
    choices(task?: 'chat' | 'agent' | 'code' | 'image' | 'research', options?: { signal?: AbortSignal }): Promise<FrameChoices>;
    query(q: string, options?: FrameQueryOptions): Promise<FrameQueryResult>;
    providers(options?: { signal?: AbortSignal }): Promise<{ providers: Array<Record<string, unknown>> }>;
    ask(body: FrameAskBody, options?: { signal?: AbortSignal }): Promise<FrameRun>;
    events(run: string, options?: { lastEventId?: string | number; signal?: AbortSignal; maxReconnects?: number; reconnectDelayMs?: number }): AsyncIterable<AgentEvent>;
    run(id: string, options?: { signal?: AbortSignal }): Promise<AgentRun | null>;
}
export function createFrameClient(client: unknown, options?: { baseUrl?: string; networkBaseUrl?: string }): FrameClient;
