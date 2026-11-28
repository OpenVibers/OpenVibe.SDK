'use strict';
// openvibe-sdk/html (0.175.0): the html helpers 25 sites copied and the Markdown renderer 10 copied, with every copy's
// fix (consolidation review, 2026-11-16).
const assert = require('assert');
const h = require('../src/html');
const { html, raw, esc, render, table, problemBox, notice, csrfField, badge, time, code, markdown } = h;

// Escaping and the template.
assert.strictEqual(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
assert.strictEqual(esc(null), '');
assert.strictEqual(String(html`<p>${'<b>'}</p>`), '<p>&lt;b&gt;</p>');
assert.strictEqual(String(html`<p>${raw('<b>ok</b>')}</p>`), '<p><b>ok</b></p>');
assert.strictEqual(String(html`<ul>${['a', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>b</li></ul>');
assert.strictEqual(render(null) + render(false) + render(undefined), '');
assert.ok(html`x` instanceof h.Raw);
assert.strictEqual(String(code('a<b')), '<code>a&lt;b</code>');
assert.strictEqual(String(time('2026-11-16T10:00:00.123Z')), '<time datetime="2026-11-16T10:00:00.123Z" data-ov-time="datetime">2026-11-16 10:00:00 UTC</time>');
// The reader's own zone (Shared's theme loader rewrites data-ov-time); a kind of its own; an unknown kind is datetime.
assert.strictEqual(String(time('2026-11-16T10:00Z', 'day')), '<time datetime="2026-11-16T10:00Z" data-ov-time="day">2026-11-16 10:00 UTC</time>');
assert.strictEqual(String(time('2026-11-16T10:00:00Z', 'nonsense')), '<time datetime="2026-11-16T10:00:00Z" data-ov-time="datetime">2026-11-16 10:00:00 UTC</time>');
// Not a full instant (no zone): no data-ov-time, since a browser would read it in its own zone and move it.
assert.strictEqual(String(time('2026-11-16 10:00:00')), '<time datetime="2026-11-16 10:00:00">2026-11-16 10:00:00</time>');
assert.strictEqual(time(null), '—');

// The table: a focusable, named region (Codes' fix, now every site's); cells name their columns.
const t = String(table(['Name', raw('<i>Size</i>')], [['a.txt', '3 KB']]));
assert.match(t, /^<div class="table-wrap" tabindex="0" role="region" aria-label="Table: Name, Size">/);
assert.match(t, /<td data-label="Name">a\.txt<\/td><td>3 KB<\/td>/);
assert.strictEqual(String(table(['A'], [], { empty: 'No files.' })), '<p class="muted">No files.</p>');

assert.strictEqual(problemBox(null), '');
assert.match(String(problemBox({ status: 403, code: 'capability.denied', detail: 'Not yours', requestId: 'req_1' })), /HTTP 403 · <code>capability\.denied<\/code> · request <code>req_1<\/code>/);
assert.strictEqual(String(notice('Saved')), '<div class="notice info" role="status">Saved</div>');
assert.strictEqual(String(csrfField('t"k')), '<input type="hidden" name="csrf" value="t&quot;k">');
assert.strictEqual(String(badge('live', 'ok')), '<span class="badge ok">live</span>');

// Markdown: everything escaped first.
assert.strictEqual(markdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
assert.strictEqual(markdown('# Title'), '<h2>Title</h2>');
assert.strictEqual(markdown('# Title', { headingOffset: 2 }), '<h3>Title</h3>');
assert.strictEqual(markdown('**bold** and *soft* and `code`'), '<p><strong>bold</strong> and <em>soft</em> and <code>code</code></p>');
// Food's: a link a person or a model wrote is never vouched for; bare links too; other schemes are dropped.
assert.strictEqual(markdown('[site](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2" rel="nofollow ugc noopener" target="_blank">site</a></p>');
assert.strictEqual(markdown('see https://example.com/x.'), '<p>see <a href="https://example.com/x" rel="nofollow ugc noopener" target="_blank">https://example.com/x</a>.</p>');
assert.strictEqual(markdown('[x](javascript:void)'), '<p>x</p>', 'another scheme: the words, no link');
assert.strictEqual(markdown('[docs](/docs/whip)'), '<p><a href="/docs/whip">docs</a></p>');
// Codes': the service's own text links plainly.
assert.strictEqual(markdown('[ADR](https://openvibe.network/adr/7)', { trusted: true }), '<p><a href="https://openvibe.network/adr/7">ADR</a></p>');
// Codes': pipe tables with escaped pipes, read without a backtracking pattern, in a named region.
const tbl = markdown('| Op | Means |\n| --- | :-: |\n| `a\\|b` | either |\n| x | y |');
assert.match(tbl, /^<div class="table-wrap" tabindex="0" role="region" aria-label="Table: Op, Means"><table>/);
assert.match(tbl, /<td><code>a\|b<\/code><\/td><td>either<\/td>/);
assert.strictEqual((tbl.match(/<tr>/g) || []).length, 3, 'a head row and two rows');
assert.strictEqual(markdown('a | b\nnot a delimiter'), '<p>a | b not a delimiter</p>');
const wide = `${Array.from({ length: 65 }, (_, k) => `c${k}`).join(' | ')}\n${Array.from({ length: 65 }, () => '---').join(' | ')}`;
assert.ok(!markdown(wide).includes('<table>'), 'more than 64 columns is no table');
const started = Date.now();
markdown(`| a |\n|${'-'.repeat(20000)}|${' '.repeat(20000)}x`);
assert.ok(Date.now() - started < 500, 'a hostile delimiter row costs nothing');
// Actor's: a model that ends on a bare marker leaves no empty bullet.
assert.strictEqual(markdown('- one\n- two\n-'), '<ul><li>one</li><li>two</li></ul>');
assert.strictEqual(markdown('1.\n'), '');
// Zone's: a code block a keyboard reaches.
assert.strictEqual(markdown('```\nlet a = "<x>";\n```'), '<pre tabindex="0"><code>let a = &quot;&lt;x&gt;&quot;;</code></pre>');
assert.strictEqual(markdown('```\nunclosed'), '<pre tabindex="0"><code>unclosed</code></pre>');
// Lists, continuation lines and paragraphs.
assert.strictEqual(markdown('1. first\n   more\n2. second\n\nafter'), '<ol><li>first more</li><li>second</li></ol>\n<p>after</p>');
console.log('html: the template, the page parts and Markdown, with every copy\'s fixes');
