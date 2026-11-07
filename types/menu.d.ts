// openvibe-sdk/menu — the cards a site publishes to the OpenVibe menu (frame.menu-card@1).

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The public file every open site serves: an array of at most three cards. */
export declare const MENU_PATH: '/.well-known/openvibe-menu.json';

export type MenuCardKind = 'rail' | 'rows' | 'chips';

/** A small picture of an item: the site's own host or an openvibe.* host, https only. */
export interface MenuCardImage {
    /** The picture's https address, at most 400 characters. */
    src: string;
    /** Natural width, 16-1920. */
    w?: number;
    /** Natural height, 16-1920. */
    h?: number;
    /** A short description, at most 120 characters. */
    alt?: string;
}

export interface MenuCardItem {
    /** Plain words, 1-80 characters after markup and control characters are stripped. */
    title: string;
    /** One short line, at most 120 characters ("12 watching"). */
    meta?: string;
    /** https on the site's own origin or an openvibe.* host, at most 400 characters. */
    url: string;
    /** Optional; a picture from another host is dropped and the item is kept. */
    image?: MenuCardImage;
}

export interface MenuCardMore {
    /** The link's words, 1-24 characters. */
    label: string;
    /** https on the site's own origin or an openvibe.* host. */
    url: string;
}

export interface MenuCardOptions {
    /** Stable card id in the site: ^[a-z][a-z0-9-]{1,39}$ (new-worlds, trending). */
    id: string;
    /** The site's Frame id: ^[a-z][a-z0-9-]{1,39}$ (live, games, media-hub). */
    site: string;
    /** The heading, cut to 60 plain characters. */
    title: string;
    /** Default `rows`. */
    kind?: MenuCardKind;
    /** At most six (the contract's cap); an empty list is valid and Network skips the card. */
    items?: MenuCardItem[];
    more?: MenuCardMore;
    /**
     * The site's https origin, for the own-host rule. When omitted, the host of `more.url` is used;
     * with neither, only `openvibe.*` links pass.
     */
    origin?: string;
    /** How long the site considers the card fresh, 30-86400 seconds. Default 300. */
    ttlSeconds?: number;
    /** When the site last built the card. Default now. */
    updatedAt?: string | number | Date;
}

/** A frame.menu-card@1, with no unknown fields. */
export interface MenuCard {
    id: string;
    site: string;
    title: string;
    kind: MenuCardKind;
    items: MenuCardItem[];
    more?: MenuCardMore;
    updated_at: string;
    ttl_s: number;
}

export type MenuLogger = Pick<Console, 'error'>;

export interface MenuRouteOptions {
    /** The response's `Cache-Control: public, max-age=…`. Default 300 seconds. */
    maxAgeSeconds?: number;
    /** Where a getCards() failure is reported, once. Default console. */
    log?: MenuLogger;
    /** When set, every card's links must also be on this https origin or an openvibe.* host. */
    origin?: string;
}

/** Express's response shape and node:http's, both accepted by the handler. */
export type MenuRequest = IncomingMessage & { url?: string; method?: string };
export type MenuResponse = ServerResponse & {
    status?: (code: number) => MenuResponse;
    set?: (name: string, value: string) => MenuResponse;
    json?: (body: unknown) => unknown;
    [key: string]: unknown;
};

/** The handler answers true when it handled the request, false for another path. */
export type MenuHandler = (req: MenuRequest, res: MenuResponse) => Promise<boolean>;

/**
 * Build one validated frame.menu-card@1: text stripped and cut, at most six items, https links on
 * the site's own origin or an openvibe.* host. Throws a TypeError naming the bad field.
 */
export declare function menuCard(options: MenuCardOptions): MenuCard;

/**
 * The GET /.well-known/openvibe-menu.json handler, for Express or node:http. It calls getCards(),
 * validates the cards and answers them with a public cache and CORS *; a failure or an invalid card
 * answers [] (never a 500) and is logged once.
 */
export declare function menuRoute(getCards: () => MenuCard | MenuCard[] | Promise<MenuCard | MenuCard[]>, options?: MenuRouteOptions): MenuHandler;
