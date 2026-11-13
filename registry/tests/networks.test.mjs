import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

const registryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const networksRoot = path.join(registryRoot, "public", "networks");

const readJson = async (file) =>
  JSON.parse(await readFile(path.join(networksRoot, file), "utf8"));

const requiredEntryFields = [
  "slug",
  "name",
  "node_count",
  "online_count",
  "latest_release",
  "generated_at",
];

const requiredSnapshotFields = [
  "network",
  "generated_at",
  "latest_release",
  "node_count",
  "nodes",
];

const requiredNodeFields = [
  "name",
  "os",
  "arch",
  "version",
  "relay_region",
  "lat",
  "lng",
  "heard",
  "online",
  "rtt_ms_from_grok_bot_metal",
  "stats",
];

const requiredStatsFields = [
  "cpu_cores",
  "cpu_percent",
  "mem_percent",
  "mem_total_bytes",
  "mem_used_bytes",
  "disk_percent",
  "disk_total_bytes",
  "disk_used_bytes",
  "gpu_mem_total_bytes",
  "gpu_mem_used_bytes",
  "load_avg_1m",
];

test("network index and snapshots have the public registry shape", async () => {
  const index = await readJson("index.json");
  assert.ok(Array.isArray(index.networks) && index.networks.length > 0);

  for (const entry of index.networks) {
    assertHasFields(entry, requiredEntryFields, `index entry ${entry.slug}`);
    assert.match(entry.slug, /^[a-z0-9-]+$/);
    assert.equal(Date.parse(entry.generated_at) > 0, true);

    const snapshot = await readJson(`${entry.slug}.json`);
    assertHasFields(snapshot, requiredSnapshotFields, entry.slug);
    assert.equal(snapshot.network, entry.name);
    assert.equal(snapshot.node_count, snapshot.nodes.length);
    assert.equal(snapshot.node_count, entry.node_count);
    assert.equal(snapshot.latest_release, entry.latest_release);
    assert.equal(snapshot.generated_at, entry.generated_at);
    assert.equal(
      snapshot.nodes.filter((node) => node.online).length,
      entry.online_count,
    );

    for (const node of snapshot.nodes) {
      assertHasFields(node, requiredNodeFields, `${entry.slug}/${node.name}`);
      assertHasFields(
        node.stats,
        requiredStatsFields,
        `${entry.slug}/${node.name}/stats`,
      );
      assert.equal(typeof node.online, "boolean");
      assert.equal(Number.isInteger(node.lat), true, "latitude must be rounded");
      assert.equal(Number.isInteger(node.lng), true, "longitude must be rounded");
      assert.ok(node.lat >= -90 && node.lat <= 90);
      assert.ok(node.lng >= -180 && node.lng <= 180);
      assert.ok(
        node.rtt_ms_from_grok_bot_metal === null ||
          (typeof node.rtt_ms_from_grok_bot_metal === "number" &&
            node.rtt_ms_from_grok_bot_metal >= 0),
      );
      for (const [key, value] of Object.entries(node.stats)) {
        assert.ok(
          value === null || (typeof value === "number" && value >= 0),
          `${entry.slug}/${node.name}/stats.${key} must be non-negative or null`,
        );
      }
    }
  }
});

test("network aggregates use only reported capacity or percentage values", async () => {
  const metal = await readJson("metal.json");
  assert.deepEqual(aggregateNetwork(metal), {
    cpu: "42 cores",
    memory: "30.5/75.8 GB",
    disk: "0.73/1.22 TB",
    gpuMemory: "n/a",
    load: "n/a",
  });

  const complete = structuredClone(metal);
  complete.nodes = complete.nodes.slice(0, 2);
  complete.nodes[0].stats = completeStats({
    cpu_cores: 4,
    mem_total_bytes: 8_000_000_000,
    mem_used_bytes: 3_000_000_000,
    disk_total_bytes: 100_000_000_000,
    disk_used_bytes: 25_000_000_000,
    gpu_mem_total_bytes: 8_000_000_000,
    gpu_mem_used_bytes: 2_000_000_000,
    load_avg_1m: 0.5,
  });
  complete.nodes[1].stats = completeStats({
    cpu_cores: 8,
    mem_total_bytes: 8_000_000_000,
    mem_used_bytes: 4_000_000_000,
    disk_total_bytes: 100_000_000_000,
    disk_used_bytes: 75_000_000_000,
    gpu_mem_total_bytes: 4_000_000_000,
    gpu_mem_used_bytes: 1_000_000_000,
    load_avg_1m: 1.5,
  });
  assert.deepEqual(aggregateNetwork(complete), {
    cpu: "12 cores",
    memory: "7/16 GB",
    disk: "100/200 GB",
    gpuMemory: "3/12 GB",
    load: "1 avg",
  });

  complete.nodes[0].stats.cpu_percent = 10;
  complete.nodes[0].stats.mem_percent = 20;
  complete.nodes[0].stats.disk_percent = 30;
  complete.nodes[1].stats.cpu_cores = null;
  complete.nodes[1].stats.cpu_percent = 20;
  complete.nodes[1].stats.mem_percent = 40;
  complete.nodes[1].stats.mem_total_bytes = null;
  complete.nodes[1].stats.mem_used_bytes = null;
  complete.nodes[1].stats.disk_percent = 60;
  complete.nodes[1].stats.disk_total_bytes = null;
  complete.nodes[1].stats.disk_used_bytes = null;
  assert.deepEqual(aggregateNetwork(complete), {
    cpu: "15% avg",
    memory: "30% avg",
    disk: "45% avg",
    gpuMemory: "3/12 GB",
    load: "1 avg",
  });
});

test("overview node color uses reported max CPU or RAM load", async () => {
  const metal = await readJson("metal.json");
  assert.deepEqual(
    metal.nodes.map((node) => nodeLoadPercent(node.stats)),
    [59.4, 54.5, 8, 8, 7.6],
  );

  const stats = completeStats({ cpu_percent: 0, mem_percent: 0 });
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

test("preserves main snapshot provenance and whitelisted resources", async () => {
  const metal = await readJson("metal.json");
  assert.deepEqual(snapshotTimes(metal), [
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
  assert.deepEqual(
    metal.nodes.find((node) => node.name === "legion").resources,
    {
      cpu_logical_cores: 28,
      mem_bytes: 34059010048,
      disk_bytes: 1021821579264,
    },
  );
});

test("main overview and tour helpers still plan generic network loops", () => {
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

test("public network data contains no private addressing or identifiers", async () => {
  const index = await readJson("index.json");
  const documents = [
    index,
    ...(await Promise.all(
      index.networks.map((entry) => readJson(`${entry.slug}.json`)),
    )),
  ];

  for (const document of documents) {
    walk(document, (key, value) => {
      assert.doesNotMatch(
        key,
        /^(?:ip|ip_address|node_id|nodeid|ticket|channel_secret|secret)$/i,
        `forbidden field: ${key}`,
      );
      if (typeof value !== "string") return;
      assert.equal(isIP(value), 0, `IP address found in ${key}`);
      assert.doesNotMatch(
        value,
        /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
        `IPv4 address found in ${key}`,
      );
      assert.doesNotMatch(
        value,
        /(?:^|[^a-f0-9])[a-f0-9]{64}(?:$|[^a-f0-9])/i,
        `64-hex node id found in ${key}`,
      );
    });
  }
});

function assertHasFields(value, fields, label) {
  assert.equal(typeof value, "object", `${label} must be an object`);
  fields.forEach((field) => {
    assert.ok(
      Object.hasOwn(value, field),
      `${label} is missing required field "${field}"`,
    );
  });
}

function walk(value, visitor, key = "root") {
  visitor(key, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${key}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) =>
      walk(childValue, visitor, childKey),
    );
  }
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
