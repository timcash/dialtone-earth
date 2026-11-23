import assert from "node:assert/strict";
import test from "node:test";
import { adaptLiveMeshToNetwork } from "../src/live-adapter.ts";
import {
  SIMULATED_NETWORKS,
  SIMULATED_TOUR_STEPS,
  summarizeSystemResources,
} from "../src/simulation.ts";

test("simulated tour covers overview, network, host, plugins/blobs, recovery, tests, and logs", () => {
  const views = new Set(SIMULATED_TOUR_STEPS.map((s) => s.view));
  for (const required of ["overview", "network", "host", "tests", "log"]) {
    assert.ok(views.has(required), `simulated tour missing view ${required}`);
  }
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
