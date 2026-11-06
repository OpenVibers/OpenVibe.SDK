'use strict';
/**
 * openvibe-sdk/auth, server entry (Node). Bundlers resolving the `browser` condition get
 * ./browser.js instead, which has the PKCE helpers only.
 */
const browser = require('./browser');
const { createServiceTokenClient } = require('./tokens');
const { verifyUserToken, verifyAppToken } = require('./jwt');
const { verifyServiceToken } = require('./service');
const { requestSubjectAssertion, verifySubjectAssertion, createSubjectAssertionVerifier, subjectAssertionHeader } = require('./subject-assertion');
const { createJwksClient, jwksClient, jwksStatus } = require('./jwks');
const { createNetworkKeys } = require('./keys');
const { exchangeCode, refreshUserToken } = require('./oauth');
const { createPgRevocationStore, revocationSchema, TOKEN_VALID_AFTER } = require('./revocations');

module.exports = { ...browser, createServiceTokenClient, verifyUserToken, verifyAppToken, verifyServiceToken, requestSubjectAssertion, verifySubjectAssertion, createSubjectAssertionVerifier, subjectAssertionHeader, createJwksClient, jwksClient, jwksStatus, createNetworkKeys, exchangeCode, refreshUserToken, createPgRevocationStore, revocationSchema, TOKEN_VALID_AFTER };
