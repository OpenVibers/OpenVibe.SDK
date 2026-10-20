/** openvibe-sdk/food: OpenVibe.Food — places to get food, the food list with prices, meal plans, a pantry and recipe ideas. */
type Opts = { signal?: AbortSignal };
type FoodJson = Record<string, any>;
export interface PantryResult {
    items: string[]; foods: FoodJson[];
    suggestions: { can_make: Array<{ slug: string; name: string; serves: number; minutes: number }>; almost: Array<{ slug: string; name: string; serves: number; minutes: number; missing: string[] }> };
    note: string;
}
export interface FoodClient {
    places(opts?: Opts & { kind?: string; q?: string; lat?: number; lon?: number; radius?: number; limit?: number }): Promise<FoodJson>;
    foods: {
        list(opts?: Opts & { group?: string; q?: string }): Promise<{ foods: FoodJson[]; count: number; groups: FoodJson[]; source: FoodJson }>;
        get(slug: string, opts?: Opts): Promise<{ food: FoodJson; source: FoodJson }>;
    };
    plans: {
        create(req: { people: number; days: number; budget?: number | null; title?: string | null }, opts?: Opts): Promise<FoodJson>;
        list(opts?: Opts & { limit?: number }): Promise<{ plans: FoodJson[] }>;
        get(id: string, opts?: Opts): Promise<FoodJson>;
    };
    pantry: { get(opts?: Opts): Promise<PantryResult>; set(items: string[], opts?: Opts): Promise<PantryResult> };
    recipes: { suggest(req?: { ask?: string; people?: number }, opts?: Opts): Promise<FoodJson>; list(opts?: Opts): Promise<{ recipes: FoodJson[] }> };
}
export function createFoodClient(client: { json(opts: Record<string, unknown>): Promise<any> }, options?: { baseUrl?: string }): FoodClient;
