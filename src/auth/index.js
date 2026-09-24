'use strict';
/**
 * openvibe-sdk/auth, server entry (Node). Bundlers resolving the `browser` condition get
 * ./browser.js instead, which has the PKCE helpers only.
 */
const browser = require('./browser');
const { createServiceTokenClient } = require('./tokens');
const { verifyUserToken, verifyAppToken } = require('./jwt');
const { exchangeCode, refreshUserToken } = require('./oauth');
const { createRevocationStore, TOKEN_VALID_AFTER } = require('./revocations');

module.exports = { ...browser, createServiceTokenClient, verifyUserToken, verifyAppToken, exchangeCode, refreshUserToken, createRevocationStore, TOKEN_VALID_AFTER };
