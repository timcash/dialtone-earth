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
import { buildSimulatedH3DataCells } from "../src/h3-geodata.ts";
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
          peer_rtt_ms: { "legion-metal": 14.8, "vm-us-metal": 22.1 },
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
  assert.equal(metalNet.plugins.length, 1);
  assert.equal(metalNet.plugins[0].name, "shell");
  assert.equal(metalNet.plugins[0].runtime, "stdio-rpc-blob");
  assert.equal(metalNet.plugins[0].repo, "timcash/dialtone-shell");

  const legion = metalNet.hosts.find((h) => h.name === "legion-metal");
  assert.ok(legion, "legion-metal missing");
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

test("metal-globe-h3-arcs: builds H3 telemetry cells and bundled atmospheric ping arcs from metal nodes", () => {
  const metalNet = adaptLiveMeshToNetwork(buildRealMetalChannelPayloads());
  const points = metalNet.hosts.map((h) => ({
    id: h.name,
    networkIndex: 0,
    lat: h.lat,
    lng: h.lng,
    rttMs: h.rtt_ms ?? 25,
  }));

  const liveOnlyCells = buildSimulatedH3DataCells(points, 3, false);
  const withDemoCells = buildSimulatedH3DataCells(points, 3, true);
  assert.ok(liveOnlyCells.length >= 5, `expected >= 5 H3 cells for 5 metal nodes, got ${liveOnlyCells.length}`);
  assert.ok(
    liveOnlyCells.length < withDemoCells.length,
    `live-only H3 cells (${liveOnlyCells.length}) must exclude simulated demo clusters (${withDemoCells.length})`,
  );
  assert.ok(liveOnlyCells.every((c) => typeof c.cell === "string" && c.cell.length > 0 && c.intensity > 0));

  const arcs = buildBundledPingArcs(points, 2.8, { segments: 24 });
  assert.ok(arcs.length >= 4, `expected >= 4 bundled ping arcs across metal nodes, got ${arcs.length}`);
  for (const arc of arcs) {
    assert.equal(arc.points.length, 25);
    const mid = arc.points[12];
    const midRadius = Math.hypot(mid[0], mid[1], mid[2]);
    assert.ok(
      midRadius > 2.82,
      `expected metal ping arc ${arc.fromId}->${arc.toId} to curve into atmosphere (>2.82), got ${midRadius.toFixed(3)}`,
    );
  }
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

  // Verify real H3 cells and bundled atmospheric ping arcs on real live metal nodes
  const points = liveNet.hosts.map((h) => ({
    id: h.name,
    networkIndex: 0,
    lat: h.lat,
    lng: h.lng,
    rttMs: h.rtt_ms ?? 25,
  }));
  const h3Cells = buildSimulatedH3DataCells(points, 3);
  assert.ok(h3Cells.length >= liveNet.hosts.length);

  const arcs = buildBundledPingArcs(points, 2.8, { segments: 24 });
  assert.ok(arcs.length >= 1, `expected bundled atmospheric ping arcs across live metal peers`);
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
