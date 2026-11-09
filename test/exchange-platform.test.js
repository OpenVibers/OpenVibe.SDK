'use strict';
const assert=require('node:assert/strict');const {createExchangeClient}=require('../src/exchange');
(async()=>{const calls=[];const c=createExchangeClient({developerKey:'test',maxRetries:0,fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response('{}',{status:200});}});
await c.keys.list();await c.keys.create({name:'demo',monthly_cap_usd:5,allowed_models:[]});await c.keys.revoke('a/b');await c.keyUsage();await c.deployments.list();await c.search('hello',{engine:'openvibe'});await c.images('cat',{license:'cc0'});await c.search.icons('home');await c.fetch('https://example.org');
assert.ok(calls[2].url.endsWith('/keys/a%2Fb'));assert.equal(calls[2].method,'DELETE');assert.equal(JSON.parse(calls[5].body).q,'hello');assert.ok(calls[6].url.endsWith('/v1/search/images'));assert.ok(calls[7].url.endsWith('/v1/search/icons'));console.log('Exchange platform SDK wire shapes passed');})().catch(e=>{console.error(e);process.exitCode=1;});
