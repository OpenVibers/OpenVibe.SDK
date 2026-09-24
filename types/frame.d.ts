// openvibe-sdk/frame — the OpenVibe network's the OpenVibe Frame (the shared navbar, footer, "shipped" views and theme loader) for any app.

export interface FrameLink { label: string; href: string; icon?: string; active?: boolean }
export interface FrameMenuItem { label: string; href?: string; icon?: string; onClick?: () => void; danger?: boolean; external?: boolean }
export interface FrameFooterConfig {
    links?: Array<{ heading: string; items: Array<{ name: string; url: string }> }>;
    variant?: 'full' | 'compact';
    /** This app's update log; default: https://openvibe.network/updates?site=<host>. */
    updates?: string;
    mount?: string;
    [key: string]: unknown;
}
export interface FrameOptions {
    /** Your app's id (brand and analytics). */
    service?: string;
    brand?: { name?: string; sub?: string; tld?: string; icon?: string; variant?: string };
    links?: FrameLink[];
    menu?: { before?: FrameMenuItem[]; after?: FrameMenuItem[] };
    /** Same-origin endpoint answering { user } for your server session. */
    sessionUrl?: string;
    /** Sign-in URL; {url} = full return URL, {path} = its local path. */
    loginUrl?: string;
    /** Sign-out URL, so your server session ends too; {url} / {path} as for loginUrl. */
    logoutUrl?: string;
    silentLogin?: string;
    /** Footer options, or false for no footer. */
    footer?: FrameFooterConfig | false;
    /** false: no "shipped X ago" line in the footer. */
    shipped?: boolean;
    /** false: do not load the shared theme loader. */
    theme?: boolean;
    /** Where the Frame is served (default https://openvibe.network). */
    base?: string;
    /** Extra navbar options passed through to OpenVibeNavbar.init. */
    navbar?: Record<string, unknown>;
    document?: unknown;
    window?: unknown;
}
export interface FrameConfig { navbar: Record<string, unknown>; footer: Record<string, unknown> | null }
export interface FrameUrls { theme: string; navbar: string; footer: string; shipped: string }

export const DEFAULT_BASE: string;
export function scriptUrls(opts?: { base?: string }): FrameUrls;
export function frameConfig(opts?: FrameOptions): FrameConfig;
export function frameTags(opts?: FrameOptions): { head: string; bodyStart: string; bodyEnd: string; config: FrameConfig; urls: FrameUrls };
export function mountFrame(opts?: FrameOptions): Promise<{ navbar: unknown | null; footer: unknown | null }>;
