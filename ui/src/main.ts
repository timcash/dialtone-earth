import "./style.css";
import {
  classifyTestSection,
  elapsedSeconds,
  normalizeStatus,
  parseStructuredLogLine,
  statusLabel,
  testLogHref,
} from "./model.js";

type TestRow = {
  name: string;
  title: string;
  section?: string;
  source?: string;
  status: string;
  elapsed: string;
  timestamp: string;
  "test-id"?: string;
};

type TestRun = TestRow & {
  "test-id": string;
  command: string;
  log: string;
  artifact?: string;
  completed_at?: string;
};

type CdpTarget = {
  id: string;
  title: string;
  url: string;
};

type CdpStatus = {
  connected: boolean;
  port: number;
  pid?: number | null;
  app_url?: string;
  active_target_id?: string;
  active_origin?: string;
  page_count?: number;
  targets?: CdpTarget[];
};

type PipelineStatus = {
  stage: string;
  message: string;
  changed?: string;
  target_origin?: string;
  deploy_url?: string;
  version_id?: string;
  passed?: number;
  failed?: number;
  total?: number;
  updated_at?: string;
};

type SplitLayout = "1" | "1|1" | "1/1" | "1|2" | "2x2";
type LayoutPref = "auto" | SplitLayout;

type WorkspaceContent = {
  id: string;
  kind: "tests-all" | "tests-browser" | "log" | "browser";
  label: string;
  sourceTag: string;
  sourceClass: "is-ch" | "is-cf" | "is-warn";
  targetId?: string;
  viewport?: "wide" | "mobile";
  url?: string;
};

const SPLIT_LAYOUTS: Array<{ id: SplitLayout; label: string; panes: number; title: string }> = [
  { id: "1", label: "1", panes: 1, title: "Single full pane" },
  { id: "1|1", label: "1|1", panes: 2, title: "Left / Right split" },
  { id: "1/1", label: "1/1", panes: 2, title: "Top / Bottom split" },
  { id: "1|2", label: "1|2", panes: 3, title: "Left + two stacked right panes (3 panes)" },
  { id: "2x2", label: "2x2", panes: 4, title: "Quad 2×2 split (4 panes)" },
];

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) {
  throw new Error("missing #app");
}
const app: HTMLElement = appElement;

// Persistent workspace state (saved in localStorage so reloads keep your panes)
let tests: TestRow[] = [];
let loaded = false;
let errorMessage = "";
let starting = false;
let useBrowser = true;
let keepSignedIn = true;
let deployOnPass = false;
let theme: "dark" | "light" = (localStorage.getItem("dt_test_theme") as "dark" | "light") || "dark";
let layoutPref: LayoutPref = (localStorage.getItem("dt_test_layout_v2") as LayoutPref) || "auto";
let paneContents: string[] = loadSavedPanes();
let focusedPane = 0;
let maximizedPane: number | null = null;
let menuOpen = false;
let selectedTestId = "";
type StagingEnvStatus = {
  preview?: {
    ok?: boolean;
    channel?: string;
    preview_url?: string;
    nodes?: Array<{ node?: string; reachable?: boolean; nodeCount?: number }>;
  };
  release_channels?: Record<string, { tag?: string }>;
  deploy?: {
    ready?: boolean;
    has_changes?: boolean;
    all_tests_passed?: boolean;
    tested_matches_current?: boolean;
    browser_passed?: number;
    browser_total?: number;
    current_hash?: string;
    tested_hash?: string;
    deployed_hash?: string;
    reason?: string;
  };
};

let selectedLogRun: TestRun | null = null;
let newBrowserUrlDraft = "http://127.0.0.1:5175/";
let stagingEnv: StagingEnvStatus = {};

let cdpStatus: CdpStatus = { connected: false, port: 9222, targets: [] };
let pipelineStatus: PipelineStatus = { stage: "idle", message: "Ready" };
let lastRunningTestName = "";
let streamNonce = 1;
let wmMounted = false;

function loadSavedPanes(): string[] {
  try {
    const raw = localStorage.getItem("dt_test_panes_v2");
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  // Default 1|2 layout: full-height test table on left (#1), wide desktop (#2) & mobile (#3) browsers stacked on right
  return ["tests:all", "browser:wide", "browser:mobile", "log:active"];
}

function saveWorkspacePrefs(): void {
  try {
    localStorage.setItem("dt_test_theme", theme);
    localStorage.setItem("dt_test_layout_v2", layoutPref);
    localStorage.setItem("dt_test_panes_v2", JSON.stringify(paneContents));
  } catch {
    // ignore
  }
}

function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", theme);
}

function resolveEffectiveLayout(): SplitLayout {
  if (maximizedPane !== null) return "1";
  // Mobile viewports strictly stay single-column ("1" or stacked "1/1")
  if (window.innerWidth < 900) {
    return layoutPref === "1" ? "1" : "1/1";
  }
  if (layoutPref !== "auto") return layoutPref;
  return "1|2";
}

function paneCountFor(layout: SplitLayout): number {
  return SPLIT_LAYOUTS.find((l) => l.id === layout)?.panes ?? 2;
}

function shortHostLabel(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return rawUrl || "chrome";
  }
}

function availableContents(): WorkspaceContent[] {
  const activeOrigin = (
    pipelineStatus.target_origin ||
    cdpStatus.active_origin ||
    stagingEnv.preview?.preview_url ||
    "http://127.0.0.1:5175"
  ).replace(/\/+$/, "");
  const isProdTarget = activeOrigin.startsWith("https://");
  const targets = cdpStatus.targets && cdpStatus.targets.length > 0 ? cdpStatus.targets : [];
  const primaryTarget =
    (cdpStatus.active_target_id ? targets.find((t) => t.id === cdpStatus.active_target_id) : undefined) ||
    targets.find((t) => t.url.startsWith(activeOrigin)) ||
    targets.find((t) => t.url.includes("127.0.0.1:5175")) ||
    targets.find((t) => t.url.includes("metal.dialtone.earth")) ||
    targets[0];

  const items: WorkspaceContent[] = [
    {
      id: "tests:all",
      kind: "tests-all",
      label: "db:tests",
      sourceTag: isProdTarget ? "LIVE PROD" : "STAGING TEST",
      sourceClass: "is-ch",
    },
    {
      id: "browser:wide",
      kind: "browser",
      label: "browser:wide",
      sourceTag: cdpStatus.connected ? (isProdTarget ? "PROD WIDE 1440×900" : "WIDE 1440×900") : "OFFLINE",
      sourceClass: cdpStatus.connected ? "is-ch" : "is-warn",
      targetId: primaryTarget?.id,
      viewport: "wide",
      url: primaryTarget?.url || `${activeOrigin}/`,
    },
    {
      id: "browser:mobile",
      kind: "browser",
      label: "browser:mobile",
      sourceTag: cdpStatus.connected ? (isProdTarget ? "PROD MOBILE 390×844" : "MOBILE 390×844") : "OFFLINE",
      sourceClass: cdpStatus.connected ? "is-ch" : "is-warn",
      viewport: "mobile",
      url: `${activeOrigin}/`,
    },
    { id: "tests:browser", kind: "tests-browser", label: "cdp:suite", sourceTag: "CDP", sourceClass: "is-ch" },
    { id: "log:active", kind: "log", label: "run:log", sourceTag: "LOG", sourceClass: "is-cf" },
  ];

  // Include any additional user-opened Chrome tabs beyond the primary staging tab
  let extraNum = 3;
  for (const t of targets) {
    if (primaryTarget && t.id === primaryTarget.id) continue;
    items.push({
      id: `browser:${t.id}`,
      kind: "browser",
      label: `browser:${extraNum} (${shortHostLabel(t.url).slice(0, 22)})`,
      sourceTag: `CDP:${cdpStatus.port}`,
      sourceClass: "is-ch",
      targetId: t.id,
      url: t.url,
    });
    extraNum += 1;
  }
  return items;
}

function normalizedAssignments(layout: SplitLayout, catalog: WorkspaceContent[]): WorkspaceContent[] {
  if (maximizedPane !== null) {
    const id = paneContents[maximizedPane] || catalog[0].id;
    const found = catalog.find((c) => c.id === id) || catalog[0];
    return [found];
  }
  const count = paneCountFor(layout);
  const valid = new Map(catalog.map((c) => [c.id, c]));
  const result: WorkspaceContent[] = [];
  for (let i = 0; i < count; i += 1) {
    const wanted = paneContents[i];
    if (wanted && valid.has(wanted)) {
      result.push(valid.get(wanted)!);
    } else {
      const fallback = catalog.find((c) => !result.some((r) => r.id === c.id)) || catalog[i % catalog.length];
      result.push(fallback);
      paneContents[i] = fallback.id;
    }
  }
  if (focusedPane >= result.length) focusedPane = 0;
  return result;
}

function ensureWmShell(): void {
  applyTheme();
  if (wmMounted) return;
  wmMounted = true;
  app.innerHTML = `
    <div class="hud-shell app-wm-shell" data-testid="wm-shell">
      <div class="app-window-grid earth-split-grid" data-testid="split-grid" data-layout="1|1"></div>
      <footer class="app-bottom-bar" data-testid="bottom-bar"></footer>
      <section class="config-page" data-testid="menu-overlay" hidden></section>
    </div>
  `;
  window.addEventListener("resize", () => {
    if (layoutPref === "auto") renderWorkspace();
  });
}

function renderWorkspace(): void {
  ensureWmShell();
  const shell = app.querySelector<HTMLElement>("[data-testid='wm-shell']")!;
  const grid = app.querySelector<HTMLElement>("[data-testid='split-grid']")!;
  const bottomBar = app.querySelector<HTMLElement>("[data-testid='bottom-bar']")!;
  const menuEl = app.querySelector<HTMLElement>("[data-testid='menu-overlay']")!;

  shell.classList.toggle("is-config-open", menuOpen);

  const layout = resolveEffectiveLayout();
  grid.setAttribute("data-layout", layout);

  const catalog = availableContents();
  const assigned = normalizedAssignments(layout, catalog);
  const runningTest = tests.find((t) => normalizeStatus(t.status) === "running");
  const isBrowserDemo = Boolean(runningTest && runningTest.name.startsWith("TestBrowser"));

  // Sync pane count without destroying active MJPEG browser streams unnecessarily.
  while (grid.children.length > assigned.length) {
    grid.lastElementChild?.remove();
  }
  while (grid.children.length < assigned.length) {
    const paneEl = document.createElement("section");
    paneEl.className = "earth-pane";
    paneEl.innerHTML = `<div class="earth-pane-head"></div><div class="pane-body-slot" style="display:flex;flex-direction:column;flex:1;min-height:0;"></div>`;
    grid.appendChild(paneEl);
  }

  assigned.forEach((content, idx) => {
    const paneEl = grid.children[idx] as HTMLElement;
    const isFocused = idx === focusedPane;
    const isDemoPane =
      content.kind === "browser" &&
      isBrowserDemo &&
      (content.id === "browser:wide" || content.id === "browser:mobile" || idx === 1);
    paneEl.setAttribute("data-testid", `wm-pane-${idx}`);
    paneEl.setAttribute("data-content-id", content.id);
    paneEl.classList.toggle("is-focused", isFocused);
    paneEl.classList.toggle("is-demonstrating", isDemoPane);
    paneEl.classList.toggle("is-deploying", content.kind === "browser" && pipelineStatus.stage === "deploying");

    paneEl.onclick = () => {
      if (focusedPane !== idx) {
        focusedPane = idx;
        renderWorkspace();
      }
    };

    const head = paneEl.querySelector<HTMLElement>(".earth-pane-head")!;
    const bodySlot = paneEl.querySelector<HTMLElement>(".pane-body-slot")!;

    let statsText = "";
    if (content.kind === "tests-all" || content.kind === "tests-browser") {
      const subset = content.kind === "tests-browser" ? tests.filter((t) => t.name.startsWith("TestBrowser")) : tests;
      const pCount = subset.filter((t) => normalizeStatus(t.status) === "pass").length;
      const fCount = subset.filter((t) => normalizeStatus(t.status) === "fail").length;
      statsText = `${pCount}/${subset.length} pass${fCount > 0 ? ` · ${fCount} fail` : ""}`;
    } else if (content.kind === "browser") {
      statsText = isDemoPane && runningTest
        ? `DEMONSTRATING: ${runningTest.title} (${elapsedSeconds(runningTest).toFixed(1)}s)`
        : content.url || "https://metal.dialtone.earth/";
    } else if (content.kind === "log") {
      statsText = selectedLogRun ? `${selectedLogRun.name} (${statusLabel(selectedLogRun.status)})` : "select any test row";
    }

    const maxLabel = maximizedPane !== null ? "restore" : "max";
    head.innerHTML = `
      <div class="pane-head-left">
        <span class="pane-num">#${idx + 1}</span>
        <span class="pane-title">${escapeHtml(content.label)}</span>
        <span class="pane-source ${content.sourceClass}">${escapeHtml(content.sourceTag)}</span>
        <span class="pane-stats" data-pane-stats="${idx}">${escapeHtml(statsText)}</span>
      </div>
      <div class="pane-head-right">
        ${
          content.kind === "browser" && cdpStatus.connected
            ? `<button type="button" class="row-btn" data-refresh-stream="${idx}" title="Reconnect stream">refresh</button>`
            : ""
        }
        <button type="button" class="row-btn" data-max-pane="${idx}">${maxLabel}</button>
      </div>
    `;
    head.querySelector<HTMLButtonElement>(`[data-max-pane="${idx}"]`)?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      maximizedPane = maximizedPane !== null ? null : idx;
      renderWorkspace();
    });
    head.querySelector<HTMLButtonElement>(`[data-refresh-stream="${idx}"]`)?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      streamNonce += 1;
      bodySlot.removeAttribute("data-mounted-stream");
      renderWorkspace();
    });

    if (content.kind === "browser") {
      renderBrowserPaneBody(bodySlot, content, isDemoPane, runningTest);
    } else if (content.kind === "tests-all" || content.kind === "tests-browser") {
      bodySlot.removeAttribute("data-mounted-stream");
      renderTestsTableBody(bodySlot, content.kind === "tests-browser");
    } else {
      bodySlot.removeAttribute("data-mounted-stream");
      renderLogPaneBody(bodySlot);
    }
  });

  renderBottomBar(bottomBar, runningTest);
  if (menuOpen) {
    menuEl.hidden = false;
    renderMenuOverlay(menuEl, catalog, assigned);
  } else {
    menuEl.hidden = true;
  }

  // Gently scroll the active running row into view inside the database table pane.
  if (runningTest && runningTest.name !== lastRunningTestName) {
    lastRunningTestName = runningTest.name;
    const row = grid.querySelector<HTMLElement>(`tr[data-test-name="${CSS.escape(runningTest.name)}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (runningTest["test-id"]) {
      selectedTestId = runningTest["test-id"];
      void fetchSelectedLog(selectedTestId);
    }
  } else if (!runningTest) {
    lastRunningTestName = "";
  }
}

function renderBrowserPaneBody(
  slot: HTMLElement,
  content: WorkspaceContent,
  isDemoPane: boolean,
  runningTest: TestRow | undefined,
): void {
  const streamKey = cdpStatus.connected
    ? `${content.viewport || "default"}:${content.viewport === "mobile" ? content.url || "mobile" : content.targetId || "default"}:${streamNonce}`
    : "offline";
  if (slot.getAttribute("data-mounted-stream") !== streamKey) {
    // Explicitly abort any existing MJPEG <img> stream socket before swapping DOM
    // so Chromium immediately releases the HTTP/1.1 connection slot.
    slot.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      img.removeAttribute("src");
      img.src = "";
    });
    slot.setAttribute("data-mounted-stream", streamKey);
    if (cdpStatus.connected) {
      const qs = new URLSearchParams({ v: String(streamNonce) });
      if (content.viewport) qs.set("viewport", content.viewport);
      if (content.targetId && content.viewport !== "mobile") qs.set("targetId", content.targetId);
      const imgCls = content.viewport === "mobile" ? "browser-stream-img is-mobile" : "browser-stream-img";
      slot.innerHTML = `
        <div class="browser-pane-body">
          <div class="browser-stage">
            <img
              data-testid="${content.viewport === "mobile" ? "cdp-mobile-stream" : "cdp-live-stream"}"
              class="${imgCls}"
              src="/api/cdp/stream?${qs.toString()}"
              alt="Projected Chrome browser ${escapeHtml(content.label)}"
            />
          </div>
          <div class="browser-foot" data-browser-foot></div>
        </div>
      `;
    } else {
      slot.innerHTML = `
        <div class="browser-pane-body">
          <div class="browser-placeholder">
            <p>Projected Chrome CDP :${cdpStatus.port} is offline.</p>
            <button type="button" class="tbl-chip is-primary" data-launch-browser-pane>Launch persistent Chrome</button>
          </div>
        </div>
      `;
      slot.querySelector<HTMLButtonElement>("[data-launch-browser-pane]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        launchBrowser().catch(showError);
      });
    }
  }

  const foot = slot.querySelector<HTMLElement>("[data-browser-foot]");
  if (foot) {
    foot.classList.toggle("is-active", isDemoPane);
    const label = isDemoPane && runningTest
      ? `▶ SPOTLIGHT: ${runningTest.title} (${runningTest.name})`
      : pipelineStatus.stage === "deploying"
        ? "DEPLOYING VERIFIED BUILD → https://dialtone.earth/..."
        : pipelineStatus.stage === "deployed"
          ? `LIVE ON dialtone.earth (${(pipelineStatus.version_id || "").slice(0, 8)})`
          : `${content.url || "https://metal.dialtone.earth/"} · persistent CDP reconnect ready`;
    foot.innerHTML = `<span>${escapeHtml(label)}</span><span>${cdpStatus.connected ? "LIVE STREAM" : "OFFLINE"}</span>`;
  }
}

function renderTestsTableBody(slot: HTMLElement, browserOnly: boolean): void {
  const prevScroll = slot.querySelector<HTMLElement>(".earth-table-scroll")?.scrollTop ?? 0;
  const rows = browserOnly ? tests.filter((t) => t.name.startsWith("TestBrowser")) : tests;
  const busy = starting || tests.some((t) => normalizeStatus(t.status) === "running") || pipelineStatus.stage === "deploying";

  if (rows.length === 0) {
    slot.innerHTML = `<div class="browser-placeholder"><p>${loaded ? "No tests listed yet. Press start tests." : "Loading tests…"}</p></div>`;
    return;
  }

  slot.innerHTML = `
    <div class="earth-table-scroll">
      <table class="earth-table" data-testid="tests-db-table">
        <thead>
          <tr>
            <th>STATUS</th>
            <th>TEST</th>
            <th>SECTION</th>
            <th>SOURCE</th>
            <th>TIME</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((test) => {
              const status = normalizeStatus(test.status);
              const elapsed = elapsedSeconds(test).toFixed(2);
              const logHref = testLogHref(test["test-id"], import.meta.env.BASE_URL);
              const dotClass =
                status === "pass"
                  ? "is-low"
                  : status === "fail"
                    ? "is-high"
                    : status === "running"
                      ? "is-low is-pulsing"
                      : status === "skip"
                        ? "is-med"
                        : "is-idle";
              const statusColor =
                status === "pass" || status === "running"
                  ? "c-ok"
                  : status === "fail"
                    ? "c-err"
                    : status === "skip"
                      ? "c-warn"
                      : "c-dim";
              const rowClass = [
                "is-clickable",
                status === "running" ? "is-running-row" : "",
                status === "fail" ? "is-fail-row" : "",
                test["test-id"] && test["test-id"] === selectedTestId ? "is-selected" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const sec = classifyTestSection(test);
              return `
                <tr class="${rowClass}" data-status="${status}" data-testid="test-row" data-test-name="${escapeHtml(test.name)}" data-test-id="${escapeHtml(test["test-id"] || "")}">
                  <td class="${statusColor} c-strong"><span class="tbl-dot ${dotClass}"></span>${escapeHtml(statusLabel(test.status).toUpperCase())}</td>
                  <td><span class="c-strong">${escapeHtml(test.title)}</span> <span class="c-dim">${escapeHtml(test.name)}</span></td>
                  <td class="c-dim">${escapeHtml(sec)}</td>
                  <td class="c-cf">${escapeHtml(test.source || "—")}</td>
                  <td class="c-dim"><time>${elapsed}s</time></td>
                  <td>
                    <span class="row-actions">
                      <button type="button" class="row-btn" data-run-single="${escapeHtml(test.name)}" data-testid="run-test-${escapeHtml(test.name)}" ${busy ? "disabled" : ""}>run</button>
                      ${logHref ? `<a class="row-link" data-testid="test-log-link" href="${escapeHtml(logHref)}" target="_blank" rel="noreferrer">log ↗</a>` : '<span class="c-dim">—</span>'}
                    </span>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  const scroller = slot.querySelector<HTMLElement>(".earth-table-scroll");
  if (scroller) scroller.scrollTop = prevScroll;

  slot.querySelectorAll<HTMLButtonElement>("[data-run-single]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const name = btn.dataset.runSingle || "";
      if (!name) return;
      const forceBrowser = name.startsWith("TestBrowser") || useBrowser;
      startFilteredTests(`^${name}$`, forceBrowser, false).catch(showError);
    });
  });

  slot.querySelectorAll<HTMLTableRowElement>("tr[data-test-name]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const id = tr.dataset.testId || "";
      if (id) {
        selectedTestId = id;
        void fetchSelectedLog(id);
      }
    });
  });
}

function renderLogPaneBody(slot: HTMLElement): void {
  if (!selectedLogRun) {
    slot.innerHTML = `<div class="browser-placeholder"><p>Click any test row in <strong>db:tests</strong> to inspect its structured timestamp / level / file:line log here.</p></div>`;
    return;
  }
  slot.innerHTML = `
    <div class="earth-table-scroll">
      <pre class="log-output" data-testid="pane-log-output">${renderFormattedLog(selectedLogRun.log)}</pre>
    </div>
  `;
}

function renderBottomBar(
  bar: HTMLElement,
  runningTest: TestRow | undefined,
): void {
  const passed = tests.filter((t) => normalizeStatus(t.status) === "pass").length;
  const failed = tests.filter((t) => normalizeStatus(t.status) === "fail").length;
  const stage = pipelineStatus.stage || "idle";
  const busy = starting || Boolean(runningTest) || stage === "deploying" || stage === "verifying_prod";

  const stepClass = (step: "edit" | "testing" | "staging_ready" | "deploying" | "verifying_prod"): string => {
    const order: Record<string, number> = {
      idle: 0,
      edit: 1,
      testing: 2,
      failed: 2,
      passed: 3,
      staging_ready: 3,
      deploying: 4,
      verifying_prod: 5,
      deployed: 6,
    };
    const rank = order[stage] ?? 0;
    const target = { edit: 1, testing: 2, staging_ready: 3, deploying: 4, verifying_prod: 5 }[step];
    if (stage === "failed" && step === "testing") return "failed";
    if (stage === step) return "active";
    if (rank > target) return "done";
    return "";
  };

  const bannerCls =
    stage === "deployed" || stage === "staging_ready" || stage === "testing" || stage === "edit" || stage === "verifying_prod"
      ? "is-live"
      : stage === "deploying"
        ? "is-warn"
        : stage === "failed"
          ? "is-err"
          : "";

  const deployInfo = stagingEnv.deploy;
  const deployReady = Boolean(deployInfo?.ready) && !busy;
  const gatePillClass =
    failed > 0
      ? "is-err"
      : deployReady
        ? "is-live"
        : deployInfo?.has_changes && !deployInfo.tested_matches_current
          ? "is-warn"
          : "";
  const gatePillText =
    failed > 0
      ? `GATE BLOCKED (${failed} fail)`
      : deployReady
        ? `READY (${passed}/${tests.length})`
        : deployInfo && !deployInfo.has_changes
          ? "UP TO DATE"
          : deployInfo?.has_changes && !deployInfo.tested_matches_current
            ? "NEW CHANGES · RUN TESTS"
            : passed > 0
              ? `PASSED ${passed}/${tests.length}`
              : "GATE PENDING";
  const deployTitle = deployReady
    ? "Deploy verified changes to https://dialtone.earth/ and release auto-update channel"
    : deployInfo?.reason || "Deploy unlocks only when new changes pass all tests on the test network";

  bar.innerHTML = `
    ${errorMessage ? `<div class="error-banner" role="alert">${escapeHtml(errorMessage)}</div>` : ""}
    <div class="tbl-banner-bar ${bannerCls}" data-testid="pipeline-bar">
      <div class="pipe-steps">
        <span class="pipe-step ${stepClass("edit")}">1.EDIT</span>
        <span>→</span>
        <span class="pipe-step ${stepClass("testing")}">2.STAGING TESTS</span>
        <span>→</span>
        <span class="pipe-step ${stepClass("staging_ready")}">3.READY</span>
        <span>→</span>
        <span class="pipe-step ${stepClass("deploying")}">4.DEPLOY</span>
        <span>→</span>
        <span class="pipe-step ${stepClass("verifying_prod")}">5.PROD VERIFY</span>
        ${pipelineStatus.changed ? `<span class="c-cf">${escapeHtml(pipelineStatus.changed)}</span>` : ""}
        <span>${escapeHtml(pipelineStatus.message || "Ready — edits stay on staging until you deploy to dialtone.earth")}</span>
      </div>
      <div>
        ${
          stage === "deployed"
            ? `<a class="c-ok" href="${escapeHtml(pipelineStatus.deploy_url || "https://dialtone.earth/")}" target="_blank" rel="noreferrer">dialtone.earth ↗</a>`
            : ""
        }
      </div>
    </div>
    <div class="earth-table-bar">
      <div class="earth-bar-left">
        <span class="tbl-brand">TEST.DIALTONE.EARTH</span>
        <span class="tbl-pill ${cdpStatus.connected ? "is-live" : "is-warn"}" data-testid="cdp-status">
          ${cdpStatus.connected ? `CDP :${cdpStatus.port}` : "CDP OFF"}
        </span>
        <span class="tbl-pill ${stagingEnv.preview?.ok ? "is-live" : "is-warn"}" data-testid="test-mesh-pill" title="Isolated Dialtone Iroh mesh test channel (${escapeHtml(stagingEnv.preview?.preview_url || "http://127.0.0.1:5175/")})">
          ${
            stagingEnv.preview?.ok
              ? `TEST MESH ${(stagingEnv.preview.nodes || []).filter((n) => n.reachable).length}/${(stagingEnv.preview.nodes || []).length}`
              : "TEST MESH OFF"
          }
        </span>
        <span class="tbl-pill ${gatePillClass}" data-testid="staging-gate-pill" title="${escapeHtml(deployTitle)}">
          ${escapeHtml(gatePillText)}
        </span>
      </div>
      <div class="earth-bar-right">
        <button type="button" class="tbl-chip" data-testid="add-browser-btn" title="Open an additional projected Chrome browser tab">+ browser</button>
        <button type="button" class="tbl-chip" data-testid="run-browser-suite" ${busy ? "disabled" : ""}>run browser</button>
        <button type="button" class="tbl-chip" data-testid="run-prod-suite" ${busy ? "disabled" : ""} title="Run the full live production verification suite on https://metal.dialtone.earth & https://dialtone.earth">test live</button>
        <button type="button" class="tbl-chip" data-testid="start-tests" ${busy ? "disabled" : ""}>
          ${starting ? "starting…" : stage === "deploying" ? "deploying…" : stage === "verifying_prod" ? "verifying…" : runningTest ? "running…" : "start tests"}
        </button>
        <button type="button" class="tbl-chip is-deploy" data-testid="deploy-live" ${deployReady ? "" : "disabled"} title="${escapeHtml(deployTitle)}">
          ${stage === "deploying" ? "deploying…" : stage === "verifying_prod" ? "verifying prod…" : "deploy"}
        </button>
        <button type="button" class="tbl-chip ${menuOpen ? "is-active" : ""}" data-testid="open-menu">menu</button>
      </div>
    </div>
  `;

  const startButton = bar.querySelector<HTMLButtonElement>("[data-testid='start-tests']");
  startButton?.addEventListener("click", () => {
    startAllTests().catch(showError);
  });

  bar.querySelector<HTMLButtonElement>("[data-testid='run-prod-suite']")?.addEventListener("click", () => {
    startProdTests().catch(showError);
  });

  bar.querySelector<HTMLButtonElement>("[data-testid='deploy-live']")?.addEventListener("click", () => {
    promoteToLive().catch(showError);
  });

  bar.querySelector<HTMLButtonElement>("[data-testid='run-browser-suite']")?.addEventListener("click", () => {
    startFilteredTests("^TestBrowser", true, deployOnPass).catch(showError);
  });

  bar.querySelector<HTMLButtonElement>("[data-testid='add-browser-btn']")?.addEventListener("click", () => {
    openExtraProjectedBrowser("http://127.0.0.1:5175/").catch(showError);
  });

  bar.querySelector<HTMLButtonElement>("[data-testid='open-menu']")?.addEventListener("click", () => {
    menuOpen = !menuOpen;
    renderWorkspace();
  });
}

function renderMenuOverlay(menuEl: HTMLElement, catalog: WorkspaceContent[], assigned: WorkspaceContent[]): void {
  const effectiveLayout = resolveEffectiveLayout();
  const wireframeCells = (layout: SplitLayout): string => {
    const count = paneCountFor(layout);
    return Array.from({ length: count }, () => "<i></i>").join("");
  };

  menuEl.innerHTML = `
    <div class="cfg-frame">
      <div class="cfg-header">
        <div class="pane-head-left">
          <span class="tbl-brand">DIALTONE.EARTH // MENU & WINDOW MANAGER</span>
          <span class="tbl-pill ${cdpStatus.connected ? "is-live" : ""}">CDP :${cdpStatus.port} (${cdpStatus.targets?.length ?? 0} browser tab(s))</span>
        </div>
        <div class="pane-head-right">
          <button type="button" class="tbl-chip" data-toggle-theme>theme: ${theme}</button>
          <button type="button" class="tbl-chip is-active" data-testid="menu-done">done</button>
        </div>
      </div>

      <div class="cfg-body">
        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">1. Tiling Window Layout</span>
            <span class="c-dim">Matches dialtone.earth split layouts</span>
          </div>
          <div class="cfg-layout-row">
            <button type="button" class="cfg-layout-card ${layoutPref === "auto" ? "is-active" : ""}" data-set-layout="auto" data-testid="layout-auto">
              <span class="cfg-wireframe" data-layout="${effectiveLayout}">${wireframeCells(effectiveLayout)}</span>
              <span class="cfg-layout-label">auto</span>
            </button>
            ${SPLIT_LAYOUTS.map(
              (l) => `
              <button type="button" class="cfg-layout-card ${layoutPref === l.id ? "is-active" : ""}" data-set-layout="${l.id}" data-testid="layout-${l.id}" title="${escapeHtml(l.title)}">
                <span class="cfg-wireframe" data-layout="${l.id}">${wireframeCells(l.id)}</span>
                <span class="cfg-layout-label">${l.label}</span>
              </button>
            `,
            ).join("")}
          </div>
        </section>

        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">2. Active Pane Assignments (click a pane slot, then assign a table or projected browser below)</span>
          </div>
          <div class="cfg-pane-map" data-layout="${effectiveLayout}">
            ${assigned
              .map(
                (item, idx) => `
              <button type="button" class="cfg-pane-slot ${idx === focusedPane ? "is-active" : ""}" data-select-pane="${idx}" data-testid="cfg-pane-${idx}">
                <span class="cfg-slot-top">PANE #${idx + 1} ${idx === focusedPane ? "· SELECTED" : ""}</span>
                <span class="cfg-slot-name">${escapeHtml(item.label)}</span>
                <span class="cfg-slot-sub">${escapeHtml(item.url || item.sourceTag)}</span>
              </button>
            `,
              )
              .join("")}
          </div>
        </section>

        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">3. Available Views & Projected Chrome Browsers</span>
          </div>
          <div class="cfg-table-wrap">
            <table class="earth-table">
              <thead>
                <tr>
                  <th>VIEW / BROWSER</th>
                  <th>TYPE</th>
                  <th>TARGET</th>
                  <th>ASSIGN TO PANE #${focusedPane + 1}</th>
                </tr>
              </thead>
              <tbody>
                ${catalog
                  .map(
                    (item) => `
                  <tr>
                    <td class="c-strong">${escapeHtml(item.label)}</td>
                    <td><span class="pane-source ${item.sourceClass}">${escapeHtml(item.sourceTag)}</span></td>
                    <td class="c-dim">${escapeHtml(item.url || item.id)}</td>
                    <td>
                      <button type="button" class="row-btn" data-assign-content="${escapeHtml(item.id)}">
                        ${assigned[focusedPane]?.id === item.id ? "assigned ✓" : `assign → #${focusedPane + 1}`}
                      </button>
                    </td>
                  </tr>
                `,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>

        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">4. Add Another Projected Browser (Multi-Browser CDP)</span>
          </div>
          <div class="cfg-controls-row">
            <input type="url" class="cfg-url-input" data-new-browser-url value="${escapeHtml(newBrowserUrlDraft)}" placeholder="https://dialtone.earth/" />
            <button type="button" class="tbl-chip is-primary" data-spawn-browser-url>open projected browser</button>
            <button type="button" class="tbl-chip" data-quick-url="https://dialtone.earth/">+ dialtone.earth</button>
            <button type="button" class="tbl-chip" data-quick-url="https://metal.dialtone.earth/">+ metal.dialtone.earth</button>
          </div>
        </section>

        <section class="cfg-section">
          <div class="cfg-section-head">
            <span class="cfg-section-title">5. Test Runner & Auto-Deploy Options</span>
          </div>
          <div class="cfg-controls-row">
            <label class="cfg-toggle">
              <input type="checkbox" data-testid="toggle-browser" ${useBrowser ? "checked" : ""} />
              <span>Live Browser (CDP)</span>
            </label>
            <label class="cfg-toggle">
              <input type="checkbox" data-testid="toggle-keep-signed-in" ${keepSignedIn ? "checked" : ""} />
              <span>Keep signed in</span>
            </label>
            <label class="cfg-toggle">
              <input type="checkbox" data-testid="toggle-deploy-on-pass" ${deployOnPass ? "checked" : ""} />
              <span>Auto-deploy to dialtone.earth on pass</span>
            </label>
            ${
              cdpStatus.connected
                ? `<button type="button" class="tbl-chip" data-testid="close-browser">close persistent chrome</button>`
                : `<button type="button" class="tbl-chip is-primary" data-testid="launch-browser">launch persistent chrome</button>`
            }
          </div>
        </section>
      </div>
    </div>
  `;

  menuEl.querySelector<HTMLButtonElement>("[data-testid='menu-done']")?.addEventListener("click", () => {
    menuOpen = false;
    renderWorkspace();
  });

  menuEl.querySelector<HTMLButtonElement>("[data-toggle-theme]")?.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    saveWorkspacePrefs();
    renderWorkspace();
  });

  menuEl.querySelectorAll<HTMLButtonElement>("[data-set-layout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = (btn.dataset.setLayout || "auto") as LayoutPref;
      layoutPref = next;
      maximizedPane = null;
      saveWorkspacePrefs();
      renderWorkspace();
    });
  });

  menuEl.querySelectorAll<HTMLButtonElement>("[data-select-pane]").forEach((btn) => {
    btn.addEventListener("click", () => {
      focusedPane = Number(btn.dataset.selectPane || 0);
      renderWorkspace();
    });
  });

  menuEl.querySelectorAll<HTMLButtonElement>("[data-assign-content]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.assignContent || "";
      if (!id) return;
      paneContents[focusedPane] = id;
      saveWorkspacePrefs();
      renderWorkspace();
    });
  });

  const urlInput = menuEl.querySelector<HTMLInputElement>("[data-new-browser-url]");
  urlInput?.addEventListener("input", () => {
    newBrowserUrlDraft = urlInput.value;
  });

  menuEl.querySelector<HTMLButtonElement>("[data-spawn-browser-url]")?.addEventListener("click", () => {
    openExtraProjectedBrowser(newBrowserUrlDraft || "https://dialtone.earth/").catch(showError);
  });

  menuEl.querySelectorAll<HTMLButtonElement>("[data-quick-url]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = btn.dataset.quickUrl || "https://dialtone.earth/";
      openExtraProjectedBrowser(u).catch(showError);
    });
  });

  const browserToggle = menuEl.querySelector<HTMLInputElement>("[data-testid='toggle-browser']");
  browserToggle?.addEventListener("change", () => {
    useBrowser = Boolean(browserToggle.checked);
  });

  const keepSignedInToggle = menuEl.querySelector<HTMLInputElement>("[data-testid='toggle-keep-signed-in']");
  keepSignedInToggle?.addEventListener("change", () => {
    keepSignedIn = Boolean(keepSignedInToggle.checked);
  });

  const deployToggle = menuEl.querySelector<HTMLInputElement>("[data-testid='toggle-deploy-on-pass']");
  deployToggle?.addEventListener("change", () => {
    deployOnPass = Boolean(deployToggle.checked);
  });

  menuEl.querySelector<HTMLButtonElement>("[data-testid='close-browser']")?.addEventListener("click", () => {
    closeBrowser().catch(showError);
  });

  menuEl.querySelector<HTMLButtonElement>("[data-testid='launch-browser']")?.addEventListener("click", () => {
    launchBrowser().catch(showError);
  });
}

async function openExtraProjectedBrowser(targetUrl: string): Promise<void> {
  if (!cdpStatus.connected) {
    await launchBrowser();
  }
  const resp = await fetch(`/api/cdp/new-tab?url=${encodeURIComponent(targetUrl)}`, { method: "POST" });
  const payload = (await resp.json()) as { targetId?: string; error?: string };
  if (!resp.ok) {
    throw new Error(payload.error || `Could not open projected browser: HTTP ${resp.status}`);
  }
  await refreshCdpStatus();
  if (payload.targetId) {
    // Automatically expand to 1|2 layout if currently in 1|1 so user immediately sees multiple projected browsers side-by-side!
    const eff = resolveEffectiveLayout();
    if (eff === "1" || eff === "1|1" || eff === "1/1") {
      layoutPref = "1|2";
      maximizedPane = null;
      paneContents[2] = `browser:${payload.targetId}`;
    } else {
      paneContents[focusedPane] = `browser:${payload.targetId}`;
    }
    saveWorkspacePrefs();
    menuOpen = false;
    renderWorkspace();
  }
}

async function fetchSelectedLog(testId: string): Promise<void> {
  if (!testLogHref(testId)) return;
  try {
    const resp = await fetch(`/api/test-runs/${encodeURIComponent(testId)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { run?: TestRun };
    if (data.run && JSON.stringify(data.run) !== JSON.stringify(selectedLogRun)) {
      selectedLogRun = data.run;
      renderWorkspace();
    }
  } catch {
    // ignore transient poll errors
  }
}

async function refreshTests(): Promise<void> {
  const response = await fetch("/api/tests", { cache: "no-store", signal: AbortSignal.timeout(4000) });
  if (!response.ok) {
    throw new Error(`Could not load tests: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { tests?: TestRow[] };
  if (!Array.isArray(payload.tests)) {
    throw new Error("Could not load tests: malformed response");
  }
  const changed = !loaded || JSON.stringify(tests) !== JSON.stringify(payload.tests) || errorMessage !== "";
  tests = payload.tests;
  loaded = true;
  errorMessage = "";
  if (changed) renderWorkspace();
}

async function refreshPipeline(): Promise<void> {
  try {
    const response = await fetch("/api/pipeline", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return;
    const next = (await response.json()) as PipelineStatus;
    if (JSON.stringify(next) !== JSON.stringify(pipelineStatus)) {
      pipelineStatus = next;
      renderWorkspace();
    }
  } catch {
    // ignore transient poll error
  }
}

async function refreshCdpStatus(): Promise<void> {
  try {
    const response = await fetch("/api/cdp/status", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return;
    const next = (await response.json()) as CdpStatus;
    if (JSON.stringify(next) !== JSON.stringify(cdpStatus)) {
      cdpStatus = next;
      renderWorkspace();
    }
  } catch {
    // ignore transient poll errors
  }
}

async function startAllTests(): Promise<void> {
  await startFilteredTests("", useBrowser, deployOnPass);
}

async function startProdTests(): Promise<void> {
  starting = true;
  errorMessage = "";
  renderWorkspace();
  const response = await fetch("/api/tests/run?prod=1", { method: "POST" });
  const payload = (await response.json()) as { error?: string };
  starting = false;
  if (!response.ok) {
    throw new Error(payload.error || `Could not start live production suite: HTTP ${response.status}`);
  }
  await refreshTests();
  void refreshPipeline();
  void refreshCdpStatus();
}

async function promoteToLive(): Promise<void> {
  starting = true;
  errorMessage = "";
  renderWorkspace();
  const response = await fetch("/api/promote", { method: "POST" });
  const payload = (await response.json()) as { error?: string };
  starting = false;
  if (!response.ok) {
    throw new Error(payload.error || `Staging promotion blocked: HTTP ${response.status}`);
  }
  await refreshPipeline();
}

async function startFilteredTests(filter: string, withBrowser: boolean, withDeploy: boolean): Promise<void> {
  starting = true;
  errorMessage = "";
  renderWorkspace();
  const params = new URLSearchParams();
  if (withBrowser) params.set("browser", "1");
  if (withBrowser && keepSignedIn) params.set("keepSignedIn", "1");
  if (withDeploy) params.set("deployOnPass", "1");
  if (filter) params.set("filter", filter);
  const query = params.toString();
  const response = await fetch(`/api/tests/run${query ? `?${query}` : ""}`, { method: "POST" });
  const payload = (await response.json()) as { error?: string };
  starting = false;
  if (!response.ok) {
    throw new Error(payload.error || `Could not start tests: HTTP ${response.status}`);
  }
  await refreshTests();
  void refreshPipeline();
  void refreshCdpStatus();
}

async function launchBrowser(): Promise<void> {
  const response = await fetch("/api/cdp/ensure", { method: "POST" });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Could not launch browser: HTTP ${response.status}`);
  }
  await refreshCdpStatus();
}

async function closeBrowser(): Promise<void> {
  const response = await fetch("/api/cdp/close", { method: "POST" });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Could not close browser: HTTP ${response.status}`);
  }
  await refreshCdpStatus();
}

function showError(error: unknown): void {
  starting = false;
  errorMessage = error instanceof Error ? error.message : String(error);
  renderWorkspace();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character] ?? character;
  });
}

let renderedRun = "";

function runDetails(run: TestRun): string {
  const details = [
    ["test-id", `<code data-testid="test-run-id">${escapeHtml(run["test-id"])}</code>`],
    ...(run.section ? [["Section", escapeHtml(run.section)]] : []),
    ["Go test", `<code>${escapeHtml(run.name)}</code>`],
    ...(run.source ? [["Source", `<code data-testid="test-run-source">${escapeHtml(run.source)}</code>`]] : []),
    ["Status", statusLabel(run.status)],
    ["Elapsed", `<span data-testid="test-run-elapsed">${elapsedSeconds(run).toFixed(2)}s</span>`],
    ["Started", `<time>${escapeHtml(run.timestamp)}</time>`],
    ...(run.completed_at ? [["Finished", `<time>${escapeHtml(run.completed_at)}</time>`]] : []),
    ...(run.artifact ? [["Log file", `<code>${escapeHtml(run.artifact)}</code>`]] : []),
  ];
  return details.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
}

function renderFormattedLog(rawLog: string): string {
  if (!rawLog) return "Waiting for output…";
  return rawLog
    .split("\n")
    .map((line) => {
      if (!line) return "";
      const parsed = parseStructuredLogLine(line);
      const cls = `log-line log-line-${parsed.level.toLowerCase()}`;
      if (!parsed.structured) {
        return `<span class="${cls}">${escapeHtml(line)}</span>`;
      }
      return `<span class="${cls}"><span class="log-ts">${escapeHtml(parsed.timestamp)}</span> <span class="log-lvl">[${escapeHtml(parsed.level)}]</span> <span class="log-src">${escapeHtml(parsed.source)}</span> <span class="log-sep">|</span> ${escapeHtml(parsed.message)}</span>`;
    })
    .join("\n");
}

async function refreshLogPage(testId: string): Promise<void> {
  applyTheme();
  const response = await fetch(`/api/test-runs/${encodeURIComponent(testId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "This test run could not be found." : `Could not load log: HTTP ${response.status}`);
  const { run } = (await response.json()) as { run: TestRun };
  const serialized = JSON.stringify(run);
  if (renderedRun === serialized) {
    const elapsed = app.querySelector('[data-testid="test-run-elapsed"]');
    if (elapsed && run.status === "running") elapsed.textContent = `${elapsedSeconds(run).toFixed(2)}s`;
    return;
  }
  renderedRun = serialized;
  app.innerHTML = `
    <div class="log-page-wrap">
      <main class="log-page">
        <header>
          <p><a class="c-cf" href="${import.meta.env.BASE_URL}">← All tests</a></p>
          <p class="c-dim">DIALTONE.EARTH / TEST RUN</p>
          <h1>${escapeHtml(run.title)}</h1>
          <dl class="run-details">${runDetails(run)}</dl>
          <h2>Rerun this test</h2>
          <pre class="command" data-testid="test-run-command"><code>${escapeHtml(run.command)}</code></pre>
          <p><a class="c-cf" href="/api/test-runs/${encodeURIComponent(testId)}/log" target="_blank" rel="noreferrer">Raw log ↗</a></p>
        </header>
        <h2>Output (timestamp · level · file:line)</h2>
        <pre class="log-output" data-testid="test-log-output" aria-label="Test run output">${renderFormattedLog(run.log)}</pre>
      </main>
    </div>`;
}

async function refreshStagingEnv(): Promise<void> {
  try {
    const response = await fetch("/api/staging/env", { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!response.ok) return;
    const next = (await response.json()) as StagingEnvStatus;
    if (JSON.stringify(next) !== JSON.stringify(stagingEnv)) {
      stagingEnv = next;
      renderWorkspace();
    }
  } catch {
    // ignore transient poll errors
  }
}

if (location.pathname.replace(/\/$/, "").endsWith("/logs")) {
  const testId = new URLSearchParams(location.search).get("test-id") || "";
  if (!testLogHref(testId)) {
    app.innerHTML = `<div class="log-page-wrap"><main class="log-page"><a class="c-cf" href="${import.meta.env.BASE_URL}">← All tests</a><p role="alert">A valid test-id is required.</p></main></div>`;
  } else {
    app.innerHTML = `<div class="log-page-wrap"><main class="log-page"><p>Loading test run…</p></main></div>`;
    let logPageInFlight = false;
    const refresh = () => {
      if (logPageInFlight) return;
      logPageInFlight = true;
      refreshLogPage(testId)
        .catch((error: unknown) => {
          renderedRun = "";
          app.innerHTML = `<div class="log-page-wrap"><main class="log-page"><a class="c-cf" href="${import.meta.env.BASE_URL}">← All tests</a><p role="alert">${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main></div>`;
        })
        .finally(() => {
          logPageInFlight = false;
        });
    };
    refresh();
    setInterval(refresh, 750);
  }
} else {
  renderWorkspace();

  // Sequential, in-flight-guarded pollers so HTTP/1.1 connection slots (shared with
  // the 2 live MJPEG streams) can never pile up into net::ERR_INSUFFICIENT_RESOURCES.
  let fastPollInFlight = false;
  let slowPollInFlight = false;
  const pollFast = async () => {
    if (fastPollInFlight) return;
    fastPollInFlight = true;
    try {
      await refreshTests().catch(showError);
      await refreshPipeline();
      if (selectedTestId) await fetchSelectedLog(selectedTestId);
    } finally {
      fastPollInFlight = false;
    }
  };
  const pollSlow = async () => {
    if (slowPollInFlight) return;
    slowPollInFlight = true;
    try {
      await refreshCdpStatus();
      await refreshStagingEnv();
    } finally {
      slowPollInFlight = false;
    }
  };

  void pollFast();
  void pollSlow();
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    void pollFast();
  }, 750);
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    void pollSlow();
  }, 2500);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void pollFast();
      void pollSlow();
    }
  });
  setInterval(() => {
    const runningTest = tests.find((test) => normalizeStatus(test.status) === "running");
    if (runningTest) {
      const row = app.querySelector<HTMLElement>(`tr[data-test-name="${CSS.escape(runningTest.name)}"]`);
      const time = row?.querySelector("time");
      if (time) time.textContent = `${elapsedSeconds(runningTest).toFixed(2)}s`;
    }
  }, 150);
}
