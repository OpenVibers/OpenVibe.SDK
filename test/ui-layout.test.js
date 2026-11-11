'use strict';
// openvibe-sdk/ui-layout: the one validator the server, the editor and the AI call share (make your
// own controls design, pieces 2-3). Every rule gets a case, in the plain words the person sees.
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { validate, applyDefaults, merge, PRESSED_PX } = require('../src/ui-layout');

const catalog = () => ({
    id: 'bot.controls', version: 1, name: 'Robot controls', devices: ['phone', 'tablet', 'computer'],
    grid: { columns: { phone: 4, tablet: 8, computer: 12 }, cell_px: { phone: 44, tablet: 44, computer: 44 } },
    theme_tokens: ['danger', 'surface', 'surface-raised', 'accent', 'text'],
    parts: [
        {
            id: 'stop', name: 'Stop', kind: 'button', required: true, pressed: true,
            min: { w: 2, h: 2, px: 64 },
            styles: { tints: ['danger'], shapes: ['round', 'square'], opacity: { min: 0.7, max: 1 }, label: true },
            bindings: { keys: ['Space'], gamepad: ['south'] }, never_covers: [],
        },
        {
            id: 'stick', name: 'Drive stick', kind: 'stick', required: false, pressed: true,
            min: { w: 2, h: 2 },
            styles: { tints: ['surface'], shapes: ['round'], opacity: { min: 0.4, max: 1 }, label: false },
            bindings: { keys: ['W', 'A', 'S', 'D'], gamepad: ['left-stick'] }, never_covers: ['stop'],
        },
        {
            id: 'hat', name: 'Hat', kind: 'slider', required: false, pressed: true,
            min: { w: 1, h: 1 },
            styles: { tints: ['accent'], shapes: ['pill'], opacity: { min: 0.4, max: 1 }, label: true },
            bindings: { keys: ['ArrowUp'], gamepad: ['right-stick-y'] }, never_covers: ['battery'],
        },
        {
            id: 'battery', name: 'Battery', kind: 'readout', required: false, pressed: false,
            min: { w: 1, h: 1 },
            styles: { tints: ['text', 'surface'], shapes: ['pill', 'square'], opacity: { min: 0.4, max: 1 }, label: true },
            bindings: { keys: [], gamepad: [] }, never_covers: [],
        },
    ],
});

const part = (id, place, extra = {}) => ({
    id, visible: true, place,
    style: { tint: id === 'stop' ? 'danger' : id === 'stick' ? 'surface' : id === 'hat' ? 'accent' : 'text', shape: id === 'stop' ? 'round' : id === 'battery' ? 'pill' : id === 'hat' ? 'pill' : 'round', opacity: 1, label: id !== 'stick' },
    bindings: id === 'stop' ? { keys: ['Space'], gamepad: ['south'] } : id === 'stick' ? { keys: ['W', 'A', 'S', 'D'], gamepad: ['left-stick'] } : id === 'hat' ? { keys: ['ArrowUp'], gamepad: ['right-stick-y'] } : { keys: [], gamepad: [] },
    ...extra,
});

const layout = () => ({
    surface: 'bot.controls', surface_version: 1, device: 'phone', name: 'Mine',
    author: { name: 'Ana' }, sharing: 'private',
    parts: [part('stop', { x: 0, y: 0, w: 2, h: 2 }), part('stick', { x: 0, y: 2, w: 2, h: 2 }), part('battery', { x: 2, y: 2, w: 1, h: 1 })],
});

const reasonsOf = (l, c = catalog()) => validate(c, l).reasons;
const has = (reasons, re) => assert.ok(reasons.some((r) => re.test(r)), `expected ${re} in ${JSON.stringify(reasons)}`);

run([
    ['a complete layout passes, and every reason list is unique', async () => {
        assert.deepEqual(validate(catalog(), layout()), { ok: true, reasons: [] });
        assert.equal(PRESSED_PX, 44);
    }],

    ['required parts: present and visible', async () => {
        const missing = layout(); missing.parts = missing.parts.filter((p) => p.id !== 'stop');
        has(reasonsOf(missing), /Stop has to stay on the surface\./);
        const hidden = layout(); hidden.parts[0].visible = false;
        has(reasonsOf(hidden), /Stop has to stay visible\./);
    }],

    ['required parts: at their minimum cells and pixels', async () => {
        const small = layout(); small.parts[0].place = { x: 0, y: 0, w: 1, h: 1 };
        const reasons = reasonsOf(small);
        has(reasons, /Stop has to be at least 2 × 2 cells\./);
        has(reasons, /Stop has to be at least 64 px\./);
    }],

    ['pressed parts: at least 44 px even when the catalog asks for one cell', async () => {
        const c = catalog();
        c.grid.cell_px.phone = 40;
        c.parts = [c.parts.find((p) => p.id === 'stick')];
        c.parts[0].min = { w: 1, h: 1 };
        const l = { ...layout(), parts: [part('stick', { x: 0, y: 0, w: 1, h: 1 })] };
        has(reasonsOf(l, c), /Drive stick has to be at least 44 px\./);
    }],

    ['nothing covers a required part', async () => {
        const l = layout(); l.parts[1].place = { x: 0, y: 0, w: 2, h: 2 };
        has(reasonsOf(l), /Drive stick covers Stop\./);
        // A hidden part covers nothing.
        l.parts[1].visible = false;
        assert.ok(!reasonsOf(l).some((r) => /covers Stop/.test(r)));
    }],

    ['a catalog never_covers rule holds', async () => {
        const l = layout(); l.parts.push(part('hat', { x: 2, y: 3, w: 1, h: 1 }));
        l.parts[3].place = { x: 2, y: 2, w: 1, h: 1 };
        has(reasonsOf(l), /Hat covers Battery\./);
    }],

    ['only parts the catalog has, and only once', async () => {
        const extra = layout(); extra.parts.push(part('battery', { x: 3, y: 3, w: 1, h: 1 }));
        has(reasonsOf(extra), /Battery appears more than once\./);
        const unknown = layout(); unknown.parts.push({ ...part('battery', { x: 3, y: 3, w: 1, h: 1 }), id: 'dial' });
        has(reasonsOf(unknown), /dial is not a part of Robot controls\./);
    }],

    ['tints from theme tokens only, and only the ones the part allows', async () => {
        const hex = layout(); hex.parts[0].style.tint = '#ff0000';
        has(reasonsOf(hex), /Stop's tint has to be one of the theme's tokens/);
        const wrong = layout(); wrong.parts[0].style.tint = 'accent';
        has(reasonsOf(wrong), /Stop can only be tinted danger\./);
    }],

    ['shape, opacity and label follow the catalog', async () => {
        const l = layout(); l.parts[0].style.shape = 'pill';
        has(reasonsOf(l), /Stop can only be round, square\./);
        const faint = layout(); faint.parts[0].style.opacity = 0.5;
        has(reasonsOf(faint), /Stop's opacity has to be between 0.7 and 1\./);
        const transparent = layout(); transparent.parts[0].style.opacity = 0.2;
        has(reasonsOf(transparent), /Stop's opacity has to be between 0.7 and 1\./);
        const labelled = layout(); labelled.parts[1].style.label = true;
        has(reasonsOf(labelled), /Drive stick can't show a label\./);
    }],

    ['bindings are a subset of what the catalog allows', async () => {
        const l = layout(); l.parts[0].bindings.keys = ['Space', 'Enter'];
        has(reasonsOf(l), /Stop can't be bound to Enter\./);
        const pad = layout(); pad.parts[0].bindings.gamepad = ['south', 'north'];
        has(reasonsOf(pad), /Stop can't be bound to north\./);
        const twice = layout(); twice.parts[1].bindings.keys = ['W', 'W'];
        has(reasonsOf(twice), /Drive stick binds keys more than once\./);
    }],

    ['no URLs, markup or code anywhere', async () => {
        const url = layout(); url.name = 'my https://example.com panel';
        has(reasonsOf(url), /A layout is data only: it can't carry a URL or code\./);
        const code = layout(); code.parts[0].style.tint = 'javascript:alert(1)';
        has(reasonsOf(code), /A layout is data only: it can't carry a URL or code\./);
        const markup = layout(); markup.name = '<script>alert(1)</script>';
        has(reasonsOf(markup), /A layout is data only: it can't carry a URL or code\./);
        const handler = layout(); handler.name = 'onerror=alert(1)';
        has(reasonsOf(handler), /A layout is data only: it can't carry a URL or code\./);
    }],

    ['the layout is for the catalog it names, its version and a supported device', async () => {
        const surface = layout(); surface.surface = 'bot.overlay';
        has(reasonsOf(surface), /This layout is not for bot.controls\./);
        const version = layout(); version.surface_version = 2;
        has(reasonsOf(version), /has changed since this layout was made/);
        const device = layout(); device.device = 'watch';
        has(reasonsOf(device), /This surface doesn't come in watch\./);
    }],

    ['grid bounds and the dock form', async () => {
        const past = layout(); past.parts[0].place = { x: 3, y: 0, w: 2, h: 2 };
        has(reasonsOf(past), /Stop runs past the edge of the phone grid\./);
        const dock = layout();
        dock.parts = [part('stop', { dock: 'right', order: 0, w: 2, h: 2 }), part('battery', { dock: 'right', order: 1, w: 1, h: 1 })];
        assert.deepEqual(validate(catalog(), dock), { ok: true, reasons: [] });
        const same = layout();
        same.parts = [part('stop', { dock: 'right', order: 0, w: 2, h: 2 }), part('battery', { dock: 'right', order: 0, w: 1, h: 1 })];
        has(reasonsOf(same), /Battery covers Stop\./);
        const noSize = layout(); noSize.parts[0].place = { dock: 'right', order: 0 };
        has(reasonsOf(noSize), /Stop needs a size, in cells\./);
    }],

    ['applyDefaults gives a valid layout on every device, required parts first', async () => {
        for (const device of catalog().devices) {
            const d = applyDefaults(catalog(), device);
            assert.deepEqual(validate(catalog(), d), { ok: true, reasons: [] }, device);
            assert.equal(d.device, device);
            assert.equal(d.parts[0].id, 'stop', 'required parts come first');
            assert.ok(d.parts.every((p) => p.visible === true), 'the default shows every part');
            for (const p of d.parts) {
                const source = catalog().parts.find((x) => x.id === p.id);
                const px = Math.max(source.pressed ? 44 : 0, source.min.px || 0);
                assert.ok(p.place.w * 44 >= px && p.place.h * 44 >= px, `${p.id} meets its pixel minimum`);
            }
        }
        assert.equal(applyDefaults(catalog()).device, 'phone');
    }],

    ['applyDefaults sizes a part by its pixel minimum when the cell is small', async () => {
        const c = catalog();
        c.grid.cell_px.phone = 40;
        c.parts = c.parts.filter((p) => p.id === 'stop');
        c.parts[0].min = { w: 1, h: 1, px: 64 };
        const d = applyDefaults(c, 'phone');
        assert.equal(d.parts[0].place.w, 2, 'two 40 px cells reach 64 px');
        assert.deepEqual(validate(c, d), { ok: true, reasons: [] });
    }],

    ['merge is a copy: parts by id, deep style, new parts appended, nothing mutated', async () => {
        const before = layout();
        const snapshot = JSON.stringify(before);
        const merged = merge(before, {
            name: 'One thumb',
            parts: [
                { id: 'stop', style: { tint: 'danger', shape: 'square' } },
                { id: 'battery', visible: false },
                { id: 'hat', place: { x: 2, y: 3, w: 1, h: 1 }, style: { tint: 'accent', shape: 'pill', opacity: 1, label: true }, bindings: { keys: ['ArrowUp'], gamepad: ['right-stick-y'] } },
            ],
        });
        assert.equal(JSON.stringify(before), snapshot, 'the original layout is not touched');
        assert.equal(merged.name, 'One thumb');
        assert.equal(merged.parts.length, 4);
        assert.equal(merged.parts.find((p) => p.id === 'stop').style.shape, 'square');
        assert.equal(merged.parts.find((p) => p.id === 'stop').place.w, 2, 'a place not patched stays');
        assert.equal(merged.parts.find((p) => p.id === 'battery').visible, false);
        assert.equal(merged.parts[3].id, 'hat', 'a new part is appended');
        assert.deepEqual(validate(catalog(), merged), { ok: true, reasons: [] });
    }],

    ['merge can add a binding and hide a part; validate still decides', async () => {
        const changed = merge(layout(), { parts: [{ id: 'stop', bindings: { keys: ['Space'], gamepad: ['south'] } }] });
        assert.deepEqual(validate(catalog(), changed), { ok: true, reasons: [] });
        const hidden = merge(layout(), { parts: [{ id: 'stop', visible: false }] });
        assert.deepEqual(validate(catalog(), hidden).ok, false);
    }],
]);
