/** billing.money-reason@1: the plain words for a movement of OpenCoins, Vibes or Balance. */
export interface MoneyReasonSubject { name: string; url: string | null }
export interface MoneyReason {
    /** The ledger's own reason, kept for support and logs; a page never prints it. */
    key: string;
    /** The phrase without the amount: "for the quest Publish a video". */
    text: string;
    /** What it was for, with its own name and address, or null. */
    subject: MoneyReasonSubject | null;
    /** The site in words: OpenVibe.Quest, OpenVibe.Live, OpenVibe. */
    site: string;
    /** False for a key no kind declares; its text is "for something on <site>". */
    known: boolean;
}
export type MoneyReasonResolver = (value: string) => { name: string; url?: string | null } | string | null | undefined;
export function describe(key: string | null | undefined, options?: { resolve?: Record<string, MoneyReasonResolver>; subject?: MoneyReasonSubject | null; site?: string }): MoneyReason;
export function describeRow(row: { reason?: string | null; reason_key?: string | null; app_id?: string | null; site?: string | null }, options?: { resolve?: Record<string, MoneyReasonResolver>; subject?: MoneyReasonSubject | null; site?: string }): MoneyReason;
export function unknownText(site?: string): string;
export function siteName(site?: string): string;
export function titleFromSlug(slug?: string): string;
export const SITES: Readonly<Record<string, string>>;
export const KINDS: ReadonlyArray<{ id: string; site: string; text?: string; path?: string; catalog?: string; subject?: string }>;
