'use strict';
/**
 * openvibe-sdk/menu — the cards a site puts in the OpenVibe menu.
 *
 * Every open site may serve an array of frame.menu-card@1 cards at /.well-known/openvibe-menu.json
 * (frame.menu-cards@1); OpenVibe.Network fetches that public file every five minutes and shows the
 * cards in the Frame menu every site shares. Two calls cover a site's side:
 *
 *   const { menuCard, menuRoute } = require('openvibe-sdk/menu');
 *
 *   // 1. Build one validated card. The signature is the card's own fields; `site` and `origin` say
 *   //    which site publishes it and which host its links may use.
 *   const cards = async () => [menuCard({
 *       id: 'new-worlds', site: 'games', title: 'New worlds', kind: 'rows',
 *       origin: 'https://openvibe.games',
 *       items: [{ title: world.title, meta: `by ${world.ownerName}`, url: `https://openvibe.games/worlds/${world.id}` }],
 *       more: { label: 'All worlds', url: 'https://openvibe.games/worlds' },
 *   })];
 *
 *   // 2. Mount the route. Express and a plain node:http handler both work.
 *   app.get('/.well-known/openvibe-menu.json', menuRoute(cards, { maxAgeSeconds: 300 }));
 *
 * menuCard applies the house rules before it validates against frame.menu-card@1: plain text (markup
 * and control characters stripped, whitespace collapsed, cut to the contract's lengths), at most six
 * items (the contract's cap), https URLs on the site's own origin or an openvibe.* host, and an
 * optional item image ({ src, w, h, alt }) with the same host rule. A bad field throws a TypeError
 * that names it. An empty items array is valid: Network skips the card until something is there.
 *
 * menuRoute calls getCards() (it may be async), validates every card, and answers the array with
 * `Cache-Control: public, max-age=<maxAgeSeconds>` and `Access-Control-Allow-Origin: *`. A getCards()
 * failure or an invalid card never becomes a 500: the route answers an empty array (and logs once),
 * so one bad build cannot take the site's file down. A picture from another host is the one thing
 * menuCard drops rather than throws on: the item stays and only its image is left out, as Network
 * itself would drop it.
 *
 * The contract is copied here rather than required: the package has no runtime dependencies. The
 * tests check every shape this module builds against the pinned openvibe-contracts release; when
 * that package is installed, menuRoute also runs it as a second check.
 */

const MENU_PATH = '/.well-known/openvibe-menu.json';
const DEFAULT_MAX_AGE_SECONDS = 300;
const MAX_ITEMS = 6;                 // frame.menu-card@1 items.maxItems
const MAX_CARDS = 3;                 // frame.menu-cards@1 maxItems
const KINDS = ['rail', 'rows', 'chips'];
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** Plain words for a card: no markup, no control characters, one line, cut to the contract's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** The hostname an https origin names, without a leading www. Throws for anything else. */
function hostOf(origin, field = 'origin') {
    let u;
    try { u = new URL(String(origin)); } catch { throw new TypeError(`openvibe-sdk/menu: ${field} must be an https URL, got ${JSON.stringify(origin)}`); }
    if (u.protocol !== 'https:' || u.username || u.password) throw new TypeError(`openvibe-sdk/menu: ${field} must be an https URL with no credentials, got ${JSON.stringify(origin)}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
}

/** The host a link is on, or null when it is not a plain https URL. */
function hostIn(value) {
    try {
        const u = new URL(String(value));
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch { return null; }
}

/**
 * `field` problem for a URL that is not https on `own` (when the site's own host is known) or an
 * openvibe.* host, else null.
 */
function urlProblem(value, field, own) {
    if (typeof value !== 'string' || !value) return `${field}: required`;
    if (value.length > 400) return `${field}: at most 400 characters`;
    const host = hostIn(value);
    if (!host) return `${field}: must be https with no credentials`;
    if (host === own || host.startsWith('openvibe.')) return null;
    return own
        ? `${field}: must be on ${own} or an openvibe.* host, got ${host}`
        : `${field}: must be an openvibe.* host (or pass the site's origin for its own host), got ${host}`;
}

/** The card's own host: `origin`, else the host of `more.url` (the "see all" link is on the site), else null. */
function ownHostOf(options) {
    if (options.origin !== undefined) return hostOf(options.origin);
    if (options.more && typeof options.more === 'object' && options.more.url !== undefined) return hostIn(options.more.url);
    return null;
}

/** One item, built field by field. A bad field throws; a picture on another host is dropped. */
function itemOf(raw, index, own) {
    const field = `items[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`openvibe-sdk/menu: menuCard: ${field} must be an object`);
    const title = plain(raw.title, 80);
    if (!title) throw new TypeError(`openvibe-sdk/menu: menuCard: ${field}.title is required (1-80 plain characters)`);
    const urlField = `${field}.url`;
    const url = raw.url === undefined ? '' : String(raw.url).trim();
    const problem = urlProblem(url, urlField, own);
    if (problem) throw new TypeError(`openvibe-sdk/menu: menuCard: ${problem}`);
    const item = { title, url };
    if (raw.meta !== undefined) item.meta = plain(raw.meta, 120);
    if (raw.image !== undefined) {
        const image = imageOf(raw.image, `${field}.image`, own);
        if (image) item.image = image;
    }
    return item;
}

/** One item image on the item's own host (or an openvibe.* host), or null when its src may not be shown. */
function imageOf(raw, field, own) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`openvibe-sdk/menu: menuCard: ${field} must be an object`);
    const src = raw.src === undefined ? '' : String(raw.src).trim();
    if (urlProblem(src, `${field}.src`, own)) return null;
    const image = { src };
    for (const k of ['w', 'h']) {
        if (raw[k] === undefined) continue;
        const n = Number(raw[k]);
        if (!Number.isInteger(n) || n < 16 || n > 1920) throw new TypeError(`openvibe-sdk/menu: menuCard: ${field}.${k} must be an integer from 16 to 1920`);
        image[k] = n;
    }
    if (raw.alt !== undefined) image.alt = plain(raw.alt, 120);
    return image;
}

/** Contract problems for one card, as "field: reason" strings. Host rules apply when `own` is known. */
function cardProblems(card, own = null) {
    const problems = [];
    if (!card || typeof card !== 'object' || Array.isArray(card)) return ['card must be an object'];
    const extra = Object.keys(card).filter((k) => !['id', 'site', 'title', 'kind', 'items', 'more', 'updated_at', 'ttl_s'].includes(k));
    if (extra.length) problems.push(`unknown field ${extra[0]}`);
    if (typeof card.id !== 'string' || !ID_RE.test(card.id)) problems.push('id must match ^[a-z][a-z0-9-]{1,39}$');
    if (typeof card.site !== 'string' || !ID_RE.test(card.site)) problems.push('site must match ^[a-z][a-z0-9-]{1,39}$');
    if (typeof card.title !== 'string' || card.title.length < 1 || card.title.length > 60) problems.push('title must be 1-60 characters');
    if (!KINDS.includes(card.kind)) problems.push('kind must be rail, rows or chips');
    if (!Array.isArray(card.items) || card.items.length > MAX_ITEMS) problems.push(`items must be an array of at most ${MAX_ITEMS}`);
    else {
        card.items.forEach((item, i) => {
            const f = `items[${i}]`;
            if (!item || typeof item !== 'object' || Array.isArray(item)) { problems.push(`${f} must be an object`); return; }
            const extraItem = Object.keys(item).filter((k) => !['title', 'meta', 'url', 'image'].includes(k));
            if (extraItem.length) problems.push(`${f}.${extraItem[0]} is an unknown field`);
            if (typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 80) problems.push(`${f}.title must be 1-80 characters`);
            if (item.meta !== undefined && (typeof item.meta !== 'string' || item.meta.length > 120)) problems.push(`${f}.meta must be at most 120 characters`);
            if (typeof item.url !== 'string' || item.url.length > 400) problems.push(`${f}.url must be at most 400 characters`);
            else {
                const p = urlProblem(item.url, `${f}.url`, own);
                if (p) problems.push(p);
            }
            if (item.image !== undefined) {
                const f2 = `${f}.image`;
                if (!item.image || typeof item.image !== 'object' || Array.isArray(item.image)) problems.push(`${f2} must be an object`);
                else {
                    const extraImage = Object.keys(item.image).filter((k) => !['src', 'w', 'h', 'alt'].includes(k));
                    if (extraImage.length) problems.push(`${f2}.${extraImage[0]} is an unknown field`);
                    if (typeof item.image.src !== 'string' || item.image.src.length > 400) problems.push(`${f2}.src must be at most 400 characters`);
                    else {
                        const p = urlProblem(item.image.src, `${f2}.src`, own);
                        if (p) problems.push(p);
                    }
                    for (const k of ['w', 'h']) {
                        if (item.image[k] === undefined) continue;
                        const n = item.image[k];
                        if (!Number.isInteger(n) || n < 16 || n > 1920) problems.push(`${f2}.${k} must be an integer from 16 to 1920`);
                    }
                    if (item.image.alt !== undefined && (typeof item.image.alt !== 'string' || item.image.alt.length > 120)) problems.push(`${f2}.alt must be at most 120 characters`);
                }
            }
        });
    }
    if (card.more !== undefined) {
        if (!card.more || typeof card.more !== 'object' || Array.isArray(card.more)) problems.push('more must be an object');
        else {
            const extraMore = Object.keys(card.more).filter((k) => !['label', 'url'].includes(k));
            if (extraMore.length) problems.push(`more.${extraMore[0]} is an unknown field`);
            if (typeof card.more.label !== 'string' || card.more.label.length < 1 || card.more.label.length > 24) problems.push('more.label must be 1-24 characters');
            if (typeof card.more.url !== 'string' || card.more.url.length > 400) problems.push('more.url must be at most 400 characters');
            else {
                const p = urlProblem(card.more.url, 'more.url', own);
                if (p) problems.push(p);
            }
        }
    }
    if (typeof card.updated_at !== 'string' || Number.isNaN(Date.parse(card.updated_at))) problems.push('updated_at must be an ISO date-time');
    if (!Number.isInteger(card.ttl_s) || card.ttl_s < 30 || card.ttl_s > 86400) problems.push('ttl_s must be an integer from 30 to 86400');
    return problems;
}

/** The pinned openvibe-contracts check, when it is installed (and knows this contract); else null. */
let contracts;
function contractProblems(card) {
    if (contracts === undefined) {
        try { contracts = require('openvibe-contracts'); } catch { contracts = null; }
    }
    if (!contracts || typeof contracts.validate !== 'function') return null;
    let result;
    try { result = contracts.validate('frame.menu-card@1', card); } catch { return null; }   // an older pin without the card: the local copy is the check
    if (result.valid) return null;
    return (result.errors || []).map((e) => `${(e.path || '/').replace(/^\//, '')}: ${e.message || 'invalid'}`);
}

/**
 * Build one validated frame.menu-card@1.
 *
 * @param {object} options
 * @param {string} options.id       Card id in the site, e.g. `new-worlds` (^[a-z][a-z0-9-]{1,39}$).
 * @param {string} options.site     The site's Frame id, e.g. `games` (the site Network checks the host against).
 * @param {string} options.title    The card's heading, cut to 60.
 * @param {'rail'|'rows'|'chips'} [options.kind='rows']
 * @param {Array<{title: string, url: string, meta?: string, image?: {src: string, w?: number, h?: number, alt?: string}}>} [options.items]
 * @param {{label: string, url: string}} [options.more]
 * @param {string} [options.origin] The site's https origin, for the own-host rule. When omitted,
 *                                  `more.url`'s host is used; with neither, only openvibe.* links pass.
 * @param {number} [options.ttlSeconds=300] How long the site considers the card fresh (30-86400).
 * @param {string|number|Date} [options.updatedAt=now] When the site last built the card.
 * @returns {object} the card, with no unknown fields, ready for frame.menu-cards@1
 */
function menuCard(options = {}) {
    const o = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    if (typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new TypeError('openvibe-sdk/menu: menuCard: id must match ^[a-z][a-z0-9-]{1,39}$');
    if (typeof o.site !== 'string' || !ID_RE.test(o.site)) throw new TypeError('openvibe-sdk/menu: menuCard: site must match ^[a-z][a-z0-9-]{1,39}$');
    const title = plain(o.title, 60);
    if (!title) throw new TypeError('openvibe-sdk/menu: menuCard: title is required (1-60 plain characters)');
    const kind = o.kind === undefined ? 'rows' : o.kind;
    if (!KINDS.includes(kind)) throw new TypeError(`openvibe-sdk/menu: menuCard: kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
    if (o.items !== undefined && !Array.isArray(o.items)) throw new TypeError('openvibe-sdk/menu: menuCard: items must be an array');
    const own = ownHostOf(o);
    const items = (o.items || []).slice(0, MAX_ITEMS).map((item, i) => itemOf(item, i, own));
    const card = { id: o.id, site: o.site, title, kind, items };
    if (o.more !== undefined) {
        if (!o.more || typeof o.more !== 'object' || Array.isArray(o.more)) throw new TypeError('openvibe-sdk/menu: menuCard: more must be an object');
        const label = plain(o.more.label, 24);
        if (!label) throw new TypeError('openvibe-sdk/menu: menuCard: more.label is required (1-24 plain characters)');
        const url = o.more.url === undefined ? '' : String(o.more.url).trim();
        const problem = urlProblem(url, 'more.url', own);
        if (problem) throw new TypeError(`openvibe-sdk/menu: menuCard: ${problem}`);
        card.more = { label, url };
    }
    const at = o.updatedAt === undefined ? new Date() : new Date(o.updatedAt);
    if (Number.isNaN(at.getTime())) throw new TypeError('openvibe-sdk/menu: menuCard: updatedAt must be a date');
    card.updated_at = at.toISOString();
    const ttl = o.ttlSeconds === undefined ? DEFAULT_MAX_AGE_SECONDS : Number(o.ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400) throw new TypeError('openvibe-sdk/menu: menuCard: ttlSeconds must be an integer from 30 to 86400');
    card.ttl_s = ttl;
    const problems = cardProblems(card, own);
    if (problems.length) throw new TypeError(`openvibe-sdk/menu: menuCard: ${problems[0]}`);
    const byContract = contractProblems(card);
    if (byContract && byContract.length) throw new TypeError(`openvibe-sdk/menu: menuCard: ${byContract[0]}`);
    return card;
}

/** A logger that counts a getCards failure/invalid card once: the route never logs a flood. */
function onceLogger(log) {
    let logged = false;
    return (err) => {
        if (logged) return;
        logged = true;
        const target = log && typeof log.error === 'function' ? log : console;
        target.error('openvibe-sdk/menu: menu cards unavailable; answering []', err && err.message ? err.message : err);
    };
}

/**
 * The GET /.well-known/openvibe-menu.json handler, for Express (res.set/res.json) or node:http
 * (res.writeHead/res.end). It answers true when it handled the request, false for another path.
 *
 * @param {() => object | Array<object> | Promise<object | Array<object>>} getCards
 * @param {{maxAgeSeconds?: number, log?: {error: Function}, origin?: string}} [options]
 */
function menuRoute(getCards, options = {}) {
    const o = options && typeof options === 'object' ? options : {};
    if (typeof getCards !== 'function') throw new TypeError('openvibe-sdk/menu: menuRoute needs a getCards() function');
    const maxAge = o.maxAgeSeconds === undefined ? DEFAULT_MAX_AGE_SECONDS : Number(o.maxAgeSeconds);
    if (!Number.isInteger(maxAge) || maxAge < 0) throw new TypeError('openvibe-sdk/menu: menuRoute: maxAgeSeconds must be a non-negative integer');
    const own = o.origin === undefined ? null : hostOf(o.origin);
    const logOnce = onceLogger(o.log);

    function send(res, status, body, headers) {
        if (res && typeof res.set === 'function' && typeof res.json === 'function') {
            if (typeof res.status === 'function') res.status(status); else if (status !== 200) res.statusCode = status;
            for (const [k, v] of Object.entries(headers)) res.set(k, v);
            return res.json(body);
        }
        if (res && typeof res.writeHead === 'function') {
            res.writeHead(status, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));
            return res.end(status === 204 || body === undefined ? undefined : JSON.stringify(body));
        }
        throw new TypeError('openvibe-sdk/menu: menuRoute: no Express or node:http response object');
    }

    return async function menuHandler(req, res) {
        const url = req && req.url ? String(req.url).split('?')[0] : '';
        if (url && url !== MENU_PATH && url !== '/') return false;
        const method = req && req.method ? String(req.method).toUpperCase() : 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
            send(res, 405, { error: 'method_not_allowed' }, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' });
            return true;
        }
        const head = method === 'HEAD';
        let cards;
        try {
            let value = await getCards();
            if (value && typeof value === 'object' && !Array.isArray(value)) value = [value];   // one card is a one-card file
            if (!Array.isArray(value)) throw new TypeError('getCards() must return an array of cards (or one card)');
            cards = [];
            for (const card of value.slice(0, MAX_CARDS)) {
                const problems = cardProblems(card, own);
                if (problems.length) { logOnce(new Error(problems[0])); continue; }
                const byContract = contractProblems(card);
                if (byContract && byContract.length) { logOnce(new Error(byContract[0])); continue; }
                cards.push(card);
            }
        } catch (err) {
            logOnce(err);
            send(res, 200, [], {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
                'Cross-Origin-Resource-Policy': 'cross-origin',
            });
            return true;
        }
        const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${maxAge}`,
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
        };
        if (head) {
            if (res && typeof res.set === 'function' && typeof res.json === 'function') {
                if (typeof res.status === 'function') res.status(200);
                for (const [k, v] of Object.entries(headers)) res.set(k, v);
                res.end();
            } else {
                res.writeHead(200, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));
                res.end();
            }
            return true;
        }
        send(res, 200, cards, headers);
        return true;
    };
}

module.exports = { menuCard, menuRoute, MENU_PATH };
