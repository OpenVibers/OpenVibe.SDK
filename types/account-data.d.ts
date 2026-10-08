import type { IncomingMessage, ServerResponse } from 'http';

/** A table holding a person's rows here. */
export interface AccountDataTable {
    table: string;
    /** The column naming the person. */
    subject: string;
    /** usr_… → what the subject column stores (default: the id itself); may return several forms. */
    value?: (subject: string) => string | string[];
    /** The export file (default '<table>.json'); null leaves the table out of the export. */
    file?: string | null;
    /** The exported columns (default: all). */
    columns?: string[];
    /** The export order column (default created_at, else the first column). */
    order?: string;
    /** 'delete' (default), { anonymize: { column: value } } (subject column NULL, row kept) or { keep: why }. */
    erase?: 'delete' | { anonymize: Record<string, unknown> } | { keep: string };
    /** The name the counts use (default: the table). */
    kind?: string;
}
export interface ExportFile { name: string; content: unknown }
export interface ExportPart { subject: string; files: ExportFile[]; truncated: string[]; note?: string }
export interface EraseCounts { erased: Record<string, number>; retained: Record<string, number> }
export type AccountDataOutcome = 'exported' | 'erased' | 'confirmed' | 'closed' | 'unchanged' | `ignored:${string}`;
export type NetworkSend = (path: string, body: unknown) => Promise<Response>;
export interface AccountData {
    apply(event: { event_type: string; source?: string; event_id?: string; payload?: unknown }, opts: { send: NetworkSend }): Promise<AccountDataOutcome>;
    exportPart(subject: string): Promise<ExportPart>;
    erase(subjects: string[]): Promise<EraseCounts>;
    ensureSchema(): Promise<void>;
    /** POST /internal/events handler (no body parser before it). */
    consumer(opts: { secrets: string[]; send: NetworkSend; onEvent?: (event: any) => Promise<string | void> | string | void; now?: () => number; limit?: number }): (req: IncomingMessage & Record<string, any>, res: ServerResponse) => Promise<void>;
    TOPICS: readonly string[];
    tables: { table: string; subject: string; file: string | null; erase: AccountDataTable['erase'] }[];
}
export function createAccountData(opts: {
    db: any;
    service: string;
    tables: AccountDataTable[];
    extraExport?: (db: any, subject: string) => Promise<ExportFile[] | void>;
    extraErase?: (tx: any, subjects: string[], counts: EraseCounts & { add(o: Record<string, number>, kind: string, n: number): void }) => Promise<void>;
    note?: string | null;
    rowLimit?: number;
    log?: { log(msg: string): void; warn(msg: string): void };
}): AccountData;
export function createNetworkSender(opts: { networkInternalUrl: string; clientId: string; clientSecret: string; fetch?: typeof fetch; timeoutMs?: number }): NetworkSend;
export const ACCOUNT_DATA_SCHEMA: string;
export const TOPICS: readonly string[];
