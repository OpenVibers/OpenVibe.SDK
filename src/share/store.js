'use strict';
const { randomUUID } = require('node:crypto');
const { newEventId } = require('../core/ids');
const v = require('./validation');
const { migrateShares } = require('./schema');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const key = ref => [ref.service, ref.kind, ref.id];
const where = 'service=$1 AND kind=$2 AND resource_id=$3';
const iso = value => new Date(value).toISOString();
const transferShape = row => ({ id: row.id, from: row.from_subject, to: row.to_subject, keep_access: row.keep_access,
    requested_at: iso(row.requested_at), expires_at: iso(row.expires_at), state: row.state });
const memberShape = row => ({ subject: row.subject, role: row.role, ...(row.expires_at ? { expires_at: iso(row.expires_at) } : {}),
    added_by: row.added_by, added_at: iso(row.added_at) });

function createShares({ db, network, events, notify, onOwnerChange, onAudienceChange, now = Date.now, nameLimit = 30, nameWindowMs = 60000 } = {}) {
    if (!db || !db.tx || !network || !network.json || !events || !events.publish || typeof notify !== 'function') {
        throw new TypeError('createShares requires db, network.json, events.publish and notify');
    }
    if (!Number.isInteger(nameLimit) || nameLimit < 1 || !Number.isInteger(nameWindowMs) || nameWindowMs < 1) throw new TypeError('Invalid name rate limit');
    const timestamp = () => iso(now());
    async function row(t, ref) { const s = await t.maybe(`SELECT * FROM shares WHERE ${where} FOR UPDATE`, key(ref)); if (!s) v.hidden(); return s; }
    async function log(t, ref, actor, action, details = {}) {
        await t.exec('INSERT INTO share_log(id,service,kind,resource_id,actor,action,details,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), ...key(ref), actor, action, details, timestamp()]);
    }
    async function queue(t, channel, body) {
        const id = randomUUID();
        await t.exec('INSERT INTO share_deliveries(id,channel,body,created_at) VALUES ($1,$2,$3,$4)', [id, channel, { ...body, delivery_id: id }, timestamp()]);
    }
    async function event(t, ref, s, actor, type, subject, extra = {}) {
        // Build an allow-listed payload; never spread a resource or HTTP body into an event.
        const payload = { ref, actor, owner_subject: s.owner_subject, audience: s.audience, subject, occurred_at: timestamp(), ...extra };
        await queue(t, 'event', { event_id: newEventId(now()), event_type: type, version: 1, timestamp: timestamp(), source: ref.service, actor, subject: { type: ref.kind, id: ref.id }, payload });
    }
    async function notice(t, ref, kind, recipient, actor, extra = {}) {
        await queue(t, 'notify', { kind, to: recipient, actor, ref, ...extra });
    }
    async function owner(t, ref, s, viewer) {
        const a = v.actor(viewer);
        if (v.equal(a, s.owner_subject)) return a;
        if (viewer.staff === true) { await log(t, ref, a, 'staff.manage'); return a; }
        v.hidden();
    }
    async function members(t, ref) {
        return t.many(`SELECT * FROM share_members WHERE ${where} AND (expires_at IS NULL OR expires_at>$4) ORDER BY added_at,subject`, [...key(ref), timestamp()]);
    }
    async function pending(t, ref) { return t.maybe(`SELECT * FROM share_transfers WHERE ${where} AND state='pending' AND expires_at>$4`, [...key(ref), timestamp()]); }
    async function snapshot(t, ref, s) {
        const tr = await pending(t, ref);
        return { ref, owner_subject: s.owner_subject, audience: s.audience, members: (await members(t, ref)).map(memberShape), ...(tr ? { transfer: transferShape(tr) } : {}) };
    }
    async function bump(t, ref) { await t.exec(`UPDATE shares SET revision=revision+1 WHERE ${where}`, key(ref)); }
    async function access(t, ref, s, viewer, edit) {
        const a = viewer?.subject ? v.subject(viewer.subject) : null;
        if (v.equal(a, s.owner_subject)) return true;
        if (a && viewer.staff === true) { await log(t, ref, a, edit ? 'staff.edit' : 'staff.view'); return true; }
        if (!edit && ['public', 'link'].includes(s.audience)) return true;
        if (!a) return false;
        if (!edit) { const tr = await pending(t, ref); if (tr && v.equal(tr.to_subject, a)) return true; }
        if (s.audience !== 'people') return false;
        const m = await t.maybe(`SELECT role FROM share_members WHERE ${where} AND subject=$4 AND (expires_at IS NULL OR expires_at>$5)`, [...key(ref), a, timestamp()]);
        return !!m && (!edit || m.role === 'editor');
    }
    async function check(viewer, input, edit) {
        const ref = v.ref(input);
        return db.tx(async t => {
            const s = await t.maybe(`SELECT * FROM shares WHERE ${where} FOR UPDATE`, key(ref));
            return s ? access(t, ref, s, viewer, edit) : false;
        });
    }
    async function authorize(viewer, ref) { await db.tx(async t => { await owner(t, ref, await row(t, ref), viewer); }); }
    async function resolve(viewer, target) {
        if (typeof target !== 'string') return v.subject(target);
        // A caller-controlled rollback must not refund account-enumeration attempts.
        if (db.inTransaction()) throw new TypeError('Resolve sharing names outside an ambient transaction');
        const name = v.name(target), caller = v.actor(viewer);
        // Persistent and atomic across processes; denied and unknown lookups consume the same budget.
        const start = Math.floor(now() / nameWindowMs) * nameWindowMs;
        const count = await db.one(`INSERT INTO share_name_limits(caller,window_start,attempts) VALUES ($1,$2,1)
            ON CONFLICT(caller) DO UPDATE SET window_start=$2,
            attempts=CASE WHEN share_name_limits.window_start=$2 THEN share_name_limits.attempts+1 ELSE 1 END RETURNING attempts`, [caller, start]);
        if (count.attempts > nameLimit) v.fail(429, 'share.rate_limited', 'Too many name checks');
        let found;
        try { found = await network.json({ service: 'network', audience: 'openvibe.network', path: '/internal/identity/resolve', query: { username: name } }); }
        catch (err) { if (err.status !== 404) throw err; }
        if (!found || found.banned || typeof found.username !== 'string' || found.username.toLowerCase() !== name.toLowerCase()) {
            v.fail(400, 'share.name_not_found', `No OpenVibe account is called @${name}`);
        }
        const s = v.subject(found.subject);
        if (s.type !== 'user') v.fail(400, 'share.name_not_found', `No OpenVibe account is called @${name}`);
        return s;
    }
    async function inputs(viewer, list) {
        if (!Array.isArray(list) || list.length > 100) v.invalid();
        const out = new Map();
        for (let item of list) {
            if (typeof item === 'string') item = { name: item, role: 'viewer' };
            v.object(item, ['name', 'subject', 'role', 'expires_at']);
            if (Object.hasOwn(item, 'name') === Object.hasOwn(item, 'subject') || !['viewer', 'editor'].includes(item.role)) v.invalid();
            const expires_at = v.expiry(item.expires_at, now());
            const subject = await resolve(viewer, Object.hasOwn(item, 'name') ? item.name : item.subject);
            // Last entry wins after resolution, so the client's add('@name') can update an existing subject.
            out.set(JSON.stringify(subject), { subject, role: item.role, expires_at });
        }
        return [...out.values()];
    }
    async function revoke(t, ref, s, actor, m, reason) {
        await t.exec(`DELETE FROM share_members WHERE ${where} AND subject=$4`, [...key(ref), m.subject]);
        await log(t, ref, actor, 'member.removed', { subject: m.subject, reason });
        await event(t, ref, s, actor, 'share.revoked', m.subject, { reason: reason === 'expired' ? 'member_expired' : 'member_removed' });
        await notice(t, ref, 'share.added', m.subject, actor, { action: 'revoked' });
    }
    async function expire(t, ref, s) {
        const actor = { type: 'service', id: ref.service };
        const old = await t.many(`SELECT * FROM share_members WHERE ${where} AND expires_at<=$4`, [...key(ref), timestamp()]);
        for (const m of old) await revoke(t, ref, s, actor, m, 'expired');
        const tr = await t.maybe(`UPDATE share_transfers SET state='expired' WHERE ${where} AND state='pending' AND expires_at<=$4 RETURNING *`, [...key(ref), timestamp()]);
        if (tr) {
            await log(t, ref, actor, 'transfer.expired', { transfer_id: tr.id, from: tr.from_subject, to: tr.to_subject });
            await event(t, ref, s, actor, 'share.revoked', tr.to_subject, { reason: 'transfer_expired', transfer_id: tr.id });
            await notice(t, ref, 'share.transfer.answered', tr.from_subject, actor, { transfer_id: tr.id, state: 'expired' });
        }
        if (old.length || tr) await bump(t, ref);
    }
    async function changeAudience(t, ref, s, actor, audience) {
        if (s.audience === audience) return;
        const before = s.audience;
        await t.exec(`UPDATE shares SET audience=$4 WHERE ${where}`, [...key(ref), audience]); s.audience = audience;
        if (onAudienceChange) await onAudienceChange(ref, audience, t);
        await log(t, ref, actor, 'audience.changed', { from: before, to: audience });
        // The owner-targeted metadata event lets Network invalidate its audience projection.
        await event(t, ref, s, actor, ['public', 'link', 'people'].includes(audience) ? 'share.granted' : 'share.revoked', s.owner_subject, { reason: 'audience_changed' });
        await notice(t, ref, 'share.added', s.owner_subject, actor, { action: 'audience_changed', audience });
    }
    async function grant(t, ref, s, actor, m) {
        if (v.equal(m.subject, s.owner_subject)) v.invalid();
        if (m.expires_at && Date.parse(m.expires_at) <= now()) v.invalid();
        const existing = await t.maybe(`SELECT * FROM share_members WHERE ${where} AND subject=$4`, [...key(ref), m.subject]);
        if (existing && existing.role === m.role && (existing.expires_at ? iso(existing.expires_at) : null) === m.expires_at) return;
        await t.exec(`INSERT INTO share_members(service,kind,resource_id,subject,role,expires_at,added_by,added_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(service,kind,resource_id,subject) DO UPDATE SET role=$5,expires_at=$6,added_by=$7,added_at=$8`, [...key(ref), m.subject, m.role, m.expires_at, actor, timestamp()]);
        await t.exec(`UPDATE share_access_requests SET state='granted' WHERE ${where} AND subject=$4 AND state='pending'`, [...key(ref), m.subject]);
        await log(t, ref, actor, 'member.added', { subject: m.subject, role: m.role });
        await event(t, ref, s, actor, 'share.granted', m.subject, { reason: 'member_added', role: m.role, ...(m.expires_at ? { expires_at: m.expires_at } : {}) });
        await notice(t, ref, 'share.added', m.subject, actor);
    }
    async function mutate(viewer, input, fn) {
        const ref = v.ref(input);
        return db.tx(async t => {
            const s = await row(t, ref), actor = await owner(t, ref, s, viewer);
            await expire(t, ref, s);
            const result = await fn(t, ref, s, actor);
            await bump(t, ref);
            return result;
        });
    }
    async function update(viewer, input, body, { ifMatch } = {}) {
        const ref = v.ref(input); v.object(body, ['audience', 'members']);
        if (!Object.keys(body).length) v.invalid();
        if (body.audience !== undefined) v.audience(body.audience);
        await authorize(viewer, ref);
        const list = body.members === undefined ? undefined : await inputs(viewer, body.members);
        return mutate(viewer, ref, async (t, ref, s, actor) => {
            if (ifMatch !== undefined && ifMatch !== `"${s.revision}"`) v.fail(412, 'share.changed', 'Sharing changed; reload and try again');
            if (body.audience !== undefined) await changeAudience(t, ref, s, actor, body.audience);
            if (list) {
                const have = await members(t, ref);
                for (const m of have) if (!list.some(x => v.equal(x.subject, m.subject))) await revoke(t, ref, s, actor, m, 'removed');
                for (const m of list) await grant(t, ref, s, actor, m);
            }
            return snapshot(t, ref, s);
        });
    }
    async function addMembers(viewer, input, list) {
        const ref = v.ref(input); await authorize(viewer, ref);
        if (!Array.isArray(list)) v.invalid();
        const normalized = list.map(item => {
            if (item && typeof item === 'object' && Object.hasOwn(item, 'type')) return { subject: v.subject(item), role: 'viewer' };
            return item;
        });
        const resolved = await inputs(viewer, normalized);
        return mutate(viewer, ref, async (t, ref, s, a) => {
            const have = await members(t, ref);
            if (new Set([...have, ...resolved].map(m => JSON.stringify(m.subject))).size > 100) v.invalid();
            for (const m of resolved) await grant(t, ref, s, a, m);
            return snapshot(t, ref, s);
        });
    }
    async function removeMember(viewer, ref, input) {
        const subject = v.subject(input);
        return mutate(viewer, ref, async (t, ref, s, a) => {
            const m = await t.maybe(`SELECT * FROM share_members WHERE ${where} AND subject=$4`, [...key(ref), subject]);
            if (m) await revoke(t, ref, s, a, m, 'removed');
            return snapshot(t, ref, s);
        });
    }
    async function register(input, { owner_subject, audience = 'private' }) {
        const ref = v.ref(input), a = v.subject(owner_subject); v.audience(audience);
        return db.tx(async t => {
            const made = await t.exec('INSERT INTO shares(service,kind,resource_id,owner_subject,audience) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [...key(ref), a, audience]);
            const s = await row(t, ref);
            if (!v.equal(s.owner_subject, a) || s.audience !== audience) v.fail(409, 'share.exists', 'Sharing already registered');
            if (made) await log(t, ref, a, 'registered', { audience });
            return snapshot(t, ref, s);
        });
    }
    async function getWithRevision(viewer, input) {
        const ref = v.ref(input);
        return db.tx(async t => { const s = await row(t, ref); await owner(t, ref, s, viewer); return { value: await snapshot(t, ref, s), etag: `"${s.revision}"` }; });
    }
    async function requestAccess(viewer, input) {
        const ref = v.ref(input), a = v.actor(viewer);
        return db.tx(async t => {
            const s = await row(t, ref);
            if (s.audience !== 'people') v.hidden();
            if (await access(t, ref, s, viewer, false)) v.fail(409, 'share.already_allowed', 'Access already allowed');
            const existing = await t.maybe(`SELECT * FROM share_access_requests WHERE ${where} AND subject=$4 AND state='pending'`, [...key(ref), a]);
            const request = existing || await t.one(`INSERT INTO share_access_requests VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`, [randomUUID(), ...key(ref), a, timestamp()]);
            if (!existing) {
                await log(t, ref, a, 'access.requested');
                await notice(t, ref, 'share.access_requested', s.owner_subject, a, { request_id: request.id });
            }
            return { id: request.id, subject: request.subject, requested_at: iso(request.requested_at), state: request.state };
        });
    }
    async function transfer(viewer, input, { to, keep_access = false } = {}) {
        const ref = v.ref(input); if (typeof keep_access !== 'boolean') v.invalid();
        await authorize(viewer, ref); const recipient = await resolve(viewer, to);
        return mutate(viewer, ref, async (t, ref, s, a) => {
            // Staff may moderate, but cannot give somebody else's ownership away.
            if (!v.equal(a, s.owner_subject)) v.hidden();
            if (v.equal(recipient, s.owner_subject)) v.invalid();
            if (await pending(t, ref)) v.fail(409, 'share.transfer_pending', 'A transfer is already pending');
            const tr = await t.one(`INSERT INTO share_transfers VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
                [randomUUID(), ...key(ref), s.owner_subject, recipient, keep_access, timestamp(), iso(now() + WEEK)]);
            const result = transferShape(tr);
            await log(t, ref, a, 'transfer.requested', { transfer_id: tr.id, from: tr.from_subject, to: recipient, keep_access });
            await event(t, ref, s, a, 'share.transfer.requested', recipient, { transfer: result });
            await notice(t, ref, 'share.transfer.requested', recipient, a, { transfer_id: tr.id });
            return result;
        });
    }
    async function answer(viewer, input, transferId, action) {
        const ref = v.ref(input), a = v.actor(viewer); v.uuid(transferId);
        return db.tx(async t => {
            const s = await row(t, ref);
            const tr = await t.maybe(`SELECT * FROM share_transfers WHERE ${where} AND id=$4`, [...key(ref), transferId]);
            if (!tr || (action === 'cancelled' ? !v.equal(a, s.owner_subject) : !v.equal(a, tr.to_subject))) v.hidden();
            if (tr.state !== 'pending' || Date.parse(tr.expires_at) <= now() || !v.equal(s.owner_subject, tr.from_subject)) {
                v.fail(409, 'share.transfer_inactive', 'Transfer is no longer pending');
            }
            await expire(t, ref, s);
            await t.exec('UPDATE share_transfers SET state=$2 WHERE id=$1', [tr.id, action]); tr.state = action;
            if (action === 'accepted') {
                if (tr.keep_access) {
                    const remaining = (await members(t, ref)).filter(m => !v.equal(m.subject, a) && !v.equal(m.subject, tr.from_subject));
                    if (remaining.length >= 100) v.fail(409, 'share.member_limit', 'Remove a member before retaining the former owner');
                }
                const from = s.owner_subject;
                await t.exec(`DELETE FROM share_members WHERE ${where} AND subject IN ($4,$5)`, [...key(ref), from, a]);
                await t.exec(`UPDATE shares SET owner_subject=$4 WHERE ${where}`, [...key(ref), a]); s.owner_subject = a;
                if (onOwnerChange) await onOwnerChange(ref, from, a, t);
                await log(t, ref, a, 'ownership.outgoing', { transfer_id: tr.id, from, to: a });
                await log(t, ref, a, 'ownership.incoming', { transfer_id: tr.id, from, to: a });
                if (tr.keep_access) {
                    if (s.audience === 'private') await changeAudience(t, ref, s, a, 'people');
                    await grant(t, ref, s, a, { subject: from, role: 'viewer', expires_at: null });
                } else await event(t, ref, s, a, 'share.revoked', from, { reason: 'ownership_changed', transfer_id: tr.id });
            }
            await log(t, ref, a, `transfer.${action}`, { transfer_id: tr.id, from: tr.from_subject, to: tr.to_subject });
            const result = transferShape(tr);
            if (action === 'cancelled') await event(t, ref, s, a, 'share.revoked', tr.to_subject, { reason: 'transfer_cancelled', transfer_id: tr.id });
            else await event(t, ref, s, a, `share.transfer.${action}`, tr.to_subject, { transfer: result });
            await notice(t, ref, 'share.transfer.answered', tr.from_subject, a, { transfer_id: tr.id, state: action });
            await notice(t, ref, 'share.transfer.answered', tr.to_subject, a, { transfer_id: tr.id, state: action });
            await bump(t, ref);
            return result;
        });
    }
    async function expireMembers({ limit = 100 } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) v.invalid();
        const refs = await db.many(`SELECT service,kind,resource_id AS id FROM share_members WHERE expires_at<=$1
            UNION SELECT service,kind,resource_id AS id FROM share_transfers WHERE state='pending' AND expires_at<=$1 LIMIT $2`, [timestamp(), limit]);
        for (const ref of refs) await db.tx(async t => { const s = await row(t, ref); await expire(t, ref, s); });
        return refs.length;
    }
    async function sharedWithMe(viewer, { service, limit = 50, cursor } = {}) {
        const a = v.actor(viewer);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) v.invalid();
        let after = ['', '', ''];
        if (cursor) {
            try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { v.invalid(); }
            if (!Array.isArray(after) || after.length !== 3 || after.some(x => typeof x !== 'string' || x.length > 200)) v.invalid();
        }
        // One SQL snapshot: no membership checked in one state and returned in another.
        const rows = await db.many(`SELECT s.*,m.role,m.added_at,tr.id AS transfer_id,tr.from_subject,tr.to_subject,tr.keep_access,tr.requested_at,tr.expires_at,tr.state
            FROM shares s LEFT JOIN share_members m ON m.service=s.service AND m.kind=s.kind AND m.resource_id=s.resource_id
                AND m.subject=$1 AND (m.expires_at IS NULL OR m.expires_at>$2)
            LEFT JOIN share_transfers tr ON tr.service=s.service AND tr.kind=s.kind AND tr.resource_id=s.resource_id
                AND tr.to_subject=$1 AND tr.state='pending' AND tr.expires_at>$2
            WHERE s.owner_subject<>$1 AND ($3::text IS NULL OR s.service=$3)
                AND ((s.audience='people' AND m.subject IS NOT NULL) OR tr.id IS NOT NULL)
                AND (s.service,s.kind,s.resource_id)>($4,$5,$6)
            ORDER BY s.service,s.kind,s.resource_id LIMIT $7`, [a, timestamp(), service || null, ...after, limit + 1]);
        const page = rows.slice(0, limit);
        return { items: page.map(s => ({ ref: { service: s.service, kind: s.kind, id: s.resource_id }, owner_subject: s.owner_subject,
            audience: s.audience, role: s.audience === 'people' && s.role ? s.role : 'viewer', shared_at: iso(s.added_at || s.requested_at),
            ...(s.transfer_id ? { transfer: transferShape({ ...s, id: s.transfer_id }) } : {}) })),
        next_cursor: rows.length > limit ? Buffer.from(JSON.stringify([page.at(-1).service, page.at(-1).kind, page.at(-1).resource_id])).toString('base64url') : null };
    }
    async function flush({ limit = 100 } = {}) {
        if (db.inTransaction()) throw new TypeError('Flush sharing deliveries outside an ambient transaction');
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) v.invalid();
        let sent = 0;
        for (; sent < limit; sent++) {
            const delivered = await db.tx(async t => {
                const d = await t.maybe('SELECT * FROM share_deliveries WHERE delivered_at IS NULL ORDER BY sequence LIMIT 1 FOR UPDATE');
                if (!d) return false;
                const { delivery_id, ...body } = d.body;
                if (d.channel === 'event') await events.publish(body);
                else await notify({ ...body, delivery_id });
                await t.exec('UPDATE share_deliveries SET delivered_at=$2 WHERE id=$1', [d.id, timestamp()]);
                return true;
            }, { retries: 0 });
            if (!delivered) break;
        }
        return sent;
    }
    const api = { register, migrate: () => migrateShares(db), canView: (viewer, ref) => check(viewer, ref, false), canEdit: (viewer, ref) => check(viewer, ref, true),
        get: async (viewer, ref) => (await getWithRevision(viewer, ref)).value, getWithRevision, update,
        setAudience: (viewer, ref, audience) => update(viewer, ref, { audience }), addMembers, removeMember, requestAccess, transfer,
        accept: (viewer, ref, id) => answer(viewer, ref, id, 'accepted'), decline: (viewer, ref, id) => answer(viewer, ref, id, 'declined'),
        cancel: (viewer, ref, id) => answer(viewer, ref, id, 'cancelled'), expireMembers, sharedWithMe, flush };
    api.router = options => require('./router').router(api, options);
    return api;
}
module.exports = { createShares };
