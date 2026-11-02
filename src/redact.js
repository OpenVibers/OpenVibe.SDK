'use strict';
/**
 * openvibe-sdk/redact: the shared secret scrubber (Memory M2). It is the JavaScript port of OpenVibe.Node's
 * internal/memory/redact.go (Node #87), so the Node and OpenVibe.AI run one list of shapes against one corpus
 * (test/redact-corpus.json). The Node scrubs a memory file before it uploads it; AI scrubs every item again before it
 * seals it, and refuses an item that was nothing but a secret.
 *
 * - redact(text) -> { text, count }: every secret shape is replaced with [redacted], and the count says how many were
 *   removed. The whole-text pass uses an internal sentinel first, the way the Node scrubs a file before it splits it
 *   into items; the sentinel is resolved to [redacted] before the result is returned. A text that is already redacted
 *   is left alone.
 * - onlySecret(text): true when nothing but redacted secrets is left ("the item was only a secret").
 *
 * The shapes are the ones Node took from OpenVibe.Codes' harness and from gitleaks, plus the card numbers that pass
 * the Luhn check and the deliberately wide environment-assignment rule (max_tokens: 100000 is a value too, because a
 * credential name may be plural and a value may be a token count).
 *
 * Pure functions, no dependencies and no Node built-ins: safe on a server and in a browser.
 */

// A credential name ends in one of these words. A name is a run of [A-Za-z0-9_.-] ending in one, so
// DATABASE_PASSWORD, MY_SECRET and GITHUB_TOKEN are names, and so are password and api_key. The name may end in an
// "s" too, so max_tokens and api_keys are names.
const SECRET_NAME_SUFFIXES = 'password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential|credentials|cookie|session';
const SECRET_NAME = `(?:${SECRET_NAME_SUFFIXES})s?`;

// The bytes of the two fence markers of markdown.
const FENCE_TICK = 0x60;      // `
const FENCE_TILDE = 0x7e;     // ~

/** What a secret is replaced with. */
const REDACTED = '[redacted]';

/** The sentinel the whole-text pass writes before the text is split into items (Node's secretMark). */
const SECRET_MARK = '\x00redacted\x00';

/**
 * One shape and how to replace it. `keep` is the number of capture groups kept in front of the marker, so an
 * assignment still reads as "password=[redacted]". `template` rebuilds the match from its groups ("$1" …) with "%s"
 * where the marker goes.
 */
const SECRET_PATTERNS = [
    // A webhook URL carries its token in the path: the whole URL goes.
    { re: /https:\/\/hooks\.slack\.com\/services\/[^\s"']+/g },
    { re: /https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/[^\s"']+/g },
    // A connection string with a password: the scheme, the user and the host stay, the password goes.
    { re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@[^\s"']*)/g, keep: 1, template: '$1%s$3' },
    // A private key block, in every form: RSA, EC, DSA, OPENSSH, PGP and ENCRYPTED.
    { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/g },
    // The keys of the tools and the services.
    { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g },
    { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
    { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
    { re: /\bglpat-[0-9A-Za-z_-]{20,}/g },
    { re: /\bnpm_[A-Za-z0-9]{36}/g },
    { re: /\bhf_[A-Za-z0-9]{30,}/g },
    { re: /\bAIza[0-9A-Za-z_-]{35}/g },
    { re: /\bSK[0-9a-fA-F]{32}\b/g },
    { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
    { re: /\bxapp-[0-9A-Za-z-]{10,}/g },
    { re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
    { re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
    { re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
    { re: /[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/g },
    { re: /\bhbt_[A-Za-z0-9_-]{16,}/g },
    { re: /\bpgsk_[A-Za-z0-9_]{16,}/g },
    { re: /\bAKIA[0-9A-Z]{16}/g },
    { re: /\bASIA[0-9A-Z]{16}/g },
    { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    // A header that carries a credential.
    { re: /(authorization[ \t]*:[ \t]*(?:bearer|basic)[ \t]+)(\S+)/gi, keep: 1 },
    { re: /(x-api-key[ \t]*:[ \t]*)(\S+)/gi, keep: 1 },
    { re: /\b(bearer[ \t]+)([A-Za-z0-9._~+/=-]{20,})/gi, keep: 1 },
    // An assignment: the name and the separator stay, the value goes. The name ends in a word that means "this is a
    // credential". A quoted value keeps its quotes, so the text still reads as the config it was.
    { re: new RegExp(`([A-Za-z0-9_.-]*${SECRET_NAME})(["']?[ \\t]*(?:=>|[:=])[ \\t]*)"([^"\\n]{4,})"`, 'gi'), template: '$1$2"%s"' },
    { re: new RegExp(`([A-Za-z0-9_.-]*${SECRET_NAME})(["']?[ \\t]*(?:=>|[:=])[ \\t]*)'([^'\\n]{4,})'`, 'gi'), template: "$1$2'%s'" },
    // A value whose closing quote was lost: it still goes, to the end of the line.
    { re: new RegExp(`([A-Za-z0-9_.-]*${SECRET_NAME})(["']?[ \\t]*(?:=>|[:=])[ \\t]*)"([^"\\n]{4,})`, 'gi'), template: '$1$2"%s' },
    // An unquoted value.
    { re: new RegExp(`([A-Za-z0-9_.-]*${SECRET_NAME})(["']?[ \\t]*(?:=>|[:=])[ \\t]*)([^\\s"',;]{6,})`, 'gi'), keep: 2 },
    // Prose: "the password is hunter2".
    { re: /\b(password|passphrase|passcode)([ \t]+(?:is|was|=)[ \t]+)(\S{4,})/gi, keep: 2 },
];

// A run of 13 to 19 digits with optional spaces or dashes between them. Whether it is a card is decided by Luhn.
const CARD_CANDIDATE = /[0-9](?:[ -]?[0-9]){12,18}/g;

// The lines of a private key block.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/;

const isDigit = (b) => b >= '0' && b <= '9';

/** A copy of a global pattern without "g": one replacement on one match (Go's ReplaceAllString on m). */
function nonGlobal(re) {
    return new RegExp(re.source, re.flags.replace('g', ''));
}

/** The replacement string for one match: the kept groups then the marker, or the pattern's own template. */
function replacementFor(pattern, match, marker) {
    if (pattern.template) {
        // A marker with a "$" in it must not be read as a replacement reference.
        return match.replace(nonGlobal(pattern.re), pattern.template.replace('%s', marker.replace(/\$/g, '$$$$')));
    }
    if (!pattern.keep) return marker;
    const groups = nonGlobal(pattern.re).exec(match);
    if (!groups || groups.length <= pattern.keep) return marker;
    return groups.slice(1, pattern.keep + 1).join('') + marker;
}

/** Replaces every match of the pattern, never touching a marker that is already there. */
function replacePattern(pattern, text, marker, state) {
    return text.replace(pattern.re, (match) => {
        if (match.includes(marker) || match.includes(REDACTED)) return match;
        state.count++;
        return replacementFor(pattern, match, marker);
    });
}

/** The length of the run of fence characters at s[i], or 0 when the run is shorter than three. */
function fenceRun(s, i) {
    if (i >= s.length || (s.charCodeAt(i) !== FENCE_TICK && s.charCodeAt(i) !== FENCE_TILDE)) return 0;
    let n = 0;
    while (i + n < s.length && s[i + n] === s[i]) n++;
    return n < 3 ? 0 : n;
}

/** The character and width of the fence open at pos, or [0, 0] when pos is not inside one. */
function openFence(text, pos) {
    let char = null;
    let width = 0;
    for (let i = 0; i < pos;) {
        const n = fenceRun(text, i);
        if (!n) { i++; continue; }
        if (!char) { char = text[i]; width = n; } else if (text[i] === char && n >= width) { char = null; width = 0; }
        i += n;
    }
    return [char, width];
}

/** The index of the fence that closes the block at pos, or the end of the text when pos is not inside a fence. */
function fenceEnd(text, pos) {
    const [char, width] = openFence(text, pos);
    if (!char) return text.length;
    for (let i = pos; i < text.length;) {
        const n = fenceRun(text, i);
        if (!n) { i++; continue; }
        if (text[i] === char && n >= width) return i;
        i += n;
    }
    return text.length;
}

/**
 * A private key block that has no END line: a truncated file, or a key pasted in halves. It is redacted from its BEGIN
 * line to the end of the fence it sits in, or to the end of the text when it is not in a fence. A block with its END
 * line is left to the pattern list, which redacts it whole.
 */
function redactUnterminatedKey(text, marker, state) {
    const blocks = [];
    for (const m of text.matchAll(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/g)) blocks.push({ start: m.index, end: m.index + m[0].length });
    // Work from the last block backwards, so the indexes of the earlier ones stay valid.
    for (let i = blocks.length - 1; i >= 0; i--) {
        const { start, end: after } = blocks[i];
        if (PEM_END.test(text.slice(after))) continue;    // complete: the pattern list redacts it whole
        let end = text.length;
        const fence = fenceEnd(text, start);
        if (fence > start) end = fence;
        text = text.slice(0, start) + marker + '\n' + text.slice(end);
        state.count++;
    }
    return text;
}

/** The Luhn check: a run of digits that passes it is a card number, and a long order number is not. */
function luhn(digits) {
    let sum = 0;
    let doubled = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (doubled) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        doubled = !doubled;
    }
    return sum % 10 === 0;
}

/** Redacts the card numbers that pass the Luhn check. */
function redactCards(text, marker, state) {
    let out = '';
    let last = 0;
    for (const m of text.matchAll(CARD_CANDIDATE)) {
        const start = m.index;
        const end = start + m[0].length;
        if (start > 0 && isDigit(text[start - 1])) continue;    // part of a longer number
        let j = end;
        while (j < text.length && text[j] === ' ') j++;
        if (j < text.length && isDigit(text[j])) continue;      // the number continues past the match
        let digits = '';
        for (let i = start; i < end; i++) if (isDigit(text[i])) digits += text[i];
        if (digits.length < 13 || digits.length > 19 || !luhn(digits)) continue;
        out += text.slice(last, start) + marker;
        state.count++;
        last = end;
    }
    return out + text.slice(last);
}

/** The per-item pass: the shapes, then cards, with one marker. */
function redactWith(text, marker) {
    const state = { count: 0 };
    let out = redactUnterminatedKey(text, marker, state);
    for (const pattern of SECRET_PATTERNS) out = replacePattern(pattern, out, marker, state);
    out = redactCards(out, marker, state);
    return { text: out, count: state.count };
}

/**
 * The whole-text pass with the sentinel, then the per-item pass. A secret that spans two items (a key block in a
 * fence, an .env block) is only seen whole, which is why the Node scrubs a file before it splits it. The sentinel is
 * resolved to [redacted] before the per-item pass, which catches anything only visible once the text is on its own.
 */
function redactDocument(text) {
    const whole = redactWith(text, SECRET_MARK);
    const resolved = whole.text.split(SECRET_MARK).join(REDACTED);
    const perItem = redactWith(resolved, REDACTED);
    return { text: perItem.text, count: whole.count + perItem.count };
}

/**
 * Removes the secrets from a text. Returns the text and how many secrets were removed; the secrets themselves are
 * never returned. A text that was already redacted is left alone.
 */
function redact(text) {
    return redactDocument(String(text == null ? '' : text));
}

/** True when a text holds nothing but redacted secrets ("the item was only a secret"). */
function onlySecret(text) {
    return String(text == null ? '' : text).split(REDACTED).join('').trim() === '';
}

module.exports = { redact, onlySecret };
