// openvibe-sdk/svg (0.176.0): an SVG cleaned before it is shown or saved, and SVG path data read (was OpenVibe.Design's
// server/vectors/svg.js and server/typefaces/path.js).

/** sanitize(): the drawing rebuilt from the allowlist, or why it was refused. */
export type SanitizeResult = { ok: true; svg: string } | { ok: false; why: string };

/** Rebuilds an SVG from the elements and attributes a drawing may have; refuses scripts, links, external references,
 *  entities and anything that is not well-formed. */
export declare function sanitize(markup: string): SanitizeResult;

/** The elements a drawing may have, by lower-cased name, to the spelling SVG gives them. */
export declare const ELEMENTS: Map<string, string>;
/** The attributes each element may keep. */
export declare const ATTRIBUTES: Record<string, string[] | readonly string[]>;
/** Attribute names never kept (event handlers, links, sources …). */
export declare const NEVER: RegExp;
/** The largest SVG sanitize() reads, in bytes. */
export declare const MAX_BYTES: number;
export declare function safeValue(value: string): string | null;
export declare function safeStyle(value: string): string | null;
export declare function safePoints(value: string): string | null;
export declare function safePathData(value: string): string | null;

/** One absolute path command (M L C Q Z) with its numbers. */
export interface PathSegment { type: 'M' | 'L' | 'C' | 'Q' | 'Z'; args: number[] }
export interface PathBox { x1: number; y1: number; x2: number; y2: number }
export type ParseResult = { ok: true; segments: PathSegment[] } | { ok: false; why: string };

/** SVG path data: parsed to absolute commands (arcs become cubics), measured, and written back. */
export declare const path: {
    parse(d: string): ParseResult;
    bbox(segments: PathSegment[]): PathBox;
    subpaths(segments: PathSegment[]): PathSegment[][];
    closed(segments: PathSegment[]): boolean;
    toData(segments: PathSegment[]): string;
    round(n: number): number;
    numText(n: number): string;
    scan(d: string): string[];
};
