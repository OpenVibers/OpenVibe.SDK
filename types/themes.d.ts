import type { OpenVibeClient } from './core';

type Opts = { signal?: AbortSignal };
export type ThemeVariables = Record<string, string>;
/** theme: the dark half; light: its light half (Hayride for Halloween). */
export interface Season { id: string; name: string; theme: string; light?: string; from: string; to: string }
export interface Theme {
    id: string; name: string; slug: string; description?: string; mode: 'dark' | 'light'; variables: ThemeVariables;
    preview_colors?: string[] | null; tags?: string[]; is_builtin?: number; downloads?: number;
    /** A seasonal theme: when it stands in for the default theme (MM-DD, both days included). */
    season?: { id: string; name: string; from: string; to: string };
    [field: string]: unknown;
}
export interface DisplayPrefs { motion?: 'auto' | 'reduced'; text?: '100' | '112' | '125'; seasonal?: 'on' | 'off'; scheme?: 'manual' | 'auto' }
export interface ActiveTheme { theme_id: string | null; custom_variables?: ThemeVariables | null; display?: DisplayPrefs | null; guest?: boolean }
export interface ThemesClient {
    catalog(query?: { mode?: 'dark' | 'light'; search?: string; sort?: 'downloads' | 'rating'; limit?: number }, opts?: Opts): Promise<{ themes: Theme[] }>;
    get(idOrSlug: string, opts?: Opts): Promise<Theme | null>;
    export(idOrSlug: string, opts?: Opts): Promise<{ format: 'openvibe-theme@1'; name: string; slug: string; mode: string; variables: ThemeVariables; [k: string]: unknown } | null>;
    active(opts?: Opts): Promise<ActiveTheme>;
    set(themeId: string, extra?: { custom?: ThemeVariables | null }, opts?: Opts): Promise<{ success: boolean; theme_id: string; custom_variables: ThemeVariables | null }>;
    setDisplay(patch: DisplayPrefs, opts?: Opts): Promise<{ ok: boolean; display: DisplayPrefs }>;
    seasons(query?: { date?: string }, opts?: Opts): Promise<{ seasons: Season[]; now: { id: string; name: string; theme: string } | null }>;
    submissions(opts?: Opts): Promise<{ themes: Theme[] }>;
    submit(theme: { name: string; description?: string; mode: 'dark' | 'light'; variables: ThemeVariables; tags?: string[] }, opts?: Opts): Promise<Record<string, unknown>>;
    import(file: Record<string, unknown>, opts?: Opts): Promise<Record<string, unknown>>;
}
export interface ThemeSnapshot {
    id: string | null;
    mode: 'dark' | 'light' | string;
    tokens: Record<string, string>;
    display: { motion: 'auto' | 'reduced'; text: '100' | '112' | '125'; seasonal: 'on' | 'off'; scheme: 'manual' | 'auto'; textScale: number; calm: boolean };
    season: { id: string } | null;
    seasonMark: string | null;
}
export function createThemesClient(client: OpenVibeClient, opts?: { baseUrl?: string }): ThemesClient;
export function followTheme(fn: (theme: ThemeSnapshot) => void, opts?: { root?: Element; names?: readonly string[] }): () => void;
export function readTheme(opts?: { root?: Element; names?: readonly string[] }): ThemeSnapshot;
export function applyTheme(vars: ThemeVariables, opts?: { root?: HTMLElement }): HTMLElement | null;
export function seasonOn(date: Date | string | number | null | undefined, seasons: Season[]): Season | null;
export function onColor(hex: string): '#0b0d10' | '#ffffff' | null;
export const DISPLAY_OPTIONS: Readonly<{ motion: string[]; text: string[]; seasonal: string[]; scheme: string[] }>;
export const TOKENS: readonly string[];
