/** openvibe-sdk/tips: OpenVibe.Tips — tip pages, tipping, receipts, goals, moderation and overlays. */
type Opts = { signal?: AbortSignal };
type TipsJson = Record<string, any>;
export interface TipRequest {
    creator: string; amount: number; message?: string; goal_id?: string; pay_with: 'credit' | 'checkout';
    provider?: string; privacy?: string; supporter?: string; target?: string; [k: string]: unknown;
}
export interface TipResult { interaction: TipsJson; checkout_url: string | null; checkout_ref: string | null }
export interface TipsClient {
    profiles: {
        get(creator: string, opts?: Opts): Promise<TipsJson>;
        update(patch: Record<string, unknown>, opts?: Opts): Promise<TipsJson>;
        totals(creator?: string, opts?: Opts): Promise<TipsJson>;
        sounds(creator: string, opts?: Opts): Promise<TipsJson>;
        supporters(creator: string, opts?: Opts): Promise<TipsJson>;
    };
    tip(req: TipRequest, opts?: Opts): Promise<TipResult>;
    send: {
        message(req: TipRequest, opts?: Opts): Promise<TipResult>;
        tts(req: TipRequest & { tts: { text: string; voice?: string } }, opts?: Opts): Promise<TipResult>;
        media(req: TipRequest & { media: { url: string } }, opts?: Opts): Promise<TipResult>;
        sound(req: TipRequest & { sound: { id: string } }, opts?: Opts): Promise<TipResult>;
    };
    interactions: {
        get(id: string, opts?: Opts): Promise<{ interaction: TipsJson }>;
        list(opts?: Opts & { creator?: string; supporter?: string; as?: 'creator'; cursor?: string }): Promise<{ interactions: TipsJson[]; next_cursor: string | null }>;
        recordExternal(req: { creator: string; provider: string; provider_ref: string; amount_cents: number; supporter_name?: string; message?: string; announce?: boolean }, opts?: Opts): Promise<TipsJson>;
        hide(id: string, opts?: Opts & { reason?: string }): Promise<TipsJson>;
        restore(id: string, opts?: Opts & { reason?: string }): Promise<TipsJson>;
    };
    goals: {
        list(creator: string, opts?: Opts): Promise<TipsJson>;
        get(id: string, opts?: Opts): Promise<TipsJson>;
        create(goal: Record<string, unknown>, opts?: Opts): Promise<{ goal: TipsJson }>;
        update(id: string, patch: Record<string, unknown>, opts?: Opts): Promise<TipsJson>;
        close(id: string, opts?: Opts): Promise<TipsJson>;
    };
    moderation: {
        queue(opts?: Opts & { creator?: string; state?: 'held' | 'hidden' | 'visible' | 'all' }): Promise<TipsJson>;
        log(opts?: Opts & { creator?: string }): Promise<TipsJson>;
        moderators: { list(opts?: Opts): Promise<TipsJson>; add(req: Record<string, unknown>, opts?: Opts): Promise<TipsJson>; remove(subject: string, opts?: Opts): Promise<TipsJson> };
    };
    overlays: {
        tokens: { list(opts?: Opts): Promise<TipsJson>; create(req?: Record<string, unknown>, opts?: Opts): Promise<{ token: string; secret: string; overlay_url: string; events_url: string }>; revoke(id: string, opts?: Opts): Promise<TipsJson> };
        configs: { list(opts?: Opts): Promise<TipsJson>; get(id: string, opts?: Opts): Promise<TipsJson>; create(config: Record<string, unknown>, opts?: Opts): Promise<TipsJson>; update(id: string, patch: Record<string, unknown>, opts?: Opts): Promise<TipsJson> };
        simulate(req?: Record<string, unknown>, opts?: Opts): Promise<TipsJson>;
    };
    me: { export(opts?: Opts): Promise<TipsJson>; erase(opts?: Opts): Promise<TipsJson> };
}
export function createTipsClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): TipsClient;
