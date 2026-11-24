import "./hud.css";
import { aggregateNetwork } from "./aggregates";
import {
  buildCameraContext,
  CAMERA_PRESETS,
  evaluateCameraPolicy,
  highlightTypeScript,
  type PolicyEvalResult,
} from "./camera-policy";
import {
  buildQueryDrivenGlobeLayers,
  type GlobeQueryLayers,
} from "./h3-geodata";
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
  GLOBE_PANE_ID,
  normalizePaneAssignments,
  resolveEffectiveLayout,
  SPLIT_LAYOUTS,
  tickSimulatedQuery,
  type LayoutPreference,
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

type PersistedConfigPayload = {
  version: 2;
  layout: LayoutPreference;
  paneContents: string[];
  queries: Array<{
    id: string;
    label: string;
    kind: TableQuery;
    source: QuerySource;
    networkSlug: string;
    rate: RateTier;
  }>;
  cameraPolicyCode: string;
  theme?: "dark" | "light";
};

type AppState = {
  session: SessionInfo;
  liveSite: LiveSiteState | null;
  liveEtag: string | null;
  networks: MeshNetwork[];
  tourSteps: TourStep[];
  queries: SavedQuery[];
  layoutPref: LayoutPreference;
  /** Each entry is "globe" or a SavedQuery.id */
  paneContents: string[];
  activePaneIndex: number;
  maximizedPaneIndex: number | null;
  configOpen: boolean;
  cameraOpen: boolean;
  cameraPolicyCode: string;
  cameraDraftCode: string;
  cameraResult: PolicyEvalResult;
  cameraDraftResult: PolicyEvalResult;
  configSyncLabel: string;
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
const QUERY_SCHEDULER_TICK_MS = 1_000;
const LOCAL_UI_CONFIG_KEY = "dialtone.uiConfig.v2";

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
  layoutPref: "auto",
  paneContents: [GLOBE_PANE_ID, initialQueries[0].id],
  activePaneIndex: 0,
  maximizedPaneIndex: null,
  configOpen: false,
  cameraOpen: false,
  cameraPolicyCode: CAMERA_PRESETS[0].code,
  cameraDraftCode: CAMERA_PRESETS[0].code,
  cameraResult: { ok: true, target: null },
  cameraDraftResult: { ok: true, target: null },
  configSyncLabel: "LOCAL",
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

let globeStageEl: HTMLDivElement | null = null;
let globeController: OverviewGlobeController | null = null;
let tourTimer: number | null = null;
let presenceTimer: number | null = null;
let adaptivePollTimer: number | null = null;
let querySchedulerTimer: number | null = null;
let saveConfigTimer: number | null = null;
let schedulerTickSeq = 0;
let lastEffectiveLayout: SplitLayout = currentEffectiveLayout();

void boot();

function currentEffectiveLayout(): SplitLayout {
  if (state.maximizedPaneIndex !== null) return "1";
  return resolveEffectiveLayout(state.layoutPref, window.innerWidth);
}

async function boot(): Promise<void> {
  if (window.location.pathname !== "/") {
    renderNotFound();
    return;
  }

  state.session = await detectSession();
  if (state.session.authenticated && state.session.mode === "live") {
    state.tourPlaying = false;
    state.tourCaptionsVisible = false;
    await syncLiveEndpointForKind("networks", true);
    state.queries = createDefaultQuerySet(state.networks);
    state.paneContents = [GLOBE_PANE_ID, state.queries[0].id];
    const restoredCloud = await loadUserConfigFromCloudflare();
    if (!restoredCloud) {
      loadUserConfigFromLocalStorage();
      state.configSyncLabel = "CF READY";
    }
  } else {
    loadUserConfigFromLocalStorage();
    await syncPublicLiveControl(true);
  }

  mountShell();
  renderAll();

  if (globeStageEl) {
    const { mountOverviewGlobe } = await import("./overview-globe");
    globeController = await mountOverviewGlobe(
      globeStageEl,
      currentGlobeLayers(),
    );
    syncGlobeFocus();
    renderAll();
  }

  window.addEventListener("resize", () => {
    const next = currentEffectiveLayout();
    if (next !== lastEffectiveLayout) {
      lastEffectiveLayout = next;
      renderAll();
    }
  });

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
    if (event.key === "Escape") {
      if (state.cameraOpen) {
        state.cameraOpen = false;
        renderAll();
      } else if (state.configOpen) {
        state.configOpen = false;
        renderAll();
      } else if (state.maximizedPaneIndex !== null) {
        state.maximizedPaneIndex = null;
        renderAll();
      }
    }
  });

  startTourTimer();
  startPresenceHeartbeat();
  scheduleNextAdaptivePoll();
  startBestEffortQueryScheduler();
}

/* ===== Cloudflare KV + localStorage UI Config Persistence ===== */

function buildPersistedConfig(): PersistedConfigPayload {
  const theme =
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return {
    version: 2,
    layout: state.layoutPref,
    paneContents: [...state.paneContents],
    queries: state.queries.map((q) => ({
      id: q.id,
      label: q.label,
      kind: q.kind,
      source: q.source,
      networkSlug: q.networkSlug,
      rate: q.rate,
    })),
    cameraPolicyCode: state.cameraPolicyCode,
    theme,
  };
}

function hydrateFromPersistedConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Partial<PersistedConfigPayload>;
  if (obj.version !== 2) return false;

  const validLayouts = new Set<LayoutPreference>([
    "auto",
    "1",
    "1|1",
    "1/1",
    "1|2",
    "2x2",
  ]);
  if (typeof obj.layout === "string" && validLayouts.has(obj.layout as LayoutPreference)) {
    state.layoutPref = obj.layout as LayoutPreference;
  }

  if (Array.isArray(obj.queries) && obj.queries.length > 0) {
    const now = Date.now();
    const restored: SavedQuery[] = [];
    for (const q of obj.queries) {
      if (!q || typeof q !== "object" || !q.id || !q.kind) continue;
      restored.push({
        id: String(q.id),
        label: String(q.label || `${q.networkSlug}:${q.kind}`),
        kind: q.kind,
        source: q.source === "cloudflare" ? "cloudflare" : "channel",
        networkSlug: String(q.networkSlug || state.networks[0]?.slug || "sim-atlas"),
        rate:
          q.rate === "base" || q.rate === "slow" || q.rate === "med" || q.rate === "fast"
            ? q.rate
            : "med",
        ticks: 0,
        deltas: 0,
        notModified: 0,
        unchangedStreak: 0,
        lastUpdatedAt: null,
        estBytesPerSec: 0,
        nextDueAtMs: now,
      });
    }
    if (restored.length > 0) {
      state.queries = restored;
    }
  }

  if (Array.isArray(obj.paneContents) && obj.paneContents.length > 0) {
    state.paneContents = obj.paneContents.map(String);
  }

  if (typeof obj.cameraPolicyCode === "string" && obj.cameraPolicyCode.trim()) {
    state.cameraPolicyCode = obj.cameraPolicyCode;
    state.cameraDraftCode = obj.cameraPolicyCode;
  }

  if (obj.theme === "light" || obj.theme === "dark") {
    document.documentElement.dataset.theme = obj.theme;
  }

  return true;
}

function loadUserConfigFromLocalStorage(): boolean {
  try {
    const raw = window.localStorage.getItem(LOCAL_UI_CONFIG_KEY);
    if (!raw) return false;
    return hydrateFromPersistedConfig(JSON.parse(raw));
  } catch {
    return false;
  }
}

async function loadUserConfigFromCloudflare(): Promise<boolean> {
  if (!state.session.authenticated) return false;
  try {
    const resp = await fetch("/api/user/ui-config", {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return false;
    const payload = (await resp.json()) as {
      saved?: boolean;
      config?: unknown;
    };
    if (payload.saved && payload.config) {
      const ok = hydrateFromPersistedConfig(payload.config);
      if (ok) {
        state.configSyncLabel = "CF RESTORED";
        return true;
      }
    }
  } catch {
    // non-fatal fallback
  }
  return false;
}

function persistUserConfig(): void {
  const payload = buildPersistedConfig();
  try {
    window.localStorage.setItem(LOCAL_UI_CONFIG_KEY, JSON.stringify(payload));
  } catch {
    // ignore localStorage quota errors
  }

  if (!state.session.authenticated) {
    state.configSyncLabel = "LOCAL SAVED";
    return;
  }

  state.configSyncLabel = "CF SAVING…";
  if (saveConfigTimer !== null) {
    window.clearTimeout(saveConfigTimer);
  }
  saveConfigTimer = window.setTimeout(() => {
    void fetch("/api/user/ui-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload),
    })
      .then((res) => {
        state.configSyncLabel = res.ok ? "CF SAVED" : "CF SAVE ERR";
        if (!state.configOpen && !state.cameraOpen) renderAll();
      })
      .catch(() => {
        state.configSyncLabel = "CF OFFLINE";
      });
  }, 300);
}

/* ===== Pane & Query Helpers ===== */

function getQueryById(id: string | undefined): SavedQuery {
  return state.queries.find((q) => q.id === id) ?? state.queries[0];
}

function visiblePaneContents(): string[] {
  const eff = resolveEffectiveLayout(state.layoutPref, window.innerWidth);
  const normalized = normalizePaneAssignments(
    state.paneContents,
    state.queries,
    eff,
  );
  if (
    state.maximizedPaneIndex !== null &&
    state.maximizedPaneIndex >= 0 &&
    state.maximizedPaneIndex < normalized.length
  ) {
    return [normalized[state.maximizedPaneIndex]];
  }
  return normalized;
}

function visibleQueryObjects(): SavedQuery[] {
  const contents = visiblePaneContents();
  const seen = new Set<string>();
  const out: SavedQuery[] = [];
  for (const id of contents) {
    if (id === GLOBE_PANE_ID || seen.has(id)) continue;
    const q = state.queries.find((item) => item.id === id);
    if (q) {
      seen.add(q.id);
      out.push(q);
    }
  }
  return out;
}

function currentGlobeLayers(): GlobeQueryLayers {
  return buildQueryDrivenGlobeLayers(
    state.networks,
    visibleQueryObjects(),
    state.hostName,
    !state.session.authenticated,
  );
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

function assignContentToPane(paneIndex: number, contentId: string): void {
  const eff = resolveEffectiveLayout(state.layoutPref, window.innerWidth);
  state.paneContents = normalizePaneAssignments(
    state.paneContents,
    state.queries,
    eff,
  );
  const idx = Math.min(
    Math.max(0, paneIndex),
    Math.max(0, state.paneContents.length - 1),
  );
  state.paneContents[idx] = contentId;
  if (contentId !== GLOBE_PANE_ID) {
    const q = getQueryById(contentId);
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
  persistUserConfig();
}

/** Pick the active pane if it's a table pane, or the first non-globe pane, else pane 0. */
function targetQueryPaneIndex(): number {
  const eff = resolveEffectiveLayout(state.layoutPref, window.innerWidth);
  const normalized = normalizePaneAssignments(
    state.paneContents,
    state.queries,
    eff,
  );
  if (
    state.activePaneIndex >= 0 &&
    state.activePaneIndex < normalized.length &&
    normalized[state.activePaneIndex] !== GLOBE_PANE_ID
  ) {
    return state.activePaneIndex;
  }
  const firstTableIdx = normalized.findIndex((c) => c !== GLOBE_PANE_ID);
  if (firstTableIdx >= 0) return firstTableIdx;
  return state.activePaneIndex < normalized.length ? state.activePaneIndex : 0;
}

function startBestEffortQueryScheduler(): void {
  if (querySchedulerTimer !== null) {
    window.clearInterval(querySchedulerTimer);
    querySchedulerTimer = null;
  }
  querySchedulerTimer = window.setInterval(() => {
    if (document.hidden) return;
    const visible = visibleQueryObjects();
    const visibleIds = new Set(visible.map((q) => q.id));
    for (const q of state.queries) {
      if (!visibleIds.has(q.id)) {
        q.estBytesPerSec = 0;
      }
    }
    if (visible.length === 0) return;

    const nowMs = Date.now();
    let anyTouched = false;
    for (const q of visible) {
      if (nowMs < q.nextDueAtMs) continue;
      schedulerTickSeq += 1;
      if (state.session.authenticated) {
        void syncSingleLiveQuery(q).then((changed) => {
          if (changed) {
            syncGlobeFocus();
            renderAll();
          }
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

    if (anyTouched && !state.configOpen && !state.cameraOpen) {
      syncGlobeFocus();
      renderAll();
    }
  }, QUERY_SCHEDULER_TICK_MS);
}

/* ===== Session, Live Mesh & Public Live-Control Sync ===== */

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
    // Offline or static preview
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

async function syncLiveEndpointForKind(
  kind: TableQuery,
  initial: boolean,
): Promise<boolean> {
  if (!state.session.authenticated || state.session.mode !== "live") {
    return false;
  }

  if (kind === "log" && state.testId && /^[a-f0-9]{32}$/.test(state.testId)) {
    if (state.loadedLogCache[state.testId]) return false;
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
  if (endpoint !== "/api/mesh/state" && !state.liveRawCache["/api/mesh/state"]) {
    const meshBootstrap = await fetchOptionalJson("/api/mesh/state");
    if (meshBootstrap) {
      state.liveRawCache["/api/mesh/state"] = meshBootstrap;
    }
  }
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
    if (state.liveEtag) headers["If-None-Match"] = state.liveEtag;
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
  if (live.theme) {
    document.documentElement.dataset.theme =
      live.theme === "light" ? "light" : "dark";
  }
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
    const idx = targetQueryPaneIndex();
    state.paneContents[idx] = q.id;
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
    state.maximizedPaneIndex = live.fullscreen ? targetQueryPaneIndex() : null;
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
  const visibleQs = visibleQueryObjects();
  const changed = state.session.authenticated
    ? await syncLiveEndpointForKind(visibleQs[0]?.kind ?? "networks", false)
    : await syncPublicLiveControl(false);
  if (changed) state.unchangedStreak = 0;
  else state.unchangedStreak += 1;
  scheduleNextAdaptivePoll();
  if (!state.configOpen && !state.cameraOpen) renderAll();
}

async function reportLivePresence(): Promise<void> {
  if (!state.session.authenticated || state.session.mode !== "live") return;
  const visibleQs = visibleQueryObjects();
  const activeKind = visibleQs[0]?.kind ?? "networks";
  try {
    await fetch("/api/mesh/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        view: queryToPresenceView(activeKind),
        node: activeKind === "networks" ? null : state.hostName || null,
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
      caption: `Saved layouts persist in Cloudflare KV across sessions.`,
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

/* ===== Persistent Full-App Shell & WebGL Reparenting ===== */

function mountShell(): void {
  document.title = state.session.authenticated
    ? `dialtone.earth — live ${state.networkSlug} mesh`
    : state.liveSite?.title
      ? `${state.liveSite.title} — dialtone.earth`
      : "dialtone.earth — simulated system tour";

  app.innerHTML = `
    <main class="hud-shell app-wm-shell">
      <div class="globe-parking" id="globe-parking" hidden></div>
      <section class="app-window-grid earth-split-grid" id="app-window-grid" data-testid="split-grid"></section>
      <section class="config-page" id="config-page" aria-label="Window and query configuration" data-testid="config-page" hidden></section>
      <section class="config-page camera-page" id="camera-page" aria-label="Camera TypeScript studio" data-testid="camera-page" hidden></section>
      <footer class="app-bottom-bar" id="bottom-table-dock" aria-label="Workspace bar"></footer>
    </main>
  `;

  globeStageEl = document.createElement("div");
  globeStageEl.className = "globe-stage";
  const parking = app.querySelector<HTMLElement>("#globe-parking");
  parking?.appendChild(globeStageEl);
}

function networkBySlug(slug: string): MeshNetwork {
  return state.networks.find((n) => n.slug === slug) ?? state.networks[0];
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
  const baseEff = resolveEffectiveLayout(state.layoutPref, window.innerWidth);
  state.paneContents = normalizePaneAssignments(
    state.paneContents,
    state.queries,
    baseEff,
  );
  if (state.activePaneIndex >= state.paneContents.length) {
    state.activePaneIndex = 0;
  }
  if (
    state.maximizedPaneIndex !== null &&
    state.maximizedPaneIndex >= state.paneContents.length
  ) {
    state.maximizedPaneIndex = null;
  }
  lastEffectiveLayout = currentEffectiveLayout();

  const shell = app.querySelector<HTMLElement>(".hud-shell");
  if (shell) {
    shell.classList.toggle("is-config-open", state.configOpen || state.cameraOpen);
  }

  // Park live WebGL globe before rebuilding window DOM so canvas is NEVER destroyed
  const parking = app.querySelector<HTMLElement>("#globe-parking");
  if (globeStageEl && parking && globeStageEl.parentElement !== parking) {
    parking.appendChild(globeStageEl);
  }

  renderWindowGrid();
  renderConfigPage();
  renderCameraPage();
  renderBottomBar();
  bindInteractions();
  globeController?.syncQueryLayers(currentGlobeLayers());
}

function renderWindowGrid(): void {
  const gridEl = app.querySelector<HTMLElement>("#app-window-grid");
  if (!gridEl) return;

  const effectiveLayout = currentEffectiveLayout();
  gridEl.dataset.layout = effectiveLayout;

  const visibleSlots: Array<{ originalIndex: number; contentId: string }> =
    state.maximizedPaneIndex !== null
      ? [
          {
            originalIndex: state.maximizedPaneIndex,
            contentId: state.paneContents[state.maximizedPaneIndex],
          },
        ]
      : state.paneContents.map((contentId, idx) => ({
          originalIndex: idx,
          contentId,
        }));

  gridEl.innerHTML = visibleSlots
    .map(({ originalIndex, contentId }) =>
      contentId === GLOBE_PANE_ID
        ? renderGlobePane(originalIndex)
        : renderQueryPane(getQueryById(contentId), originalIndex),
    )
    .join("");

  // Reparent the live Three.js WebGL globe into the first visible globe pane
  const globeMount = gridEl.querySelector<HTMLElement>(".globe-pane-mount");
  if (globeMount && globeStageEl) {
    globeMount.appendChild(globeStageEl);
  }
}

function renderGlobePane(paneIndex: number): string {
  const focused = paneIndex === state.activePaneIndex ? "is-focused" : "";
  const isMax = state.maximizedPaneIndex === paneIndex;
  const layers = currentGlobeLayers();
  const camSummary =
    state.cameraResult.ok && state.cameraResult.target
      ? `${state.cameraResult.target.node ?? `${state.cameraResult.target.lat.toFixed(1)}°,${state.cameraResult.target.lng.toFixed(1)}°`}${state.cameraResult.target.reason ? ` · ${state.cameraResult.target.reason}` : ""}`
      : "free orbit";

  const step = state.tourSteps[state.tourStepIndex] ?? state.tourSteps[0];
  const liveCtrl = !state.session.authenticated ? state.liveSite : null;
  const ccControls = `
    <span class="cc-controls">
      <button type="button" class="tbl-chip" data-action="prev-step" title="Previous tour step">◀</button>
      <button type="button" class="tbl-chip ${state.tourPlaying ? "is-active" : ""}" data-action="toggle-tour" data-testid="toggle-tour" aria-pressed="${state.tourPlaying}">${state.tourPlaying ? "⏸ tour" : "▶ tour"}</button>
      <button type="button" class="tbl-chip" data-action="next-step" title="Next tour step">▶</button>
    </span>
  `;

  const ccHtml =
    state.tourCaptionsVisible && step
      ? `<div class="cc-head-row">
          <span class="cc-line cc-kicker">CC · TOUR ${state.tourStepIndex + 1}/${state.tourSteps.length} · ${escapeHtml(step.label)}</span>
          ${ccControls}
        </div>
        <div class="cc-line cc-headline">${escapeHtml(liveCtrl?.headline || step.headline)}</div>
        <div class="cc-line cc-body">${escapeHtml(liveCtrl?.subline || step.caption)}</div>`
      : `<div class="cc-head-row">${ccControls}</div>`;

  return `
    <div class="earth-pane globe-pane ${focused}" data-pane-index="${paneIndex}" data-testid="query-pane-${paneIndex}" data-pane-type="globe">
      <div class="earth-pane-head">
        <div class="pane-head-left">
          <span class="pane-num">#${paneIndex + 1}</span>
          <strong class="pane-title">3D H3 GLOBE</strong>
          <span class="pane-source is-ch" data-testid="globe-layer-legend" title="${escapeHtml(layers.legendTooltip)}">${escapeHtml(layers.legend)}</span>
        </div>
        <div class="pane-head-right">
          <span class="pane-stats" data-testid="globe-cam-stats">CAM: ${escapeHtml(camSummary)}</span>
          <button type="button" class="tbl-chip" data-action="open-camera" title="Open fullscreen TypeScript camera editor">code</button>
          <button type="button" class="tbl-chip ${isMax ? "is-active" : ""}" data-max-pane="${paneIndex}">${isMax ? "split" : "full"}</button>
        </div>
      </div>
      <div class="globe-pane-body">
        <div class="globe-pane-mount" data-testid="globe-pane-mount"></div>
        <aside class="tour-captions" id="tour-captions" aria-live="polite" data-testid="tour-captions">${ccHtml}</aside>
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
  const isMax = state.maximizedPaneIndex === paneIndex;
  const sourceTag = query.source === "cloudflare" ? "CF GATEWAY" : "DIALTONE CH";
  const statsText = `${query.rate} · ${query.estBytesPerSec} B/s · Δ${query.deltas} · ${query.notModified}×304${query.lastUpdatedAt ? ` · ${query.lastUpdatedAt}` : ""}`;

  return `
    <div class="earth-pane ${focused}" data-pane-index="${paneIndex}" data-testid="query-pane-${paneIndex}" data-pane-type="query">
      <div class="earth-pane-head">
        <div class="pane-head-left">
          <span class="pane-num">#${paneIndex + 1}</span>
          <strong class="pane-title">${escapeHtml(query.label)}</strong>
          <span class="pane-source ${query.source === "cloudflare" ? "is-cf" : "is-ch"}">${sourceTag}</span>
        </div>
        <div class="pane-head-right">
          <span class="pane-stats">${escapeHtml(statsText)}</span>
          <button type="button" class="tbl-chip ${isMax ? "is-active" : ""}" data-max-pane="${paneIndex}">${isMax ? "split" : "full"}</button>
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

function renderFullscreenTourCaptionsHtml(testId: string): string {
  const tourStep = state.tourSteps[state.tourStepIndex] ?? state.tourSteps[0];
  if (!state.tourCaptionsVisible || !tourStep) return "";
  const liveCtrl = !state.session.authenticated ? state.liveSite : null;
  return `<div class="cfg-tour-cc" data-testid="${testId}" aria-live="polite">
    <div class="cfg-cc-top">
      <span class="cc-kicker">CC · TOUR ${state.tourStepIndex + 1}/${state.tourSteps.length} · ${escapeHtml(tourStep.label)}</span>
      <strong class="cfg-cc-headline">${escapeHtml(liveCtrl?.headline || tourStep.headline)}</strong>
      <span class="cc-controls">
        <button type="button" class="tbl-chip" data-action="prev-step" title="Previous tour step">◀</button>
        <button type="button" class="tbl-chip ${state.tourPlaying ? "is-active" : ""}" data-action="toggle-tour" aria-pressed="${state.tourPlaying}">${state.tourPlaying ? "⏸ tour" : "▶ tour"}</button>
        <button type="button" class="tbl-chip" data-action="next-step" title="Next tour step">▶</button>
      </span>
    </div>
    <div class="cfg-cc-body">${escapeHtml(liveCtrl?.subline || tourStep.caption)}</div>
  </div>`;
}

function buildLineNumbers(code: string): string {
  const count = Math.max(1, code.split("\n").length);
  return Array.from({ length: count }, (_, idx) => String(idx + 1)).join("\n");
}

function formatCameraStatus(result: PolicyEvalResult): { cls: string; text: string } {
  if (!result.ok) {
    return {
      cls: "cfg-cam-err",
      text: `ERROR: ${result.error ?? "Invalid TypeScript policy"}`,
    };
  }
  if (result.target) {
    return {
      cls: "cfg-cam-ok",
      text: `TARGET: ${result.target.node ?? "custom"} (${result.target.lat.toFixed(2)}°, ${result.target.lng.toFixed(2)}°)${result.target.reason ? ` · ${result.target.reason}` : ""}`,
    };
  }
  return { cls: "c-dim", text: "TARGET: null (free orbit)" };
}

function renderCameraPage(): void {
  const camEl = app.querySelector<HTMLElement>("#camera-page");
  if (!camEl) return;
  if (!state.cameraOpen) {
    camEl.innerHTML = "";
    camEl.hidden = true;
    return;
  }

  const ctx = buildCameraContext(
    state.networks,
    state.networkSlug,
    performance.now() / 1000,
  );
  state.cameraDraftResult = evaluateCameraPolicy(state.cameraDraftCode, ctx);
  const status = formatCameraStatus(state.cameraDraftResult);
  const isDirty = state.cameraDraftCode.trim() !== state.cameraPolicyCode.trim();

  const exampleCards = CAMERA_PRESETS.map((p) => {
    const isSelected = state.cameraDraftCode.trim() === p.code.trim();
    const isApplied = state.cameraPolicyCode.trim() === p.code.trim();
    return `<button type="button" class="cam-example-card ${isSelected ? "is-active" : ""}" data-cam-preset="${escapeHtml(p.id)}" data-testid="cam-preset-${escapeHtml(p.id)}">
      <span class="cam-ex-top">
        <strong>${escapeHtml(p.label)}</strong>
        ${isApplied ? `<span class="cam-ex-live">ACTIVE</span>` : ""}
      </span>
      <span class="cam-ex-desc">${escapeHtml(p.description)}</span>
    </button>`;
  }).join("");

  const liveNodeRows = ctx.nodes
    .map((n) => {
      const isTarget =
        state.cameraDraftResult.ok &&
        state.cameraDraftResult.target?.node === n.name;
      return `<tr class="${isTarget ? "is-selected" : ""}">
        <td class="c-strong">${isTarget ? "● " : ""}${escapeHtml(n.name)}</td>
        <td>${n.cpu}%</td>
        <td>${n.mem}%</td>
        <td>${n.rttP95}ms</td>
        <td>${n.gpu > 0 ? `${n.gpu}%` : "—"}</td>
      </tr>`;
    })
    .join("");

  const captionsHtml = renderFullscreenTourCaptionsHtml("camera-tour-captions");

  camEl.hidden = false;
  camEl.innerHTML = `
    <div class="cfg-frame cam-studio-frame">
      ${captionsHtml}
      <header class="cfg-header">
        <div class="earth-bar-left">
          <span class="tbl-brand">CAMERA // TYPESCRIPT GEOLOCATION STUDIO</span>
          <span class="${status.cls}" id="camera-status-pill" data-testid="cam-status">${escapeHtml(status.text)}</span>
        </div>
        <div class="earth-bar-right">
          <button type="button" class="tbl-chip" data-action="open-config">window config</button>
          <button type="button" class="tbl-chip is-active" data-action="apply-camera-ts" data-testid="apply-camera-ts">${isDirty ? "apply* (Ctrl+Enter)" : "apply (Ctrl+Enter)"}</button>
          <button type="button" class="tbl-chip" data-action="close-camera" data-testid="camera-done">done</button>
        </div>
      </header>

      <div class="cam-studio-grid">
        <aside class="cam-sidebar">
          <div class="cfg-section">
            <div class="cfg-section-title">PREFILLED EXAMPLES (1-CLICK LOAD &amp; APPLY)</div>
            <div class="cam-example-list">${exampleCards}</div>
          </div>
          <div class="cfg-section">
            <div class="cfg-section-title">LIVE ctx.nodes SNAPSHOT</div>
            <div class="cfg-table-wrap">
              <table class="earth-table cam-ref-table">
                <thead>
                  <tr><th>NODE</th><th>CPU</th><th>MEM</th><th>p95</th><th>GPU</th></tr>
                </thead>
                <tbody>${liveNodeRows}</tbody>
              </table>
            </div>
          </div>
        </aside>

        <section class="cam-editor-pane">
          <div class="cam-sig-bar">
            <span>ctx.nodes: { name, network, lat, lng, online, cpu, mem, disk, gpu, load1m, rttMs, rttP95, cores, blobs }</span>
            <span>helpers: maxBy, minBy, p95, avg, centroid, Math</span>
          </div>
          <div class="code-ide" data-testid="code-ide">
            <pre class="code-gutter" id="camera-ts-gutter" aria-hidden="true">${buildLineNumbers(state.cameraDraftCode)}</pre>
            <div class="code-surface">
              <pre class="code-pre" id="camera-ts-pre" aria-hidden="true"><code id="camera-ts-highlight" data-testid="camera-ts-highlight">${highlightTypeScript(state.cameraDraftCode)}</code></pre>
              <textarea class="code-textarea" id="camera-ts-editor" data-testid="camera-ts-editor" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off">${escapeHtml(state.cameraDraftCode)}</textarea>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderConfigPage(): void {
  const cfgEl = app.querySelector<HTMLElement>("#config-page");
  if (!cfgEl) return;
  if (!state.configOpen) {
    cfgEl.innerHTML = "";
    cfgEl.hidden = true;
    return;
  }

  const resolvedEff = resolveEffectiveLayout(state.layoutPref, window.innerWidth);
  const autoCard = `<button type="button" class="cfg-layout-card ${state.layoutPref === "auto" ? "is-active" : ""}" data-layout-btn="auto" data-testid="layout-auto" title="Auto: Left/Right on wide displays, Top/Bottom on mobile">
    <span class="cfg-wireframe" data-layout="${resolvedEff}"><i></i><i></i></span>
    <span class="cfg-layout-label">auto (${resolvedEff})</span>
  </button>`;

  const layoutCards =
    autoCard +
    SPLIT_LAYOUTS.map((item) => {
      const active = state.layoutPref === item.id ? "is-active" : "";
      const cells = Array.from({ length: item.panes }, () => `<i></i>`).join("");
      return `<button type="button" class="cfg-layout-card ${active}" data-layout-btn="${item.id}" data-testid="layout-${item.id.replace(/[^a-z0-9]/gi, "_")}" title="${escapeHtml(item.title)}">
        <span class="cfg-wireframe" data-layout="${item.id}">${cells}</span>
        <span class="cfg-layout-label">${escapeHtml(item.label)}</span>
      </button>`;
    }).join("");

  const paneSlots = state.paneContents
    .map((contentId, idx) => {
      const selected = idx === state.activePaneIndex ? "is-active" : "";
      if (contentId === GLOBE_PANE_ID) {
        return `<button type="button" class="cfg-pane-slot ${selected}" data-cfg-pane="${idx}" data-testid="cfg-pane-${idx}">
          <span class="cfg-slot-top">PANE #${idx + 1} · VISUAL PANEL</span>
          <strong class="cfg-slot-name">3D H3 GLOBE</strong>
          <span class="cfg-slot-sub">query-driven H3 tiles + measured RTT arcs</span>
        </button>`;
      }
      const q = getQueryById(contentId);
      const src = q.source === "cloudflare" ? "CF GATEWAY" : "DIALTONE CH";
      return `<button type="button" class="cfg-pane-slot ${selected}" data-cfg-pane="${idx}" data-testid="cfg-pane-${idx}">
        <span class="cfg-slot-top">PANE #${idx + 1} · ${src} · ${escapeHtml(q.rate.toUpperCase())}</span>
        <strong class="cfg-slot-name">${escapeHtml(q.label)}</strong>
        <span class="cfg-slot-sub">${escapeHtml(q.kind)} · ${escapeHtml(q.networkSlug)}</span>
      </button>`;
    })
    .join("");

  const globeAssignedToActive =
    state.paneContents[state.activePaneIndex] === GLOBE_PANE_ID;
  const globeInAnyPane = state.paneContents.includes(GLOBE_PANE_ID);

  const globeRow = `<tr>
    <td>
      <button type="button" class="tbl-chip ${globeAssignedToActive ? "is-active" : globeInAnyPane ? "is-shown" : ""}" data-cfg-assign="${GLOBE_PANE_ID}" data-testid="cfg-assign-globe">${globeAssignedToActive ? `● #${state.activePaneIndex + 1}` : `set #${state.activePaneIndex + 1}`}</button>
      <span class="c-strong cfg-q-name">3D H3 GLOBE</span>
    </td>
    <td><span class="pane-source is-ch">VISUAL</span></td>
    <td class="c-dim">all networks</td>
    <td class="c-dim">camera policy driven</td>
    <td></td>
  </tr>`;

  const rateList: RateTier[] = ["base", "slow", "med", "fast"];
  const rateLabels: Record<RateTier, string> = {
    base: "base 30s",
    slow: "slow 10s",
    med: "med 4s",
    fast: "fast 1.5s",
  };

  const queryRows =
    globeRow +
    state.queries
      .map((q) => {
        const assignedToActive =
          state.paneContents[state.activePaneIndex] === q.id;
        const inAnyPane = state.paneContents.includes(q.id);
        const sourceBtns = (["channel", "cloudflare"] as QuerySource[])
          .map(
            (src) =>
              `<button type="button" class="tbl-chip ${q.source === src ? "is-active" : ""}" data-cfg-source="${escapeHtml(q.id)}:${src}">${src === "cloudflare" ? "cf" : "ch"}</button>`,
          )
          .join("");
        const netBtns = state.networks
          .map(
            (n) =>
              `<button type="button" class="tbl-chip ${q.networkSlug === n.slug ? "is-active" : ""}" data-cfg-net="${escapeHtml(q.id)}:${escapeHtml(n.slug)}">${escapeHtml(n.slug.replace(/^sim-/, ""))}</button>`,
          )
          .join("");
        const rateBtns = rateList
          .map(
            (r) =>
              `<button type="button" class="tbl-chip ${q.rate === r ? "is-active" : ""}" data-cfg-rate="${escapeHtml(q.id)}:${r}" data-testid="rate-${escapeHtml(q.id)}-${r}">${rateLabels[r]}</button>`,
          )
          .join("");
        const rmBtn =
          state.queries.length > 1
            ? `<button type="button" class="tbl-chip" data-remove-query="${escapeHtml(q.id)}" title="Remove query">×</button>`
            : "";
        return `<tr>
          <td>
            <button type="button" class="tbl-chip ${assignedToActive ? "is-active" : inAnyPane ? "is-shown" : ""}" data-cfg-assign="${escapeHtml(q.id)}" data-testid="cfg-assign-${escapeHtml(q.id)}">${assignedToActive ? `● #${state.activePaneIndex + 1}` : `set #${state.activePaneIndex + 1}`}</button>
            <span class="c-strong cfg-q-name">${escapeHtml(q.label)}</span>
          </td>
          <td><span class="cfg-btn-row">${sourceBtns}</span></td>
          <td><span class="cfg-btn-row">${netBtns}</span></td>
          <td><span class="cfg-btn-row">${rateBtns}</span></td>
          <td>${rmBtn}</td>
        </tr>`;
      })
      .join("");

  const addKinds: TableQuery[] = [
    "networks",
    "hosts",
    "host",
    "plugins",
    "users",
    "recovery",
    "tests",
    "log",
  ];
  const addButtons = addKinds
    .map(
      (kind) =>
        `<button type="button" class="tbl-chip" data-cfg-add="${kind}" data-testid="cfg-add-${kind}">+ ${kind}</button>`,
    )
    .join("");

  const saveLabel = state.session.authenticated
    ? `CLOUDFLARE KV · ${state.configSyncLabel}`
    : `BROWSER STORAGE · ${state.configSyncLabel} (SIGN IN TO SYNC VIA CLOUDFLARE)`;

  const cfgCaptionsHtml = renderFullscreenTourCaptionsHtml("config-tour-captions");

  cfgEl.hidden = false;
  cfgEl.innerHTML = `
    <div class="cfg-frame">
      ${cfgCaptionsHtml}
      <header class="cfg-header">
        <div class="earth-bar-left">
          <span class="tbl-brand">CONFIG // APP WINDOWS &amp; QUERIES</span>
          <span class="tbl-cadence" data-testid="config-sync-status">${escapeHtml(saveLabel)}</span>
        </div>
        <div class="earth-bar-right">
          <button type="button" class="tbl-chip" data-action="open-camera" data-testid="cfg-open-camera">camera studio</button>
          <button type="button" class="tbl-chip" data-cfg-reset="1" data-testid="cfg-reset">reset defaults</button>
          <button type="button" class="tbl-chip is-active" data-action="close-config" data-testid="config-done">done</button>
        </div>
      </header>

      <div class="cfg-body">
        <section class="cfg-section">
          <div class="cfg-section-title">1. APP WINDOW LAYOUT (AUTO = LEFT/RIGHT WIDE · TOP/BOTTOM MOBILE)</div>
          <div class="cfg-layout-row">${layoutCards}</div>
        </section>

        <section class="cfg-section">
          <div class="cfg-section-title">2. WINDOW PANE MAP — CLICK A PANE (#${state.activePaneIndex + 1} SELECTED), THEN ASSIGN GLOBE OR ANY QUERY BELOW</div>
          <div class="cfg-pane-map" data-layout="${resolvedEff}" data-testid="cfg-pane-map">${paneSlots}</div>
        </section>

        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">3. PANELS &amp; QUERY SET (SINGLE-BUTTON RATES)</span>
            <span class="cfg-btn-row">${addButtons}</span>
          </div>
          <div class="cfg-table-wrap">
            <table class="earth-table" data-testid="cfg-query-table">
              <thead>
                <tr>
                  <th>PANEL / QUERY (SET IN #${state.activePaneIndex + 1})</th>
                  <th>SOURCE</th>
                  <th>NETWORK</th>
                  <th>BEST-EFFORT RATE</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${queryRows}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderBottomBar(): void {
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

  const visibleQs = visibleQueryObjects();
  const totalBps = visibleQs.reduce((acc, q) => acc + q.estBytesPerSec, 0);
  const baseCadence = formatCadenceLabel(
    state.currentPollMs,
    state.unchangedStreak,
    state.notModifiedCount,
  );
  const trafficSummary =
    visibleQs.length === 0
      ? `BASE ONLY · 0 B/s · ${baseCadence}`
      : `${visibleQs.length} ACTIVE · ${totalBps} B/s · ${baseCadence}`;

  const camBadge =
    state.cameraResult.ok && state.cameraResult.target
      ? `CAM: ${state.cameraResult.target.node ?? `${state.cameraResult.target.lat.toFixed(1)}°,${state.cameraResult.target.lng.toFixed(1)}°`}${state.cameraResult.target.reason ? ` (${state.cameraResult.target.reason})` : ""}`
      : "CAM: free";

  const authAction = isLive
    ? `<a class="tbl-chip" data-testid="auth-logout" href="${escapeHtml(state.session.logout_url || "/cdn-cgi/access/logout")}">sign out</a>`
    : state.session.login_url
      ? `<a class="tbl-chip" data-testid="auth-login" href="${escapeHtml(state.session.login_url)}">sign in</a>`
      : "";

  const liveBannerBar = state.liveError
    ? `<div class="tbl-banner-bar is-warn">${escapeHtml(state.liveError)}</div>`
    : liveCtrl?.banner
      ? `<div class="tbl-banner-bar is-live" data-testid="live-cli-banner"><strong>REV #${liveCtrl.revision}</strong> ${escapeHtml(liveCtrl.banner)}</div>`
      : "";

  const isMax = state.maximizedPaneIndex !== null;

  dockEl.innerHTML = `
    <div class="earth-table-frame">
      ${liveBannerBar}
      <div class="earth-table-bar">
        <div class="earth-bar-left">
          <a class="tbl-brand" href="/">${escapeHtml(brand)}</a>
          ${statusPill}
          <span class="tbl-cadence" data-testid="mesh-cadence">${escapeHtml(trafficSummary)}</span>
          <span class="tbl-cadence" data-testid="camera-readout">${escapeHtml(camBadge)}</span>
        </div>
        <div class="earth-bar-right">
          <button type="button" class="tbl-chip ${isMax ? "is-active" : ""}" data-action="toggle-fullscreen" data-testid="toggle-fullscreen" aria-pressed="${isMax}">${isMax ? "split" : "full"}</button>
          <button type="button" class="tbl-chip ${state.cameraOpen ? "is-active" : ""}" data-action="open-camera" data-testid="open-camera">camera</button>
          <button type="button" class="tbl-chip ${state.configOpen ? "is-active" : ""}" data-action="open-config" data-testid="open-config">menu</button>
          ${authAction}
        </div>
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
          const pathTag =
            h.path_mode === "lan"
              ? " LAN"
              : h.path_mode === "direct"
                ? " DIR"
                : h.path_mode === "relay"
                  ? " RLY"
                  : "";
          const rtt =
            typeof h.rtt_ms === "number" && h.rtt_ms > 0
              ? `${h.rtt_ms.toFixed(1)} ms${pathTag}`
              : "local";
          const cores = h.stats.cpu_cores ?? 0;
          const cpuCell = cores > 0 ? `${cpuPct.toFixed(0)}% (${cores}c)` : `${cpuPct.toFixed(0)}%`;
          const memTotalBytes = h.stats.mem_total_bytes ?? 0;
          const ramCell =
            memTotalBytes > 0
              ? `${((h.stats.mem_used_bytes ?? 0) / 1e9).toFixed(1)}/${(memTotalBytes / 1e9).toFixed(0)} GB`
              : `${memPct.toFixed(0)}%`;
          return `<tr class="is-clickable ${selected}" data-select-host="${escapeHtml(h.name)}" data-host-net="${escapeHtml(net.slug)}">
            <td class="c-strong"><span class="tbl-dot ${loadClass}"></span>${escapeHtml(h.name)}</td>
            <td>${escapeHtml(h.os)}/${escapeHtml(h.arch)}</td>
            <td>${cpuCell}</td>
            <td>${ramCell}</td>
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
    const cores = host.stats.cpu_cores ?? 0;
    const load1m = (host.stats.load_avg_1m ?? 0).toFixed(2);
    const memTotalBytes = host.stats.mem_total_bytes ?? 0;
    const ramSummary =
      memTotalBytes > 0
        ? `RAM ${((host.stats.mem_used_bytes ?? 0) / 1e9).toFixed(1)}/${(memTotalBytes / 1e9).toFixed(0)} GB`
        : `RAM ${(host.stats.mem_percent ?? 0).toFixed(0)}%`;
    const diskTotalBytes = host.stats.disk_total_bytes ?? 0;
    const diskSummary =
      diskTotalBytes > 0
        ? `DISK ${((host.stats.disk_used_bytes ?? 0) / 1e9).toFixed(0)}/${(diskTotalBytes / 1e9).toFixed(0)} GB`
        : `DISK ${(host.stats.disk_percent ?? 0).toFixed(0)}%`;
    const gpuTotalBytes = host.stats.gpu_mem_total_bytes ?? 0;
    const gpuSummary =
      gpuTotalBytes > 0
        ? ` · GPU ${host.gpuName ?? "VRAM"} (${((host.stats.gpu_mem_used_bytes ?? 0) / 1e9).toFixed(1)}/${(gpuTotalBytes / 1e9).toFixed(0)} GB)`
        : "";
    const cpuSummary =
      cores > 0
        ? `CPU ${cpuPct}% (${cores}c, load ${load1m})`
        : `CPU ${cpuPct}% (load ${load1m})`;
    const blobMb = (host.blobStore.totalBytes / 1e6).toFixed(1);
    const rows: Array<[string, string, string]> = [
      [
        "host",
        `${host.name} (${host.os}/${host.arch})`,
        `v${host.version} · ${host.relay_region} · ${host.probeSummary}`,
      ],
      [
        "compute",
        cpuSummary,
        `${ramSummary} · ${diskSummary}${gpuSummary}`,
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
  // Bottom bar panel / query chips
  app.querySelectorAll<HTMLButtonElement>("[data-pick-content]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.pickContent;
      if (!id) return;
      if (id === GLOBE_PANE_ID) {
        assignContentToPane(state.activePaneIndex, GLOBE_PANE_ID);
      } else {
        exitTour();
        const paneIdx = targetQueryPaneIndex();
        state.activePaneIndex = paneIdx;
        assignContentToPane(paneIdx, id);
      }
      renderAll();
      syncGlobeFocus();
      void reportLivePresence();
    });
  });

  // Per-pane full / split maximize toggle
  app.querySelectorAll<HTMLButtonElement>("[data-max-pane]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const idx = Number(btn.dataset.maxPane ?? 0);
      state.activePaneIndex = idx;
      state.maximizedPaneIndex = state.maximizedPaneIndex === idx ? null : idx;
      renderAll();
    });
  });

  app
    .querySelector<HTMLButtonElement>('[data-action="toggle-fullscreen"]')
    ?.addEventListener("click", () => {
      state.maximizedPaneIndex =
        state.maximizedPaneIndex !== null ? null : state.activePaneIndex;
      renderAll();
    });

  // Open / close visual Config Page & Fullscreen Camera Studio
  app
    .querySelectorAll<HTMLButtonElement>('[data-action="open-config"]')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        state.cameraOpen = false;
        state.configOpen = !state.configOpen;
        renderAll();
      });
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="close-config"]')
    ?.addEventListener("click", () => {
      state.configOpen = false;
      for (const q of visibleQueryObjects()) {
        q.nextDueAtMs = Date.now();
      }
      renderAll();
      syncGlobeFocus();
    });

  app
    .querySelectorAll<HTMLButtonElement>('[data-action="open-camera"]')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        state.configOpen = false;
        state.cameraOpen = !state.cameraOpen;
        if (state.cameraOpen) {
          state.cameraDraftCode = state.cameraPolicyCode;
        }
        renderAll();
      });
    });

  app
    .querySelector<HTMLButtonElement>('[data-action="close-camera"]')
    ?.addEventListener("click", () => {
      state.cameraOpen = false;
      renderAll();
      syncGlobeFocus();
    });

  // Config Page: single-button visual layout cards
  app.querySelectorAll<HTMLButtonElement>("[data-layout-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextPref = btn.dataset.layoutBtn as LayoutPreference | undefined;
      if (!nextPref) return;
      state.layoutPref = nextPref;
      state.maximizedPaneIndex = null;
      const eff = resolveEffectiveLayout(state.layoutPref, window.innerWidth);
      state.paneContents = normalizePaneAssignments(
        state.paneContents,
        state.queries,
        eff,
      );
      if (state.activePaneIndex >= state.paneContents.length) {
        state.activePaneIndex = 0;
      }
      persistUserConfig();
      renderAll();
    });
  });

  // Config Page: click a visual pane slot in the pane map
  app.querySelectorAll<HTMLButtonElement>("[data-cfg-pane]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activePaneIndex = Number(btn.dataset.cfgPane ?? 0);
      renderAll();
    });
  });

  // Config Page: assign globe or query to active pane in 1 click
  app.querySelectorAll<HTMLButtonElement>("[data-cfg-assign]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.cfgAssign;
      if (!id) return;
      assignContentToPane(state.activePaneIndex, id);
      renderAll();
    });
  });

  // Config Page: 1-click source toggle
  app.querySelectorAll<HTMLButtonElement>("[data-cfg-source]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.cfgSource || "";
      const sep = raw.lastIndexOf(":");
      if (sep < 0) return;
      const q = getQueryById(raw.slice(0, sep));
      q.source = raw.slice(sep + 1) as QuerySource;
      persistUserConfig();
      renderAll();
    });
  });

  // Config Page: 1-click network toggle
  app.querySelectorAll<HTMLButtonElement>("[data-cfg-net]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.cfgNet || "";
      const sep = raw.lastIndexOf(":");
      if (sep < 0) return;
      const q = getQueryById(raw.slice(0, sep));
      q.networkSlug = raw.slice(sep + 1);
      q.nextDueAtMs = Date.now();
      persistUserConfig();
      renderAll();
    });
  });

  // Config Page: 1-click best-effort rate toggle
  app.querySelectorAll<HTMLButtonElement>("[data-cfg-rate]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.cfgRate || "";
      const sep = raw.lastIndexOf(":");
      if (sep < 0) return;
      const q = getQueryById(raw.slice(0, sep));
      q.rate = raw.slice(sep + 1) as RateTier;
      q.unchangedStreak = 0;
      q.nextDueAtMs = Date.now();
      persistUserConfig();
      renderAll();
    });
  });

  // Config Page: 1-click add preset query
  app.querySelectorAll<HTMLButtonElement>("[data-cfg-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = (btn.dataset.cfgAdd || "hosts") as TableQuery;
      const created = createCustomQuery(state.queries, {
        kind,
        source: defaultSourceForKind(kind),
        networkSlug: state.networkSlug,
        rate: "med",
      });
      state.queries.push(created);
      assignContentToPane(state.activePaneIndex, created.id);
      renderAll();
    });
  });

  // Config Page: remove query
  app.querySelectorAll<HTMLButtonElement>("[data-remove-query]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const removeId = btn.dataset.removeQuery;
      if (!removeId || state.queries.length <= 1) return;
      state.queries = state.queries.filter((q) => q.id !== removeId);
      const eff = resolveEffectiveLayout(state.layoutPref, window.innerWidth);
      state.paneContents = normalizePaneAssignments(
        state.paneContents,
        state.queries,
        eff,
      );
      persistUserConfig();
      renderAll();
    });
  });

  // Config Page: 1-click TypeScript camera policy presets
  app.querySelectorAll<HTMLButtonElement>("[data-cam-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = CAMERA_PRESETS.find((p) => p.id === btn.dataset.camPreset);
      if (!preset) return;
      state.cameraDraftCode = preset.code;
      applyCameraPolicyCode(preset.code);
      renderAll();
    });
  });

  // Camera Studio: syntax-highlighted TypeScript editor (live highlight + scroll sync + Tab + Ctrl+Enter)
  const tsEditor = app.querySelector<HTMLTextAreaElement>("#camera-ts-editor");
  const tsHighlight = app.querySelector<HTMLElement>("#camera-ts-highlight");
  const tsPre = app.querySelector<HTMLElement>("#camera-ts-pre");
  const tsGutter = app.querySelector<HTMLElement>("#camera-ts-gutter");
  const statusPill = app.querySelector<HTMLElement>("#camera-status-pill");
  if (tsEditor) {
    const syncEditorLayers = () => {
      const code = tsEditor.value;
      state.cameraDraftCode = code;
      if (tsHighlight) {
        tsHighlight.innerHTML = highlightTypeScript(code);
      }
      if (tsGutter) {
        tsGutter.textContent = buildLineNumbers(code);
      }
      const ctx = buildCameraContext(
        state.networks,
        state.networkSlug,
        performance.now() / 1000,
      );
      state.cameraDraftResult = evaluateCameraPolicy(code, ctx);
      if (statusPill) {
        const fmt = formatCameraStatus(state.cameraDraftResult);
        statusPill.className = fmt.cls;
        statusPill.textContent = fmt.text;
      }
    };
    tsEditor.addEventListener("input", syncEditorLayers);
    tsEditor.addEventListener("scroll", () => {
      if (tsPre) {
        tsPre.scrollTop = tsEditor.scrollTop;
        tsPre.scrollLeft = tsEditor.scrollLeft;
      }
      if (tsGutter) {
        tsGutter.scrollTop = tsEditor.scrollTop;
      }
    });
    tsEditor.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = tsEditor.selectionStart;
        const end = tsEditor.selectionEnd;
        tsEditor.value =
          tsEditor.value.slice(0, start) + "  " + tsEditor.value.slice(end);
        tsEditor.selectionStart = tsEditor.selectionEnd = start + 2;
        syncEditorLayers();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        state.cameraDraftCode = tsEditor.value;
        applyCameraPolicyCode(tsEditor.value);
        renderAll();
      }
    });
  }

  app
    .querySelector<HTMLButtonElement>('[data-action="apply-camera-ts"]')
    ?.addEventListener("click", () => {
      const code = tsEditor ? tsEditor.value : state.cameraDraftCode;
      state.cameraDraftCode = code;
      applyCameraPolicyCode(code);
      renderAll();
    });

  // Config Page: reset defaults
  app
    .querySelector<HTMLButtonElement>("[data-cfg-reset]")
    ?.addEventListener("click", () => {
      state.queries = createDefaultQuerySet(state.networks);
      state.layoutPref = "auto";
      state.maximizedPaneIndex = null;
      state.paneContents = [GLOBE_PANE_ID, state.queries[0].id];
      state.activePaneIndex = 0;
      state.cameraDraftCode = CAMERA_PRESETS[0].code;
      applyCameraPolicyCode(CAMERA_PRESETS[0].code);
      try {
        window.localStorage.removeItem(LOCAL_UI_CONFIG_KEY);
      } catch {
        // ignore
      }
      if (state.session.authenticated) {
        void fetch("/api/user/ui-config", { method: "DELETE" });
        state.configSyncLabel = "CF RESET";
      } else {
        state.configSyncLabel = "LOCAL RESET";
      }
      renderAll();
    });

  // Focus live pane on click
  app.querySelectorAll<HTMLElement>("[data-pane-index]").forEach((pane) => {
    pane.addEventListener("mousedown", () => {
      const idx = Number(pane.dataset.paneIndex ?? 0);
      if (idx !== state.activePaneIndex) {
        state.activePaneIndex = idx;
        const contentId = state.paneContents[idx];
        if (contentId && contentId !== GLOBE_PANE_ID) {
          state.networkSlug = getQueryById(contentId).networkSlug;
        }
        renderAll();
        syncGlobeFocus();
      }
    });
  });

  // Row drill-downs inside query tables
  app
    .querySelectorAll<HTMLElement>("[data-select-network]")
    .forEach((row) => {
      row.addEventListener("click", () => {
        const slug = row.dataset.selectNetwork;
        if (!slug) return;
        exitTour();
        state.networkSlug = slug;
        const q = ensureQueryForKind("hosts", slug);
        const idx = targetQueryPaneIndex();
        state.activePaneIndex = idx;
        assignContentToPane(idx, q.id);
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
      const idx = targetQueryPaneIndex();
      state.activePaneIndex = idx;
      assignContentToPane(idx, q.id);
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
      const idx = targetQueryPaneIndex();
      state.activePaneIndex = idx;
      assignContentToPane(idx, q.id);
      renderAll();
    });
  });

  // Tour controls (inside globe panel and config closed-caption bar)
  app
    .querySelectorAll<HTMLButtonElement>('[data-action="prev-step"]')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextIdx =
          (state.tourStepIndex - 1 + state.tourSteps.length) %
          state.tourSteps.length;
        applyTourStep(nextIdx, false);
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>('[data-action="next-step"]')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextIdx = (state.tourStepIndex + 1) % state.tourSteps.length;
        applyTourStep(nextIdx, false);
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>('[data-action="toggle-tour"]')
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tourPlaying = !state.tourPlaying;
        state.tourCaptionsVisible = state.tourPlaying;
        if (state.tourPlaying) startTourTimer();
        else clearTourTimer();
        renderAll();
      });
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
  const idx = targetQueryPaneIndex();
  if (state.paneContents[idx] !== GLOBE_PANE_ID) {
    state.paneContents[idx] = q.id;
  }
  if (!keepPlaying) {
    state.tourPlaying = false;
    clearTourTimer();
  }
  renderAll();
  syncGlobeFocus();
}

function applyCameraPolicyCode(code: string): void {
  const ctx = buildCameraContext(
    state.networks,
    state.networkSlug,
    performance.now() / 1000,
  );
  const result = evaluateCameraPolicy(code, ctx);
  state.cameraResult = result;
  if (result.ok) {
    state.cameraPolicyCode = code;
    persistUserConfig();
    globeController?.setCameraTarget(result.target);
  }
}

function syncGlobeFocus(): void {
  globeController?.syncQueryLayers(currentGlobeLayers());
  const ctx = buildCameraContext(
    state.networks,
    state.networkSlug,
    performance.now() / 1000,
  );
  const result = evaluateCameraPolicy(state.cameraPolicyCode, ctx);
  state.cameraResult = result;
  if (result.ok) {
    globeController?.setCameraTarget(result.target);
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
