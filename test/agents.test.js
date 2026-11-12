'use strict';
const assert = require('node:assert/strict');
const { run, stubServer, send } = require('./helpers');
const { createClient } = require('../src/core');
const { createAgentsClient } = require('../src/agents');
run([
 ['run snapshot, post approval, and resumable AG-UI SSE', async () => {
   let calls = 0; const srv = await stubServer((req,res) => {
     if (req.url.endsWith('/approvals')) return send(res,200,{accepted:true});
     if (req.url.endsWith('/events')) { calls++; assert.equal(req.headers['last-event-id'], calls === 1 ? '4' : '5'); res.writeHead(200,{'Content-Type':'text/event-stream'}); res.write(`id: ${calls===1?'5':'6'}\nevent: ${calls===1?'STEP_STARTED':'RUN_FINISHED'}\ndata: ${JSON.stringify({type:calls===1?'STEP_STARTED':'RUN_FINISHED',timestamp:'2026-11-11T00:00:00Z'})}\n\n`); return res.end(); }
     return send(res,200,{id:'run_a',status:'running'});
   });
   try { const agents=createAgentsClient(createClient({baseUrls:{network:srv.url},token:'t'}));
     assert.equal((await agents.run('run_a')).id,'run_a'); assert.deepEqual(await agents.post('run_a',{id:'approval_1',action:'approve'}),{accepted:true});
     const got=[]; for await (const e of agents.events('run_a',{lastEventId:4,reconnectDelayMs:1})) got.push([e.id,e.event]);
     assert.deepEqual(got,[['5','STEP_STARTED'],['6','RUN_FINISHED']]); assert.equal(srv.requests[3].headers['last-event-id'],'5');
   } finally { await srv.close(); }
 }],
 ['See it work: desks, take over, hand back and replay are the SDK\'s own calls', async () => {
   const seen = [];
   const srv = await stubServer((req, res, raw) => {
     const body = raw && raw.length ? JSON.parse(raw.toString()) : null;
     seen.push({ method: req.method, url: req.url, body });
     if (req.url.endsWith('/desks')) return send(res, 200, { desks: [{ desk: { id: 'desk-a' }, view: null, still: '/still' }] });
     if (req.url.endsWith('/take-over')) return send(res, 200, { control: true });
     if (req.url.endsWith('/hand-back')) return send(res, 200, { control: false });
     if (req.url.endsWith('/replay')) return send(res, 200, { steps: [{ seq: 3, action: 'click' }] });
     return send(res, 200, {});
   });
   try {
     const agents = createAgentsClient(createClient({ baseUrls: { network: srv.url }, token: 't' }));
     assert.deepEqual(await agents.desks('run_a'), { desks: [{ desk: { id: 'desk-a' }, view: null, still: '/still' }] });
     assert.deepEqual(await agents.takeOver({ id: 'run_a' }, 'desk-a'), { control: true });
     assert.deepEqual(await agents.handBack('run_a', 'desk-a', 'signed in, carry on'), { control: false });
     assert.deepEqual(await agents.replay('run_a'), { steps: [{ seq: 3, action: 'click' }] });
     assert.deepEqual(seen.map((x) => `${x.method} ${x.url}`), [
       'GET /api/v1/runs/run_a/desks',
       'POST /api/v1/runs/run_a/desks/desk-a/take-over',
       'POST /api/v1/runs/run_a/desks/desk-a/hand-back',
       'GET /api/v1/runs/run_a/replay',
     ]);
     assert.deepEqual(seen[2].body, { note: 'signed in, carry on' });
     await assert.rejects(agents.takeOver('run_a', ''), /desk id/);
   } finally { await srv.close(); }
 }],
 ['reconnect retries use exponential backoff', async () => {
   let calls=0; const srv=await stubServer((req,res)=>{ calls++; if(calls<4) return send(res,503,{code:'temporarily.unavailable'}); res.writeHead(200,{'Content-Type':'text/event-stream'}); res.end(`id: 1\nevent: RUN_FINISHED\ndata: ${JSON.stringify({type:'RUN_FINISHED',timestamp:1794355200000})}\n\n`); });
   try { const agents=createAgentsClient(createClient({baseUrls:{network:srv.url},token:'t'})); const start=Date.now(); const got=[]; for await(const e of agents.events('run_a',{reconnectDelayMs:10,maxReconnects:5})) got.push(e.id); assert.deepEqual(got,['1']); assert.ok(Date.now()-start>=65,`backoff elapsed ${Date.now()-start}ms`); assert.equal(calls,4); }
   finally { await srv.close(); }
 }],
]);
