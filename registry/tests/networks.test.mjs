import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { aggregateNetwork } from "../src/aggregates.ts";

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
    cpu: "1.3% avg",
    memory: "27.3% avg",
    disk: "41.1% avg",
    gpuMemory: "n/a",
    load: "n/a",
  });

  const complete = structuredClone(metal);
  complete.nodes = complete.nodes.slice(0, 2);
  complete.nodes[0].stats = completeStats({
    cpu_cores: 4,
    mem_total_bytes: 8 * 1024 ** 3,
    mem_used_bytes: 3 * 1024 ** 3,
    disk_total_bytes: 100 * 1024 ** 3,
    disk_used_bytes: 25 * 1024 ** 3,
    gpu_mem_total_bytes: 8 * 1024 ** 3,
    gpu_mem_used_bytes: 2 * 1024 ** 3,
    load_avg_1m: 0.5,
  });
  complete.nodes[1].stats = completeStats({
    cpu_cores: 8,
    mem_total_bytes: 8 * 1024 ** 3,
    mem_used_bytes: 4 * 1024 ** 3,
    disk_total_bytes: 100 * 1024 ** 3,
    disk_used_bytes: 75 * 1024 ** 3,
    gpu_mem_total_bytes: 4 * 1024 ** 3,
    gpu_mem_used_bytes: 1 * 1024 ** 3,
    load_avg_1m: 1.5,
  });
  assert.deepEqual(aggregateNetwork(complete), {
    cpu: "12c",
    memory: "16 GiB",
    disk: "200 GiB",
    gpuMemory: "12 GiB",
    load: "1 avg",
  });
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
