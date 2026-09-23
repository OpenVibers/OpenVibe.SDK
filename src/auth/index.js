'use strict';
/**
 * openvibe-sdk/auth, server entry (Node). Bundlers resolving the `browser` condition get
 * ./browser.js instead, which has the PKCE helpers only.
 */
const browser = require('./browser');
const { createServiceTokenClient } = require('./tokens');
const { verifyUserToken, verifyAppToken } = require('./jwt');
const { exchangeCode, refreshUserToken } = require('./oauth');

module.exports = { ...browser, createServiceTokenClient, verifyUserToken, verifyAppToken, exchangeCode, refreshUserToken };
