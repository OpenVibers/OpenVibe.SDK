'use strict';
/**
 * openvibe-sdk/explicit: AI text that says a scene shows sex acts or pornography is not published at all — a moment,
 * clip or paste whose description says so stays private. Describing people is fine, and so is nudity: the owner,
 * 2026-10-31, "naked and nude is fine… stop being against art on my platform". What stays gated is sex itself, and the
 * hard line that nudity being art never moves: a child and a bare body in the same text.
 *
 *   isExplicit(title, overview)  // from openvibe-sdk/explicit
 *
 * The same rule as OpenVibe.Live's server/ai/explicit.js (Live#469), so every service that adopts this one agrees.
 */
// What a scene shows, not what someone talks about in passing: sex acts and pornography. Nudity and body words are not
// in it (a nude body is not a sex act). Live's AI auto-clip 483 went public with "explicit adult content… sexual acts"
// in its description on 2026-10-23.
const EXPLICIT = /\b(?:sexual(?:ly)?\s+(?:acts?|activity|intercourse)|sex\s+acts?|having\s+sex|(?:pornographic|sexually\s+explicit|explicit\s+adult)\s+(?:content|material|footage|scenes?|imagery|videos?|acts?)|adult\s+(?:films?|videos?)|porn(?:o|ography|ographic)?|masturbat\w*|intercourse|oral\s+sex|penetrat\w*)\b/i;

// A child together with nudity or genitals is treated as explicit, whatever else the text says ("kids in swimsuits at
// the beach" is not this): the moment is never picked, and an AI clip of it goes private for a person to review.
const MINOR = /\b(?:child(?:ren)?|kids?|minors?|teen(?:age(?:rs?)?|s)?|toddlers?|bab(?:y|ies)|infants?|boys?|girls?|underage)\b/i;
const NUDE = /\b(?:naked|nude|nudity|undress(?:ed|ing)?|topless|bottomless|genital(?:s|ia)?|penis(?:es)?|vaginas?|vulvas?|breasts?|nipples?)\b/i;
const minorNude = (t) => MINOR.test(t) && NUDE.test(t);

/** True when any of the texts describes sex acts or pornography, or puts a child and nudity together. */
function isExplicit(...texts) {
    return texts.some((t) => t != null && (EXPLICIT.test(String(t)) || minorNude(String(t))));
}

module.exports = { isExplicit };
