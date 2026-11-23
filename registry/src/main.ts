import "./hud.css";
import { aggregateNetwork } from "./aggregates";
import {
  findSimulatedHost,
  findSimulatedNetwork,
  findSimulatedTest,
  SIMULATED_NETWORKS,
  SIMULATED_OVERVIEW_NETWORKS,
  SIMULATED_TOUR_STEPS,
  summarizeSystemResources,
  type NetworkFocusTab,
  type SimHost,
  type SimNetwork,
  type SimTestRun,
  type TourView,
} from "./simulation";
import type { OverviewGlobeController } from "./overview-globe";

type SessionInfo = {
  authenticated: boolean;
  mode: "live" | "simulated";
  network: string | null;
  subject?: string;
  origin_count?: number;
  gateway?: string;
};

type AppState = {
  session: SessionInfo;
  view: TourView;
  networkSlug: string;
  hostName: string;
  networkTab: NetworkFocusTab;
  testId: string;
  tourPlaying: boolean;
  tourStepIndex: number;
  liveSummary: string | null;
};

const TOUR_INTERVAL_MS = 6_500;

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("Missing app root");
const app: HTMLDivElement = appElement;

const initialNet = SIMULATED_NETWORKS[0];
const state: AppState = {
  session: {
    authenticated: false,
    mode: "simulated",
    network: null,
    gateway: "cloudflare-access",
  },
  view: "overview",
  networkSlug: initialNet.slug,
  hostName: initialNet.hosts[0].name,
  networkTab: "hosts",
  testId: initialNet.tests[4]?.testId ?? initialNet.tests[0].testId,
  tourPlaying: true,
  tourStepIndex: 0,
  liveSummary: null,
};

let globeController: OverviewGlobeController | null = null;
let tourTimer: number | null = null;

void boot();

async function boot(): Promise<void> {
  if (window.location.pathname !== "/") {
    renderNotFound();
    return;
  }

  state.session = await detectSession();
  if (state.session.authenticated && state.session.mode === "live") {
    state.tourPlaying = false;
    state.liveSummary = await fetchLiveSummary();
  }

  mountShell();
  renderPanels();

  const stage = app.querySelector<HTMLElement>(".globe-stage");
  if (stage) {
    const { mountOverviewGlobe } = await import("./overview-globe");
    globeController = await mountOverviewGlobe(
      stage,
      SIMULATED_OVERVIEW_NETWORKS,
      () => {},
    );
    syncGlobeFocus();
  }

  startTourTimer();
}

async function detectSession(): Promise<SessionInfo> {
  try {
    const response = await fetch("/api/session", {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (response.ok) {
      const payload = (await response.json()) as Partial<SessionInfo>;
      if (typeof payload.authenticated === "boolean") {
        return {
          authenticated: payload.authenticated,
          mode: payload.authenticated ? "live" : "simulated",
          network: payload.network ?? null,
          subject: payload.subject,
          origin_count: payload.origin_count,
          gateway: payload.gateway ?? "cloudflare-access",
        };
      }
    }
  } catch {
    // Offline or static preview: default safely to simulated signed-out tour.
  }
  return {
    authenticated: false,
    mode: "simulated",
    network: null,
    gateway: "cloudflare-access",
  };
}

async function fetchLiveSummary(): Promise<string | null> {
  try {
    const response = await fetch("/api/mesh/state", {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return `Gateway returned HTTP ${response.status}`;
    const payload = (await response.json()) as Record<string, unknown>;
    const node = typeof payload.node === "string" ? payload.node : "origin";
    const peers = Array.isArray(payload.nodes) ? payload.nodes.length : 0;
    return `Connected to live mesh via Cloudflare Access (${node}, ${peers} peers)`;
  } catch {
    return "Authenticated via Cloudflare Access; awaiting enrolled origin response.";
  }
}

function mountShell(): void {
  document.title = "dialtone.earth — simulated system tour";
  app.innerHTML = `
    <main class="hud-shell overview-page sim-shell">
      <div class="globe-stage"></div>
      <div class="scene-shade" aria-hidden="true"></div>
      <div class="sim-top-chrome" id="sim-top-chrome"></div>
      <section class="sim-drawer" id="sim-drawer" aria-live="polite"></section>
      <footer class="sim-tour-bar" id="sim-tour-bar" aria-label="Guided tour controls"></footer>
    </main>
  `;
}

function renderPanels(): void {
  const topEl = app.querySelector<HTMLElement>("#sim-top-chrome");
  const drawerEl = app.querySelector<HTMLElement>("#sim-drawer");
  const tourEl = app.querySelector<HTMLElement>("#sim-tour-bar");
  if (!topEl || !drawerEl || !tourEl) return;

  const summary = summarizeSystemResources(SIMULATED_NETWORKS);
  const net = findSimulatedNetwork(state.networkSlug);
  const host = findSimulatedHost(net, state.hostName);
  const testRun = findSimulatedTest(net, state.testId);

  const modeBadge = state.session.authenticated
    ? `<span class="sim-badge is-live">LIVE MESH · ${escapeHtml(state.session.network ?? "CLOUDFLARE ACCESS")}</span>`
    : `<span class="sim-badge is-sim" data-testid="simulated-badge">SIMULATED TOUR · NOT SIGNED IN</span>`;

  topEl.innerHTML = `
    <header class="sim-header">
      <div class="sim-brand-group">
        <a class="overview-wordmark" href="/">dialtone // earth</a>
        ${modeBadge}
      </div>
      <nav class="sim-nav" aria-label="System tour views">
        ${navButton("overview", "Overview")}
        ${navButton("network", `Network: ${net.slug}`)}
        ${navButton("host", `Host: ${host.name}`)}
        ${navButton("tests", `Tests (${net.tests.length})`)}
        ${navButton("log", "Log")}
      </nav>
    </header>
    <section class="sim-resource-strip" aria-label="System-wide resource statistics">
      <span><b>NETS</b> ${summary.networks}</span>
      <span><b>NODES</b> ${summary.onlineNodes}/${summary.totalNodes}</span>
      <span><b>CPU</b> ${summary.cpuCores}c (${summary.avgCpuPercent}%)</span>
      <span><b>RAM</b> ${summary.memUsedGb}/${summary.memTotalGb} GB</span>
      <span><b>DISK</b> ${summary.diskUsedTb}/${summary.diskTotalTb} TB</span>
      <span><b>GPU VRAM</b> ${summary.gpuUsedGb}/${summary.gpuTotalGb} GB</span>
      <span><b>BLOBS</b> ${summary.blobObjects} (${summary.blobTotalMb} MB)</span>
      <span><b>PLUGINS</b> ${summary.activePlugins}</span>
      <span><b>SHELLS</b> ${summary.activeShellSessions}</span>
      <span><b>TESTS</b> ${summary.passingTests}/${summary.totalTests} PASS</span>
    </section>
  `;

  if (state.view === "overview") {
    drawerEl.innerHTML = renderOverviewView(summary);
  } else if (state.view === "network") {
    drawerEl.innerHTML = renderNetworkView(net);
  } else if (state.view === "host") {
    drawerEl.innerHTML = renderHostView(net, host);
  } else if (state.view === "tests") {
    drawerEl.innerHTML = renderTestsView(net);
  } else {
    drawerEl.innerHTML = renderLogView(net, testRun);
  }

  const currentStep = SIMULATED_TOUR_STEPS[state.tourStepIndex];
  tourEl.innerHTML = `
    <div class="sim-tour-copy">
      <div class="sim-tour-meta">
        <span class="sim-step-tag">STEP ${state.tourStepIndex + 1}/${SIMULATED_TOUR_STEPS.length} · ${escapeHtml(currentStep.label)}</span>
        <strong class="sim-tour-headline">${escapeHtml(currentStep.headline)}</strong>
      </div>
      <p class="sim-tour-caption">${escapeHtml(currentStep.caption)}</p>
    </div>
    <div class="sim-tour-controls">
      <button type="button" class="sim-btn" data-action="prev-step">◀ Prev</button>
      <button type="button" class="sim-btn is-primary" data-action="toggle-tour" aria-pressed="${state.tourPlaying}">
        ${state.tourPlaying ? "⏸ Pause Tour" : "▶ Play Tour"}
      </button>
      <button type="button" class="sim-btn" data-action="next-step">Next ▶</button>
    </div>
  `;

  bindInteractions();
}

function navButton(view: TourView, label: string): string {
  const active = state.view === view ? "is-active" : "";
  return `<button type="button" class="sim-nav-btn ${active}" data-nav="${view}">${escapeHtml(label)}</button>`;
}

function renderOverviewView(
  summary: ReturnType<typeof summarizeSystemResources>,
): string {
  const liveBanner = state.liveSummary
    ? `<p class="sim-callout is-live">${escapeHtml(state.liveSummary)}</p>`
    : `<p class="sim-callout">You are viewing <strong>simulated Dialtone v0.5.5 telemetry</strong> (zero private data). Select any network below to inspect hosts, blob-backed plugins, error recovery, and test logs—or authenticate on an enrolled <code>&lt;network&gt;.dialtone.earth</code> hostname via Cloudflare Access.</p>`;

  const rows = SIMULATED_NETWORKS.map((net) => {
    const agg = aggregateNetwork(net.snapshot);
    const active = net.slug === state.networkSlug ? "is-selected" : "";
    return `
      <button type="button" class="sim-table-row sim-net-row ${active}" data-select-network="${escapeHtml(net.slug)}">
        <span class="sim-strong">${escapeHtml(net.slug)}</span>
        <span>${net.hosts.length}/${net.hosts.length}</span>
        <span>${escapeHtml(agg.cpu)}</span>
        <span>${escapeHtml(agg.memory)}</span>
        <span>${escapeHtml(agg.gpuMemory)}</span>
        <span>${net.blobStore.objects} blobs</span>
        <span>${net.tests.length}/${net.tests.length} pass</span>
      </button>
    `;
  }).join("");

  return `
    <div class="sim-panel-head">
      <div>
        <h2>SYSTEM-WIDE OVERVIEW (SIMULATED)</h2>
        <p class="sim-sub">Click any simulated network to inspect its hosts, plugin rollouts, iroh-blobs store, error recovery, and tests.</p>
      </div>
      <div class="node-load-legend">
        <span class="node-load-legend-title">LOAD</span>
        <span><i class="load-low"></i>LOW</span>
        <span><i class="load-medium"></i>MED</span>
        <span><i class="load-high"></i>HIGH</span>
      </div>
    </div>
    ${liveBanner}
    <div class="sim-table" role="table" aria-label="Simulated Dialtone networks">
      <div class="sim-table-row sim-table-head" role="row">
        <span>NETWORK</span>
        <span>NODES</span>
        <span>CPU</span>
        <span>RAM</span>
        <span>GPU VRAM</span>
        <span>BLOB STORE</span>
        <span>TESTS</span>
      </div>
      ${rows}
    </div>
    <div class="sim-mini-grid">
      <article class="sim-mini-card">
        <h3>CLOUDFLARE ACCESS GATEWAY</h3>
        <p>Exact-hostname JWT verification (<code>Cf-Access-Jwt-Assertion</code>) fronts enrolled Dialtone v0.5.5 Tunnel origins with fail-closed <code>401</code> denial and <code>Cache-Control: private, no-store</code>.</p>
      </article>
      <article class="sim-mini-card">
        <h3>BLOB-BACKED PLUGINS &amp; SHELLS</h3>
        <p>${summary.activePlugins} verified plugins (<code>dialtone/shell/1</code>, <code>dialtone/exec/1</code>, stdio-RPC binaries) and ${summary.activeShellSessions} persistent cross-OS sessions across ${summary.totalNodes} simulated hosts.</p>
      </article>
      <article class="sim-mini-card">
        <h3>SELF-HEALING RECOVERY</h3>
        <p>${summary.recoveryEventsCount} recorded watchdog/failover events demonstrating <code>EXIT_RESTART</code>, daemon relaunch, QUIC blob re-pull, and Cloudflare origin pool failover.</p>
      </article>
    </div>
  `;
}

function renderNetworkView(net: SimNetwork): string {
  const tabBtn = (tab: NetworkFocusTab, label: string) =>
    `<button type="button" class="sim-subtab ${state.networkTab === tab ? "is-active" : ""}" data-net-tab="${tab}">${escapeHtml(label)}</button>`;

  let body = "";
  if (state.networkTab === "hosts") {
    body = `
      <div class="sim-table" role="table" aria-label="${escapeHtml(net.slug)} hosts">
        <div class="sim-table-row sim-host-row sim-table-head">
          <span>HOST</span>
          <span>OS / ARCH</span>
          <span>CPU</span>
          <span>RAM</span>
          <span>RTT</span>
          <span>PROBES</span>
        </div>
        ${net.hosts
          .map(
            (h) => `
          <button type="button" class="sim-table-row sim-host-row" data-select-host="${escapeHtml(h.name)}">
            <span class="sim-strong"><i class="sim-dot"></i> ${escapeHtml(h.name)}</span>
            <span>${escapeHtml(h.os)}/${escapeHtml(h.arch)} · v${escapeHtml(h.version)}</span>
            <span>${h.stats.cpu_percent ?? "n/a"}% (${h.stats.cpu_cores ?? "?"}c)</span>
            <span>${h.stats.mem_percent ?? "n/a"}%</span>
            <span>${h.rtt_ms !== null && h.rtt_ms !== undefined ? `${h.rtt_ms.toFixed(1)} ms` : "origin"}</span>
            <span>${escapeHtml(h.probeSummary)}</span>
          </button>
        `,
          )
          .join("")}
      </div>
    `;
  } else if (state.networkTab === "plugins") {
    body = `
      <div class="sim-table" role="table" aria-label="Plugin deployments">
        <div class="sim-table-row sim-plugin-row sim-table-head">
          <span>PLUGIN</span>
          <span>RUNTIME / PROTOCOL</span>
          <span>REPO</span>
          <span>SHA-256 DIGEST</span>
          <span>SIZE</span>
          <span>STATUS</span>
        </div>
        ${net.plugins
          .map(
            (p) => `
          <div class="sim-table-row sim-plugin-row">
            <span class="sim-strong">${escapeHtml(p.name)} ${escapeHtml(p.version)}</span>
            <span>${escapeHtml(p.runtime)} (${escapeHtml(p.protocol)})</span>
            <span>${escapeHtml(p.repo)}</span>
            <code>${escapeHtml(p.digest)}</code>
            <span>${(p.sizeBytes / 1e6).toFixed(1)} MB</span>
            <span class="sim-pill is-ok">${escapeHtml(p.status.toUpperCase())}</span>
          </div>
        `,
          )
          .join("")}
      </div>
    `;
  } else if (state.networkTab === "blobs") {
    const b = net.blobStore;
    body = `
      <div class="sim-mini-grid">
        <article class="sim-mini-card">
          <h3>IROH-BLOBS STORE</h3>
          <p><strong>${b.objects}</strong> content-addressed objects · <strong>${(b.totalBytes / 1e6).toFixed(1)} MB</strong> total · <strong>${b.pinnedPlugins}</strong> pinned plugin binaries.</p>
        </article>
        <article class="sim-mini-card">
          <h3>QUIC TRANSFER &amp; INTEGRITY</h3>
          <p><strong>${b.peerPulls24h}</strong> peer pulls (24h) · <strong>${b.cacheHitPercent}%</strong> local cache hit · <strong>${b.verifiedSha256Percent}%</strong> SHA-256 verified.</p>
        </article>
        <article class="sim-mini-card">
          <h3>LATEST BLOB PULL</h3>
          <p><code>${escapeHtml(b.recentTransfer)}</code></p>
        </article>
      </div>
    `;
  } else {
    body = `
      <div class="sim-recovery-list" aria-label="Error recovery timeline">
        ${net.recoveryEvents
          .map(
            (ev) => `
          <article class="sim-recovery-card">
            <div class="sim-recovery-head">
              <span class="sim-pill is-${ev.stage === "detected" ? "warn" : "ok"}">${escapeHtml(ev.stage.toUpperCase())}</span>
              <strong>${escapeHtml(ev.host)}</strong>
              <span>${escapeHtml(ev.timestamp)}</span>
              <span>+${ev.recoveryMs} ms</span>
            </div>
            <p><b>Trigger:</b> ${escapeHtml(ev.trigger)}</p>
            <p><b>Action:</b> ${escapeHtml(ev.action)} · <code>${escapeHtml(ev.probeAfter)}</code></p>
          </article>
        `,
          )
          .join("")}
      </div>
    `;
  }

  return `
    <div class="sim-panel-head">
      <div>
        <h2>NETWORK // ${escapeHtml(net.slug.toUpperCase())} <span class="sim-dim">(${escapeHtml(net.hostname)} · ${escapeHtml(net.channelFingerprint)})</span></h2>
        <p class="sim-sub">${escapeHtml(net.regionSummary)} · Dialtone v${escapeHtml(net.snapshot.latest_release)} · Click any host or inspect plugins, blobs, recovery, and tests.</p>
      </div>
      <div class="sim-head-actions">
        <button type="button" class="sim-btn" data-nav="tests">Open Network Tests (${net.tests.length}) →</button>
      </div>
    </div>
    <div class="sim-subtabs" role="tablist">
      ${tabBtn("hosts", `Hosts (${net.hosts.length})`)}
      ${tabBtn("plugins", `Plugin Deployments (${net.plugins.length})`)}
      ${tabBtn("blobs", `Blob Store (${net.blobStore.objects})`)}
      ${tabBtn("recovery", `Error Recovery (${net.recoveryEvents.length})`)}
    </div>
    ${body}
  `;
}

function renderHostView(net: SimNetwork, host: SimHost): string {
  const ramUsed =
    host.stats.mem_used_bytes !== null
      ? (host.stats.mem_used_bytes / 1e9).toFixed(1)
      : "n/a";
  const ramTotal =
    host.stats.mem_total_bytes !== null
      ? (host.stats.mem_total_bytes / 1e9).toFixed(1)
      : "n/a";
  const gpuLine =
    host.gpuName &&
    host.stats.gpu_mem_used_bytes !== null &&
    host.stats.gpu_mem_total_bytes !== null
      ? `${host.gpuName} · ${(host.stats.gpu_mem_used_bytes / 1e9).toFixed(1)}/${(host.stats.gpu_mem_total_bytes / 1e9).toFixed(1)} GB (${host.gpuLoadPercent ?? 0}%)`
      : "No GPU sensor reported (distinct from 0)";

  const sessionsHtml =
    host.sessions.length > 0
      ? host.sessions
          .map(
            (s) => `
          <div class="sim-session-card">
            <div class="sim-recovery-head">
              <strong>${escapeHtml(s.name)}</strong>
              <span>${escapeHtml(s.shell)} · ${escapeHtml(s.cwd)}</span>
              <span class="sim-pill is-ok">${escapeHtml(s.status.toUpperCase())}</span>
            </div>
            <pre class="sim-code">$ ${escapeHtml(s.lastCommand)}\n${escapeHtml(s.lastOutput)}</pre>
          </div>
        `,
          )
          .join("")
      : `<p class="sim-dim">No active shell sessions on this host right now.</p>`;

  return `
    <div class="sim-panel-head">
      <div>
        <h2>HOST // ${escapeHtml(host.name)} <span class="sim-dim">(${escapeHtml(host.role)} · ${escapeHtml(net.slug)})</span></h2>
        <p class="sim-sub">${escapeHtml(host.os)}/${escapeHtml(host.arch)} · Dialtone v${escapeHtml(host.version)} · Relay ${escapeHtml(host.relay_region)} · ${escapeHtml(host.probeSummary)}</p>
      </div>
      <div class="sim-head-actions">
        <button type="button" class="sim-btn" data-nav="network">← Back to ${escapeHtml(net.slug)}</button>
        <button type="button" class="sim-btn" data-nav="tests">Network Tests →</button>
      </div>
    </div>
    <div class="sim-mini-grid">
      <article class="sim-mini-card">
        <h3>COMPUTE &amp; MEMORY</h3>
        <p>CPU: <strong>${host.stats.cpu_percent ?? "n/a"}%</strong> (${host.stats.cpu_cores ?? "?"} cores, load ${host.stats.load_avg_1m ?? "n/a"})</p>
        <p>RAM: <strong>${ramUsed}/${ramTotal} GB</strong> (${host.stats.mem_percent ?? "n/a"}%) · Disk: <strong>${host.stats.disk_percent ?? "n/a"}%</strong></p>
        <p>GPU: <strong>${escapeHtml(gpuLine)}</strong></p>
      </article>
      <article class="sim-mini-card">
        <h3>SUPERVISED BLOB PROCESSES</h3>
        ${host.processes
          .map(
            (p) =>
              `<p><strong>${escapeHtml(p.name)}</strong> pid=${p.pid} · <code>${escapeHtml(p.digest)}</code> · restarts=${p.restarts} · <span class="sim-pill is-ok">${escapeHtml(p.status)}</span></p>`,
          )
          .join("")}
      </article>
      <article class="sim-mini-card">
        <h3>HOST BLOB STORE</h3>
        <p><strong>${host.blobStore.objects}</strong> blobs · <strong>${(host.blobStore.totalBytes / 1e6).toFixed(1)} MB</strong> · ${host.blobStore.cacheHitPercent}% cache hit</p>
        <p><code>${escapeHtml(host.blobStore.recentTransfer)}</code></p>
      </article>
    </div>
    <div class="sim-section-block">
      <h3>PERSISTENT QUIC SHELL SESSIONS (<code>dialtone/shell/1</code>)</h3>
      ${sessionsHtml}
    </div>
  `;
}

function renderTestsView(net: SimNetwork): string {
  const passed = net.tests.filter((t) => t.status === "pass").length;
  return `
    <div class="sim-panel-head">
      <div>
        <h2>NETWORK TESTS // ${escapeHtml(net.slug.toUpperCase())} <span class="sim-dim">(timcash/template run contract)</span></h2>
        <p class="sim-sub">${net.tests.length} total · ${passed} passed · 0 failed · Click <strong>Log ↗</strong> on any test to inspect its immutable per-run transcript.</p>
      </div>
      <div class="sim-head-actions">
        <button type="button" class="sim-btn" data-nav="network">← Back to ${escapeHtml(net.slug)}</button>
      </div>
    </div>
    <div class="sim-table" role="table" aria-label="Network test runs">
      ${net.tests
        .map(
          (t) => `
        <div class="sim-table-row sim-test-row" data-testid="sim-test-row">
          <div class="sim-test-title">
            <span class="sim-strong">${escapeHtml(t.title)}</span>
            <code>${escapeHtml(t.name)}</code>
          </div>
          <span class="sim-pill is-ok">${t.status === "pass" ? "PASSED" : escapeHtml(t.status.toUpperCase())}</span>
          <span>${escapeHtml(t.elapsed)}s</span>
          <button type="button" class="sim-link-btn" data-open-log="${escapeHtml(t.testId)}">Log ↗</button>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderLogView(net: SimNetwork, run: SimTestRun): string {
  return `
    <div class="sim-panel-head">
      <div>
        <h2>EXECUTION LOG // ${escapeHtml(run.title)}</h2>
        <p class="sim-sub">test-id: <code>${escapeHtml(run.testId)}</code> · ${escapeHtml(run.artifact)} · ${escapeHtml(run.elapsed)}s</p>
      </div>
      <div class="sim-head-actions">
        <button type="button" class="sim-btn" data-nav="tests">← All ${escapeHtml(net.slug)} Tests</button>
      </div>
    </div>
    <div class="sim-log-meta">
      <span><b>GO TEST</b> <code>${escapeHtml(run.name)}</code></span>
      <span><b>STATUS</b> <span class="sim-pill is-ok">${run.status === "pass" ? "PASSED" : escapeHtml(run.status.toUpperCase())}</span></span>
      <span><b>RERUN</b> <code>${escapeHtml(run.command)}</code></span>
    </div>
    <pre class="sim-code sim-log-pre" data-testid="sim-log-output">${escapeHtml(run.log)}</pre>
  `;
}

function bindInteractions(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.nav as TourView | undefined;
      if (!target) return;
      pauseTour();
      state.view = target;
      renderPanels();
      syncGlobeFocus();
    });
  });

  app
    .querySelectorAll<HTMLButtonElement>("[data-select-network]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.dataset.selectNetwork;
        if (!slug) return;
        const net = findSimulatedNetwork(slug);
        pauseTour();
        state.networkSlug = net.slug;
        state.hostName = net.hosts[0].name;
        state.testId = net.tests[0].testId;
        state.networkTab = "hosts";
        state.view = "network";
        renderPanels();
        syncGlobeFocus();
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-select-host]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const hostName = btn.dataset.selectHost;
        if (!hostName) return;
        pauseTour();
        state.hostName = hostName;
        state.view = "host";
        renderPanels();
        syncGlobeFocus();
      });
    });

  app.querySelectorAll<HTMLButtonElement>("[data-net-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.netTab as NetworkFocusTab | undefined;
      if (!tab) return;
      pauseTour();
      state.networkTab = tab;
      renderPanels();
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-open-log]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.openLog;
      if (!id) return;
      pauseTour();
      state.testId = id;
      state.view = "log";
      renderPanels();
    });
  });

  app
    .querySelector<HTMLButtonElement>('[data-action="prev-step"]')
    ?.addEventListener("click", () => {
      const nextIdx =
        (state.tourStepIndex - 1 + SIMULATED_TOUR_STEPS.length) %
        SIMULATED_TOUR_STEPS.length;
      applyTourStep(nextIdx, false);
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="next-step"]')
    ?.addEventListener("click", () => {
      const nextIdx = (state.tourStepIndex + 1) % SIMULATED_TOUR_STEPS.length;
      applyTourStep(nextIdx, false);
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="toggle-tour"]')
    ?.addEventListener("click", () => {
      state.tourPlaying = !state.tourPlaying;
      if (state.tourPlaying) startTourTimer();
      else clearTourTimer();
      renderPanels();
    });
}

function applyTourStep(index: number, keepPlaying: boolean): void {
  const step = SIMULATED_TOUR_STEPS[index];
  if (!step) return;
  state.tourStepIndex = index;
  state.view = step.view;
  if (step.networkSlug) {
    state.networkSlug = step.networkSlug;
    const net = findSimulatedNetwork(step.networkSlug);
    state.hostName = step.hostName ?? net.hosts[0].name;
    state.testId = step.testId ?? net.tests[0].testId;
  }
  if (step.networkTab) state.networkTab = step.networkTab;
  if (!keepPlaying) pauseTour();
  renderPanels();
  syncGlobeFocus();
}

function syncGlobeFocus(): void {
  if (!globeController) return;
  if (state.view === "overview") {
    globeController.focusTarget(null, null);
  } else if (state.view === "host") {
    globeController.focusTarget(state.networkSlug, state.hostName);
  } else {
    globeController.focusTarget(state.networkSlug, null);
  }
}

function startTourTimer(): void {
  clearTourTimer();
  if (!state.tourPlaying) return;
  tourTimer = window.setInterval(() => {
    if (!state.tourPlaying || document.hidden) return;
    const nextIdx = (state.tourStepIndex + 1) % SIMULATED_TOUR_STEPS.length;
    applyTourStep(nextIdx, true);
  }, TOUR_INTERVAL_MS);
}

function clearTourTimer(): void {
  if (tourTimer !== null) {
    window.clearInterval(tourTimer);
    tourTimer = null;
  }
}

function pauseTour(): void {
  state.tourPlaying = false;
  clearTourTimer();
}

function renderNotFound(): void {
  document.title = "404 — dialtone.earth";
  app.innerHTML = `
    <main class="hud-shell error-page">
      <section class="terminal-overlay">
        <a class="hud-brand" href="/">dialtone // earth</a>
        <h1>404 // NOT FOUND</h1>
        <a class="text-link" href="/">[ ESC ] RETURN TO DIALTONE.EARTH</a>
      </section>
    </main>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] ?? character,
  );
}
