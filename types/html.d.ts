// openvibe-sdk/html (0.175.0): escaping, the html`` template, the small parts of a server-drawn page, and a safe
// Markdown renderer (was server/render/html.js in 25 sites and server/render/markdown.js in 10).

/** Markup that is already safe: html`` returns it, raw() makes it, render() passes it through unescaped. */
export declare class Raw {
    constructor(s: unknown);
    readonly s: string;
    toString(): string;
}

/** A value an html`` hole takes: text is escaped, Raw is kept, arrays are joined, null/undefined/false draw nothing. */
export type Renderable = string | number | boolean | null | undefined | Raw | Renderable[];

export declare function esc(s: unknown): string;
export declare function raw(s: unknown): Raw;
export declare function html(strings: TemplateStringsArray, ...values: Renderable[]): Raw;
export declare function render(v: Renderable): string;

export declare function code(s: Renderable): Raw;
/** An ISO time as <time datetime>, read as "2026-11-16 10:00:00 UTC"; '—' when there is none. */
/** A moment as `<time>`; a full instant (…Z) also gets data-ov-time so the page says it in the reader's own zone. */
export declare function time(iso: string | null | undefined, kind?: 'datetime' | 'date' | 'time' | 'day' | 'ago' | 'full'): Raw | '—';

export interface TableOptions {
    cls?: string;
    /** Said instead of an empty table. Default 'Nothing here yet.' */
    empty?: string;
}
/** A table in a focusable, named scroll region; each cell names its column (data-label) for phone layouts. */
export declare function table(headers: Renderable[], rows: Renderable[][], options?: TableOptions): Raw;

export interface Problem {
    status?: number;
    code?: string;
    detail?: string;
    requestId?: string;
}
/** A problem as Network, Events or Media returned it, shown as it came. */
export declare function problemBox(p: Problem | null | undefined, options?: { title?: string }): Raw | '';
export declare function notice(text: Renderable, kind?: string): Raw;
export declare function csrfField(token: string): Raw;
export declare function badge(text: Renderable, kind?: string): Raw;

export interface MarkdownOptions {
    /** How far headings move down, so a page keeps its own h1. Default 1 (# is h2). */
    headingOffset?: number;
    /** The service's own text (ADRs, docs): http(s) links are plain. Default false: rel="nofollow ugc noopener", a new tab. */
    trusted?: boolean;
}
/** Markdown to HTML, escaped first: headings, paragraphs, lists, fenced code, pipe tables, bold, italics, code, links. */
export declare function markdown(src: string | null | undefined, options?: MarkdownOptions): string;
/** One line's marks (code, bold, italics, links), after escaping. */
export declare function inline(s: string, options?: { trusted?: boolean }): string;

/** A Markdown table's limits: a hostile table costs at most MAX_COLUMNS × MAX_ROWS cells. */
export declare const MAX_COLUMNS: 64;
export declare const MAX_ROWS: 1000;
