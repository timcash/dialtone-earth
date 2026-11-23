import type { NetworkNode, NetworkSnapshot, OverviewNetwork } from "./types";
import { redactSecrets } from "../worker/redact.ts";

export type MeshUserLocation = {
  sessionId: string;
  location: string;
  city: string | null;
  region: string | null;
  country: string | null;
  colo: string | null;
  viewingView: string;
  viewingNode: string | null;
  lastSeenAt: string;
};

export type MeshUserPresence = {
  email: string;
  role: string;
  status: "active" | "idle";
  locations: MeshUserLocation[];
  shellNodes: string[];
  lastCommandAt: string | null;
};

export type ShellAuditEntry = {
  id: string;
  timestamp: string;
  user: string;
  node: string;
  sessionName: string;
  shell: "bash" | "powershell";
  cwd: string;
  command: string;
  output: string;
  redactedCount: number;
};

export type SimPluginDeployment = {
  name: string;
  version: string;
  protocol: string;
  runtime: "builtin-quic" | "stdio-rpc-blob";
  repo: string;
  digest: string;
  sizeBytes: number;
  status: "deployed" | "verifying";
  deployedAt: string;
};

export type SimShellSession = {
  name: string;
  shell: "bash" | "powershell";
  cwd: string;
  status: "active" | "idle";
  interrupts: number;
  lastCommand: string;
  lastOutput: string;
};

export type SimBlobStoreStats = {
  objects: number;
  totalBytes: number;
  pinnedPlugins: number;
  peerPulls24h: number;
  cacheHitPercent: number;
  verifiedSha256Percent: number;
  recentTransfer: string;
};

export type SimRecoveryEvent = {
  id: string;
  timestamp: string;
  host: string;
  stage: "detected" | "restarted" | "rejoined" | "verified";
  trigger: string;
  action: string;
  recoveryMs: number;
  probeAfter: string;
};

export type SimTestRun = {
  testId: string;
  name: string;
  title: string;
  status: "pass" | "fail" | "running" | "skip";
  elapsed: string;
  timestamp: string;
  completedAt: string;
  command: string;
  artifact: string;
  log: string;
};

export type SimHost = NetworkNode & {
  role: string;
  gpuName: string | null;
  gpuLoadPercent: number | null;
  probeSummary: string;
  processes: Array<{
    name: string;
    pid: number;
    digest: string;
    restarts: number;
    status: "running" | "recovered";
  }>;
  plugins: SimPluginDeployment[];
  sessions: SimShellSession[];
  blobStore: SimBlobStoreStats;
};

export type SimNetwork = {
  slug: string;
  name: string;
  hostname: string;
  channelFingerprint: string;
  regionSummary: string;
  simulated: boolean;
  snapshot: NetworkSnapshot;
  hosts: SimHost[];
  plugins: SimPluginDeployment[];
  blobStore: SimBlobStoreStats;
  recoveryEvents: SimRecoveryEvent[];
  tests: SimTestRun[];
  users: MeshUserPresence[];
  shellAuditLog: ShellAuditEntry[];
};

export type MeshNetwork = SimNetwork;
export type MeshHost = SimHost;

export type SystemResourceSummary = {
  networks: number;
  totalNodes: number;
  onlineNodes: number;
  activeUsers: number;
  cpuCores: number;
  avgCpuPercent: number;
  memUsedGb: number;
  memTotalGb: number;
  diskUsedTb: number;
  diskTotalTb: number;
  gpuUsedGb: number;
  gpuTotalGb: number;
  blobObjects: number;
  blobTotalMb: number;
  activePlugins: number;
  activeShellSessions: number;
  recoveryEventsCount: number;
  passingTests: number;
  totalTests: number;
};

export type TourView = "overview" | "network" | "host" | "users" | "tests" | "log";
export type NetworkFocusTab = "hosts" | "plugins" | "blobs" | "recovery";

export type TourStep = {
  id: string;
  label: string;
  view: TourView;
  networkSlug: string | null;
  hostName: string | null;
  networkTab?: NetworkFocusTab;
  testId?: string;
  headline: string;
  caption: string;
};

export const SIMULATED_NETWORKS: SimNetwork[] = [
  buildAtlasNetwork(),
  buildFoundryNetwork(),
  buildOrbitNetwork(),
];

export const SIMULATED_OVERVIEW_NETWORKS: OverviewNetwork[] =
  SIMULATED_NETWORKS.map((net) => ({
    slug: net.slug,
    snapshot: net.snapshot,
  }));

export const SIMULATED_TOUR_STEPS: TourStep[] = [
  {
    id: "system-overview",
    label: "GLOBAL H3 MESH",
    view: "overview",
    networkSlug: null,
    hostName: null,
    headline: "Simulated H3 Geospatial Mesh & Bundled Atmospheric Pings",
    caption:
      "Resolution-3 H3 telemetry clusters and peer-to-peer latency pings curve into the atmosphere and bundle along shared corridors so dense meshes stay legible. Expand the minimized table below to inspect live queries.",
  },
  {
    id: "select-network",
    label: "SELECT NETWORK",
    view: "network",
    networkSlug: "sim-atlas",
    hostName: null,
    networkTab: "hosts",
    headline: "Network Selected: sim-atlas (atlas.dialtone.earth)",
    caption:
      "Focusing sim-atlas shows allowlisted peers over Iroh 1.3 QUIC, direct vs relay RTTs, and continuous 30s probe checks (MSH, NBR, BEAT, STO, PUL, PRC, SEC).",
  },
  {
    id: "select-host",
    label: "SELECT HOST",
    view: "host",
    networkSlug: "sim-atlas",
    hostName: "atlas-gpu-01",
    headline: "Host Selected: atlas-gpu-01 (linux/amd64 · v0.5.5)",
    caption:
      "Drilling into a single host displays live CPU/RAM/Disk/GPU utilization, supervised blob processes, local iroh-blobs digests, and persistent cross-OS QUIC shell sessions (dialtone/shell/1).",
  },
  {
    id: "plugin-deployments",
    label: "PLUGINS & BLOBS",
    view: "network",
    networkSlug: "sim-atlas",
    hostName: null,
    networkTab: "plugins",
    headline: "Blob-Backed Plugin Deployments & Content-Addressed Store",
    caption:
      "Plugins (shell, exec, probe-worker stdio-RPC binaries) ship as SHA-256 verified iroh-blobs tickets. Peers pull verified chunks directly over QUIC with 98.4% local store hit rate.",
  },
  {
    id: "error-recovery",
    label: "ERROR RECOVERY",
    view: "network",
    networkSlug: "sim-atlas",
    hostName: null,
    networkTab: "recovery",
    headline: "Self-Healing Error Recovery (Watchdog + Daemon + Gossip Rejoin)",
    caption:
      "When atlas-edge-02 stalls, the Dialtone watchdog exits with EXIT_RESTART, the OS daemon relaunches, the node rejoins the encrypted channel, re-pulls missing plugin blobs, and probes return to 7/7 PASS in 4.2s.",
  },
  {
    id: "network-users",
    label: "SIGNED-IN USERS",
    view: "users",
    networkSlug: "sim-atlas",
    hostName: null,
    headline: "Signed-In Users, Locations & Redacted dialtone-shell Log",
    caption:
      "Every private network lists its logged-in members, multiple active locations, the node each session is inspecting, and a shared dialtone-shell audit log with keys, tokens, and passwords automatically redacted.",
  },
  {
    id: "network-tests",
    label: "NETWORK TESTS",
    view: "tests",
    networkSlug: "sim-atlas",
    hostName: null,
    headline: "Network Test Suite (timcash/template Run Contract)",
    caption:
      "Each network runs ordered Go tests producing immutable logs/<test-id>.json and .log records—covering mesh gossip, blob pulls, stdio-RPC plugin deploys, QUIC shells, error recovery, and Cloudflare Access denial.",
  },
  {
    id: "test-log-page",
    label: "EXECUTION LOG",
    view: "log",
    networkSlug: "sim-atlas",
    hostName: null,
    testId: "e4a10f92c81b44d09f33a7c1182be405",
    headline: "Immutable Test Execution Log (TestStuckNodeErrorRecovery)",
    caption:
      "Clicking Log opens a dedicated per-execution page with the 32-hex test-id, exact rerun command, wall-clock duration, and structured RFC3339 transcript. Sign in via Cloudflare Access to inspect live private networks.",
  },
];

export function summarizeSystemResources(
  networks: SimNetwork[],
): SystemResourceSummary {
  let totalNodes = 0;
  let onlineNodes = 0;
  let activeUsers = 0;
  let cpuCores = 0;
  let cpuPercentSum = 0;
  let cpuPercentCount = 0;
  let memUsedBytes = 0;
  let memTotalBytes = 0;
  let diskUsedBytes = 0;
  let diskTotalBytes = 0;
  let gpuUsedBytes = 0;
  let gpuTotalBytes = 0;
  let blobObjects = 0;
  let blobTotalBytes = 0;
  let activePlugins = 0;
  let activeShellSessions = 0;
  let recoveryEventsCount = 0;
  let passingTests = 0;
  let totalTests = 0;

  for (const net of networks) {
    activeUsers += net.users.length;
    blobObjects += net.blobStore.objects;
    blobTotalBytes += net.blobStore.totalBytes;
    activePlugins += net.plugins.length;
    recoveryEventsCount += net.recoveryEvents.length;
    totalTests += net.tests.length;
    passingTests += net.tests.filter((t) => t.status === "pass").length;

    for (const host of net.hosts) {
      totalNodes += 1;
      if (host.online) onlineNodes += 1;
      activeShellSessions += host.sessions.length;
      const s = host.stats;
      if (s.cpu_cores !== null) cpuCores += s.cpu_cores;
      if (s.cpu_percent !== null) {
        cpuPercentSum += s.cpu_percent;
        cpuPercentCount += 1;
      }
      if (s.mem_used_bytes !== null) memUsedBytes += s.mem_used_bytes;
      if (s.mem_total_bytes !== null) memTotalBytes += s.mem_total_bytes;
      if (s.disk_used_bytes !== null) diskUsedBytes += s.disk_used_bytes;
      if (s.disk_total_bytes !== null) diskTotalBytes += s.disk_total_bytes;
      if (s.gpu_mem_used_bytes !== null) gpuUsedBytes += s.gpu_mem_used_bytes;
      if (s.gpu_mem_total_bytes !== null) gpuTotalBytes += s.gpu_mem_total_bytes;
    }
  }

  return {
    networks: networks.length,
    totalNodes,
    onlineNodes,
    activeUsers,
    cpuCores,
    avgCpuPercent:
      cpuPercentCount > 0
        ? Math.round((cpuPercentSum / cpuPercentCount) * 10) / 10
        : 0,
    memUsedGb: Math.round((memUsedBytes / 1e9) * 10) / 10,
    memTotalGb: Math.round((memTotalBytes / 1e9) * 10) / 10,
    diskUsedTb: Math.round((diskUsedBytes / 1e12) * 100) / 100,
    diskTotalTb: Math.round((diskTotalBytes / 1e12) * 100) / 100,
    gpuUsedGb: Math.round((gpuUsedBytes / 1e9) * 10) / 10,
    gpuTotalGb: Math.round((gpuTotalBytes / 1e9) * 10) / 10,
    blobObjects,
    blobTotalMb: Math.round((blobTotalBytes / 1e6) * 10) / 10,
    activePlugins,
    activeShellSessions,
    recoveryEventsCount,
    passingTests,
    totalTests,
  };
}

export function findSimulatedNetwork(slug: string | null): SimNetwork {
  return (
    SIMULATED_NETWORKS.find((n) => n.slug === slug) ?? SIMULATED_NETWORKS[0]
  );
}

export function findSimulatedHost(
  net: SimNetwork,
  hostName: string | null,
): SimHost {
  return net.hosts.find((h) => h.name === hostName) ?? net.hosts[0];
}

export function findSimulatedTest(
  net: SimNetwork,
  testId: string | null,
): SimTestRun {
  return net.tests.find((t) => t.testId === testId) ?? net.tests[0];
}

function buildAtlasNetwork(): SimNetwork {
  const plugins: SimPluginDeployment[] = [
    {
      name: "shell",
      version: "v0.5.5",
      protocol: "dialtone/shell/1",
      runtime: "builtin-quic",
      repo: "timcash/dialtone",
      digest: "sha256:9f24c8a1e7b043d2c619...8a4e",
      sizeBytes: 14_820_416,
      status: "deployed",
      deployedAt: "2026-11-22T22:10:00Z",
    },
    {
      name: "exec",
      version: "v0.5.5",
      protocol: "dialtone/exec/1",
      runtime: "builtin-quic",
      repo: "timcash/dialtone",
      digest: "sha256:4c18d7e5a09f2b14e83a...2d91",
      sizeBytes: 11_204_608,
      status: "deployed",
      deployedAt: "2026-11-22T22:10:04Z",
    },
    {
      name: "probe-worker",
      version: "v0.5.5",
      protocol: "stdio-rpc/v1",
      runtime: "stdio-rpc-blob",
      repo: "timcash/dialtone-probe",
      digest: "sha256:7a83f01b3d4e920c51fa...c703",
      sizeBytes: 6_418_944,
      status: "deployed",
      deployedAt: "2026-11-22T22:12:18Z",
    },
  ];

  const hosts: SimHost[] = [
    {
      name: "atlas-gpu-01",
      role: "Primary Compute & Gateway Origin",
      os: "linux",
      arch: "amd64",
      version: "0.5.5",
      relay_region: "us-west-sim",
      lat: 37,
      lng: -122,
      heard: 1763850000,
      online: true,
      rtt_ms: 4.2,
      gpuName: "Simulated Tensor 24GB",
      gpuLoadPercent: 64,
      probeSummary: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC)",
      stats: {
        cpu_cores: 32,
        cpu_percent: 48.2,
        mem_percent: 58.6,
        mem_total_bytes: 68_000_000_000,
        mem_used_bytes: 39_848_000_000,
        disk_percent: 44.0,
        disk_total_bytes: 2_000_000_000_000,
        disk_used_bytes: 880_000_000_000,
        gpu_mem_total_bytes: 24_000_000_000,
        gpu_mem_used_bytes: 15_360_000_000,
        load_avg_1m: 2.14,
      },
      processes: [
        {
          name: "probe-worker",
          pid: 4182,
          digest: "7a83f01b3d4e",
          restarts: 0,
          status: "running",
        },
        {
          name: "cf-tunnel-origin",
          pid: 4209,
          digest: "1b9c8e4f02a7",
          restarts: 0,
          status: "running",
        },
      ],
      plugins,
      sessions: [
        {
          name: "ci-runner",
          shell: "bash",
          cwd: "/srv/dialtone/sim-atlas",
          status: "active",
          interrupts: 1,
          lastCommand: "dialtone probe --all",
          lastOutput:
            "MSH=ok NBR=3 BEAT=ok STO=ok(1.4ms) PUL=ok(18.2MB/s) PRC=ok SEC=ok",
        },
      ],
      blobStore: {
        objects: 84,
        totalBytes: 412_800_000,
        pinnedPlugins: 3,
        peerPulls24h: 196,
        cacheHitPercent: 98.4,
        verifiedSha256Percent: 100,
        recentTransfer: "pulled probe-worker (6.4 MB) in 142ms via direct QUIC",
      },
    },
    {
      name: "atlas-edge-02",
      role: "Auto-Recovered Edge Node",
      os: "windows",
      arch: "amd64",
      version: "0.5.5",
      relay_region: "us-east-sim",
      lat: 40,
      lng: -74,
      heard: 1763850000,
      online: true,
      rtt_ms: 21.8,
      gpuName: "Simulated Edge 12GB",
      gpuLoadPercent: 31,
      probeSummary: "7/7 PASS (recovered 4.2s after EXIT_RESTART)",
      stats: {
        cpu_cores: 16,
        cpu_percent: 34.5,
        mem_percent: 46.1,
        mem_total_bytes: 32_000_000_000,
        mem_used_bytes: 14_752_000_000,
        disk_percent: 51.2,
        disk_total_bytes: 1_000_000_000_000,
        disk_used_bytes: 512_000_000_000,
        gpu_mem_total_bytes: 12_000_000_000,
        gpu_mem_used_bytes: 3_720_000_000,
        load_avg_1m: 1.05,
      },
      processes: [
        {
          name: "probe-worker",
          pid: 9012,
          digest: "7a83f01b3d4e",
          restarts: 1,
          status: "recovered",
        },
      ],
      plugins,
      sessions: [
        {
          name: "win-qa",
          shell: "powershell",
          cwd: "C:\\dialtone\\sim-atlas",
          status: "active",
          interrupts: 0,
          lastCommand: ".\\dialtone-earth.ps1 test --filter TestAuth",
          lastOutput: "PASS TestAuthStatusIsExplicitlyUnconfigured (0.00s)",
        },
      ],
      blobStore: {
        objects: 62,
        totalBytes: 286_400_000,
        pinnedPlugins: 3,
        peerPulls24h: 118,
        cacheHitPercent: 97.1,
        verifiedSha256Percent: 100,
        recentTransfer: "re-verified shell plugin blob after daemon restart",
      },
    },
    {
      name: "atlas-relay-03",
      role: "EU Observer & Blob Mirror",
      os: "linux",
      arch: "arm64",
      version: "0.5.5",
      relay_region: "eu-central-sim",
      lat: 50,
      lng: 8,
      heard: 1763850000,
      online: true,
      rtt_ms: 88.4,
      gpuName: null,
      gpuLoadPercent: null,
      probeSummary: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC)",
      stats: {
        cpu_cores: 8,
        cpu_percent: 14.0,
        mem_percent: 29.5,
        mem_total_bytes: 16_000_000_000,
        mem_used_bytes: 4_720_000_000,
        disk_percent: 33.0,
        disk_total_bytes: 500_000_000_000,
        disk_used_bytes: 165_000_000_000,
        gpu_mem_total_bytes: null,
        gpu_mem_used_bytes: null,
        load_avg_1m: 0.42,
      },
      processes: [
        {
          name: "probe-worker",
          pid: 1844,
          digest: "7a83f01b3d4e",
          restarts: 0,
          status: "running",
        },
      ],
      plugins,
      sessions: [
        {
          name: "mirror-sync",
          shell: "bash",
          cwd: "/var/lib/dialtone/blobs",
          status: "idle",
          interrupts: 0,
          lastCommand: "dialtone plugin list",
          lastOutput: "shell v0.5.5 | exec v0.5.5 | probe-worker v0.5.5",
        },
      ],
      blobStore: {
        objects: 84,
        totalBytes: 412_800_000,
        pinnedPlugins: 3,
        peerPulls24h: 241,
        cacheHitPercent: 99.2,
        verifiedSha256Percent: 100,
        recentTransfer: "seeded 3 plugin blobs to atlas-edge-02 (0 mismatches)",
      },
    },
  ];

  const recoveryEvents: SimRecoveryEvent[] = [
    {
      id: "rec-01",
      timestamp: "2026-11-22T22:14:02Z",
      host: "atlas-edge-02",
      stage: "detected",
      trigger: "Stuck gossip heartbeat missed 2 intervals (MSH=fail)",
      action: "Watchdog emitted EXIT_RESTART and notified channel audit log",
      recoveryMs: 620,
      probeAfter: "MSH=fail NBR=0 BEAT=stale",
    },
    {
      id: "rec-02",
      timestamp: "2026-11-22T22:14:03Z",
      host: "atlas-edge-02",
      stage: "restarted",
      trigger: "OS Scheduled Task daemon supervised relaunch",
      action: "Booted dialtone v0.5.5, unlocked local iroh-blobs store",
      recoveryMs: 1_480,
      probeAfter: "STO=ok PRC=starting",
    },
    {
      id: "rec-03",
      timestamp: "2026-11-22T22:14:05Z",
      host: "atlas-edge-02",
      stage: "rejoined",
      trigger: "Ed25519 allowlist handshake with atlas-gpu-01 & atlas-relay-03",
      action: "Pulled verified probe-worker blob (sha256:7a83f01b...) via QUIC",
      recoveryMs: 1_310,
      probeAfter: "MSH=ok NBR=2 PUL=ok",
    },
    {
      id: "rec-04",
      timestamp: "2026-11-22T22:14:06Z",
      host: "atlas-edge-02",
      stage: "verified",
      trigger: "Full post-recovery probe (--all) + Cloudflare origin health check",
      action: "Restored node to active pool; zero dropped test runs",
      recoveryMs: 790,
      probeAfter: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC)",
    },
  ];

  const tests: SimTestRun[] = [
    {
      testId: "a19c4d72e0184b9e9310f8a224d10101",
      name: "TestMeshMembershipAndGossip",
      title: "Mesh Membership And Gossip",
      status: "pass",
      elapsed: "0.42",
      timestamp: "2026-11-22T22:15:01Z",
      completedAt: "2026-11-22T22:15:01Z",
      command: 'go run . test --filter "^TestMeshMembershipAndGossip$"',
      artifact: "logs/a19c4d72e0184b9e9310f8a224d10101.log",
      log: [
        "2026-11-22T22:15:01Z INFO [SIMULATED] TestMeshMembershipAndGossip start channel=sim-atlas",
        "2026-11-22T22:15:01Z INFO [SIMULATED] peers=3/3 allowlisted (atlas-gpu-01, atlas-edge-02, atlas-relay-03)",
        "2026-11-22T22:15:01Z INFO [SIMULATED] MSH=ok NBR=ok BEAT=ok median_rtt=21.8ms",
        "--- PASS: TestMeshMembershipAndGossip (0.42s)",
      ].join("\n"),
    },
    {
      testId: "b20d5e83f1295c0fa421e9b335e20202",
      name: "TestBlobStoreRoundTripAndPull",
      title: "Blob Store Round Trip And Pull",
      status: "pass",
      elapsed: "0.68",
      timestamp: "2026-11-22T22:15:02Z",
      completedAt: "2026-11-22T22:15:03Z",
      command: 'go run . test --filter "^TestBlobStoreRoundTripAndPull$"',
      artifact: "logs/b20d5e83f1295c0fa421e9b335e20202.log",
      log: [
        "2026-11-22T22:15:02Z INFO [SIMULATED] iroh-blobs put 6418944 bytes -> sha256:7a83f01b3d4e920c",
        "2026-11-22T22:15:02Z INFO [SIMULATED] atlas-edge-02 pulled ticket from atlas-relay-03 via direct QUIC (142ms)",
        "2026-11-22T22:15:03Z INFO [SIMULATED] SHA-256 digest verified; STO=ok PUL=ok",
        "--- PASS: TestBlobStoreRoundTripAndPull (0.68s)",
      ].join("\n"),
    },
    {
      testId: "c31e6f94a2306d10b532fac446f30303",
      name: "TestPluginStdioRpcDeploy",
      title: "Plugin Stdio Rpc Deploy",
      status: "pass",
      elapsed: "0.91",
      timestamp: "2026-11-22T22:15:03Z",
      completedAt: "2026-11-22T22:15:04Z",
      command: 'go run . test --filter "^TestPluginStdioRpcDeploy$"',
      artifact: "logs/c31e6f94a2306d10b532fac446f30303.log",
      log: [
        "2026-11-22T22:15:03Z INFO [SIMULATED] dialtone install probe-worker --repo timcash/dialtone-probe",
        "2026-11-22T22:15:04Z INFO [SIMULATED] staged blob binary pid=4182 stdio-rpc handshake ok",
        "2026-11-22T22:15:04Z INFO [SIMULATED] PRC=ok deployed across 3/3 hosts",
        "--- PASS: TestPluginStdioRpcDeploy (0.91s)",
      ].join("\n"),
    },
    {
      testId: "d42f70a5b3417e21c6430bd557040404",
      name: "TestCrossOsQuicShellSession",
      title: "Cross Os Quic Shell Session",
      status: "pass",
      elapsed: "0.74",
      timestamp: "2026-11-22T22:15:04Z",
      completedAt: "2026-11-22T22:15:05Z",
      command: 'go run . test --filter "^TestCrossOsQuicShellSession$"',
      artifact: "logs/d42f70a5b3417e21c6430bd557040404.log",
      log: [
        "2026-11-22T22:15:04Z INFO [SIMULATED] dialtone/shell/1 new ci-runner (bash on linux) & win-qa (powershell on windows)",
        "2026-11-22T22:15:05Z INFO [SIMULATED] verified cwd persistence, clean stderr capture, interrupt recovery, and kill cleanup",
        "--- PASS: TestCrossOsQuicShellSession (0.74s)",
      ].join("\n"),
    },
    {
      testId: "e4a10f92c81b44d09f33a7c1182be405",
      name: "TestStuckNodeErrorRecovery",
      title: "Stuck Node Error Recovery",
      status: "pass",
      elapsed: "4.20",
      timestamp: "2026-11-22T22:15:05Z",
      completedAt: "2026-11-22T22:15:09Z",
      command: 'go run . test --filter "^TestStuckNodeErrorRecovery$"',
      artifact: "logs/e4a10f92c81b44d09f33a7c1182be405.log",
      log: [
        "2026-11-22T22:15:05Z WARN [SIMULATED] injected heartbeat stall on atlas-edge-02 (MSH=fail)",
        "2026-11-22T22:15:06Z INFO [SIMULATED] watchdog triggered EXIT_RESTART; OS daemon relaunched dialtone v0.5.5 (1.48s)",
        "2026-11-22T22:15:07Z INFO [SIMULATED] allowlist handshake accepted by atlas-gpu-01 & atlas-relay-03",
        "2026-11-22T22:15:08Z INFO [SIMULATED] re-pulled blob sha256:7a83f01b3d4e920c (verified=true, 0 corrupted chunks)",
        "2026-11-22T22:15:09Z INFO [SIMULATED] post-recovery probe: MSH=ok NBR=2 BEAT=ok STO=ok PUL=ok PRC=ok SEC=ok (total=4.20s)",
        "--- PASS: TestStuckNodeErrorRecovery (4.20s)",
      ].join("\n"),
    },
    {
      testId: "f53081b6c4528f32d7541ce668150606",
      name: "TestCloudflareAccessGatewayDeny",
      title: "Cloudflare Access Gateway Deny",
      status: "pass",
      elapsed: "0.19",
      timestamp: "2026-11-22T22:15:10Z",
      completedAt: "2026-11-22T22:15:10Z",
      command: 'go run . test --filter "^TestCloudflareAccessGatewayDeny$"',
      artifact: "logs/f53081b6c4528f32d7541ce668150606.log",
      log: [
        "2026-11-22T22:15:10Z INFO [SIMULATED] unauthenticated GET /api/mesh/state -> 401 (0 origin fetches)",
        "2026-11-22T22:15:10Z INFO [SIMULATED] wrong-audience JWT for atlas.dialtone.earth -> 401 (0 origin fetches)",
        "2026-11-22T22:15:10Z INFO [SIMULATED] valid Access JWT for exact hostname -> 200 Cache-Control: private, no-store",
        "--- PASS: TestCloudflareAccessGatewayDeny (0.19s)",
      ].join("\n"),
    },
    {
      testId: "064192c7d5639043e8652df779260707",
      name: "TestSystemWideResourceTelemetry",
      title: "System Wide Resource Telemetry",
      status: "pass",
      elapsed: "0.26",
      timestamp: "2026-11-22T22:15:10Z",
      completedAt: "2026-11-22T22:15:11Z",
      command: 'go run . test --filter "^TestSystemWideResourceTelemetry$"',
      artifact: "logs/064192c7d5639043e8652df779260707.log",
      log: [
        "2026-11-22T22:15:10Z INFO [SIMULATED] aggregated 3 hosts: 56 cores, 59.3/116.0 GB RAM, 1.56/3.50 TB Disk, 19.1/36.0 GB GPU VRAM",
        "2026-11-22T22:15:11Z INFO [SIMULATED] missing GPU sensor on atlas-relay-03 preserved as null (distinct from 0)",
        "--- PASS: TestSystemWideResourceTelemetry (0.26s)",
      ].join("\n"),
    },
  ];

  return {
    slug: "sim-atlas",
    name: "sim-atlas",
    hostname: "atlas.dialtone.earth",
    channelFingerprint: "ch-sim-atlas-9f24",
    regionSummary: "US-West · US-East · EU-Central",
    simulated: true,
    snapshot: {
      network: "sim-atlas",
      generated_at: "2026-11-22T22:15:11Z",
      latest_release: "0.5.5",
      node_count: hosts.length,
      nodes: hosts,
    },
    hosts,
    plugins,
    blobStore: {
      objects: 230,
      totalBytes: 1_112_000_000,
      pinnedPlugins: 9,
      peerPulls24h: 555,
      cacheHitPercent: 98.4,
      verifiedSha256Percent: 100,
      recentTransfer: "atlas-edge-02 <- atlas-relay-03 (6.4 MB, 142ms)",
    },
    recoveryEvents,
    tests,
    users: [
      {
        email: "maya@sim-atlas.example",
        role: "mesh-operator",
        status: "active",
        locations: [
          {
            sessionId: "sim-a1",
            location: "Seattle, WA, US (SEA)",
            city: "Seattle",
            region: "WA",
            country: "US",
            colo: "SEA",
            viewingView: "host",
            viewingNode: "atlas-gpu-01",
            lastSeenAt: "2026-11-22T22:14:52Z",
          },
          {
            sessionId: "sim-a2",
            location: "Frankfurt, DE (FRA)",
            city: "Frankfurt",
            region: "HE",
            country: "DE",
            colo: "FRA",
            viewingView: "host",
            viewingNode: "atlas-edge-02",
            lastSeenAt: "2026-11-22T22:13:18Z",
          },
        ],
        shellNodes: ["atlas-gpu-01", "atlas-edge-02"],
        lastCommandAt: "2026-11-22T22:14:40Z",
      },
      {
        email: "devon@sim-atlas.example",
        role: "authorized-member",
        status: "active",
        locations: [
          {
            sessionId: "sim-a3",
            location: "Tokyo, JP (NRT)",
            city: "Tokyo",
            region: "13",
            country: "JP",
            colo: "NRT",
            viewingView: "users",
            viewingNode: "atlas-relay-03",
            lastSeenAt: "2026-11-22T22:12:09Z",
          },
        ],
        shellNodes: ["atlas-relay-03"],
        lastCommandAt: "2026-11-22T22:11:44Z",
      },
    ],
    shellAuditLog: [
      makeRedactedAuditEntry({
        id: "sim-sh-a1",
        timestamp: "2026-11-22T22:14:40Z",
        user: "maya@sim-atlas.example",
        node: "atlas-gpu-01",
        sessionName: "gpu-deploy",
        shell: "bash",
        cwd: "/srv/dialtone/plugins",
        rawCommand:
          'curl -s -H "Authorization: Bearer sim_demo_bearer_9a8f7e6d5c4b" https://127.0.0.1:8788/api/plugins | jq .count',
        rawOutput: "3 verified plugins loaded; SHA-256 checksums match",
      }),
      makeRedactedAuditEntry({
        id: "sim-sh-a2",
        timestamp: "2026-11-22T22:13:05Z",
        user: "maya@sim-atlas.example",
        node: "atlas-edge-02",
        sessionName: "edge-check",
        shell: "bash",
        cwd: "/srv/dialtone",
        rawCommand:
          "dialtone shell exec --token sim_edge_tok_1122334455 --node atlas-edge-02 -- probe status",
        rawOutput: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC) · MESH_ORIGIN_TOKEN=sim_origin_hex_00ff11ee22dd",
      }),
      makeRedactedAuditEntry({
        id: "sim-sh-a3",
        timestamp: "2026-11-22T22:11:44Z",
        user: "devon@sim-atlas.example",
        node: "atlas-relay-03",
        sessionName: "relay-ops",
        shell: "bash",
        cwd: "/var/lib/dialtone",
        rawCommand: "dialtone mesh peers --verify-blobs",
        rawOutput: "3/3 peers online · 230 blobs verified (100% SHA-256)",
      }),
    ],
  };
}

function buildFoundryNetwork(): SimNetwork {
  const plugins: SimPluginDeployment[] = [
    {
      name: "shell",
      version: "v0.5.5",
      protocol: "dialtone/shell/1",
      runtime: "builtin-quic",
      repo: "timcash/dialtone",
      digest: "sha256:9f24c8a1e7b043d2c619...8a4e",
      sizeBytes: 14_820_416,
      status: "deployed",
      deployedAt: "2026-11-22T21:40:00Z",
    },
    {
      name: "cad-builder",
      version: "v0.5.5",
      protocol: "stdio-rpc/v1",
      runtime: "stdio-rpc-blob",
      repo: "timcash/dialtone-cad",
      digest: "sha256:5e90ab1283cf4170d8a2...91b4",
      sizeBytes: 18_940_000,
      status: "deployed",
      deployedAt: "2026-11-22T21:45:12Z",
    },
  ];

  const hosts: SimHost[] = [
    {
      name: "foundry-arm-01",
      role: "macOS ARM64 Build Node",
      os: "darwin",
      arch: "arm64",
      version: "0.5.5",
      relay_region: "us-west-sim",
      lat: 34,
      lng: -118,
      heard: 1763850000,
      online: true,
      rtt_ms: 9.6,
      gpuName: "Simulated Unified 32GB",
      gpuLoadPercent: 42,
      probeSummary: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC)",
      stats: {
        cpu_cores: 14,
        cpu_percent: 41.0,
        mem_percent: 52.0,
        mem_total_bytes: 36_000_000_000,
        mem_used_bytes: 18_720_000_000,
        disk_percent: 38.0,
        disk_total_bytes: 1_000_000_000_000,
        disk_used_bytes: 380_000_000_000,
        gpu_mem_total_bytes: 32_000_000_000,
        gpu_mem_used_bytes: 13_440_000_000,
        load_avg_1m: 1.62,
      },
      processes: [
        {
          name: "cad-builder",
          pid: 3108,
          digest: "5e90ab1283cf",
          restarts: 0,
          status: "running",
        },
      ],
      plugins,
      sessions: [
        {
          name: "arm-build",
          shell: "bash",
          cwd: "/Users/sim/foundry",
          status: "active",
          interrupts: 0,
          lastCommand: "./dialtone.sh test --here --only lint",
          lastOutput: "lint: zero-leak ok, domain language ok, clippy ok",
        },
      ],
      blobStore: {
        objects: 58,
        totalBytes: 340_000_000,
        pinnedPlugins: 2,
        peerPulls24h: 92,
        cacheHitPercent: 96.8,
        verifiedSha256Percent: 100,
        recentTransfer: "shared cad-builder artifact (18.9 MB)",
      },
    },
    {
      name: "foundry-x86-02",
      role: "Linux CI & Release Signer",
      os: "linux",
      arch: "amd64",
      version: "0.5.5",
      relay_region: "us-central-sim",
      lat: 33,
      lng: -97,
      heard: 1763850000,
      online: true,
      rtt_ms: 19.4,
      gpuName: null,
      gpuLoadPercent: null,
      probeSummary: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC)",
      stats: {
        cpu_cores: 24,
        cpu_percent: 61.5,
        mem_percent: 64.0,
        mem_total_bytes: 64_000_000_000,
        mem_used_bytes: 40_960_000_000,
        disk_percent: 49.0,
        disk_total_bytes: 2_000_000_000_000,
        disk_used_bytes: 980_000_000_000,
        gpu_mem_total_bytes: null,
        gpu_mem_used_bytes: null,
        load_avg_1m: 3.12,
      },
      processes: [
        {
          name: "cad-builder",
          pid: 5810,
          digest: "5e90ab1283cf",
          restarts: 0,
          status: "running",
        },
      ],
      plugins,
      sessions: [
        {
          name: "release-pkg",
          shell: "bash",
          cwd: "/srv/foundry/releases",
          status: "idle",
          interrupts: 0,
          lastCommand: "sha256sum dialtone-linux-amd64",
          lastOutput: "verified 4 release targets",
        },
      ],
      blobStore: {
        objects: 74,
        totalBytes: 495_000_000,
        pinnedPlugins: 2,
        peerPulls24h: 134,
        cacheHitPercent: 97.9,
        verifiedSha256Percent: 100,
        recentTransfer: "replicated cad-builder blob from foundry-arm-01",
      },
    },
    {
      name: "foundry-lab-03",
      role: "Hardware Bench Controller",
      os: "linux",
      arch: "arm64",
      version: "0.5.5",
      relay_region: "ap-east-sim",
      lat: 35,
      lng: 139,
      heard: 1763850000,
      online: true,
      rtt_ms: 112.0,
      gpuName: "Simulated Jetson 16GB",
      gpuLoadPercent: 28,
      probeSummary: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC)",
      stats: {
        cpu_cores: 8,
        cpu_percent: 22.0,
        mem_percent: 38.0,
        mem_total_bytes: 16_000_000_000,
        mem_used_bytes: 6_080_000_000,
        disk_percent: 29.0,
        disk_total_bytes: 500_000_000_000,
        disk_used_bytes: 145_000_000_000,
        gpu_mem_total_bytes: 16_000_000_000,
        gpu_mem_used_bytes: 4_480_000_000,
        load_avg_1m: 0.78,
      },
      processes: [
        {
          name: "bench-telemetry",
          pid: 2201,
          digest: "8c44e91a002b",
          restarts: 0,
          status: "running",
        },
      ],
      plugins,
      sessions: [],
      blobStore: {
        objects: 41,
        totalBytes: 192_000_000,
        pinnedPlugins: 2,
        peerPulls24h: 64,
        cacheHitPercent: 95.5,
        verifiedSha256Percent: 100,
        recentTransfer: "pulled shell plugin over relay fallback (180ms)",
      },
    },
  ];

  return {
    slug: "sim-foundry",
    name: "sim-foundry",
    hostname: "foundry.dialtone.earth",
    channelFingerprint: "ch-sim-foundry-5e90",
    regionSummary: "US-West · US-Central · Tokyo",
    simulated: true,
    snapshot: {
      network: "sim-foundry",
      generated_at: "2026-11-22T22:15:11Z",
      latest_release: "0.5.5",
      node_count: hosts.length,
      nodes: hosts,
    },
    hosts,
    plugins,
    blobStore: {
      objects: 173,
      totalBytes: 1_027_000_000,
      pinnedPlugins: 6,
      peerPulls24h: 290,
      cacheHitPercent: 97.2,
      verifiedSha256Percent: 100,
      recentTransfer: "foundry-x86-02 <- foundry-arm-01 (18.9 MB)",
    },
    recoveryEvents: [
      {
        id: "rec-f1",
        timestamp: "2026-11-22T21:58:10Z",
        host: "foundry-lab-03",
        stage: "verified",
        trigger: "Direct UDP NAT rebind changed external port",
        action: "Iroh relay kept QUIC session live and re-established direct path",
        recoveryMs: 840,
        probeAfter: "7/7 PASS (zero session drops)",
      },
    ],
    tests: [
      {
        testId: "1752a3d8e674a154f9763e088a370808",
        name: "TestFoundryCrossArchBuildAndSign",
        title: "Foundry Cross Arch Build And Sign",
        status: "pass",
        elapsed: "1.84",
        timestamp: "2026-11-22T22:12:00Z",
        completedAt: "2026-11-22T22:12:02Z",
        command: 'go run . test --filter "^TestFoundryCrossArchBuildAndSign$"',
        artifact: "logs/1752a3d8e674a154f9763e088a370808.log",
        log: [
          "2026-11-22T22:12:00Z INFO [SIMULATED] cross-arch release verification (darwin/arm64, linux/amd64, linux/arm64)",
          "2026-11-22T22:12:02Z INFO [SIMULATED] SHA-256 checksums verified; blob tickets published",
          "--- PASS: TestFoundryCrossArchBuildAndSign (1.84s)",
        ].join("\n"),
      },
      {
        testId: "2863b4e9f785b2650a874f199b480909",
        name: "TestRelayFailoverToDirectQuic",
        title: "Relay Failover To Direct Quic",
        status: "pass",
        elapsed: "0.84",
        timestamp: "2026-11-22T22:12:03Z",
        completedAt: "2026-11-22T22:12:04Z",
        command: 'go run . test --filter "^TestRelayFailoverToDirectQuic$"',
        artifact: "logs/2863b4e9f785b2650a874f199b480909.log",
        log: [
          "2026-11-22T22:12:03Z INFO [SIMULATED] foundry-lab-03 switched relay -> direct QUIC in 840ms",
          "--- PASS: TestRelayFailoverToDirectQuic (0.84s)",
        ].join("\n"),
      },
    ],
    users: [
      {
        email: "lin@sim-foundry.example",
        role: "build-engineer",
        status: "active",
        locations: [
          {
            sessionId: "sim-f1",
            location: "Los Angeles, CA, US (LAX)",
            city: "Los Angeles",
            region: "CA",
            country: "US",
            colo: "LAX",
            viewingView: "host",
            viewingNode: "foundry-arm-01",
            lastSeenAt: "2026-11-22T22:14:11Z",
          },
        ],
        shellNodes: ["foundry-arm-01"],
        lastCommandAt: "2026-11-22T22:13:50Z",
      },
    ],
    shellAuditLog: [
      makeRedactedAuditEntry({
        id: "sim-sh-f1",
        timestamp: "2026-11-22T22:13:50Z",
        user: "lin@sim-foundry.example",
        node: "foundry-arm-01",
        sessionName: "release-sign",
        shell: "bash",
        cwd: "~/dialtone-cad",
        rawCommand:
          "SIGNING_KEY=sim_release_signing_secret_778899 ./dialtone.sh build --release",
        rawOutput: "darwin/arm64 + linux/amd64 artifacts signed and pinned to iroh-blobs",
      }),
    ],
  };
}

function buildOrbitNetwork(): SimNetwork {
  const plugins: SimPluginDeployment[] = [
    {
      name: "shell",
      version: "v0.5.5",
      protocol: "dialtone/shell/1",
      runtime: "builtin-quic",
      repo: "timcash/dialtone",
      digest: "sha256:9f24c8a1e7b043d2c619...8a4e",
      sizeBytes: 14_820_416,
      status: "deployed",
      deployedAt: "2026-11-22T20:30:00Z",
    },
    {
      name: "cf-gateway-origin",
      version: "v0.5.5",
      protocol: "stdio-rpc/v1",
      runtime: "stdio-rpc-blob",
      repo: "timcash/dialtone-earth",
      digest: "sha256:1b9c8e4f02a765d1e409...3e12",
      sizeBytes: 9_650_176,
      status: "deployed",
      deployedAt: "2026-11-22T20:32:44Z",
    },
  ];

  const hosts: SimHost[] = [
    {
      name: "orbit-gw-01",
      role: "Active Cloudflare Tunnel Origin",
      os: "linux",
      arch: "amd64",
      version: "0.5.5",
      relay_region: "eu-west-sim",
      lat: 51,
      lng: 0,
      heard: 1763850000,
      online: true,
      rtt_ms: 14.1,
      gpuName: null,
      gpuLoadPercent: null,
      probeSummary: "7/7 PASS (MSH NBR BEAT STO PUL PRC SEC)",
      stats: {
        cpu_cores: 8,
        cpu_percent: 18.4,
        mem_percent: 31.2,
        mem_total_bytes: 16_000_000_000,
        mem_used_bytes: 4_992_000_000,
        disk_percent: 24.0,
        disk_total_bytes: 500_000_000_000,
        disk_used_bytes: 120_000_000_000,
        gpu_mem_total_bytes: null,
        gpu_mem_used_bytes: null,
        load_avg_1m: 0.35,
      },
      processes: [
        {
          name: "cf-gateway-origin",
          pid: 1402,
          digest: "1b9c8e4f02a7",
          restarts: 0,
          status: "running",
        },
      ],
      plugins,
      sessions: [
        {
          name: "gw-watch",
          shell: "bash",
          cwd: "/srv/orbit",
          status: "active",
          interrupts: 0,
          lastCommand: "dialtone link list",
          lastOutput: "2 direct QUIC links active (0 packet loss)",
        },
      ],
      blobStore: {
        objects: 49,
        totalBytes: 218_500_000,
        pinnedPlugins: 2,
        peerPulls24h: 81,
        cacheHitPercent: 99.1,
        verifiedSha256Percent: 100,
        recentTransfer: "served cf-gateway-origin blob to orbit-gw-02",
      },
    },
    {
      name: "orbit-gw-02",
      role: "Standby Failover Origin",
      os: "linux",
      arch: "amd64",
      version: "0.5.5",
      relay_region: "ap-south-sim",
      lat: 1,
      lng: 104,
      heard: 1763850000,
      online: true,
      rtt_ms: 138.2,
      gpuName: null,
      gpuLoadPercent: null,
      probeSummary: "7/7 PASS (failover hot-standby verified)",
      stats: {
        cpu_cores: 8,
        cpu_percent: 11.2,
        mem_percent: 26.8,
        mem_total_bytes: 16_000_000_000,
        mem_used_bytes: 4_288_000_000,
        disk_percent: 22.0,
        disk_total_bytes: 500_000_000_000,
        disk_used_bytes: 110_000_000_000,
        gpu_mem_total_bytes: null,
        gpu_mem_used_bytes: null,
        load_avg_1m: 0.21,
      },
      processes: [
        {
          name: "cf-gateway-origin",
          pid: 1519,
          digest: "1b9c8e4f02a7",
          restarts: 0,
          status: "running",
        },
      ],
      plugins,
      sessions: [],
      blobStore: {
        objects: 49,
        totalBytes: 218_500_000,
        pinnedPlugins: 2,
        peerPulls24h: 77,
        cacheHitPercent: 98.9,
        verifiedSha256Percent: 100,
        recentTransfer: "synced 49 blobs from orbit-gw-01",
      },
    },
  ];

  return {
    slug: "sim-orbit",
    name: "sim-orbit",
    hostname: "orbit.dialtone.earth",
    channelFingerprint: "ch-sim-orbit-1b9c",
    regionSummary: "EU-West · Singapore",
    simulated: true,
    snapshot: {
      network: "sim-orbit",
      generated_at: "2026-11-22T22:15:11Z",
      latest_release: "0.5.5",
      node_count: hosts.length,
      nodes: hosts,
    },
    hosts,
    plugins,
    blobStore: {
      objects: 98,
      totalBytes: 437_000_000,
      pinnedPlugins: 4,
      peerPulls24h: 158,
      cacheHitPercent: 99.0,
      verifiedSha256Percent: 100,
      recentTransfer: "orbit-gw-02 synced origin pool bundle (9.6 MB)",
    },
    recoveryEvents: [
      {
        id: "rec-o1",
        timestamp: "2026-11-22T21:11:04Z",
        host: "orbit-gw-02",
        stage: "verified",
        trigger: "Simulated origin A gateway drain test (#373)",
        action:
          "Cloudflare Worker gateway failed over to orbit-gw-02 with zero cross-network fallback",
        recoveryMs: 310,
        probeAfter: "HTTP 200 from orbit-gw-02 (private, no-store)",
      },
    ],
    tests: [
      {
        testId: "3974c5fa0896c3761b98502aac591010",
        name: "TestCloudflareOriginPoolFailover",
        title: "Cloudflare Origin Pool Failover",
        status: "pass",
        elapsed: "0.31",
        timestamp: "2026-11-22T22:10:00Z",
        completedAt: "2026-11-22T22:10:00Z",
        command: 'go run . test --filter "^TestCloudflareOriginPoolFailover$"',
        artifact: "logs/3974c5fa0896c3761b98502aac591010.log",
        log: [
          "2026-11-22T22:10:00Z INFO [SIMULATED] origin A returned 503; Worker gateway promoted enrolled origin B (orbit-gw-02)",
          "2026-11-22T22:10:00Z INFO [SIMULATED] unrelated origin C never contacted; failover completed in 310ms",
          "--- PASS: TestCloudflareOriginPoolFailover (0.31s)",
        ].join("\n"),
      },
    ],
    users: [
      {
        email: "sam@sim-orbit.example",
        role: "authorized-member",
        status: "active",
        locations: [
          {
            sessionId: "sim-o1",
            location: "Singapore, SG (SIN)",
            city: "Singapore",
            region: null,
            country: "SG",
            colo: "SIN",
            viewingView: "host",
            viewingNode: "orbit-gw-02",
            lastSeenAt: "2026-11-22T22:11:30Z",
          },
        ],
        shellNodes: ["orbit-gw-02"],
        lastCommandAt: "2026-11-22T22:10:42Z",
      },
    ],
    shellAuditLog: [
      makeRedactedAuditEntry({
        id: "sim-sh-o1",
        timestamp: "2026-11-22T22:10:42Z",
        user: "sam@sim-orbit.example",
        node: "orbit-gw-02",
        sessionName: "gateway-verify",
        shell: "bash",
        cwd: "/etc/dialtone",
        rawCommand:
          "dialtone gateway check --password sim_gw_pass_42 --origin https://admin:sim_pass@origin-b.example.test",
        rawOutput: "origin-b healthy · failover verified in 310ms",
      }),
    ],
  };
}

function makeRedactedAuditEntry(opts: {
  id: string;
  timestamp: string;
  user: string;
  node: string;
  sessionName: string;
  shell: "bash" | "powershell";
  cwd: string;
  rawCommand: string;
  rawOutput: string;
}): ShellAuditEntry {
  const cmd = redactSecrets(opts.rawCommand);
  const out = redactSecrets(opts.rawOutput);
  return {
    id: opts.id,
    timestamp: opts.timestamp,
    user: opts.user,
    node: opts.node,
    sessionName: opts.sessionName,
    shell: opts.shell,
    cwd: opts.cwd,
    command: cmd.text,
    output: out.text,
    redactedCount: cmd.redactedCount + out.redactedCount,
  };
}
