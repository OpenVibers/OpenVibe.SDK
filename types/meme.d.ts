import type { OpenVibeClient } from './core';

export interface MemeOptions { signal?: AbortSignal; }
export interface MemeDefaults extends MemeOptions { baseUrl?: string; }

export type MemeScope = 'openvibe' | 'internet';
export type MemeStatus = 'rising' | 'peaked' | 'classic' | 'dead';
export type MemeLabel = 'nudity' | 'language' | 'graphic' | '18+' | 'flashing' | 'spoilers';

export interface MemeEntry {
    id: string;
    slug: string;
    title: string;
    kind: string;
    scope: MemeScope;
    summary: string | null;
    meaning?: string | null;
    usage?: string | null;
    labels: MemeLabel[];
    status: MemeStatus;
    status_since: string;
    first_seen_at: string;
    last_seen_at: string;
    visibility: 'public' | 'unlisted' | 'hidden';
    revision: number;
    submitted_by?: string | null;
    uses?: number;
    created_at: string;
    updated_at: string;
    [field: string]: unknown;
}

export interface MemeCitation {
    id: number;
    entry_id: string;
    role: 'origin' | 'use' | 'example';
    source_service: string;
    source_type: string;
    source_id: string;
    quote_text: string;
    url: string;
    observed_at: string;
    source_status: 'live' | 'hidden' | 'gone';
    [field: string]: unknown;
}

export interface MemeOrigin {
    source: 'web' | 'reddit' | 'media' | 'openvibe';
    url: string;
    title: string;
    publisher: string | null;
    author: string | null;
    published_at: string | null;
    retrieved_at: string;
    quote: string | null;
}

export interface MemeSpreadPoint { id: number; observed_at: string; place: string; url: string | null; count: number | null; note: string | null; }
export interface MemeVariation { id: number; name: string; description: string | null; media_id: string | null; source_url: string | null; }
export interface MemeExample { id?: number; media_id: string; caption?: string | null; source_url?: string | null; }
export interface MemeRelated { id: string; slug: string; title: string; status: MemeStatus; summary: string | null; }

export interface MemeRevision {
    revision: number;
    author: string;
    base_revision: number | null;
    change: Record<string, unknown>;
    diff: Array<{ field: string; from: unknown; to: unknown }>;
    moderation_state: 'pending' | 'approved' | 'rejected';
    note: string | null;
    created_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
    entry_slug?: string;
    entry_title?: string;
}

export interface MemeEntryDetail extends MemeEntry {
    origin: MemeOrigin | MemeCitation | null;
    web_origin?: MemeOrigin | null;
    citations: MemeCitation[];
    timeline: MemeCitation[];
    examples: MemeExample[];
    spread: MemeSpreadPoint[];
    variations: MemeVariation[];
    related: MemeRelated[];
    revisions: MemeRevision[];
}

export interface MemeSearchQuery extends MemeOptions {
    scope?: MemeScope;
    q?: string;
    status?: MemeStatus;
    label?: MemeLabel;
    kind?: string;
    sort?: 'newest' | 'top';
    window?: 'day' | 'week' | 'month' | 'all';
    channel?: number | string;
    limit?: number;
    cursor?: string;
}
export interface MemeSearchResult { count: number; entries: MemeEntry[]; next_cursor: string | null; }

export interface MemeTrendPost {
    id: string; subreddit: string; title: string; author: string | null; permalink: string;
    url: string | null; image_url: string | null; media_id: string | null; phash: string | null;
    score: number; comments: number; over_18: boolean; created_at: string; last_seen_at: string;
    velocity: number; velocity_basis: 'samples' | 'score_age'; velocity_samples: number; score_delta: number | null;
}
export interface MemeTrendTemplate { id: string; label: string | null; phash: string; image_url: string | null; media_id: string | null; post_count: number; first_seen_at: string; last_seen_at: string; }
export interface MemeTrends {
    window: 'day' | 'week'; from: string; to: string;
    rising: MemeTrendPost[]; templates: MemeTrendTemplate[];
    entries: Array<Pick<MemeEntry, 'id' | 'slug' | 'title' | 'kind' | 'status' | 'first_seen_at' | 'last_seen_at'>>;
    subreddits: Array<{ subreddit: string; posts: number; score: number; top: { id: string; title: string; score: number } | null }>;
}

export interface MemeAnalysisInput { url?: string; media_id?: string; mediaId?: string; }
export interface MemeAnalysisOrigin { title: string; url: string | null; year: number | null; confidence: number; why: string | null; entry_slug: string | null; }
export interface MemeAnalysis {
    id: string;
    input: { url: string | null; media_id: string | null };
    template: { name: string | null; known: boolean; template_id: string | null; template: MemeTemplate | null; closest_entry: MemeRelated | null };
    matched_entries: Array<MemeRelated & { kind: string; match: number }>;
    origins: MemeAnalysisOrigin[];
    meaning: string | null;
    usage: string | null;
    labels: MemeLabel[];
    vision: { alt: string; caption: string; tags: string[] } | null;
    reddit: {
        spread: { subreddit: string | null; score: number; upvote_ratio: number; comments: number; created_at: string | null; permalink: string | null; crossposts: number; over_18: boolean };
        post: { id: string; title: string; permalink: string | null };
        comments_tone: { tone: 'positive' | 'negative' | 'mixed' | 'neutral' | 'ironic'; summary: string } | null;
        comments_sampled: number;
    } | null;
    similar: string[];
    cost_usd: number;
    created_at: string;
}

export interface MemeResearchInput { topic: string; }
export interface MemeResearchSource { n: number; title: string; url: string; provider: string; license: string | null; retrieved_at: string | null; snippet: string; }
export interface MemeResearch {
    id: string;
    topic: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    title: string | null;
    summary: string | null;
    body_markdown?: string | null;
    sources: MemeResearchSource[];
    facts: Array<{ label: string; value: string }>;
    citations: MemeResearchSource[];
    cost_usd: number;
    error: { code: string; detail: string | null } | null;
    entry_slug: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    subject?: string;
}

export interface MemeTemplate { id: string; name: string; image_url: string; box_count: number; source: string; license: string; layout?: Record<string, unknown> | null; created_at?: string; }
export interface MemeGenerateInput { template?: string; template_slug?: string; topic?: string; lines?: string[]; }
export interface MemeGenerateResult {
    media_id: string;
    media_url: string;
    captions: string[];
    template: MemeTemplate;
    labels: MemeLabel[];
    caption: { id: string; subject: string; template_id: string; lines: string[]; created_at: string; visibility: string; labels?: MemeLabel[]; media_id?: string | null };
    cost_usd: number;
}

export interface MemeClient {
    search(query?: MemeSearchQuery): Promise<MemeSearchResult>;
    entry(slug: string, opts?: MemeOptions): Promise<MemeEntryDetail>;
    revisions(slug: string, opts?: MemeOptions): Promise<{ slug: string; count: number; revisions: MemeRevision[] }>;
    trends(opts?: { window?: 'day' | 'week'; limit?: number } & MemeOptions): Promise<MemeTrends>;
    analyze(input: MemeAnalysisInput, opts?: MemeOptions): Promise<MemeAnalysis>;
    research(topic: string, opts?: MemeOptions): Promise<MemeResearch>;
    researchGet(id: string, opts?: MemeOptions): Promise<MemeResearch>;
    saveResearch(id: string, opts?: MemeOptions): Promise<{ entry: MemeEntry; already: boolean }>;
    generate(input: MemeGenerateInput, opts?: MemeOptions): Promise<MemeGenerateResult>;
}

export function createMemeClient(client: OpenVibeClient, defaults?: MemeDefaults): MemeClient;
