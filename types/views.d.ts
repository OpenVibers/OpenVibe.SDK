import type { OpenVibeClient } from './core';

export interface ViewRef {
    service: string;
    kind: string;
    id: string;
    /** The site the view happened on, when it differs from the owning service (the Feed counts a clip on network). */
    site?: string;
    /** The creator's canonical subject or channel username, for Report's per-creator numbers. */
    creator?: string;
}

export interface ViewEvent {
    ref: ViewRef;
    /** preview: a silent preview in the feed; watch: a watch page; live: a live stream being watched now. */
    how: 'preview' | 'watch' | 'live';
    /** Cumulative seconds watched in this session for this item. A retry sends the same number. */
    seconds: number;
    /** The item's length when known: engaged comes at min(30, of_seconds / 3) for a watch. */
    of_seconds?: number;
    /** The anonymous session id a signed-out viewer keeps (8–128 characters); a signed-in viewer sends a token instead. */
    session?: string;
}

export interface ViewResult {
    accepted: boolean;
    counted: boolean;
    engaged: boolean;
    reason?: string;
}

export interface ViewCounts {
    views: number;
    engaged: number;
    previews: number;
    /** Preview views divided by all views, 0–1; null before the item has a view. */
    preview_share: number | null;
    /** The most live watchers seen at once (how = live); null when it was never watched live. */
    peak_concurrent: number | null;
}

export interface ViewsClient {
    /** Record one event or up to 20 at once (a signed-in viewer's token, or an anonymous session id). */
    record(events: ViewEvent | ViewEvent[], options?: { signal?: AbortSignal }): Promise<{ results: ViewResult[]; counts?: ViewCounts }>;
    /** One item's numbers. */
    counts(ref: ViewRef, options?: { signal?: AbortSignal }): Promise<{ ref: ViewRef; counts: ViewCounts }>;
}

export function createViewsClient(client: OpenVibeClient, options?: { baseUrl?: string }): ViewsClient;
export const MEDIA_URL: string;
export const MAX_BATCH: number;
export const HOWS: Array<'preview' | 'watch' | 'live'>;

/** Validate and normalize one ref (throws a TypeError on a bad service, kind or id). */
export function refOf(ref: ViewRef): ViewRef;
/** Validate and normalize one event (throws a TypeError on a bad how, seconds or session). */
export function eventOf(event: ViewEvent): ViewEvent;
