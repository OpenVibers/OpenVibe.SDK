import type { OpenVibeClient } from './core';

export interface HomeLayout { home: string[]; folders: Array<{ id: string; name: string; apps: string[] }>; updated_at?: string | null; }
export interface TodayPoint { day: string; people: number | null; streams: number | null; posts: number | null; new_videos: number | null; }
export interface Today { day: string; people_today: number | null; streams_today: number | null; posts_today: number | null; new_videos_today: number | null; series: TodayPoint[]; updated_at: string; }
export interface FeedItem { id: number; source: { service: string; type: string; id: string }; title: string; url: string; label: string | null; via?: string; picture_url?: string; actor: Record<string, unknown> | null; occurred_at: string | null; }
export interface HomeFeedClient {
    home: { get(opts?: { signal?: AbortSignal }): Promise<HomeLayout>; set(layout: HomeLayout, opts?: { signal?: AbortSignal }): Promise<HomeLayout> };
    network: { today(opts?: { signal?: AbortSignal }): Promise<Today> };
    feed: {
        list(opts?: { for?: 'me'; cursor?: string; signal?: AbortSignal }): Promise<{ items: FeedItem[]; next_cursor: string | null }>;
        post(text: string, opts?: { link?: string; signal?: AbortSignal }): Promise<{ id: number; post_id: number; text: string; url: string; created_at: string }>;
        contribute(item: { id: string; text: string; url: string; picture_url?: string }, opts?: { signal?: AbortSignal }): Promise<{ item: FeedItem; created: boolean }>;
    };
}
export declare function createHomeFeedClient(client: OpenVibeClient, opts?: { networkBaseUrl?: string; communityBaseUrl?: string }): HomeFeedClient;
