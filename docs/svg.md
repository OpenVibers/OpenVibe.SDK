# openvibe-sdk/svg

An SVG cleaned before it is shown or saved, and SVG path data read (0.176.0). It was OpenVibe.Design's
`server/vectors/svg.js` (AI drawings, item art) and `server/typefaces/path.js`. Every service that takes an SVG now
cleans it the same way: Design's drawings, Media and Pics uploads, Inventory's item art.

```js
const { sanitize, path } = require('openvibe-sdk/svg');

const r = sanitize(modelOutput);
if (!r.ok) return res.status(422).json({ error: r.why });
save(r.svg);   // rebuilt from the allowlist: nothing the input wrote is passed through
```

## sanitize(markup) → `{ ok: true, svg }` | `{ ok: false, why }`

The drawing is rebuilt from scratch out of what a drawing may contain.

**What may stay:**

- the shape elements (`svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`), and the
  gradients and clip paths that point at a local `#id`;
- each element's look: fill, stroke, opacity, transforms and the like;
- one `viewBox`.

**What is refused** (the whole drawing, never half of it):

- script, style, foreignObject, animate, set, use, image, `a` and every other element;
- event handlers;
- any `href`, external reference, or `url()` that is not a local `#id`;
- entity declarations, CDATA, doctypes and processing instructions;
- markup that is not well-formed;
- anything over `MAX_BYTES` (200 KB).

## path

`path.parse(d)` → `{ ok: true, segments }` | `{ ok: false, why }`. It returns absolute commands only (`M L C Q Z`):
relative commands are made absolute and arcs become cubic curves.

The rest:

- `path.bbox(segments)`: the true bounds, curves included;
- `path.closed(segments)`;
- `path.subpaths(segments)`;
- `path.toData(segments)`: normalised path data (absolute, two decimals).
