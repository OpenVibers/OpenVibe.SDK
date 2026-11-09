'use strict';
/** openvibe-sdk/link: platform.link-capabilities@1 — build, validate, and linkOffers(). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./helpers');
const { linkCapabilities, linkOffers, validateLinkCapabilities } = require('../src/link');

const FIXTURES = path.join(__dirname, '..', 'node_modules', 'openvibe-contracts', 'fixtures', 'platform.link-capabilities');
let contracts = null;
try { contracts = require('openvibe-contracts'); } catch { /* the fixture cases skip */ }
if (contracts && (!fs.existsSync(path.join(FIXTURES, 'valid')) || !fs.existsSync(path.join(FIXTURES, 'invalid')))) contracts = null;

run([
    ['linkCapabilities passes every valid fixture through unchanged, and they validate', async () => {
        if (!contracts) { console.log('node-capabilities fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'valid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid', f), 'utf8'));
            assert.deepEqual(linkCapabilities({ ...fixture }), fixture, f);
            assert.deepEqual(validateLinkCapabilities(fixture), { ok: true, errors: [] }, f);
        }
    }],
    ['linkCapabilities strips null/undefined', async () => {
        const c = linkCapabilities({ node_id: 'n1', cpu: { cores: 4 }, arch: 'x86_64', memory_mb: 8192,
            storage: { capacity_gb: 100 }, network: { ingress_mbps: 100, egress_mbps: 100 },
            regions: ['us-west'], tags: [], costs: { per_hour_usd: 0.1 },
            gpu: null, capabilities: undefined, agent_version: null });
        assert.ok(!('gpu' in c), 'null gpu stripped');
        assert.ok(!('capabilities' in c), 'undefined capabilities stripped');
        assert.ok(!('agent_version' in c), 'null agent_version stripped');
    }],
    ['validateLinkCapabilities refuses every invalid fixture with its errors', async () => {
        if (!contracts) { console.log('node-capabilities invalid fixtures: skipped (matching openvibe-contracts fixtures unavailable)'); return; }
        for (const f of fs.readdirSync(path.join(FIXTURES, 'invalid'))) {
            const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid', f), 'utf8'));
            const r = validateLinkCapabilities(fixture);
            assert.equal(r.ok, false, f);
            assert.ok(r.errors.length > 0, f);
        }
    }],
    ['linkOffers: default trust is first-party, capabilities pass through, kind is "node"', async () => {
        const caps = linkCapabilities({ node_id: 'n1', cpu: { cores: 8 }, arch: 'x86_64', memory_mb: 16384,
            storage: { capacity_gb: 500, available_gb: 300 }, network: { ingress_mbps: 1000, egress_mbps: 1000 },
            regions: ['us-west'], tags: ['gpu'], costs: { per_hour_usd: 0.2 },
            capabilities: ['node:http', 'worker:ffmpeg'] });
        const { resource, runtime } = linkOffers(caps);
        assert.equal(resource.kind, 'node');
        assert.equal(resource.trust, 'first-party');
        assert.equal(resource.node_id, 'n1');
        assert.equal(resource.region, 'us-west');
        assert.deepEqual(resource.capabilities, ['node:http', 'worker:ffmpeg']);
        assert.equal(resource.offer_id, 'node:n1');
        assert.equal(resource.health.status, 'up');
        // runtime
        assert.equal(runtime.kind, 'container');
        assert.equal(runtime.node, 'n1');
        assert.deepEqual(runtime.limits, { cpu_cores: 8, memory_mb: 16384 });
        assert.equal(runtime.price.amount_usd, 0.2);
        assert.equal(runtime.price.unit, 'hour');
        assert.deepEqual(runtime.constraints, ['first-party']);
    }],
    ['linkOffers: trust is "user-owned" only when opts.trust says so', async () => {
        const caps = linkCapabilities({ node_id: 'n2', cpu: { cores: 4 }, arch: 'arm64', memory_mb: 8192,
            storage: { capacity_gb: 200 }, network: { ingress_mbps: 500, egress_mbps: 500 },
            regions: ['eu-west'], tags: [], costs: { per_hour_usd: 0.1 } });
        const { resource, runtime } = linkOffers(caps, { trust: 'user-owned' });
        assert.equal(resource.trust, 'user-owned');
        assert.deepEqual(runtime.constraints, ['user-owned']);
        // default (no opts) stays first-party
        const { resource: r2 } = linkOffers(caps);
        assert.equal(r2.trust, 'first-party');
    }],
    ['linkOffers: per-second pricing from per_hour_usd', async () => {
        const caps = linkCapabilities({ node_id: 'n3', cpu: { cores: 2 }, arch: 'x86_64', memory_mb: 4096,
            storage: { capacity_gb: 100 }, network: { ingress_mbps: 100, egress_mbps: 100 },
            regions: ['us-east'], tags: [], costs: { per_hour_usd: 0.36 } });
        const { resource } = linkOffers(caps);
        assert.equal(resource.pricing.model, 'per-second');
        assert.ok(Math.abs(resource.pricing.marginal_usd_per_unit - 0.0001) < 1e-12);   // 0.36 / 3600
    }],
]);
