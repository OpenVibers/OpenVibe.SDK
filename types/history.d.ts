export interface HistoryRow {
  id: number; type: string; title: string; url: string; image_url?: string | null;
  service: string | null; service_label: string | null; created_at: string; updated_at: string;
}
export interface HistoryList { items: HistoryRow[]; total: number; next_cursor: string | null; keep_history: boolean; agents_allowed: boolean; }
export declare function createHistoryClient(client: unknown, options?: { baseUrl?: string }): {
  list(query?: { cursor?: string; limit?: number; day?: string; site?: string; kind?: string; q?: string }, options?: { signal?: AbortSignal }): Promise<HistoryList>;
  find(q: string, options?: { limit?: number; signal?: AbortSignal }): Promise<{ query: string; items: HistoryRow[] }>;
  summary(period?: 'day' | 'week', options?: { signal?: AbortSignal }): Promise<{ period: 'day' | 'week'; items: Array<{ kind: string; title: string }>; text: string }>;
  agentRecent(query?: { limit?: number }, options?: { signal?: AbortSignal }): Promise<{ items: HistoryRow[] }>;
  settings(patch: { keep_history?: boolean; agents_allowed?: boolean }, options?: { signal?: AbortSignal }): Promise<{ keep_history: boolean; agents_allowed: boolean }>;
  remove(id: number | string, options?: { signal?: AbortSignal }): Promise<{ ok: boolean }>;
  removeDay(day: string, options?: { signal?: AbortSignal }): Promise<{ deleted: number }>;
  removeSite(site: string, options?: { signal?: AbortSignal }): Promise<{ deleted: number }>;
  clear(options?: { signal?: AbortSignal }): Promise<{ deleted: number }>;
};
