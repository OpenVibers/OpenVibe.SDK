'use strict';
const assert=require('node:assert/strict');
const {createAiClient}=require('../src/ai');
const calls=[];const ai=createAiClient({json:async r=>{calls.push(r);return {ok:true};}});
(async()=>{
 const choice={model:'anthropic/claude-opus-5-5',source:'openvibe'};
 await ai.tasks();await ai.choices.get('design.icon');await ai.choices.set('design.icon',choice);
 await ai.run('design.icon',{prompt:'A tree'},{choice,wait:1000});
 await ai.runs.create('ai.generate',{prompt:'A tree'},{choice});
 await ai.admin.defaults();await ai.admin.defaults({defaults:[]});
 assert.equal(calls[0].path,'/api/v1/tasks');assert.deepEqual(calls[1].query,{task:'design.icon'});
 assert.equal(calls[2].method,'PUT');assert.deepEqual(calls[2].json,choice);
 assert.deepEqual(calls[3].json,{task:'design.icon',input:{prompt:'A tree'},choice});
 assert.deepEqual(calls[4].json.choice,choice);assert.equal(calls[5].path,'/api/v1/admin/task-defaults');assert.equal(calls[6].method,'PUT');
 console.log('AI choices: seven client operations preserve their wire shape');
})().catch(e=>{console.error(e);process.exitCode=1;});
