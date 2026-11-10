'use strict';

/** Shared older-page iterator and scroll controller for Chat, Live and the Dock. */
function pages(readPage, { limit = 50, before = null, signal } = {}) {
    if (typeof readPage !== 'function') throw new TypeError('readPage must be a function');
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    return {
        async *[Symbol.asyncIterator]() {
            let cursor = before == null ? null : Number(before);
            while (true) {
                if (signal && signal.aborted) throw signal.reason || new Error('History read aborted');
                const query = { limit: pageSize, ...(cursor == null ? {} : { before: cursor }) };
                const page = await readPage(query, { signal });
                if (!page || !Array.isArray(page.messages)) return;
                yield page;
                if (!page.more || !page.messages.length) return;
                const oldest = Number(page.messages[page.messages.length - 1].id);
                if (!Number.isFinite(oldest) || oldest <= 0 || oldest === cursor) return;
                cursor = oldest;
            }
        },
    };
}

function attach({ feed, status = null, fetchPage, render, hasMore = true, threshold = 600, scrollToBottom = true } = {}) {
    if (!feed || typeof feed.addEventListener !== 'function') throw new TypeError('feed must be a scrollable element');
    if (typeof fetchPage !== 'function' || typeof render !== 'function') throw new TypeError('fetchPage and render are required');
    let more = hasMore !== false;
    let loading = false;
    let disposed = false;
    const state = status || feed.querySelector('[data-history-status]');
    const setStatus = (message) => {
        if (!state) return;
        state.textContent = message;
        state.hidden = !message;
    };
    setStatus(more ? '' : 'The start of the chat');

    async function load() {
        if (disposed || loading || !more) return;
        const first = feed.querySelector('[data-id]');
        if (!first) return;
        loading = true;
        setStatus('Loading earlier messages');
        const cursor = Number(first.dataset.id);
        const anchorTop = first.getBoundingClientRect().top;
        try {
            const page = await fetchPage(cursor);
            if (!page || !Array.isArray(page.messages)) { setStatus(''); return; }
            const anchor = feed.querySelector('[data-id="' + first.dataset.id + '"]');
            // API pages are newest-first; prepend oldest-first to preserve chronological display.
            page.messages.slice().reverse().forEach((message) => {
                if (!message || feed.querySelector('[data-id="' + Number(message.id) + '"]')) return;
                feed.insertBefore(render(message), anchor || (state && state.nextSibling) || feed.firstChild);
            });
            more = !!page.more;
            setStatus(more ? '' : 'The start of the chat');
            if (anchor) feed.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
        } catch {
            setStatus('');
        } finally {
            loading = false;
        }
    }
    const onScroll = () => { if (feed.scrollTop < threshold) load(); };
    feed.addEventListener('scroll', onScroll);
    if (scrollToBottom) feed.scrollTop = feed.scrollHeight;
    return {
        load,
        get loading() { return loading; },
        get more() { return more; },
        dispose() { disposed = true; feed.removeEventListener('scroll', onScroll); },
    };
}

module.exports = { pages, attach };
