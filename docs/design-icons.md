# Design icon client

Use the Design client with a signed-in access token to find glyphs, request a style family, or fetch a drawing:

```js
const { createDesignClient } = require('openvibe-sdk/design');
const design = createDesignClient({ accessToken });

const matches = await design.icons.search('hot tub');
const draft = await design.icons.draft({
    name: 'hot-tub',
    sentence: 'A rental tub with steam over it',
    styles: ['thin', 'light', 'regular', 'bold', 'solid', 'duotone'],
});
const glyph = await design.icons.get('hot-tub', { style: 'duotone' });
```

For a solid twin, pass the existing line drawing as `sourceSvg` and request `styles: ['solid']`. The server sanitizes and
fits both drawings before saving them for review. Drafts stay private until an administrator approves them.

## The glyph as a file

`icons.export` fetches the drawing with the PNG maker's choices — the SVG text, or the PNG bytes. It is public: no
token is needed.

```js
const svg = await design.icons.export({ glyph: 'heart', ground: 'square', rounding: 'round' });
const png = await design.icons.export({ glyph: 'heart', ground: 'square', rounding: 'squircle', format: 'png' });
// png.bytes is an ArrayBuffer, png.contentType is 'image/png'
```

- **`ground`** picks the shape: `none`, `circle`, `square` or `squircle`.
- **`rounding`** picks the corner of that square: `none`, `soft` (a 12 % corner), `round` (the app icon's corner) or
  `squircle` (a superellipse). A circle has no corner and ignores it.
- The other choices are the maker's own: `size`, `scale`, `color`, `stroke`, `pad`, `bg`, `fx` and `style`.

A name that is not one of the four corners (or a ground that is not one of the four shapes) is refused before the
request goes out, and the server refuses it too, with a plain message.
