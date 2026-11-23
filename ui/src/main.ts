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

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) {
  throw new Error("missing #app");
}
const app: HTMLElement = appElement;

let tests: TestRow[] = [];
let loaded = false;
let errorMessage = "";
let starting = false;

function render(): void {
  const passed = tests.filter((test) => normalizeStatus(test.status) === "pass").length;
  const failed = tests.filter((test) => normalizeStatus(test.status) === "fail").length;
  const running = tests.some((test) => normalizeStatus(test.status) === "running");
  const sections = groupTestsBySection(tests);

  app.innerHTML = `
    <main>
      <header>
        <p class="eyebrow">Dialtone Earth</p>
        <section class="heading-row">
          <div>
            <h1>Tests</h1>
          </div>
          <button data-testid="start-tests" type="button" ${starting || running ? "disabled" : ""}>
            ${starting ? "Starting…" : running ? "Running…" : "Start tests"}
          </button>
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
            ? sections.map(renderSection).join("")
            : `<section class="test-list"><p class="empty">${loaded ? "No tests listed yet. Press Start tests." : "Loading tests…"}</p></section>`
        }
      </section>
    </main>
  `;

  const startButton = app.querySelector<HTMLButtonElement>("[data-testid='start-tests']");
  startButton?.addEventListener("click", () => {
    startAllTests().catch(showError);
  });
}

function renderSection(section: { title: string; description: string; tests: TestRow[] }): string {
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
        ${section.tests.map(renderTest).join("")}
      </div>
    </section>
  `;
}

function renderTest(test: TestRow): string {
  const status = normalizeStatus(test.status);
  const elapsed = elapsedSeconds(test).toFixed(2);
  const logHref = testLogHref(test["test-id"], import.meta.env.BASE_URL);
  return `
    <article class="test-card ${status}" data-status="${status}" data-testid="test-row" data-test-name="${escapeHtml(test.name)}">
      <section class="test-copy">
        <h3>${escapeHtml(test.title)}</h3>
        <div class="test-meta">
          <code>${escapeHtml(test.name)}</code>
          ${test.source ? `<span class="test-src">${escapeHtml(test.source)}</span>` : ""}
        </div>
      </section>
      <section class="result" aria-label="${escapeHtml(test.title)} result">
        <strong>${statusLabel(test.status)}</strong>
        <time>${elapsed}s</time>
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

async function startAllTests(): Promise<void> {
  starting = true;
  errorMessage = "";
  render();
  const response = await fetch("/api/tests/run", { method: "POST" });
  const payload = (await response.json()) as { error?: string };
  starting = false;
  if (!response.ok) {
    throw new Error(payload.error || `Could not start tests: HTTP ${response.status}`);
  }
  await refreshTests();
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
  setInterval(() => {
    refreshTests().catch(showError);
  }, 500);
  setInterval(() => {
    tests.forEach((test) => {
      if (normalizeStatus(test.status) !== "running") return;
      const row = app.querySelector<HTMLElement>(`[data-test-name="${CSS.escape(test.name)}"]`);
      const time = row?.querySelector("time");
      if (time) time.textContent = `${elapsedSeconds(test).toFixed(2)}s`;
    });
  }, 100);
}
