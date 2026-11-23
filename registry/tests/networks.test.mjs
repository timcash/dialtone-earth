import assert from "node:assert/strict";
import test from "node:test";
import { aggregateNetwork } from "../src/aggregates.ts";
import {
  NODE_DOT_RADIUS_RATIO,
  NODE_LOAD_COLORS,
  nodeLoadColor,
  nodeLoadPercent,
} from "../src/node-load.ts";
import {
  createGlobePlan,
  snapshotTimes,
  summarizeNetwork,
} from "../src/overview.ts";
import {
  sampleTour,
  shouldAnimateTour,
  TOUR_STOP_MS,
} from "../src/tour.ts";

test("network aggregates use only reported capacity or percentage values", () => {
  const snapshot = syntheticSnapshot();
  assert.deepEqual(aggregateNetwork(snapshot), {
    cpu: "12 cores",
    memory: "7/16 GB",
    disk: "100/200 GB",
    gpuMemory: "3/12 GB",
    load: "1 avg",
  });

  snapshot.nodes[0].stats.cpu_percent = 10;
  snapshot.nodes[0].stats.mem_percent = 20;
  snapshot.nodes[0].stats.disk_percent = 30;
  snapshot.nodes[1].stats.cpu_cores = null;
  snapshot.nodes[1].stats.cpu_percent = 20;
  snapshot.nodes[1].stats.mem_percent = 40;
  snapshot.nodes[1].stats.mem_total_bytes = null;
  snapshot.nodes[1].stats.mem_used_bytes = null;
  snapshot.nodes[1].stats.disk_percent = 60;
  snapshot.nodes[1].stats.disk_total_bytes = null;
  snapshot.nodes[1].stats.disk_used_bytes = null;
  assert.deepEqual(aggregateNetwork(snapshot), {
    cpu: "15% avg",
    memory: "30% avg",
    disk: "45% avg",
    gpuMemory: "3/12 GB",
    load: "1 avg",
  });
});

test("overview node color uses reported max CPU or RAM load", () => {
  const stats = completeStats({ cpu_percent: 0, mem_percent: 0 });
  assert.equal(nodeLoadPercent(stats), 0);
  assert.equal(nodeLoadColor(stats), NODE_LOAD_COLORS.low);
  stats.cpu_percent = 50;
  assert.equal(nodeLoadColor(stats), NODE_LOAD_COLORS.medium);
  stats.mem_percent = 100;
  assert.equal(nodeLoadColor(stats), NODE_LOAD_COLORS.high);
  stats.cpu_percent = null;
  stats.mem_percent = null;
  assert.equal(nodeLoadPercent(stats), null);
  assert.equal(nodeLoadColor(stats), NODE_LOAD_COLORS.unavailable);

  assert.equal(
    NODE_DOT_RADIUS_RATIO / (0.1 / 2.8),
    0.25,
    "overview dots should be one quarter of the previous HUD disc radius",
  );
});

test("snapshotTimes formats telemetry and location timestamps when provided", () => {
  const times = snapshotTimes({
    telemetry_generated_at: "2026-11-12T18:00:00.0088759Z",
    coordinates_generated_at: "2026-11-12T01:50:34Z",
  });
  assert.deepEqual(times, [
    {
      label: "Telemetry snapshot",
      dateTime: "2026-11-12T18:00:00.0088759Z",
      text: "12 Nov 2026, 18:00:00 UTC",
    },
    {
      label: "Location snapshot",
      dateTime: "2026-11-12T01:50:34Z",
      text: "12 Nov 2026, 01:50:34 UTC",
    },
  ]);
});

test("overview and tour helpers plan generic synthetic network loops", () => {
  const west = summarizeNetwork(
    { slug: "west", name: "West", node_count: 2 },
    {
      node_count: 2,
      nodes: [
        { name: "one", lat: 0, lng: 0 },
        { name: "two", lat: 10, lng: 20 },
      ],
    },
  );
  const plan = createGlobePlan([west]);
  assert.deepEqual(
    plan.stops.map(({ network, node }) => [network, node]),
    [
      ["West", null],
      ["West", "one"],
      ["West", "two"],
    ],
  );
  assert.deepEqual(sampleTour(0, 3), {
    from: 0,
    to: 1,
    progress: 0,
  });
  assert.deepEqual(
    sampleTour(TOUR_STOP_MS * 3, 3),
    sampleTour(0, 3),
  );
  assert.equal(
    shouldAnimateTour({
      hidden: false,
      inView: true,
      reducedMotion: false,
      paused: false,
      stopCount: 3,
    }),
    true,
  );
});

function syntheticSnapshot() {
  return {
    network: "example",
    generated_at: "2026-11-12T18:00:00Z",
    latest_release: "0.0.0-test",
    node_count: 2,
    nodes: [
      {
        name: "node-a",
        os: "linux",
        arch: "amd64",
        version: "0.0.0-test",
        relay_region: "example",
        lat: 0,
        lng: 0,
        heard: true,
        online: true,
        rtt_ms_from_grok_bot_metal: null,
        stats: completeStats({
          cpu_cores: 4,
          mem_total_bytes: 8_000_000_000,
          mem_used_bytes: 3_000_000_000,
          disk_total_bytes: 100_000_000_000,
          disk_used_bytes: 25_000_000_000,
          gpu_mem_total_bytes: 8_000_000_000,
          gpu_mem_used_bytes: 2_000_000_000,
          load_avg_1m: 0.5,
        }),
      },
      {
        name: "node-b",
        os: "linux",
        arch: "arm64",
        version: "0.0.0-test",
        relay_region: "example",
        lat: 10,
        lng: 20,
        heard: true,
        online: true,
        rtt_ms_from_grok_bot_metal: 12.5,
        stats: completeStats({
          cpu_cores: 8,
          mem_total_bytes: 8_000_000_000,
          mem_used_bytes: 4_000_000_000,
          disk_total_bytes: 100_000_000_000,
          disk_used_bytes: 75_000_000_000,
          gpu_mem_total_bytes: 4_000_000_000,
          gpu_mem_used_bytes: 1_000_000_000,
          load_avg_1m: 1.5,
        }),
      },
    ],
  };
}

function completeStats(overrides) {
  return {
    cpu_cores: 1,
    cpu_percent: 1,
    mem_percent: 1,
    mem_total_bytes: 1,
    mem_used_bytes: 1,
    disk_percent: 1,
    disk_total_bytes: 1,
    disk_used_bytes: 1,
    gpu_mem_total_bytes: null,
    gpu_mem_used_bytes: null,
    load_avg_1m: null,
    ...overrides,
  };
}
