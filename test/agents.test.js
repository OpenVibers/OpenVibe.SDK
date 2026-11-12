'use strict';
const assert = require('node:assert/strict');
const { run, stubServer, send } = require('./helpers');
const { createClient } = require('../src/core');
const { createAgentsClient, createFrameAgentsClient, refOf, parseRef, isEnd, needsPerson, KINDS, STATUSES } = require('../src/agents');
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
 ['runs: list, get, steps, start, say, stop, and an approval answer', async () => {
   const run = { id:'run_a', owner:{type:'user',id:'usr_a'}, agent:{id:'actor',product:'actor'}, status:'running', created_at:'2026-11-11T00:00:00Z', updated_at:'2026-11-11T00:00:10Z' };
   const step = { run_id:'run_a', seq:11, kind:'tool', text:'Ran the tests', started_at:'2026-11-11T00:00:10Z', ended_at:'2026-11-11T00:00:10Z' };
   const srv = await stubServer((req,res) => {
     const u = new URL(req.url,'http://x');
     if (u.pathname === '/api/v1/runs' && req.method === 'GET') return send(res,200,{runs:[run],next:'run_z'});
     if (u.pathname === '/api/v1/runs' && req.method === 'POST') return send(res,201,{...run,id:'run_new'});
     if (u.pathname === '/api/v1/runs/run_a/steps') return send(res,200,{steps:[step],next:11});
     if (u.pathname === '/api/v1/runs/run_a/stop') return send(res,200,{...run,status:'stopped'});
     if (u.pathname === '/api/v1/runs/run_a/approvals/7' || u.pathname === '/api/v1/runs/run_a/approvals/apr_1') return send(res,200,{run_id:'run_a',step_seq:7,what:'push',options:[{id:'approve',label:'Approve'}],answer:'approve'});
     if (u.pathname === '/api/v1/runs/run_a/messages') return send(res,201,{run_id:'run_a',seq:12,kind:'message',from:'person',text:'make it purple',started_at:'2026-11-11T00:00:11Z'});
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
     // Start: the words alone, or the whole agents.run-start@1 object (Contracts 0.414.0).
     assert.equal((await agents.runs.start('find it')).id,'run_new');
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {text:'find it'});
     assert.equal((await agents.runs.start({text:'a goal bar',kind:'code',target:'openvibe',budget:{usd:1}},{idempotencyKey:'k-1'})).id,'run_new');
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {text:'a goal bar',kind:'code',target:'openvibe',budget:{usd:1}});
     assert.equal(srv.requests.at(-1).headers['idempotency-key'], 'k-1');
     await assert.rejects(agents.runs.start({kind:'chat'}), /words to start with/);
     await assert.rejects(agents.runs.start('   '), /words to start with/);
     // Say: continue or steer a run.
     assert.equal((await agents.runs.say('run_a','make it purple')).seq, 12);
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {text:'make it purple'});
     assert.equal((await agents.runs.say({id:'run_a'},{attachments:[{kind:'image',media_id:'med_1'}]})).seq, 12);
     await assert.rejects(agents.runs.say('run_a',''), /words or attachments/);
     assert.equal((await agents.runs.stop('run_a',{reason:'not now'})).status,'stopped');
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {reason:'not now'});
     assert.equal((await agents.approvals.answer({id:'run_a'},7,'approve')).answer,'approve');
     assert.deepEqual(JSON.parse(srv.requests.at(-1).body.toString()), {answer:'approve'});
     // By the approval's own id, or the approval object.
     assert.equal((await agents.approvals.answer('run_a','apr_1','approve')).answer,'approve');
     assert.match(srv.requests.at(-1).url, /\/approvals\/apr_1$/);
     assert.equal((await agents.approvals.answer('run_a',{id:'apr_1'},'approve')).answer,'approve');
     await assert.rejects(agents.approvals.answer('run_a','','approve'), /an approval/);
     await assert.rejects(agents.approvals.answer('run_a','apr_1'), /an answer/);
   } finally { await srv.close(); }
 }],
 ['follow: the engine\'s stream calls a handler per event and ends at end', async () => {
   const run = { id:'c_1', ref:'chat:c_1', kind:'chat', owner:{type:'user',id:'usr_a'}, agent:{id:'vibe',product:'chat'}, status:'running', created_at:'2026-11-12T00:00:00Z', updated_at:'2026-11-12T00:00:01Z' };
   const step = { run_id:'c_1', seq:4, kind:'message', from:'agent', status:'running', text:'Three', started_at:'2026-11-12T00:00:01Z' };
   const srv = await stubServer((req,res) => {
     assert.equal(req.url, '/api/v1/runs/c_1/events'); assert.equal(req.headers['last-event-id'], '3');
     res.writeHead(200,{'Content-Type':'text/event-stream'});
     res.write(`id: 3\nevent: run\ndata: ${JSON.stringify({type:'run',run})}\n\n`);
     res.write(`id: 4\nevent: step\ndata: ${JSON.stringify({type:'step',step})}\n\n`);
     res.write(`id: 4\nevent: delta\ndata: ${JSON.stringify({type:'delta',run_id:'c_1',seq:4,text:' picks'})}\n\n`);
     res.write(`id: 4\nevent: delta\ndata: ${JSON.stringify({type:'delta',run_id:'c_1',seq:4,text:' under $90'})}\n\n`);
     res.end(`id: 5\nevent: end\ndata: ${JSON.stringify({type:'end',run_id:'c_1',status:'done'})}\n\n`);
   });
   try {
     const agents = createAgentsClient(createClient({baseUrls:{network:srv.url},token:'t'}));
     const seen = { runs:[], steps:[], text:'', events:0 };
     const end = await agents.runs.follow('c_1', { after: 3, reconnectDelayMs: 1,
       onRun: (r) => seen.runs.push(r.status), onStep: (st) => { seen.steps.push(st.seq); seen.text = st.text; }, onDelta: (d) => { seen.text += d.text; }, onEvent: () => { seen.events++; } });
     assert.deepEqual(end, { status: 'done' });
     assert.deepEqual(seen, { runs: ['running'], steps: [4], text: 'Three picks under $90', events: 5 }, 'a delta with its step\'s id is delivered, not skipped as already seen');
   } finally { await srv.close(); }
 }],
 ['the Frame client names a run by its ref', async () => {
   const seen = [];
   const srv = await stubServer((req,res) => { seen.push(`${req.method} ${req.url}`); return send(res, 200, req.url.includes('/steps') ? { steps: [], next: null } : { id: 'tsk_1', ref: 'codes:tsk_1', status: 'running' }); });
   try {
     const all = createFrameAgentsClient(createClient({baseUrls:{network:srv.url},token:'t'}));
     await all.runs.list({ kind: 'code', limit: 5 });
     await all.runs.get({ id: 'tsk_1', ref: 'codes:tsk_1' });
     await all.runs.steps('codes:tsk_1', { after: 2 });
     await all.runs.say('codes:tsk_1', 'also add a test');
     await all.runs.stop({ id: 'tsk_1', ref: 'codes:tsk_1' });
     assert.deepEqual(seen, ['GET /api/frame/runs?kind=code&limit=5', 'GET /api/frame/runs/codes%3Atsk_1', 'GET /api/frame/runs/codes%3Atsk_1/steps?after=2', 'POST /api/frame/runs/codes%3Atsk_1/messages', 'POST /api/frame/runs/codes%3Atsk_1/stop']);
     assert.throws(() => createAgentsClient(createClient({baseUrls:{network:srv.url},token:'t'}), { prefix: 'runs' }), /prefix/);
   } finally { await srv.close(); }
 }],
 ['shape helpers: refs, ends and who a run waits on', async () => {
   assert.equal(refOf('chat', 'c_8f3k2m'), 'chat:c_8f3k2m');
   assert.deepEqual(parseRef('codes:tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH'), { product: 'codes', id: 'tsk_01K9R2V6M8Q4T0B7C3D5E9F2GH' });
   assert.equal(parseRef('tsk_1'), null); assert.throws(() => refOf('Chat', 'x'), /product/); assert.throws(() => refOf('chat', ''), /product/);
   assert.equal(isEnd('done'), true); assert.equal(isEnd({ status: 'waiting' }), false); assert.equal(isEnd(null), false);
   assert.equal(needsPerson({ status: 'waiting', waiting: { for: 'message' } }), false, 'a conversation between turns does not need its person');
   assert.equal(needsPerson({ status: 'waiting', waiting: { for: 'approval', approval: 'apr_1' } }), true);
   assert.equal(needsPerson({ status: 'running' }), false);
   assert.ok(KINDS.includes('chat') && KINDS.includes('code') && STATUSES.length === 6);
 }],
]);
