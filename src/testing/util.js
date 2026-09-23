'use strict';
/** Shared helpers of the mock platform (Node only). */
const crypto = require('node:crypto');

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function ulid() {
    let t = Date.now();
    let time = '';
    for (let i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ULID_ALPHABET[t % 32] + time;
    let rand = '';
    for (const b of crypto.randomBytes(16)) rand += ULID_ALPHABET[b & 31];
    return time + rand;
}

function topicRegex(pattern) {
    const seg = '[a-z0-9_]+';
    const parts = String(pattern).split('.').map((p) => (p === '*' ? `${seg}(?:\\.${seg})*` : p.replace(/[^a-z0-9_]/g, '')));
    return new RegExp(`^${parts.join('\\.')}$`);
}

function json(status, body, headers = {}) {
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function problem(status, code, detail, extra = {}) {
    return new Response(JSON.stringify({ type: `https://openvibe.network/problems/${code}`, title: String(status), status, code, detail, error: detail || code, ...extra }), {
        status, headers: { 'Content-Type': 'application/problem+json' },
    });
}

/** A 302 to `target` with query parameters added. */
function redirect(target, params) {
    const u = new URL(target);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store' } });
}

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
const s256 = (verifier) => b64url(crypto.createHash('sha256').update(String(verifier)).digest());

module.exports = { ULID_RE, b64url, fromB64url, ulid, topicRegex, json, problem, redirect, sha256hex, s256 };
