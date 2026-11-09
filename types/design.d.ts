export type GlyphStyle = 'thin' | 'light' | 'regular' | 'bold' | 'solid' | 'duotone';
export interface DesignGlyph { name: string; style: GlyphStyle; svg: string; solid: string; strokeWidth: number | null; underlay: string; underlayOpacity: number; }
export interface DesignGlyphReference { name: string; set: string; setName: string; author: string; license: string; licenseUrl: string; preview: string; }
export interface DesignGlyphDraft { id: string; name: string; svg: string; solid_svg: string | null; styles: GlyphStyle[]; references: DesignGlyphReference[]; status: string; }
export interface DesignComponent {
  schema: 'design.component@1';
  name: string;
  title: string;
  summary: string;
  anatomy: Array<{ part: string; role: string }>;
  props: Record<string, string>;
  states: string[];
  tokens: string[];
  behaviors: { keyboardAware: boolean; outsideTapCloses: boolean; scrollLock: boolean; reducedMotion: string };
  accessibility: { name: string; target: string; focus: string };
  platforms: {
    web: { module: string; markup: string; demo: string };
    android: { toolkit: 'Jetpack Compose'; material3: string; specification: string };
    ios: { toolkit: 'SwiftUI'; specification: string };
  };
  examples: Array<{ title: string; props: Record<string, unknown> }>;
}

/** accessToken is needed for icons only; the component registry is public. */
export declare function createDesignClient(options?: { accessToken?: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): {
    icons: {
        draft(input: { name: string; sentence?: string; styles?: GlyphStyle[]; sourceSvg?: string }, opts?: { signal?: AbortSignal }): Promise<{ kept: DesignGlyphDraft[]; refused: string[] }>;
        get(name: string, opts?: { style?: GlyphStyle; signal?: AbortSignal }): Promise<DesignGlyph>;
        search(q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<{ query: string; glyphs: DesignGlyph[] }>;
    };
    components(opts?: { signal?: AbortSignal }): Promise<{ schema: 'design.component@1'; components: DesignComponent[]; kitComponents: unknown[] }>;
    component(name: string, opts?: { signal?: AbortSignal }): Promise<{ schema: 'design.component@1'; component: DesignComponent; examples: DesignComponent['examples'] } | null>;
};
export declare const DEFAULT_DESIGN_URL: string;
