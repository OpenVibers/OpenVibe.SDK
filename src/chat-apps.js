'use strict';
/**
 * openvibe-sdk/chat-apps — the three chat apps (Telegram, Discord, Slack) in one place.
 *
 *   The checks     Every delivery is checked before it is read: Telegram's secret token, Slack's signing
 *                  secret (v0 over "v0:<timestamp>:<body>", the timestamp within five minutes) and
 *                  Discord's Ed25519 signature over "<timestamp><body>" (the application's public key).
 *                  The code came from OpenVibe.Watch, which has checked these deliveries since 2026-11-03
 *                  (Watch #194 and #195); it lives here so every service that answers a chat app reads it
 *                  the same way. The comparison is constant time and a wrong signature is only ever "no".
 *   The buttons    An approval arrives in the chat as buttons. What the buttons carry is a callback token:
 *                  "v1.<base64url(payload)>.<hex hmac>" over the payload with the app's own secret, with an
 *                  expiry inside the payload. It is signed once, used once and expires; a token that was
 *                  changed, replayed or is too old is refused.
 *   The messages   Each app's payload becomes the same small shape: who said it, where, what they said and
 *                  whether they said it to the bot. A service that answers the bot works with that shape and
 *                  never with the app's own JSON.
 *
 *   const { verifyDelivery, parseTelegramUpdate } = require('openvibe-sdk/chat-apps');
 *   if (!verifyDelivery({ provider: 'telegram', secret, headers: req.headers })) return res.sendStatus(401);
 *   const message = parseTelegramUpdate(req.body, { botUsername: 'openvibe_bot' });
 */
const crypto = require('crypto');

const TOLERANCE_SEC = 300;
// The DER prefix of an Ed25519 public key (SubjectPublicKeyInfo), so the 32 raw bytes Discord shows become a key object.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
// How long one message may be in each app: Telegram 4096, Discord 2000, Slack 3000 (a block's text).
const APP_LIMITS = Object.freeze({ telegram: 4096, discord: 2000, slack: 3000 });
const PROVIDERS = Object.freeze(['telegram', 'discord', 'slack']);

function safeEqual(a, b) {
    const x = Buffer.from(String(a == null ? '' : a));
    const y = Buffer.from(String(b == null ? '' : b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const fresh = (ts, nowMs) => /^\d{1,12}$/.test(String(ts)) && Math.abs(Math.floor(nowMs / 1000) - Number(ts)) <= TOLERANCE_SEC;

/**
 * Telegram's secret token: the header setWebhook's secret_token carries, compared in constant time.
 * The token is the app's own (setWebhook), 1–256 characters of A–Z, a–z, 0–9, _ and -.
 */
function verifyTelegram({ secret, headers = {} } = {}) {
    if (!secret) return false;
    const given = headers['x-telegram-bot-api-secret-token'];
    if (given == null) return false;
    return safeEqual(String(given), String(secret));
}

/**
 * Slack's request signing: v0 over "v0:<timestamp>:<body>", the timestamp within five minutes.
 * Slack's retry of a delivery it did not see answered carries X-Slack-Retry-Num; the check is the same.
 */
function verifySlack({ secret, raw, headers = {}, now = Date.now() } = {}) {
    if (!secret) return false;
    const ts = String(headers['x-slack-request-timestamp'] || '');
    const sig = String(headers['x-slack-signature'] || '');
    if (!fresh(ts, now) || !sig.startsWith('v0=')) return false;
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw == null ? '' : raw), 'utf8');
    return safeEqual(sig, `v0=${hmacHex(secret, Buffer.concat([Buffer.from(`v0:${ts}:`), body]))}`);
}

/**
 * Discord's interaction signing: Ed25519 over "<timestamp><body>" with the application's public key
 * (64 hex characters), the timestamp within five minutes.
 */
function verifyDiscord({ publicKey, raw, headers = {}, now = Date.now() } = {}) {
    const ts = String(headers['x-signature-timestamp'] || '');
    const sig = String(headers['x-signature-ed25519'] || '');
    if (!publicKey || !fresh(ts, now) || !/^[0-9a-f]{128}$/i.test(sig) || !/^[0-9a-f]{64}$/i.test(String(publicKey))) return false;
    try {
        const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(String(publicKey), 'hex')]), format: 'der', type: 'spki' });
        const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw == null ? '' : raw), 'utf8');
        return crypto.verify(null, Buffer.concat([Buffer.from(ts), body]), key, Buffer.from(sig, 'hex'));
    } catch { return false; }
}

/**
 * The delivery carries the app's own proof. The provider names how it is checked: telegram (the secret
 * token), slack (the signing secret) or discord (the application's public key). A provider this does not
 * know is never verified.
 */
function verifyDelivery({ provider, secret, publicKey, raw, headers = {}, now = Date.now() } = {}) {
    if (provider === 'telegram') return verifyTelegram({ secret, headers });
    if (provider === 'slack') return verifySlack({ secret, raw, headers, now });
    if (provider === 'discord') return verifyDiscord({ publicKey, raw, headers, now });
    return false;
}

/**
 * A callback token: the payload, signed with the app's own secret. The payload is the base64url of its
 * JSON; the signature is an HMAC-SHA256 over "v1.<payload>" in hex. The payload carries its own expiry
 * (exp, in milliseconds since the epoch).
 */
function signCallback({ secret, payload } = {}) {
    if (!secret) throw new TypeError('signCallback: the app needs a secret of its own');
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64url');
    return `v1.${body}.${hmacHex(secret, `v1.${body}`)}`;
}

/**
 * The payload of a callback token, or null when the token is not ours, was changed, was already used
 * (the caller marks it used) or has expired. maxAgeMs is the window when the payload has no exp of its own.
 */
function verifyCallback({ secret, token, now = Date.now(), maxAgeMs = 15 * 60 * 1000 } = {}) {
    if (!secret || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const [, body, sig] = parts;
    if (!/^[0-9a-f]{64}$/.test(sig)) return null;
    if (!safeEqual(sig, hmacHex(secret, `v1.${body}`))) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) { if (now >= payload.exp) return null; }
    else if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now || now - payload.iat > maxAgeMs) return null;
    return payload;
}

const text = (v, max = 4000) => String(v == null ? '' : v).slice(0, max);
const chatTypeOf = (t) => (t === 'private' || t === 'dm' ? 'private'
    : t === 'group' || t === 'supergroup' ? 'group'
        : t === 'channel' ? 'channel' : 'unknown');

/** A command word at the start of a message: "/link now" → command 'link', args 'now'. */
function commandOf(body) {
    const m = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(body || '').trim());
    if (!m) return null;
    return { command: m[1].toLowerCase(), args: (m[3] || '').trim(), mentionName: m[2] ? m[2].toLowerCase() : null };
}

/**
 * A Telegram update (a new message) as the common shape. An edit of a message that was already
 * answered and a channel post are not answered: only `update.message` is read. A callback query
 * (a button) is the same shape with kind 'button'. A message from a bot is never read.
 */
function parseTelegramUpdate(update, { botUsername = null, botUserId = null } = {}) {
    if (!update || typeof update !== 'object') return null;
    if (update.callback_query) {
        const q = update.callback_query;
        const from = q.from || {};
        return {
            app: 'telegram', kind: 'button', chatId: String((q.message && q.message.chat && q.message.chat.id) || ''),
            chatType: chatTypeOf(q.message && q.message.chat && q.message.chat.type), userId: String(from.id || ''),
            userName: text(from.username, 64) || null, text: '', command: null, args: '', mention: true, replyToBot: false,
            attachments: [], button: { id: text(q.data, 200) }, messageId: String((q.message && q.message.message_id) || ''), raw: q,
        };
    }
    const m = update.message;
    if (m && m.from && m.from.is_bot) return null;
    if (!m) return null;
    const chat = m.chat || {};
    const from = m.from || {};
    const body = text(m.text != null ? m.text : m.caption, 4000);
    const cmd = commandOf(body);
    if (cmd && cmd.mentionName && (!botUsername || cmd.mentionName !== String(botUsername).toLowerCase())) return null;
    const replyUser = m.reply_to_message && m.reply_to_message.from;
    const mentioned = Boolean(botUsername && body.toLowerCase().includes(`@${String(botUsername).toLowerCase()}`))
        || Boolean(botUserId && replyUser && String(replyUser.id) === String(botUserId));
    const attachments = [];
    if (m.document && m.document.file_id) attachments.push({ kind: 'file', id: m.document.file_id, name: text(m.document.file_name, 120) || null, mime: text(m.document.mime_type, 80) || null });
    return {
        app: 'telegram', kind: cmd ? 'command' : mentioned ? 'mention' : 'message',
        chatId: String(chat.id == null ? '' : chat.id),
        chatType: chatTypeOf(chat.type), userId: String(from.id == null ? '' : from.id),
        userName: text(from.username, 64) || text(from.first_name, 64) || null,
        text: body, command: cmd ? cmd.command : null, args: cmd ? cmd.args : '', mention: mentioned,
        replyToBot: Boolean(replyUser && botUserId && String(replyUser.id) === String(botUserId)),
        attachments, button: null, messageId: String(m.message_id == null ? '' : m.message_id), raw: m,
    };
}

/**
 * A Discord interaction (a ping, a slash command, a button) as the common shape. The application's own
 * user id says whether the bot was mentioned; a guild id says it was not a private conversation.
 */
function parseDiscordInteraction(interaction, { botUserId = null } = {}) {
    if (!interaction || typeof interaction !== 'object') return null;
    const member = interaction.member || {};
    const user = interaction.user || member.user || {};
    const channel = interaction.channel || {};
    const guildId = interaction.guild_id || (interaction.guild && interaction.guild.id) || null;
    const base = {
        app: 'discord', chatId: String(channel.id || interaction.channel_id || ''),
        chatType: guildId ? 'group' : 'private', userId: String(user.id == null ? '' : user.id),
        userName: text(user.global_name || user.username, 64) || null, text: '', command: null, args: '',
        mention: false, replyToBot: false, attachments: [], button: null,
        requestId: text(interaction.id, 64) || null, raw: interaction,
    };
    if (interaction.type === 1) return { ...base, kind: 'ping' };
    if (interaction.type === 3) {
        const data = interaction.data || {};
        const values = Array.isArray(data.values) ? data.values : [];
        return { ...base, kind: 'button', button: { id: text(data.custom_id, 200), value: values.length ? text(values[0], 200) : null } };
    }
    if (interaction.type === 2) {
        const data = interaction.data || {};
        const options = Array.isArray(data.options) ? data.options : [];
        const opts = options.map((o) => `${o.name}=${text(o.value, 500)}`).join(' ');
        return { ...base, kind: 'command', command: text(data.name, 60).toLowerCase() || null, args: opts, mention: true };
    }
    if (interaction.type === 4) return { ...base, kind: 'unknown' };
    return { ...base, kind: 'unknown' };
}

/**
 * A Slack event (a message, an app_mention) as the common shape. A message in a channel is a group; a
 * message to the bot in a direct conversation is private; a thread's parent (thread_ts) means it is a reply.
 */
function parseSlackEvent(event, { botUserId = null } = {}) {
    if (!event || typeof event !== 'object') return null;
    if (event.bot_id || (botUserId && event.user === botUserId)) return null;
    if (event.type === 'app_mention') {
        const user = event.user || '';
        return {
            app: 'slack', kind: 'mention', chatId: text(event.channel, 64), chatType: 'group', userId: text(user, 64),
            userName: null, text: text(event.text, 4000), command: null, args: '', mention: true, replyToBot: true,
            attachments: [], button: null, threadTs: text(event.thread_ts, 64) || null, raw: event,
        };
    }
    if (event.type !== 'message') return null;
    // A file a person shares is a message; an edit of one already answered, a join and a bot's own
    // message are not. Reading an edit would answer twice, and a join is not something said.
    if (event.subtype && event.subtype !== 'file_share') return null;
    if (botUserId && event.user === botUserId) return null;   // the bot's own message
    const m = event;
    const channelType = text(event.channel_type, 20);
    const cmd = commandOf(m.text);
    const files = Array.isArray(m.files) ? m.files.map((f) => ({ kind: 'file', id: text(f.id, 80), name: text(f.name, 120) || null, url: text(f.url_private || f.permalink, 300) || null })) : [];
    return {
        app: 'slack', kind: cmd ? 'command' : channelType === 'im' ? 'message' : 'message',
        chatId: text(event.channel, 64), chatType: channelType === 'im' ? 'private' : channelType === 'channel' ? 'channel' : 'group',
        userId: text(m.user, 64), userName: null, text: text(m.text, 4000), command: cmd ? cmd.command : null,
        args: cmd ? cmd.args : '', mention: Boolean(botUserId && String(m.text || '').includes(`<@${botUserId}>`)), replyToBot: Boolean(m.thread_ts && botUserId && m.parent_user_id === botUserId),
        attachments: files, button: null, threadTs: text(m.thread_ts, 64) || null, raw: m,
    };
}

/**
 * A Slack button press: the interactivity payload with its actions (each with a custom id and a value).
 */
function parseSlackInteraction(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const action = actions[0] || null;
    const user = payload.user || {};
    return {
        app: 'slack', kind: action ? 'button' : 'unknown', chatId: text(payload.channel && payload.channel.id, 64),
        chatType: payload.channel && payload.channel.is_im ? 'private' : 'group', userId: text(user.id, 64),
        userName: text(user.name || user.username, 64) || null, text: '', command: null, args: '', mention: false,
        replyToBot: false, attachments: [], button: action ? { id: text(action.action_id, 200), value: text(action.value, 200) } : null,
        raw: payload,
    };
}

/**
 * One answer in the app's own shape: the text split into pieces the app accepts, never longer than its
 * limit, and never cutting a word in half when a line break can do it.
 */
function splitText(app, body, limit) {
    const max = Math.max(1, Math.min(Number(limit) || APP_LIMITS[app] || 2000, 10000));
    const s = String(body == null ? '' : body);
    if (!s) return [];
    const out = [];
    let rest = s;
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max);
        if (cut < Math.floor(max / 2)) cut = rest.lastIndexOf(' ', max);
        if (cut < Math.floor(max / 2)) cut = max;
        out.push(rest.slice(0, cut).replace(/\s+$/, ''));
        rest = rest.slice(cut).replace(/^[ \t]+/, '');
    }
    if (rest) out.push(rest);
    return out;
}

/** Compact signed row reference: 44 ASCII bytes, under Telegram's 64-byte limit.
 * Identity, action, expiry and consumption are checked atomically against the caller's stored row. */
function signButton({ secret, id }) {
    if (!secret || !/^[A-Za-z0-9_-]{16}$/.test(id)) throw new TypeError('invalid button');
    const body = `b1.${id}`;
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest().subarray(0, 18).toString('base64url')}`;
}
function verifyButton({ secret, token }) {
    if (!secret || typeof token !== 'string' || !/^b1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24}$/.test(token)) return null;
    const id = token.split('.')[1];
    return safeEqual(token, signButton({ secret, id })) ? id : null;
}
function parseDiscordMessage(m, { botUserId } = {}) {
    if (!m || !m.author || m.author.bot || m.webhook_id) return null;
    const cmd = commandOf(m.content);
    return { app: 'discord', kind: cmd ? 'command' : 'message', chatId: String(m.channel_id || ''),
        chatType: m.guild_id ? 'group' : 'private', userId: String(m.author.id || ''), userName: m.author.username || null,
        text: text(m.content), command: cmd ? cmd.command : null, args: cmd ? cmd.args : '',
        mention: Boolean(botUserId && (m.mentions || []).some(u => String(u.id) === String(botUserId))),
        replyToBot: Boolean(botUserId && m.referenced_message && m.referenced_message.author && String(m.referenced_message.author.id) === String(botUserId)),
        messageId: String(m.id || ''), attachments: (m.attachments || []).map(f => ({ kind: 'file', url: f.url, name: f.filename })), button: null, raw: m };
}

module.exports = {
    verifyTelegram, verifySlack, verifyDiscord, verifyDelivery,
    signCallback, verifyCallback,
    parseTelegramUpdate, parseDiscordInteraction, parseSlackEvent, parseSlackInteraction,
    splitText, commandOf, safeEqual, signButton, verifyButton, parseDiscordMessage,
    APP_LIMITS, PROVIDERS, TOLERANCE_SEC,
};
