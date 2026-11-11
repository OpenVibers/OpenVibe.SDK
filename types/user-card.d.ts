import type { OpenVibeClient } from './core';
/** An omitted field is hidden or unavailable, never an implied zero/offline state. */
export interface UserCard {
    username: string;
    profile_url: string;
    display_name?: string;
    avatar_url?: string;
    channel_url?: string;
    live?: { now: false } | { now: true; site: 'live'; url: string };
    /** Network's global level (the level shown by Quest). */
    level?: number;
    /** Consecutive completed daily quests, using the person's chosen time zone. */
    streak?: number;
    badges_count?: number;
    followers?: number;
    /** Explicit opt-in; site names only, from the last seven days of Network history. */
    active_sites?: Array<{ id: string; name: string; url: string }>;
}
export interface UserCardClient {
    get(username: string, options?: { signal?: AbortSignal }): Promise<UserCard>;
}
/** Public read, without Bearer credentials or cookies. Disabled owner switch returns HTTP 503. */
export function createUserCardClient(client: OpenVibeClient, options?: { baseUrl?: string }): UserCardClient;
