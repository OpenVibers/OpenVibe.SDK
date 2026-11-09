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
