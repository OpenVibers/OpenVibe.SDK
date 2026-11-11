import type { CallOptions } from './core';
import type { FeedItem, FeedKind } from './community';

export interface FeedClient {
    list(query?: { kind?: FeedKind; cursor?: string }, opts?: CallOptions): Promise<{ items: FeedItem[]; next_cursor: string | null }>;
}
export declare function createFeedClient(client: import('./core').OpenVibeClient, options?: { communityBaseUrl?: string }): FeedClient;
