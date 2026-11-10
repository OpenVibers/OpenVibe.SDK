'use strict';
// moneyReasons: the same formatter as openvibe-contracts (billing.money-reason@1), for a service holding a raw row.
const assert = require('assert');
const { moneyReasons } = require('..');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

const quest = moneyReasons.describe('quest:publish-a-video', { site: 'quest' });
ok(quest.text === 'for the quest Publish a video', 'a quest key reads as a sentence');
ok(quest.subject && quest.subject.url === 'https://openvibe.quest/quests/publish-a-video', 'and links to the quest');
ok(quest.site === 'OpenVibe.Quest', 'and names its site');

const resolved = moneyReasons.describe('quest:go-live', { resolve: { quest: () => ({ name: 'Go live once', url: 'https://openvibe.quest/quests/go-live' }) } });
ok(resolved.text === 'for the quest Go live once', 'a resolver names the subject');

const row = moneyReasons.describeRow({ reason: 'Refund: A film', app_id: 'live' });
ok(row.text === 'for a refund of A film' && row.site === 'OpenVibe.Live', 'a raw row is described by its reason and app');

const tip = moneyReasons.describe('donation', { subject: { name: '@alice', url: 'https://openvibe.live/@alice' } });
ok(tip.text === 'for a tip to @alice', 'a tip names its creator');

const unknown = moneyReasons.describe('nobody:declared-this', { site: 'fun' });
ok(!unknown.known && unknown.text === 'for something on OpenVibe.Fun', 'an undeclared key reads "for something on <site>"');
ok(!/nobody:|declared-this/.test(unknown.text), 'and never shows the key');

console.log(`openvibe-sdk money reasons: ${n} checks passed`);
