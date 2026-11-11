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
   try { const agents=createAgentsClient(createClient({baseUrls:{actor:srv.url},token:'t'}));
     assert.equal((await agents.run('run_a')).id,'run_a'); assert.deepEqual(await agents.post('run_a',{id:'approval_1',action:'approve'}),{accepted:true});
     const got=[]; for await (const e of agents.events('run_a',{lastEventId:4,reconnectDelayMs:1})) got.push([e.id,e.event]);
     assert.deepEqual(got,[['5','STEP_STARTED'],['6','RUN_FINISHED']]); assert.equal(srv.requests[3].headers['last-event-id'],'5');
   } finally { await srv.close(); }
 }],
]);
