// openvibe-sdk/chrome — the OpenVibe network's shared navbar, footer, "shipped" views and theme loader for any app.

export interface ChromeLink { label: string; href: string; icon?: string; active?: boolean }
export interface ChromeMenuItem { label: string; href?: string; icon?: string; onClick?: () => void; danger?: boolean; external?: boolean }
export interface ChromeFooterConfig {
    links?: Array<{ heading: string; items: Array<{ name: string; url: string }> }>;
    variant?: 'full' | 'compact';
    /** This app's update log; default: https://openvibe.network/updates?site=<host>. */
    updates?: string;
    mount?: string;
    [key: string]: unknown;
}
export interface ChromeOptions {
    /** Your app's id (brand and analytics). */
    service?: string;
    brand?: { name?: string; sub?: string; tld?: string; icon?: string; variant?: string };
    links?: ChromeLink[];
    menu?: { before?: ChromeMenuItem[]; after?: ChromeMenuItem[] };
    /** Same-origin endpoint answering { user } for your server session. */
    sessionUrl?: string;
    /** Sign-in URL; {url} = full return URL, {path} = its local path. */
    loginUrl?: string;
    /** Sign-out URL, so your server session ends too; {url} / {path} as for loginUrl. */
    logoutUrl?: string;
    silentLogin?: string;
    /** Footer options, or false for no footer. */
    footer?: ChromeFooterConfig | false;
    /** false: no "shipped X ago" line in the footer. */
    shipped?: boolean;
    /** false: do not load the shared theme loader. */
    theme?: boolean;
    /** Where the shared chrome is served (default https://openvibe.network). */
    base?: string;
    /** Extra navbar options passed through to OpenVibeNavbar.init. */
    navbar?: Record<string, unknown>;
    document?: unknown;
    window?: unknown;
}
export interface ChromeConfig { navbar: Record<string, unknown>; footer: Record<string, unknown> | null }
export interface ChromeUrls { theme: string; navbar: string; footer: string; shipped: string }

export const DEFAULT_BASE: string;
export function scriptUrls(opts?: { base?: string }): ChromeUrls;
export function chromeConfig(opts?: ChromeOptions): ChromeConfig;
export function chromeTags(opts?: ChromeOptions): { head: string; bodyStart: string; bodyEnd: string; config: ChromeConfig; urls: ChromeUrls };
export function mountChrome(opts?: ChromeOptions): Promise<{ navbar: unknown | null; footer: unknown | null }>;
