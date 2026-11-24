import "./style.css";
import {
  elapsedSeconds,
  groupTestsBySection,
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

type CdpStatus = {
  connected: boolean;
  port: number;
  pid?: number | null;
  app_url?: string;
  page_count?: number;
};

type PipelineStatus = {
  stage: string;
  message: string;
  changed?: string;
  deploy_url?: string;
  version_id?: string;
  passed?: number;
  failed?: number;
  total?: number;
  updated_at?: string;
};

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) {
  throw new Error("missing #app");
}
const app: HTMLElement = appElement;

let tests: TestRow[] = [];
let loaded = false;
let errorMessage = "";
let starting = false;
let useBrowser = true;
let keepSignedIn = true;
let deployOnPass = true;
let cdpStatus: CdpStatus = { connected: false, port: 9222 };
let pipelineStatus: PipelineStatus = { stage: "idle", message: "Ready" };
let lastRunningTestName = "";
let streamNonce = 1;
let mountedStreamConnected: boolean | null = null;
let shellMounted = false;

function ensureDashboardShell(): { testsRoot: HTMLElement; viewportRoot: HTMLElement } {
  if (!shellMounted) {
    shellMounted = true;
    app.innerHTML = `
      <main class="synced-workspace">
        <section id="cdp-viewport-host" class="viewport-pane" aria-label="Live Chrome CDP browser viewport"></section>
        <section id="dashboard-tests" class="tests-pane"></section>
      </main>
    `;
  }
  const testsRoot = app.querySelector<HTMLElement>("#dashboard-tests");
  const viewportRoot = app.querySelector<HTMLElement>("#cdp-viewport-host");
  if (!testsRoot || !viewportRoot) {
    throw new Error("missing dashboard workspace roots");
  }
  return { testsRoot, viewportRoot };
}

function syncViewportPane(): void {
  const { viewportRoot } = ensureDashboardShell();
  const runningTest = tests.find((test) => normalizeStatus(test.status) === "running");
  const isBrowserDemoActive = Boolean(runningTest && runningTest.name.startsWith("TestBrowser"));

  // Only recreate the <img> stream element when CDP connection state changes
  // so live MJPEG playback never flickers as individual test cards update.
  if (mountedStreamConnected !== cdpStatus.connected) {
    mountedStreamConnected = cdpStatus.connected;
    if (cdpStatus.connected) {
      streamNonce += 1;
      viewportRoot.innerHTML = `
        <div class="viewport-card" data-testid="viewport-card">
          <div class="viewport-head">
            <div class="viewport-title-row">
              <span class="cdp-pill connected" data-testid="viewport-live-pill">
                <span class="cdp-dot"></span>
                PROJECTED CHROME · CDP :${cdpStatus.port}
              </span>
              <code class="viewport-url" data-testid="viewport-url">${escapeHtml(cdpStatus.app_url || "https://metal.dialtone.earth/")}</code>
            </div>
            <div class="viewport-actions">
              <span class="viewport-active-test" data-testid="viewport-active-test"></span>
              <button data-testid="viewport-reconnect" class="ghost-btn" type="button" title="Reconnect live video stream">Refresh view</button>
              <button data-testid="viewport-close-browser" class="ghost-btn" type="button">Close</button>
            </div>
          </div>
          <div class="viewport-stage">
            <img
              data-testid="cdp-live-stream"
              class="viewport-stream"
              src="/api/cdp/stream?v=${streamNonce}"
              alt="Live Chrome browser running Dialtone Earth tests"
            />
          </div>
          <div class="viewport-foot" data-testid="viewport-foot">
            <span class="viewport-foot-dot"></span>
            <span data-testid="viewport-foot-label">Connected to persistent Chrome — UI spotlight follows each running test</span>
          </div>
        </div>
      `;
      viewportRoot.querySelector<HTMLButtonElement>("[data-testid='viewport-reconnect']")?.addEventListener("click", () => {
        mountedStreamConnected = null;
        syncViewportPane();
      });
      viewportRoot.querySelector<HTMLButtonElement>("[data-testid='viewport-close-browser']")?.addEventListener("click", () => {
        closeBrowser().catch(showError);
      });
    } else {
      viewportRoot.innerHTML = `
        <div class="viewport-card viewport-offline" data-testid="viewport-card">
          <div class="viewport-head">
            <span class="cdp-pill offline" data-testid="viewport-live-pill">
              <span class="cdp-dot"></span>
              CHROME CDP :${cdpStatus.port} OFFLINE
            </span>
            <button data-testid="launch-browser" class="secondary-btn" type="button">Launch live browser</button>
          </div>
          <div class="viewport-placeholder">
            <p>Start the persistent Chrome browser or click <strong>Run browser suite</strong> to watch live tests execute here in real time.</p>
          </div>
        </div>
      `;
      viewportRoot.querySelector<HTMLButtonElement>("[data-testid='launch-browser']")?.addEventListener("click", () => {
        launchBrowser().catch(showError);
      });
    }
  }

  const card = viewportRoot.querySelector<HTMLElement>("[data-testid='viewport-card']");
  if (card) {
    card.classList.toggle("demonstrating", isBrowserDemoActive);
    card.classList.toggle("deploying", pipelineStatus.stage === "deploying");
    card.classList.toggle("deployed", pipelineStatus.stage === "deployed");
  }

  const urlEl = viewportRoot.querySelector<HTMLElement>("[data-testid='viewport-url']");
  if (urlEl && cdpStatus.app_url) {
    urlEl.textContent = cdpStatus.app_url;
  }
  const activeBadge = viewportRoot.querySelector<HTMLElement>("[data-testid='viewport-active-test']");
  const footLabel = viewportRoot.querySelector<HTMLElement>("[data-testid='viewport-foot-label']");
  if (activeBadge) {
    if (runningTest) {
      const prefix = isBrowserDemoActive ? "DEMONSTRATING" : "RUNNING";
      activeBadge.textContent = `${prefix}: ${runningTest.title} (${elapsedSeconds(runningTest).toFixed(1)}s)`;
      activeBadge.classList.add("active");
    } else if (pipelineStatus.stage === "deploying") {
      activeBadge.textContent = "DEPLOYING → dialtone.earth…";
      activeBadge.classList.add("active");
    } else if (pipelineStatus.stage === "deployed") {
      activeBadge.textContent = "LIVE ON dialtone.earth ✓";
      activeBadge.classList.remove("active");
    } else {
      activeBadge.textContent = "READY · Reconnectable";
      activeBadge.classList.remove("active");
    }
  }
  if (footLabel) {
    if (isBrowserDemoActive && runningTest) {
      footLabel.textContent = `Live spotlight active on ${runningTest.title} (${runningTest.name})`;
    } else if (pipelineStatus.stage === "deploying") {
      footLabel.textContent = "All tests passed — publishing verified build live to https://dialtone.earth/...";
    } else if (pipelineStatus.stage === "deployed") {
      footLabel.textContent = `Verified & deployed live to https://dialtone.earth/${pipelineStatus.version_id ? ` (version ${pipelineStatus.version_id.slice(0, 8)})` : ""}`;
    } else {
      footLabel.textContent = "Persistent Chrome projected live — spotlight tracks every UI action during tests";
    }
  }
}

function renderPipelineBar(): string {
  const stage = pipelineStatus.stage || "idle";
  const stepState = (step: "edit" | "testing" | "deploying" | "deployed"): string => {
    const order = { idle: 0, edit: 1, testing: 2, passed: 2, failed: 2, deploying: 3, deployed: 4 } as Record<string, number>;
    const rank = order[stage] ?? 0;
    const target = { edit: 1, testing: 2, deploying: 3, deployed: 4 }[step];
    if (stage === "failed" && step === "testing") return "failed";
    if (stage === step) return "active";
    if (rank > target || (stage === "deployed" && step === "deployed")) return "done";
    return "";
  };
  return `
    <section class="pipeline-bar stage-${escapeHtml(stage)}" data-testid="pipeline-bar" aria-label="Live edit-test-deploy pipeline">
      <div class="pipeline-steps">
        <span class="pipe-step ${stepState("edit")}">1. Edit</span>
        <span class="pipe-arrow">→</span>
        <span class="pipe-step ${stepState("testing")}">2. Synced Tests</span>
        <span class="pipe-arrow">→</span>
        <span class="pipe-step ${stepState("deploying")}">3. Deploy</span>
        <span class="pipe-arrow">→</span>
        <span class="pipe-step ${stepState("deployed")}">4. Live dialtone.earth</span>
      </div>
      <div class="pipeline-meta">
        ${pipelineStatus.changed ? `<code class="pipe-file">${escapeHtml(pipelineStatus.changed)}</code>` : ""}
        <span class="pipe-msg">${escapeHtml(pipelineStatus.message || "Ready")}</span>
        ${
          pipelineStatus.stage === "deployed"
            ? `<a class="pipe-live-link" href="${escapeHtml(pipelineStatus.deploy_url || "https://dialtone.earth/")}" target="_blank" rel="noreferrer">Open dialtone.earth ↗</a>`
            : ""
        }
      </div>
    </section>
  `;
}

function render(): void {
  const { testsRoot } = ensureDashboardShell();
  syncViewportPane();

  const passed = tests.filter((test) => normalizeStatus(test.status) === "pass").length;
  const failed = tests.filter((test) => normalizeStatus(test.status) === "fail").length;
  const runningTest = tests.find((test) => normalizeStatus(test.status) === "running");
  const running = Boolean(runningTest) || pipelineStatus.stage === "deploying";
  const sections = groupTestsBySection(tests);

  testsRoot.innerHTML = `
    <header>
      <p class="eyebrow">Dialtone Earth · Live Edit → Test → Deploy</p>
      <section class="heading-row">
        <div>
          <h1>Tests</h1>
        </div>
        <div class="header-actions">
          <button data-testid="run-browser-suite" class="secondary-btn" type="button" ${starting || running ? "disabled" : ""}>
            Run browser suite
          </button>
          <button data-testid="start-tests" type="button" ${starting || running ? "disabled" : ""}>
            ${starting ? "Starting…" : pipelineStatus.stage === "deploying" ? "Deploying…" : running ? "Running…" : "Start tests"}
          </button>
        </div>
      </section>
      ${renderPipelineBar()}
      <section class="cdp-bar" aria-label="Persistent browser controls">
        <span class="cdp-pill ${cdpStatus.connected ? "connected" : "offline"}" data-testid="cdp-status">
          <span class="cdp-dot"></span>
          CDP :${cdpStatus.port} ${cdpStatus.connected ? "connected" : "offline"}
        </span>
        <label class="cdp-toggle">
          <input type="checkbox" data-testid="toggle-browser" ${useBrowser ? "checked" : ""} />
          <span>Live Browser</span>
        </label>
        <label class="cdp-toggle">
          <input type="checkbox" data-testid="toggle-keep-signed-in" ${keepSignedIn ? "checked" : ""} />
          <span>Keep signed in</span>
        </label>
        <label class="cdp-toggle">
          <input type="checkbox" data-testid="toggle-deploy-on-pass" ${deployOnPass ? "checked" : ""} />
          <span>Auto-deploy on pass</span>
        </label>
        ${
          cdpStatus.connected
            ? `<button data-testid="close-browser" class="ghost-btn" type="button">Close browser</button>`
            : `<button data-testid="open-browser-bar" class="ghost-btn" type="button">Launch browser</button>`
        }
      </section>
      <section class="summary" aria-label="Test summary">
        <span><strong>${tests.length}</strong> total</span>
        <span><strong>${sections.length}</strong> sections</span>
        <span class="passed"><strong>${passed}</strong> passed</span>
        <span class="${failed > 0 ? "failed" : ""}"><strong>${failed}</strong> failed</span>
      </section>
      ${errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
    </header>
    <section class="test-sections" aria-label="Test sections">
      ${
        tests.length > 0
          ? sections.map((section) => renderSection(section, starting || running)).join("")
          : `<section class="test-list"><p class="empty">${loaded ? "No tests listed yet. Press Start tests." : "Loading tests…"}</p></section>`
      }
    </section>
  `;

  const startButton = testsRoot.querySelector<HTMLButtonElement>("[data-testid='start-tests']");
  startButton?.addEventListener("click", () => {
    startAllTests().catch(showError);
  });

  const browserSuiteBtn = testsRoot.querySelector<HTMLButtonElement>("[data-testid='run-browser-suite']");
  browserSuiteBtn?.addEventListener("click", () => {
    startFilteredTests("^TestBrowser", true, deployOnPass).catch(showError);
  });

  const browserToggle = testsRoot.querySelector<HTMLInputElement>("[data-testid='toggle-browser']");
  browserToggle?.addEventListener("change", () => {
    useBrowser = Boolean(browserToggle.checked);
  });

  const keepSignedInToggle = testsRoot.querySelector<HTMLInputElement>("[data-testid='toggle-keep-signed-in']");
  keepSignedInToggle?.addEventListener("change", () => {
    keepSignedIn = Boolean(keepSignedInToggle.checked);
  });

  const deployToggle = testsRoot.querySelector<HTMLInputElement>("[data-testid='toggle-deploy-on-pass']");
  deployToggle?.addEventListener("change", () => {
    deployOnPass = Boolean(deployToggle.checked);
  });

  const closeBrowserBtn = testsRoot.querySelector<HTMLButtonElement>("[data-testid='close-browser']");
  closeBrowserBtn?.addEventListener("click", () => {
    closeBrowser().catch(showError);
  });

  const openBrowserBarBtn = testsRoot.querySelector<HTMLButtonElement>("[data-testid='open-browser-bar']");
  openBrowserBarBtn?.addEventListener("click", () => {
    launchBrowser().catch(showError);
  });

  testsRoot.querySelectorAll<HTMLButtonElement>("[data-run-single]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.runSingle || "";
      if (!name) return;
      const forceBrowser = name.startsWith("TestBrowser") || useBrowser;
      startFilteredTests(`^${name}$`, forceBrowser, false).catch(showError);
    });
  });

  if (runningTest && runningTest.name !== lastRunningTestName) {
    lastRunningTestName = runningTest.name;
    const row = testsRoot.querySelector<HTMLElement>(`[data-test-name="${CSS.escape(runningTest.name)}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (!runningTest) {
    lastRunningTestName = "";
  }
}

function renderSection(section: { title: string; description: string; tests: TestRow[] }, busy: boolean): string {
  const secPassed = section.tests.filter((t) => normalizeStatus(t.status) === "pass").length;
  const secFailed = section.tests.filter((t) => normalizeStatus(t.status) === "fail").length;
  const secRunning = section.tests.some((t) => normalizeStatus(t.status) === "running");
  const badgeClass = secFailed > 0 ? "failed" : secRunning ? "running" : secPassed === section.tests.length ? "passed" : "";
  const badgeText =
    secFailed > 0
      ? `${secFailed} failed · ${secPassed}/${section.tests.length} passed`
      : secRunning
        ? `running · ${secPassed}/${section.tests.length}`
        : `${secPassed}/${section.tests.length} passed`;

  return `
    <section class="test-section" data-testid="test-section" data-section="${escapeHtml(section.title)}">
      <div class="section-head">
        <div>
          <h2 class="section-title">${escapeHtml(section.title)}</h2>
          ${section.description ? `<p class="section-desc">${escapeHtml(section.description)}</p>` : ""}
        </div>
        <span class="section-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>
      <div class="test-list">
        ${section.tests.map((test) => renderTest(test, busy)).join("")}
      </div>
    </section>
  `;
}

function renderTest(test: TestRow, busy: boolean): string {
  const status = normalizeStatus(test.status);
  const elapsed = elapsedSeconds(test).toFixed(2);
  const logHref = testLogHref(test["test-id"], import.meta.env.BASE_URL);
  const isRunning = status === "running";
  return `
    <article class="test-card ${status}" data-status="${status}" data-testid="test-row" data-test-name="${escapeHtml(test.name)}">
      <section class="test-copy">
        <h3>${isRunning ? '<span class="running-pulse" aria-hidden="true"></span>' : ""}${escapeHtml(test.title)}</h3>
        <div class="test-meta">
          <code>${escapeHtml(test.name)}</code>
          ${test.source ? `<span class="test-src">${escapeHtml(test.source)}</span>` : ""}
        </div>
      </section>
      <section class="result" aria-label="${escapeHtml(test.title)} result">
        <strong>${statusLabel(test.status)}</strong>
        <time>${elapsed}s</time>
        <button class="run-one-btn" type="button" data-run-single="${escapeHtml(test.name)}" data-testid="run-test-${escapeHtml(test.name)}" ${busy ? "disabled" : ""} title="Run only ${escapeHtml(test.name)}">
          Run
        </button>
        ${logHref ? `<a data-testid="test-log-link" href="${escapeHtml(logHref)}" target="_blank" rel="noreferrer" aria-label="Log for ${escapeHtml(test.title)}">Log ↗</a>` : '<span class="no-log" title="Log available when this test starts">—</span>'}
      </section>
    </article>
  `;
}

async function refreshTests(): Promise<void> {
  const response = await fetch("/api/tests", { cache: "no-store" });
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
  if (changed) render();
}

async function refreshPipeline(): Promise<void> {
  try {
    const response = await fetch("/api/pipeline", { cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as PipelineStatus;
    if (JSON.stringify(next) !== JSON.stringify(pipelineStatus)) {
      pipelineStatus = next;
      render();
    }
  } catch {
    // ignore transient poll error
  }
}

async function refreshCdpStatus(): Promise<void> {
  try {
    const response = await fetch("/api/cdp/status", { cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as CdpStatus;
    if (
      next.connected !== cdpStatus.connected ||
      next.port !== cdpStatus.port ||
      next.app_url !== cdpStatus.app_url
    ) {
      cdpStatus = next;
      render();
    }
  } catch {
    // ignore transient poll errors
  }
}

async function startAllTests(): Promise<void> {
  await startFilteredTests("", useBrowser, deployOnPass);
}

async function startFilteredTests(filter: string, withBrowser: boolean, withDeploy: boolean): Promise<void> {
  starting = true;
  errorMessage = "";
  render();
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
  render();
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
    <main class="log-page">
      <header>
        <p><a href="${import.meta.env.BASE_URL}">← All tests</a></p>
        <p class="eyebrow">Dialtone Earth / test run</p>
        <h1>${escapeHtml(run.title)}</h1>
        <dl class="run-details">${runDetails(run)}</dl>
        <h2>Rerun this test</h2>
        <pre class="command" data-testid="test-run-command"><code>${escapeHtml(run.command)}</code></pre>
        <a href="/api/test-runs/${encodeURIComponent(testId)}/log" target="_blank" rel="noreferrer">Raw log</a>
      </header>
      <h2>Output (timestamp · level · file:line)</h2>
      <pre class="log-output" data-testid="test-log-output" aria-label="Test run output">${renderFormattedLog(run.log)}</pre>
    </main>`;
}

if (location.pathname.replace(/\/$/, "").endsWith("/logs")) {
  const testId = new URLSearchParams(location.search).get("test-id") || "";
  if (!testLogHref(testId)) {
    app.innerHTML = `<main><a href="${import.meta.env.BASE_URL}">← All tests</a><p role="alert">A valid test-id is required.</p></main>`;
  } else {
    app.innerHTML = "<main><p>Loading test run…</p></main>";
    const refresh = () =>
      refreshLogPage(testId).catch((error: unknown) => {
        renderedRun = "";
        app.innerHTML = `<main><a href="${import.meta.env.BASE_URL}">← All tests</a><p role="alert">${escapeHtml(error instanceof Error ? error.message : String(error))}</p></main>`;
      });
    void refresh();
    setInterval(refresh, 500);
  }
} else {
  render();
  refreshTests().catch(showError);
  void refreshPipeline();
  void refreshCdpStatus();
  setInterval(() => {
    refreshTests().catch(showError);
    void refreshPipeline();
  }, 500);
  setInterval(() => {
    void refreshCdpStatus();
  }, 1500);
  setInterval(() => {
    const runningTest = tests.find((test) => normalizeStatus(test.status) === "running");
    if (runningTest) {
      const row = app.querySelector<HTMLElement>(`[data-test-name="${CSS.escape(runningTest.name)}"]`);
      const time = row?.querySelector("time");
      if (time) time.textContent = `${elapsedSeconds(runningTest).toFixed(2)}s`;
      const activeBadge = app.querySelector<HTMLElement>("[data-testid='viewport-active-test']");
      if (activeBadge) {
        const prefix = runningTest.name.startsWith("TestBrowser") ? "DEMONSTRATING" : "RUNNING";
        activeBadge.textContent = `${prefix}: ${runningTest.title} (${elapsedSeconds(runningTest).toFixed(1)}s)`;
        activeBadge.classList.add("active");
      }
    }
  }, 100);
}
