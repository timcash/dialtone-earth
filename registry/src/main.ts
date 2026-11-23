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
  bestEffortIntervalMs,
  createCustomQuery,
  createDefaultQuerySet,
  defaultSourceForKind,
  normalizePaneAssignments,
  SPLIT_LAYOUTS,
  tickSimulatedQuery,
  type QuerySource,
  type RateTier,
  type SavedQuery,
  type SplitLayout,
} from "./query-workspace";
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
  fullscreen: boolean | null;
};

type AppState = {
  session: SessionInfo;
  liveSite: LiveSiteState | null;
  liveEtag: string | null;
  networks: MeshNetwork[];
  tourSteps: TourStep[];
  queries: SavedQuery[];
  layout: SplitLayout;
  paneQueryIds: string[];
  activePaneIndex: number;
  composerOpen: boolean;
  networkSlug: string;
  hostName: string;
  testId: string;
  tourPlaying: boolean;
  tourCaptionsVisible: boolean;
  tableMinimized: boolean;
  tableFullscreen: boolean;
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
const QUERY_SCHEDULER_TICK_MS = 1_000;

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("Missing app root");
const app: HTMLDivElement = appElement;

const initialQueries = createDefaultQuerySet(SIMULATED_NETWORKS);

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
  queries: initialQueries,
  layout: "1",
  paneQueryIds: [initialQueries[0].id],
  activePaneIndex: 0,
  composerOpen: false,
  networkSlug: SIMULATED_NETWORKS[0].slug,
  hostName: SIMULATED_NETWORKS[0].hosts[0].name,
  testId:
    SIMULATED_NETWORKS[0].tests[4]?.testId ??
    SIMULATED_NETWORKS[0].tests[0].testId,
  tourPlaying: true,
  tourCaptionsVisible: true,
  tableMinimized: true,
  tableFullscreen: false,
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
let querySchedulerTimer: number | null = null;
let schedulerTickSeq = 0;

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
    state.tableMinimized = false;
    await syncActiveLiveQuery(true);
    state.queries = createDefaultQuerySet(state.networks);
    state.paneQueryIds = normalizePaneAssignments(
      [],
      state.queries,
      state.layout,
    );
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
      { includeSimulatedGeodata: !state.session.authenticated },
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.tableFullscreen) {
      state.tableFullscreen = false;
      renderAll();
    }
  });

  startTourTimer();
  startPresenceHeartbeat();
  scheduleNextAdaptivePoll();
  startBestEffortQueryScheduler();
}

function getQueryById(id: string | undefined): SavedQuery {
  return (
    state.queries.find((q) => q.id === id) ??
    state.queries[0]
  );
}

function activePaneQuery(): SavedQuery {
  const id = state.paneQueryIds[state.activePaneIndex] ?? state.paneQueryIds[0];
  return getQueryById(id);
}

function visiblePaneQueries(): SavedQuery[] {
  if (state.tableMinimized && !state.tableFullscreen) {
    return [];
  }
  return state.paneQueryIds.map((id) => getQueryById(id));
}

function isQueryVisible(queryId: string): boolean {
  if (state.tableMinimized && !state.tableFullscreen) return false;
  return state.paneQueryIds.includes(queryId);
}

function ensureQueryForKind(kind: TableQuery, networkSlug?: string): SavedQuery {
  const targetNet = networkSlug || state.networkSlug;
  const exact = state.queries.find(
    (q) => q.kind === kind && (kind === "networks" || q.networkSlug === targetNet),
  );
  if (exact) return exact;
  const byKind = state.queries.find((q) => q.kind === kind);
  if (byKind) {
    if (networkSlug) byKind.networkSlug = networkSlug;
    return byKind;
  }
  const created = createCustomQuery(state.queries, {
    kind,
    source: defaultSourceForKind(kind),
    networkSlug: targetNet,
    rate: "med",
  });
  state.queries.push(created);
  return created;
}

function assignQueryToActivePane(queryId: string): void {
  state.paneQueryIds = normalizePaneAssignments(
    state.paneQueryIds,
    state.queries,
    state.layout,
  );
  const idx = Math.min(
    Math.max(0, state.activePaneIndex),
    Math.max(0, state.paneQueryIds.length - 1),
  );
  state.paneQueryIds[idx] = queryId;
  const q = getQueryById(queryId);
  state.networkSlug = q.networkSlug;
  const net = networkBySlug(q.networkSlug);
  if (!net.hosts.some((h) => h.name === state.hostName)) {
    state.hostName = net.hosts[0]?.name ?? "";
  }
  if (!net.tests.some((t) => t.testId === state.testId)) {
    state.testId = net.tests[0]?.testId ?? "";
  }
  q.nextDueAtMs = Date.now();
}

function startBestEffortQueryScheduler(): void {
  if (querySchedulerTimer !== null) {
    window.clearInterval(querySchedulerTimer);
    querySchedulerTimer = null;
  }
  querySchedulerTimer = window.setInterval(() => {
    if (document.hidden) return;
    const visible = visiblePaneQueries();
    if (visible.length === 0) {
      // Minimized: zero query-plane traffic (only mesh-formation base plane runs)
      for (const q of state.queries) {
        q.estBytesPerSec = 0;
      }
      return;
    }

    const visibleIds = new Set(visible.map((q) => q.id));
    for (const q of state.queries) {
      if (!visibleIds.has(q.id)) {
        q.estBytesPerSec = 0;
      }
    }

    const nowMs = Date.now();
    let anyTouched = false;
    const deduped = new Map<string, SavedQuery>();
    for (const q of visible) {
      deduped.set(q.id, q);
    }

    for (const q of deduped.values()) {
      if (nowMs < q.nextDueAtMs) continue;
      schedulerTickSeq += 1;
      if (state.session.authenticated) {
        void syncSingleLiveQuery(q).then((changed) => {
          if (changed) renderAll();
        });
      } else {
        tickSimulatedQuery(q, state.networks, nowMs, schedulerTickSeq);
      }
      const nextMs =
        bestEffortIntervalMs(q.rate, q.unchangedStreak, document.hidden) ??
        30_000;
      q.nextDueAtMs = nowMs + nextMs;
      anyTouched = true;
    }

    if (anyTouched && !state.composerOpen) {
      renderAll();
    }
  }, QUERY_SCHEDULER_TICK_MS);
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

function viewToQueryKind(view: TourView, networkTab?: string): TableQuery {
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

async function syncSingleLiveQuery(q: SavedQuery): Promise<boolean> {
  if (!state.session.authenticated || state.session.mode !== "live") {
    return false;
  }
  q.ticks += 1;
  const changed = await syncLiveEndpointForKind(q.kind, false);
  if (changed) {
    q.deltas += 1;
    q.unchangedStreak = 0;
    q.lastUpdatedAt = new Date().toISOString().slice(11, 19) + "Z";
    q.estBytesPerSec = 140;
  } else {
    q.notModified += 1;
    q.unchangedStreak += 1;
    q.estBytesPerSec = 8;
  }
  return changed;
}

async function syncActiveLiveQuery(initial = false): Promise<boolean> {
  return syncLiveEndpointForKind(activePaneQuery().kind, initial);
}

async function syncLiveEndpointForKind(
  kind: TableQuery,
  initial: boolean,
): Promise<boolean> {
  if (!state.session.authenticated || state.session.mode !== "live") {
    return false;
  }

  if (kind === "log" && state.testId && /^[a-f0-9]{32}$/.test(state.testId)) {
    if (state.loadedLogCache[state.testId]) {
      return false;
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

  const endpoint = liveEndpointForQuery(kind, state.testId);
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
      fullscreen:
        typeof payload.fullscreen === "boolean" ? payload.fullscreen : null,
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
    const q = ensureQueryForKind(
      viewToQueryKind(live.view),
      live.network ?? undefined,
    );
    assignQueryToActivePane(q.id);
  }
  if (typeof live.tour_playing === "boolean") {
    state.tourPlaying = live.tour_playing;
    state.tourCaptionsVisible = live.tour_playing;
    if (!initial) {
      if (state.tourPlaying) startTourTimer();
      else clearTourTimer();
    }
  }
  if (typeof live.fullscreen === "boolean") {
    state.tableFullscreen = live.fullscreen;
    if (live.fullscreen) {
      state.tableMinimized = false;
    }
  } else {
    state.tableFullscreen = false;
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
  if (!state.composerOpen) {
    renderAll();
  }
}

async function reportLivePresence(): Promise<void> {
  if (!state.session.authenticated || state.session.mode !== "live") return;
  const activeQ = activePaneQuery();
  try {
    await fetch("/api/mesh/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        view: queryToPresenceView(activeQ.kind),
        node: activeQ.kind === "networks" ? null : state.hostName || null,
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
      caption: `Open tables subscribe on a best-effort basis; minimized tables drop back to base mesh-formation metadata only.`,
    },
    {
      id: "live-hosts",
      label: "LIVE HOSTS",
      view: "network",
      networkSlug: net.slug,
      hostName: null,
      networkTab: "hosts",
      headline: `Live peers on ${net.slug}`,
      caption: `Active Dialtone channel query for peer OS/arch, CPU/RAM, RTTs, and probes.`,
    },
    {
      id: "live-host",
      label: "LIVE HOST",
      view: "host",
      networkSlug: net.slug,
      hostName: firstHost,
      headline: `Inspecting host ${firstHost ?? "origin"}`,
      caption: `Single-host telemetry, blob store, and dialtone/shell/1 sessions.`,
    },
    {
      id: "live-users",
      label: "LIVE USERS",
      view: "users",
      networkSlug: net.slug,
      hostName: null,
      headline: `Cloudflare Gateway Users (${net.slug})`,
      caption: `Cloudflare edge presence and redacted dialtone-shell audit log.`,
    },
    {
      id: "live-tests",
      label: "LIVE TESTS",
      view: "tests",
      networkSlug: net.slug,
      hostName: null,
      headline: `Recorded tests (${net.tests.length})`,
      caption: `Immutable per-run test results queried on demand.`,
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
            caption: `Cached once per test-id for zero repeat bandwidth.`,
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
      <section class="bottom-table-dock" id="bottom-table-dock" aria-label="Live mesh query workspace"></section>
    </main>
  `;
}

function networkBySlug(slug: string): MeshNetwork {
  return (
    state.networks.find((n) => n.slug === slug) ??
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
  state.paneQueryIds = normalizePaneAssignments(
    state.paneQueryIds,
    state.queries,
    state.layout,
  );
  if (state.activePaneIndex >= state.paneQueryIds.length) {
    state.activePaneIndex = 0;
  }
  const shell = app.querySelector<HTMLElement>(".hud-shell");
  if (shell) {
    shell.classList.toggle("is-table-fullscreen", state.tableFullscreen);
    shell.classList.toggle(
      "is-table-minimized",
      !state.tableFullscreen && state.tableMinimized,
    );
  }
  renderTourCaptions();
  renderBottomWorkspace();
  bindInteractions();
}

function renderTourCaptions(): void {
  const ccEl = app.querySelector<HTMLElement>("#tour-captions");
  if (!ccEl) return;

  if (state.tableFullscreen) {
    ccEl.innerHTML = "";
    ccEl.hidden = true;
    return;
  }

  const controlsHtml = `
    <span class="cc-controls">
      <button type="button" class="tbl-chip" data-action="prev-step" title="Previous tour step">◀</button>
      <button type="button" class="tbl-chip ${state.tourPlaying ? "is-active" : ""}" data-action="toggle-tour" data-testid="toggle-tour" aria-pressed="${state.tourPlaying}">${state.tourPlaying ? "⏸ tour" : "▶ tour"}</button>
      <button type="button" class="tbl-chip" data-action="next-step" title="Next tour step">▶</button>
    </span>
  `;

  if (!state.tourCaptionsVisible) {
    ccEl.hidden = false;
    ccEl.innerHTML = `<div class="cc-head-row">${controlsHtml}</div>`;
    return;
  }

  const net = networkBySlug(state.networkSlug);
  const isLive = state.session.authenticated && !net.simulated;
  const liveCtrl = !isLive ? state.liveSite : null;
  const step = state.tourSteps[state.tourStepIndex] ?? state.tourSteps[0];
  if (!step) {
    ccEl.hidden = false;
    ccEl.innerHTML = `<div class="cc-head-row">${controlsHtml}</div>`;
    return;
  }

  const headline = liveCtrl?.headline || step.headline;
  const caption = liveCtrl?.subline || step.caption;

  ccEl.hidden = false;
  ccEl.innerHTML = `
    <div class="cc-head-row">
      <span class="cc-line cc-kicker">CC · TOUR ${state.tourStepIndex + 1}/${state.tourSteps.length} · ${escapeHtml(step.label)}</span>
      ${controlsHtml}
    </div>
    <div class="cc-line cc-headline">${escapeHtml(headline)}</div>
    <div class="cc-line cc-body">${escapeHtml(caption)}</div>
  `;
}

function renderBottomWorkspace(): void {
  const dockEl = app.querySelector<HTMLElement>("#bottom-table-dock");
  if (!dockEl) return;

  const summary = summarizeSystemResources(state.networks);
  const primaryNet = networkBySlug(state.networkSlug);
  const isLive = state.session.authenticated && !primaryNet.simulated;
  const liveCtrl = !isLive ? state.liveSite : null;

  const brand = liveCtrl?.title || "dialtone // earth";
  const statusPill = isLive
    ? `<span class="tbl-pill is-live" data-testid="live-badge">LIVE · ${escapeHtml(primaryNet.slug)}</span>`
    : liveCtrl?.badge
      ? `<span class="tbl-pill is-live" data-testid="live-cli-badge">${escapeHtml(liveCtrl.badge)}</span>`
      : `<span class="tbl-pill is-sim" data-testid="simulated-badge">SIM · ${summary.onlineNodes}/${summary.totalNodes}</span>`;

  const visible = visiblePaneQueries();
  const totalBps = visible.reduce((acc, q) => acc + q.estBytesPerSec, 0);
  const baseCadence = formatCadenceLabel(
    state.currentPollMs,
    state.unchangedStreak,
    state.notModifiedCount,
  );
  const trafficSummary =
    visible.length === 0
      ? `BASE ONLY · 0 B/s · ${baseCadence}`
      : `${visible.length} ACTIVE · ${totalBps} B/s · ${baseCadence}`;

  const authAction = isLive
    ? `<a class="tbl-chip" data-testid="auth-logout" href="${escapeHtml(state.session.logout_url || "/cdn-cgi/access/logout")}">sign out</a>`
    : state.session.login_url
      ? `<a class="tbl-chip" data-testid="auth-login" href="${escapeHtml(state.session.login_url)}">sign in</a>`
      : "";

  const activeQ = activePaneQuery();
  const queryChips = state.queries
    .map((q) => {
      const isFocused = !state.tableMinimized && q.id === activeQ.id;
      const isShown = isQueryVisible(q.id);
      const cls = isFocused
        ? "is-active"
        : isShown
          ? "is-shown"
          : "";
      const rmBtn =
        state.queries.length > 1 && q.id.startsWith("q-custom-")
          ? `<span class="tbl-rm" data-remove-query="${escapeHtml(q.id)}" title="Remove query">×</span>`
          : "";
      return `<button type="button" class="tbl-tab ${cls}" data-pick-query="${escapeHtml(q.id)}" title="${escapeHtml(q.source)} · rate=${escapeHtml(q.rate)}">${escapeHtml(q.label)}${rmBtn}</button>`;
    })
    .join("");

  const layoutButtons = SPLIT_LAYOUTS.map((item) => {
    const active = state.layout === item.id ? "is-active" : "";
    return `<button type="button" class="tbl-chip ${active}" data-layout-btn="${item.id}" data-testid="layout-${item.id.replace(/[^a-z0-9]/gi, "_")}" title="${escapeHtml(item.title)}">${escapeHtml(item.label)}</button>`;
  }).join("");

  const composerHtml = state.composerOpen
    ? `<form class="query-composer" id="query-composer" data-testid="query-composer">
        <span class="c-dim">NEW QUERY</span>
        <select name="kind" aria-label="Query kind">
          <option value="networks">networks</option>
          <option value="hosts" selected>hosts</option>
          <option value="host">host</option>
          <option value="plugins">plugins</option>
          <option value="users">users</option>
          <option value="recovery">recovery</option>
          <option value="tests">tests</option>
          <option value="log">log</option>
        </select>
        <select name="network" aria-label="Network">
          ${state.networks.map((n) => `<option value="${escapeHtml(n.slug)}" ${n.slug === state.networkSlug ? "selected" : ""}>${escapeHtml(n.slug)}</option>`).join("")}
        </select>
        <select name="source" aria-label="Source plane">
          <option value="channel">dialtone channel</option>
          <option value="cloudflare">cloudflare gateway</option>
        </select>
        <select name="rate" aria-label="Best-effort data rate">
          <option value="base">base (30s)</option>
          <option value="slow">slow (10s)</option>
          <option value="med" selected>med (4s)</option>
          <option value="fast">fast (1.5s)</option>
        </select>
        <input type="text" name="label" placeholder="label (optional)" maxlength="32" />
        <button type="submit" class="tbl-chip is-active" data-testid="composer-add">add</button>
        <button type="button" class="tbl-chip" data-action="close-composer">cancel</button>
      </form>`
    : "";

  const liveBannerBar = state.liveError
    ? `<div class="tbl-banner-bar is-warn">${escapeHtml(state.liveError)}</div>`
    : liveCtrl?.banner
      ? `<div class="tbl-banner-bar is-live" data-testid="live-cli-banner"><strong>REV #${liveCtrl.revision}</strong> ${escapeHtml(liveCtrl.banner)}</div>`
      : "";

  const panesHtml = state.paneQueryIds
    .map((qId, paneIndex) => renderQueryPane(getQueryById(qId), paneIndex))
    .join("");

  dockEl.innerHTML = `
    <div class="earth-table-frame">
      <div class="earth-table-bar">
        <div class="earth-bar-left">
          <a class="tbl-brand" href="/">${escapeHtml(brand)}</a>
          ${statusPill}
          <span class="tbl-cadence" data-testid="mesh-cadence">${escapeHtml(trafficSummary)}</span>
        </div>
        <div class="earth-bar-tabs" role="tablist" aria-label="Query set">
          ${queryChips}
          <button type="button" class="tbl-chip ${state.composerOpen ? "is-active" : ""}" data-action="toggle-composer" data-testid="toggle-composer">+ query</button>
        </div>
        <div class="earth-bar-right">
          <span class="tbl-split-group" aria-label="Split table layout">${layoutButtons}</span>
          <button type="button" class="tbl-chip ${!state.tableMinimized && !state.tableFullscreen ? "is-active" : ""}" data-action="toggle-minimize" data-testid="toggle-minimize" aria-pressed="${state.tableMinimized}">${state.tableMinimized ? "table" : "min"}</button>
          <button type="button" class="tbl-chip ${state.tableFullscreen ? "is-active" : ""}" data-action="toggle-fullscreen" data-testid="toggle-fullscreen" aria-pressed="${state.tableFullscreen}">${state.tableFullscreen ? "dock" : "full"}</button>
          ${authAction}
        </div>
      </div>
      ${liveBannerBar}
      ${composerHtml}
      <div class="earth-split-grid" data-layout="${state.layout}" data-testid="split-grid">
        ${panesHtml}
      </div>
    </div>
  `;
}

function renderQueryPane(query: SavedQuery, paneIndex: number): string {
  const net = networkBySlug(query.networkSlug);
  const host = activeHost(net);
  const testRun = activeTestRun(net);
  const { columns, rowsHtml } = buildSingleQueryTable(query, net, host, testRun);
  const focused = paneIndex === state.activePaneIndex ? "is-focused" : "";
  const sourceTag = query.source === "cloudflare" ? "CF GATEWAY" : "DIALTONE CH";

  const queryOptions = state.queries
    .map(
      (q) =>
        `<option value="${escapeHtml(q.id)}" ${q.id === query.id ? "selected" : ""}>${escapeHtml(q.label)}</option>`,
    )
    .join("");

  const rateOptions: RateTier[] = ["base", "slow", "med", "fast"];
  const rateSelect = rateOptions
    .map((r) => {
      const lbl =
        r === "base"
          ? "base 30s"
          : r === "slow"
            ? "slow 10s"
            : r === "med"
              ? "med 4s"
              : "fast 1.5s";
      return `<option value="${r}" ${r === query.rate ? "selected" : ""}>${lbl}</option>`;
    })
    .join("");

  const statsText = `${query.estBytesPerSec} B/s · Δ${query.deltas} · ${query.notModified}×304${query.lastUpdatedAt ? ` · ${query.lastUpdatedAt}` : ""}`;

  return `
    <div class="earth-pane ${focused}" data-pane-index="${paneIndex}" data-testid="query-pane-${paneIndex}">
      <div class="earth-pane-head">
        <div class="pane-head-left">
          <span class="pane-num">#${paneIndex + 1}</span>
          <select class="pane-select" data-pane-query="${paneIndex}" aria-label="Pane ${paneIndex + 1} query">${queryOptions}</select>
          <span class="pane-source ${query.source === "cloudflare" ? "is-cf" : "is-ch"}">${sourceTag}</span>
        </div>
        <div class="pane-head-right">
          <select class="pane-select" data-pane-rate="${escapeHtml(query.id)}" aria-label="Best-effort data rate">${rateSelect}</select>
          <span class="pane-stats">${escapeHtml(statsText)}</span>
        </div>
      </div>
      <div class="earth-table-scroll">
        <table class="earth-table" data-testid="${paneIndex === 0 ? "earth-table" : `earth-table-${paneIndex}`}">
          <thead>
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
  query: SavedQuery,
  net: MeshNetwork,
  host: MeshHost | null,
  testRun: SimTestRun | null,
): { columns: string[]; rowsHtml: string } {
  if (query.kind === "networks") {
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
    };
  }

  if (query.kind === "hosts") {
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
          return `<tr class="is-clickable ${selected}" data-select-host="${escapeHtml(h.name)}" data-host-net="${escapeHtml(net.slug)}">
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
    };
  }

  if (query.kind === "host" && host) {
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
    return {
      columns: ["RESOURCE", "STATE", "DETAIL"],
      rowsHtml: rows
        .map(
          ([k, v, detail]) => `<tr>
            <td class="c-strong">${escapeHtml(k)}</td>
            <td>${escapeHtml(v)}</td>
            <td class="c-dim">${escapeHtml(detail)}</td>
          </tr>`,
        )
        .join(""),
    };
  }

  if (query.kind === "plugins") {
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
    };
  }

  if (query.kind === "recovery") {
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
    };
  }

  if (query.kind === "users") {
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
    };
  }

  if (query.kind === "tests") {
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
          return `<tr class="is-clickable ${selected}" data-open-log="${escapeHtml(t.testId)}" data-log-net="${escapeHtml(net.slug)}">
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
    };
  }

  if (!testRun) {
    return {
      columns: ["#", "OUTPUT"],
      rowsHtml: `<tr><td colspan="2" class="c-dim">Select a test run to inspect its immutable log.</td></tr>`,
    };
  }
  const lines = [
    `$ ${testRun.command}   [${testRun.status.toUpperCase()} · ${testRun.elapsed}s · ${testRun.artifact}]`,
    ...testRun.log.split(/\r?\n/),
  ];
  return {
    columns: ["#", `LOG · ${testRun.title}`],
    rowsHtml: lines
      .map(
        (line, idx) => `<tr>
          <td class="c-dim">${idx + 1}</td>
          <td class="c-mono-line">${escapeHtml(line)}</td>
        </tr>`,
      )
      .join(""),
  };
}

function bindInteractions(): void {
  // Query set chip clicks
  app.querySelectorAll<HTMLButtonElement>("[data-pick-query]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.dataset.removeQuery) {
        event.stopPropagation();
        const removeId = target.dataset.removeQuery;
        state.queries = state.queries.filter((q) => q.id !== removeId);
        state.paneQueryIds = normalizePaneAssignments(
          state.paneQueryIds,
          state.queries,
          state.layout,
        );
        renderAll();
        syncGlobeFocus();
        return;
      }
      const id = btn.dataset.pickQuery;
      if (!id) return;
      exitTour();
      state.tableMinimized = false;
      assignQueryToActivePane(id);
      renderAll();
      syncGlobeFocus();
      void reportLivePresence();
    });
  });

  // Split layout buttons (1, 1|1, 1/1, 1|2, 2x2)
  app.querySelectorAll<HTMLButtonElement>("[data-layout-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextLayout = btn.dataset.layoutBtn as SplitLayout | undefined;
      if (!nextLayout) return;
      exitTour();
      state.layout = nextLayout;
      state.tableMinimized = false;
      state.paneQueryIds = normalizePaneAssignments(
        state.paneQueryIds,
        state.queries,
        state.layout,
      );
      if (state.activePaneIndex >= state.paneQueryIds.length) {
        state.activePaneIndex = 0;
      }
      for (const q of visiblePaneQueries()) {
        q.nextDueAtMs = Date.now();
      }
      renderAll();
      syncGlobeFocus();
    });
  });

  // Focus pane on click
  app.querySelectorAll<HTMLElement>("[data-pane-index]").forEach((pane) => {
    pane.addEventListener("mousedown", () => {
      const idx = Number(pane.dataset.paneIndex ?? 0);
      if (idx !== state.activePaneIndex) {
        state.activePaneIndex = idx;
        const q = activePaneQuery();
        state.networkSlug = q.networkSlug;
        renderAll();
        syncGlobeFocus();
      }
    });
  });

  // Per-pane query selector
  app.querySelectorAll<HTMLSelectElement>("[data-pane-query]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const paneIdx = Number(sel.dataset.paneQuery ?? 0);
      state.activePaneIndex = paneIdx;
      exitTour();
      assignQueryToActivePane(sel.value);
      renderAll();
      syncGlobeFocus();
    });
  });

  // Per-query best-effort rate selector
  app.querySelectorAll<HTMLSelectElement>("[data-pane-rate]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const q = getQueryById(sel.dataset.paneRate);
      const nextRate = sel.value as RateTier;
      q.rate = nextRate;
      q.unchangedStreak = 0;
      q.nextDueAtMs = Date.now();
      renderAll();
    });
  });

  // New query composer
  app
    .querySelector<HTMLButtonElement>('[data-action="toggle-composer"]')
    ?.addEventListener("click", () => {
      state.composerOpen = !state.composerOpen;
      renderAll();
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="close-composer"]')
    ?.addEventListener("click", () => {
      state.composerOpen = false;
      renderAll();
    });

  app
    .querySelector<HTMLFormElement>("#query-composer")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const fd = new FormData(form);
      const kind = String(fd.get("kind") || "hosts") as TableQuery;
      const networkSlug = String(fd.get("network") || state.networkSlug);
      const source = String(fd.get("source") || "channel") as QuerySource;
      const rate = String(fd.get("rate") || "med") as RateTier;
      const label = String(fd.get("label") || "");
      const created = createCustomQuery(state.queries, {
        label,
        kind,
        source,
        networkSlug,
        rate,
      });
      state.queries.push(created);
      state.composerOpen = false;
      state.tableMinimized = false;
      exitTour();
      assignQueryToActivePane(created.id);
      renderAll();
      syncGlobeFocus();
    });

  // Row drill-downs (sync globe + active pane)
  app
    .querySelectorAll<HTMLElement>("[data-select-network]")
    .forEach((row) => {
      row.addEventListener("click", () => {
        const slug = row.dataset.selectNetwork;
        if (!slug) return;
        exitTour();
        state.networkSlug = slug;
        const q = ensureQueryForKind("hosts", slug);
        assignQueryToActivePane(q.id);
        renderAll();
        syncGlobeFocus();
      });
    });

  app.querySelectorAll<HTMLElement>("[data-select-host]").forEach((row) => {
    row.addEventListener("click", () => {
      const hostName = row.dataset.selectHost;
      const netSlug = row.dataset.hostNet || state.networkSlug;
      if (!hostName) return;
      exitTour();
      state.networkSlug = netSlug;
      state.hostName = hostName;
      const q = ensureQueryForKind("host", netSlug);
      assignQueryToActivePane(q.id);
      renderAll();
      syncGlobeFocus();
      void reportLivePresence();
    });
  });

  app.querySelectorAll<HTMLElement>("[data-open-log]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.openLog;
      const netSlug = row.dataset.logNet || state.networkSlug;
      if (!id) return;
      exitTour();
      state.networkSlug = netSlug;
      state.testId = id;
      const q = ensureQueryForKind("log", netSlug);
      assignQueryToActivePane(q.id);
      renderAll();
    });
  });

  // Minimize / Fullscreen / Tour controls
  app
    .querySelector<HTMLButtonElement>('[data-action="toggle-minimize"]')
    ?.addEventListener("click", () => {
      if (state.tableFullscreen) {
        state.tableFullscreen = false;
        state.tableMinimized = true;
      } else {
        state.tableMinimized = !state.tableMinimized;
      }
      if (!state.tableMinimized) {
        for (const q of visiblePaneQueries()) {
          q.nextDueAtMs = Date.now();
        }
      }
      renderAll();
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="toggle-fullscreen"]')
    ?.addEventListener("click", () => {
      state.tableFullscreen = !state.tableFullscreen;
      if (state.tableFullscreen) {
        state.tableMinimized = false;
        exitTour();
        for (const q of visiblePaneQueries()) {
          q.nextDueAtMs = Date.now();
        }
      }
      renderAll();
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
      if (state.tourPlaying) {
        state.tableFullscreen = false;
        startTourTimer();
      } else {
        clearTourTimer();
      }
      renderAll();
    });
}

function applyTourStep(index: number, keepPlaying: boolean): void {
  const step = state.tourSteps[index];
  if (!step) return;
  state.tourStepIndex = index;
  state.tourCaptionsVisible = true;
  const kind = viewToQueryKind(step.view, step.networkTab);
  if (step.networkSlug) {
    state.networkSlug = step.networkSlug;
    const net = networkBySlug(step.networkSlug);
    state.hostName = step.hostName ?? net.hosts[0]?.name ?? "";
    state.testId = step.testId ?? net.tests[0]?.testId ?? "";
  }
  const q = ensureQueryForKind(kind, step.networkSlug ?? undefined);
  assignQueryToActivePane(q.id);
  if (!keepPlaying) {
    state.tourPlaying = false;
    clearTourTimer();
  }
  renderAll();
  syncGlobeFocus();
}

function syncGlobeFocus(): void {
  if (!globeController) return;
  const activeQ = activePaneQuery();
  if (activeQ.kind === "networks") {
    globeController.focusTarget(null, null);
  } else if (activeQ.kind === "host") {
    globeController.focusTarget(activeQ.networkSlug, state.hostName);
  } else {
    globeController.focusTarget(activeQ.networkSlug, null);
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
