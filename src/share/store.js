'use strict';
const { randomUUID } = require('node:crypto');
const { newEventId } = require('../core/ids');
const v = require('./validation');
const { migrateShares } = require('./schema');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const PEOPLE_TTL = 60 * 1000;
const key = ref => [ref.service, ref.kind, ref.id];
const where = 'service=$1 AND kind=$2 AND resource_id=$3';
const iso = value => new Date(value).toISOString();
const personKey = subject => `${subject.type}:${subject.id}`;
const unknownPerson = subject => ({ subject, username: null, display_name: null, avatar_url: null });
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
    const peopleCache = new Map();
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
        // Never tell somebody about their own action.
        if (v.equal(recipient, actor)) return;
        await queue(t, 'notify', { kind, to: recipient, actor, ref, ...extra });
    }
    async function permitted(t, ref, s, viewer, audit) {
        const a = v.actor(viewer);
        if (v.equal(a, s.owner_subject)) return { actor: a, staff: false };
        if (viewer.staff === true) { if (audit) await log(t, ref, a, 'staff.manage'); return { actor: a, staff: true }; }
        v.hidden();
    }
    async function owner(t, ref, s, viewer) { return permitted(t, ref, s, viewer, true); }
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
        // A plain snapshot: a page view must never queue behind somebody else's ACL write.
        return db.tx(async t => {
            const s = await t.maybe(`SELECT * FROM shares WHERE ${where}`, key(ref));
            return s ? access(t, ref, s, viewer, edit) : false;
        });
    }
    async function authorize(viewer, ref) { return db.tx(async t => permitted(t, ref, await row(t, ref), viewer, false)); }
    /** Network projections for these subjects, cached for a minute. Unknown, banned and deleted are null. */
    async function projections(subjects) {
        const at = now(), out = new Map(), missing = [];
        for (const s of subjects) {
            const k = personKey(s), hit = peopleCache.get(k);
            if (hit && at - hit.at < PEOPLE_TTL) out.set(k, hit.person);
            else if (!missing.some(m => personKey(m) === k)) missing.push(s);
        }
        for (let i = 0; i < missing.length; i += 500) {
            const chunk = missing.slice(i, i + 500);
            const res = await network.json({ service: 'network', audience: 'openvibe.network', path: '/internal/identity/resolve-batch',
                method: 'POST', json: { subject_ids: chunk.map(s => s.id) } });
            const results = (res && res.results) || {};
            for (const s of chunk) { const p = results[s.id] || null; peopleCache.set(personKey(s), { at, person: p }); out.set(personKey(s), p); }
        }
        return out;
    }
    function personShape(subject, p) {
        if (!p || p.banned || p.deleted || !p.subject || p.subject.type !== 'user' || p.subject.id !== subject.id || typeof p.username !== 'string') return unknownPerson(subject);
        return { subject, username: p.username, display_name: p.display_name || p.username, avatar_url: p.avatar_url || null };
    }
    async function peopleOf(subjects) {
        const uniq = [];
        for (const s of subjects) if (!uniq.some(u => v.equal(u, s))) uniq.push(s);
        if (!uniq.length) return new Map();
        const found = await projections(uniq);
        return new Map(uniq.map(s => [personKey(s), personShape(s, found.get(personKey(s)))]));
    }
    /** One name lookup, sharing the per-caller budget with resolve(). null means no active person by that exact name. */
    async function lookupName(viewer, target) {
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
        if (!found || found.banned || found.deleted || typeof found.username !== 'string' || found.username.toLowerCase() !== name.toLowerCase()) return null;
        try { const subject = v.subject(found.subject); return subject.type === 'user' ? { ...found, subject } : null; } catch { return null; }
    }
    async function resolve(viewer, target) {
        if (typeof target !== 'string') {
            const subject = v.subject(target);
            if (subject.type !== 'user') v.fail(400, 'share.not_person', 'Not an OpenVibe account');
            const person = (await peopleOf([subject])).get(personKey(subject));
            if (!person || !person.username) v.fail(400, 'share.name_not_found', 'No OpenVibe account is that subject');
            return subject;
        }
        const found = await lookupName(viewer, target);
        if (!found) v.fail(400, 'share.name_not_found', `No OpenVibe account is called @${v.name(target)}`);
        return found.subject;
    }
    async function lookup(viewer, name) {
        const found = await lookupName(viewer, name);
        if (!found) return { person: null };
        return { person: { subject: found.subject, username: found.username, display_name: found.display_name || found.username, avatar_url: found.avatar_url || null } };
    }
    async function inputs(viewer, list) {
        if (!Array.isArray(list) || list.length > 100) v.invalid();
        const parsed = list.map(item => {
            if (typeof item === 'string') item = { name: item, role: 'viewer' };
            v.object(item, ['name', 'subject', 'role', 'expires_at']);
            if (Object.hasOwn(item, 'name') === Object.hasOwn(item, 'subject') || !['viewer', 'editor'].includes(item.role)) v.invalid();
            return { item, expires_at: v.expiry(item.expires_at, now()) };
        });
        // Canonical subjects are people too: verify them in one Network batch, never trust the object alone.
        const subjects = parsed.filter(x => Object.hasOwn(x.item, 'subject')).map(x => v.subject(x.item.subject));
        for (const s of subjects) if (s.type !== 'user') v.fail(400, 'share.not_person', 'Not an OpenVibe account');
        const people = subjects.length ? await peopleOf(subjects) : new Map();
        const out = new Map();
        for (const { item, expires_at } of parsed) {
            let subject;
            if (Object.hasOwn(item, 'name')) subject = await resolve(viewer, item.name);
            else {
                subject = v.subject(item.subject);
                const person = people.get(personKey(subject));
                if (!person || !person.username) v.fail(400, 'share.name_not_found', 'No OpenVibe account is that subject');
            }
            // Last entry wins after resolution, so the client's add('@name') can update an existing subject.
            out.set(JSON.stringify(subject), { subject, role: item.role, expires_at });
        }
        return [...out.values()];
    }
    async function revoke(t, ref, s, actor, m, reason) {
        await t.exec(`DELETE FROM share_members WHERE ${where} AND subject=$4`, [...key(ref), m.subject]);
        await log(t, ref, actor, 'member.removed', { subject: m.subject, reason });
        await event(t, ref, s, actor, 'share.revoked', m.subject, { reason: reason === 'expired' ? 'member_expired' : 'member_removed' });
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
    }
    async function grant(t, ref, s, actor, m, notify) {
        if (v.equal(m.subject, s.owner_subject)) v.invalid();
        if (m.expires_at && Date.parse(m.expires_at) <= now()) v.invalid();
        const existing = await t.maybe(`SELECT * FROM share_members WHERE ${where} AND subject=$4`, [...key(ref), m.subject]);
        if (existing && existing.role === m.role && (existing.expires_at ? iso(existing.expires_at) : null) === m.expires_at) return;
        await t.exec(`INSERT INTO share_members(service,kind,resource_id,subject,role,expires_at,added_by,added_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(service,kind,resource_id,subject) DO UPDATE SET role=$5,expires_at=$6,added_by=$7,added_at=$8`, [...key(ref), m.subject, m.role, m.expires_at, actor, timestamp()]);
        await t.exec(`UPDATE share_access_requests SET state='granted' WHERE ${where} AND subject=$4 AND state='pending'`, [...key(ref), m.subject]);
        await log(t, ref, actor, 'member.added', { subject: m.subject, role: m.role });
        await event(t, ref, s, actor, 'share.granted', m.subject, { reason: 'member_added', role: m.role, ...(m.expires_at ? { expires_at: m.expires_at } : {}) });
        // Only a person who was not a member before hears about it; a role or expiry change does not.
        if (!existing && notify) await notice(t, ref, 'share.added', m.subject, actor);
    }
    async function mutate(viewer, input, fn) {
        const ref = v.ref(input);
        return db.tx(async t => {
            const s = await row(t, ref), { actor, staff } = await owner(t, ref, s, viewer);
            await expire(t, ref, s);
            const result = await fn(t, ref, s, actor, staff);
            await bump(t, ref);
            return result;
        });
    }
    async function update(viewer, input, body, { ifMatch } = {}) {
        const ref = v.ref(input); v.object(body, ['audience', 'members', 'notify']);
        if (!Object.keys(body).length) v.invalid();
        if (body.audience !== undefined) v.audience(body.audience);
        if (body.notify !== undefined && typeof body.notify !== 'boolean') v.invalid();
        await authorize(viewer, ref);
        const list = body.members === undefined ? undefined : await inputs(viewer, body.members);
        const notify = body.notify !== false;
        return mutate(viewer, ref, async (t, ref, s, actor, staff) => {
            if (ifMatch !== undefined && ifMatch !== `"${s.revision}"`) v.fail(412, 'share.changed', 'Sharing changed; reload and try again');
            if (staff) {
                // Staff narrow access only: private and removals. No widening, additions or role raises.
                if (body.audience !== undefined && body.audience !== 'private') v.hidden();
                if (list) {
                    const have = await members(t, ref);
                    for (const m of list) {
                        const cur = have.find(x => v.equal(x.subject, m.subject));
                        if (!cur || cur.role !== m.role || (cur.expires_at ? iso(cur.expires_at) : null) !== m.expires_at) v.hidden();
                    }
                }
            }
            if (body.audience !== undefined) await changeAudience(t, ref, s, actor, body.audience);
            if (list) {
                const have = await members(t, ref);
                for (const m of have) if (!list.some(x => v.equal(x.subject, m.subject))) await revoke(t, ref, s, actor, m, 'removed');
                for (const m of list) await grant(t, ref, s, actor, m, notify);
            }
            return snapshot(t, ref, s);
        });
    }
    async function addMembers(viewer, input, list) {
        const ref = v.ref(input);
        // Staff may not add: refuse before touching the name budget or Network.
        if ((await authorize(viewer, ref)).staff) v.hidden();
        if (!Array.isArray(list)) v.invalid();
        const normalized = list.map(item => {
            if (item && typeof item === 'object' && Object.hasOwn(item, 'type')) return { subject: v.subject(item), role: 'viewer' };
            return item;
        });
        const resolved = await inputs(viewer, normalized);
        return mutate(viewer, ref, async (t, ref, s, a, staff) => {
            if (staff) v.hidden();
            const have = await members(t, ref);
            if (new Set([...have, ...resolved].map(m => JSON.stringify(m.subject))).size > 100) v.invalid();
            for (const m of resolved) await grant(t, ref, s, a, m, true);
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
    /** The GET body: people, not bare subjects, plus the caller's own role and pending access requests. */
    async function present(viewer, ref, share) {
        const requests = await db.many(`SELECT * FROM share_access_requests WHERE ${where} AND state='pending' ORDER BY requested_at,id`, key(ref));
        const subjects = [share.owner_subject, ...(share.members || []).map(m => m.subject), ...(share.transfer ? [share.transfer.to] : []), ...requests.map(r => r.subject)];
        let people;
        try { people = await peopleOf(subjects); }
        catch { people = new Map(subjects.map(s => [personKey(s), unknownPerson(s)])); }
        const person = subject => people.get(personKey(subject)) || unknownPerson(subject);
        return { ...share,
            owner: person(share.owner_subject),
            members: (share.members || []).map(m => ({ ...m, ...person(m.subject) })),
            ...(share.transfer ? { transfer: { ...share.transfer, to: person(share.transfer.to) } } : {}),
            you: { subject: v.actor(viewer), role: v.equal(viewer.subject, share.owner_subject) ? 'owner' : 'staff' },
            requests: requests.map(r => ({ id: r.id, ...person(r.subject), requested_at: iso(r.requested_at) })) };
    }
    async function getWithRevision(viewer, input) {
        const ref = v.ref(input);
        const { value, etag } = await db.tx(async t => { const s = await row(t, ref); await owner(t, ref, s, viewer); return { value: await snapshot(t, ref, s), etag: `"${s.revision}"` }; });
        return { value: await present(viewer, ref, value), etag };
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
    async function dismiss(viewer, input, requestId) {
        const ref = v.ref(input); v.uuid(requestId);
        return mutate(viewer, ref, async (t, ref, s, actor) => {
            // Dismissing a request is the owner's call, not a staff moderation action.
            if (!v.equal(actor, s.owner_subject)) v.hidden();
            const request = await t.maybe(`SELECT * FROM share_access_requests WHERE ${where} AND id=$4`, [...key(ref), requestId]);
            if (!request || request.state !== 'pending') v.hidden();
            await t.exec(`UPDATE share_access_requests SET state='dismissed' WHERE id=$1`, [request.id]);
            await log(t, ref, actor, 'access.dismissed', { request_id: request.id, subject: request.subject });
            return snapshot(t, ref, s);
        });
    }
    async function transfer(viewer, input, { to, keep_access = false } = {}) {
        const ref = v.ref(input); if (typeof keep_access !== 'boolean') v.invalid();
        await authorize(viewer, ref);
        let target = to;
        if (to && typeof to === 'object' && !Object.hasOwn(to, 'type')) {
            if (Object.hasOwn(to, 'subject') === Object.hasOwn(to, 'name')) v.invalid();
            target = Object.hasOwn(to, 'subject') ? to.subject : to.name;
        }
        const recipient = await resolve(viewer, target);
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
                    await grant(t, ref, s, a, { subject: from, role: 'viewer', expires_at: null }, true);
                } else await event(t, ref, s, a, 'share.revoked', from, { reason: 'ownership_changed', transfer_id: tr.id });
            }
            await log(t, ref, a, `transfer.${action}`, { transfer_id: tr.id, from: tr.from_subject, to: tr.to_subject });
            const result = transferShape(tr);
            if (action === 'cancelled') await event(t, ref, s, a, 'share.revoked', tr.to_subject, { reason: 'transfer_cancelled', transfer_id: tr.id });
            else await event(t, ref, s, a, `share.transfer.${action}`, tr.to_subject, { transfer: result });
            // The owner hears an answer (including expiry); the recipient hears a cancellation. Never both.
            await notice(t, ref, 'share.transfer.answered', action === 'cancelled' ? tr.to_subject : tr.from_subject, a, { transfer_id: tr.id, state: action });
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
        get: async (viewer, ref) => (await getWithRevision(viewer, ref)).value, getWithRevision, present, lookup, update,
        setAudience: (viewer, ref, audience) => update(viewer, ref, { audience }), addMembers, removeMember, requestAccess, dismiss, transfer,
        accept: (viewer, ref, id) => answer(viewer, ref, id, 'accepted'), decline: (viewer, ref, id) => answer(viewer, ref, id, 'declined'),
        cancel: (viewer, ref, id) => answer(viewer, ref, id, 'cancelled'), expireMembers, sharedWithMe, flush };
    api.router = options => require('./router').router(api, options);
    return api;
}
module.exports = { createShares };
