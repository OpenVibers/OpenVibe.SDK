/** openvibe-sdk/live: OpenVibe.Live — who is live, channels, slots, going live, sessions, WHIP and the content feeds. */
type Opts = { signal?: AbortSignal };
/** Live's JSON as documented at https://openvibe.live/documentation (shapes vary by route). */
type LiveJson = Record<string, any>;
export interface SlotRequest {
    title?: string; description?: string; category?: string; protocol?: string; is_nsfw?: boolean; slug?: string;
    streaming_method?: 'browser' | 'whip' | 'cli' | 'rtmp'; control_config_id?: number;
    [setting: string]: unknown;
}
export interface GoLiveOptions { title?: string; category?: string; tags?: string[] | string; is_nsfw?: boolean; control_config_id?: number }
export interface FeedOptions extends Opts { type?: string; sort?: 'new' | 'top'; window?: string; cursor?: string; limit?: number }
export interface WhipSession { answer: string; location: string | null }
export interface LiveClient {
    streams: {
        list(opts?: Opts): Promise<LiveJson>;
        get(streamId: number | string, opts?: Opts): Promise<LiveJson>;
        recentlyOnline(opts?: Opts): Promise<LiveJson>;
        mine(opts?: Opts): Promise<LiveJson>;
        update(streamId: number | string, patch: { title?: string; description?: string; category?: string; tags?: string[] | string }, opts?: Opts): Promise<LiveJson>;
        end(streamId: number | string, opts?: Opts): Promise<LiveJson>;
        heartbeat(streamId: number | string, opts?: Opts): Promise<LiveJson>;
        endpoint(streamId: number | string, opts?: Opts): Promise<LiveJson>;
    };
    slots: {
        list(opts?: Opts): Promise<LiveJson>;
        create(slot: SlotRequest, opts?: Opts): Promise<LiveJson>;
        update(slotId: number | string, patch: SlotRequest, opts?: Opts): Promise<LiveJson>;
        remove(slotId: number | string, opts?: Opts): Promise<LiveJson>;
        regenerateKey(slotId: number | string, opts?: Opts): Promise<LiveJson>;
    };
    /** Go live from a slot → { stream, endpoint }. */
    goLive(slotId: number | string, opts?: GoLiveOptions, extra?: Opts): Promise<{ stream: LiveJson; endpoint: LiveJson }>;
    channels: {
        get(username: string, opts?: Opts): Promise<LiveJson>;
        mine(opts?: Opts): Promise<LiveJson>;
        update(patch: Record<string, unknown>, opts?: Opts): Promise<LiveJson>;
        toggleFollow(username: string, opts?: Opts): Promise<LiveJson>;
        url(username: string): Promise<string>;
    };
    content: {
        feed(opts?: FeedOptions): Promise<{ items: LiveJson[]; next: string | null; [k: string]: unknown }>;
        moments(opts?: FeedOptions): Promise<{ items: LiveJson[]; next: string | null; [k: string]: unknown }>;
    };
    whip: {
        url(keyOrSlot: string | number): Promise<string>;
        publish(url: string | Promise<string>, offer: string, opts?: Opts & { key?: string }): Promise<WhipSession>;
        end(location: string, opts?: Opts): Promise<void>;
    };
}
export function createLiveClient(client: { json(opts: Record<string, unknown>): Promise<any>; request(opts: Record<string, unknown>): Promise<any>; origin(service: string): Promise<string> }, options?: { baseUrl?: string }): LiveClient;
