/** openvibe-sdk/shoes: Open.Shoes public catalog and tools. */
export type ProductKind = 'shoe' | 'laces' | 'socks' | 'care' | 'insoles' | 'kids';
export interface ShoesClient {
  products: {
    list(args?: { kind?: ProductKind; q?: string; size?: string; signal?: AbortSignal }): Promise<{ products: unknown[]; total: number }>;
    get(id: string, options?: { signal?: AbortSignal }): Promise<{ product: unknown }>;
    offers(id: string, options?: { signal?: AbortSignal }): Promise<{ offers: unknown[] }>;
  };
  tools: { laceLength(args: { eyelet_pairs: number; method?: string; horizontal_cm?: number; vertical_cm?: number; ends_cm?: number; signal?: AbortSignal }): Promise<{ cm: number; inches: number; method: string }> };
  sizes: { convert(args: { system: string; size: string; brand?: string; signal?: AbortSignal }): Promise<{ conversions: unknown[] }> };
}
export function createShoesClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): ShoesClient;
