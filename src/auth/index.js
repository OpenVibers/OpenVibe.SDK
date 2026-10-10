'use strict';
/**
 * openvibe-sdk/auth, server entry (Node). Bundlers resolving the `browser` condition get
 * ./browser.js instead, which has the PKCE helpers only.
 */
const browser = require('./browser');
const { createServiceTokenClient } = require('./tokens');
const { verifyUserToken, verifyAppToken } = require('./jwt');
const { verifyServiceToken } = require('./service');
const { createJwksClient, jwksClient, jwksStatus } = require('./jwks');
const { createNetworkKeys } = require('./keys');
const { exchangeCode, refreshUserToken } = require('./oauth');
const { createRevocationStore, createPgRevocationStore, revocationSchema, TOKEN_VALID_AFTER } = require('./revocations');

module.exports = { ...browser, createServiceTokenClient, verifyUserToken, verifyAppToken, verifyServiceToken, createJwksClient, jwksClient, jwksStatus, createNetworkKeys, exchangeCode, refreshUserToken, createRevocationStore, createPgRevocationStore, revocationSchema, TOKEN_VALID_AFTER };
