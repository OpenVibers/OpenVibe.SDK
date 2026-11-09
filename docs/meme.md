# Meme client

`openvibe-sdk/meme` exposes the public OpenVibe.Meme API. It works in Node and browsers; public reads do not need a token, while render writes use the token from the core client.

```js
const ov = require('openvibe-sdk');
const client = ov.createClient();
const meme = ov.meme.createMemeClient(client);

const { entries } = await meme.search({ scope: 'internet', q: 'Distracted Boyfriend' });
const entry = await meme.get(entries[0].slug); // entry() is the same read
const { templates } = await meme.templates();
const rendered = await meme.render({
  template_id: templates[0].id,
  lines: ['new format', 'same old bug'],
  format: 'png',
  editor: { font_style: 'impact', font_size: 30, crop_x: 50, crop_y: 50 },
});
// rendered.bytes is an ArrayBuffer; rendered.contentType is image/png.
```

`search(query)` accepts the same scope, text, kind, label, status, sort and usage-window filters as the HTTP API. `get(slug)` (or its older name, `entry(slug)`) reads one entry. `templates()` returns the reusable formats and their source/licence details. `render(input)` accepts one to four lines (up to 120 characters each), `png`, `gif` or `mp4`, and optional editor state; it returns `{ bytes, contentType }` without decoding the response as JSON. A render is a signed-in write and can fail with the API's problem response for an unavailable template, rejected caption, or missing sign-in.
