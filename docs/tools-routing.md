# Tools worker placement

```js
const run = await tools.run('png', {}, { files: [fileBlob], prefer: 'host' });
const done = await run.wait();
const job = await tools.jobs.get(done.job.id);
console.log(job.result.data.execution);
```

`prefer` is `auto` (default), `home`, or `host`, sent as `X-Tools-Prefer` for JSON and multipart requests. `host` keeps the job on the host. `home` is advisory: the owner's routing order still applies. Fetch-based jobs always stay on the host, and the owner must enable worker routing.

Durable job results carry `result.data.execution`: the final worker id, location, total execution milliseconds and each attempt's location, time and outcome. Failed or cancelled jobs carry the receipt at `error.execution`. `ToolsExecutionReceipt` describes the shape. Receipts survive `tools.jobs.get(id)` and the usual run/wait helpers.
