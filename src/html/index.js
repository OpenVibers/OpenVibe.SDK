'use strict';
/**
 * openvibe-sdk/html (0.175.0): escaping, the html`` template and the small parts of a server-drawn page, plus a small
 * safe Markdown renderer. They were copied into 25 sites as server/render/html.js and into 10 as
 * server/render/markdown.js (consolidation review, 2026-11-16: "look for duplicate shit … consolidate"); each copy had
 * drifted with its own fix. This one carries every fix:
 * - Codes' table is a focusable, named scroll region (axe scrollable-region-focusable), for every site;
 * - Markdown merges Food's (a model's links carry rel="nofollow ugc noopener" and open in a new tab, bare links,
 *   italics), Codes' (pipe tables with escaped \| cells, read without a backtracking pattern, capped at 64 columns and
 *   1000 rows), Actor's (no empty bullet from a model that ends on a bare marker) and Zone's (code blocks a keyboard
 *   reaches).
 *
 *   const { html, raw, esc, table, markdown } = require('openvibe-sdk/html');
 *   html`<p>${name}</p>`                 // escaped unless raw(); arrays joined; null and false draw nothing
 *   markdown(text)                        // text a person or a model wrote: escaped first, links never vouched for
 *   markdown(adr, { trusted: true })      // text this service ships (ADRs, docs): plain links
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tagged template: interpolations are escaped unless wrapped in raw(). Arrays are joined. */
class Raw { constructor(s) { this.s = String(s); } toString() { return this.s; } }
const raw = (s) => new Raw(s);
function html(strings, ...values) {
    let out = strings[0];
    values.forEach((v, i) => {
        out += render(v) + strings[i + 1];
    });
    return raw(out);
}
function render(v) {
    if (v == null || v === false) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    return esc(v);
}

const code = (s) => html`<code>${s}</code>`;
const time = (iso) => (iso ? html`<time datetime="${iso}">${String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}</time>` : '—');

/**
 * A <table> from headers and rows of cells (cells are already html or plain values). Each cell names its column
 * (data-label), so on a phone a wide table can show each row as a card (the site's stylesheet). The wrapper scrolls
 * sideways on a phone, so it is a focusable, named region.
 */
function table(headers, rows, { cls = '', empty = 'Nothing here yet.' } = {}) {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    const named = headers.map((h) => (typeof h === 'string' ? h : (h instanceof Raw ? h.s.replace(/<[^>]*>/g, '') : ''))).filter(Boolean).join(', ');
    return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Table: ${named}"><table class="${cls}"><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (typeof headers[i] === 'string' && headers[i] ? html`<td data-label="${headers[i]}">${c}</td>` : html`<td>${c}</td>`))}</tr>`)}</tbody></table></div>`;
}

/** A problem as returned by Network, Events or Media, shown as it came, never softened. */
function problemBox(p, { title = 'The request failed' } = {}) {
    if (!p) return '';
    return html`<div class="problem" role="alert"><strong>${title}</strong>
<p>${p.detail || 'No detail was given.'}</p>
<p class="muted small">HTTP ${p.status || '—'} · <code>${p.code || 'unknown'}</code>${p.requestId ? html` · request <code>${p.requestId}</code>` : ''}</p></div>`;
}

const notice = (text, kind = 'info') => html`<div class="notice ${kind}" role="status">${text}</div>`;
const csrfField = (token) => html`<input type="hidden" name="csrf" value="${token}">`;
const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_COLUMNS = 64;
const MAX_ROWS = 1000;

/** A line's inline marks: code, bold, italics and links, all after escaping. */
function inline(s, { trusted = false } = {}) {
    const away = trusted ? '' : ' rel="nofollow ugc noopener" target="_blank"';
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
        const h = href.replace(/&amp;/g, '&');
        if (/^https?:\/\//.test(h)) return `<a href="${esc(h)}"${away}>${text}</a>`;
        if (/^[#./a-zA-Z0-9]/.test(h) && !/^[a-z]+:/i.test(h)) return `<a href="${esc(h)}">${text}</a>`;
        return text;
    });
    // Bare links written out, outside an <a> already made above.
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+[^\s<)"'.,;:!?])/g, (m, pre, url) => `${pre}<a href="${url}"${away}>${url}</a>`);
    return out;
}

/** A table row's cells: split on pipes not escaped as \|, one optional outer pipe on each side. */
function cells(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    const out = [];
    let cur = '';
    for (let k = 0; k < t.length; k++) {
        if (t[k] === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
        if (t[k] === '|') { out.push(cur.trim()); cur = ''; continue; }
        cur += t[k];
    }
    out.push(cur.trim());
    return out;
}

/** Whether a line is a table's delimiter row (| --- | :-: |), checked without a backtracking pattern. */
const isDelimiter = (line) => !!line && line.includes('|') && /^[\s|:-]+$/.test(line) && cells(line).every((c) => /^:?-+:?$/.test(c));

/**
 * Markdown to HTML: headings (moved down by headingOffset, so a page keeps its own h1), paragraphs, lists, fenced
 * code, pipe tables, bold, italics, inline code and links. Everything is escaped first; links are kept only when
 * http(s) or relative, and an http(s) link is never vouched for unless the text is the service's own ({ trusted }).
 */
function markdown(src, { headingOffset = 1, trusted = false } = {}) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const mark = (s) => inline(s, { trusted });
    const out = [];
    let para = [];
    let list = null;   // { type: 'ul' | 'ol', items: [] }
    let fence = null;
    const pre = (body) => `<pre tabindex="0"><code>${esc(body.join('\n'))}</code></pre>`;
    const flushPara = () => { if (para.length) { out.push(`<p>${mark(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list && list.items.length) out.push(`<${list.type}>${list.items.map((i) => `<li>${mark(i)}</li>`).join('')}</${list.type}>`); list = null; };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fence) {
            if (/^```/.test(line)) { out.push(pre(fence)); fence = null; } else fence.push(line);
            continue;
        }
        if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
        // A pipe table: a header row whose cells match the delimiter row under it, then rows while lines hold a pipe.
        if (line.includes('|') && isDelimiter(lines[i + 1]) && cells(line).length === cells(lines[i + 1]).length && cells(line).length <= MAX_COLUMNS) {
            flushPara(); flushList();
            const head = cells(line);
            const rows = [];
            for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|') && rows.length < MAX_ROWS; i++) rows.push(cells(lines[i]));
            i--;
            out.push(`<div class="table-wrap" tabindex="0" role="region" aria-label="Table: ${esc(head.join(', '))}"><table><thead><tr>${head.map((h) => `<th scope="col">${mark(h)}</th>`).join('')}</tr></thead>`
                + `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${mark(r[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            flushPara(); flushList();
            const level = Math.min(6, h[1].length + headingOffset);
            out.push(`<h${level}>${mark(h[2])}</h${level}>`);
            continue;
        }
        // A model that ends on a bare marker ("-" or "1.") or an empty item ("- ") would leave an empty bullet.
        if (/^\s*(?:[-*]|\d+\.)\s*$/.test(line)) continue;
        const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)$/);
        if (li) {
            flushPara();
            if (!li[2].trim()) continue;
            const type = li[1] ? 'ol' : 'ul';
            if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
            list.items.push(li[2]);
            continue;
        }
        if (!line.trim()) { flushPara(); flushList(); continue; }
        if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
        flushList();
        para.push(line.trim());
    }
    if (fence) out.push(pre(fence));
    flushPara(); flushList();
    return out.join('\n');
}

module.exports = { esc, html, raw, Raw, render, code, time, table, problemBox, notice, csrfField, badge, markdown, inline, MAX_COLUMNS, MAX_ROWS };
