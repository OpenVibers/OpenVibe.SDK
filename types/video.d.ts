/** openvibe-sdk/video: OpenVibe.Video's playlists of recordings and clips. */
type Opts = { signal?: AbortSignal };
export type PlaylistVisibility = 'public' | 'unlisted' | 'private';
export interface PlaylistItemRef { kind: 'vod' | 'clip'; id: number }
export interface Playlist { id: string; title: string; description: string | null; visibility: PlaylistVisibility; item_count: number; created_at: string; updated_at: string; owner?: { kind: string; username?: string | null } }
export interface PlaylistItem extends PlaylistItemRef { position: number; added_at: string }
export interface VideoClient {
    playlists: {
        list(opts?: Opts): Promise<{ playlists: Playlist[] }>;
        create(req: { title: string; description?: string; visibility?: PlaylistVisibility }, opts?: Opts): Promise<{ playlist: Playlist }>;
        get(id: string, opts?: Opts): Promise<{ playlist: Playlist; items: PlaylistItem[] }>;
        update(id: string, patch: { title?: string; description?: string | null; visibility?: PlaylistVisibility }, opts?: Opts): Promise<{ playlist: Playlist }>;
        remove(id: string, opts?: Opts): Promise<unknown>;
        items: {
            add(id: string, item: PlaylistItemRef, opts?: Opts): Promise<Record<string, any>>;
            reorder(id: string, items: PlaylistItemRef[], opts?: Opts): Promise<{ items: PlaylistItem[] }>;
            remove(id: string, item: PlaylistItemRef, opts?: Opts): Promise<unknown>;
        };
    };
    users: { playlists(username: string, opts?: Opts & { limit?: number; cursor?: string }): Promise<{ playlists: Playlist[]; next_cursor: string | null }> };
}
export function createVideoClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): VideoClient;
