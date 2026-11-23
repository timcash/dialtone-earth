import assert from "node:assert/strict";
import test from "node:test";
import { adaptLiveMeshToNetwork } from "../src/live-adapter.ts";
import { buildBundledPingArcs } from "../src/edge-bundling.ts";
import { buildSimulatedH3DataCells } from "../src/h3-geodata.ts";
import {
  computeAdaptivePollMs,
  formatCadenceLabel,
  liveEndpointForQuery,
} from "../src/mesh-cadence.ts";
import {
  bestEffortIntervalMs,
  createCustomQuery,
  createDefaultQuerySet,
  normalizePaneAssignments,
  paneCountForLayout,
  tickSimulatedQuery,
} from "../src/query-workspace.ts";
import {
  SIMULATED_NETWORKS,
  SIMULATED_TOUR_STEPS,
  summarizeSystemResources,
} from "../src/simulation.ts";

test("simulated tour covers overview, network, host, users, plugins/blobs, recovery, tests, and logs", () => {
  const views = new Set(SIMULATED_TOUR_STEPS.map((s) => s.view));
  for (const required of ["overview", "network", "host", "users", "tests", "log"]) {
    assert.ok(views.has(required), `simulated tour missing view ${required}`);
  }
  // Verify multi-location users and redacted dialtone-shell logs exist on simulated networks
  const atlas = SIMULATED_NETWORKS[0];
  assert.ok(atlas.users.some((u) => u.locations.length >= 2), "sim-atlas must demonstrate multi-location user");
  assert.ok(atlas.shellAuditLog.some((e) => e.redactedCount > 0 && e.command.includes("[REDACTED]")));
  const rawAudit = JSON.stringify(atlas.shellAuditLog);
  assert.ok(!rawAudit.includes("sim_demo_bearer_9a8f7e6d5c4b"), "simulated shell log must not retain raw bearer token");
  assert.ok(!rawAudit.includes("sim_edge_tok_1122334455"), "simulated shell log must not retain raw CLI token");
  const tabs = new Set(
    SIMULATED_TOUR_STEPS.map((s) => s.networkTab).filter(Boolean),
  );
  for (const requiredTab of ["hosts", "plugins", "recovery"]) {
    assert.ok(
      tabs.has(requiredTab),
      `simulated tour missing network focus tab ${requiredTab}`,
    );
  }
});

test("system-wide simulated resource stats aggregate CPU, RAM, Disk, GPU, blobs, plugins, shells, and tests", () => {
  const summary = summarizeSystemResources(SIMULATED_NETWORKS);
  assert.equal(summary.networks, 3);
  assert.ok(summary.totalNodes >= 8);
  assert.equal(summary.onlineNodes, summary.totalNodes);
  assert.ok(summary.cpuCores > 0);
  assert.ok(summary.memTotalGb > 0 && summary.memUsedGb > 0);
  assert.ok(summary.diskTotalTb > 0 && summary.diskUsedTb > 0);
  assert.ok(summary.gpuTotalGb > 0 && summary.gpuUsedGb > 0);
  assert.ok(summary.blobObjects > 0 && summary.blobTotalMb > 0);
  assert.ok(summary.activePlugins > 0);
  assert.ok(summary.activeShellSessions > 0);
  assert.ok(summary.recoveryEventsCount > 0);
  assert.ok(summary.totalTests > 0 && summary.passingTests === summary.totalTests);
});

test("simulated data contains valid 32-hex test-ids and zero real private identifiers", () => {
  const serialized = JSON.stringify({
    networks: SIMULATED_NETWORKS,
    steps: SIMULATED_TOUR_STEPS,
  }).toLowerCase();

  for (const forbidden of [
    "metal.json",
    "grok-bot-metal",
    "legion-metal",
    "vm-us",
    "vm-eu",
    "vm-asia",
    "rosie",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `simulated tour must not leak private identifier ${forbidden}`,
    );
  }

  for (const net of SIMULATED_NETWORKS) {
    assert.equal(net.simulated, true);
    for (const run of net.tests) {
      assert.match(
        run.testId,
        /^[a-f0-9]{32}$/,
        `invalid testId on ${run.name}: ${run.testId}`,
      );
      assert.ok(run.log.includes("[SIMULATED]"));
    }
  }
});

test("adaptLiveMeshToNetwork produces the exact same MeshNetwork schema as simulated data", () => {
  const adapted = adaptLiveMeshToNetwork({
    hostname: "example.dialtone.earth",
    mesh: {
      self_node: "origin-1",
      mesh_config: {
        channel: "example-live",
        channel_fingerprint: "ch-live-1234",
      },
      blob_stats: {
        blob_keys: 42,
        blob_bytes: 5_200_000,
        blob_fetches: 3,
        installed_programs: 1,
      },
      nodes: [
        {
          node: "origin-1",
          os: "linux",
          arch: "x86_64",
          version: "0.5.5",
          geo_location: { lat: 37.7, lng: -122.4, label: "San Francisco" },
          heard: 10,
          peer_rtt_ms: { "peer-2": 18.4 },
          stats: {
            cpu_cores: 16,
            cpu_percent: 25.0,
            mem_percent: 40.0,
            mem_total_bytes: 32_000_000_000,
            mem_used_bytes: 12_800_000_000,
            disk_percent: 50.0,
            disk_total_bytes: 1_000_000_000_000,
            disk_used_bytes: 500_000_000_000,
            gpu_mem_total_bytes: null,
            gpu_mem_used_bytes: null,
            load_avg_1m: 1.2,
          },
          probe: {
            passed_count: 3,
            total_count: 3,
            checks: [
              { code: "MSH", ok: true },
              { code: "NBR", ok: true },
              { code: "BEAT", ok: true },
            ],
          },
        },
      ],
    },
    plugins: {
      plugins: [
        {
          verified: true,
          manifest: {
            name: "shell",
            version: "0.5.5",
            kind: "blob-binary",
            protocols: ["dialtone/shell/1"],
            source_repo: "timcash/dialtone-shell",
            blob_digest: "sha256:0123456789abcdef0123456789abcdef",
            bytes: 455168,
          },
        },
      ],
    },
    tests: {
      tests: [
        {
          name: "TestDialtoneEarthCloudflareGateway",
          title: "Dialtone Earth Cloudflare Gateway",
          status: "pass",
          elapsed: "0.10",
          timestamp: "2026-11-22T22:00:00Z",
          "test-id": "a".repeat(32),
        },
      ],
    },
  });

  const simKeys = Object.keys(SIMULATED_NETWORKS[0]).sort();
  assert.deepEqual(Object.keys(adapted).sort(), simKeys);
  assert.equal(adapted.simulated, false);
  assert.equal(adapted.slug, "example-live");
  assert.equal(adapted.hosts.length, 1);
  assert.equal(adapted.plugins.length, 1);
  assert.equal(adapted.blobStore.objects, 42);
  assert.equal(adapted.tests.length, 1);

  const summary = summarizeSystemResources([adapted]);
  assert.equal(summary.networks, 1);
  assert.equal(summary.totalNodes, 1);
  assert.equal(summary.cpuCores, 16);
  assert.equal(summary.blobObjects, 42);
  assert.equal(summary.activePlugins, 1);
  assert.equal(summary.passingTests, 1);
});

test("adaptive gossip-mesh cadence backs off to minimal base rate and pauses when hidden", () => {
  assert.equal(computeAdaptivePollMs({ unchangedStreak: 0, hidden: true, random: 0.5 }), null);
  assert.equal(computeAdaptivePollMs({ unchangedStreak: 0, hidden: false, random: 0.5 }), 2_000);
  assert.equal(computeAdaptivePollMs({ unchangedStreak: 2, hidden: false, random: 0.5 }), 4_000);
  assert.equal(computeAdaptivePollMs({ unchangedStreak: 3, hidden: false, random: 0.5 }), 8_000);
  assert.equal(computeAdaptivePollMs({ unchangedStreak: 4, hidden: false, random: 0.5 }), 15_000);
  assert.equal(computeAdaptivePollMs({ unchangedStreak: 12, hidden: false, random: 0.5 }), 30_000);

  // Single-query endpoint mapping: never fans out
  assert.equal(liveEndpointForQuery("networks"), "/api/mesh/state");
  assert.equal(liveEndpointForQuery("hosts"), "/api/mesh/state");
  assert.equal(liveEndpointForQuery("plugins"), "/api/mesh/plugins");
  assert.equal(liveEndpointForQuery("users"), "/api/mesh/users");
  assert.equal(liveEndpointForQuery("tests"), "/api/mesh/tests");
  assert.equal(liveEndpointForQuery("log", "a".repeat(32)), `/api/mesh/test-runs/${"a".repeat(32)}`);
  assert.equal(liveEndpointForQuery("log", "../bad"), null);

  assert.equal(formatCadenceLabel(30_000, 8, 5), "GOSSIP BASE 30s · 5×304");
  assert.equal(formatCadenceLabel(null, 0, 0), "MESH PAUSED");
});

test("edge bundling lifts ping curves into atmosphere and bundles parallel corridors + H3 cells", () => {
  const nodes = [
    { id: "us-w1", networkIndex: 0, lat: 37.77, lng: -122.42, rttMs: 12 },
    { id: "us-w2", networkIndex: 0, lat: 34.05, lng: -118.24, rttMs: 14 },
    { id: "eu-1", networkIndex: 0, lat: 51.51, lng: -0.13, rttMs: 88 },
    { id: "eu-2", networkIndex: 0, lat: 50.11, lng: 8.68, rttMs: 92 },
  ];
  const R = 50;
  const arcs = buildBundledPingArcs(nodes, R, { segments: 24, beta: 0.74, forceIterations: 2 });
  assert.equal(arcs.length, 6);
  for (const arc of arcs) {
    assert.equal(arc.points.length, 25);
    assert.equal(arc.progress[0], 0);
    assert.ok(Math.abs(arc.progress[arc.progress.length - 1] - 1) < 1e-6);
    const mid = arc.points[12];
    const midRadius = Math.hypot(mid[0], mid[1], mid[2]);
    assert.ok(midRadius > R * 1.04, `expected atmospheric arch above globe, got r=${midRadius}`);
  }

  const cells = buildSimulatedH3DataCells(nodes, 3);
  assert.ok(cells.length >= 20, `expected simulated H3 geospatial clusters, got ${cells.length}`);
  assert.ok(cells.every((c) => c.intensity > 0 && c.intensity <= 1));
});

test("query workspace supports custom queries, best-effort rate tiers, and 1 / 1|1 / 1/1 / 1|2 / 2x2 splits", () => {
  const queries = createDefaultQuerySet(SIMULATED_NETWORKS, 1000);
  assert.ok(queries.length >= 6);
  const custom = createCustomQuery(
    queries,
    {
      label: "orbit-fast-hosts",
      kind: "hosts",
      source: "channel",
      networkSlug: "sim-orbit",
      rate: "fast",
    },
    2000,
  );
  queries.push(custom);
  assert.equal(custom.label, "orbit-fast-hosts");
  assert.equal(custom.rate, "fast");

  // Layout pane counts: 1, 1|1 (2), 1/1 (2), 1|2 (3: left half + right split in 2), 2x2 (4)
  assert.equal(paneCountForLayout("1"), 1);
  assert.equal(paneCountForLayout("1|1"), 2);
  assert.equal(paneCountForLayout("1/1"), 2);
  assert.equal(paneCountForLayout("1|2"), 3);
  assert.equal(paneCountForLayout("2x2"), 4);

  const panes3 = normalizePaneAssignments([queries[0].id], queries, "1|2");
  assert.equal(panes3.length, 3);
  assert.equal(new Set(panes3).size, 3, "split panes default to distinct queries");

  const panes4 = normalizePaneAssignments(panes3, queries, "2x2");
  assert.equal(panes4.length, 4);
  assert.equal(new Set(panes4).size, 4);

  // Best-effort rate ordering & hidden pause
  assert.equal(bestEffortIntervalMs("fast", 0, true), null);
  const fastMs = bestEffortIntervalMs("fast", 0, false, 0.5);
  const medMs = bestEffortIntervalMs("med", 0, false, 0.5);
  const baseMs = bestEffortIntervalMs("base", 0, false, 0.5);
  assert.ok(fastMs < medMs && medMs < baseMs);
  const fastDecayed = bestEffortIntervalMs("fast", 4, false, 0.5);
  assert.ok(fastDecayed > fastMs, "unchanged fast query backs off best-effort");

  // Simulated tick produces delta + non-zero estimated B/s
  const changed = tickSimulatedQuery(custom, SIMULATED_NETWORKS, 3000, 1);
  assert.equal(changed, true);
  assert.equal(custom.ticks, 1);
  assert.ok(custom.estBytesPerSec > 0);
});
