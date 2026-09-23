'use strict';
/**
 * Just enough semver for version negotiation: parse, compare, and ranges made of space-separated
 * comparators (>=, >, <=, <, =, bare), caret (^1.2.3), tilde (~1.2.3) and `||` alternatives.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v) {
    const m = typeof v === 'string' && v.trim().match(VERSION_RE);
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}

function compare(a, b) {
    const x = typeof a === 'string' ? parse(a) : a;
    const y = typeof b === 'string' ? parse(b) : b;
    if (!x || !y) throw new TypeError(`invalid version ${!x ? a : b}`);
    for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return x.pre < y.pre ? -1 : 1;
}

function comparators(part) {
    const out = [];
    for (const tok of part.trim().split(/\s+/).filter(Boolean)) {
        const m = tok.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
        const op = m[1] || '=';
        const v = parse(m[2]);
        if (!v) throw new TypeError(`invalid range token ${tok}`);
        if (op === '^') {
            const upper = v.major > 0 ? `${v.major + 1}.0.0` : v.minor > 0 ? `0.${v.minor + 1}.0` : `0.0.${v.patch + 1}`;
            out.push(['>=', v], ['<', parse(upper)]);
        } else if (op === '~') {
            out.push(['>=', v], ['<', parse(`${v.major}.${v.minor + 1}.0`)]);
        } else {
            out.push([op, v]);
        }
    }
    return out;
}

function satisfies(version, range) {
    const v = parse(version);
    if (!v) return false;
    return String(range).split('||').some((part) => comparators(part).every(([op, c]) => {
        const r = compare(v, c);
        return op === '>=' ? r >= 0 : op === '>' ? r > 0 : op === '<=' ? r <= 0 : op === '<' ? r < 0 : r === 0;
    }));
}

module.exports = { parse, compare, satisfies };
