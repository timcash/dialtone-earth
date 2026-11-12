import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    }
  }
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
