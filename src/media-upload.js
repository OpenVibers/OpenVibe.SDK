'use strict';
const { createObjectsClient } = require('./media');
const MIB = 1024 * 1024;

/** Media's resumable multipart transport, configured for 8 MiB parts and three in flight. */
function createUploadClient(config) {
    const objects = createObjectsClient({ partSize: 8 * MIB, concurrency: 3, ...config });
    return {
        upload(file, options = {}) {
            return objects.upload(file, { kind: 'file', filename: file && file.name, ...options });
        },
        resume(ref, file, options) { return objects.resume(ref, file, options); },
        objects,
    };
}

module.exports = { createUploadClient };
