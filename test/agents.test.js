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
 ['reconnect retries use exponential backoff', async () => {
   let calls=0; const srv=await stubServer((req,res)=>{ calls++; if(calls<4) return send(res,503,{code:'temporarily.unavailable'}); res.writeHead(200,{'Content-Type':'text/event-stream'}); res.end(`id: 1\nevent: RUN_FINISHED\ndata: ${JSON.stringify({type:'RUN_FINISHED',timestamp:1794355200000})}\n\n`); });
   try { const agents=createAgentsClient(createClient({baseUrls:{network:srv.url},token:'t'})); const start=Date.now(); const got=[]; for await(const e of agents.events('run_a',{reconnectDelayMs:10,maxReconnects:5})) got.push(e.id); assert.deepEqual(got,['1']); assert.ok(Date.now()-start>=65,`backoff elapsed ${Date.now()-start}ms`); assert.equal(calls,4); }
   finally { await srv.close(); }
 }],
 ['runs: list, get, steps, start, stop, and an approval answer', async () => {
   const run = { id:'run_a', owner:{type:'user',id:'usr_a'}, agent:{id:'actor',product:'actor'}, status:'running', created_at:'2026-11-11T00:00:00Z', updated_at:'2026-11-11T00:00:10Z' };
   const step = { run_id:'run_a', seq:11, kind:'tool', text:'Ran the tests', started_at:'2026-11-11T00:00:10Z', ended_at:'2026-11-11T00:00:10Z' };
   const srv = await stubServer((req,res) => {
     const u = new URL(req.url,'http://x');
     if (u.pathname === '/api/v1/runs' && req.method === 'GET') return send(res,200,{runs:[run],next:'run_z'});
     if (u.pathname === '/api/v1/runs' && req.method === 'POST') return send(res,201,{...run,id:'run_new'});
     if (u.pathname === '/api/v1/runs/run_a/steps') return send(res,200,{steps:[step],next:11});
     if (u.pathname === '/api/v1/runs/run_a/stop') return send(res,200,{...run,status:'stopped'});
     if (u.pathname === '/api/v1/runs/run_a/approvals/7') return send(res,200,{run_id:'run_a',step_seq:7,what:'push',options:[{id:'approve',label:'Approve'}],answer:'approve'});
     if (u.pathname === '/api/v1/runs/run_a') return send(res,200,run);
     return send(res,404,{code:'agents.run.not_found'});
   });
   try {
     const agents = createAgentsClient(createClient({baseUrls:{network:srv.url},token:'t'}));
     assert.deepEqual(await agents.runs.list({limit:2,parentRun:'run_p'}), {runs:[run],next:'run_z'});
     assert.match(srv.requests.at(-1).url, /limit=2/); assert.match(srv.requests.at(-1).url, /parent_run=run_p/);
     assert.deepEqual(await agents.runs.get('run_a'), run);
     assert.equal(await agents.runs.get('missing'), null);
     assert.deepEqual(await agents.runs.steps('run_a',{after:10,limit:5}), {steps:[step],next:11});
     assert.match(srv.requests.at(-1).url, /after=10/);
     assert.equal((await agents.runs.start('actor',{text:'find it'},{budget:{usd:1}})).id,'run_new');
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {agent:'actor',input:{text:'find it'},budget:{usd:1}});
     assert.equal((await agents.runs.stop('run_a',{reason:'not now'})).status,'stopped');
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {reason:'not now'});
     assert.equal((await agents.approvals.answer({id:'run_a'},7,'approve')).answer,'approve');
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {answer:'approve'});
   } finally { await srv.close(); }
 }],
]);
