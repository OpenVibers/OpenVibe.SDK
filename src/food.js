'use strict';
/**
 * openvibe-sdk/food — OpenVibe.Food for apps: places to get food near you (food banks, pantries, free meals; from
 * OpenStreetMap), the food list with store prices, meal plans, a person's pantry with "what can I make", and recipe
 * ideas from the network's AI. Routes at https://openvibe.food/api/v1; tokens for audience openvibe.food.
 *
 *   const food = createFoodClient(createClient({ tokenProvider }));
 *   const near = await food.places({ kind: 'foodbank', lat: 45.52, lon: -122.68, radius: 10 });   // public
 *   const { foods } = await food.foods.list({ group: 'vegetables', q: 'carrot' });               // public
 *   const plan = await food.plans.create({ people: 2, days: 7, budget: 80, title: 'This week' }); // food.plan.write
 *   await food.pantry.set(['rice', 'black-beans', 'onions']);                                    // food.pantry.write
 *   const { suggestions } = await food.pantry.get();                                             // { can_make, almost }
 *   const ideas = await food.recipes.suggest({ ask: 'something quick', people: 2 });             // 10 a day
 *
 * A plan, a pantry and recipe ideas are the caller's own: a person's token, or an app holding the capability. A plan
 * is deterministic (all six MyPlate groups, a shopping list, the cheapest store per line, a budget as a hard cap); the
 * pantry's suggestions are matches against basic recipes, not dietary advice. Creating a plan or asking for recipe
 * ideas makes a new one each time, so neither is retried on its own; setting the pantry is a PUT and is.
 * Errors are OpenVibeError: food.plan.invalid, food.pantry.invalid, food.pantry.unknown_item, food.pantry_empty,
 * food.recipes_daily_limit (429), food.ai_off (503), food.plan.not_found, …
 */
const enc = encodeURIComponent;
const PLAN_ID_RE = /^pln_[0-9A-HJKMNP-TV-Z]{26}$/;   // Food's own rule

function createFoodClient(client, { baseUrl } = {}) {
    if (!client || typeof client.json !== 'function') throw new TypeError('createFoodClient: pass an openvibe-sdk/core client');
    const at = { service: 'food', baseUrl, audience: 'openvibe.food' };
    const call = (opts) => client.json({ ...at, ...opts });
    const planId = (id) => {
        if (!PLAN_ID_RE.test(String(id || ''))) throw new TypeError('food: a plan is a pln_ id');
        return enc(String(id));
    };

    return {
        /** Places to get food (public): kind foodbank (default) or another kind Food lists, near lat/lon or a place q. */
        places: ({ kind, q, lat, lon, radius, limit, signal } = {}) => call({ path: '/api/v1/places', query: { kind, q, lat, lon, radius, limit }, signal }),
        foods: {
            /** The food list with store prices (public), by MyPlate group and/or a search. */
            list: ({ group, q, signal } = {}) => call({ path: '/api/v1/foods', query: { group, q }, signal }),
            get: (slug, { signal } = {}) => call({ path: `/api/v1/foods/${enc(String(slug))}`, signal }),
        },
        plans: {
            /** A meal plan for 1–14 days (food.plan-create-request@1) → the plan, saved as the caller's. */
            create: ({ people, days, budget, title } = {}, { signal } = {}) => call({ method: 'POST', path: '/api/v1/plans', json: { people, days, budget, title }, idempotencyKey: false, signal }),
            list: ({ limit, signal } = {}) => call({ path: '/api/v1/plans', query: { limit }, signal }),
            get: (id, { signal } = {}) => call({ path: `/api/v1/plans/${planId(id)}`, signal }),
        },
        pantry: {
            /** The caller's pantry: { items, foods, suggestions: { can_make, almost }, note }. */
            get: ({ signal } = {}) => call({ path: '/api/v1/pantry', signal }),
            /** Replace the pantry with these food slugs (at most 200; GET foods lists them). */
            set: (items, { signal } = {}) => {
                if (!Array.isArray(items)) throw new TypeError('food.pantry.set: items is an array of food slugs');
                if (items.length > 200) throw new TypeError('food.pantry.set: at most 200 items');
                return call({ method: 'PUT', path: '/api/v1/pantry', json: { items: items.map(String) }, signal });
            },
        },
        recipes: {
            /** Recipe ideas from the pantry through OpenVibe.AI (10 a day per person); ask and people are optional. */
            suggest: ({ ask, people } = {}, { signal } = {}) => call({ method: 'POST', path: '/api/v1/recipes/suggest', json: { ask, people }, idempotencyKey: false, signal }),
            /** The caller's last 20 suggestions. */
            list: ({ signal } = {}) => call({ path: '/api/v1/recipes', signal }),
        },
    };
}

module.exports = { createFoodClient };
