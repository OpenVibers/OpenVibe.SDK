'use strict';
/**
 * ui.layout validation and editing (make your own controls design, 2026-11-11, pieces 2-3).
 *
 * One function is the authority for a person's arrangement of a surface: the server uses it before
 * a layout is stored, the editor uses it before Save, and OpenVibe.AI uses it on every answer. It is
 * plain code with no browser or Node dependency, so the same check runs everywhere.
 *
 *   validate(catalog, layout)  -> { ok, reasons[] }   the catalog is ui.surface@1, the layout ui.layout@1
 *   applyDefaults(catalog)                          -> a valid layout for the default (or named) device
 *   merge(layout, patch)                            -> a new layout, patched by part id
 *
 * The rules, in the words a person sees (the design note's "Can't do that: <reason>"):
 *   - required parts present, visible and at their minimum size;
 *   - anything pressed is at least 44 px, and a part above that gets its own minimum (Stop 64 px);
 *   - nothing covers a required part, and a catalog's never_covers rules hold;
 *   - every tint is a theme token the catalog lists, and every style and binding is one the part allows;
 *   - only parts the catalog has;
 *   - no URL, markup or code anywhere: a layout is data.
 *
 * The validator never changes a layout and never fills a missing value in: a caller that wants the
 * default asks applyDefaults. Reasons are unique and in a stable order, so two runs and two callers
 * agree on the refusal.
 */

const DEVICE_PX = { phone: 44, tablet: 44, computer: 44 };
const DEVICE_COLUMNS = { phone: 4, tablet: 8, computer: 12 };
const PRESSED_PX = 44;
const MIN_OPACITY = 0.4;
const MAX_OPACITY = 1;
const URL_RE = /(?:https?:\/\/|www\.)/i;
const SCHEME_RE = /(?:^|[\s"'(])(?:javascript|data|vbscript|file):/i;
const CODE_RE = /(?:<\s*\/?\s*(?:script|iframe|img|svg|style|a|object|embed)\b|\bon[a-z]{3,}\s*=|\bfunction\s*\(|=>|\beval\s*\(|\brequire\s*\(|\bimport\s*\()/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const nameOf = (part) => String((part && part.name) || (part && part.id) || 'that part');
const unique = (list) => [...new Set(list)];

/** Every string (and object key) in a value, for the no-URL/no-code rule. */
function stringsIn(value, out = []) {
    if (typeof value === 'string') { out.push(value); return out; }
    if (Array.isArray(value)) { for (const v of value) stringsIn(v, out); return out; }
    if (!isObject(value)) return out;
    for (const [k, v] of Object.entries(value)) { out.push(k); stringsIn(v, out); }
    return out;
}

/** A part's size in cells: grid place (w/h) or dock place (w/h); null when the place is unusable. */
function sizeOf(place) {
    if (!isObject(place)) return null;
    if (place.dock !== undefined) {
        return Number.isInteger(place.w) && Number.isInteger(place.h) && place.w >= 1 && place.h >= 1 ? { w: place.w, h: place.h } : null;
    }
    return Number.isInteger(place.w) && Number.isInteger(place.h) && place.w >= 1 && place.h >= 1 ? { w: place.w, h: place.h } : null;
}

/** The rectangular cells a visible part occupies, or null for a dock (which covers along its edge). */
function boxOf(part) {
    const p = part && part.place;
    if (!isObject(p) || p.dock !== undefined) return null;
    if (![p.x, p.y, p.w, p.h].every(Number.isInteger)) return null;
    if (p.x < 0 || p.y < 0 || p.w < 1 || p.h < 1) return null;
    return { x: p.x, y: p.y, w: p.w, h: p.h };
}

function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Two docked parts cover each other only when they claim the same edge and order. */
function dockOverlaps(a, b) {
    const pa = a && a.place;
    const pb = b && b.place;
    return isObject(pa) && isObject(pb) && pa.dock !== undefined && pb.dock !== undefined
        && pa.dock === pb.dock && pa.order === pb.order;
}

/**
 * Check one layout against its surface catalog.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function validate(catalog, layout) {
    const reasons = [];
    const fail = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };
    if (!isObject(catalog) || !Array.isArray(catalog.parts)) {
        return { ok: false, reasons: ['The surface catalog is missing.'] };
    }
    if (!isObject(layout)) return { ok: false, reasons: ['A layout has to be an object.'] };

    // A layout is data: never a URL, markup or code, anywhere in a name, a value or a key.
    if (stringsIn(layout).some((s) => URL_RE.test(s) || SCHEME_RE.test(s) || CODE_RE.test(s))) {
        fail("A layout is data only: it can't carry a URL or code.");
    }

    if (layout.surface !== catalog.id) fail(`This layout is not for ${catalog.id || 'this surface'}.`);
    if (layout.surface_version !== catalog.version) {
        fail(`${catalog.name || 'This surface'} has changed since this layout was made; reset it to the default.`);
    }
    const device = layout.device;
    const devices = Array.isArray(catalog.devices) ? catalog.devices : ['phone', 'tablet', 'computer'];
    if (!devices.includes(device)) fail(`This surface doesn't come in ${device || 'that device'}.`);

    const columns = (catalog.grid && catalog.grid.columns && catalog.grid.columns[device]) || DEVICE_COLUMNS[device] || 4;
    const cellPx = (catalog.grid && catalog.grid.cell_px && catalog.grid.cell_px[device]) || DEVICE_PX[device] || 44;
    const tokens = Array.isArray(catalog.theme_tokens) ? catalog.theme_tokens : [];
    const byId = new Map(catalog.parts.filter((p) => p && p.id).map((p) => [p.id, p]));
    const parts = Array.isArray(layout.parts) ? layout.parts : [];
    const placed = new Map();

    if (!Array.isArray(layout.parts) || layout.parts.length === 0) fail('A layout needs at least one part.');

    for (const placedPart of parts) {
        if (!isObject(placedPart) || typeof placedPart.id !== 'string') { fail('Every part in a layout needs an id.'); continue; }
        const source = byId.get(placedPart.id);
        if (!source) { fail(`${placedPart.id} is not a part of ${catalog.name || 'this surface'}.`); continue; }
        if (placed.has(placedPart.id)) { fail(`${nameOf(source)} appears more than once.`); continue; }
        placed.set(placedPart.id, placedPart);

        const name = nameOf(source);
        if (source.required && placedPart.visible !== true) fail(`${name} has to stay visible.`);

        const place = placedPart.place;
        if (!isObject(place)) { fail(`${name} needs a place on the surface.`); continue; }
        const size = sizeOf(place);
        if (!size) { fail(`${name} needs a size, in cells.`); continue; }
        if (place.dock !== undefined) {
            if (!['left', 'right', 'top', 'bottom'].includes(place.dock)) fail(`${name} can only dock to an edge.`);
            if (!Number.isInteger(place.order) || place.order < 0) fail(`${name} needs a place in the dock order.`);
        } else {
            if (!Number.isInteger(place.x) || place.x < 0 || !Number.isInteger(place.y) || place.y < 0) fail(`${name} needs a place on the grid.`);
            else if (place.x + place.w > columns) fail(`${name} runs past the edge of the ${device} grid.`);
        }
        const min = source.min || {};
        if (size.w < (min.w || 1) || size.h < (min.h || 1)) {
            fail(`${name} has to be at least ${Math.max(min.w || 1, 1)} × ${Math.max(min.h || 1, 1)} cells.`);
        }
        const needPx = Math.max(source.pressed ? PRESSED_PX : 0, Number(min.px) || 0);
        if (needPx && (size.w * cellPx < needPx || size.h * cellPx < needPx)) fail(`${name} has to be at least ${needPx} px.`);

        const style = isObject(placedPart.style) ? placedPart.style : {};
        const allowedStyles = isObject(source.styles) ? source.styles : {};
        if (typeof style.tint !== 'string' || !tokens.includes(style.tint)) {
            fail(`${name}'s tint has to be one of the theme's tokens${tokens.length ? ` (${tokens.join(', ')})` : ''}.`);
        } else if (Array.isArray(allowedStyles.tints) && !allowedStyles.tints.includes(style.tint)) {
            fail(`${name} can only be tinted ${allowedStyles.tints.join(', ')}.`);
        }
        if (!['round', 'pill', 'square'].includes(style.shape)) fail(`${name} needs a shape: round, pill or square.`);
        else if (Array.isArray(allowedStyles.shapes) && !allowedStyles.shapes.includes(style.shape)) {
            fail(`${name} can only be ${allowedStyles.shapes.join(', ')}.`);
        }
        const low = Math.max(MIN_OPACITY, Number(allowedStyles.opacity && allowedStyles.opacity.min) || MIN_OPACITY);
        const high = Math.min(MAX_OPACITY, Number(allowedStyles.opacity && allowedStyles.opacity.max) || MAX_OPACITY);
        if (typeof style.opacity !== 'number' || style.opacity < low || style.opacity > high) {
            fail(`${name}'s opacity has to be between ${low} and ${high}.`);
        }
        if (style.label !== true && style.label !== false) fail(`${name} says whether its label is on.`);
        else if (style.label && allowedStyles.label === false) fail(`${name} can't show a label.`);

        const bindings = isObject(placedPart.bindings) ? placedPart.bindings : {};
        const allowed = isObject(source.bindings) ? source.bindings : {};
        for (const kind of ['keys', 'gamepad']) {
            const list = Array.isArray(bindings[kind]) ? bindings[kind] : [];
            const ok = Array.isArray(allowed[kind]) ? allowed[kind] : [];
            const bad = list.filter((b) => !ok.includes(b));
            if (bad.length) fail(`${name} can't be bound to ${bad.join(', ')}.`);
            if (new Set(list).size !== list.length) fail(`${name} binds ${kind} more than once.`);
        }
    }

    for (const source of catalog.parts) {
        if (source && source.required && !placed.has(source.id)) fail(`${nameOf(source)} has to stay on the surface.`);
    }

    // Nothing covers a required part. Only a visible part can cover anything, and a required part
    // that is itself hidden is already refused above; its neighbours still do not cover it.
    const visible = parts.filter((p) => p && p.visible === true && placed.has(p.id));
    for (const required of visible) {
        const source = byId.get(required.id);
        if (!source || !source.required) continue;
        for (const other of visible) {
            if (other === required || other.id === required.id) continue;
            const covers = overlaps(boxOf(required) || { x: 0, y: 0, w: 0, h: 0 }, boxOf(other) || { x: 0, y: 0, w: 0, h: 0 })
                || dockOverlaps(required, other);
            if (covers) fail(`${nameOf(byId.get(other.id))} covers ${nameOf(source)}.`);
        }
    }
    // A catalog's own never_covers rules, in either direction of the relation it states.
    for (const [id, source] of byId) {
        const own = placed.get(id);
        if (!own || own.visible !== true) continue;
        for (const targetId of Array.isArray(source.never_covers) ? source.never_covers : []) {
            const target = placed.get(targetId);
            if (!target || target.visible !== true) continue;
            const targetSource = byId.get(targetId);
            if (overlaps(boxOf(own) || { x: 0, y: 0, w: 0, h: 0 }, boxOf(target) || { x: 0, y: 0, w: 0, h: 0 }) || dockOverlaps(own, target)) {
                fail(`${nameOf(source)} covers ${nameOf(targetSource || { id: targetId })}.`);
            }
        }
    }

    return { ok: reasons.length === 0, reasons };
}

/** The cells a part needs at the default size: its own minimum, and at least 44 px when pressed. */
function cellsFor(part, cellPx) {
    const min = part.min || {};
    const px = Math.max(part.pressed ? PRESSED_PX : 0, Number(min.px) || 0);
    return {
        w: Math.max(1, Number(min.w) || 1, px ? Math.ceil(px / cellPx) : 0),
        h: Math.max(1, Number(min.h) || 1, px ? Math.ceil(px / cellPx) : 0),
    };
}

/**
 * The default arrangement of a surface: every catalog part, visible, at its minimum (or a size that
 * meets the 44 px rule), required parts first, laid out left to right and then down the grid.
 * @param {object} catalog ui.surface@1
 * @param {'phone'|'tablet'|'computer'} [device] defaults to the catalog's first device
 */
function applyDefaults(catalog, device) {
    if (!isObject(catalog) || !Array.isArray(catalog.parts)) throw new TypeError('applyDefaults: a ui.surface@1 catalog is required');
    const chosen = (Array.isArray(catalog.devices) && catalog.devices.includes(device)) ? device : (catalog.devices || ['phone'])[0];
    const columns = (catalog.grid && catalog.grid.columns && catalog.grid.columns[chosen]) || DEVICE_COLUMNS[chosen] || 4;
    const cellPx = (catalog.grid && catalog.grid.cell_px && catalog.grid.cell_px[chosen]) || DEVICE_PX[chosen] || 44;
    const ordered = [...catalog.parts].sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
    let x = 0; let y = 0; let rowHeight = 0;
    const parts = ordered.map((part) => {
        const size = cellsFor(part, cellPx);
        const w = Math.min(columns, size.w);
        const h = size.h;
        if (x + w > columns) { x = 0; y += rowHeight; rowHeight = 0; }
        const place = { x, y, w, h };
        x += w;
        rowHeight = Math.max(rowHeight, h);
        const styles = isObject(part.styles) ? part.styles : {};
        const bindings = isObject(part.bindings) ? part.bindings : {};
        const tokens = Array.isArray(catalog.theme_tokens) ? catalog.theme_tokens : [];
        const tints = Array.isArray(styles.tints) ? styles.tints : [];
        return {
            id: part.id,
            visible: true,
            place,
            style: {
                tint: tints.find((t) => tokens.includes(t)) || tints[0] || tokens[0] || 'surface',
                shape: (Array.isArray(styles.shapes) && styles.shapes[0]) || 'square',
                opacity: 1,
                label: styles.label !== false,
            },
            bindings: {
                keys: Array.isArray(bindings.keys) ? [...bindings.keys] : [],
                gamepad: Array.isArray(bindings.gamepad) ? [...bindings.gamepad] : [],
            },
        };
    });
    return {
        surface: catalog.id,
        surface_version: catalog.version,
        device: chosen,
        name: 'Default',
        author: { name: 'OpenVibe' },
        sharing: 'private',
        parts,
    };
}

function mergeInto(base, patch) {
    if (!isObject(base)) return clone(patch);
    if (!isObject(patch)) return clone(patch);
    const out = clone(base);
    for (const [key, value] of Object.entries(patch)) {
        if (isObject(value) && isObject(out[key])) out[key] = mergeInto(out[key], value);
        else out[key] = clone(value);
    }
    return out;
}

/**
 * A new layout with `patch` applied. `parts` are merged by id: a patch part changes only the fields it
 * names, and a part the layout does not have is appended. Nothing is mutated, and the result is not
 * validated (the caller validates before storing or showing it).
 */
function merge(layout, patch) {
    if (!isObject(layout)) throw new TypeError('merge: a layout is required');
    if (!isObject(patch)) return clone(layout);
    const out = clone(layout);
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'parts' && Array.isArray(value)) {
            const parts = Array.isArray(out.parts) ? out.parts.map(clone) : [];
            const index = new Map(parts.map((p, i) => [p && p.id, i]));
            for (const incoming of value) {
                if (!isObject(incoming) || typeof incoming.id !== 'string') { parts.push(clone(incoming)); continue; }
                if (index.has(incoming.id)) parts[index.get(incoming.id)] = mergeInto(parts[index.get(incoming.id)], incoming);
                else { index.set(incoming.id, parts.length); parts.push(clone(incoming)); }
            }
            out.parts = parts;
        } else if (isObject(value) && isObject(out[key])) out[key] = mergeInto(out[key], value);
        else out[key] = clone(value);
    }
    return out;
}

module.exports = { validate, applyDefaults, merge, PRESSED_PX };
