/** openvibe-sdk/db — the async PostgreSQL data layer (ADR-035). */
export declare class Sql {
    readonly parts: string[];
    readonly values: unknown[];
    compile(start?: number): { text: string; values: unknown[] };
}
export interface SqlTag {
    (strings: TemplateStringsArray, ...values: unknown[]): Sql;
    /** "name" or "schema"."name"; throws on anything else. */
    ident(name: string): Sql;
    /** Trusted text, inserted as is. Never user input. */
    raw(text: string): Sql;
    join(items: Iterable<unknown>, sep?: Sql): Sql;
    set(obj: Record<string, unknown>): Sql;
    insert(rows: Record<string, unknown> | Record<string, unknown>[], columns?: string[]): Sql;
    json(value: unknown): Sql;
}
export const sql: SqlTag;

export type Row = Record<string, any>;
export interface Queryable {
    query(q: Sql | string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number }>;
    many<T = Row>(q: Sql | string, values?: unknown[]): Promise<T[]>;
    maybe<T = Row>(q: Sql | string, values?: unknown[]): Promise<T | null>;
    /** Throws DbError (code 'no_rows') when there is none. */
    one<T = Row>(q: Sql | string, values?: unknown[]): Promise<T>;
    value<T = unknown>(q: Sql | string, values?: unknown[]): Promise<T | null>;
    exec(q: Sql | string, values?: unknown[]): Promise<number>;
}
/** An async statement shaped like better-sqlite3's: ? or @name / :name parameters. */
export interface Statement {
    readonly source: string;
    /** The first row, or undefined. */
    get<T = Row>(...params: unknown[]): Promise<T | undefined>;
    all<T = Row>(...params: unknown[]): Promise<T[]>;
    /** lastInsertRowid is the first column of the first returned row (needs RETURNING). */
    run(...params: unknown[]): Promise<{ changes: number; rows: Row[]; lastInsertRowid: unknown }>;
    /** The same statement returning each row's first column. */
    pluck(on?: boolean): Statement;
}
export interface Tx extends Queryable {
    sql: SqlTag;
    /** A nested savepoint: rolls back alone when fn throws. */
    tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>;
    prepare(text: string): Statement;
    /** Run fn after the whole transaction commits (dropped if this savepoint or the transaction rolls back). */
    afterCommit(fn: () => unknown): void;
}
export interface TxOptions { isolation?: 'read committed' | 'repeatable read' | 'serializable'; retries?: number; readOnly?: boolean }
export interface MigrateResult { applied: { id: string; name: string; phase: string; ms: number }[]; pending: { id: string; name: string; phase: string }[]; held: { id: string; reason: string }[] }
export interface Db extends Queryable {
    sql: SqlTag;
    readonly store: 'postgresql' | 'pglite';
    /** Inside fn, plain db calls join the transaction (ambient mode, the default); a db.tx inside is a savepoint. */
    tx<T>(fn: (t: Tx) => Promise<T>, opts?: TxOptions): Promise<T>;
    prepare(text: string): Statement;
    inTransaction(): boolean;
    /** Run fn after the running transaction commits (dropped on rollback); outside one, on the next turn. */
    afterCommit(fn: () => unknown): void;
    /** Run fn outside any ambient transaction. */
    detached<T>(fn: () => T): T;
    ready(): Promise<{ ok: true; detail: { store: string; pool: { total: number; idle: number; waiting: number } } } | { ok: false; error: string }>;
    migrate(o: { dir: string; windowDays?: number; dryRun?: boolean; now?: () => number; log?: { log(msg: string): void } }): Promise<MigrateResult>;
    stats(): { queries: number; errors: number; slow: number; retries: number; tx: number; open: number; pool: { total: number; idle: number; waiting: number } };
    close(): Promise<void>;
}
export interface CreateDbOptions {
    /** Default: DATABASE_URL (through PgBouncer). */
    url?: string;
    /** true: in-memory PGlite (tests); a directory: persisted; or a PGlite instance. */
    pglite?: boolean | string | object;
    service?: string;
    max?: number;
    queryTimeoutMs?: number;
    slowMs?: number;
    log?: { warn(msg: string): void; error(msg: string): void };
    registry?: object;
    /** Default true: db calls inside db.tx join it (AsyncLocalStorage). */
    ambient?: boolean;
}
export function createDb(opts?: CreateDbOptions): Db;
export declare class DbError extends Error { code?: string; detail?: string; constraint?: string; table?: string; column?: string; statement?: string; cause?: unknown }
export const PARSERS: Record<number, (v: string) => unknown>;
export const ISOLATION: Record<string, string>;
