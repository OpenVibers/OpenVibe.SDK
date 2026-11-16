'use strict';
/**
 * SVG path data, read (openvibe-sdk/svg's `path`; from OpenVibe.Design's server/typefaces/path.js, plan R1 item 8).
 * Design's typefaces add their own opentype.js step on top; the SDK carries no font library.
 *
 * One parser for the whole service: the model writes outlines as path data, and the server has to know three things
 * about each one before it may become a glyph — is it a single closed contour inside the em box, how big is it, and
 * what commands does it use. This module answers all three and hands back a clean, absolute command list.
 *
 * Absolute commands only (M L C Q Z), because a font's outlines are absolute: the model may write relative commands
 * or arcs, and both are converted here. Arcs become cubic curves (the same curve, four segments at most), because a
 * font's outlines are cubics and the compiler does not read arcs.
 *
 *   parse(d)        → { ok: true, segments } | { ok: false, why }
 *   bbox(segments)  → { x1, y1, x2, y2 } (the true bounds, curves included)
 *   closed(segments)→ true when every contour ends with Z
 *   toData(segments)→ normalised path data (absolute, two decimals)
 */

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/;
const COMMANDS = 'MmLlHhVvCcSsQqTtAaZz';
const EPS = 1e-6;

/** Round to two decimals and drop a trailing zero: the same outline, written once. */
function round(n) {
    const v = Math.round(Number(n) * 100) / 100;
    return Object.is(v, -0) ? 0 : v;
}

function numText(n) {
    return String(round(n));
}

/** The scanner: numbers and command letters, with the separators between them. */
function scan(d) {
    const src = String(d || '');
    const out = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ',') { i++; continue; }
        if (COMMANDS.includes(c)) { out.push({ cmd: c }); i++; continue; }
        const m = NUM.exec(src.slice(i));
        if (!m || !m[0]) return { ok: false, why: 'unexpected character "' + c + '" in the path data' };
        out.push({ num: Number(m[0]) });
        i += m[0].length;
    }
    return { ok: true, tokens: out };
}

/** The points of one cubic, and where it actually turns (the curve's true bounds). */
function cubicExtrema(p0, p1, p2, p3) {
    const ts = [0, 1];
    // B'(t) = 3(1-t)^2 (p1-p0) + 6(1-t)t (p2-p1) + 3t^2 (p3-p2) → a quadratic in t.
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const push = (t) => { if (t > EPS && t < 1 - EPS) ts.push(t); };
    if (Math.abs(a) < EPS) {
        if (Math.abs(b) > EPS) push(-c / b);
    } else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
            const sq = Math.sqrt(disc);
            push((-b + sq) / (2 * a));
            push((-b - sq) / (2 * a));
        }
    }
    const at = (t) => {
        const u = 1 - t;
        return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };
    return ts.map(at);
}

function quadExtrema(p0, p1, p2) {
    const ts = [0, 1];
    const den = p0 - 2 * p1 + p2;
    if (Math.abs(den) > EPS) {
        const t = (p0 - p1) / den;
        if (t > EPS && t < 1 - EPS) ts.push(t);
    }
    const at = (t) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
    return ts.map(at);
}

/** An elliptical arc as cubic segments (the endpoint-to-centre form, split into quarter-turns). */
function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
    if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
    const phi = (phiDeg % 360) * Math.PI / 180;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
    const x1p = cosP * dx2 + sinP * dy2;
    const y1p = -sinP * dx2 + cosP * dy2;
    let rxa = Math.abs(rx), rya = Math.abs(ry);
    const lambda = (x1p * x1p) / (rxa * rxa) + (y1p * y1p) / (rya * rya);
    if (lambda > 1) { const s = Math.sqrt(lambda); rxa *= s; rya *= s; }
    const sign = largeArc === sweep ? -1 : 1;
    const num = rxa * rxa * rya * rya - rxa * rxa * y1p * y1p - rya * rya * x1p * x1p;
    const den = rxa * rxa * y1p * y1p + rya * rya * x1p * x1p;
    const coef = sign * Math.sqrt(Math.max(0, num / (den || 1)));
    const cxp = coef * (rxa * y1p / rya);
    const cyp = coef * -(rya * x1p / rxa);
    const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
    const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
    const angle = (ux, uy, vx, vy) => {
        const dot = ux * vx + uy * vy;
        const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1;
        let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
        if (ux * vy - uy * vx < 0) a = -a;
        return a;
    };
    const ux = (x1p - cxp) / rxa, uy = (y1p - cyp) / rya;
    const vx = (-x1p - cxp) / rxa, vy = (-y1p - cyp) / rya;
    const theta1 = angle(1, 0, ux, uy);
    let dTheta = angle(ux, uy, vx, vy);
    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
    const parts = Math.ceil(Math.abs(dTheta) / (Math.PI / 2)) || 1;
    const delta = dTheta / parts;
    const k = (4 / 3) * Math.tan(delta / 4);
    const out = [];
    let th = theta1;
    let px = x1, py = y1;
    for (let i = 0; i < parts; i++) {
        const th2 = th + delta;
        const cos1 = Math.cos(th), sin1 = Math.sin(th), cos2 = Math.cos(th2), sin2 = Math.sin(th2);
        const e1x = cx + rxa * cosP * cos1 - rya * sinP * sin1;
        const e1y = cy + rxa * sinP * cos1 + rya * cosP * sin1;
        const e2x = cx + rxa * cosP * cos2 - rya * sinP * sin2;
        const e2y = cy + rxa * sinP * cos2 + rya * cosP * sin2;
        const d1x = -rxa * cosP * sin1 - rya * sinP * cos1;
        const d1y = -rxa * sinP * sin1 + rya * cosP * cos1;
        const d2x = -rxa * cosP * sin2 - rya * sinP * cos2;
        const d2y = -rxa * sinP * sin2 + rya * cosP * cos2;
        out.push([px + k * d1x, py + k * d1y, e2x - k * d2x, e2y - k * d2y, e2x, e2y]);
        px = e2x; py = e2y; th = th2;
    }
    return out;
}

/**
 * Read the path data. Every command is made absolute; S and T take the previous control point into account; an arc
 * becomes cubics. The result is a list of { type, args } with types M, L, C, Q and Z.
 */
function parse(d) {
    const scanned = scan(d);
    if (!scanned.ok) return scanned;
    const tokens = scanned.tokens;
    const segments = [];
    let x = 0, y = 0, startX = 0, startY = 0;
    let lastCtrl = null, lastQuad = null, cmd = null;
    let i = 0;
    const need = (n) => {
        const vals = [];
        for (let k = 0; k < n; k++) {
            const t = tokens[i++];
            if (!t || t.num === undefined) return null;
            vals.push(t.num);
        }
        return vals;
    };
    while (i < tokens.length) {
        const t = tokens[i];
        if (t.cmd) { cmd = t.cmd; i++; }
        else if (!cmd) return { ok: false, why: 'the path data starts with a number, not a command' };
        else if (cmd === 'M') cmd = 'L';            // extra pairs after a move are lines
        else if (cmd === 'm') cmd = 'l';
        const rel = cmd === cmd.toLowerCase();
        const abs = cmd.toUpperCase();
        if (abs === 'Z') {
            // The command letter was already consumed above; Z never repeats, so nothing is read here.
            segments.push({ type: 'Z', args: [] });
            x = startX; y = startY; lastCtrl = null; lastQuad = null;
            continue;
        }
        if (abs === 'M') {
            const v = need(2); if (!v) return { ok: false, why: 'a move needs two numbers' };
            x = rel ? x + v[0] : v[0]; y = rel ? y + v[1] : v[1];
            startX = x; startY = y;
            segments.push({ type: 'M', args: [x, y] });
            lastCtrl = null; lastQuad = null;
            continue;
        }
        if (abs === 'L') {
            const v = need(2); if (!v) return { ok: false, why: 'a line needs two numbers' };
            x = rel ? x + v[0] : v[0]; y = rel ? y + v[1] : v[1];
            segments.push({ type: 'L', args: [x, y] });
            lastCtrl = null; lastQuad = null;
            continue;
        }
        if (abs === 'H') {
            const v = need(1); if (!v) return { ok: false, why: 'a horizontal line needs one number' };
            x = rel ? x + v[0] : v[0];
            segments.push({ type: 'L', args: [x, y] });
            lastCtrl = null; lastQuad = null;
            continue;
        }
        if (abs === 'V') {
            const v = need(1); if (!v) return { ok: false, why: 'a vertical line needs one number' };
            y = rel ? y + v[0] : v[0];
            segments.push({ type: 'L', args: [x, y] });
            lastCtrl = null; lastQuad = null;
            continue;
        }
        if (abs === 'C') {
            const v = need(6); if (!v) return { ok: false, why: 'a curve needs six numbers' };
            const p = rel ? [x + v[0], y + v[1], x + v[2], y + v[3], x + v[4], y + v[5]] : v;
            segments.push({ type: 'C', args: p });
            lastCtrl = [p[2], p[3]];
            x = p[4]; y = p[5];
            lastQuad = null;
            continue;
        }
        if (abs === 'S') {
            const v = need(4); if (!v) return { ok: false, why: 'a smooth curve needs four numbers' };
            const p = rel ? [x + v[0], y + v[1], x + v[2], y + v[3]] : v;
            const c1 = lastCtrl ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
            segments.push({ type: 'C', args: [c1[0], c1[1], p[0], p[1], p[2], p[3]] });
            lastCtrl = [p[0], p[1]];
            x = p[2]; y = p[3];
            lastQuad = null;
            continue;
        }
        if (abs === 'Q') {
            const v = need(4); if (!v) return { ok: false, why: 'a quadratic curve needs four numbers' };
            const p = rel ? [x + v[0], y + v[1], x + v[2], y + v[3]] : v;
            segments.push({ type: 'Q', args: p });
            lastQuad = [p[0], p[1]];
            x = p[2]; y = p[3];
            lastCtrl = null;
            continue;
        }
        if (abs === 'T') {
            const v = need(2); if (!v) return { ok: false, why: 'a smooth quadratic needs two numbers' };
            const p = rel ? [x + v[0], y + v[1]] : v;
            const c1 = lastQuad ? [2 * x - lastQuad[0], 2 * y - lastQuad[1]] : [x, y];
            segments.push({ type: 'Q', args: [c1[0], c1[1], p[0], p[1]] });
            lastQuad = c1;
            x = p[0]; y = p[1];
            lastCtrl = null;
            continue;
        }
        if (abs === 'A') {
            const v = need(7); if (!v) return { ok: false, why: 'an arc needs seven numbers' };
            const [rx, ry, phi, laf, sf, ex, ey] = v;
            const tx = rel ? x + ex : ex, ty = rel ? y + ey : ey;
            const parts = arcToCubics(x, y, rx, ry, phi, laf !== 0, sf !== 0, tx, ty);
            for (const p of parts) segments.push({ type: 'C', args: p });
            x = tx; y = ty;
            lastCtrl = null; lastQuad = null;
            continue;
        }
        return { ok: false, why: 'the command "' + cmd + '" is not a path command' };
    }
    if (!segments.length) return { ok: false, why: 'the path data is empty' };
    return { ok: true, segments };
}

/** The true bounds of the outline, curves included. */
function bbox(segments) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const add = (x, y) => { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; };
    let cx = 0, cy = 0, sx = 0, sy = 0;
    for (const s of segments) {
        if (s.type === 'M') { cx = sx = s.args[0]; cy = sy = s.args[1]; add(cx, cy); continue; }
        if (s.type === 'L') { cx = s.args[0]; cy = s.args[1]; add(cx, cy); continue; }
        if (s.type === 'C') {
            const [a, b, c, d, e, f] = s.args;
            const xs = cubicExtrema(cx, a, c, e);
            const ys = cubicExtrema(cy, b, d, f);
            for (let k = 0; k < xs.length; k++) add(xs[k], ys[k]);
            cx = e; cy = f;
            continue;
        }
        if (s.type === 'Q') {
            const [a, b, c, d] = s.args;
            const xs = quadExtrema(cx, a, c), ys = quadExtrema(cy, b, d);
            for (let k = 0; k < xs.length; k++) add(xs[k], ys[k]);
            cx = c; cy = d;
            continue;
        }
        if (s.type === 'Z') { cx = sx; cy = sy; }
    }
    if (!Number.isFinite(x1)) return null;
    return { x1, y1, x2, y2 };
}

/** The contours of the outline: each with its start and whether it was closed. */
function subpaths(segments) {
    const out = [];
    let cur = null;
    for (const s of segments) {
        if (s.type === 'M') { cur = { start: [s.args[0], s.args[1]], closed: false, points: [[s.args[0], s.args[1]]] }; out.push(cur); continue; }
        if (!cur) continue;
        if (s.type === 'L') cur.points.push([s.args[0], s.args[1]]);
        else if (s.type === 'C') cur.points.push([s.args[4], s.args[5]]);
        else if (s.type === 'Q') cur.points.push([s.args[2], s.args[3]]);
        else if (s.type === 'Z') cur.closed = true;
    }
    return out;
}

/** True when every contour ends with a close: a glyph's outline must not run off the edge. */
function closed(segments) {
    const subs = subpaths(segments);
    if (!subs.length) return false;
    return subs.every((s) => s.closed);
}

/** The same outline as path data: absolute, two decimals, arcs already cubics. */
function toData(segments) {
    const parts = [];
    for (const s of segments) {
        if (s.type === 'M') parts.push('M' + numText(s.args[0]) + ' ' + numText(s.args[1]));
        else if (s.type === 'L') parts.push('L' + numText(s.args[0]) + ' ' + numText(s.args[1]));
        else if (s.type === 'C') parts.push('C' + s.args.map(numText).join(' '));
        else if (s.type === 'Q') parts.push('Q' + s.args.map(numText).join(' '));
        else parts.push('Z');
    }
    return parts.join(' ');
}

module.exports = { parse, bbox, subpaths, closed, toData, round, numText, scan };
