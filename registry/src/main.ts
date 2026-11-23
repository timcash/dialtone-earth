import "./hud.css";
import { aggregateNetwork } from "./aggregates";
import { adaptLiveMeshToNetwork } from "./live-adapter";
import {
  SIMULATED_NETWORKS,
  SIMULATED_TOUR_STEPS,
  summarizeSystemResources,
  type MeshHost,
  type MeshNetwork,
  type NetworkFocusTab,
  type SimTestRun,
  type TourStep,
  type TourView,
} from "./simulation";
import type { OverviewGlobeController } from "./overview-globe";

type SessionInfo = {
  authenticated: boolean;
  mode: "live" | "simulated";
  network: string | null;
  hostname?: string;
  subject?: string;
  origin_count?: number;
  gateway?: string;
  login_url?: string | null;
  logout_url?: string | null;
};

type LiveSiteState = {
  revision: number;
  updated_at: string | null;
  updated_by: string | null;
  title: string | null;
  badge: string | null;
  banner: string | null;
  headline: string | null;
  subline: string | null;
  theme: "light" | "dark" | null;
  view: TourView | null;
  network: string | null;
  tour_playing: boolean | null;
};

type AppState = {
  session: SessionInfo;
  liveSite: LiveSiteState | null;
  networks: MeshNetwork[];
  tourSteps: TourStep[];
  view: TourView;
  networkSlug: string;
  hostName: string;
  networkTab: NetworkFocusTab;
  testId: string;
  tourPlaying: boolean;
  tourStepIndex: number;
  liveError: string | null;
  loadedLogCache: Record<string, SimTestRun>;
  shellFilterNode: string;
};

const TOUR_INTERVAL_MS = 6_500;
const PRESENCE_INTERVAL_MS = 30_000;
const LIVE_POLL_INTERVAL_MS = 1_500;

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("Missing app root");
const app: HTMLDivElement = appElement;

const state: AppState = {
  session: {
    authenticated: false,
    mode: "simulated",
    network: null,
    gateway: "cloudflare-access",
  },
  liveSite: null,
  networks: SIMULATED_NETWORKS,
  tourSteps: SIMULATED_TOUR_STEPS,
  view: "overview",
  networkSlug: SIMULATED_NETWORKS[0].slug,
  hostName: SIMULATED_NETWORKS[0].hosts[0].name,
  networkTab: "hosts",
  testId:
    SIMULATED_NETWORKS[0].tests[4]?.testId ??
    SIMULATED_NETWORKS[0].tests[0].testId,
  tourPlaying: true,
  tourStepIndex: 0,
  liveError: null,
  loadedLogCache: {},
  shellFilterNode: "all",
};

let globeController: OverviewGlobeController | null = null;
let tourTimer: number | null = null;
let presenceTimer: number | null = null;
let livePollTimer: number | null = null;

void boot();

async function boot(): Promise<void> {
  if (window.location.pathname !== "/") {
    renderNotFound();
    return;
  }

  state.session = await detectSession();
  if (state.session.authenticated && state.session.mode === "live") {
    state.tourPlaying = false;
    const liveNetwork = await loadLiveNetwork(state.session);
    if (liveNetwork) {
      state.networks = [liveNetwork];
      state.networkSlug = liveNetwork.slug;
      state.hostName = liveNetwork.hosts[0]?.name ?? "";
      state.testId = liveNetwork.tests[0]?.testId ?? "";
      state.tourSteps = buildLiveTourSteps(liveNetwork);
      state.tourStepIndex = 0;
    }
  } else {
    await pollLiveSiteState(true);
  }

  mountShell();
  renderPanels();

  const stage = app.querySelector<HTMLElement>(".globe-stage");
  if (stage) {
    const { mountOverviewGlobe } = await import("./overview-globe");
    globeController = await mountOverviewGlobe(
      stage,
      state.networks.map((net) => ({ slug: net.slug, snapshot: net.snapshot })),
      () => {},
    );
    syncGlobeFocus();
  }

  startTourTimer();
  startPresenceHeartbeat();
  startLiveSitePolling();
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
          hostname: payload.hostname,
          subject: payload.subject,
          origin_count: payload.origin_count,
          gateway: payload.gateway ?? "cloudflare-access",
          login_url: payload.login_url ?? null,
          logout_url: payload.logout_url ?? "/cdn-cgi/access/logout",
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

async function loadLiveNetwork(
  session: SessionInfo,
): Promise<MeshNetwork | null> {
  try {
    const [mesh, plugins, sessions, processes, probe, fullState, tests, users] =
      await Promise.all([
        fetchOptionalJson("/api/mesh/state"),
        fetchOptionalJson("/api/mesh/plugins"),
        fetchOptionalJson("/api/mesh/shell/sessions"),
        fetchOptionalJson("/api/mesh/processes"),
        fetchOptionalJson("/api/mesh/probe"),
        fetchOptionalJson("/api/mesh/full-state"),
        fetchOptionalJson("/api/mesh/tests"),
        fetchOptionalJson("/api/mesh/users"),
      ]);
    if (!mesh) {
      state.liveError =
        "Authenticated session active, but enrolled Dialtone origin did not return /api/mesh/state.";
      return null;
    }
    return adaptLiveMeshToNetwork({
      hostname: session.hostname || window.location.hostname,
      networkName: session.network ?? undefined,
      currentUser: session.subject,
      mesh,
      plugins,
      sessions,
      processes,
      probe,
      fullState,
      tests,
      users,
    });
  } catch (error) {
    state.liveError =
      error instanceof Error ? error.message : "Failed to load live mesh data.";
    return null;
  }
}

async function reportLivePresence(): Promise<void> {
  if (!state.session.authenticated || state.session.mode !== "live") return;
  try {
    await fetch("/api/mesh/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        view: state.view,
        node: state.view === "overview" ? null : state.hostName || null,
      }),
    });
  } catch {
    // Non-blocking heartbeat
  }
}

async function refreshLiveUsers(): Promise<void> {
  if (!state.session.authenticated || state.session.mode !== "live") return;
  const payload = await fetchOptionalJson("/api/mesh/users");
  if (!payload) return;
  const net = activeNetwork();
  const adapted = adaptLiveMeshToNetwork({
    hostname: net.hostname,
    networkName: net.slug,
    currentUser: state.session.subject,
    mesh: { nodes: [], mesh_config: { channel: net.slug } },
    users: payload,
  });
  net.users = adapted.users;
  if (adapted.shellAuditLog.length > 0 || Array.isArray(payload.shell_audit_log)) {
    net.shellAuditLog = adapted.shellAuditLog;
  }
  renderPanels();
}

function startPresenceHeartbeat(): void {
  if (presenceTimer !== null) {
    window.clearInterval(presenceTimer);
    presenceTimer = null;
  }
  if (!state.session.authenticated || state.session.mode !== "live") return;
  void reportLivePresence();
  presenceTimer = window.setInterval(() => {
    if (document.hidden) return;
    void reportLivePresence();
    if (state.view === "users") {
      void refreshLiveUsers();
    }
  }, PRESENCE_INTERVAL_MS);
}

async function pollLiveSiteState(initial = false): Promise<void> {
  if (state.session.authenticated) return;
  const payload = await fetchOptionalJson("/api/live");
  if (!payload || typeof payload.revision !== "number") return;
  const next: LiveSiteState = {
    revision: Math.floor(payload.revision),
    updated_at: typeof payload.updated_at === "string" ? payload.updated_at : null,
    updated_by: typeof payload.updated_by === "string" ? payload.updated_by : null,
    title: typeof payload.title === "string" ? payload.title : null,
    badge: typeof payload.badge === "string" ? payload.badge : null,
    banner: typeof payload.banner === "string" ? payload.banner : null,
    headline: typeof payload.headline === "string" ? payload.headline : null,
    subline: typeof payload.subline === "string" ? payload.subline : null,
    theme:
      payload.theme === "light" || payload.theme === "dark"
        ? payload.theme
        : null,
    view:
      payload.view === "overview" ||
      payload.view === "network" ||
      payload.view === "host" ||
      payload.view === "users" ||
      payload.view === "tests" ||
      payload.view === "log"
        ? payload.view
        : null,
    network: typeof payload.network === "string" ? payload.network : null,
    tour_playing:
      typeof payload.tour_playing === "boolean" ? payload.tour_playing : null,
  };
  const changed =
    state.liveSite === null || state.liveSite.revision !== next.revision;
  if (!changed) return;

  state.liveSite = next;
  applyLiveSiteState(next, initial);
}

function applyLiveSiteState(live: LiveSiteState, initial: boolean): void {
  document.documentElement.dataset.theme =
    live.theme === "light" ? "light" : "dark";
  if (live.title) {
    document.title = `${live.title} — dialtone.earth`;
  } else if (!state.session.authenticated) {
    document.title = "dialtone.earth — simulated system tour";
  }
  if (live.network) {
    const matched = state.networks.find((n) => n.slug === live.network);
    if (matched) {
      state.networkSlug = matched.slug;
      state.hostName = matched.hosts[0]?.name ?? "";
      state.testId = matched.tests[0]?.testId ?? "";
    }
  }
  if (live.view) {
    state.view = live.view;
  }
  if (typeof live.tour_playing === "boolean") {
    state.tourPlaying = live.tour_playing;
    if (!initial) {
      if (state.tourPlaying) startTourTimer();
      else clearTourTimer();
    }
  }
  if (!initial) {
    renderPanels();
    syncGlobeFocus();
  }
}

function startLiveSitePolling(): void {
  if (livePollTimer !== null) {
    window.clearInterval(livePollTimer);
    livePollTimer = null;
  }
  if (state.session.authenticated) return;
  livePollTimer = window.setInterval(() => {
    if (document.hidden) return;
    void pollLiveSiteState(false);
  }, LIVE_POLL_INTERVAL_MS);
}

async function fetchOptionalJson(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function loadLiveTestRunLog(testId: string): Promise<void> {
  if (!state.session.authenticated || !/^[a-f0-9]{32}$/.test(testId)) return;
  if (state.loadedLogCache[testId]) return;
  const payload = await fetchOptionalJson(`/api/mesh/test-runs/${testId}`);
  const run =
    payload?.run && typeof payload.run === "object"
      ? (payload.run as Record<string, unknown>)
      : null;
  if (!run) return;
  state.loadedLogCache[testId] = {
    testId,
    name: typeof run.name === "string" ? run.name : testId,
    title: typeof run.title === "string" ? run.title : testId,
    status:
      run.status === "pass" ||
      run.status === "fail" ||
      run.status === "running" ||
      run.status === "skip"
        ? run.status
        : "pass",
    elapsed: typeof run.elapsed === "string" ? run.elapsed : "0.00",
    timestamp: typeof run.timestamp === "string" ? run.timestamp : "none",
    completedAt:
      typeof run.completed_at === "string" ? run.completed_at : "",
    command:
      typeof run.command === "string"
        ? run.command
        : `go run . test --filter "^${String(run.name ?? "")}$"`,
    artifact:
      typeof run.artifact === "string" ? run.artifact : `logs/${testId}.log`,
    log: typeof run.log === "string" ? run.log : "(empty log)",
  };
  renderPanels();
}

function buildLiveTourSteps(net: MeshNetwork): TourStep[] {
  const firstHost = net.hosts[0]?.name ?? null;
  const firstTestId = net.tests[0]?.testId;
  const authLabel =
    state.session.gateway === "dialtone-magic-link"
      ? "dialtone.earth email link"
      : "Cloudflare Access";
  return [
    {
      id: "live-overview",
      label: "LIVE OVERVIEW",
      view: "overview",
      networkSlug: net.slug,
      hostName: null,
      headline: `Live Authenticated Mesh: ${net.slug} (${net.hosts.length} peers)`,
      caption: `Signed in as ${state.session.subject ?? "verified user"} via ${authLabel}. Displaying real live Dialtone v${net.snapshot.latest_release} telemetry using the exact same UI model as the signed-out simulated tour.`,
    },
    {
      id: "live-network",
      label: "LIVE NETWORK",
      view: "network",
      networkSlug: net.slug,
      hostName: null,
      networkTab: "hosts",
      headline: `Live Network: ${net.slug} (${net.channelFingerprint})`,
      caption: `Real allowlisted Dialtone peers, OS/arch versions, neighbor RTTs, and continuous probe status across ${net.hosts.length} live nodes.`,
    },
    {
      id: "live-host",
      label: "LIVE HOST",
      view: "host",
      networkSlug: net.slug,
      hostName: firstHost,
      headline: `Live Host: ${firstHost ?? "origin"}`,
      caption:
        "Live CPU, RAM, Disk, supervised blob processes, iroh-blobs store, and persistent dialtone/shell/1 sessions.",
    },
    {
      id: "live-users",
      label: "LIVE USERS",
      view: "users",
      networkSlug: net.slug,
      hostName: null,
      headline: `Signed-In Users & Redacted Shell Log (${net.users.length} active)`,
      caption:
        "Logged-in members for this private network, active locations, viewed nodes, and shared dialtone-shell log with keys and passwords redacted.",
    },
    {
      id: "live-tests",
      label: "LIVE TESTS",
      view: "tests",
      networkSlug: net.slug,
      hostName: null,
      headline: `Live Recorded Test Suite (${net.tests.length} runs)`,
      caption:
        "Immutable per-execution test records served through the authenticated Cloudflare gateway.",
    },
    ...(firstTestId
      ? [
          {
            id: "live-log",
            label: "LIVE LOG",
            view: "log" as const,
            networkSlug: net.slug,
            hostName: null,
            testId: firstTestId,
            headline: `Live Immutable Execution Log (${firstTestId.slice(0, 12)}…)`,
            caption:
              "Per-run immutable log artifact fetched live through /api/mesh/test-runs/<test-id>.",
          },
        ]
      : []),
  ];
}

function mountShell(): void {
  document.title = state.session.authenticated
    ? `dialtone.earth — live ${state.networkSlug} mesh`
    : "dialtone.earth — simulated system tour";
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

function activeNetwork(): MeshNetwork {
  return (
    state.networks.find((n) => n.slug === state.networkSlug) ??
    state.networks[0]
  );
}

function activeHost(net: MeshNetwork): MeshHost | null {
  return net.hosts.find((h) => h.name === state.hostName) ?? net.hosts[0] ?? null;
}

function activeTestRun(net: MeshNetwork): SimTestRun | null {
  const fromCache = state.loadedLogCache[state.testId];
  if (fromCache) return fromCache;
  return (
    net.tests.find((t) => t.testId === state.testId) ?? net.tests[0] ?? null
  );
}

function renderPanels(): void {
  const topEl = app.querySelector<HTMLElement>("#sim-top-chrome");
  const drawerEl = app.querySelector<HTMLElement>("#sim-drawer");
  const tourEl = app.querySelector<HTMLElement>("#sim-tour-bar");
  if (!topEl || !drawerEl || !tourEl) return;

  const summary = summarizeSystemResources(state.networks);
  const net = activeNetwork();
  const host = activeHost(net);
  const testRun = activeTestRun(net);

  const isLive = state.session.authenticated && !net.simulated;
  const liveCtrl = !isLive ? state.liveSite : null;
  const wordmarkText = liveCtrl?.title || "dialtone // earth";
  const modeBadge = isLive
    ? `<span class="sim-badge is-live" data-testid="live-badge">LIVE MESH · ${escapeHtml(net.slug.toUpperCase())} (${escapeHtml(state.session.subject ?? "CLOUDFLARE ACCESS")})</span>`
    : liveCtrl?.badge
      ? `<span class="sim-badge is-live" data-testid="live-cli-badge">${escapeHtml(liveCtrl.badge)}</span>`
      : `<span class="sim-badge is-sim" data-testid="simulated-badge">SIMULATED TOUR · NOT SIGNED IN</span>`;

  const liveBannerHtml = liveCtrl?.banner
    ? `<div class="sim-live-banner" data-testid="live-cli-banner" role="status">
        <span class="sim-live-dot" aria-hidden="true"></span>
        <span class="sim-live-label">LIVE CLI · REV #${liveCtrl.revision}</span>
        <span class="sim-live-text">${escapeHtml(liveCtrl.banner)}</span>
        ${liveCtrl.updated_at ? `<span class="sim-live-time">${escapeHtml(liveCtrl.updated_at)}</span>` : ""}
      </div>`
    : "";
  const shellEl = app.querySelector<HTMLElement>(".sim-shell");
  if (shellEl) {
    shellEl.classList.toggle("has-live-banner", Boolean(liveCtrl?.banner));
  }

  const authAction = isLive
    ? `<a class="sim-nav-btn" data-testid="auth-logout" href="${escapeHtml(state.session.logout_url || "/cdn-cgi/access/logout")}">Sign out</a>`
    : state.session.login_url
      ? `<a class="sim-nav-btn is-active" data-testid="auth-login" href="${escapeHtml(state.session.login_url)}">Sign in</a>`
      : "";

  topEl.innerHTML = `
    <header class="sim-header">
      <div class="sim-brand-group">
        <a class="overview-wordmark" href="/">${escapeHtml(wordmarkText)}</a>
        ${modeBadge}
      </div>
      <nav class="sim-nav" aria-label="System tour views">
        ${navButton("overview", "Overview")}
        ${navButton("network", `Network: ${net.slug}`)}
        ${navButton("host", `Host: ${host?.name ?? "none"}`)}
        ${navButton("users", `Users (${net.users.length})`)}
        ${navButton("tests", `Tests (${net.tests.length})`)}
        ${navButton("log", "Log")}
        ${authAction}
      </nav>
    </header>
    <section class="sim-resource-strip" aria-label="System-wide resource statistics">
      <span><b>NETS</b> ${summary.networks}</span>
      <span><b>NODES</b> ${summary.onlineNodes}/${summary.totalNodes}</span>
      <span><b>USERS</b> ${summary.activeUsers}</span>
      <span><b>CPU</b> ${summary.cpuCores}c (${summary.avgCpuPercent}%)</span>
      <span><b>RAM</b> ${summary.memUsedGb}/${summary.memTotalGb} GB</span>
      <span><b>DISK</b> ${summary.diskUsedTb}/${summary.diskTotalTb} TB</span>
      <span><b>GPU VRAM</b> ${summary.gpuUsedGb}/${summary.gpuTotalGb} GB</span>
      <span><b>BLOBS</b> ${summary.blobObjects} (${summary.blobTotalMb} MB)</span>
      <span><b>PLUGINS</b> ${summary.activePlugins}</span>
      <span><b>SHELLS</b> ${summary.activeShellSessions}</span>
      <span><b>TESTS</b> ${summary.passingTests}/${summary.totalTests} PASS</span>
    </section>
    ${liveBannerHtml}
  `;

  if (state.view === "overview") {
    drawerEl.innerHTML = renderOverviewView(summary, isLive);
  } else if (state.view === "network") {
    drawerEl.innerHTML = renderNetworkView(net);
  } else if (state.view === "host" && host) {
    drawerEl.innerHTML = renderHostView(net, host);
  } else if (state.view === "users") {
    drawerEl.innerHTML = renderUsersView(net, isLive);
  } else if (state.view === "tests") {
    drawerEl.innerHTML = renderTestsView(net);
  } else if (testRun) {
    drawerEl.innerHTML = renderLogView(net, testRun);
  } else {
    drawerEl.innerHTML = `<p class="sim-dim">No test run selected.</p>`;
  }

  const currentStep = state.tourSteps[state.tourStepIndex] ?? state.tourSteps[0];
  const tourHeadline = liveCtrl?.headline || currentStep.headline;
  const tourCaption = liveCtrl?.subline || currentStep.caption;
  tourEl.innerHTML = `
    <div class="sim-tour-copy">
      <div class="sim-tour-meta">
        <span class="sim-step-tag">STEP ${state.tourStepIndex + 1}/${state.tourSteps.length} · ${escapeHtml(currentStep.label)}</span>
        <strong class="sim-tour-headline">${escapeHtml(tourHeadline)}</strong>
      </div>
      <p class="sim-tour-caption">${escapeHtml(tourCaption)}</p>
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
  isLive: boolean,
): string {
  const authLabel =
    state.session.gateway === "dialtone-magic-link"
      ? "dialtone.earth email link"
      : "Cloudflare Access";
  const banner = state.liveError
    ? `<p class="sim-callout">${escapeHtml(state.liveError)}</p>`
    : isLive
      ? `<p class="sim-callout is-live">Authenticated via <strong>${escapeHtml(authLabel)}</strong> as <code>${escapeHtml(state.session.subject ?? "user")}</code>. Showing <strong>live real-time telemetry</strong> from your enrolled Dialtone v0.5.5 mesh (identical data model and screens to the signed-out simulated tour).</p>`
      : `<p class="sim-callout">You are viewing <strong>simulated Dialtone v0.5.5 telemetry</strong> (zero private data). Select any network below to inspect hosts, signed-in users, blob-backed plugins, error recovery, and test logs—or sign in to inspect your live mesh.</p>`;

  const rows = state.networks
    .map((net) => {
      const agg = aggregateNetwork(net.snapshot);
      const active = net.slug === state.networkSlug ? "is-selected" : "";
      const online = net.hosts.filter((h) => h.online).length;
      return `
      <button type="button" class="sim-table-row sim-net-row ${active}" data-select-network="${escapeHtml(net.slug)}">
        <span class="sim-strong">${escapeHtml(net.slug)}</span>
        <span>${online}/${net.hosts.length}</span>
        <span>${escapeHtml(agg.cpu)}</span>
        <span>${escapeHtml(agg.memory)}</span>
        <span>${escapeHtml(agg.gpuMemory)}</span>
        <span>${net.blobStore.objects} blobs</span>
        <span>${net.tests.filter((t) => t.status === "pass").length}/${net.tests.length} pass</span>
      </button>
    `;
    })
    .join("");

  const liveCtrl = !isLive ? state.liveSite : null;
  const heading = liveCtrl?.headline
    ? escapeHtml(liveCtrl.headline)
    : `SYSTEM-WIDE OVERVIEW (${isLive ? "LIVE MESH" : "SIMULATED"})`;
  const subline = liveCtrl?.subline
    ? escapeHtml(liveCtrl.subline)
    : "Click any network to inspect its hosts, plugin rollouts, iroh-blobs store, error recovery, and tests.";

  return `
    <div class="sim-panel-head">
      <div>
        <h2>${heading}</h2>
        <p class="sim-sub">${subline}</p>
      </div>
      <div class="node-load-legend">
        <span class="node-load-legend-title">LOAD</span>
        <span><i class="load-low"></i>LOW</span>
        <span><i class="load-medium"></i>MED</span>
        <span><i class="load-high"></i>HIGH</span>
      </div>
    </div>
    ${banner}
    <div class="sim-table" role="table" aria-label="Dialtone networks">
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
        <p>Exact-hostname RS256 JWT verification (<code>Cf-Access-Jwt-Assertion</code>) fronts enrolled Dialtone v0.5.5 Tunnel origins with fail-closed <code>401</code> denial and <code>Cache-Control: private, no-store</code>.</p>
      </article>
      <article class="sim-mini-card">
        <h3>BLOB-BACKED PLUGINS &amp; SHELLS</h3>
        <p>${summary.activePlugins} verified plugin(s) (<code>dialtone/shell/1</code>, <code>dialtone/exec/1</code>, stdio-RPC binaries) and ${summary.activeShellSessions} persistent cross-OS session(s) across ${summary.totalNodes} host(s).</p>
      </article>
      <article class="sim-mini-card">
        <h3>SELF-HEALING &amp; EVENTS</h3>
        <p>${summary.recoveryEventsCount} recorded mesh/recovery event(s) tracking peer discovery, watchdog <code>EXIT_RESTART</code>, blob verification, and probe status.</p>
      </article>
    </div>
  `;
}

function renderNetworkView(net: MeshNetwork): string {
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
            <span>${h.stats.cpu_percent !== null ? `${h.stats.cpu_percent}%` : "n/a"}${h.stats.cpu_cores !== null ? ` (${h.stats.cpu_cores}c)` : ""}</span>
            <span>${h.stats.mem_percent !== null ? `${h.stats.mem_percent}%` : "n/a"}</span>
            <span>${h.rtt_ms !== null && h.rtt_ms !== undefined ? (h.rtt_ms === 0 ? "origin" : `${h.rtt_ms.toFixed(1)} ms`) : "n/a"}</span>
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
            <span>${(p.sizeBytes / 1e6).toFixed(2)} MB</span>
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
          <p><strong>${b.objects}</strong> content-addressed objects · <strong>${(b.totalBytes / 1e6).toFixed(2)} MB</strong> total · <strong>${b.pinnedPlugins}</strong> pinned plugin/program(s).</p>
        </article>
        <article class="sim-mini-card">
          <h3>QUIC TRANSFER &amp; INTEGRITY</h3>
          <p><strong>${b.peerPulls24h}</strong> peer fetch(es) · <strong>${b.cacheHitPercent}%</strong> local cache hit · <strong>${b.verifiedSha256Percent}%</strong> SHA-256 verified.</p>
        </article>
        <article class="sim-mini-card">
          <h3>LATEST BLOB STATUS</h3>
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
              ${ev.recoveryMs > 0 ? `<span>+${ev.recoveryMs} ms</span>` : ""}
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
        <button type="button" class="sim-btn" data-nav="users">Users &amp; Shell Log (${net.users.length}) →</button>
        <button type="button" class="sim-btn" data-nav="tests">Network Tests (${net.tests.length}) →</button>
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

function renderHostView(net: MeshNetwork, host: MeshHost): string {
  const ramUsed =
    host.stats.mem_used_bytes !== null
      ? (host.stats.mem_used_bytes / 1e9).toFixed(1)
      : "n/a";
  const ramTotal =
    host.stats.mem_total_bytes !== null
      ? (host.stats.mem_total_bytes / 1e9).toFixed(1)
      : "n/a";
  const gpuLine =
    host.stats.gpu_mem_used_bytes !== null &&
    host.stats.gpu_mem_total_bytes !== null
      ? `${host.gpuName ?? "GPU"} · ${(host.stats.gpu_mem_used_bytes / 1e9).toFixed(1)}/${(host.stats.gpu_mem_total_bytes / 1e9).toFixed(1)} GB${host.gpuLoadPercent !== null ? ` (${host.gpuLoadPercent}%)` : ""}`
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

  const procHtml =
    host.processes.length > 0
      ? host.processes
          .map(
            (p) =>
              `<p><strong>${escapeHtml(p.name)}</strong> pid=${p.pid} · <code>${escapeHtml(p.digest)}</code> · restarts=${p.restarts} · <span class="sim-pill is-ok">${escapeHtml(p.status)}</span></p>`,
          )
          .join("")
      : `<p class="sim-dim">No supervised blob processes reported on this host.</p>`;

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
        <p>CPU: <strong>${host.stats.cpu_percent ?? "n/a"}%</strong> (${host.stats.cpu_cores ?? "n/a"} cores, load ${host.stats.load_avg_1m ?? "n/a"})</p>
        <p>RAM: <strong>${ramUsed}/${ramTotal} GB</strong> (${host.stats.mem_percent ?? "n/a"}%) · Disk: <strong>${host.stats.disk_percent ?? "n/a"}%</strong></p>
        <p>GPU: <strong>${escapeHtml(gpuLine)}</strong></p>
      </article>
      <article class="sim-mini-card">
        <h3>SUPERVISED BLOB PROCESSES</h3>
        ${procHtml}
      </article>
      <article class="sim-mini-card">
        <h3>HOST BLOB STORE</h3>
        <p><strong>${host.blobStore.objects}</strong> blobs · <strong>${(host.blobStore.totalBytes / 1e6).toFixed(2)} MB</strong> · ${host.blobStore.cacheHitPercent}% cache hit</p>
        <p><code>${escapeHtml(host.blobStore.recentTransfer)}</code></p>
      </article>
    </div>
    <div class="sim-section-block">
      <h3>PERSISTENT QUIC SHELL SESSIONS (<code>dialtone/shell/1</code>)</h3>
      ${sessionsHtml}
    </div>
  `;
}

function renderUsersView(net: MeshNetwork, isLive: boolean): string {
  const totalLocations = net.users.reduce((sum, u) => sum + u.locations.length, 0);
  const allShellNodes = Array.from(
    new Set(net.shellAuditLog.map((e) => e.node).filter(Boolean)),
  );
  const activeFilter =
    state.shellFilterNode === "all" ||
    allShellNodes.includes(state.shellFilterNode)
      ? state.shellFilterNode
      : "all";
  const filteredLog =
    activeFilter === "all"
      ? net.shellAuditLog
      : net.shellAuditLog.filter((e) => e.node === activeFilter);
  const totalRedactions = net.shellAuditLog.reduce(
    (sum, e) => sum + e.redactedCount,
    0,
  );

  const usersHtml =
    net.users.length > 0
      ? net.users
          .map((user) => {
            const locRows = user.locations
              .map((loc) => {
                const nodeChip = loc.viewingNode
                  ? `<button type="button" class="sim-inline-node" data-select-host="${escapeHtml(loc.viewingNode)}">${escapeHtml(loc.viewingNode)}</button>`
                  : `<span class="sim-dim">${escapeHtml(loc.viewingView)}</span>`;
                return `
                  <div class="sim-user-loc-row">
                    <span><b>LOC</b> ${escapeHtml(loc.location)}</span>
                    <span><b>VIEWING</b> ${nodeChip}</span>
                    <span class="sim-dim">${escapeHtml(loc.lastSeenAt)}</span>
                  </div>
                `;
              })
              .join("");

            const shellNodeChips =
              user.shellNodes.length > 0
                ? user.shellNodes
                    .map(
                      (node) =>
                        `<button type="button" class="sim-inline-node" data-select-host="${escapeHtml(node)}">${escapeHtml(node)}</button>`,
                    )
                    .join(" ")
                : `<span class="sim-dim">none recorded</span>`;

            return `
              <article class="sim-user-card" data-testid="network-user-card">
                <div class="sim-recovery-head">
                  <span class="sim-strong"><i class="sim-dot"></i> ${escapeHtml(user.email)}</span>
                  <span class="sim-pill is-ok">${escapeHtml(user.status.toUpperCase())}</span>
                  <span class="sim-pill">${user.locations.length} ${user.locations.length === 1 ? "LOCATION" : "LOCATIONS"}</span>
                  <span class="sim-dim">${escapeHtml(user.role)}</span>
                </div>
                <div class="sim-user-locs">${locRows}</div>
                <div class="sim-user-shell-nodes">
                  <b>DIALTONE-SHELL NODES</b> ${shellNodeChips}
                </div>
              </article>
            `;
          })
          .join("")
      : `<p class="sim-dim">No active logged-in users reported for ${escapeHtml(net.hostname)} yet.</p>`;

  const filterBar = `
    <div class="sim-subtabs" role="tablist" aria-label="Filter shell audit log by node">
      <button type="button" class="sim-subtab ${activeFilter === "all" ? "is-active" : ""}" data-shell-filter="all">All nodes (${net.shellAuditLog.length})</button>
      ${allShellNodes
        .map(
          (node) =>
            `<button type="button" class="sim-subtab ${activeFilter === node ? "is-active" : ""}" data-shell-filter="${escapeHtml(node)}">${escapeHtml(node)}</button>`,
        )
        .join("")}
    </div>
  `;

  const auditHtml =
    filteredLog.length > 0
      ? filteredLog
          .map(
            (entry) => `
              <article class="sim-session-card" data-testid="shell-audit-entry">
                <div class="sim-recovery-head">
                  <button type="button" class="sim-inline-node" data-select-host="${escapeHtml(entry.node)}">${escapeHtml(entry.node)}</button>
                  <strong>${escapeHtml(entry.user)}</strong>
                  <span>${escapeHtml(entry.sessionName)} · ${escapeHtml(entry.shell)} · ${escapeHtml(entry.cwd)}</span>
                  <span class="sim-dim">${escapeHtml(entry.timestamp)}</span>
                  ${entry.redactedCount > 0 ? `<span class="sim-pill is-warn">${entry.redactedCount} REDACTED</span>` : ""}
                </div>
                <pre class="sim-code">$ ${escapeHtml(entry.command)}${entry.output ? `\n${escapeHtml(entry.output)}` : ""}</pre>
              </article>
            `,
          )
          .join("")
      : `<p class="sim-dim">No dialtone-shell commands recorded for this filter yet.</p>`;

  return `
    <div class="sim-panel-head">
      <div>
        <h2>SIGNED-IN USERS // ${escapeHtml(net.slug.toUpperCase())} <span class="sim-dim">(${escapeHtml(net.hostname)})</span></h2>
        <p class="sim-sub">${net.users.length} logged-in user(s) across ${totalLocations} active location(s) · Shared <code>dialtone-shell</code> audit log visible to all signed-in members (${totalRedactions} secret value(s) redacted).</p>
      </div>
      <div class="sim-head-actions">
        <span class="sim-pill is-warn" data-testid="redaction-badge">KEYS &amp; PASSWORDS REDACTED</span>
        ${isLive ? `<button type="button" class="sim-btn" data-action="refresh-users">↻ Refresh</button>` : ""}
        <button type="button" class="sim-btn" data-nav="network">← Back to ${escapeHtml(net.slug)}</button>
      </div>
    </div>
    <div class="sim-section-block">
      <h3>LOGGED-IN MEMBERS &amp; ACTIVE LOCATIONS</h3>
      <div class="sim-recovery-list">${usersHtml}</div>
    </div>
    <div class="sim-section-block" style="margin-top:14px">
      <h3>SHARED DIALTONE-SHELL LOG (KEYS &amp; PASSWORDS REDACTED)</h3>
      ${filterBar}
      <div class="sim-recovery-list">${auditHtml}</div>
    </div>
  `;
}

function renderTestsView(net: MeshNetwork): string {
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

function renderLogView(net: MeshNetwork, run: SimTestRun): string {
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
      void reportLivePresence();
      if (target === "users") {
        void refreshLiveUsers();
      }
      if (target === "log" && state.testId) {
        void loadLiveTestRunLog(state.testId);
      }
    });
  });

  app
    .querySelectorAll<HTMLButtonElement>("[data-select-network]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.dataset.selectNetwork;
        if (!slug) return;
        const net =
          state.networks.find((n) => n.slug === slug) ?? state.networks[0];
        pauseTour();
        state.networkSlug = net.slug;
        state.hostName = net.hosts[0]?.name ?? "";
        state.testId = net.tests[0]?.testId ?? "";
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
        void reportLivePresence();
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-shell-filter]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const node = btn.dataset.shellFilter;
        if (!node) return;
        pauseTour();
        state.shellFilterNode = node;
        renderPanels();
      });
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="refresh-users"]')
    ?.addEventListener("click", () => {
      void reportLivePresence().then(() => refreshLiveUsers());
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
      void loadLiveTestRunLog(id);
    });
  });

  app
    .querySelector<HTMLButtonElement>('[data-action="prev-step"]')
    ?.addEventListener("click", () => {
      const nextIdx =
        (state.tourStepIndex - 1 + state.tourSteps.length) %
        state.tourSteps.length;
      applyTourStep(nextIdx, false);
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="next-step"]')
    ?.addEventListener("click", () => {
      const nextIdx = (state.tourStepIndex + 1) % state.tourSteps.length;
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
  const step = state.tourSteps[index];
  if (!step) return;
  state.tourStepIndex = index;
  state.view = step.view;
  if (step.networkSlug) {
    state.networkSlug = step.networkSlug;
    const net = activeNetwork();
    state.hostName = step.hostName ?? net.hosts[0]?.name ?? "";
    state.testId = step.testId ?? net.tests[0]?.testId ?? "";
  }
  if (step.networkTab) state.networkTab = step.networkTab;
  if (!keepPlaying) pauseTour();
  renderPanels();
  syncGlobeFocus();
  if (state.view === "log" && state.testId) {
    void loadLiveTestRunLog(state.testId);
  }
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
    const nextIdx = (state.tourStepIndex + 1) % state.tourSteps.length;
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
