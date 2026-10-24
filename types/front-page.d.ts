/** True when the text may lead a front page (a latest or most viewed list, a quote strip, a feed): not empty, no built-in slur category, no strong profanity in English, Portuguese, Spanish, French or German, no hate topic. */
export function frontPageOk(text: unknown): boolean;
/** True when the text has one of the built-in slur categories (OpenVibe.Chat's), spaced out, run together or leet-spelled included. */
export function containsCoreSlur(text: unknown): boolean;
