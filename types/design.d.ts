export type GlyphStyle = 'thin' | 'light' | 'regular' | 'bold' | 'solid' | 'duotone';
export interface DesignGlyph { name: string; style: GlyphStyle; svg: string; solid: string; strokeWidth: number | null; underlay: string; underlayOpacity: number; }
export interface DesignGlyphReference { name: string; set: string; setName: string; author: string; license: string; licenseUrl: string; preview: string; }
export interface DesignGlyphDraft { id: string; name: string; svg: string; solid_svg: string | null; styles: GlyphStyle[]; references: DesignGlyphReference[]; status: string; }
export declare function createDesignClient(options: { accessToken: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): {
    icons: {
        draft(input: { name: string; sentence?: string; styles?: GlyphStyle[]; sourceSvg?: string }, opts?: { signal?: AbortSignal }): Promise<{ kept: DesignGlyphDraft[]; refused: string[] }>;
        get(name: string, opts?: { style?: GlyphStyle; signal?: AbortSignal }): Promise<DesignGlyph>;
        search(q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<{ query: string; glyphs: DesignGlyph[] }>;
    };
};
export declare const DEFAULT_DESIGN_URL: string;
