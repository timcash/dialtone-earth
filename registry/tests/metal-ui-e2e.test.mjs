import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCameraContext,
  CAMERA_PRESETS,
  evaluateCameraPolicy,
  highlightTypeScript,
} from "../src/camera-policy.ts";
import { buildBundledPingArcs } from "../src/edge-bundling.ts";
import {
  buildQueryDrivenGlobeLayers,
  H3_LAYER_COLORS,
} from "../src/h3-geodata.ts";
import { adaptLiveMeshToNetwork } from "../src/live-adapter.ts";
import {
  bestEffortIntervalMs,
  createCustomQuery,
  createDefaultQuerySet,
  GLOBE_PANE_ID,
  normalizePaneAssignments,
  resolveEffectiveLayout,
} from "../src/query-workspace.ts";
import { handleGatewayRequest } from "../worker/gateway.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = resolve(__dirname, "..");

/**
 * Realistic live `metal` channel payloads modeled directly on Dialtone v0.5.5+
 * `/api/mesh`, `/api/plugins`, `/api/shell/sessions`, `/api/probe`, and `/api/state`.
 */
function buildRealMetalChannelPayloads() {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    hostname: "metal.dialtone.earth",
    networkName: "metal",
    currentUser: "timcash@gmail.com",
    mesh: {
      self_node: "legion-metal",
      mesh_config: {
        channel: "metal",
        channel_fingerprint: "metal-ch-9f4a21c8e7b3",
        node_name: "legion-metal",
      },
      blob_stats: {
        blob_keys: 28,
        blob_bytes: 18_420_000,
        installed_programs: 2,
        blob_fetches: 14,
      },
      nodes: [
        {
          node: "legion-metal",
          role: "Gateway Origin & GPU Host",
          os: "windows",
          arch: "amd64",
          version: "0.5.5",
          online: true,
          updated_at_unix: nowUnix,
          heard: 1840,
          geo_location: { lat: 37.77, lng: -122.42, label: "us-west (SF)" },
          peer_rtt_ms: {
            "mac-metal": 14.2,
            "vm-us-metal": 28.4,
            "vm-eu-metal": 138.6,
            "vm-asia-metal": 182.9,
          },
          iroh_transport: {
            advertised_relay_urls: ["https://use1-1.relay.n0.iroh-canary.iroh.link/"],
          },
          probe: { passed_count: 7, total_count: 7 },
          stats: {
            cpu_cores: 16,
            cpu_percent: 68.5,
            mem_percent: 54.0,
            mem_total_bytes: 34_359_738_368,
            mem_used_bytes: 18_554_258_718,
            disk_percent: 42.1,
            disk_total_bytes: 1_000_000_000_000,
            disk_used_bytes: 421_000_000_000,
            gpu_mem_total_bytes: 17_179_869_184,
            gpu_mem_used_bytes: 12_884_901_888,
            load_avg_1m: 6.4,
          },
        },
        {
          node: "mac-metal",
          role: "mesh-peer-node",
          os: "darwin",
          arch: "arm64",
          version: "0.5.5",
          online: true,
          updated_at_unix: nowUnix,
          heard: 1812,
          geo_location: { lat: 34.05, lng: -118.24, label: "us-west (LA)" },
          observed_remote_addrs: ["active:ip:192.168.1.220:60554", "active:relay:https://usw1-1.relay.n0.iroh.link./"],
          peer_rtt_ms: { "legion-metal": 14.8, "vm-us-metal": 22.1, "vm-asia-metal": 180.0 },
          probe: { passed_count: 7, total_count: 7 },
          stats: {
            cpu_cores: 12,
            cpu_percent: 24.0,
            mem_percent: 18.5,
            mem_total_bytes: 68_719_476_736,
            mem_used_bytes: 12_713_103_196,
            disk_percent: 31.0,
            disk_total_bytes: 1_000_000_000_000,
            disk_used_bytes: 310_000_000_000,
            gpu_mem_total_bytes: null,
            gpu_mem_used_bytes: null,
            load_avg_1m: 1.8,
          },
        },
        {
          node: "vm-us-metal",
          role: "mesh-peer-node",
          os: "linux",
          arch: "amd64",
          version: "0.5.5",
          online: true,
          updated_at_unix: nowUnix,
          heard: 1790,
          geo_location: { lat: 39.04, lng: -77.49, label: "us-east (VA)" },
          peer_rtt_ms: { "legion-metal": 29.1, "vm-eu-metal": 86.2 },
          probe: { passed_count: 7, total_count: 7 },
          stats: {
            cpu_cores: 4,
            cpu_percent: 82.0,
            mem_percent: 71.0,
            mem_total_bytes: 8_589_934_592,
            mem_used_bytes: 6_098_853_560,
            disk_percent: 55.0,
            disk_total_bytes: 100_000_000_000,
            disk_used_bytes: 55_000_000_000,
            gpu_mem_total_bytes: null,
            gpu_mem_used_bytes: null,
            load_avg_1m: 4.9,
          },
        },
        {
          node: "vm-eu-metal",
          role: "mesh-peer-node",
          os: "linux",
          arch: "amd64",
          version: "0.5.5",
          online: true,
          updated_at_unix: nowUnix,
          heard: 1765,
          geo_location: { lat: 50.11, lng: 8.68, label: "eu-central (FRA)" },
          peer_rtt_ms: { "vm-us-metal": 85.4, "vm-asia-metal": 164.0 },
          probe: { passed_count: 7, total_count: 7 },
          stats: {
            cpu_cores: 4,
            cpu_percent: 41.2,
            mem_percent: 48.0,
            mem_total_bytes: 8_589_934_592,
            mem_used_bytes: 4_123_168_604,
            disk_percent: 38.0,
            disk_total_bytes: 100_000_000_000,
            disk_used_bytes: 38_000_000_000,
            gpu_mem_total_bytes: null,
            gpu_mem_used_bytes: null,
            load_avg_1m: 1.5,
          },
        },
        {
          node: "vm-asia-metal",
          role: "mesh-peer-node",
          os: "linux",
          arch: "amd64",
          version: "0.5.5",
          online: true,
          updated_at_unix: nowUnix,
          heard: 1744,
          geo_location: { lat: 1.35, lng: 103.82, label: "ap-southeast (SIN)" },
          peer_rtt_ms: { "legion-metal": 196.4, "vm-eu-metal": 171.8 },
          probe: { passed_count: 7, total_count: 7 },
          stats: {
            cpu_cores: 4,
            cpu_percent: 35.0,
            mem_percent: 39.0,
            mem_total_bytes: 8_589_934_592,
            mem_used_bytes: 3_350_074_490,
            disk_percent: 29.0,
            disk_total_bytes: 100_000_000_000,
            disk_used_bytes: 29_000_000_000,
            gpu_mem_total_bytes: null,
            gpu_mem_used_bytes: null,
            load_avg_1m: 1.1,
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
            version: "0.1.0",
            kind: "blob-binary",
            source_repo: "timcash/dialtone-shell",
            protocols: ["dialtone/shell/1", "stdio-rpc/v1"],
            blob_digest: "sha256:9f84b2c1a40e71f23c8d4a0b91c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
            bytes: 5_242_880,
            installed_at_unix: nowUnix - 120,
          },
        },
      ],
    },
    sessions: {
      sessions: [
        {
          name: "metal-ops",
          shell: "bash",
          cwd: "/home/tim",
          status: "active",
          interrupt_count: 0,
          last_command: "curl -H 'Authorization: Bearer secret_metal_token_999' http://127.0.0.1:8788/api/mesh",
          last_output: "5 metal peers online",
        },
      ],
    },
    processes: {
      processes: [
        {
          name: "dialtone-shell",
          pid: 4812,
          digest: "sha256:9f84b2c1a40e71f2",
          restart_count: 0,
        },
      ],
    },
    fullState: {
      events: [
        {
          timestamp: new Date().toISOString(),
          kind: "probe",
          message: "metal channel 7/7 probe checks passed across 5 peers",
        },
      ],
    },
  };
}

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [];
      for (const name of store.keys()) {
        if (name.startsWith(prefix)) keys.push({ name });
      }
      return { keys };
    },
  };
}

test("metal-live-parity: adapts live metal channel nodes, dialtone-shell plugin, and redacts secrets", () => {
  const metalNet = adaptLiveMeshToNetwork(buildRealMetalChannelPayloads());
  assert.equal(metalNet.simulated, false);
  assert.equal(metalNet.slug, "metal");
  assert.equal(metalNet.hostname, "metal.dialtone.earth");
  assert.equal(metalNet.hosts.length, 5);
  const mac = metalNet.hosts.find((h) => h.name === "mac-metal");
  assert.ok(mac, "expected mac-metal peer");
  assert.equal(mac.path_mode, "lan", "expected LAN path classification from 192.168.1.220");
  assert.equal(
    mac.rtt_ms,
    14.2,
    "expected direct RTT from legion-metal (14.2ms), not average including 180ms WAN peer",
  );
  assert.equal(metalNet.plugins.length, 1);
  assert.equal(metalNet.plugins[0].name, "shell");
  assert.equal(metalNet.plugins[0].runtime, "stdio-rpc-blob");
  assert.equal(metalNet.plugins[0].repo, "timcash/dialtone-shell");

  const legion = metalNet.hosts.find((h) => h.name === "legion-metal");
  assert.ok(legion, "legion-metal missing");
  assert.equal(legion.path_mode, "self");
  assert.equal(legion.sessions.length, 1);
  assert.ok(
    !legion.sessions[0].lastCommand.includes("secret_metal_token_999"),
    "bearer token leaked into adapted shell session",
  );
  assert.ok(
    metalNet.shellAuditLog.every((e) => !e.command.includes("secret_metal_token_999")),
    "bearer token leaked into shell audit log",
  );
});

test("metal-globe-h3-arcs: globe overlays are 100% query-driven with zero cloud layer or fake H3 halos", () => {
  // 1. Verify decorative cloud/atmosphere layers and fake H3 clusters are completely gone
  const materialsTs = readFileSync(resolve(REGISTRY_DIR, "src/hud-globe-materials.ts"), "utf8");
  const globeTs = readFileSync(resolve(REGISTRY_DIR, "src/overview-globe.ts"), "utf8");
  const geodataTs = readFileSync(resolve(REGISTRY_DIR, "src/h3-geodata.ts"), "utf8");
  assert.ok(!materialsTs.includes("createHudCloudMaterial"), "cloud layer must be removed");
  assert.ok(!materialsTs.includes("createHudAtmosphereMaterial"), "fake atmosphere halo must be removed");
  assert.ok(!globeTs.includes("createHudCloudMaterial"), "overview-globe must not render clouds");
  assert.ok(!globeTs.includes("addRelayMicroNode"), "overview-globe must not render fake relay micro-nodes");
  assert.ok(!geodataTs.includes("SIMULATED_GEOSPATIAL_CLUSTERS"), "fake H3 demo clusters must be removed");
  assert.ok(!geodataTs.includes("gridDisk"), "fake 1-ring H3 neighbor halos must be removed");

  // 2. Verify live metal channel query-driven projection
  const metalNet = adaptLiveMeshToNetwork(buildRealMetalChannelPayloads());
  const queries = createDefaultQuerySet([metalNet]);
  const hostsQ = queries.find((q) => q.kind === "hosts");
  const pluginsQ = queries.find((q) => q.kind === "plugins");
  const usersQ = queries.find((q) => q.kind === "users");
  const hostQ = createCustomQuery(queries, {
    kind: "host",
    source: "channel",
    networkSlug: "metal",
    rate: "med",
  });
  const testsQ = queries.find((q) => q.kind === "tests");

  // Globe-only (no query tables open) -> 0 H3 tiles, 0 RTT arcs
  const baseOnly = buildQueryDrivenGlobeLayers([metalNet], [], "legion-metal", false);
  assert.equal(baseOnly.markers.length, 5);
  assert.equal(baseOnly.h3Cells.length, 0);
  assert.equal(baseOnly.arcNodes.length, 0);
  assert.equal(baseOnly.measuredArcCount, 0);
  assert.equal(baseOnly.legend, "BASE NODES ONLY");

  // Hosts query open -> exact 1 res-3 tile per host (5 nodes = 5 tiles, never 35-tile halo!) + measured peer_rtt_ms arcs only
  const hostsLayers = buildQueryDrivenGlobeLayers([metalNet], [hostsQ], "legion-metal", false);
  assert.equal(hostsLayers.h3Cells.length, 5, `expected exact 5 H3 tiles for 5 metal hosts, got ${hostsLayers.h3Cells.length}`);
  assert.equal(hostsLayers.onlyMeasuredLinks, true);
  assert.ok(hostsLayers.measuredArcCount >= 5, `expected real measured RTT arcs, got ${hostsLayers.measuredArcCount}`);
  assert.match(hostsLayers.legend, /^H3: LOAD \(5\) · ARCS: \d+ RTT$/);

  const arcs = buildBundledPingArcs(hostsLayers.arcNodes, 2.8, {
    segments: 24,
    onlyMeasuredLinks: true,
  });
  assert.equal(arcs.length, hostsLayers.measuredArcCount);
  for (const arc of arcs) {
    assert.equal(arc.points.length, 25);
    const mid = arc.points[12];
    const midRadius = Math.hypot(mid[0], mid[1], mid[2]);
    assert.ok(
      midRadius > 2.82,
      `expected metal ping arc ${arc.fromId}->${arc.toId} to curve into atmosphere (>2.82), got ${midRadius.toFixed(3)}`,
    );
  }

  // Plugins query only -> cyan tile ONLY on plugin host (legion-metal), 0 RTT arcs
  const pluginsLayers = buildQueryDrivenGlobeLayers([metalNet], [pluginsQ], "legion-metal", false);
  assert.equal(pluginsLayers.h3Cells.length, 1);
  assert.equal(pluginsLayers.h3Cells[0].colorHex, H3_LAYER_COLORS.plugins);
  assert.deepEqual(pluginsLayers.h3Cells[0].hosts, ["legion-metal"]);
  assert.equal(pluginsLayers.arcNodes.length, 0);
  assert.equal(pluginsLayers.legend, "H3: PLUGINS (1) · NO RTT QUERY");

  // Single host query -> exact 1 H3 tile for focused host + arcs focused on that host
  const singleHostLayers = buildQueryDrivenGlobeLayers([metalNet], [hostQ], "mac-metal", false);
  assert.equal(singleHostLayers.h3Cells.length, 1);
  assert.deepEqual(singleHostLayers.h3Cells[0].hosts, ["mac-metal"]);
  assert.equal(singleHostLayers.focusHostName, "mac-metal");
  const focusedArcs = buildBundledPingArcs(singleHostLayers.arcNodes, 2.8, {
    segments: 16,
    onlyMeasuredLinks: true,
    focusHostName: singleHostLayers.focusHostName,
  });
  assert.equal(focusedArcs.length, 3, "mac-metal has measured peer_rtt_ms to legion-metal, vm-us-metal, and vm-asia-metal");

  // Users & probes queries -> violet / green tiles driven strictly by real data
  const usersLayers = buildQueryDrivenGlobeLayers([metalNet], [usersQ], "legion-metal", false);
  assert.ok(usersLayers.h3Cells.every((c) => c.colorHex === H3_LAYER_COLORS.users));
  const testsLayers = buildQueryDrivenGlobeLayers([metalNet], [testsQ], "legion-metal", false);
  assert.equal(testsLayers.h3Cells.length, 5);
  assert.ok(testsLayers.h3Cells.every((c) => c.colorHex === H3_LAYER_COLORS.probesPass));
});

test("metal-tiling-wm-rates: supports whole-app tiling defaults, 1|2 & 2x2 splits, globe pane, and best-effort rates", () => {
  const metalNet = adaptLiveMeshToNetwork(buildRealMetalChannelPayloads());
  assert.equal(resolveEffectiveLayout("auto", 1440), "1|1");
  assert.equal(resolveEffectiveLayout("auto", 640), "1/1");

  const queries = createDefaultQuerySet([metalNet]);
  assert.ok(queries.every((q) => q.networkSlug === "metal"));

  const customP95 = createCustomQuery(queries, {
    label: "metal hosts fast",
    kind: "hosts",
    source: "mesh-channel",
    networkSlug: "metal",
    rate: "fast",
  });
  queries.push(customP95);

  const split12 = normalizePaneAssignments([GLOBE_PANE_ID, customP95.id], queries, "1|2");
  assert.equal(split12.length, 3);
  assert.equal(split12[0], GLOBE_PANE_ID);
  assert.equal(split12[1], customP95.id);

  const split2x2 = normalizePaneAssignments(split12, queries, "2x2");
  assert.equal(split2x2.length, 4);
  assert.equal(split2x2[0], GLOBE_PANE_ID);

  assert.equal(bestEffortIntervalMs("fast", 0, false), 1_500);
  assert.equal(bestEffortIntervalMs("med", 0, false), 4_000);
  assert.equal(bestEffortIntervalMs("slow", 0, false), 10_000);
  assert.equal(bestEffortIntervalMs("base", 0, false), 30_000);
  assert.equal(bestEffortIntervalMs("fast", 0, true), null, "hidden tab must pause polling");
});

test("metal-camera-studio: evaluates all 8 presets, custom TS policies, and syntax highlighting on metal nodes", () => {
  const metalNet = adaptLiveMeshToNetwork(buildRealMetalChannelPayloads());
  const ctx = buildCameraContext([metalNet], "metal");
  assert.equal(ctx.nodes.length, 5);
  assert.ok(CAMERA_PRESETS.length >= 8);

  for (const preset of CAMERA_PRESETS) {
    const res = evaluateCameraPolicy(preset.code, ctx);
    assert.equal(res.ok, true, `preset ${preset.id} failed on metal data: ${res.error}`);
    assert.ok(res.target, `preset ${preset.id} returned null target on metal data`);
    assert.ok(Number.isFinite(res.target.lat) && Number.isFinite(res.target.lng));
  }

  const hiCpu = evaluateCameraPolicy(CAMERA_PRESETS.find((p) => p.id === "highest-cpu").code, ctx);
  assert.equal(hiCpu.target.node, "vm-us-metal");

  const loMem = evaluateCameraPolicy(CAMERA_PRESETS.find((p) => p.id === "lowest-mem").code, ctx);
  assert.equal(loMem.target.node, "mac-metal");

  const hiP95 = evaluateCameraPolicy(CAMERA_PRESETS.find((p) => p.id === "highest-p95").code, ctx);
  assert.equal(hiP95.target.node, "vm-asia-metal");

  const customCode = `// Pick highest combined CPU + p95 latency on metal
export function selectTarget(ctx: CameraContext): CameraTarget | null {
  const hot = maxBy(ctx.nodes.filter(n => n.online), (n: CameraNodeMetric) => n.cpu + n.rttP95 * 0.5);
  return hot ? { lat: hot.lat, lng: hot.lng, node: hot.name, network: hot.network, reason: "metal-hot" } : null;
}`;
  const customRes = evaluateCameraPolicy(customCode, ctx);
  assert.equal(customRes.ok, true);
  assert.equal(customRes.target.node, "vm-asia-metal");
  assert.equal(customRes.target.reason, "metal-hot");

  const html = highlightTypeScript(customCode);
  for (const cls of ["tok-com", "tok-kw", "tok-ty", "tok-fn", "tok-num", "tok-str"]) {
    assert.ok(html.includes(cls), `highlightTypeScript missing token class ${cls}`);
  }
});

test("metal-kv-config-and-captions: persists layout & camera studio policy in CF KV and keeps 2-line captions", async () => {
  const kv = createMemoryKv();
  const env = {
    DIALTONE_AUTH_TOKENS: kv,
    ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    ACCESS_AUD_MAP: JSON.stringify({ "metal.dialtone.earth": "aud-metal" }),
    MESH_ORIGINS_MAP: JSON.stringify({ "metal.dialtone.earth": ["https://origin-a.internal"] }),
  };
  const deps = {
    verifyJwt: async () => ({ valid: true, subject: "timcash@gmail.com" }),
  };

  const payload = {
    version: 2,
    layout: "1|2",
    paneContents: ["globe", "q-hosts", "q-plugins"],
    queries: [
      { id: "q-hosts", label: "metal hosts", kind: "hosts", source: "channel", networkSlug: "metal", rate: "fast" },
      { id: "q-plugins", label: "metal plugins", kind: "plugins", source: "channel", networkSlug: "metal", rate: "slow" },
    ],
    cameraPolicyCode: CAMERA_PRESETS.find((p) => p.id === "highest-p95").code,
    theme: "dark",
  };

  const putResp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/user/ui-config", {
      method: "PUT",
      headers: {
        "Cf-Access-Jwt-Assertion": "valid-jwt",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
    env,
    deps,
  );
  assert.equal(putResp.status, 200);

  const getResp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/user/ui-config", {
      method: "GET",
      headers: { "Cf-Access-Jwt-Assertion": "valid-jwt" },
    }),
    env,
    deps,
  );
  assert.equal(getResp.status, 200);
  const loaded = await getResp.json();
  assert.equal(loaded.saved, true);
  assert.equal(loaded.config.layout, "1|2");
  assert.deepEqual(loaded.config.paneContents, ["globe", "q-hosts", "q-plugins"]);
  assert.equal(loaded.config.cameraPolicyCode, payload.cameraPolicyCode);

  // Verify fullscreen config & camera pages both reserve top 2-line tour captions and Camera Studio IDE
  const mainTs = readFileSync(resolve(REGISTRY_DIR, "src/main.ts"), "utf8");
  assert.ok(mainTs.includes('renderFullscreenTourCaptionsHtml("config-tour-captions")'));
  assert.ok(mainTs.includes('renderFullscreenTourCaptionsHtml("camera-tour-captions")'));
  assert.ok(mainTs.includes('data-testid="camera-page"'));
  assert.ok(mainTs.includes('data-testid="camera-ts-highlight"'));
});

test("metal-live-daemon-8788: adapts real live metal channel daemon into globe H3 arcs and Camera Studio", async (t) => {
  const base = (process.env.METAL_LIVE_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
  let mesh;
  try {
    const resp = await fetch(`${base}/api/mesh`, { signal: AbortSignal.timeout(2_500) });
    if (!resp.ok) {
      t.skip(`live metal daemon returned HTTP ${resp.status} at ${base}`);
      return;
    }
    mesh = await resp.json();
  } catch {
    t.skip(`live local metal daemon not reachable at ${base}`);
    return;
  }

  const fetchOpt = async (path) => {
    try {
      const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_500) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };

  const [plugins, sessions, probe, processes] = await Promise.all([
    fetchOpt("/api/plugins"),
    fetchOpt("/api/shell/sessions"),
    fetchOpt("/api/probe"),
    fetchOpt("/api/processes"),
  ]);

  const liveNet = adaptLiveMeshToNetwork({
    hostname: "metal.dialtone.earth",
    networkName: "metal",
    currentUser: "live-metal-test",
    mesh,
    plugins,
    sessions,
    probe,
    processes,
  });

  assert.equal(liveNet.simulated, false);
  assert.equal(liveNet.slug, "metal");
  assert.ok(liveNet.hosts.length >= 2, `expected >= 2 live metal peers, got ${liveNet.hosts.length}`);

  // Verify co-located peers (e.g. legion/build-1/rosie) fanned out to distinct coordinates
  const coordSet = new Set(liveNet.hosts.map((h) => `${h.lat.toFixed(2)},${h.lng.toFixed(2)}`));
  assert.equal(
    coordSet.size,
    liveNet.hosts.length,
    `expected distinct globe coordinates for all ${liveNet.hosts.length} live metal nodes, got ${coordSet.size}`,
  );

  // Verify query-driven H3 cells and real measured peer_rtt_ms arcs on live metal nodes
  const liveQueries = createDefaultQuerySet([liveNet]);
  const liveHostsQ = liveQueries.find((q) => q.kind === "hosts");
  const liveLayers = buildQueryDrivenGlobeLayers([liveNet], [liveHostsQ], liveNet.hosts[0].name, false);
  assert.ok(liveLayers.h3Cells.length >= 1 && liveLayers.h3Cells.length <= liveNet.hosts.length);

  const arcs = buildBundledPingArcs(liveLayers.arcNodes, 2.8, {
    segments: 24,
    onlyMeasuredLinks: true,
  });
  assert.ok(arcs.length >= 1, `expected real measured peer_rtt_ms arcs across live metal peers`);
  for (const arc of arcs) {
    const mid = arc.points[12];
    const r = Math.hypot(mid[0], mid[1], mid[2]);
    assert.ok(Number.isFinite(r) && r > 2.82, `arc ${arc.fromId}->${arc.toId} invalid radius ${r}`);
  }

  // Verify all 8 TypeScript Camera Studio presets evaluate cleanly against real live metal nodes
  const camCtx = buildCameraContext([liveNet], "metal");
  assert.equal(camCtx.nodes.length, liveNet.hosts.length);
  for (const preset of CAMERA_PRESETS) {
    const res = evaluateCameraPolicy(preset.code, camCtx);
    assert.equal(res.ok, true, `preset ${preset.id} failed on live metal daemon: ${res.error}`);
    assert.ok(res.target && Number.isFinite(res.target.lat) && Number.isFinite(res.target.lng));
  }

  console.log(
    `LIVE METAL OK: ${liveNet.hosts.length} nodes (${liveNet.hosts.map((h) => h.name).join(", ")}), ${arcs.length} bundled arcs, ${liveNet.plugins.length} plugin(s)`,
  );
});
