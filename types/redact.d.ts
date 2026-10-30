/** A text with its secrets removed, and how many secrets were removed. */
export interface RedactResult {
    text: string;
    count: number;
}

/** Remove every secret shape from a text. The secrets themselves are never returned; an already-redacted text is unchanged. */
export function redact(text: unknown): RedactResult;

/** True when a text holds nothing but redacted secrets: an item that was only a secret is refused. */
export function onlySecret(text: unknown): boolean;
