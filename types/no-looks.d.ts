/** @deprecated (2026-10-31) AI text may describe people. Returns the text as given. */
export function noLooks<T>(text: T): T;
/** @deprecated Returns the string tags as given. */
export function noLooksTags(tags: unknown): string[];
/** @deprecated Always false. */
export function hasLooks(text: unknown): boolean;
/** True when any of the texts says a scene shows sexual content: publish none of it. Prefer openvibe-sdk/explicit. */
export function isExplicit(...texts: unknown[]): boolean;
/** @deprecated 'off'. */
export const RULES_VERSION: string;
