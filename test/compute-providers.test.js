'use strict';
const assert=require('node:assert/strict');
const {createProviders}=require('../src/compute');
(async()=>{
 const calls=[];
 const fetch=async(url,opts)=>{
  calls.push({url,...opts});
  let body={};
  if(url.includes('server_types')) body={server_types:[{name:'cx',memory:4,cores:2,prices:[{location:'fsn1',price_hourly:{gross:'0.01'}}]}]};
  else if(url.endsWith('/servers') && opts.method==='POST') body={server:{id:42}};
  else if(url.includes('/servers/')) body={server:{status:'running'}};
  else if(url.includes('live_data')) body={server:[{id:1,price:40,ram_size:64,datacenter:'FSN1'}]};
  else if(url.includes('bundles')) body={offers:[{id:2,dph_total:0.2,cpu_ram:32000,gpu_ram:24000,num_gpus:1,geolocation:'US'}]};
  else if(url.includes('/asks/')) body={new_contract:9};
  else if(url.includes('/instances/')) body={instances:{actual_status:'running'}};
  else if(url.includes('graphql')) body={data:{gpuTypes:[{id:'a',displayName:'GPU',memoryInGb:24,securePrice:0.3}]}};
  else if(url.endsWith('/pods') && opts.method==='POST') body={id:'p'};
  else if(url.includes('/pods/')) body={desiredStatus:'RUNNING'};
  else if(url.includes('community/offers')) body={offers:[{id:'c',region:'US'}]};
  else if(url.endsWith('/auth/time')) body=100;
  else if(url.includes('/order/catalog')) body={locale:{currencyCode:'USD'},plans:[{planCode:'b-hour',pricings:[{interval:1,mode:'default',price:2000000}]}]};
  else if(url.endsWith('/flavor')) body=[{id:'b',ram:4,region:'GRA',planCodes:{hourly:'b-hour'}}];
  else if(url.endsWith('/instance')) body={id:'i'};
  else if(url.includes('/instance/')) body={status:'ACTIVE'};
  return {ok:true,status:200,json:async()=>body};
 };
 const config=Object.fromEntries(['hetzner','vast','runpod','ovh'].map(n=>[n,{key:'stub',application_secret:'stub',consumer_key:'stub',project:'project'}]));
 const ps=createProviders({fetch,config,now:()=>100});
 for(const name of ['hetzner','ovh','vast','runpod']){
  const q=(await ps[name].quote())[0]; assert.ok(q.hourly>0,name); assert.equal(q.expires_at,60100);
  const r=await ps[name].provision(q,{label:'test',image:'prepared'}); assert.ok(r.id);
  assert.ok((await ps[name].health(r.id)).state); await ps[name].release(r.id);
 }
 assert.equal((await ps['hetzner-auction'].quote())[0].provisionable,false);
 assert.equal((await ps.community.quote())[0].hourly,null);
 assert.equal(calls.find(c=>c.url.includes('/asks/')).method,'PUT');
 assert.ok(calls.find(c=>c.url==='https://rest.runpod.io/v1/pods'));
 assert.ok(calls.filter(c=>c.url.includes('/cloud/project/')).every(c=>c.headers['X-Ovh-Signature'].startsWith('$1$')));
 const noKey=createProviders({fetch});
 for(const name of ['hetzner','ovh','vast','runpod']) await assert.rejects(noKey[name].provision({id:'1'},{image:'x'}),/key|credentials/);
 await assert.rejects(ps.community.provision(),/router/);
 await assert.rejects(ps['hetzner-auction'].provision(),/quote only/);
 console.log('compute provider API stubs and key gates: passed');
})().catch(e=>{console.error(e);process.exit(1);});
