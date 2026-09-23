'use strict';
/**
 * Uploaded files as multipart parts, shared by openvibe-sdk/jobs and openvibe-sdk/tools so both take
 * the same shapes: a Blob/File, or { name, data: Blob | ArrayBuffer | typed array (Buffer) | string,
 * type? }. Browser-safe (Blob, FormData). Internal: not a public subpath.
 */

const isBlob = (x) => typeof Blob !== 'undefined' && x instanceof Blob;

/** Is `f` something appendFiles() can upload? */
function isUpload(f) {
    if (isBlob(f)) return true;
    const d = f && typeof f === 'object' ? f.data : undefined;
    return isBlob(d) || typeof d === 'string' || d instanceof ArrayBuffer || ArrayBuffer.isView(d);
}

/** Append each file as a `file` part (Tools reads `file` and `files` parts alike). */
function appendFiles(form, list, where) {
    for (const f of list) {
        if (!isUpload(f)) throw new TypeError(`${where}: a file is a Blob/File, or { name, data: Blob | ArrayBuffer | typed array | string, type? }`);
        if (isBlob(f)) {
            form.append('file', f, f.name || 'file');
            continue;
        }
        const blob = isBlob(f.data) ? f.data : new Blob([f.data], f.type ? { type: f.type } : undefined);
        form.append('file', blob, f.name || 'file');
    }
    return form;
}

module.exports = { isBlob, isUpload, appendFiles };
