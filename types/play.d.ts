/** openvibe-sdk/play: OpenVibe.Play game services — titles, scores, achievements and leaderboards. */
export interface PlayAchievementDef { id: string; name: string; description?: string; hidden?: boolean }
export interface PlayBoardDef { id: string; name: string; kind: 'best' | 'sum' }
export interface PlayTitleDefinition { name: string; url?: string; summary?: string; achievements?: PlayAchievementDef[]; boards?: PlayBoardDef[] }
export interface PlayScoreEntry { player: string; name: string; score: number; [k: string]: unknown }
export interface PlayClient {
    titles: {
        define(title: string, definition: PlayTitleDefinition, opts?: { signal?: AbortSignal }): Promise<any>;
        list(opts?: { signal?: AbortSignal }): Promise<any>;
        get(title: string, opts?: { signal?: AbortSignal }): Promise<any | null>;
    };
    scores: {
        post(title: string, round: { board: string; ref: string; at?: string; entries: PlayScoreEntry[] }, opts?: { signal?: AbortSignal }): Promise<any>;
    };
    achievements: {
        unlock(title: string, input: { player: string; achievements: string[]; at?: string }, opts?: { signal?: AbortSignal }): Promise<any>;
    };
    players: {
        adopt(title: string, guest: string, person: string, opts?: { signal?: AbortSignal }): Promise<any>;
        achievements(title: string, player: string, opts?: { signal?: AbortSignal }): Promise<any>;
    };
    boards: {
        get(title: string, board: string, opts?: { period?: string; page?: number; signal?: AbortSignal }): Promise<any | null>;
    };
}
export function createPlayClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): PlayClient;
