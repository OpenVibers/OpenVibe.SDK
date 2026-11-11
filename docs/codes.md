# Codes model plans

`openvibe-sdk/codes` uses a person's Network token for coding tasks and model plans.

```js
const { createClient } = require('openvibe-sdk/core');
const { createCodesClient } = require('openvibe-sdk/codes');
const codes = createCodesClient(createClient({ tokenProvider }));

const { presets } = await codes.modelPlans.presets();
const saved = await codes.modelPlans.put(presets.Balanced); // account default
const project = await codes.modelPlans.get({ project: 'prj_...' });
await codes.tasks.create({ text: 'Fix the parser', mode: 'repo', repo: 'owner/repo', preset: 'Deep' });
await codes.tasks.create({ text: 'Fix the parser', mode: 'repo', repo: 'owner/repo', plan: saved.resolved });
```

Pass `{ project }` to `modelPlans.put(plan, { project })` to save a project default. A task accepts either `plan` or `preset`. The service checks models against AI's registry and returns resolved choices and fallback reasons when a plan is saved.
