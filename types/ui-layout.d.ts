/** A ui.surface@1 part (the subset this module reads). */
export interface UiSurfacePart {
    id: string;
    name: string;
    kind?: 'stick' | 'button' | 'slider' | 'readout' | 'video' | 'list';
    required?: boolean;
    pressed?: boolean;
    min?: { w?: number; h?: number; px?: number };
    styles?: {
        tints?: string[];
        shapes?: Array<'round' | 'pill' | 'square'>;
        opacity?: { min?: number; max?: number };
        label?: boolean;
    };
    bindings?: { keys?: string[]; gamepad?: string[] };
    never_covers?: string[];
}

/** The parts of ui.surface@1 this module reads. */
export interface UiSurfaceCatalog {
    id: string;
    version: number;
    name?: string;
    devices?: Array<'phone' | 'tablet' | 'computer'>;
    grid?: {
        columns?: Partial<Record<'phone' | 'tablet' | 'computer', number>>;
        cell_px?: Partial<Record<'phone' | 'tablet' | 'computer', number>>;
    };
    theme_tokens?: string[];
    parts: UiSurfacePart[];
}

export interface UiLayoutPart {
    id: string;
    visible: boolean;
    place: { x: number; y: number; w: number; h: number } | { dock: 'left' | 'right' | 'top' | 'bottom'; order: number; w: number; h: number };
    style: { tint: string; shape: 'round' | 'pill' | 'square'; opacity: number; label: boolean };
    bindings: { keys: string[]; gamepad: string[] };
}

/** A ui.layout@1 document as this module reads and writes it. */
export interface UiLayout {
    id?: string;
    revision?: number;
    surface: string;
    surface_version: number;
    device: 'phone' | 'tablet' | 'computer';
    name: string;
    author: { name: string; subject?: { type: string; id: string } };
    sharing: 'private' | 'link' | 'gallery';
    parts: UiLayoutPart[];
    updated_at?: string;
}

export interface UiLayoutValidation {
    ok: boolean;
    reasons: string[];
}

/** Every rule the design note gives, in plain words. */
export declare function validate(catalog: UiSurfaceCatalog, layout: UiLayout): UiLayoutValidation;

/** The default arrangement: every part visible, required parts first, none under 44 px. */
export declare function applyDefaults(catalog: UiSurfaceCatalog, device?: 'phone' | 'tablet' | 'computer'): UiLayout;

/** A copy with the patch applied; parts merge by id, new parts append, nothing is mutated. */
export declare function merge(layout: UiLayout, patch: Partial<UiLayout> & { parts?: Array<Partial<UiLayoutPart> & { id: string }> }): UiLayout;

export declare const PRESSED_PX: number;
