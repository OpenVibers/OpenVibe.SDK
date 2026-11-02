'use strict';
/**
 * openvibe-sdk/no-looks: DEPRECATED (2026-10-31). The rule that public AI text never describes a person is gone: the
 * owner, "there should be no reason it can't describe people … remove all that crap." AI text may describe how people
 * look. These functions now return what they are given, so a service that still calls them keeps working until its
 * next release removes the calls; nothing new should call them.
 *
 * isExplicit (nothing sexual is published) is a different rule and stays: it lives in openvibe-sdk/explicit, and is
 * re-exported here for the services that import it from this module.
 */
const { isExplicit } = require('./explicit');

/** @deprecated The text as given. */
const noLooks = (text) => text;
/** @deprecated The tags as given (strings only, as before). */
const noLooksTags = (tags) => (Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : []);
/** @deprecated Always false: a title that describes people is fine. */
const hasLooks = () => false;
/** @deprecated The rules are off: a service that repairs stored rows when this changes runs its repair once more, as a no-op. */
const RULES_VERSION = 'off';

module.exports = { noLooks, noLooksTags, hasLooks, isExplicit, RULES_VERSION };
