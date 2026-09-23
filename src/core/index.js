'use strict';
/** openvibe-sdk/core: the HTTP client, errors, tracing, ids, pagination. Browser-safe. */
const { createClient, CONTRACTS_RANGE, DEFAULT_NETWORK } = require('./client');
const { OpenVibeError, isOpenVibeError } = require('./errors');
const { parseTraceparent, startSpan, contextFromHeaders } = require('./trace');
const { ulid, newEventId, newIdempotencyKey, isActingSubjectId } = require('./ids');
const { paginate, offsetPager } = require('./paginate');
const semver = require('./semver');

/** The package version (test/version.test.js keeps it equal to package.json). */
const SDK_VERSION = '0.5.0';

module.exports = {
    createClient,
    OpenVibeError,
    isOpenVibeError,
    paginate,
    offsetPager,
    parseTraceparent,
    startSpan,
    contextFromHeaders,
    ulid,
    newEventId,
    newIdempotencyKey,
    isActingSubjectId,
    satisfiesRange: semver.satisfies,
    compareVersions: semver.compare,
    CONTRACTS_RANGE,
    DEFAULT_NETWORK,
    SDK_VERSION,
};
