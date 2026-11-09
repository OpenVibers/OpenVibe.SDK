'use strict';
const assert = require('node:assert/strict');
const { run, stubServer } = require('./helpers');
const { createClient } = require('../src/core');
const { createPicsClient } = require('../src/pics');
run([[ 
 'Pics routes preserve discovery queries, person audience and raw chunk bytes', async () => {
    const server = await stubServer(async (req, res, body) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:true })); });
    try {
        const pics = createPicsClient(createClient(), { baseUrl: server.url });
        await pics.gallery({sort:'rising',tag:'forest',cursor:'30'});
        await pics.uploads.chunk('pup_example', 7, Buffer.from([1,2,255]));
        await pics.publish('Abcdef23',{listed:true,tags:['forest']});
        await pics.like('Abcdef23',false);
        const [g,c,p,l] = server.requests;
        assert.match(g.url,/sort=rising/); assert.match(g.url,/cursor=30/);
        assert.equal(c.method,'PATCH'); assert.equal(c.headers['upload-offset'],'7'); assert.deepEqual([...c.body],[1,2,255]);
        assert.deepEqual(JSON.parse(p.body),{listed:true,tags:['forest']}); assert.equal(l.method,'DELETE');
    } finally { await server.close(); }
 }
]]);
