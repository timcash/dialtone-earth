import "./hud.css";
import { aggregateNetwork } from "./aggregates";
import { adaptLiveMeshToNetwork } from "./live-adapter";
import {
  computeAdaptivePollMs,
  formatCadenceLabel,
  liveEndpointForQuery,
  type TableQuery,
} from "./mesh-cadence";
import {
  SIMULATED_NETWORKS,
  SIMULATED_TOUR_STEPS,
  summarizeSystemResources,
  type MeshHost,
  type MeshNetwork,
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
  liveEtag: string | null;
  networks: MeshNetwork[];
  tourSteps: TourStep[];
  query: TableQuery;
  networkSlug: string;
  hostName: string;
  testId: string;
  tourPlaying: boolean;
  tourCaptionsVisible: boolean;
  tourStepIndex: number;
  liveError: string | null;
  loadedLogCache: Record<string, SimTestRun>;
  unchangedStreak: number;
  notModifiedCount: number;
  currentPollMs: number | null;
  lastMeshHash: string | null;
  liveRawCache: Record<string, Record<string, unknown> | null>;
};

const TOUR_INTERVAL_MS = 6_500;
const PRESENCE_INTERVAL_MS = 30_000;

const QUERY_TABS: Array<{ id: TableQuery; label: string }> = [
  { id: "networks", label: "networks" },
  { id: "hosts", label: "hosts" },
  { id: "plugins", label: "plugins" },
  { id: "users", label: "users" },
  { id: "recovery", label: "recovery" },
  { id: "tests", label: "tests" },
  { id: "log", label: "log" },
];

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
  liveEtag: null,
  networks: SIMULATED_NETWORKS,
  tourSteps: SIMULATED_TOUR_STEPS,
  query: "networks",
  networkSlug: SIMULATED_NETWORKS[0].slug,
  hostName: SIMULATED_NETWORKS[0].hosts[0].name,
  testId:
    SIMULATED_NETWORKS[0].tests[4]?.testId ??
    SIMULATED_NETWORKS[0].tests[0].testId,
  tourPlaying: true,
  tourCaptionsVisible: true,
  tourStepIndex: 0,
  liveError: null,
  loadedLogCache: {},
  unchangedStreak: 0,
  notModifiedCount: 0,
  currentPollMs: 2_000,
  lastMeshHash: null,
  liveRawCache: {},
};

let globeController: OverviewGlobeController | null = null;
let tourTimer: number | null = null;
let presenceTimer: number | null = null;
let adaptivePollTimer: number | null = null;

void boot();

async function boot(): Promise<void> {
  if (window.location.pathname !== "/") {
    renderNotFound();
    return;
  }

  state.session = await detectSession();
  if (state.session.authenticated && state.session.mode === "live") {
    state.tourPlaying = false;
    state.tourCaptionsVisible = false;
    await syncActiveLiveQuery(true);
  } else {
    await syncPublicLiveControl(true);
  }

  mountShell();
  renderAll();

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

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearAdaptivePollTimer();
      state.currentPollMs = null;
      renderAll();
    } else {
      state.unchangedStreak = 0;
      void runAdaptiveMeshTick();
    }
  });

  startTourTimer();
  startPresenceHeartbeat();
  scheduleNextAdaptivePoll();
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

function viewToQuery(view: TourView, networkTab?: string): TableQuery {
  switch (view) {
    case "overview":
      return "networks";
    case "network":
      if (networkTab === "plugins") return "plugins";
      if (networkTab === "recovery") return "recovery";
      return "hosts";
    case "host":
      return "host";
    case "users":
      return "users";
    case "tests":
      return "tests";
    case "log":
      return "log";
  }
}

function queryToPresenceView(query: TableQuery): TourView {
  switch (query) {
    case "networks":
      return "overview";
    case "hosts":
    case "plugins":
    case "recovery":
      return "network";
    case "host":
      return "host";
    case "users":
      return "users";
    case "tests":
      return "tests";
    case "log":
      return "log";
  }
}

/**
 * Single-query-only live mesh sync: fetches ONLY the endpoint backing the
 * currently displayed table query instead of fanning out to all endpoints.
 */
async function syncActiveLiveQuery(initial = false): Promise<boolean> {
  if (!state.session.authenticated || state.session.mode !== "live") {
    return false;
  }

  if (state.query === "log" && state.testId && /^[a-f0-9]{32}$/.test(state.testId)) {
    if (state.loadedLogCache[state.testId]) {
      return false; // Immutable log already cached: zero network traffic.
    }
    const payload = await fetchOptionalJson(`/api/mesh/test-runs/${state.testId}`);
    const run =
      payload?.run && typeof payload.run === "object"
        ? (payload.run as Record<string, unknown>)
        : null;
    if (!run) return false;
    state.loadedLogCache[state.testId] = {
      testId: state.testId,
      name: typeof run.name === "string" ? run.name : state.testId,
      title: typeof run.title === "string" ? run.title : state.testId,
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
        typeof run.artifact === "string"
          ? run.artifact
          : `logs/${state.testId}.log`,
      log: typeof run.log === "string" ? run.log : "(empty log)",
    };
    return true;
  }

  const endpoint = liveEndpointForQuery(state.query, state.testId);
  if (!endpoint) return false;

  const payload = await fetchOptionalJson(endpoint);
  if (!payload) {
    if (initial && !state.liveRawCache["/api/mesh/state"]) {
      state.liveError = `Authenticated session active, but ${endpoint} did not respond.`;
    }
    return false;
  }

  state.liveError = null;
  const serialized = JSON.stringify(payload);
  const changed = serialized !== state.lastMeshHash;
  state.lastMeshHash = serialized;
  state.liveRawCache[endpoint] = payload;

  const meshPayload =
    state.liveRawCache["/api/mesh/state"] ??
    (endpoint === "/api/mesh/state"
      ? payload
      : {
          nodes: [],
          mesh_config: { channel: state.session.network ?? "live" },
        });

  const adapted = adaptLiveMeshToNetwork({
    hostname: state.session.hostname || window.location.hostname,
    networkName: state.session.network ?? undefined,
    currentUser: state.session.subject,
    mesh: meshPayload,
    plugins: state.liveRawCache["/api/mesh/plugins"] ?? null,
    sessions: state.liveRawCache["/api/mesh/shell/sessions"] ?? null,
    processes: state.liveRawCache["/api/mesh/processes"] ?? null,
    probe: state.liveRawCache["/api/mesh/probe"] ?? null,
    fullState: state.liveRawCache["/api/mesh/full-state"] ?? null,
    tests: state.liveRawCache["/api/mesh/tests"] ?? null,
    users: state.liveRawCache["/api/mesh/users"] ?? null,
  });

  state.networks = [adapted];
  state.networkSlug = adapted.slug;
  if (!adapted.hosts.some((h) => h.name === state.hostName)) {
    state.hostName = adapted.hosts[0]?.name ?? "";
  }
  if (!adapted.tests.some((t) => t.testId === state.testId)) {
    state.testId = adapted.tests[0]?.testId ?? "";
  }
  state.tourSteps = buildLiveTourSteps(adapted);
  return changed;
}

/**
 * Public dialtone.earth live-control sync using ETag / If-None-Match (304 = 0 bytes).
 */
async function syncPublicLiveControl(initial = false): Promise<boolean> {
  if (state.session.authenticated) return false;
  try {
    const headers: Record<string, string> = {};
    if (state.liveEtag) {
      headers["If-None-Match"] = state.liveEtag;
    }
    const response = await fetch("/api/live", {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (response.status === 304) {
      state.notModifiedCount += 1;
      return false;
    }
    if (!response.ok) return false;
    const etag = response.headers.get("ETag");
    if (etag) state.liveEtag = etag;
    const payload = (await response.json()) as Record<string, unknown>;
    if (!payload || typeof payload.revision !== "number") return false;
    const next: LiveSiteState = {
      revision: Math.floor(payload.revision),
      updated_at:
        typeof payload.updated_at === "string" ? payload.updated_at : null,
      updated_by:
        typeof payload.updated_by === "string" ? payload.updated_by : null,
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
    if (!changed) return false;

    state.liveSite = next;
    applyLiveSiteState(next, initial);
    return true;
  } catch {
    return false;
  }
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
    state.query = viewToQuery(live.view);
  }
  if (typeof live.tour_playing === "boolean") {
    state.tourPlaying = live.tour_playing;
    state.tourCaptionsVisible = live.tour_playing;
    if (!initial) {
      if (state.tourPlaying) startTourTimer();
      else clearTourTimer();
    }
  }
  if (!initial) {
    renderAll();
    syncGlobeFocus();
  }
}

function clearAdaptivePollTimer(): void {
  if (adaptivePollTimer !== null) {
    window.clearTimeout(adaptivePollTimer);
    adaptivePollTimer = null;
  }
}

function scheduleNextAdaptivePoll(): void {
  clearAdaptivePollTimer();
  const nextMs = computeAdaptivePollMs({
    unchangedStreak: state.unchangedStreak,
    hidden: document.hidden,
  });
  state.currentPollMs = nextMs;
  if (nextMs === null) return;
  adaptivePollTimer = window.setTimeout(() => {
    void runAdaptiveMeshTick();
  }, nextMs);
}

async function runAdaptiveMeshTick(): Promise<void> {
  if (document.hidden) {
    state.currentPollMs = null;
    return;
  }
  const changed = state.session.authenticated
    ? await syncActiveLiveQuery(false)
    : await syncPublicLiveControl(false);
  if (changed) {
    state.unchangedStreak = 0;
  } else {
    state.unchangedStreak += 1;
  }
  scheduleNextAdaptivePoll();
  renderAll();
}

function triggerImmediateQuerySync(): void {
  state.unchangedStreak = 0;
  if (state.session.authenticated) {
    void syncActiveLiveQuery(false).then(() => {
      scheduleNextAdaptivePoll();
      renderAll();
    });
  } else {
    scheduleNextAdaptivePoll();
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
        view: queryToPresenceView(state.query),
        node: state.query === "networks" ? null : state.hostName || null,
      }),
    });
  } catch {
    // Non-blocking heartbeat
  }
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
  }, PRESENCE_INTERVAL_MS);
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

function buildLiveTourSteps(net: MeshNetwork): TourStep[] {
  const firstHost = net.hosts[0]?.name ?? null;
  const firstTestId = net.tests[0]?.testId;
  return [
    {
      id: "live-overview",
      label: "LIVE OVERVIEW",
      view: "overview",
      networkSlug: net.slug,
      hostName: null,
      headline: `Live mesh ${net.slug} (${net.hosts.length} peers)`,
      caption: `Single-query gossip telemetry for ${net.slug} at minimal adaptive base traffic.`,
    },
    {
      id: "live-hosts",
      label: "LIVE HOSTS",
      view: "network",
      networkSlug: net.slug,
      hostName: null,
      networkTab: "hosts",
      headline: `Live peers on ${net.slug}`,
      caption: `Active Dialtone peers, OS/arch versions, CPU/RAM load, RTTs, and probes.`,
    },
    {
      id: "live-host",
      label: "LIVE HOST",
      view: "host",
      networkSlug: net.slug,
      hostName: firstHost,
      headline: `Inspecting host ${firstHost ?? "origin"}`,
      caption: `Per-host compute telemetry, blob store, and persistent dialtone/shell/1 sessions.`,
    },
    {
      id: "live-users",
      label: "LIVE USERS",
      view: "users",
      networkSlug: net.slug,
      hostName: null,
      headline: `Active members on ${net.slug}`,
      caption: `Signed-in network presence and redacted dialtone-shell audit log.`,
    },
    {
      id: "live-tests",
      label: "LIVE TESTS",
      view: "tests",
      networkSlug: net.slug,
      hostName: null,
      headline: `Recorded tests (${net.tests.length})`,
      caption: `Immutable per-run test results fetched on demand.`,
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
            headline: `Immutable log ${firstTestId.slice(0, 10)}`,
            caption: `Cached once per test-id so repeat reads send zero network traffic.`,
          },
        ]
      : []),
  ];
}

function mountShell(): void {
  document.title = state.session.authenticated
    ? `dialtone.earth — live ${state.networkSlug} mesh`
    : state.liveSite?.title
      ? `${state.liveSite.title} — dialtone.earth`
      : "dialtone.earth — simulated system tour";
  app.innerHTML = `
    <main class="hud-shell earth-minimal-shell">
      <div class="globe-stage"></div>
      <div class="scene-shade" aria-hidden="true"></div>
      <aside class="tour-captions" id="tour-captions" aria-live="polite" data-testid="tour-captions"></aside>
      <section class="bottom-table-dock" id="bottom-table-dock" aria-label="Live mesh query table"></section>
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

function renderAll(): void {
  renderTourCaptions();
  renderBottomTable();
  bindInteractions();
}

/**
 * The ONLY text outside the bottom table: closed-caption text in the top-left
 * strictly when a tour is active.
 */
function renderTourCaptions(): void {
  const ccEl = app.querySelector<HTMLElement>("#tour-captions");
  if (!ccEl) return;

  if (!state.tourCaptionsVisible) {
    ccEl.innerHTML = "";
    ccEl.hidden = true;
    return;
  }

  const net = activeNetwork();
  const isLive = state.session.authenticated && !net.simulated;
  const liveCtrl = !isLive ? state.liveSite : null;
  const step = state.tourSteps[state.tourStepIndex] ?? state.tourSteps[0];
  if (!step) {
    ccEl.innerHTML = "";
    ccEl.hidden = true;
    return;
  }

  const headline = liveCtrl?.headline || step.headline;
  const caption = liveCtrl?.subline || step.caption;

  ccEl.hidden = false;
  ccEl.innerHTML = `
    <div class="cc-line cc-kicker">CC · TOUR ${state.tourStepIndex + 1}/${state.tourSteps.length} · ${escapeHtml(step.label)}</div>
    <div class="cc-line cc-headline">${escapeHtml(headline)}</div>
    <div class="cc-line cc-body">${escapeHtml(caption)}</div>
  `;
}

function renderBottomTable(): void {
  const dockEl = app.querySelector<HTMLElement>("#bottom-table-dock");
  if (!dockEl) return;

  const net = activeNetwork();
  const host = activeHost(net);
  const testRun = activeTestRun(net);
  const summary = summarizeSystemResources(state.networks);
  const isLive = state.session.authenticated && !net.simulated;
  const liveCtrl = !isLive ? state.liveSite : null;

  const brand = liveCtrl?.title || "dialtone // earth";
  const statusPill = isLive
    ? `<span class="tbl-pill is-live" data-testid="live-badge">● LIVE · ${escapeHtml(net.slug)}</span>`
    : liveCtrl?.badge
      ? `<span class="tbl-pill is-live" data-testid="live-cli-badge">● ${escapeHtml(liveCtrl.badge)}</span>`
      : `<span class="tbl-pill is-sim" data-testid="simulated-badge">○ SIM · ${summary.onlineNodes}/${summary.totalNodes}</span>`;

  const cadenceText = formatCadenceLabel(
    state.currentPollMs,
    state.unchangedStreak,
    state.notModifiedCount,
  );

  const authAction = isLive
    ? `<a class="tbl-chip" data-testid="auth-logout" href="${escapeHtml(state.session.logout_url || "/cdn-cgi/access/logout")}">sign out</a>`
    : state.session.login_url
      ? `<a class="tbl-chip" data-testid="auth-login" href="${escapeHtml(state.session.login_url)}">sign in</a>`
      : "";

  const networkPicker =
    state.query !== "networks" && state.networks.length > 1
      ? `<span class="tbl-net-group">${state.networks
          .map(
            (n) =>
              `<button type="button" class="tbl-chip ${n.slug === net.slug ? "is-active" : ""}" data-switch-network="${escapeHtml(n.slug)}">${escapeHtml(n.slug)}</button>`,
          )
          .join("")}</span>`
      : "";

  const queryButtons = QUERY_TABS.map((tab) => {
    const active =
      state.query === tab.id || (state.query === "host" && tab.id === "hosts")
        ? "is-active"
        : "";
    return `<button type="button" class="tbl-tab ${active}" data-query="${tab.id}">${tab.label}</button>`;
  }).join("");

  const inlineNotice = state.liveError
    ? `<tr class="tbl-notice-row is-warn"><td colspan="8">${escapeHtml(state.liveError)}</td></tr>`
    : liveCtrl?.banner
      ? `<tr class="tbl-notice-row is-live" data-testid="live-cli-banner"><td colspan="8"><span class="tbl-dot is-low"></span><strong>REV #${liveCtrl.revision}</strong> ${escapeHtml(liveCtrl.banner)}${!state.tourCaptionsVisible && liveCtrl.headline ? ` — <em>${escapeHtml(liveCtrl.headline)}</em>` : ""}</td></tr>`
      : !state.tourCaptionsVisible && liveCtrl?.headline
        ? `<tr class="tbl-notice-row is-live"><td colspan="8"><span class="tbl-dot is-low"></span><strong>${escapeHtml(liveCtrl.headline)}</strong>${liveCtrl.subline ? ` — ${escapeHtml(liveCtrl.subline)}` : ""}</td></tr>`
        : "";

  const { columns, rowsHtml, queryDescriptor } = buildSingleQueryTable(
    net,
    host,
    testRun,
  );

  dockEl.innerHTML = `
    <div class="earth-table-frame">
      <div class="earth-table-bar">
        <div class="earth-bar-left">
          <a class="tbl-brand" href="/">${escapeHtml(brand)}</a>
          ${statusPill}
          <span class="tbl-query-id" data-testid="active-query">QUERY: ${escapeHtml(queryDescriptor)}</span>
          ${networkPicker}
        </div>
        <div class="earth-bar-tabs" role="tablist" aria-label="Single active table query">
          ${queryButtons}
        </div>
        <div class="earth-bar-right">
          <span class="tbl-cadence" data-testid="mesh-cadence" title="Adaptive gossip sync interval with ETag/304 backoff">${escapeHtml(cadenceText)}</span>
          <button type="button" class="tbl-chip" data-action="prev-step" title="Previous tour step">◀</button>
          <button type="button" class="tbl-chip ${state.tourPlaying ? "is-active" : ""}" data-action="toggle-tour" aria-pressed="${state.tourPlaying}">${state.tourPlaying ? "⏸ tour" : "▶ tour"}</button>
          <button type="button" class="tbl-chip" data-action="next-step" title="Next tour step">▶</button>
          ${authAction}
        </div>
      </div>
      <div class="earth-table-scroll">
        <table class="earth-table" data-testid="earth-table">
          <thead>
            ${inlineNotice}
            <tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function buildSingleQueryTable(
  net: MeshNetwork,
  host: MeshHost | null,
  testRun: SimTestRun | null,
): { columns: string[]; rowsHtml: string; queryDescriptor: string } {
  if (state.query === "networks") {
    const rowsHtml = state.networks
      .map((n) => {
        const agg = aggregateNetwork(n.snapshot);
        const online = n.hosts.filter((h) => h.online).length;
        const pass = n.tests.filter((t) => t.status === "pass").length;
        const selected = n.slug === state.networkSlug ? "is-selected" : "";
        return `<tr class="is-clickable ${selected}" data-select-network="${escapeHtml(n.slug)}">
          <td class="c-strong"><span class="tbl-dot ${online === n.hosts.length ? "is-low" : "is-med"}"></span>${escapeHtml(n.slug)}</td>
          <td>${online}/${n.hosts.length}</td>
          <td>${escapeHtml(agg.cpu)}</td>
          <td>${escapeHtml(agg.memory)}</td>
          <td>${escapeHtml(agg.gpuMemory)}</td>
          <td>${n.blobStore.objects} (${Math.round(n.blobStore.totalBytes / 1_000_000)} MB)</td>
          <td>${pass}/${n.tests.length} pass</td>
        </tr>`;
      })
      .join("");
    return {
      columns: ["NETWORK", "NODES", "CPU", "RAM", "GPU", "BLOBS", "TESTS"],
      rowsHtml,
      queryDescriptor: "networks",
    };
  }

  if (state.query === "hosts") {
    const rowsHtml =
      net.hosts
        .map((h) => {
          const cpuPct = h.stats.cpu_percent ?? 0;
          const memPct = h.stats.mem_percent ?? 0;
          const loadClass =
            Math.max(cpuPct, memPct) >= 80
              ? "is-high"
              : Math.max(cpuPct, memPct) >= 55
                ? "is-med"
                : "is-low";
          const selected = h.name === state.hostName ? "is-selected" : "";
          const rtt =
            typeof h.rtt_ms === "number" && h.rtt_ms > 0
              ? `${h.rtt_ms.toFixed(1)} ms`
              : "local";
          const memUsed = ((h.stats.mem_used_bytes ?? 0) / 1e9).toFixed(1);
          const memTotal = ((h.stats.mem_total_bytes ?? 0) / 1e9).toFixed(0);
          return `<tr class="is-clickable ${selected}" data-select-host="${escapeHtml(h.name)}">
            <td class="c-strong"><span class="tbl-dot ${loadClass}"></span>${escapeHtml(h.name)}</td>
            <td>${escapeHtml(h.os)}/${escapeHtml(h.arch)}</td>
            <td>${cpuPct.toFixed(0)}% (${h.stats.cpu_cores ?? 0}c)</td>
            <td>${memUsed}/${memTotal} GB</td>
            <td>${escapeHtml(rtt)}</td>
            <td>${h.blobStore.objects}</td>
            <td>${escapeHtml(h.probeSummary)}</td>
          </tr>`;
        })
        .join("") ||
      `<tr><td colspan="7" class="c-dim">No hosts reported in ${escapeHtml(net.slug)}.</td></tr>`;
    return {
      columns: ["HOST", "OS/ARCH", "CPU", "RAM", "RTT", "BLOBS", "PROBES"],
      rowsHtml,
      queryDescriptor: `hosts · ${net.slug}`,
    };
  }

  if (state.query === "host" && host) {
    const cpuPct = (host.stats.cpu_percent ?? 0).toFixed(1);
    const load1m = (host.stats.load_avg_1m ?? 0).toFixed(2);
    const memUsed = ((host.stats.mem_used_bytes ?? 0) / 1e9).toFixed(1);
    const memTotal = ((host.stats.mem_total_bytes ?? 0) / 1e9).toFixed(0);
    const diskUsed = ((host.stats.disk_used_bytes ?? 0) / 1e9).toFixed(0);
    const diskTotal = ((host.stats.disk_total_bytes ?? 0) / 1e9).toFixed(0);
    const gpuUsed = ((host.stats.gpu_mem_used_bytes ?? 0) / 1e9).toFixed(1);
    const gpuTotal = ((host.stats.gpu_mem_total_bytes ?? 0) / 1e9).toFixed(0);
    const blobMb = (host.blobStore.totalBytes / 1e6).toFixed(1);
    const rows: Array<[string, string, string]> = [
      [
        "host",
        `${host.name} (${host.os}/${host.arch})`,
        `v${host.version} · ${host.relay_region} · ${host.probeSummary}`,
      ],
      [
        "compute",
        `CPU ${cpuPct}% (${host.stats.cpu_cores ?? 0}c, load ${load1m})`,
        `RAM ${memUsed}/${memTotal} GB · DISK ${diskUsed}/${diskTotal} GB${host.gpuName ? ` · GPU ${host.gpuName} (${gpuUsed}/${gpuTotal} GB)` : ""}`,
      ],
      [
        "blobs",
        `${host.blobStore.objects} objects (${blobMb} MB)`,
        host.blobStore.recentTransfer || "content-addressed iroh-blobs store",
      ],
      ...host.processes.map(
        (p): [string, string, string] => [
          `proc:${p.name}`,
          `${p.status} (pid=${p.pid}, restarts=${p.restarts})`,
          p.digest,
        ],
      ),
      ...host.sessions.map(
        (s): [string, string, string] => [
          `shell:${s.name}`,
          `${s.shell} · ${s.status} · ${s.cwd}`,
          `$ ${s.lastCommand}`,
        ],
      ),
    ];
    const rowsHtml = rows
      .map(
        ([k, v, detail]) => `<tr>
          <td class="c-strong">${escapeHtml(k)}</td>
          <td>${escapeHtml(v)}</td>
          <td class="c-dim">${escapeHtml(detail)}</td>
        </tr>`,
      )
      .join("");
    return {
      columns: ["RESOURCE", "STATE", "DETAIL"],
      rowsHtml,
      queryDescriptor: `host · ${host.name}`,
    };
  }

  if (state.query === "plugins") {
    const rowsHtml =
      net.plugins
        .map(
          (p) => `<tr>
          <td class="c-strong"><span class="tbl-dot ${p.status === "deployed" ? "is-low" : "is-med"}"></span>${escapeHtml(p.name)}</td>
          <td>v${escapeHtml(p.version)}</td>
          <td>${escapeHtml(p.protocol)}</td>
          <td>${escapeHtml(p.runtime)}</td>
          <td>${(p.sizeBytes / 1024).toFixed(0)} KB</td>
          <td>${escapeHtml(p.status)}</td>
        </tr>`,
        )
        .join("") ||
      `<tr><td colspan="6" class="c-dim">No plugins deployed on ${escapeHtml(net.slug)}.</td></tr>`;
    return {
      columns: ["PLUGIN", "VER", "PROTOCOL", "RUNTIME", "SIZE", "STATUS"],
      rowsHtml,
      queryDescriptor: `plugins · ${net.slug}`,
    };
  }

  if (state.query === "recovery") {
    const rowsHtml =
      net.recoveryEvents
        .map(
          (ev) => `<tr>
          <td class="c-strong">${escapeHtml(ev.host)}</td>
          <td><span class="tbl-dot ${ev.stage === "verified" ? "is-low" : "is-med"}"></span>${escapeHtml(ev.stage)}</td>
          <td>${escapeHtml(ev.trigger)}</td>
          <td>${escapeHtml(ev.action)}</td>
          <td>${ev.recoveryMs} ms</td>
          <td class="c-dim">${escapeHtml(ev.probeAfter)}</td>
        </tr>`,
        )
        .join("") ||
      `<tr><td colspan="6" class="c-dim">No recovery events recorded on ${escapeHtml(net.slug)}.</td></tr>`;
    return {
      columns: ["HOST", "STAGE", "TRIGGER", "ACTION", "RECOVERY", "PROBE"],
      rowsHtml,
      queryDescriptor: `recovery · ${net.slug}`,
    };
  }

  if (state.query === "users") {
    const rowsHtml =
      net.users
        .map((u) => {
          const locs = u.locations
            .map((l) => `${l.location} [${l.viewingNode || l.viewingView}]`)
            .join("; ");
          return `<tr>
            <td class="c-strong"><span class="tbl-dot ${u.status === "active" ? "is-low" : "is-med"}"></span>${escapeHtml(u.email)}</td>
            <td>${escapeHtml(u.role)}</td>
            <td>${escapeHtml(u.status)}</td>
            <td>${escapeHtml(locs || "—")}</td>
            <td>${escapeHtml(u.shellNodes.join(", ") || "—")}</td>
          </tr>`;
        })
        .join("") ||
      `<tr><td colspan="5" class="c-dim">No active users on ${escapeHtml(net.slug)}.</td></tr>`;
    return {
      columns: ["USER", "ROLE", "STATUS", "LOCATIONS / VIEW", "SHELL NODES"],
      rowsHtml,
      queryDescriptor: `users · ${net.slug}`,
    };
  }

  if (state.query === "tests") {
    const rowsHtml =
      net.tests
        .map((t) => {
          const dot =
            t.status === "pass"
              ? "is-low"
              : t.status === "fail"
                ? "is-high"
                : "is-med";
          const selected = t.testId === state.testId ? "is-selected" : "";
          return `<tr class="is-clickable ${selected}" data-open-log="${escapeHtml(t.testId)}">
            <td class="c-strong"><span class="tbl-dot ${dot}"></span>${escapeHtml(t.title)}</td>
            <td>${escapeHtml(t.status.toUpperCase())}</td>
            <td>${escapeHtml(t.elapsed)}s</td>
            <td class="c-dim">${escapeHtml(t.timestamp)}</td>
            <td class="c-dim">${escapeHtml(t.testId.slice(0, 12))}…</td>
          </tr>`;
        })
        .join("") ||
      `<tr><td colspan="5" class="c-dim">No test runs recorded on ${escapeHtml(net.slug)}.</td></tr>`;
    return {
      columns: ["TEST", "STATUS", "ELAPSED", "TIMESTAMP", "ID"],
      rowsHtml,
      queryDescriptor: `tests · ${net.slug}`,
    };
  }

  // query === "log"
  if (!testRun) {
    return {
      columns: ["LINE", "OUTPUT"],
      rowsHtml: `<tr><td colspan="2" class="c-dim">Select a test run to inspect its immutable log.</td></tr>`,
      queryDescriptor: `log · none`,
    };
  }
  const lines = [
    `$ ${testRun.command}   [${testRun.status.toUpperCase()} · ${testRun.elapsed}s · ${testRun.artifact}]`,
    ...testRun.log.split(/\r?\n/),
  ];
  const rowsHtml = lines
    .map(
      (line, idx) => `<tr>
        <td class="c-dim">${idx + 1}</td>
        <td class="c-mono-line">${escapeHtml(line)}</td>
      </tr>`,
    )
    .join("");
  return {
    columns: ["#", `LOG · ${testRun.title}`],
    rowsHtml,
    queryDescriptor: `log · ${testRun.testId.slice(0, 10)}`,
  };
}

function bindInteractions(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-query]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.dataset.query as TableQuery | undefined;
      if (!q) return;
      exitTour();
      state.query = q;
      renderAll();
      syncGlobeFocus();
      triggerImmediateQuerySync();
      void reportLivePresence();
    });
  });

  app
    .querySelectorAll<HTMLButtonElement>("[data-switch-network]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.dataset.switchNetwork;
        if (!slug) return;
        const net =
          state.networks.find((n) => n.slug === slug) ?? state.networks[0];
        exitTour();
        state.networkSlug = net.slug;
        state.hostName = net.hosts[0]?.name ?? "";
        state.testId = net.tests[0]?.testId ?? "";
        renderAll();
        syncGlobeFocus();
      });
    });

  app
    .querySelectorAll<HTMLElement>("[data-select-network]")
    .forEach((row) => {
      row.addEventListener("click", () => {
        const slug = row.dataset.selectNetwork;
        if (!slug) return;
        const net =
          state.networks.find((n) => n.slug === slug) ?? state.networks[0];
        exitTour();
        state.networkSlug = net.slug;
        state.hostName = net.hosts[0]?.name ?? "";
        state.testId = net.tests[0]?.testId ?? "";
        state.query = "hosts";
        renderAll();
        syncGlobeFocus();
        triggerImmediateQuerySync();
      });
    });

  app.querySelectorAll<HTMLElement>("[data-select-host]").forEach((row) => {
    row.addEventListener("click", () => {
      const hostName = row.dataset.selectHost;
      if (!hostName) return;
      exitTour();
      state.hostName = hostName;
      state.query = "host";
      renderAll();
      syncGlobeFocus();
      void reportLivePresence();
    });
  });

  app.querySelectorAll<HTMLElement>("[data-open-log]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.openLog;
      if (!id) return;
      exitTour();
      state.testId = id;
      state.query = "log";
      renderAll();
      triggerImmediateQuerySync();
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
      state.tourCaptionsVisible = state.tourPlaying;
      if (state.tourPlaying) startTourTimer();
      else clearTourTimer();
      renderAll();
    });
}

function applyTourStep(index: number, keepPlaying: boolean): void {
  const step = state.tourSteps[index];
  if (!step) return;
  state.tourStepIndex = index;
  state.tourCaptionsVisible = true;
  state.query = viewToQuery(step.view, step.networkTab);
  if (step.networkSlug) {
    state.networkSlug = step.networkSlug;
    const net = activeNetwork();
    state.hostName = step.hostName ?? net.hosts[0]?.name ?? "";
    state.testId = step.testId ?? net.tests[0]?.testId ?? "";
  }
  if (!keepPlaying) {
    state.tourPlaying = false;
    clearTourTimer();
  }
  renderAll();
  syncGlobeFocus();
  if (state.session.authenticated) {
    triggerImmediateQuerySync();
  }
}

function syncGlobeFocus(): void {
  if (!globeController) return;
  if (state.query === "networks") {
    globeController.focusTarget(null, null);
  } else if (state.query === "host") {
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

function exitTour(): void {
  state.tourPlaying = false;
  state.tourCaptionsVisible = false;
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
