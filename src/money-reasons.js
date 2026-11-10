'use strict';

/**
 * The plain words for a ledger row, for a service that holds the raw key (`reason` from OpenCoins,
 * or Billing's `type:metadata`). The list and the formatter live in openvibe-contracts
 * (`billing.money-reason@1`, `lib/money-reasons.js`); this re-exports them when the installed
 * package has them and otherwise answers from the same list copied at 0.392.0, so every service
 * builds the sentence the same way.
 *
 *   const { moneyReasons } = require('openvibe-sdk');
 *   moneyReasons.describe(row.reason, { site: row.app_id, resolve: { quest: (id) => ({ name, url }) } });
 *   // → { key, text: 'for the quest Publish a video', subject: { name, url }, site, known: true }
 */
let canonical = null;
try { canonical = require('openvibe-contracts').moneyReasons || null; } catch { /* an older contract package: the copy below answers */ }
module.exports = canonical || require('./money-reasons-list');
