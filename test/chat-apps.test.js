'use strict';
/**
 * openvibe-sdk/chat-apps — the three chat apps' checks, their button callbacks and their messages.
 *
 * The Discord key pair is made here, so the test signs exactly as Discord signs: Ed25519 over
 * "<timestamp><body>".
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./helpers');
const {
    verifyTelegram, verifySlack, verifyDiscord, verifyDelivery,
    signCallback, verifyCallback,
    parseTelegramUpdate, parseDiscordInteraction, parseSlackEvent, parseSlackInteraction,
    splitText,
} = require('../src/chat-apps');

const NOW = 1_800_000_000_000;
const stamp = (ms = NOW) => String(Math.floor(ms / 1000));

function slackSignature(secret, body, ts = stamp()) {
    return `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:`).update(body).digest('hex')}`;
}

const discordKeys = crypto.generateKeyPairSync('ed25519');
const discordPublicHex = discordKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
function discordSignature(body, ts = stamp(), key = discordKeys.privateKey) {
    return crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), key).toString('hex');
}

run([
    ['Telegram: the secret token is compared in constant time', () => {
        assert.equal(verifyTelegram({ secret: 'tg-secret', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' } }), true);
        assert.equal(verifyTelegram({ secret: 'tg-secret', headers: { 'x-telegram-bot-api-secret-token': 'tg-secrex' } }), false);
        assert.equal(verifyTelegram({ secret: 'tg-secret', headers: {} }), false);
        assert.equal(verifyTelegram({ secret: 'tg-secret', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret-longer' } }), false);
        assert.equal(verifyTelegram({ secret: '', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' } }), false);
    }],

    ['Slack: v0 over "v0:<timestamp>:<body>", within five minutes', () => {
        const secret = 'a'.repeat(32);
        const body = '{"type":"url_verification"}';
        const ts = stamp();
        assert.equal(verifySlack({ secret, raw: body, headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, body, ts) }, now: NOW }), true);
        // another body with the same signature
        assert.equal(verifySlack({ secret, raw: '{"type":"event_callback"}', headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, body, ts) }, now: NOW }), false);
        // too old
        const old = stamp(NOW - 301 * 1000);
        assert.equal(verifySlack({ secret, raw: body, headers: { 'x-slack-request-timestamp': old, 'x-slack-signature': slackSignature(secret, body, old) }, now: NOW }), false);
        // no timestamp
        assert.equal(verifySlack({ secret, raw: body, headers: { 'x-slack-signature': slackSignature(secret, body) }, now: NOW }), false);
    }],

    ['Discord: Ed25519 over "<timestamp><body>"', () => {
        const body = '{"type":2,"data":{"name":"link"}}';
        const ts = stamp();
        assert.equal(verifyDiscord({ publicKey: discordPublicHex, raw: body, headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': discordSignature(body, ts) }, now: NOW }), true);
        assert.equal(verifyDiscord({ publicKey: discordPublicHex, raw: '{"type":2}', headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': discordSignature(body, ts) }, now: NOW }), false);
        // another key
        const other = crypto.generateKeyPairSync('ed25519');
        assert.equal(verifyDiscord({ publicKey: discordPublicHex, raw: body, headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': discordSignature(body, ts, other.privateKey) }, now: NOW }), false);
        // too old
        const old = stamp(NOW - 400 * 1000);
        assert.equal(verifyDiscord({ publicKey: discordPublicHex, raw: body, headers: { 'x-signature-timestamp': old, 'x-signature-ed25519': discordSignature(body, old) }, now: NOW }), false);
    }],

    ['the delivery is checked with the provider it names, and an unknown provider is never checked', () => {
        const body = 'hello';
        const ts = stamp();
        assert.equal(verifyDelivery({ provider: 'telegram', secret: 's', headers: { 'x-telegram-bot-api-secret-token': 's' } }), true);
        assert.equal(verifyDelivery({ provider: 'slack', secret: 's', raw: body, headers: {} }), false);
        assert.equal(verifyDelivery({ provider: 'whatsapp', secret: 's', headers: { 'x-telegram-bot-api-secret-token': 's' } }), false);
        assert.equal(verifyDelivery({ provider: 'discord', publicKey: discordPublicHex, raw: body, headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': discordSignature(body, ts) }, now: NOW }), true);
    }],

    ['a button callback is signed once, read once and expires', () => {
        const secret = 'own-secret';
        const token = signCallback({ secret, payload: { exp: NOW + 60_000, act: 'approve', id: 'apr_1' } });
        assert.deepEqual(verifyCallback({ secret, token, now: NOW }), { exp: NOW + 60_000, act: 'approve', id: 'apr_1' });
        // another secret
        assert.equal(verifyCallback({ secret: 'other', token, now: NOW }), null);
        // a changed payload
        const parts = token.split('.');
        const changed = `v1.${Buffer.from(JSON.stringify({ exp: NOW + 60_000, act: 'approve', id: 'apr_2' })).toString('base64url')}.${parts[2]}`;
        assert.equal(verifyCallback({ secret, token: changed, now: NOW }), null);
        // expired
        assert.equal(verifyCallback({ secret, token: signCallback({ secret, payload: { exp: NOW - 1, act: 'approve' } }), now: NOW }), null);
        // not a token
        assert.equal(verifyCallback({ secret, token: 'nope', now: NOW }), null);
        assert.equal(verifyCallback({ secret, token: 'v1.abc.def', now: NOW }), null);
    }],

    ['a Telegram message becomes the common shape', () => {
        const m = parseTelegramUpdate({
            update_id: 1,
            message: { message_id: 7, text: 'hello there', chat: { id: 42, type: 'private' }, from: { id: 5, username: 'alex', first_name: 'Alex' } },
        }, { botUsername: 'openvibe_bot' });
        assert.equal(m.app, 'telegram');
        assert.equal(m.kind, 'message');
        assert.equal(m.chatId, '42');
        assert.equal(m.chatType, 'private');
        assert.equal(m.userId, '5');
        assert.equal(m.userName, 'alex');
        assert.equal(m.text, 'hello there');
        assert.equal(m.command, null);
    }],

    ['a Telegram command and a group mention are told apart', () => {
        const cmd = parseTelegramUpdate({ message: { message_id: 8, text: '/link now', chat: { id: 42, type: 'private' }, from: { id: 5 } } });
        assert.equal(cmd.kind, 'command');
        assert.equal(cmd.command, 'link');
        assert.equal(cmd.args, 'now');
        const group = parseTelegramUpdate({ message: { message_id: 9, text: 'hey @openvibe_bot what now', chat: { id: -100, type: 'supergroup' }, from: { id: 6 } } }, { botUsername: 'openvibe_bot' });
        assert.equal(group.chatType, 'group');
        assert.equal(group.mention, true);
        assert.equal(group.kind, 'mention');
        const notForUs = parseTelegramUpdate({ message: { message_id: 10, text: 'hey @someone_else', chat: { id: -100, type: 'supergroup' }, from: { id: 6 } } }, { botUsername: 'openvibe_bot' });
        assert.equal(notForUs.mention, false);
    }],

    ['a Telegram button press carries its data', () => {
        const b = parseTelegramUpdate({ callback_query: { id: '1', data: 'v1.abc.def', from: { id: 5, username: 'alex' }, message: { message_id: 7, chat: { id: 42, type: 'private' } } } });
        assert.equal(b.kind, 'button');
        assert.equal(b.button.id, 'v1.abc.def');
        assert.equal(b.userId, '5');
    }],

    ['a Discord ping, a slash command and a button are told apart', () => {
        const base = { id: 'i1', channel: { id: 'c1' }, user: { id: 'u1', username: 'alex' } };
        assert.equal(parseDiscordInteraction({ ...base, type: 1 }).kind, 'ping');
        const cmd = parseDiscordInteraction({ ...base, type: 2, guild_id: 'g1', data: { name: 'link', options: [] } }, { botUserId: 'u9' });
        assert.equal(cmd.kind, 'command');
        assert.equal(cmd.command, 'link');
        assert.equal(cmd.chatType, 'group');
        const btn = parseDiscordInteraction({ ...base, type: 3, data: { custom_id: 'v1.abc.def', values: ['approve'] } });
        assert.equal(btn.kind, 'button');
        assert.equal(btn.button.id, 'v1.abc.def');
        assert.equal(btn.button.value, 'approve');
        const dm = parseDiscordInteraction({ ...base, type: 2, data: { name: 'link' } });
        assert.equal(dm.chatType, 'private');
    }],

    ['a Slack message, an app mention and a button are told apart', () => {
        const m = parseSlackEvent({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'hello', ts: '1.2' }, { botUserId: 'U9' });
        assert.equal(m.app, 'slack');
        assert.equal(m.chatType, 'channel');   // a public channel: it is not a private conversation
        assert.equal(m.userId, 'U1');
        const dm = parseSlackEvent({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'hello', ts: '1.3' }, { botUserId: 'U9' });
        assert.equal(dm.chatType, 'private');
        const mention = parseSlackEvent({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@U9> hello', ts: '1.4' }, { botUserId: 'U9' });
        assert.equal(mention.kind, 'mention');
        assert.equal(mention.mention, true);
        // the bot's own message is not a message to answer
        assert.equal(parseSlackEvent({ type: 'message', channel: 'C1', user: 'U9', text: 'mine', bot_id: 'B1' }, { botUserId: 'U9' }), null);
        const btn = parseSlackInteraction({ type: 'block_actions', user: { id: 'U1', name: 'alex' }, channel: { id: 'C1' }, actions: [{ action_id: 'v1.abc.def', value: 'approve' }] });
        assert.equal(btn.kind, 'button');
        assert.equal(btn.button.id, 'v1.abc.def');
        assert.equal(btn.userId, 'U1');
    }],

    ['a long answer is split the app\'s way and nothing is lost', () => {
        const text = Array.from({ length: 300 }, (_, i) => `line ${i} of the answer`).join('\n');
        for (const app of ['telegram', 'discord', 'slack']) {
            const parts = splitText(app, text);
            assert.ok(parts.length > 1, `${app}: a long answer is split`);
            for (const p of parts) assert.ok(p.length <= (app === 'telegram' ? 4096 : app === 'discord' ? 2000 : 3000), `${app}: a piece fits`);
            assert.equal(parts.join('\n').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '), `${app}: nothing is lost`);
        }
        assert.deepEqual(splitText('telegram', 'short'), ['short']);
        assert.deepEqual(splitText('telegram', ''), []);
    }],
]);

// Provider fixture regressions: unrelated bot commands, attachments, workspace payloads and bounded callbacks.
{
    const sdk = require('../src/chat-apps');
    const id = 'abcdefghijklmnop';
    const token = sdk.signButton({ secret: 'fixture-only', id });
    assert.ok(Buffer.byteLength(token) <= 64);
    assert.equal(sdk.verifyButton({ secret: 'fixture-only', token }), id);
    assert.equal(sdk.verifyButton({ secret: 'wrong', token }), null);
    assert.equal(sdk.verifyButton({ secret: 'fixture-only', token: token + 'x' }), null);
    assert.equal(sdk.parseTelegramUpdate({ message: { text: '/link@another_bot', from: { id: 1 }, chat: { id: 1, type: 'private' } } }, { botUsername: 'our_bot' }), null);
    assert.equal(sdk.parseTelegramUpdate({ message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, document: { file_id: 'doc', file_name: 'a.pdf' } } }).attachments[0].id, 'doc');
    assert.equal(sdk.parseDiscordInteraction({ type: 2, channel_id: '123', user: { id: '9' }, data: { name: 'link' } }).chatId, '123');
    assert.equal(sdk.parseDiscordMessage({ id: '1', channel_id: '2', guild_id: '3', author: { id: '4' }, content: 'hello', mentions: [{ id: '9' }] }, { botUserId: '9' }).mention, true);
    assert.equal(sdk.parseDiscordMessage({ author: { bot: true } }), null);
    assert.equal(sdk.verifyCallback({ secret: 's', token: sdk.signCallback({ secret: 's', payload: { iat: 'invalid' } }) }), null);
    assert.equal(sdk.parseSlackEvent({ type: 'app_mention', bot_id: 'B1', text: 'loop' }), null);
    assert.equal(sdk.parseTelegramUpdate({ edited_message: { text: 'changed', from: { id: 1 }, chat: { id: 1 } } }), null);
    assert.equal(sdk.parseTelegramUpdate({ message: { from: { id: 1, is_bot: true }, chat: { id: 1 }, text: 'bot' } }), null);
    const file = sdk.parseSlackEvent({ type: 'message', subtype: 'file_share', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'the report', files: [{ id: 'F1', name: 'report.pdf', url_private: 'https://files.slack.com/report.pdf' }] }, { botUserId: 'U9' });
    assert.equal(file.attachments[0].name, 'report.pdf');
    assert.equal(file.attachments[0].url, 'https://files.slack.com/report.pdf');
    assert.equal(sdk.parseSlackEvent({ type: 'message', subtype: 'message_changed', channel: 'C1', message: { user: 'U1', text: 'edited' } }, { botUserId: 'U9' }), null);
    assert.equal(sdk.parseSlackEvent({ type: 'message', subtype: 'channel_join', channel: 'C1', user: 'U1' }, { botUserId: 'U9' }), null);
}
