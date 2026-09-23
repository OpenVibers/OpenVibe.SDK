'use strict';
/**
 * Cursor pagination as an async iterator.
 *
 *   for await (const item of paginate((cursor) => fetchPage(cursor), { cursor: 0 })) { … }
 *
 * `fetchPage(cursor)` returns { items, next }; iteration stops when `next` is null/undefined or
 * does not move. Offset APIs use `offsetPager()` to produce the same shape.
 */

async function* paginate(fetchPage, { cursor, maxPages = Infinity, maxItems = Infinity } = {}) {
    let c = cursor;
    let pages = 0;
    let items = 0;
    while (pages < maxPages) {
        pages++;
        const page = await fetchPage(c);
        for (const item of (page && page.items) || []) {
            if (items >= maxItems) return;
            items++;
            yield item;
        }
        if (!page || page.next == null || page.next === c) return;
        c = page.next;
    }
}

/**
 * For limit/offset endpoints: wraps `load(offset, limit)` -> { items, total? } into a fetchPage.
 * Stops on a short page, or when `total` is known and reached.
 */
function offsetPager(load, { limit = 50 } = {}) {
    return async (offset = 0) => {
        const { items, total } = await load(offset, limit);
        const end = offset + items.length;
        const more = items.length === limit && (typeof total !== 'number' || end < total);
        return { items, next: more ? end : null };
    };
}

module.exports = { paginate, offsetPager };
