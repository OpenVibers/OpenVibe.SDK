// openvibe-sdk/markdown (0.178.0): a small, safe Markdown renderer for posts, pastes and documents (was
// OpenVibe.Community's server/render/markdown.js; OpenVibe.Git carried an older subset).

/** A fenced block's highlighter: the inner HTML of its <code> (escaped by the highlighter) and the language it used. */
export type Highlight = (code: string, language: string) => { html: string; language: string };

export interface RenderOptions {
    /** Headings are demoted this many levels (1–4) so a page keeps one h1. Default 2. */
    headingShift?: number;
    /** A whole document: the heading levels it uses are numbered in order after the shift. */
    document?: boolean;
    /** Draws a fenced block with a language; without one, the code is escaped as it is. */
    highlight?: Highlight | null;
}

/** Markdown source → HTML. Every piece of text is escaped; raw HTML in the source is shown as text. */
export declare function renderMarkdown(source: unknown, options?: RenderOptions): string;
/** Markdown source → plain text for descriptions, JSON-LD and feeds, at most `max` characters. The caller escapes it. */
export declare function markdownToText(source: unknown, max?: number): string;
/** & < > " ' as entities. */
export declare function escapeHtml(s: unknown): string;
