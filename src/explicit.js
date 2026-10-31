'use strict';
/**
 * openvibe-sdk/explicit: AI text that says a scene shows sexual content (body parts, sex acts, pornography, nudity) is
 * not published at all — a moment, clip or paste whose description says so stays private. This is not about how
 * anyone looks (describing people is fine, owner 2026-10-31); it is about what a public page shows.
 *
 *   isExplicit(title, overview)  // from openvibe-sdk/explicit
 */
// What a scene shows: a service asks isExplicit() before it publishes AI text at all. Live's AI auto-clip 483 went public
// with such a description on 2026-10-23 (Live#344 had its own copy first).
const EXPLICIT = /\b(?:genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|sexual(?:ly)?\s+(?:acts?|activity|content|material|explicit|intercourse)|sex\s+acts?|(?:explicit|adult|pornographic|sexual)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|nudity|erotica?)\b/i;
function isExplicit(...texts) {
    return texts.some((t) => t != null && EXPLICIT.test(String(t)));
}

module.exports = { isExplicit };
