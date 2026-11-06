'use strict';
/**
 * The memory check of the stream seal, in its own process.
 *
 * It runs with --expose-gc so it can ask for a collection and see what is really still held,
 * instead of counting what the collector has not got to yet. A seal that buffered the whole file
 * would show 64 MiB here; one that holds a chunk at a time shows a few.
 *
 * Run by test/locker.test.js: node --expose-gc test/locker-memory.js
 */
const locker = require('../src/locker');

(async () => {
    const SIZE = 64 * 1024 * 1024;
    let produced = 0;
    const source = new ReadableStream({
        pull(controller) {
            if (produced >= SIZE) { controller.close(); return; }
            const chunk = new Uint8Array(1024 * 1024);
            chunk.fill(produced % 251);
            produced += chunk.length;
            controller.enqueue(chunk);
        },
    });
    const sealed = locker.sealStream(source, { lock: 'password', password: 'x', size: SIZE });
    const reader = sealed.getReader();
    let peak = 0;
    let total = 0;
    let firstFrame = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (!firstFrame) firstFrame = produced;
        global.gc();
        const now = process.memoryUsage();
        peak = Math.max(peak, now.heapUsed + now.external);
    }
    process.stdout.write(JSON.stringify({ peak, total, firstFrame }));
})().catch((err) => { console.error(err); process.exit(1); });
