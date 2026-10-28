/** openvibe-sdk/food: OpenVibe.Food — places to get food, the food list with prices, meal plans, a pantry and recipe ideas. */
type Opts = { signal?: AbortSignal };
type FoodJson = Record<string, any>;
export interface PantryResult {
    items: string[]; foods: FoodJson[];
    suggestions: { can_make: Array<{ slug: string; name: string; serves: number; minutes: number }>; almost: Array<{ slug: string; name: string; serves: number; minutes: number; missing: string[] }> };
    note: string;
}
export type BoxKind = 'cook' | 'ready' | 'produce' | 'meat' | 'snacks' | 'coffee' | 'baby' | 'pets';
/** A food box: every fact as its own pages stated it (sources, checked), null when nobody checked. */
export interface FoodBox {
    slug: string; name: string; kind: BoxKind; kind_name: string; url: string; host: string; what: string;
    cadence: string[]; people: number[]; meals_per_week: number[]; diets: string[];
    price: { from: number | null; to: number | null; unit: 'serving' | 'meal' | 'box' | 'month' | 'delivery' | 'day' | 'membership'; text: string; line: string | null } | null;
    shipping: { amount: number | null; to?: number | null; text: string } | null;
    ships_to: string | null; cancel: string | null; notes: string[]; sources: string[]; checked: string | null;
    links: { page: string; coupons: string; reviews: string };
}
type Range = { from: number; to: number };
export interface FoodBoxCost { servings: number; weeks: number; food: Range; shipping: Range | null; total: Range | null; basis: string }
export interface FoodClient {
    places(opts?: Opts & { kind?: string; q?: string; lat?: number; lon?: number; radius?: number; limit?: number }): Promise<FoodJson>;
    foods: {
        list(opts?: Opts & { group?: string; q?: string }): Promise<{ foods: FoodJson[]; count: number; groups: FoodJson[]; source: FoodJson }>;
        get(slug: string, opts?: Opts): Promise<{ food: FoodJson; source: FoodJson }>;
    };
    boxes: {
        list(opts?: Opts & { kind?: BoxKind; diet?: string; q?: string }): Promise<{ boxes: FoodBox[]; count: number; kinds: FoodJson[]; diets: Record<string, string>; method: string }>;
        get(slug: string, opts?: Opts): Promise<{ box: FoodBox; coupons: { url: string; active: number; best: { code: string; title: string } | null } | null; reviews: { url: string; name: string; percent: number | null; total: number | null; line: string | null } | null }>;
        cost(slug: string, opts?: Opts & { people?: number; meals?: number; weeks?: number }): Promise<{ box: string; cost: FoodBoxCost }>;
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
