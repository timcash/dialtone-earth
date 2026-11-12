import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { isIP } from "node:net";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createGlobePlan,
  formatResource,
  loadNetworkIndex,
  loadNetworkOverview,
  resourceColumns,
  snapshotTimes,
  summarizeNetwork,
} from "../src/overview.ts";
import { sampleTour, shouldAnimateTour, TOUR_STOP_MS } from "../src/tour.ts";

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

test("the published metal overview shows only Legion's three reported capacities", async () => {
  const { networks: [entry] } = await readJson("index.json");
  const snapshot = await readJson("metal.json");
  const overview = summarizeNetwork(entry, snapshot);
  const reportingNodes = snapshot.nodes
    .filter((node) => Object.hasOwn(node, "resources"))
    .map(({ name, resources }) => ({ name, resources }));

  assert.equal(overview.nodeCount, 5);
  assert.equal(overview.nodes.length, 5);
  assert.deepEqual(reportingNodes, [{
    name: "legion",
    resources: {
      cpu_logical_cores: 28,
      mem_bytes: 34059010048,
      disk_bytes: 1021821579264,
    },
  }]);
  assert.deepEqual(Object.fromEntries(resourceColumns.map(({ key }) =>
    [key, formatResource(key, overview.resources[key])],
  )), {
    cpu_logical_cores: "28 cores (partial, 1/5 nodes)",
    mem_bytes: "31.72 GiB (partial, 1/5 nodes)",
    disk_bytes: "951.65 GiB (partial, 1/5 nodes)",
    gpu_mem_bytes: "Unavailable",
    load_1m: "Unavailable",
  });
});

test("metal displays distinct telemetry and location snapshot times in UTC", async () => {
  const snapshot = await readJson("metal.json");
  const { networks: [entry] } = await readJson("index.json");
  const overview = summarizeNetwork(entry, snapshot);

  assert.equal(snapshot.generated_at, "2026-11-12T01:50:34Z");
  assert.equal(snapshot.coordinates_generated_at, snapshot.generated_at);
  assert.deepEqual(overview.times, [
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
  assert.deepEqual(snapshotTimes({ generated_at: entry.generated_at, telemetry_generated_at: "invalid" }), [
    {
      label: "Network snapshot",
      dateTime: entry.generated_at,
      text: "12 Nov 2026, 01:50:34 UTC",
    },
  ]);
});

test("missing resource data and CPU percentages leave resource columns unavailable", () => {
  const overview = summarizeNetwork({ slug: "test", name: "Test", node_count: 1 }, {
    node_count: 1,
    nodes: [{ resources: { cpu_percent: 19.1 } }],
  });
  for (const { key } of resourceColumns) {
    assert.equal(formatResource(key, overview.resources[key]), "Unavailable");
  }
});

test("resource totals use reported units and preserve zero and partial coverage", () => {
  const gib = 1024 ** 3;
  const overview = summarizeNetwork({ slug: "test", name: "Test", node_count: 3 }, {
    node_count: 3,
    nodes: [
      { resources: { cpu_logical_cores: 8, mem_bytes: 2 * gib, disk_bytes: 3 * gib, gpu_mem_bytes: 0, load_1m: 0 } },
      { resources: { cpu_logical_cores: 4, mem_bytes: 3 * gib, disk_bytes: -1, gpu_mem_bytes: 0, load_1m: 2 } },
      { resources: { cpu_logical_cores: 2, mem_bytes: gib, disk_bytes: "100", gpu_mem_bytes: null } },
    ],
  });
  const read = (key) => formatResource(key, overview.resources[key]);

  assert.equal(read("cpu_logical_cores"), "14 cores");
  assert.equal(read("mem_bytes"), "6 GiB");
  assert.equal(read("disk_bytes"), "3 GiB (partial, 1/3 nodes)");
  assert.equal(read("gpu_mem_bytes"), "0 B (partial, 2/3 nodes)");
  assert.equal(read("load_1m"), "1 (partial, 2/3 nodes)");
});

test("short or inconsistent node lists never report complete totals", () => {
  const entry = { slug: "test", name: "Test", node_count: 3 };
  const node = { name: "one", lat: 0, lng: 0, resources: { cpu_logical_cores: 8 } };
  const overview = summarizeNetwork(entry, { node_count: 2, nodes: [node] });
  assert.equal(overview.snapshotStatus, "partial");
  assert.equal(overview.nodeCount, 3);
  assert.equal(formatResource("cpu_logical_cores", overview.resources.cpu_logical_cores), "8 cores (partial, 1/3 nodes)");

  const disagreement = summarizeNetwork({ ...entry, node_count: 0 }, { node_count: 1, nodes: [node] });
  assert.equal(disagreement.snapshotStatus, "partial");
  assert.equal(formatResource("cpu_logical_cores", disagreement.resources.cpu_logical_cores), "8 cores (partial, 1 reporting)");
});

test("loads every indexed network and isolates missing or malformed snapshots", async () => {
  const entries = [
    { slug: "metal", name: "Metal", node_count: 5 },
    { slug: "edge", name: "Edge", node_count: 1 },
    { slug: "lab", name: "Lab", node_count: 2 },
    { slug: "broken", name: "Broken" },
  ];
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(url);
    switch (url) {
      case "/networks/index.json": return Response.json({ networks: entries });
      case "/networks/metal.json": return Response.json(await readJson("metal.json"));
      case "/networks/edge.json": return Response.json({
        node_count: 1,
        nodes: [{ name: "edge node", lat: 1, lng: 2 }],
      });
      case "/networks/lab.json": return new Response(null, { status: 503 });
      case "/networks/broken.json": return Response.json({ nodes: "invalid" });
      default: throw new Error("Unexpected request");
    }
  };
  const { entries: index, skipped } = await loadNetworkIndex(fakeFetch);
  assert.equal(skipped, 0);
  const overviews = await Promise.all(index.map((entry) => loadNetworkOverview(entry, fakeFetch)));
  assert.deepEqual(requested, [
    "/networks/index.json", "/networks/metal.json", "/networks/edge.json",
    "/networks/lab.json", "/networks/broken.json",
  ]);
  assert.deepEqual(overviews.map(({ slug, nodeCount, snapshotStatus }) => [slug, nodeCount, snapshotStatus]), [
    ["metal", 5, "available"], ["edge", 1, "available"],
    ["lab", 2, "unavailable"], ["broken", null, "unavailable"],
  ]);
  await assert.rejects(loadNetworkIndex(async () => Response.json({ networks: null })), /invalid network index/i);

  const partialIndex = await loadNetworkIndex(async () => Response.json({
    networks: [null, { slug: "../invalid", name: "Invalid" }, entries[1]],
  }));
  assert.deepEqual(partialIndex, { entries: [entries[1]], skipped: 2 });
});

test("the globe only maps valid locations and tours each mapped network and node", () => {
  const makeNetwork = (slug, nodes) => summarizeNetwork(
    { slug, name: slug, node_count: nodes.length },
    { node_count: nodes.length, nodes },
  );
  const overview = createGlobePlan([
    makeNetwork("west", [
      { name: "west one", lat: 0, lng: 0 },
      { name: "unknown" },
      { name: "west two", lat: 15, lng: -20 },
    ]),
    makeNetwork("east", [
      { name: "east one", lat: 5, lng: 180 },
      { name: "east two", lat: 10, lng: -179 },
    ]),
    makeNetwork("unmapped", [{ name: "invalid", lat: 91, lng: 0 }]),
  ]);
  assert.deepEqual(overview.groups.map(({ slug, nodes }) => [slug, nodes.map(({ name }) => name)]), [
    ["west", ["west one", "west two"]], ["east", ["east one", "east two"]],
  ]);
  assert.deepEqual(overview.stops.map(({ network, node }) => [network, node]), [
    ["west", null], ["west", "west one"], ["west", "west two"],
    ["east", null], ["east", "east one"], ["east", "east two"],
  ]);
  const east = overview.stops[3];
  assert.ok(east.lat > 5 && east.lat < 10);
  assert.ok(Math.abs(east.lng) > 179);
});

test("the camera timeline holds each stop, transitions, and closes the loop", () => {
  assert.deepEqual(sampleTour(0, 3), { from: 0, to: 1, progress: 0 });
  assert.deepEqual(sampleTour(100, 3), { from: 0, to: 1, progress: 0 });
  const end = sampleTour(TOUR_STOP_MS * 3 - 100, 3);
  assert.equal(end.from, 2);
  assert.equal(end.to, 0);
  assert.ok(end.progress > 0.9 && end.progress < 1);
  assert.deepEqual(sampleTour(TOUR_STOP_MS * 3, 3), sampleTour(0, 3));
});

test("the tour animates only when visible, in view, and motion is enabled", () => {
  const playing = { hidden: false, inView: true, reducedMotion: false, paused: false, stopCount: 2 };
  assert.equal(shouldAnimateTour(playing), true);
  for (const override of [
    { hidden: true }, { inView: false }, { reducedMotion: true },
    { paused: true }, { stopCount: 1 }, { stopCount: 0 },
  ]) {
    assert.equal(shouldAnimateTour({ ...playing, ...override }), false);
  }
});

test("a sparse detail route preserves its escaped node table when WebGL fails", async (t) => {
  const snapshot = {
    network: 'Edge & "Lab" <test>',
    node_count: 3,
    nodes: [
      { name: "<svg>", lat: 0, lng: 0 },
      { name: "origin node", rtt_ms_from_grok_bot_metal: null },
      { name: "edge node", os: "<os>", version: '1"2', relay_region: "a&b", rtt_ms_from_grok_bot_metal: 12 },
    ],
  };
  const stage = { replaceChildren() {} };
  const controls = { textContent: "" };
  const shell = {
    innerHTML: "",
    insertAdjacentHTML(_position, markup) { this.innerHTML += markup; },
  };
  const app = {
    innerHTML: "",
    querySelector(selector) {
      return { ".network-shell": shell, ".globe-stage": stage, ".network-globe-help": controls }[selector] ?? null;
    },
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { querySelector: () => app } },
    window: { configurable: true, value: { location: { pathname: "/n/edge" } } },
  });
  t.after(() => { delete globalThis.document; delete globalThis.window; });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "/networks/edge.json");
    return Response.json(snapshot);
  });

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith("/src/main.ts")) {
        if (specifier === "./hud.css") return { url: "data:text/javascript,", shortCircuit: true };
        if (specifier === "./globe") {
          const module = 'export function mountGlobe() { throw new Error("No WebGL"); }';
          return { url: "data:text/javascript," + encodeURIComponent(module), shortCircuit: true };
        }
        if (specifier === "./overview") return nextResolve("./overview.ts", context);
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  await import("../src/main.ts");
  await setImmediate();

  assert.match(shell.innerHTML, /aria-label="Edge &amp; &quot;Lab&quot; &lt;test&gt; nodes"/);
  const rows = [...shell.innerHTML.matchAll(/class="node-row" role="row">([\s\S]*?)<\/div>/g)];
  assert.equal(rows.length, 3);
  assert.match(rows[0][1], /&lt;svg&gt;/);
  assert.equal((rows[0][1].match(/>Unavailable</g) ?? []).length, 4);
  assert.match(shell.innerHTML, /&lt;os&gt;[\s\S]*v1&quot;2[\s\S]*a&amp;b[\s\S]*12\.0 ms/);
  assert.match(shell.innerHTML, />origin</);
  assert.match(shell.innerHTML, /Snapshot time unavailable/);
  assert.doesNotMatch(shell.innerHTML, /SNAPSHOT UNAVAILABLE|<svg>|Invalid Date/);
  assert.equal(controls.textContent, "Globe unavailable.");
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
