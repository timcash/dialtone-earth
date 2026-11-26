import type { KvNamespaceBinding } from "./auth.ts";
import type { R2BucketBinding } from "./registry.ts";
import { redactText } from "./redact.ts";

export interface DiagnosticsEnv {
  DIALTONE_AUTH_TOKENS?: KvNamespaceBinding;
  DIALTONE_REGISTRY?: R2BucketBinding;
}

export interface DiagCheckResult {
  check_id: string;
  test_id: string;
  category: string;
  title: string;
  depends_on: string[];
  after?: string[];
  status: "pass" | "fail" | "skipped";
  skip_reason?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms: number;
  summary?: string;
  error?: string;
  details?: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
  redacted_count?: number;
  task_id?: string;
  task_action?: string;
}

export interface DiagSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface DiagLoopReport {
  schema_version: number;
  loop_id: string;
  source: string;
  runner_node: string;
  interval?: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: "pass" | "fail";
  summary: DiagSummary;
  screenshots_url?: string;
  screenshots_loop_id?: string;
  git_branch?: string;
  git_commit?: string;
  checks: DiagCheckResult[];
}

export interface DiagHistoryEntry {
  loop_id: string;
  source: string;
  runner_node: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: "pass" | "fail";
  summary: DiagSummary;
  screenshots_url?: string;
  screenshots_loop_id?: string;
  failed_check_ids?: string[];
}

export interface DiagLogUpload {
  record: Record<string, unknown>;
  log: string;
}

const KV_LATEST_KEY = "diag:latest";
const KV_HISTORY_KEY = "diag:history";
const R2_RUNS_PREFIX = "diag/runs/";
const R2_LOGS_PREFIX = "diag/logs/";
const MAX_HISTORY = 50;
const SAFE_LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/;
const SAFE_TEST_ID_RE = /^[a-f0-9]{32}$/;

const DIAG_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function diagHeaders(
  securityHeaders: Record<string, string>,
  contentType: string,
): Headers {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Security-Policy", DIAG_CSP);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

function jsonResp(
  payload: unknown,
  status: number,
  securityHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: diagHeaders(securityHeaders, "application/json; charset=utf-8"),
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return ch;
    }
  });
}

function toHistoryEntry(report: DiagLoopReport): DiagHistoryEntry {
  const failedIds = (report.checks || [])
    .filter((c) => c.status === "fail")
    .map((c) => c.check_id);
  return {
    loop_id: report.loop_id,
    source: report.source || "cli",
    runner_node: report.runner_node || "unknown",
    started_at: report.started_at,
    ended_at: report.ended_at,
    duration_ms: Number(report.duration_ms) || 0,
    status: report.status === "pass" ? "pass" : "fail",
    summary: report.summary || { total: 0, passed: 0, failed: 0, skipped: 0 },
    screenshots_url: report.screenshots_url || "/screenshots/",
    screenshots_loop_id: report.screenshots_loop_id,
    failed_check_ids: failedIds.length > 0 ? failedIds : undefined,
  };
}

async function readLatest(kv: KvNamespaceBinding | undefined): Promise<DiagLoopReport | null> {
  if (!kv) return null;
  const raw = await kv.get(KV_LATEST_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DiagLoopReport;
  } catch {
    return null;
  }
}

async function readHistory(kv: KvNamespaceBinding | undefined): Promise<DiagHistoryEntry[]> {
  if (!kv) return [];
  const raw = await kv.get(KV_HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DiagHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

async function readRunById(
  r2: R2BucketBinding | undefined,
  kv: KvNamespaceBinding | undefined,
  loopId: string,
): Promise<DiagLoopReport | null> {
  if (r2) {
    const obj = await r2.get(R2_RUNS_PREFIX + loopId + ".json");
    if (obj) {
      try {
        const text =
          typeof obj.text === "function"
            ? await obj.text()
            : new TextDecoder().decode(await obj.arrayBuffer());
        return JSON.parse(text) as DiagLoopReport;
      } catch {
        // fallback below
      }
    }
  }
  const latest = await readLatest(kv);
  if (latest && latest.loop_id === loopId) {
    return latest;
  }
  return null;
}

async function persistReportToEdge(
  env: DiagnosticsEnv,
  report: DiagLoopReport,
  logs?: Record<string, DiagLogUpload>,
): Promise<void> {
  const kv = env.DIALTONE_AUTH_TOKENS;
  const r2 = env.DIALTONE_REGISTRY;
  const reportText = JSON.stringify(report, null, 2);

  if (r2) {
    await r2.put(R2_RUNS_PREFIX + report.loop_id + ".json", reportText, {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "private, no-store",
      },
      customMetadata: {
        loop_id: report.loop_id,
        status: report.status,
      },
    });
    if (logs && typeof logs === "object") {
      for (const [testId, entry] of Object.entries(logs)) {
        if (!SAFE_TEST_ID_RE.test(testId) || !entry) continue;
        const safeLog = redactText(String(entry.log || ""));
        const safeRecord = {
          ...(entry.record || {}),
          "test-id": testId,
        };
        await r2.put(R2_LOGS_PREFIX + testId + ".json", JSON.stringify(safeRecord, null, 2), {
          httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "private, no-store" },
        });
        await r2.put(R2_LOGS_PREFIX + testId + ".log", safeLog, {
          httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "private, no-store" },
        });
      }
    }
  }

  if (kv) {
    await kv.put(KV_LATEST_KEY, reportText);
    const existing = await readHistory(kv);
    const nextEntry = toHistoryEntry(report);
    const merged = [nextEntry, ...existing.filter((h) => h.loop_id !== nextEntry.loop_id)].slice(0, MAX_HISTORY);
    await kv.put(KV_HISTORY_KEY, JSON.stringify(merged));
  }
}

function computeDagDepths(checks: DiagCheckResult[]): Map<string, number> {
  const byId = new Map<string, DiagCheckResult>();
  for (const c of checks) byId.set(c.check_id, c);
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0;
    const item = byId.get(id);
    if (!item) return 0;
    stack.add(id);
    let maxParent = -1;
    for (const dep of [...(item.depends_on || []), ...(item.after || [])]) {
      if (byId.has(dep)) {
        maxParent = Math.max(maxParent, visit(dep, stack));
      }
    }
    stack.delete(id);
    const depth = maxParent + 1;
    memo.set(id, depth);
    return depth;
  };
  for (const c of checks) visit(c.check_id, new Set());
  return memo;
}

function renderDiagnosticsHtml(
  report: DiagLoopReport | null,
  history: DiagHistoryEntry[],
  selectedLoopId: string,
): string {
  const title = selectedLoopId
    ? `Diagnostics Loop ${selectedLoopId} | test.dialtone.earth`
    : "Diagnostics | test.dialtone.earth";

  const statusBadge = (st: string) => {
    const cls = st === "pass" ? "st-pass" : st === "fail" ? "st-fail" : "st-skip";
    return `<span class="badge ${cls}">${escapeHtml(st.toUpperCase())}</span>`;
  };

  let bodyContent = `<section class="card"><p class="muted">No diagnostic loops have been published yet. Run <code>go run . diag run</code> to publish a loop.</p></section>`;

  if (report) {
    const depths = computeDagDepths(report.checks || []);
    const layers = new Map<number, DiagCheckResult[]>();
    for (const c of report.checks || []) {
      const d = depths.get(c.check_id) ?? 0;
      const list = layers.get(d) || [];
      list.push(c);
      layers.set(d, list);
    }
    const sortedDepths = Array.from(layers.keys()).sort((a, b) => a - b);

    const dagLayersHtml = sortedDepths
      .map((depth) => {
        const nodes = (layers.get(depth) || [])
          .map((c) => {
            const deps = (c.depends_on || []).length > 0 ? `deps: ${c.depends_on.join(", ")}` : "root";
            const cls = c.status === "pass" ? "node-pass" : c.status === "fail" ? "node-fail" : "node-skip";
            return `<a class="dag-node ${cls}" href="/logs/?test-id=${encodeURIComponent(c.test_id)}" title="${escapeHtml(c.summary || c.error || "")}">
              <div class="dag-id">${escapeHtml(c.check_id)}</div>
              <div class="dag-meta">${escapeHtml(c.status.toUpperCase())} | ${c.duration_ms}ms | ${escapeHtml(deps)}</div>
            </a>`;
          })
          .join("");
        return `<div class="dag-layer"><div class="dag-layer-title">Stage ${depth}</div><div class="dag-nodes">${nodes}</div></div>`;
      })
      .join("");

    const checkRowsHtml = (report.checks || [])
      .map((c) => {
        const depsText = (c.depends_on || []).join(", ") || "none";
        const detailText = c.error || c.skip_reason || c.summary || "";
        const taskCell = c.task_id
          ? `<code>${escapeHtml(c.task_id)}</code> (${escapeHtml(c.task_action || "")})`
          : `<span class="muted">none</span>`;
        const logLink = SAFE_TEST_ID_RE.test(c.test_id || "")
          ? `<a class="link" href="/logs/?test-id=${encodeURIComponent(c.test_id)}">log</a>`
          : `<span class="muted">n/a</span>`;
        return `<tr>
          <td>${statusBadge(c.status)}</td>
          <td><code>${escapeHtml(c.check_id)}</code></td>
          <td>${escapeHtml(c.category)}</td>
          <td class="muted">${escapeHtml(depsText)}</td>
          <td>${c.duration_ms}ms</td>
          <td>${escapeHtml(detailText)}</td>
          <td>${taskCell}</td>
          <td>${logLink}</td>
        </tr>`;
      })
      .join("");

    const shotHref = report.screenshots_url || "/screenshots/";
    bodyContent = `
      <section class="card summary-grid">
        <div><div class="label">LOOP ID</div><div class="val"><code>${escapeHtml(report.loop_id)}</code></div></div>
        <div><div class="label">STATUS</div><div class="val">${statusBadge(report.status)}</div></div>
        <div><div class="label">RUNNER</div><div class="val">${escapeHtml(report.runner_node)} (${escapeHtml(report.source)})</div></div>
        <div><div class="label">TOTALS</div><div class="val">${report.summary.passed} pass, ${report.summary.failed} fail, ${report.summary.skipped} skipped / ${report.summary.total}</div></div>
        <div><div class="label">DURATION</div><div class="val">${report.duration_ms}ms</div></div>
        <div><div class="label">SCREENSHOTS</div><div class="val"><a class="link" href="${escapeHtml(shotHref)}">Annotated gallery</a></div></div>
      </section>

      <section class="card">
        <h2>Dependency DAG</h2>
        <div class="dag-grid">${dagLayersHtml}</div>
      </section>

      <section class="card">
        <h2>Checks (${(report.checks || []).length})</h2>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr><th>STATUS</th><th>CHECK ID</th><th>CATEGORY</th><th>DEPENDS ON</th><th>TIME</th><th>RESULT</th><th>TASK</th><th>LOG</th></tr>
            </thead>
            <tbody>${checkRowsHtml}</tbody>
          </table>
        </div>
      </section>`;
  }

  const historyRowsHtml = history
    .map((h) => {
      const active = report && h.loop_id === report.loop_id ? ` class="active-row"` : "";
      return `<tr${active}>
        <td>${statusBadge(h.status)}</td>
        <td><a class="link" href="/diagnostics/runs/${encodeURIComponent(h.loop_id)}"><code>${escapeHtml(h.loop_id)}</code></a></td>
        <td>${escapeHtml(h.runner_node)} (${escapeHtml(h.source)})</td>
        <td>${escapeHtml(h.started_at)}</td>
        <td>${h.summary.passed} pass / ${h.summary.failed} fail / ${h.summary.skipped} skip</td>
        <td>${h.duration_ms}ms</td>
        <td><a class="link" href="${escapeHtml(h.screenshots_url || "/screenshots/")}">screenshots</a></td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { --bg:#0c0c0c; --panel:#131313; --fg:#fff; --muted:#9a9a9a; --line:#2c2c2c; --ok:#2fd065; --err:#ef4136; --warn:#f1c84b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    header { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); background:#080808; }
    nav { display:flex; flex-wrap:wrap; gap:12px; }
    main { max-width:1440px; margin:0 auto; padding:18px 20px 40px; display:flex; flex-direction:column; gap:16px; }
    h1, h2 { margin:0 0 10px; font-size:15px; letter-spacing:0.04em; }
    .card { background:var(--panel); border:1px solid var(--line); padding:14px 16px; }
    .summary-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:12px; }
    .label { color:var(--muted); font-size:11px; margin-bottom:4px; }
    .val { font-size:13px; }
    .muted { color:var(--muted); }
    .link { color:#fff; text-decoration:underline; }
    .badge { display:inline-block; padding:2px 6px; font-size:11px; font-weight:700; border:1px solid var(--line); }
    .st-pass { color:var(--ok); border-color:var(--ok); }
    .st-fail { color:var(--err); border-color:var(--err); }
    .st-skip { color:var(--warn); border-color:var(--warn); }
    .dag-grid { display:flex; flex-direction:column; gap:12px; }
    .dag-layer { border:1px solid var(--line); padding:10px; background:#0f0f0f; }
    .dag-layer-title { font-size:11px; color:var(--muted); margin-bottom:8px; text-transform:uppercase; }
    .dag-nodes { display:flex; flex-wrap:wrap; gap:8px; }
    .dag-node { display:block; padding:8px 10px; border:1px solid var(--line); color:var(--fg); text-decoration:none; background:#161616; min-width:210px; }
    .node-pass { border-left:3px solid var(--ok); }
    .node-fail { border-left:3px solid var(--err); }
    .node-skip { border-left:3px solid var(--warn); }
    .dag-id { font-weight:700; font-size:12px; }
    .dag-meta { color:var(--muted); font-size:11px; margin-top:2px; }
    .tbl-wrap { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); background:#0f0f0f; }
    .active-row { background:rgba(255,255,255,0.06); }
  </style>
</head>
<body>
  <header>
    <div><strong>TEST.DIALTONE.EARTH / DIAGNOSTICS</strong></div>
    <nav>
      <a class="link" href="/">Dashboard</a>
      <a class="link" href="/diagnostics">Latest Loop</a>
      <a class="link" href="/screenshots/">Screenshots</a>
      <a class="link" href="/logs">Logs</a>
      <a class="link" href="/code">Code</a>
      <a class="link" href="/auth/logout">Sign out</a>
    </nav>
  </header>
  <main>
    ${bodyContent}
    <section class="card">
      <h2>Recent Diagnostic Loops (last ${MAX_HISTORY})</h2>
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr><th>STATUS</th><th>LOOP ID</th><th>RUNNER</th><th>STARTED</th><th>SUMMARY</th><th>DURATION</th><th>SCREENSHOTS</th></tr>
          </thead>
          <tbody>${historyRowsHtml || '<tr><td colspan="7" class="muted">No loops recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>`;
}

/**
 * Handles owner-authenticated diagnostic loop routes on test.dialtone.earth:
 *   GET  /diagnostics                 -> latest loop DAG + history HTML
 *   GET  /diagnostics/runs/<loop-id>  -> specific loop HTML
 *   GET  /api/diagnostics/latest      -> latest DiagLoopReport JSON
 *   GET  /api/diagnostics/history     -> last 50 DiagHistoryEntry JSON
 *   GET  /api/diagnostics/runs/<id>   -> specific DiagLoopReport JSON
 *   POST /api/diagnostics/runs        -> publish loop report + logs to R2 + KV
 *   GET  /api/test-runs/<test-id>[/log] -> serve stored diagnostic check log from R2 if present
 */
export async function handleDiagnosticsRoute(
  request: Request,
  env: DiagnosticsEnv,
  securityHeaders: Record<string, string>,
  _nowSec: number,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const kv = env.DIALTONE_AUTH_TOKENS;
  const r2 = env.DIALTONE_REGISTRY;

  if (path === "/api/diagnostics/runs" && request.method === "POST") {
    if (!kv || !r2) {
      return jsonResp(
        { error: "DIALTONE_AUTH_TOKENS KV and DIALTONE_REGISTRY R2 bindings are required" },
        503,
        securityHeaders,
      );
    }
    let body: { report?: DiagLoopReport; logs?: Record<string, DiagLogUpload> };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResp({ error: "Invalid JSON diagnostics payload" }, 400, securityHeaders);
    }
    const report = body?.report;
    if (!report || typeof report.loop_id !== "string" || !SAFE_LOOP_ID_RE.test(report.loop_id)) {
      return jsonResp({ error: "Valid report.loop_id is required" }, 400, securityHeaders);
    }
    await persistReportToEdge(env, report, body.logs);
    return jsonResp(
      {
        ok: true,
        loop_id: report.loop_id,
        url: "/diagnostics",
        run_url: `/diagnostics/runs/${encodeURIComponent(report.loop_id)}`,
      },
      200,
      securityHeaders,
    );
  }

  if (path === "/api/diagnostics/latest" && request.method === "GET") {
    const latest = await readLatest(kv);
    if (!latest) {
      return jsonResp({ error: "No diagnostic loop published yet" }, 404, securityHeaders);
    }
    return jsonResp(latest, 200, securityHeaders);
  }

  if (path === "/api/diagnostics/history" && request.method === "GET") {
    const history = await readHistory(kv);
    return jsonResp({ history }, 200, securityHeaders);
  }

  if (path.startsWith("/api/diagnostics/runs/") && request.method === "GET") {
    const loopId = decodeURIComponent(path.slice("/api/diagnostics/runs/".length));
    if (!SAFE_LOOP_ID_RE.test(loopId)) {
      return jsonResp({ error: "Invalid diagnostic loop_id" }, 400, securityHeaders);
    }
    const report = await readRunById(r2, kv, loopId);
    if (!report) {
      return jsonResp({ error: "Diagnostic loop not found" }, 404, securityHeaders);
    }
    return jsonResp(report, 200, securityHeaders);
  }

  const testRunMatch = /^\/api\/test-runs\/([a-f0-9]{32})(\/log)?$/.exec(path);
  if (testRunMatch && request.method === "GET" && r2) {
    const testId = testRunMatch[1];
    const wantRaw = Boolean(testRunMatch[2]);
    const logObj = await r2.get(R2_LOGS_PREFIX + testId + ".log");
    if (!logObj) {
      return null;
    }
    const logText =
      typeof logObj.text === "function"
        ? await logObj.text()
        : new TextDecoder().decode(await logObj.arrayBuffer());
    if (wantRaw) {
      return new Response(logText, {
        status: 200,
        headers: diagHeaders(securityHeaders, "text/plain; charset=utf-8"),
      });
    }
    let record: Record<string, unknown> = { "test-id": testId, name: "diag", title: "Diagnostic check", status: "pass", elapsed: "0", timestamp: "" };
    const recObj = await r2.get(R2_LOGS_PREFIX + testId + ".json");
    if (recObj) {
      try {
        const recText =
          typeof recObj.text === "function"
            ? await recObj.text()
            : new TextDecoder().decode(await recObj.arrayBuffer());
        record = JSON.parse(recText) as Record<string, unknown>;
      } catch {
        // fallback record
      }
    }
    return jsonResp({ run: { ...record, log: logText } }, 200, securityHeaders);
  }

  if ((path === "/diagnostics" || path === "/diagnostics/") && (request.method === "GET" || request.method === "HEAD")) {
    const [latest, history] = await Promise.all([readLatest(kv), readHistory(kv)]);
    const html = renderDiagnosticsHtml(latest, history, "");
    return new Response(request.method === "HEAD" ? null : html, {
      status: 200,
      headers: diagHeaders(securityHeaders, "text/html; charset=utf-8"),
    });
  }

  if (path.startsWith("/diagnostics/runs/") && (request.method === "GET" || request.method === "HEAD")) {
    const loopId = decodeURIComponent(path.slice("/diagnostics/runs/".length));
    if (!SAFE_LOOP_ID_RE.test(loopId)) {
      return jsonResp({ error: "Invalid diagnostic loop_id" }, 400, securityHeaders);
    }
    const [report, history] = await Promise.all([readRunById(r2, kv, loopId), readHistory(kv)]);
    if (!report) {
      return jsonResp({ error: "Diagnostic loop not found" }, 404, securityHeaders);
    }
    const html = renderDiagnosticsHtml(report, history, loopId);
    return new Response(request.method === "HEAD" ? null : html, {
      status: 200,
      headers: diagHeaders(securityHeaders, "text/html; charset=utf-8"),
    });
  }

  return null;
}

function randomHex16(bytesLen: number): string {
  const buf = new Uint8Array(bytesLen);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ScheduledDiagOptions {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

/**
 * Optional Cloudflare Cron Trigger runner for HTTP-only read-only GET checks.
 * Persists a source="cron" diagnostic loop into R2 + KV under diag/.
 */
export async function runScheduledHttpDiagnostics(
  env: DiagnosticsEnv,
  opts: ScheduledDiagOptions = {},
): Promise<DiagLoopReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const startedMs = nowMs();
  const startedIso = new Date(startedMs).toISOString();

  const checks: DiagCheckResult[] = [];
  const logs: Record<string, DiagLogUpload> = {};

  const recordCheck = (c: DiagCheckResult) => {
    checks.push(c);
    const uiStatus = c.status === "skipped" ? "skip" : c.status;
    logs[c.test_id] = {
      record: {
        "test-id": c.test_id,
        name: c.check_id,
        title: c.title,
        section: "Diagnostics: " + c.category,
        source: "cron:" + c.check_id,
        command: "cloudflare-cron",
        status: uiStatus,
        timestamp: c.started_at || startedIso,
        elapsed: (c.duration_ms / 1000).toFixed(3),
      },
      log: `${startedIso} [${c.status === "pass" ? "PASS " : c.status === "fail" ? "ERROR" : "WARN "}] cron:${c.check_id} | ${c.summary || c.error || c.skip_reason || ""}\n`,
    };
  };

  const runHttpCheck = async (
    checkId: string,
    title: string,
    dependsOn: string[],
    url: string,
    validate: (resp: Response, body: string) => string | null,
    redirect: RequestRedirect = "follow",
  ) => {
    const testId = randomHex16(16);
    const t0 = nowMs();
    for (const dep of dependsOn) {
      const parent = checks.find((x) => x.check_id === dep);
      if (!parent || parent.status !== "pass") {
        const reason = `skipped because dependency ${dep} ${parent?.status || "failed"}`;
        recordCheck({
          check_id: checkId,
          test_id: testId,
          category: "http",
          title,
          depends_on: dependsOn,
          status: "skipped",
          skip_reason: reason,
          started_at: new Date(t0).toISOString(),
          ended_at: new Date(nowMs()).toISOString(),
          duration_ms: 0,
          summary: reason,
        });
        return;
      }
    }
    try {
      const resp = await fetchImpl(url, { method: "GET", redirect });
      const body = resp.status >= 300 && resp.status < 400 ? "" : await resp.text();
      const errMsg = validate(resp, body);
      const t1 = nowMs();
      const dur = Math.max(0, t1 - t0);
      if (errMsg) {
        recordCheck({
          check_id: checkId,
          test_id: testId,
          category: "http",
          title,
          depends_on: dependsOn,
          status: "fail",
          started_at: new Date(t0).toISOString(),
          ended_at: new Date(t1).toISOString(),
          duration_ms: dur,
          error: redactText(errMsg),
          summary: redactText(errMsg),
          details: { url, status_code: resp.status, latency_ms: dur },
        });
      } else {
        recordCheck({
          check_id: checkId,
          test_id: testId,
          category: "http",
          title,
          depends_on: dependsOn,
          status: "pass",
          started_at: new Date(t0).toISOString(),
          ended_at: new Date(t1).toISOString(),
          duration_ms: dur,
          summary: `HTTP ${resp.status} (${dur}ms)`,
          details: { url, status_code: resp.status, latency_ms: dur },
        });
      }
    } catch (err) {
      const t1 = nowMs();
      const msg = redactText(err instanceof Error ? err.message : String(err));
      recordCheck({
        check_id: checkId,
        test_id: testId,
        category: "http",
        title,
        depends_on: dependsOn,
        status: "fail",
        started_at: new Date(t0).toISOString(),
        ended_at: new Date(t1).toISOString(),
        duration_ms: Math.max(0, t1 - t0),
        error: msg,
        summary: msg,
        details: { url },
      });
    }
  };

  await runHttpCheck(
    "http.dialtone.home",
    "dialtone.earth homepage and security headers",
    [],
    "https://dialtone.earth/",
    (resp, body) => {
      if (resp.status !== 200) return `HTTP ${resp.status} (want 200)`;
      if (!body.includes('id="app"')) return 'missing id="app"';
      if (!resp.headers.get("strict-transport-security")) return "missing HSTS header";
      return null;
    },
  );

  await runHttpCheck(
    "http.dialtone.session",
    "dialtone.earth /api/session",
    ["http.dialtone.home"],
    "https://dialtone.earth/api/session",
    (resp, body) => {
      if (resp.status !== 200) return `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(body) as { authenticated?: boolean; mode?: string };
        if (parsed.authenticated !== false || parsed.mode !== "simulated") {
          return "unexpected anonymous session state";
        }
        return null;
      } catch {
        return "invalid JSON";
      }
    },
  );

  await runHttpCheck(
    "http.dialtone.plugins",
    "dialtone.earth /api/plugins",
    ["http.dialtone.home"],
    "https://dialtone.earth/api/plugins",
    (resp, body) => {
      if (resp.status !== 200) return `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(body) as { plugins?: Array<{ name?: string }> };
        if (!Array.isArray(parsed.plugins) || !parsed.plugins.some((p) => p.name === "dialtone-shell")) {
          return "missing dialtone-shell in plugin catalog";
        }
        return null;
      } catch {
        return "invalid JSON";
      }
    },
  );

  await runHttpCheck(
    "http.dialtone.live",
    "dialtone.earth /api/live",
    ["http.dialtone.home"],
    "https://dialtone.earth/api/live",
    (resp) => (resp.status === 200 ? null : `HTTP ${resp.status}`),
  );

  await runHttpCheck(
    "http.metal.home",
    "metal.dialtone.earth homepage",
    [],
    "https://metal.dialtone.earth/",
    (resp) => (resp.status === 200 ? null : `HTTP ${resp.status}`),
  );

  await runHttpCheck(
    "http.metal.auth_gate",
    "metal.dialtone.earth /api/mesh/state 401 gate",
    ["http.metal.home"],
    "https://metal.dialtone.earth/api/mesh/state",
    (resp) => (resp.status === 401 ? null : `expected 401, got ${resp.status}`),
  );

  await runHttpCheck(
    "http.test.auth_gate",
    "test.dialtone.earth owner redirect gate",
    [],
    "https://test.dialtone.earth/",
    (resp) => {
      if (resp.status !== 302 || resp.headers.get("location") !== "/login") {
        return `expected 302 -> /login, got ${resp.status} -> ${resp.headers.get("location") || ""}`;
      }
      return null;
    },
    "manual",
  );

  const endedMs = nowMs();
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const skipped = checks.filter((c) => c.status === "skipped").length;
  const stamp = new Date(startedMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const loopId = `${stamp}-cron-${randomHex16(3)}`;

  const report: DiagLoopReport = {
    schema_version: 1,
    loop_id: loopId,
    source: "cron",
    runner_node: "cloudflare-worker",
    interval: "10m",
    started_at: startedIso,
    ended_at: new Date(endedMs).toISOString(),
    duration_ms: Math.max(0, endedMs - startedMs),
    status: failed === 0 ? "pass" : "fail",
    summary: { total: checks.length, passed, failed, skipped },
    screenshots_url: "/screenshots/",
    checks,
  };

  await persistReportToEdge(env, report, logs);
  return report;
}
