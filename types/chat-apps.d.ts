/** openvibe-sdk/chat-apps: the three chat apps (Telegram, Discord, Slack) — the checks, the buttons and the messages. */
export type ChatApp = 'telegram' | 'discord' | 'slack';
export interface DeliveryCheck {
    provider: ChatApp | string;
    secret?: string | null;
    publicKey?: string | null;
    raw?: Buffer | string;
    headers?: Record<string, string | string[] | undefined>;
    now?: number;
}
export interface CallbackPayload {
    exp?: number;
    iat?: number;
    act?: string;
    id?: string;
    app?: ChatApp | string;
    chatId?: string;
    userId?: string;
    subject?: string;
    [k: string]: unknown;
}
export interface ChatMessage {
    app: ChatApp;
    kind: 'message' | 'command' | 'mention' | 'button' | 'ping' | 'unknown';
    chatId: string;
    chatType: 'private' | 'group' | 'channel' | 'unknown';
    userId: string;
    userName: string | null;
    text: string;
    command: string | null;
    args: string;
    mention: boolean;
    replyToBot: boolean;
    attachments: Array<{ kind: string; id?: string; name?: string | null; mime?: string | null; url?: string | null }>;
    button: { id: string; value?: string | null } | null;
    messageId?: string;
    requestId?: string | null;
    threadTs?: string | null;
    raw: unknown;
}
export function verifyTelegram(args: { secret?: string | null; headers?: Record<string, any> }): boolean;
export function verifySlack(args: { secret?: string | null; raw?: Buffer | string; headers?: Record<string, any>; now?: number }): boolean;
export function verifyDiscord(args: { publicKey?: string | null; raw?: Buffer | string; headers?: Record<string, any>; now?: number }): boolean;
export function verifyDelivery(args: DeliveryCheck): boolean;
export function signCallback(args: { secret: string; payload: CallbackPayload }): string;
export function verifyCallback(args: { secret: string; token: string; now?: number; maxAgeMs?: number }): CallbackPayload | null;
export function parseTelegramUpdate(update: any, opts?: { botUsername?: string | null; botUserId?: string | null }): ChatMessage | null;
export function parseDiscordInteraction(interaction: any, opts?: { botUserId?: string | null }): ChatMessage | null;
export function parseSlackEvent(event: any, opts?: { botUserId?: string | null }): ChatMessage | null;
export function parseSlackInteraction(payload: any): ChatMessage | null;
export function splitText(app: ChatApp | string, body: string, limit?: number): string[];
export function commandOf(body: string): { command: string; args: string; mentionName: string | null } | null;
export function safeEqual(a: unknown, b: unknown): boolean;
export const APP_LIMITS: { telegram: number; discord: number; slack: number };
export const PROVIDERS: string[];
export const TOLERANCE_SEC: number;

export function signButton(args: { secret: string; id: string }): string;
export function verifyButton(args: { secret: string; token: string }): string | null;
export function parseDiscordMessage(message: any, opts?: { botUserId?: string | null }): ChatMessage | null;
