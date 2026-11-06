'use strict';
class ShareError extends Error {
    constructor(status, code, message) { super(message); this.name = 'ShareError'; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ShareError(status, code, message); };
const invalid = () => fail(400, 'share.invalid', 'Invalid sharing request');
const hidden = () => fail(404, 'share.not_found', 'Not found');
function object(v, keys) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) invalid();
}
function subject(v) {
    object(v, ['type', 'id']);
    const prefixes = { user: 'usr', guest: 'gst', app: 'app', mod: 'mod', agent: 'agt' };
    const pattern = prefixes[v.type] ? new RegExp(`^${prefixes[v.type]}_[0-9A-HJKMNP-TV-Z]{26}$`)
        : ['service', 'system'].includes(v.type) ? /^[a-z][a-z0-9-]{1,39}$/ : null;
    if (!pattern || typeof v.id !== 'string' || !pattern.test(v.id)) invalid();
    return { type: v.type, id: v.id };
}
function ref(v) {
    object(v, ['service', 'kind', 'id']);
    if (typeof v.service !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(v.service)
        || typeof v.kind !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(v.kind)
        || typeof v.id !== 'string' || !v.id.length || v.id.length > 200) invalid();
    return { service: v.service, kind: v.kind, id: v.id };
}
function audience(v) { if (!['public', 'link', 'people', 'private'].includes(v)) invalid(); return v; }
function actor(viewer) { if (!viewer || !viewer.subject) hidden(); return subject(viewer.subject); }
function equal(a, b) { return !!a && !!b && a.type === b.type && a.id === b.id; }
function name(v) { if (typeof v !== 'string' || !/^@?[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(v)) invalid(); return v.replace(/^@/, ''); }
function uuid(v) { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) invalid(); return v; }
function expiry(v, now) {
    if (v === undefined) return null;
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v)
        || !Number.isFinite(Date.parse(v)) || Date.parse(v) <= now) invalid();
    const parts = v.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/).slice(1).map(Number);
    const [year, month, day, hour, minute, second] = parts;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) invalid();
    return new Date(v).toISOString();
}
module.exports = { ShareError, fail, invalid, hidden, object, subject, ref, audience, actor, equal, name, uuid, expiry };
