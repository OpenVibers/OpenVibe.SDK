/** Public AI text with every description of a person removed (looks, body, clothing, hair, face, pose, age, guessed gender). Non-strings are returned as given. */
export function noLooks<T>(text: T): T;
/** Tags that name no clothing, hair, face, age or gendered person. */
export function noLooksTags(tags: unknown): string[];
/** True when a short text (a title) names looks at all: replace it rather than repair it. */
export function hasLooks(text: unknown): boolean;
/** A 16-hex-digit hash of the rules: record it after repairing stored rows, and repair again when it changes. */
export const RULES_VERSION: string;
