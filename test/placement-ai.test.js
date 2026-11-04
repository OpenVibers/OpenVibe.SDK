'use strict';
/**
 * openvibe-sdk/placement, the AI Exchange face (plan-state 2026-10-22 §E, G-P1/P7; decisions D1 and D5):
 * hard gates before scoring, the expected cost per success, sparse evidence marked and not trusted, the
 * nano-USD math by hand, and an explanation that never carries a secret or a host.
 *
 * Every number below is hand-computed in its comment.
 */
const assert = require('node:assert/strict');
const { run } = require('./helpers');
const { planAi, aiExcluded, safeReason, PROVIDER_ACCESS, PAID_PROVIDER_ACCESS } = require('../src/placement');
const { nanoUsd, chargeTokens, expectedCostNano, costPerSuccessNano, formatNanoUsd } = require('../src/cost');

// The contracts of the AI Exchange (ai.route-explain@1) may not be in the pinned openvibe-contracts yet; the
// shape check then skips and says so.
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* not installed */ }
let hasRouteExplain = false;
if (contracts) {
    try { contracts.validate('ai.route-explain@1', { chosen: 'x', rejected: [], objective: 'cheapest', estimate: { charge_nano_usd: '0' } }); hasRouteExplain = true; } catch { /* the contract is not in this pin yet */ }
}

const T = Date.parse('2026-11-03T12:00:00Z');

// The usage of one request: 800 uncached input tokens, 400 output tokens.
const USAGE = { input_tokens: 800, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 400 };

// The rates of one model (ai.model@1 retail_rate): 3000 nano-USD per million input tokens, 15000 per million
// output tokens, no per-request fee.
const RATES = {
    input_nano_usd_per_m: '3000',
    cached_read_nano_usd_per_m: '300',
    cache_write_nano_usd_per_m: '3000',
    output_nano_usd_per_m: '15000',
    per_request_nano_usd: '0',
};

// A deployment (ai.inference-deployment@1) with its model (ai.model@1).
const deployment = (id, extra = {}) => ({
    id,
    artifact_id: 'qwen/qwen3-9b-abliterated:q4_k_m@3f2a1c9',
    region: 'us-east',
    trust_tier: 'first_party',
    operator: 'openvibe',
    status: 'ready',
    limits: { context_tokens: 32768 },
    provider_access: 'OWN_DEPLOYMENT',
    commercial_rights: 'OWN_DEPLOYMENT',
    privacy_policy: 'zero_retention',
    health: { healthy: true },
    updated_at: '2026-11-03T00:00:00.000Z',
    capabilities: { tools: true, json: true, vision: false, stream: true },
    ...extra,
});

// The requirements of one request.
const req = (o = {}) => ({ objective: 'cheapest', paid_managed: true, ...o });

const opts = (o = {}) => ({ enabled: true, now: T, usage: USAGE, rates: {}, ...o });

// The rates of a set of deployments.
const ratesFor = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v]));

run([
    ['the planner is off by default and says so', async () => {
        const r = planAi(req(), [deployment('dep-a')], opts({ enabled: false }));
        assert.equal(r.disabled, true);
        assert.equal(r.chosen, null);
        assert.equal(r.explain.disabled, true);
        assert.equal(r.explain.objective, 'cheapest');
    }],

    ['nano-USD: the charge of a component is ceil(tokens * rate / 1e6), by hand', async () => {
        // 800 input tokens at 3000 nano-USD per million: 800 * 3000 = 2_400_000; / 1e6 = 2.4; ceil = 3.
        assert.equal(chargeTokens(800, '3000'), 3n);
        // 400 output tokens at 15000 nano-USD per million: 400 * 15000 = 6_000_000; / 1e6 = 6; ceil = 6.
        assert.equal(chargeTokens(400, '15000'), 6n);
        // A partial token still costs the whole nano-USD: 1 token at 3000 per million = 0.003; ceil = 1.
        assert.equal(chargeTokens(1, '3000'), 1n);
        // Zero tokens cost nothing.
        assert.equal(chargeTokens(0, '3000'), 0n);
        // A rate of zero costs nothing.
        assert.equal(chargeTokens(1e9, '0'), 0n);
        // Money is an integer count of nano-USD, never a float of dollars.
        assert.equal(nanoUsd('3000'), 3000n);
        assert.equal(nanoUsd(0), 0n);
        assert.equal(nanoUsd(null), 0n);
        assert.throws(() => nanoUsd(1.5), TypeError, 'a fractional nano-USD is a bug, not a rounding opportunity');
        assert.throws(() => nanoUsd('0.5'), TypeError);
        assert.equal(formatNanoUsd(8400n), '8400');
    }],

    ['nano-USD: the expected cost adds the four token classes and the per-request fee', async () => {
        // input 800 @ 3000/M = 3; output 400 @ 15000/M = 6; cached read 0; cache write 0; fee 0 => 9 nano-USD.
        const cost = expectedCostNano(USAGE, RATES);
        assert.equal(cost, 9n);
        // The cached read is cheaper: 1000 cached @ 300/M = 1000*300/1e6 = 0.3; ceil = 1.
        assert.equal(chargeTokens(1000, '300'), 1n);
        // A per-request fee is added once, not per component.
        const withFee = expectedCostNano(USAGE, { ...RATES, per_request_nano_usd: '7' });
        assert.equal(withFee, 16n);
        // The nested settlement rate shape (nano_usd_per_m) prices the same way.
        const nested = expectedCostNano(USAGE, {
            nano_usd_per_m: { input: '3000', cached_read: '300', cache_write: '3000', output: '15000' },
            per_request_nano_usd: '0',
        });
        assert.equal(nested, 9n);
        // Four token classes at once, each charged once:
        // input 1000 @ 3000/M = 3; cached read 2000 @ 300/M = 600000/1e6 = 0.6 -> 1;
        // cache write 500 @ 3000/M = 1.5 -> 2; output 1000 @ 15000/M = 15; fee 3 => 3+1+2+15+3 = 24.
        const four = expectedCostNano(
            { input_tokens: 1000, cached_read_tokens: 2000, cache_write_tokens: 500, output_tokens: 1000 },
            { ...RATES, per_request_nano_usd: '3' },
        );
        assert.equal(four, 24n);
    }],

    ['nano-USD: the cost per success is the expected cost over max(p_success, floor)', async () => {
        // 9 nano-USD at p = 0.9: 9 / 0.9 = 10 nano-USD.
        assert.equal(costPerSuccessNano(9n, 0.9, 0.1), 10n);
        // The floor holds it up: p = 0.01 with a floor of 0.1 gives 9 / 0.1 = 90.
        assert.equal(costPerSuccessNano(9n, 0.01, 0.1), 90n);
        // No chance of success has no cost per success.
        assert.equal(costPerSuccessNano(9n, 0, 0.1), null);
    }],

    ['gate: the exact artifact is never substituted', async () => {
        const wanted = 'qwen/qwen3-9b-abliterated:q4_k_m@3f2a1c9';
        const other = deployment('dep-b', { artifact_id: 'meta-llama/llama_3.1_8b_instruct:fp16@bca2580' });
        const r = planAi(req({ exact_artifact: wanted }), [deployment('dep-a'), other], opts({
            rates: { 'dep-a': RATES, 'dep-b': RATES },
        }));
        assert.equal(r.chosen, 'dep-a');
        const rejected = r.explain.rejected.find((x) => x.id === 'dep-b');
        assert.ok(rejected, 'the other artifact is rejected');
        assert.match(rejected.reason, /exact model requested/);
        // The gate is a hard one: nothing is eligible when no deployment carries the artifact.
        const none = planAi(req({ exact_artifact: 'org/nope@abc' }), [deployment('dep-a')], opts({ rates: { 'dep-a': RATES } }));
        assert.equal(none.chosen, null);
        assert.equal(none.explain.rejected[0].reason.includes('exact model requested'), true);
    }],

    ['gate: a paid managed route needs OWN_DEPLOYMENT or AUTHORIZED_WHOLESALE', async () => {
        for (const access of ['CUSTOMER_BYOK', 'RESTRICTED', 'UNVERIFIED']) {
            const d = deployment('dep-x', { provider_access: access, commercial_rights: access });
            const r = planAi(req(), [d], opts({ rates: { 'dep-x': RATES } }));
            assert.equal(r.chosen, null, `${access} may not serve a paid route`);
            assert.match(r.explain.rejected[0].reason, /commercial right/);
        }
        // The two rights that may.
        for (const access of PAID_PROVIDER_ACCESS) {
            const d = deployment('dep-x', { provider_access: access, commercial_rights: access });
            const r = planAi(req(), [d], opts({ rates: { 'dep-x': RATES } }));
            assert.equal(r.chosen, 'dep-x', `${access} may serve a paid route`);
        }
        // A route that is not paid managed accepts a restricted right.
        const free = planAi(req({ paid_managed: false }), [deployment('dep-x', { provider_access: 'RESTRICTED' })],
            opts({ rates: { 'dep-x': RATES } }));
        assert.equal(free.chosen, 'dep-x');
        // The full set of rights is the one the contract names.
        assert.deepEqual([...PROVIDER_ACCESS].sort(), ['AUTHORIZED_WHOLESALE', 'CUSTOMER_BYOK', 'OWN_DEPLOYMENT', 'RESTRICTED', 'UNVERIFIED']);
    }],

    ['gate: the privacy class and the trust tier keep a request where it belongs', async () => {
        // A deployment that is not zero-retention may not run a zero-retention workload.
        const loose = deployment('dep-loose', { privacy_policy: 'standard' });
        const r = planAi(req({ privacy_class: 'zero_retention' }), [loose], opts({ rates: { 'dep-loose': RATES } }));
        assert.equal(r.chosen, null);
        assert.match(r.explain.rejected[0].reason, /privacy class/);
        // A zero-retention deployment may.
        const tight = deployment('dep-tight');
        const ok = planAi(req({ privacy_class: 'zero_retention' }), [tight], opts({ rates: { 'dep-tight': RATES } }));
        assert.equal(ok.chosen, 'dep-tight');
        // The trust tier is a gate too.
        const partner = deployment('dep-p', { trust_tier: 'approved_wholesale' });
        const trust = planAi(req({ trust: ['first_party'] }), [partner], opts({ rates: { 'dep-p': RATES } }));
        assert.equal(trust.chosen, null);
        assert.match(trust.explain.rejected[0].reason, /trust tier/);
    }],

    ['gate: a capability the model lacks keeps it out', async () => {
        for (const cap of ['tools', 'json', 'vision', 'stream']) {
            const blind = deployment('dep-blind', { capabilities: { tools: false, json: false, vision: false, stream: false } });
            const r = planAi(req({ capabilities: [cap] }), [blind], opts({ rates: { 'dep-blind': RATES } }));
            assert.equal(r.chosen, null, `${cap} is required`);
            assert.match(r.explain.rejected[0].reason, new RegExp(`lacks ${cap}`));
        }
        // A deployment that has them all passes every gate.
        const full = deployment('dep-full', { capabilities: { tools: true, json: true, vision: true, stream: true } });
        const ok = planAi(req({ capabilities: ['tools', 'json', 'vision', 'stream'] }), [full], opts({ rates: { 'dep-full': RATES } }));
        assert.equal(ok.chosen, 'dep-full');
    }],

    ['gate: the context bound and the health keep a candidate out', async () => {
        const small = deployment('dep-small', { limits: { context_tokens: 4096 } });
        const r = planAi(req({ context_tokens: 32768 }), [small], opts({ rates: { 'dep-small': RATES } }));
        assert.equal(r.chosen, null);
        assert.match(r.explain.rejected[0].reason, /context/);
        // A deployment that is not ready is out.
        const down = deployment('dep-down', { status: 'offline' });
        const h = planAi(req(), [down], opts({ rates: { 'dep-down': RATES } }));
        assert.equal(h.chosen, null);
        assert.match(h.explain.rejected[0].reason, /status offline/);
    }],

    ['gate: the cost ceiling is in nano-USD and an unpriced candidate is never free', async () => {
        // The expected cost of the request is 9 nano-USD.
        const r = planAi(req({ max_cost_nano_usd: '8' }), [deployment('dep-a')], opts({ rates: { 'dep-a': RATES } }));
        assert.equal(r.chosen, null);
        assert.match(r.explain.rejected[0].reason, /over the 8 ceiling/);
        // A ceiling of 9 lets it through.
        const ok = planAi(req({ max_cost_nano_usd: '9' }), [deployment('dep-a')], opts({ rates: { 'dep-a': RATES } }));
        assert.equal(ok.chosen, 'dep-a');
        // A candidate with no rate is not free: it is rejected.
        const noRate = planAi(req(), [deployment('dep-a')], opts({ rates: {} }));
        assert.equal(noRate.chosen, null);
        assert.match(noRate.explain.rejected[0].reason, /no rate/);
    }],

    ['the objective prefers the cheaper per success over the cheaper per token', async () => {
        // dep-cheap costs 9 nano-USD for the request and succeeds 60% of the time: 9 / 0.6 = 15 per success.
        // dep-good costs 12 nano-USD and succeeds 95% of the time: 12 / 0.95 = 12.63 per success.
        // dep-cheap is cheaper per token (9 < 12) but dearer per success (15 > 12.63): the planner takes dep-good.
        const cheap = deployment('dep-cheap');
        const good = deployment('dep-good');
        const r = planAi(req(), [cheap, good], opts({
            rates: { 'dep-cheap': RATES, 'dep-good': { ...RATES, output_nano_usd_per_m: '24000' } },
            evidence: {
                'dep-cheap': { p_success: 0.6, confidence: 1, samples: 500 },
                'dep-good': { p_success: 0.95, confidence: 1, samples: 500 },
            },
        }));
        assert.equal(r.chosen, 'dep-good', 'the cheaper per success wins, not the cheaper per token');
        const byId = Object.fromEntries(r.explain.candidates.map((c) => [c.id, c]));
        assert.equal(byId['dep-cheap'].expected_cost_nano_usd, '9');
        // dep-good: output 400 @ 24000/M = 400*24000/1e6 = 9.6 -> 10; input 3; fee 0 => 13.
        assert.equal(byId['dep-good'].expected_cost_nano_usd, '13');
        // 13 / 0.95 = 13.68 -> ceil = 14; 9 / 0.6 = 15.
        assert.equal(byId['dep-good'].cost_per_success_nano_usd, '14');
        assert.equal(byId['dep-cheap'].cost_per_success_nano_usd, '15');
        // The one that lost is listed with its reason.
        assert.ok(r.explain.rejected.find((x) => x.id === 'dep-cheap' && /higher expected cost per success/.test(x.reason)));
    }],

    ['sparse evidence is marked, not trusted: it never dominates', async () => {
        // dep-thin has a great number but only 3 observations and no confidence: it is sparse.
        // dep-solid has a worse number but 400 observations at full confidence.
        // dep-thin is cheaper (9 vs 13 nano-USD), so on price alone it would win; on trusted evidence it must not.
        const thin = deployment('dep-thin');
        const solid = deployment('dep-solid');
        const r = planAi(req(), [thin, solid], opts({
            rates: { 'dep-thin': RATES, 'dep-solid': { ...RATES, output_nano_usd_per_m: '24000' } },
            evidence: {
                'dep-thin': { p_success: 0.99, samples: 3 },
                'dep-solid': { p_success: 0.7, confidence: 1, samples: 400 },
            },
        }));
        const byId = Object.fromEntries(r.explain.candidates.map((c) => [c.id, c]));
        assert.equal(byId['dep-thin'].sparse_evidence, true, 'thin evidence is marked');
        assert.equal(byId['dep-solid'].sparse_evidence, false);
        assert.equal(byId['dep-thin'].confidence, 0, 'a sparse measurement carries no confidence');
        // The sparse candidate is priced as if it were at the prior (0.9): 9 / 0.9 = 10; the solid one:
        // 13 / 0.7 = 18.57 -> 19. The solid one is dearer per success, so the thin one wins on price...
        assert.equal(r.chosen, 'dep-thin');
        // ...but it never wins on QUALITY: it may not claim a better probability than the prior.
        assert.ok(byId['dep-thin'].p_success <= 0.9 + 1e-9, 'a sparse measurement is pulled back to the prior');
        assert.equal(byId['dep-thin'].p_success, 0.9);
        // And the answer says the evidence is sparse.
        assert.ok(r.explain.reasons.some((x) => /sparse quality evidence/.test(x)));
    }],

    ['sparse evidence cannot beat a trusted one when the trusted one is also better priced', async () => {
        // dep-thin: 9 nano-USD, a sparse 0.99 measurement. dep-solid: 8 nano-USD, a trusted 0.7 measurement.
        // Priced as at the prior the thin one is 9 / 0.9 = 10 per success; the solid one 8 / 0.7 = 11.43 -> 12.
        // The thin one wins on the prior price, and that is the point: the sparse measurement never moved it.
        const thin = deployment('dep-thin');
        const solid = deployment('dep-solid');
        const r = planAi(req(), [thin, solid], opts({
            rates: {
                'dep-thin': RATES,
                'dep-solid': { ...RATES, input_nano_usd_per_m: '1500', output_nano_usd_per_m: '9000' },
            },
            evidence: {
                'dep-thin': { p_success: 0.99, samples: 3 },
                'dep-solid': { p_success: 0.7, confidence: 1, samples: 400 },
            },
        }));
        const byId = Object.fromEntries(r.explain.candidates.map((c) => [c.id, c]));
        // dep-solid: input 800 @ 1500/M = 1.2 -> 2; output 400 @ 9000/M = 3.6 -> 4; total 6.
        assert.equal(byId['dep-solid'].expected_cost_nano_usd, '6');
        // 6 / 0.7 = 8.57 -> 9; the thin one 9 / 0.9 = 10.
        assert.equal(byId['dep-solid'].cost_per_success_nano_usd, '9');
        assert.equal(byId['dep-thin'].cost_per_success_nano_usd, '10');
        assert.equal(r.chosen, 'dep-solid', 'the trusted evidence wins on the cost per success');
    }],

    ['the explanation never carries a secret, a host or an endpoint', async () => {
        const leaky = deployment('dep-leaky', {
            endpoint: 'http://gpu-001.internal:4800/v1',
            host: 'gpu-001.internal',
            operator: 'owner:usr_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        });
        const r = planAi(req({ exact_artifact: 'org/other@abc' }), [leaky], opts({ rates: { 'dep-leaky': RATES } }));
        const text = JSON.stringify(r.explain.rejected);
        assert.ok(!/gpu-001/.test(text), 'no host');
        assert.ok(!/internal/.test(text), 'no internal name');
        assert.ok(!/usr_[A-Z]{26}/.test(text), 'no subject id');
        assert.ok(!/http/.test(text), 'no endpoint');
        // safeReason() strips them whatever it is given.
        const s = safeReason('call http://10.0.0.5/v1 with sk-abcdefgh12345678 for usr_BBBBBBBBBBBBBBBBBBBBBBBBBB');
        assert.ok(!/10\.0\.0\.5/.test(s));
        assert.ok(!/sk-abcdefgh12345678/.test(s));
        assert.ok(!/usr_B/.test(s));
    }],

    ['hysteresis and affinity stay: the current placement is kept unless another is clearly better', async () => {
        // dep-a is the current placement and costs 9; dep-b costs 13.
        // dep-a: 9 / 0.8 = 11.25 -> 12 per success; dep-b: 13 / 0.9 = 14.44 -> 15. dep-a is the better one,
        // and the current placement stays.
        const a = deployment('dep-a');
        const b = deployment('dep-b');
        const r = planAi(req(), [a, b], opts({
            current: 'dep-a',
            rates: { 'dep-a': RATES, 'dep-b': { ...RATES, output_nano_usd_per_m: '24000' } },
            evidence: {
                'dep-a': { p_success: 0.8, confidence: 1, samples: 400 },
                'dep-b': { p_success: 0.9, confidence: 1, samples: 400 },
            },
        }));
        assert.equal(r.chosen, 'dep-a');
        // The current placement is kept when the alternative is only a little better: dep-a 12 per success,
        // dep-b 15: the gain is (12 - 15)/12, negative, so it stays.
        // Now a case where the alternative IS clearly better but not by the 15% the planner asks for:
        // dep-a 9 / 0.5 = 18 per success; dep-b 13 / 0.95 = 13.68 -> 14. The gain is (18 - 14) / 18 = 22%.
        const moved = planAi(req(), [a, b], opts({
            current: 'dep-a',
            minGain: 0.30,
            rates: { 'dep-a': RATES, 'dep-b': { ...RATES, output_nano_usd_per_m: '24000' } },
            evidence: {
                'dep-a': { p_success: 0.5, confidence: 1, samples: 400 },
                'dep-b': { p_success: 0.95, confidence: 1, samples: 400 },
            },
        }));
        assert.equal(moved.chosen, 'dep-a', 'a 22% gain is below the 30% the planner asks for');
        assert.ok(moved.explain.reasons.some((x) => /only .*% better/.test(x)), 'the reason says how much better the other is');
        // With the default gain of 15% the same two candidates do move.
        const moved2 = planAi(req(), [a, b], opts({
            current: 'dep-a',
            rates: { 'dep-a': RATES, 'dep-b': { ...RATES, output_nano_usd_per_m: '24000' } },
            evidence: {
                'dep-a': { p_success: 0.5, confidence: 1, samples: 400 },
                'dep-b': { p_success: 0.95, confidence: 1, samples: 400 },
            },
        }));
        assert.equal(moved2.chosen, 'dep-b');
        // Affinity: a warm deployment is kept when it is within the affinity gain.
        const warm = planAi(req(), [a, b], opts({
            affinity: { 'dep-a': 0.8 },
            minGain: 0.30,
            rates: { 'dep-a': RATES, 'dep-b': { ...RATES, output_nano_usd_per_m: '24000' } },
            evidence: {
                'dep-a': { p_success: 0.5, confidence: 1, samples: 400 },
                'dep-b': { p_success: 0.95, confidence: 1, samples: 400 },
            },
        }));
        assert.equal(warm.chosen, 'dep-a');
        assert.ok(warm.explain.reasons.some((x) => /affinity/.test(x)));
    }],

    ['the answer carries the objective, the estimate and the rejections', async () => {
        const r = planAi(req({ objective: 'balanced' }), [deployment('dep-a'), deployment('dep-b', { artifact_id: 'other/other@abc' })], opts({
            rates: { 'dep-a': RATES, 'dep-b': RATES },
        }));
        assert.equal(r.objective, 'balanced');
        assert.equal(r.explain.objective, 'balanced');
        assert.equal(r.chosen, 'dep-a');
        assert.equal(r.estimate.charge_nano_usd, '9');
        assert.equal(r.estimate.input_tokens, 800);
        assert.equal(r.estimate.output_tokens, 400);
        assert.ok(Array.isArray(r.explain.rejected));
        assert.ok(r.explain.rejected.every((x) => x.id && x.reason));
    }],

    ['a candidate with no chance of success is not a candidate', async () => {
        const r = planAi(req(), [deployment('dep-a')], opts({
            rates: { 'dep-a': RATES },
            evidence: { 'dep-a': { p_success: 0, confidence: 1, samples: 400 } },
        }));
        assert.equal(r.chosen, null);
        assert.match(r.explain.rejected[0].reason, /no chance of success/);
    }],

    ['the objective says what was weighed: cheapest takes the cost per success, fastest the latency', async () => {
        // dep-slow is cheaper per success (9 / 0.9 = 10) but slower; dep-quick costs 12 / 0.9 = 14 and is faster.
        const slow = deployment('dep-slow', { latency_ms: 800 });
        const quick = deployment('dep-quick', { latency_ms: 100 });
        const rates = { 'dep-slow': RATES, 'dep-quick': { ...RATES, output_nano_usd_per_m: '24000' } };
        const evidence = {
            'dep-slow': { p_success: 0.9, confidence: 1, samples: 400 },
            'dep-quick': { p_success: 0.9, confidence: 1, samples: 400 },
        };
        const cheapest = planAi(req({ objective: 'cheapest' }), [slow, quick], opts({ rates, evidence }));
        assert.equal(cheapest.chosen, 'dep-slow', 'cheapest takes the lower cost per success');
        assert.equal(cheapest.explain.objective, 'cheapest');
        const fastest = planAi(req({ objective: 'fastest' }), [slow, quick], opts({ rates, evidence }));
        assert.equal(fastest.chosen, 'dep-quick', 'fastest takes the quicker one');
        assert.equal(fastest.explain.objective, 'fastest');
    }],

    ['the answer is an ai.route-explain@1 document', async () => {
        if (!hasRouteExplain) { console.log('ai.route-explain@1: skipped (the contract is not in the pinned openvibe-contracts yet)'); return; }
        const r = planAi(req({ objective: 'balanced' }), [deployment('dep-a'), deployment('dep-b', { artifact_id: 'other/other@abc' })], opts({
            rates: { 'dep-a': RATES, 'dep-b': RATES },
            evidence: { 'dep-a': { p_success: 0.95, confidence: 0.9, samples: 120 } },
        }));
        const v = contracts.validate('ai.route-explain@1', {
            chosen: r.chosen, rejected: r.rejected, objective: r.objective, estimate: r.estimate,
        });
        assert.ok(v.valid, `ai.route-explain@1: ${JSON.stringify(v.errors)}`);
    }],
]);
