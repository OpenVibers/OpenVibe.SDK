import type { OpenVibeClient } from './core';

export interface HomeLayout { home: string[]; folders: Array<{ id: string; name: string; apps: string[] }>; updated_at?: string | null; }
export interface TodayPoint { day: string; people: number | null; streams: number | null; posts: number | null; new_videos: number | null; }
export interface Today { day: string; people_today: number | null; streams_today: number | null; posts_today: number | null; new_videos_today: number | null; series: TodayPoint[]; updated_at: string; }
export interface FeedItem { id: number; source: { service: string; type: string; id: string }; title: string; url: string; label: string | null; via?: string; picture_url?: string; actor: Record<string, unknown> | null; occurred_at: string | null; }
/** One destination in the signed-out "things people do now" list and in a person's Try next: a public label, an
 * https address, an icon id and the one-line reason it is there, with the Report numbers behind them when known. */
export interface PopularItem {
    id: string;
    kind: 'site' | 'tool';
    name: string;
    url: string;
    icon: string;
    reason: string;
    score?: number;
    opens_24h?: number | null;
    opens_7d?: number | null;
    opens_prev_7d?: number | null;
    growth_7d_pct?: number | null;
    uses_24h?: number | null;
    uses_7d?: number | null;
}
export interface Popular {
    source: 'report' | 'fallback';
    reason: string;
    generated_at: string | null;
    fetched_at: string | null;
    stale: boolean;
    items: PopularItem[];
    error?: string;
}
export interface TryNext {
    source: 'report' | 'fallback';
    basis: 'co-usage' | 'popular' | 'starter';
    generated_at: string;
    items: PopularItem[];
}
export interface HomeFeedClient {
    home: { get(opts?: { signal?: AbortSignal }): Promise<HomeLayout>; set(layout: HomeLayout, opts?: { signal?: AbortSignal }): Promise<HomeLayout> };
    network: {
        today(opts?: { signal?: AbortSignal }): Promise<Today>;
        popular(opts?: { limit?: number; signal?: AbortSignal }): Promise<Popular>;
        tryNext(opts?: { limit?: number; signal?: AbortSignal }): Promise<TryNext>;
    };
    feed: {
        list(opts?: { for?: 'me'; cursor?: string; signal?: AbortSignal }): Promise<{ items: FeedItem[]; next_cursor: string | null }>;
        post(text: string, opts?: { link?: string; signal?: AbortSignal }): Promise<{ id: number; post_id: number; text: string; url: string; created_at: string }>;
        contribute(item: { id: string; text: string; url: string; picture_url?: string }, opts?: { signal?: AbortSignal }): Promise<{ item: FeedItem; created: boolean }>;
    };
}
export declare function createHomeFeedClient(client: OpenVibeClient, opts?: { networkBaseUrl?: string; communityBaseUrl?: string }): HomeFeedClient;
