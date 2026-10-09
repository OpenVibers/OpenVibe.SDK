'use strict';
/**
 * openvibe-sdk/account-data — a service's share of account export and deletion (ADR-033).
 *
 * Network asks every service holding network.account.export.contribute and network.account.deletion.confirm for its
 * part. network.account.export_requested wants the person's rows, pushed to POST /internal/account-exports/:id/parts
 * (network.account-export-part@1). network.account.deleted wants them gone, or made authorless where other people's
 * rows hang under them, and confirmed with counts at POST /internal/account-deletions/:id/confirmations
 * (network.account-deletion-confirmation@1). Network waits for every holder of those grants, so a service adopts this
 * module and its Events subscription first, and asks for the grants last.
 *
 *   const { createAccountData, createNetworkSender } = require('openvibe-sdk/account-data');
 *   const accountData = createAccountData({ db, service: 'food', tables: [
 *       { table: 'food_plans', subject: 'owner', value: (usr) => `user:${usr}`, file: 'plans.json' },
 *       { table: 'food_pantry', subject: 'owner', value: (usr) => `user:${usr}`, file: 'pantry.json' },
 *   ] });
 *   await accountData.ensureSchema();                    // or ACCOUNT_DATA_SCHEMA in a migration
 *   const send = createNetworkSender({ networkInternalUrl, clientId, clientSecret });
 *   app.use('/internal/events', accountData.consumer({ secrets: [process.env.FOOD_EVENTS_SECRET], send }));
 *   startSubscriptions({ eventsUrl, endpoint: 'http://127.0.0.1:4970/internal/events', secret, networkInternalUrl,
 *       clientId, clientSecret });                      // the two subscriptions, created at boot when missing
 *   // or, inside a consumer the service already has:  const outcome = await accountData.apply(event, { send });
 *
 * A table entry:
 *   table    the table (a plain lower-case identifier)
 *   subject  the column naming the person
 *   value    usr_… → what that column stores (default: the id itself); may return an array of forms
 *   file     the export file name (default '<table>.json'); null leaves the table out of the export
 *   columns  the exported columns (default: all). List them when a table holds anything that is not the person's to
 *            read (a token, a secret, someone else's private note).
 *   order    the export order column (default: created_at when the table has it, else the first column)
 *   erase    'delete' (default)
 *            | { anonymize: { <column>: <value>, … } }  the row stays, the subject column becomes NULL and the listed
 *              columns take the values (e.g. { body: '[deleted]' }): for rows other people's rows hang under
 *            | { keep: '<why>' }  nothing changes; counted as retained (a ledger the law makes us keep)
 *   kind     the name the counts use (default: the table)
 *
 * `extraExport(db, subject)` → [{ name, content }] and `extraErase(t, subjects, counts)` cover what a table map
 * cannot say (recounting cached totals, files in object storage); extraErase runs inside the erase transaction.
 *
 * apply() answers 'exported' | 'erased' | 'confirmed' | 'closed' | 'unchanged' | 'ignored:<why>', and throws when
 * Network refuses for a reason worth retrying, so Events redelivers. It is idempotent per export and deletion id
 * (account_data_events): a redelivered deletion never erases twice, and a confirmation that failed is sent again.
 */
const { parseDelivery } = require('./events');
const { createServiceTokenClient } = require('./auth/tokens');

const TOPICS = Object.freeze(['network.account.export_requested', 'network.account.deleted']);
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXPORT_RE = /^exp_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELETION_RE = /^del_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const FILE_RE = /^[a-z0-9][a-z0-9_.-]{0,62}\.json$/;
const MAX_FILES = 64;

const ACCOUNT_DATA_SCHEMA = `CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
)`;

function ident(name, what) {
    if (typeof name !== 'string' || !IDENT.test(name)) throw new TypeError(`openvibe-sdk/account-data: ${what} "${name}" is not a plain identifier`);
    return name;
}

function normaliseTables(tables) {
    if (!Array.isArray(tables)) throw new TypeError('openvibe-sdk/account-data: tables must be an array');
    const files = new Set();
    return tables.map((t) => {
        const table = ident(t.table, 'table');
        const subject = ident(t.subject, `${table}: subject column`);
        const file = t.file === null ? null : (t.file || `${table}.json`);
        if (file !== null) {
            if (!FILE_RE.test(file)) throw new TypeError(`openvibe-sdk/account-data: ${table}: file "${file}" must be a flat name ending in .json`);
            if (files.has(file)) throw new TypeError(`openvibe-sdk/account-data: two tables export to ${file}`);
            files.add(file);
        }
        const columns = t.columns ? t.columns.map((c) => ident(c, `${table}: column`)) : null;
        const order = t.order ? ident(t.order, `${table}: order column`) : null;
        let erase = t.erase || 'delete';
        if (erase !== 'delete') {
            if (erase.anonymize) {
                for (const c of Object.keys(erase.anonymize)) ident(c, `${table}: anonymize column`);
            } else if (!(typeof erase.keep === 'string' && erase.keep)) {
                throw new TypeError(`openvibe-sdk/account-data: ${table}: erase is 'delete', { anonymize: {…} } or { keep: '<why>' }`);
            }
        }
        const value = typeof t.value === 'function' ? t.value : (s) => s;
        return { table, subject, file, columns, order, erase, value, kind: t.kind || table };
    });
}

function createAccountData({ db, service, tables, extraExport = null, extraErase = null, note = null, rowLimit = 5000, log = console } = {}) {
    if (!db || typeof db.many !== 'function' || typeof db.tx !== 'function') throw new TypeError('openvibe-sdk/account-data: db must be an openvibe-sdk/db handle');
    if (typeof service !== 'string' || !service) throw new TypeError('openvibe-sdk/account-data: service is required');
    const entries = normaliseTables(tables || []);
    const columnCache = new Map();

    /** The table's columns, or null when the table does not exist (yet): a table a migration has not made is skipped. */
    async function columnsOf(q, table) {
        if (columnCache.has(table)) return columnCache.get(table);
        const rows = await q.many('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [table]);
        const cols = rows.length ? rows.map((r) => r.column_name) : null;
        if (cols) columnCache.set(table, cols);
        return cols;
    }

    const formsOf = (entry, subjects) => [...new Set(subjects.flatMap((s) => [].concat(entry.value(s))).filter((v) => v != null).map(String))];

    async function ensureSchema() { await db.exec(ACCOUNT_DATA_SCHEMA); }

    /** The person's part: one file per table that has rows for them, newest first, cut at rowLimit. */
    async function exportPart(subject) {
        const files = [];
        const truncated = [];
        for (const e of entries) {
            if (e.file === null) continue;
            const cols = await columnsOf(db, e.table);
            if (!cols || !cols.includes(e.subject)) continue;
            const order = e.order || (cols.includes('created_at') ? 'created_at' : cols[0]);
            const list = e.columns ? e.columns.filter((c) => cols.includes(c)) : null;
            const select = list && list.length ? list.map((c) => `"${c}"`).join(', ') : '*';
            const rows = await db.many(`SELECT ${select} FROM "${e.table}" WHERE "${e.subject}" = ANY($1::text[]) ORDER BY "${order}" DESC LIMIT ${Number(rowLimit) + 1}`, [formsOf(e, [subject])]);
            if (!rows.length) continue;
            if (rows.length > rowLimit) truncated.push(e.file);
            files.push({ name: e.file, content: rows.slice(0, rowLimit) });
        }
        if (extraExport) for (const f of (await extraExport(db, subject)) || []) files.push(f);
        if (files.length > MAX_FILES) throw new Error(`openvibe-sdk/account-data: ${files.length} export files; at most ${MAX_FILES}`);
        const part = { subject, files, truncated };
        if (note) part.note = String(note).slice(0, 500);
        return part;
    }

    /** Erase everything the subjects (the account and the accounts merged into it) left here, in one transaction. */
    async function erase(subjects) {
        const erased = {};
        const retained = {};
        const add = (o, k, n) => { if (n) o[k] = (o[k] || 0) + n; };
        await db.tx(async (t) => {
            for (const e of entries) {
                const cols = await columnsOf(t, e.table);
                if (!cols || !cols.includes(e.subject)) continue;
                const forms = formsOf(e, subjects);
                if (e.erase === 'delete') {
                    add(erased, e.kind, await t.exec(`DELETE FROM "${e.table}" WHERE "${e.subject}" = ANY($1::text[])`, [forms]));
                } else if (e.erase.anonymize) {
                    const sets = [`"${e.subject}" = NULL`];
                    const values = [forms];
                    for (const [c, v] of Object.entries(e.erase.anonymize)) {
                        if (!cols.includes(c)) continue;
                        values.push(v);
                        sets.push(`"${c}" = $${values.length}`);
                    }
                    add(retained, 'tombstones', await t.exec(`UPDATE "${e.table}" SET ${sets.join(', ')} WHERE "${e.subject}" = ANY($1::text[])`, values));
                } else {
                    add(retained, e.kind, Number(await t.value(`SELECT COUNT(*)::int FROM "${e.table}" WHERE "${e.subject}" = ANY($1::text[])`, [forms])) || 0);
                }
            }
            if (extraErase) await extraErase(t, subjects, { erased, retained, add });
        });
        return { erased, retained };
    }

    /** One envelope → an outcome (see the header); throws to be redelivered. */
    async function apply(ev, { send } = {}) {
        if (!ev || !TOPICS.includes(ev.event_type)) return 'ignored:type';
        if (ev.source !== 'network') return 'ignored:source';
        if (typeof send !== 'function') throw new TypeError('openvibe-sdk/account-data: apply needs { send } (createNetworkSender)');
        const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
        if (ev.event_type === 'network.account.export_requested') {
            if (!EXPORT_RE.test(String(p.export_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
            const seen = await db.maybe('SELECT sent_at FROM account_data_events WHERE id = $1', [p.export_id]);
            if (seen && seen.sent_at) return 'unchanged';
            const part = await exportPart(p.subject);
            const res = await send(`/internal/account-exports/${p.export_id}/parts`, part);
            // 404/409: the export was built at its deadline or no longer exists; a late part has nowhere to go.
            const outcome = res.ok ? 'exported' : (res.status === 409 || res.status === 404 ? 'closed' : null);
            if (!outcome) throw new Error(`openvibe-sdk/account-data: export part refused (${res.status})`);
            await db.exec(`INSERT INTO account_data_events (id, kind, subject, outcome, sent_at) VALUES ($1, 'export', $2, $3, now())
                ON CONFLICT (id) DO UPDATE SET outcome = excluded.outcome, sent_at = excluded.sent_at`,
            [p.export_id, p.subject, JSON.stringify({ result: outcome, files: part.files.length })]);
            return outcome;
        }
        if (!DELETION_RE.test(String(p.deletion_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
        let rec = await db.maybe('SELECT * FROM account_data_events WHERE id = $1', [p.deletion_id]);
        let result = 'confirmed';
        if (!rec) {
            const subjects = [p.subject, ...(Array.isArray(p.aliases) ? p.aliases.filter((s) => SUBJECT_RE.test(String(s))) : [])];
            const counts = await erase(subjects);
            await db.exec(`INSERT INTO account_data_events (id, kind, subject, outcome) VALUES ($1, 'deletion', $2, $3)
                ON CONFLICT (id) DO NOTHING`, [p.deletion_id, p.subject, JSON.stringify(counts)]);
            log.log(`[AccountData] ${service}: deletion ${p.deletion_id} ${JSON.stringify(counts)}`);
            rec = await db.maybe('SELECT * FROM account_data_events WHERE id = $1', [p.deletion_id]);
            result = 'erased';
        }
        if (rec.sent_at) return 'unchanged';
        const o = rec.outcome || {};
        const completedAt = new Date(rec.applied_at).toISOString();
        const res = await send(`/internal/account-deletions/${p.deletion_id}/confirmations`, { subject: p.subject, completed_at: completedAt, erased: o.erased || {}, retained: o.retained || {} });
        if (!res.ok && res.status !== 404) throw new Error(`openvibe-sdk/account-data: confirmation refused (${res.status})`);
        await db.exec('UPDATE account_data_events SET sent_at = now() WHERE id = $1', [p.deletion_id]);
        return result;
    }

    /**
     * A request handler for POST /internal/events, for a service with no consumer of its own:
     *   app.post('/internal/events', accountData.consumer({ secrets, send }))
     * (no body parser before it: the v2 signature covers the raw body). It verifies the signature under any of
     * `secrets`, answers 2xx once applied (Events retries anything else) and hands events of other topics to
     * `onEvent(event)` when given (otherwise they are acknowledged and ignored). Loopback only: a request that came
     * through a proxy (X-Forwarded-For, X-Real-IP, CF-Connecting-IP) is refused.
     */
    function consumer({ secrets = [], send, onEvent = null, now = () => Date.now(), limit = 256 * 1024 } = {}) {
        const keys = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 32);
        const reply = (res, status, body) => {
            res.statusCode = status;
            res.setHeader('Content-Type', status < 300 ? 'application/json' : 'application/problem+json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(body));
        };
        const problem = (res, status, code, detail) => reply(res, status, { type: 'about:blank', title: code, status, code, detail });
        const readRaw = (req) => (Buffer.isBuffer(req.body) ? Promise.resolve(req.body) : new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        }));
        return async function handle(req, res) {
            if (req.method !== 'POST') return problem(res, 405, 'method_not_allowed', 'POST only');
            if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return problem(res, 403, `${service}.internal_only`, 'internal route');
            if (!keys.length) return problem(res, 503, `${service}.events_disabled`, 'no events secret is configured');
            let raw;
            try { raw = await readRaw(req); } catch (err) { return problem(res, err.status || 400, 'bad_request', 'unreadable body'); }
            let delivery = null;
            for (const k of keys) { delivery = parseDelivery(raw, req.headers, k, { requireV2: true, now: now() }); if (delivery) break; }
            if (!delivery || !delivery.event || typeof delivery.event.event_type !== 'string') return problem(res, 401, `${service}.bad_signature`, 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window');
            const ev = delivery.event;
            try {
                let outcome;
                if (TOPICS.includes(ev.event_type)) outcome = await apply(ev, { send });
                else if (onEvent) outcome = (await onEvent(ev)) || 'applied';
                else outcome = 'ignored:type';
                return reply(res, 200, { event_id: ev.event_id, outcome });
            } catch (err) {
                log.warn(`[AccountData] ${service}: ${ev.event_type} ${ev.event_id} failed: ${(err && err.message) || err}`);
                return problem(res, 503, `${service}.retry`, 'not applied; Events will retry');
            }
        };
    }

    return { apply, exportPart, erase, ensureSchema, consumer, TOPICS, tables: entries.map((e) => ({ table: e.table, subject: e.subject, file: e.file, erase: e.erase })) };
}

/**
 * send(path, body) → Response: POST to Network's internal routes with this service's own client-credentials token
 * (audience openvibe.network). A 401 refreshes the token once.
 */
function createNetworkSender({ networkInternalUrl, clientId, clientSecret, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (!networkInternalUrl) throw new TypeError('createNetworkSender: networkInternalUrl is required');
    const base = String(networkInternalUrl).replace(/\/+$/, '');
    const tokens = createServiceTokenClient({ tokenUrl: `${base}/oauth/token`, clientId, clientSecret, audience: 'openvibe.network', fetch: fetchImpl });
    return async function send(path, body, retried = false) {
        const res = await fetchImpl(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 && !retried) { tokens.invalidate(); return send(path, body, true); }
        return res;
    };
}

/**
 * The boot-time half: create any missing Events subscription for `topics` (default the two account topics) to this
 * service's loopback `endpoint`, idempotently, retried with backoff in the background. Off (null) when the Events URL,
 * the delivery secret or the client secret is unset. The token is this service's own, audience openvibe.events, scope
 * events.subscription.manage. A subscription already there for the same topic and endpoint is left alone, so a
 * restart creates nothing; Events answers 409 for a racing duplicate, which counts as done.
 *
 *   const subs = startSubscriptions({ eventsUrl, endpoint: `http://127.0.0.1:${port}/internal/events`, secret,
 *       networkInternalUrl, clientId, clientSecret });
 *   // graceful stop: subs && subs.stop()
 *
 * `done` resolves true once every topic is subscribed, false when the retries ran out or stop() came first.
 */
function startSubscriptions({
    eventsUrl, endpoint, secret, topics = TOPICS, networkInternalUrl, clientId, clientSecret,
    fetch: fetchImpl = globalThis.fetch, log = console, delays = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000],
} = {}) {
    if (!eventsUrl || !endpoint || !secret || !clientId || !clientSecret || !networkInternalUrl) return null;
    const base = String(eventsUrl).replace(/\/+$/, '');
    const tokens = createServiceTokenClient({ tokenUrl: `${String(networkInternalUrl).replace(/\/+$/, '')}/oauth/token`, clientId, clientSecret, audience: 'openvibe.events', scope: 'events.subscription.manage', fetch: fetchImpl });
    const call = async (method, path, body) => {
        const res = await fetchImpl(`${base}${path}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401) tokens.invalidate();
        return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
    };
    const attempt = async () => {
        const listed = await call('GET', '/api/v1/subscriptions');
        if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
        const mine = (listed.body.subscriptions || []).filter((s) => s.endpoint === endpoint);
        for (const topic of topics) {
            if (mine.some((s) => s.topic_pattern === topic)) continue;
            const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint, secret });
            if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${topic}: ${r.status} ${r.body.code || ''}`.trim());
            if (r.ok) log.log(`[Events] subscription created: ${r.body.id} (${topic} → ${endpoint})`);
        }
    };
    let i = 0;
    let timer = null;
    let stopped = false;
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const schedule = (ms) => { timer = setTimeout(run, ms); if (timer.unref) timer.unref(); };
    function run() {
        timer = null;
        if (stopped) return;
        attempt().then(() => settle(true), (err) => {
            if (stopped) return;
            if (++i < delays.length) schedule(delays[i]);
            else { log.warn(`[Events] subscriptions not created: ${err.message}`); settle(false); }
        });
    }
    schedule(delays[0] || 0);
    return { topics: [...topics], endpoint, done, stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; settle(false); } };
}

module.exports = { createAccountData, createNetworkSender, startSubscriptions, ACCOUNT_DATA_SCHEMA, TOPICS };
