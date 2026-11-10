'use strict';
const assert = require('assert');
const { createLevelsClient } = require('../src/levels');
(async () => {
 const calls = []; const levels = createLevelsClient({ json: async o => { calls.push(o); return { level: 1 }; } });
 const subject = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
 await levels.get('alice'); await levels.batch([subject]); await levels.board();
 await levels.award({ subject, reason: 'quest.completed', amount: 25, idempotency_key: 'completion:1' });
 assert.equal(calls[0].path, '/api/v1/levels/people/alice');
 assert(calls[1].path.includes(subject)); assert.equal(calls[2].path, '/api/v1/levels/board');
 assert.equal(calls[3].method, 'POST'); assert.equal(calls[3].idempotencyKey, false);
 assert(calls.every(c => c.audience === 'openvibe.network'));
 assert.throws(() => levels.batch(Array(101).fill(subject))); assert.throws(() => levels.batch(['bad']));
 assert.throws(() => levels.get('../board'));
 const refused = createLevelsClient({ json: async () => { const e = new Error('duplicate'); e.status = 409; throw e; } });
 await assert.rejects(refused.award({}), e => e.status === 409);
 console.log('levels: public reads, bounded batches and service awards passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
