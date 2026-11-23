import type {
  MeshHost,
  MeshNetwork,
  MeshUserLocation,
  MeshUserPresence,
  ShellAuditEntry,
  SimBlobStoreStats,
  SimPluginDeployment,
  SimRecoveryEvent,
  SimShellSession,
  SimTestRun,
} from "./simulation";
import { redactSecrets, redactText } from "../worker/redact.ts";

export interface LiveMeshPayloads {
  hostname: string;
  networkName?: string;
  currentUser?: string;
  mesh: Record<string, unknown>;
  plugins?: Record<string, unknown> | null;
  sessions?: Record<string, unknown> | null;
  processes?: Record<string, unknown> | null;
  probe?: Record<string, unknown> | null;
  fullState?: Record<string, unknown> | null;
  tests?: Record<string, unknown> | null;
  users?: Record<string, unknown> | null;
}

/**
 * Adapts real Dialtone v0.5.5 + timcash/template JSON payloads into the exact
 * same MeshNetwork model rendered by the simulated system tour so signed-in
 * and signed-out views display identical structure, metrics, and screens.
 */
export function adaptLiveMeshToNetwork(input: LiveMeshPayloads): MeshNetwork {
  const mesh = asRecord(input.mesh);
  const meshConfig = asRecord(mesh.mesh_config);
  const channel =
    asString(meshConfig.channel) ||
    asString(input.networkName) ||
    "metal";
  const channelFingerprint =
    asString(meshConfig.channel_fingerprint) || "live-channel";
  const selfNode = asString(mesh.self_node) || asString(meshConfig.node_name);
  const nowSec = Math.floor(Date.now() / 1000);

  const plugins = adaptPlugins(input.plugins);
  const topProcesses = adaptProcesses(input.processes ?? mesh);
  const topSessions = adaptSessions(input.sessions);
  const blobStore = adaptBlobStore(mesh.blob_stats, plugins.length);
  const recoveryEvents = adaptRecoveryEvents(input.fullState, input.probe, selfNode);
  const tests = adaptTests(input.tests);
  const shellAuditLog = adaptShellAuditLog(
    input.users,
    topSessions,
    selfNode || channel,
    input.currentUser || "authorized-user",
  );
  const users = adaptUsers(input.users, input.currentUser, shellAuditLog);

  const rawNodes = Array.isArray(mesh.nodes) ? mesh.nodes : [];

  // Build symmetric peer RTT graph so every host reports true RTT from `selfNode`
  // (direct hop if neighbored, else shortest path via Dijkstra) instead of averaging distant WAN peers.
  const rttGraph = new Map<string, Map<string, number>>();
  const addGraphEdge = (a: string, b: string, ms: number) => {
    if (!a || !b || a === b || !Number.isFinite(ms) || ms <= 0) return;
    let aMap = rttGraph.get(a);
    if (!aMap) {
      aMap = new Map();
      rttGraph.set(a, aMap);
    }
    const existing = aMap.get(b);
    if (existing === undefined || ms < existing) {
      aMap.set(b, Math.round(ms * 10) / 10);
    }
  };
  for (const raw of rawNodes) {
    const n = asRecord(raw);
    const name = asString(n.node) || asString(n.name);
    if (!name) continue;
    const peerMap = asRecord(n.peer_rtt_ms);
    for (const [peerName, val] of Object.entries(peerMap)) {
      if (typeof val === "number" && Number.isFinite(val) && val > 0) {
        addGraphEdge(name, peerName, val);
        addGraphEdge(peerName, name, val);
      }
    }
  }
  const shortestFromSelf = computeShortestRttFromOrigin(selfNode, rttGraph);

  const hosts: MeshHost[] = rawNodes.map((raw) => {
    const n = asRecord(raw);
    const name = asString(n.node) || asString(n.name) || "unknown-node";
    const isSelf = selfNode !== "" && name === selfNode;
    const geo = asRecord(n.geo_location);
    const rawStats = asRecord(n.stats);
    const probe = asRecord(n.probe);
    const probeSummary = formatProbeSummary(probe);
    const updatedAt = asNumber(n.updated_at_unix);
    const online =
      typeof n.online === "boolean"
        ? n.online
        : isSelf || (updatedAt !== null && nowSec - updatedAt < 120);

    const peerRttMap = asRecord(n.peer_rtt_ms);
    const cleanPeerRtt: Record<string, number> = {};
    for (const [peerName, val] of Object.entries(peerRttMap)) {
      if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
        cleanPeerRtt[peerName] = Math.round(val * 10) / 10;
      }
    }
    const rttValues = Object.values(cleanPeerRtt);
    const fromSelf = shortestFromSelf.get(name);
    const rttMs = isSelf
      ? 0
      : typeof fromSelf === "number"
        ? fromSelf
        : rttValues.length > 0
          ? Math.round((rttValues.reduce((a, b) => a + b, 0) / rttValues.length) * 10) / 10
          : null;
    const pathMode = classifyPathMode(isSelf, n.observed_remote_addrs);

    const nodeProcesses =
      Array.isArray(n.processes) && n.processes.length > 0
        ? adaptProcesses({ processes: n.processes })
        : isSelf
          ? topProcesses
          : [];

    const relayUrls = Array.isArray(asRecord(n.iroh_transport).advertised_relay_urls)
      ? (asRecord(n.iroh_transport).advertised_relay_urls as unknown[])
      : [];
    const relayRegion =
      asString(geo.label) ||
      extractRelayLabel(asString(relayUrls[0])) ||
      "iroh-relay";

    return {
      name,
      role: isSelf
        ? "Gateway Origin & Mesh Peer"
        : asString(n.role) || "mesh-peer-node",
      os: asString(n.os) || "unknown",
      arch: asString(n.arch) || "unknown",
      version: asString(n.version) || "0.5.5",
      relay_region: relayRegion,
      lat: Math.round((asNumber(geo.lat) ?? 0) * 100) / 100,
      lng: Math.round((asNumber(geo.lng) ?? 0) * 100) / 100,
      heard: asNumber(n.heard) ?? 0,
      online,
      rtt_ms: rttMs,
      peer_rtt_ms: cleanPeerRtt,
      path_mode: pathMode,
      gpuName: null,
      gpuLoadPercent: null,
      probeSummary,
      stats: {
        cpu_cores: asNumber(rawStats.cpu_cores),
        cpu_percent: asNumber(rawStats.cpu_percent),
        mem_percent: asNumber(rawStats.mem_percent),
        mem_total_bytes: asNumber(rawStats.mem_total_bytes),
        mem_used_bytes: asNumber(rawStats.mem_used_bytes),
        disk_percent: asNumber(rawStats.disk_percent),
        disk_total_bytes: asNumber(rawStats.disk_total_bytes),
        disk_used_bytes: asNumber(rawStats.disk_used_bytes),
        gpu_mem_total_bytes: asNumber(rawStats.gpu_mem_total_bytes),
        gpu_mem_used_bytes: asNumber(rawStats.gpu_mem_used_bytes),
        load_avg_1m: asNumber(rawStats.load_avg_1m),
      },
      processes: nodeProcesses,
      plugins: isSelf ? plugins : [],
      sessions: isSelf ? topSessions : [],
      blobStore: isSelf
        ? blobStore
        : {
            objects: 0,
            totalBytes: 0,
            pinnedPlugins: 0,
            peerPulls24h: 0,
            cacheHitPercent: 100,
            verifiedSha256Percent: 100,
            recentTransfer: "Peer blob metrics available via /api/details",
          },
    };
  });

  // Deterministically fan out co-located peers (e.g. multiple nodes in one metro)
  // by a tiny ~0.35° ring so each node and its bundled ping arcs stay distinct on the 3D globe.
  const geoGroups = new Map<string, MeshHost[]>();
  for (const h of hosts) {
    const key = `${h.lat.toFixed(2)},${h.lng.toFixed(2)}`;
    const group = geoGroups.get(key) ?? [];
    group.push(h);
    geoGroups.set(key, group);
  }
  for (const group of geoGroups.values()) {
    if (group.length < 2) continue;
    group.forEach((host, idx) => {
      const angle = (2 * Math.PI * idx) / group.length;
      const radius = 0.35;
      host.lat = Math.round((host.lat + Math.sin(angle) * radius) * 100) / 100;
      host.lng = Math.round((host.lng + Math.cos(angle) * radius) * 100) / 100;
    });
  }

  const latestVersion =
    hosts.find((h) => h.version)?.version || "0.5.5";
  const regionLabels = [
    ...new Set(hosts.map((h) => h.relay_region).filter(Boolean)),
  ].slice(0, 3);

  return {
    slug: channel,
    name: channel,
    hostname: input.hostname,
    channelFingerprint,
    regionSummary: regionLabels.join(" · ") || "Dialtone Iroh Mesh",
    simulated: false,
    snapshot: {
      network: channel,
      generated_at: new Date().toISOString(),
      latest_release: latestVersion,
      node_count: hosts.length,
      nodes: hosts,
    },
    hosts,
    plugins,
    blobStore,
    recoveryEvents,
    tests,
    users,
    shellAuditLog,
  };
}

function adaptPlugins(
  raw: Record<string, unknown> | null | undefined,
): SimPluginDeployment[] {
  const list = Array.isArray(asRecord(raw).plugins)
    ? (asRecord(raw).plugins as unknown[])
    : [];
  return list.map((entry) => {
    const item = asRecord(entry);
    const manifest = asRecord(item.manifest);
    const protocols = Array.isArray(manifest.protocols)
      ? (manifest.protocols as unknown[]).map(asString).filter(Boolean)
      : [];
    const installedUnix = asNumber(manifest.installed_at_unix);
    return {
      name: asString(manifest.name) || "plugin",
      version: asString(manifest.version) || "0.5.5",
      protocol: protocols.join(", ") || "stdio-rpc/v1",
      runtime:
        asString(manifest.kind) === "blob-binary"
          ? "stdio-rpc-blob"
          : "builtin-quic",
      repo: asString(manifest.source_repo) || "timcash/dialtone",
      digest: shortenDigest(asString(manifest.blob_digest)),
      sizeBytes: asNumber(manifest.bytes) ?? 0,
      status: item.verified === false ? "verifying" : "deployed",
      deployedAt: installedUnix
        ? new Date(installedUnix * 1000).toISOString()
        : new Date().toISOString(),
    };
  });
}

function adaptProcesses(
  raw: Record<string, unknown> | null | undefined,
): MeshHost["processes"] {
  const list = Array.isArray(asRecord(raw).processes)
    ? (asRecord(raw).processes as unknown[])
    : [];
  return list.map((entry) => {
    const p = asRecord(entry);
    const restarts = asNumber(p.restart_count) ?? 0;
    return {
      name: asString(p.name) || "process",
      pid: asNumber(p.pid) ?? 0,
      digest: shortenDigest(asString(p.digest)),
      restarts,
      status: restarts > 0 ? "recovered" : "running",
    };
  });
}

function adaptSessions(
  raw: Record<string, unknown> | null | undefined,
): SimShellSession[] {
  const list = Array.isArray(asRecord(raw).sessions)
    ? (asRecord(raw).sessions as unknown[])
    : [];
  return list.map((entry) => {
    const s = asRecord(entry);
    const shell = asString(s.shell).toLowerCase().includes("power")
      ? "powershell"
      : "bash";
    return {
      name: asString(s.name) || "session",
      shell,
      cwd: asString(s.cwd) || "~",
      status: asString(s.status) === "idle" ? "idle" : "active",
      interrupts: asNumber(s.interrupt_count) ?? 0,
      lastCommand: redactText(asString(s.last_command) || "(interactive shell)"),
      lastOutput: redactText(
        asString(s.last_output) || "(connected over dialtone/shell/1)",
      ),
    };
  });
}

function adaptUsers(
  raw: Record<string, unknown> | null | undefined,
  currentUser: string | undefined,
  auditLog: ShellAuditEntry[],
): MeshUserPresence[] {
  const list = Array.isArray(asRecord(raw).users)
    ? (asRecord(raw).users as unknown[])
    : [];
  const adapted: MeshUserPresence[] = list
    .map((entry): MeshUserPresence | null => {
      const u = asRecord(entry);
      const email = asString(u.email);
      if (!email) return null;
      const rawLocs = Array.isArray(u.locations) ? u.locations : [];
      const locations: MeshUserLocation[] = rawLocs.map((locRaw, idx) => {
        const l = asRecord(locRaw);
        return {
          sessionId: asString(l.sessionId) || `sess-${idx}`,
          location: asString(l.location) || "Edge session",
          city: asString(l.city) || null,
          region: asString(l.region) || null,
          country: asString(l.country) || null,
          colo: asString(l.colo) || null,
          viewingView: asString(l.viewingView) || "overview",
          viewingNode: asString(l.viewingNode) || null,
          lastSeenAt: asString(l.lastSeenAt) || new Date().toISOString(),
        };
      });
      const shellNodes = Array.isArray(u.shellNodes)
        ? (u.shellNodes as unknown[]).map(asString).filter(Boolean)
        : [];
      return {
        email,
        role: asString(u.role) || "authorized-member",
        status: asString(u.status) === "idle" ? "idle" : "active",
        locations,
        shellNodes,
        lastCommandAt: asString(u.lastCommandAt) || null,
      };
    })
    .filter((u): u is MeshUserPresence => u !== null);

  if (adapted.length > 0) return adapted;
  if (!currentUser) return [];
  const shellNodes = Array.from(new Set(auditLog.map((e) => e.node).filter(Boolean)));
  return [
    {
      email: currentUser,
      role: "authorized-member",
      status: "active",
      locations: [
        {
          sessionId: "current",
          location: "Current browser session",
          city: null,
          region: null,
          country: null,
          colo: null,
          viewingView: "overview",
          viewingNode: null,
          lastSeenAt: new Date().toISOString(),
        },
      ],
      shellNodes,
      lastCommandAt: auditLog[0]?.timestamp ?? null,
    },
  ];
}

function adaptShellAuditLog(
  raw: Record<string, unknown> | null | undefined,
  fallbackSessions: SimShellSession[],
  defaultNode: string,
  defaultUser: string,
): ShellAuditEntry[] {
  const list = Array.isArray(asRecord(raw).shell_audit_log)
    ? (asRecord(raw).shell_audit_log as unknown[])
    : [];
  if (list.length > 0) {
    return list.map((entry, idx) => {
      const e = asRecord(entry);
      const cmd = redactSecrets(asString(e.command) || "(interactive shell)");
      const out = redactSecrets(asString(e.output) || "");
      const serverRedactions = asNumber(e.redactedCount) ?? 0;
      return {
        id: asString(e.id) || `audit-${idx}`,
        timestamp: asString(e.timestamp) || new Date().toISOString(),
        user: asString(e.user) || defaultUser,
        node: asString(e.node) || defaultNode,
        sessionName: asString(e.sessionName) || "dialtone/shell/1",
        shell: asString(e.shell) === "powershell" ? "powershell" : "bash",
        cwd: asString(e.cwd) || "~",
        command: cmd.text,
        output: out.text,
        redactedCount: Math.max(
          serverRedactions,
          cmd.redactedCount + out.redactedCount,
        ),
      };
    });
  }
  return fallbackSessions.map((s, idx) => {
    const cmd = redactSecrets(s.lastCommand);
    const out = redactSecrets(s.lastOutput);
    return {
      id: `session-fallback-${idx}-${s.name}`,
      timestamp: new Date().toISOString(),
      user: defaultUser,
      node: defaultNode,
      sessionName: s.name,
      shell: s.shell,
      cwd: s.cwd,
      command: cmd.text,
      output: out.text,
      redactedCount: cmd.redactedCount + out.redactedCount,
    };
  });
}

function adaptBlobStore(
  raw: unknown,
  pinnedPlugins: number,
): SimBlobStoreStats {
  const b = asRecord(raw);
  const objects = asNumber(b.blob_keys) ?? 0;
  const totalBytes = asNumber(b.blob_bytes) ?? 0;
  const fetches = asNumber(b.blob_fetches) ?? 0;
  const programs = asNumber(b.installed_programs) ?? 0;
  return {
    objects,
    totalBytes,
    pinnedPlugins: Math.max(pinnedPlugins, programs),
    peerPulls24h: fetches,
    cacheHitPercent: objects > 0 ? 100 : 0,
    verifiedSha256Percent: 100,
    recentTransfer: `${objects} local iroh-blobs keys (${(totalBytes / 1e6).toFixed(2)} MB), ${programs} staged program(s)`,
  };
}

function adaptRecoveryEvents(
  fullState: Record<string, unknown> | null | undefined,
  probeResp: Record<string, unknown> | null | undefined,
  selfNode: string,
): SimRecoveryEvent[] {
  const events = Array.isArray(asRecord(fullState).events)
    ? (asRecord(fullState).events as unknown[])
    : [];
  const mapped: SimRecoveryEvent[] = events.slice(-8).reverse().map((raw, idx) => {
    const ev = asRecord(raw);
    const ts = asNumber(ev.timestamp_unix);
    const kind = asString(ev.kind) || "mesh.event";
    const severity = asString(ev.severity);
    return {
      id: asString(ev.id) || `live-evt-${idx}`,
      timestamp: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
      host: asString(ev.source) || selfNode || "origin",
      stage:
        severity === "error" || severity === "warn"
          ? "detected"
          : kind.includes("join")
            ? "rejoined"
            : "verified",
      trigger: kind,
      action: asString(ev.message) || "Live mesh event recorded",
      recoveryMs: 0,
      probeAfter: formatProbeSummary(asRecord(asRecord(probeResp).probe)),
    };
  });

  if (mapped.length > 0) return mapped;

  const probe = asRecord(asRecord(probeResp).probe);
  return [
    {
      id: "live-probe-latest",
      timestamp: new Date().toISOString(),
      host: selfNode || "origin",
      stage: "verified",
      trigger: `Live Dialtone probe cycle #${asNumber(probe.cycle) ?? 0}`,
      action: formatProbeSummary(probe),
      recoveryMs: 0,
      probeAfter: formatProbeSummary(probe),
    },
  ];
}

function adaptTests(
  raw: Record<string, unknown> | null | undefined,
): SimTestRun[] {
  const list = Array.isArray(asRecord(raw).tests)
    ? (asRecord(raw).tests as unknown[])
    : [];
  return list.map((entry) => {
    const t = asRecord(entry);
    const name = asString(t.name) || "TestUnknown";
    const statusRaw = asString(t.status);
    const status: SimTestRun["status"] =
      statusRaw === "pass" ||
      statusRaw === "fail" ||
      statusRaw === "running" ||
      statusRaw === "skip"
        ? statusRaw
        : "pass";
    const testId = asString(t["test-id"]);
    return {
      testId,
      name,
      title: asString(t.title) || name,
      status,
      elapsed: asString(t.elapsed) || "0.00",
      timestamp: asString(t.timestamp) || "none",
      completedAt: asString(t.completed_at) || "",
      command: `go run . test --filter "^${name}$"`,
      artifact: testId ? `logs/${testId}.log` : "",
      log: "Select Log ↗ to load immutable execution transcript from the gateway.",
    };
  });
}

function formatProbeSummary(probe: Record<string, unknown>): string {
  const passed = asNumber(probe.passed_count);
  const total = asNumber(probe.total_count);
  const checks = Array.isArray(probe.checks)
    ? (probe.checks as unknown[]).map((c) => {
        const item = asRecord(c);
        const code = asString(item.code);
        const ok = item.ok === true;
        const detail = asString(item.detail);
        return ok ? code : `${code}! (${detail || "fail"})`;
      })
    : [];
  if (passed !== null && total !== null) {
    return `${passed}/${total} PASS (${checks.join(" ")})`;
  }
  return checks.length > 0 ? checks.join(" ") : "probe nominal";
}

function extractRelayLabel(url: string): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname;
    return host.split(".")[0] || host;
  } catch {
    return "";
  }
}

function isPrivateLanIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function classifyPathMode(
  isSelf: boolean,
  observedRaw: unknown,
): "self" | "lan" | "direct" | "relay" | null {
  if (isSelf) return "self";
  if (!Array.isArray(observedRaw)) return null;
  let hasActiveLan = false;
  let hasActiveIp = false;
  let hasActiveRelay = false;
  for (const item of observedRaw) {
    if (typeof item !== "string") continue;
    if (item.startsWith("active:ip:")) {
      hasActiveIp = true;
      const addr = item.slice("active:ip:".length);
      const host = addr.startsWith("[") ? "" : addr.split(":")[0] || "";
      if (isPrivateLanIpv4(host)) hasActiveLan = true;
    } else if (item.startsWith("active:relay:")) {
      hasActiveRelay = true;
    }
  }
  if (hasActiveLan) return "lan";
  if (hasActiveIp) return "direct";
  if (hasActiveRelay) return "relay";
  return null;
}

function computeShortestRttFromOrigin(
  origin: string,
  graph: Map<string, Map<string, number>>,
): Map<string, number> {
  const dist = new Map<string, number>();
  if (!origin) return dist;
  dist.set(origin, 0);
  const visited = new Set<string>();
  while (true) {
    let bestNode: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const [node, d] of dist.entries()) {
      if (!visited.has(node) && d < bestDist) {
        bestDist = d;
        bestNode = node;
      }
    }
    if (bestNode === null) break;
    visited.add(bestNode);
    const edges = graph.get(bestNode);
    if (!edges) continue;
    for (const [neighbor, weight] of edges.entries()) {
      const alt = Math.round((bestDist + weight) * 10) / 10;
      const prev = dist.get(neighbor);
      if (prev === undefined || alt < prev) {
        dist.set(neighbor, alt);
      }
    }
  }
  return dist;
}

function shortenDigest(digest: string): string {
  if (digest.length <= 28) return digest;
  return `${digest.slice(0, 20)}...${digest.slice(-4)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
