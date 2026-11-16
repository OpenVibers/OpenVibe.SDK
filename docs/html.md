# openvibe-sdk/html

Escaping, the `html` template, the small parts of a server-drawn page, and a safe Markdown renderer. Node only.

Before 0.175.0 these were copied into each site:
- `server/render/html.js` in 25 sites;
- `server/render/markdown.js` in 10.

Each copy had drifted with a fix of its own. This module carries all of them.

```js
const { html, raw, esc, table, problemBox, notice, badge, csrfField, time, code, markdown } = require('openvibe-sdk/html');

html`<p>Hello ${name}</p>`             // every hole is escaped, unless it is raw() or another html`` result
html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`   // arrays are joined; null, undefined and false draw nothing
table(['Name', 'Size'], rows)           // a focusable, named scroll region; each cell carries its column's name
problemBox(problem)                     // a problem from Network, Events or Media, shown as it came
markdown(text)                          // text a person or a model wrote
markdown(adr, { trusted: true })        // text the service ships: plain links
```

## The page parts

| Part | Draws |
|---|---|
| `esc(s)` | Text safe in an element or an attribute: `& < > " '` |
| `html` / `raw` / `render` / `Raw` | The template; `Raw` is markup already safe |
| `code(s)` | `<code>` |
| `time(iso)` | `<time datetime>` read as `2026-11-16 10:00:00 UTC`, or `—` |
| `table(headers, rows, { cls, empty })` | A table in `<div class="table-wrap" tabindex="0" role="region" aria-label="Table: …">`. Cells carry `data-label`, so a phone can show rows as cards. With no rows, the `empty` line. |
| `problemBox(p, { title })` | `role="alert"`: the detail, then the status, code and request id |
| `notice(text, kind)` | `role="status"` |
| `csrfField(token)` | The hidden `csrf` input |
| `badge(text, kind)` | `<span class="badge kind">` |

## Markdown

- **What it reads:** headings, paragraphs, `-` / `*` / `1.` lists (an indented line continues an item), fenced
  code, pipe tables, `**bold**`, `*italics*`, `` `code` ``, `[links](…)` and bare `https://` links.
- **Headings** move down by `headingOffset` (default 1), so a page keeps its own `<h1>`.
- **Safety:** everything is escaped before any mark is read. A link is kept only when it is http(s) or relative.
  - An http(s) link carries `rel="nofollow ugc noopener"` and opens a new tab: the text may be a person's or a model's.
  - `{ trusted: true }` is for text the service ships itself (ADRs, its own docs), whose links are plain.
- **Tables:**
  - a header row whose cell count matches the delimiter row under it;
  - `\|` is a pipe inside a cell;
  - at most 64 columns and 1,000 rows, read without a backtracking pattern, so a hostile table costs little;
  - drawn in the same named, focusable region as `table()`.
- **Code blocks** are `<pre tabindex="0">`, so a keyboard can scroll them.
- **No empty bullets:** a bare marker (`-`, `1.`), as a model sometimes ends, draws nothing.

## Moving a site to it

A site's copy becomes one line, plus whatever is its own:

```js
// server/render/html.js
module.exports = require('openvibe-sdk/html');

// server/render/markdown.js
const { markdown } = require('openvibe-sdk/html');
module.exports = { markdown };

// A site with an extra part keeps it beside the shared ones:
const kit = require('openvibe-sdk/html');
const dayText = (iso) => …;
module.exports = { ...kit, dayText, time: (iso) => … };
```

The table's region attributes are the one visible change for most sites: before, only Codes had them.
