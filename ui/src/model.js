/** @typedef {"pending" | "running" | "pass" | "fail" | "skip"} TestStatus */

/** @param {unknown} testId @param {string} [base] @returns {string | null} */
export function testLogHref(testId, base = "/") {
  return typeof testId === "string" && /^[a-f0-9]{32}$/.test(testId)
    ? `${base.replace(/\/$/, "")}/logs/?test-id=${encodeURIComponent(testId)}`
    : null;
}

/** @param {unknown} value @returns {TestStatus} */
export function normalizeStatus(value) {
  return value === "running" || value === "pass" || value === "fail" || value === "skip" ? value : "pending";
}

/** @param {unknown} value */
export function statusLabel(value) {
  const status = normalizeStatus(value);
  return status === "pass" ? "passed" : status === "fail" ? "failed" : status === "skip" ? "skipped" : status;
}

/**
 * @param {{status?: unknown, timestamp?: unknown, elapsed?: unknown}} row
 * @param {number} [now]
 */
export function elapsedSeconds(row, now = Date.now()) {
  if (normalizeStatus(row.status) === "running" && typeof row.timestamp === "string") {
    const started = Date.parse(row.timestamp);
    if (Number.isFinite(started)) {
      return Math.max(0, (now - started) / 1000);
    }
  }
  const elapsed = Number.parseFloat(String(row.elapsed ?? "0"));
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

/**
 * Computes progress-bar fill percentage and overtime flag against the test's last elapsed time.
 * @param {{status?: unknown, timestamp?: unknown, elapsed?: unknown, last_elapsed?: unknown}} row
 * @param {number} [fallbackLastSec]
 * @param {number} [now]
 * @returns {{elapsed: number, lastSec: number, percent: number, overtime: boolean}}
 */
export function computeTestProgress(row, fallbackLastSec = 0, now = Date.now()) {
  const status = normalizeStatus(row.status);
  const elapsed = elapsedSeconds(row, now);
  const parsedLast = Number.parseFloat(String(row.last_elapsed ?? "0"));
  const lastSec =
    Number.isFinite(parsedLast) && parsedLast > 0
      ? parsedLast
      : Number.isFinite(fallbackLastSec) && fallbackLastSec > 0
        ? fallbackLastSec
        : 0;

  if (status === "running") {
    if (lastSec > 0) {
      const percent = Math.min(100, (elapsed / lastSec) * 100);
      return { elapsed, lastSec, percent, overtime: elapsed > lastSec };
    }
    const percent = Math.min(85, (elapsed / (elapsed + 2)) * 100);
    return { elapsed, lastSec: 0, percent, overtime: false };
  }
  if (status === "pass") {
    const overtime = lastSec > 0 && elapsed > lastSec;
    return { elapsed, lastSec, percent: 100, overtime };
  }
  if (status === "fail") {
    return { elapsed, lastSec, percent: 100, overtime: true };
  }
  return { elapsed, lastSec, percent: 0, overtime: false };
}

export const SECTION_META = [
  {
    title: "Synced Live Browser (CDP)",
    description: "Persistent reconnectable Chrome CDP session driving live https://metal.dialtone.earth/ side-by-side with this dashboard",
  },
  {
    title: "Live metal Data & UI",
    description: "Real metal channel payloads, 3D H3 globe & bundled ping arcs, tiling WM & query rates, fullscreen TypeScript Camera Studio, Cloudflare KV persistence, and tour captions",
  },
  {
    title: "Cloudflare Gateway & Security",
    description: "Magic-link & Cloudflare Access JWT auth, multi-origin failover, secret redaction, CSP/security headers, and read-only origin bridge",
  },
  {
    title: "Build, Live CLI & PWA",
    description: "Live dialtone.earth CLI overrides, Go & TypeScript lint, local bundle deploy, dashboard unit tests, and installable PWA checks",
  },
  {
    title: "Diagnostic Loop & Coverage",
    description: "Diagnostic DAG ordering, version checks, pending-migration gating, GB-34 agent spec, GB-35 channel scope fixtures, try_rpc retry, and Mac app verification",
  },
  {
    title: "CLI & Test Runner Contracts",
    description: "Structured timestamp/level/file:line logs, immutable per-run artifacts, stdlib CLI self-containment, and wrapper/installer verification",
  },
];

/** @param {{name?: unknown, section?: unknown}} row @returns {string} */
export function classifyTestSection(row) {
  if (typeof row?.section === "string" && row.section.trim() !== "") {
    return row.section.trim();
  }
  const name = typeof row?.name === "string" ? row.name : "";
  if (/^TestBrowser/.test(name)) {
    return "Synced Live Browser (CDP)";
  }
  if (/^TestDiag/.test(name)) {
    return "Diagnostic Loop & Coverage";
  }
  if (
    /LiveMetal|MetalCloudflareLive|MetalLiveBrowser|GlobeH3|TilingWindowManager|CameraStudio|CloudflareKVConfig|SimulatedTour/.test(name)
  ) {
    return "Live metal Data & UI";
  }
  if (/CloudflareGateway|SecurityHeaders|OriginBridge|RegistryNetworks/.test(name)) {
    return "Cloudflare Gateway & Security";
  }
  if (/LiveControlCLI|LintAllSources|BuildArtifacts|DeployLocalBundle|UIUnitTests|InstallablePWA/.test(name)) {
    return "Build, Live CLI & PWA";
  }
  return "CLI & Test Runner Contracts";
}

/**
 * @template {{name?: unknown, section?: unknown}} T
 * @param {T[]} rows
 * @returns {Array<{title: string, description: string, tests: T[]}>}
 */
export function groupTestsBySection(rows) {
  /** @type {Map<string, T[]>} */
  const buckets = new Map();
  for (const row of rows) {
    const section = classifyTestSection(row);
    const list = buckets.get(section) ?? [];
    list.push(row);
    buckets.set(section, list);
  }

  /** @type {Array<{title: string, description: string, tests: T[]}>} */
  const ordered = [];
  for (const meta of SECTION_META) {
    const items = buckets.get(meta.title);
    if (items && items.length > 0) {
      ordered.push({ title: meta.title, description: meta.description, tests: items });
      buckets.delete(meta.title);
    }
  }
  for (const [title, items] of buckets.entries()) {
    ordered.push({ title, description: "", tests: items });
  }
  return ordered;
}

const STRUCTURED_LOG_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+\[(ERROR|WARN |PASS |INFO )\]\s+([^\s|]+)\s+\|\s?(.*)$/;

/**
 * @param {string} line
 * @returns {{structured: boolean, timestamp: string, level: "ERROR"|"WARN"|"PASS"|"INFO", source: string, message: string}}
 */
export function parseStructuredLogLine(line) {
  const match = STRUCTURED_LOG_RE.exec(line);
  if (!match) {
    const isErr = /--- FAIL:|AssertionError|Error:|panic:|✖/.test(line);
    const isPass = /--- PASS:|✔/.test(line);
    return {
      structured: false,
      timestamp: "",
      level: isErr ? "ERROR" : isPass ? "PASS" : "INFO",
      source: "",
      message: line,
    };
  }
  const level = /** @type {"ERROR"|"WARN"|"PASS"|"INFO"} */ (match[2].trim());
  return {
    structured: true,
    timestamp: match[1],
    level,
    source: match[3],
    message: match[4],
  };
}

export const DIAG_CATEGORY_ORDER = [
  "http",
  "metal",
  "versions",
  "migration",
  "plugins",
  "gb34",
  "gb35",
  "rpc",
  "macapp",
  "dialtone",
];

export const DIAG_CATEGORY_TITLES = {
  http: "Public & Auth HTTP Endpoints",
  metal: "Metal Mesh Connectivity",
  versions: "Fleet Plugin & Agent Versions",
  migration: "Migration Readiness (Pending Does Not Fail)",
  plugins: "Installed Plugins & Task Consistency",
  gb34: "GB-34 Agent Spec, Logs & Permissions",
  gb35: "GB-35 Channel Scope & Manifests",
  rpc: "RPC & DB Lock Retry",
  macapp: "Mac App Verification",
  dialtone: "Dialtone Daemon & CLI",
};

/**
 * Maps a diagnostic check status to display metadata. Pending and info never count as failures.
 * @param {unknown} status
 * @returns {{status: string, cls: string, label: string, isFailure: boolean}}
 */
export function diagStatusMeta(status) {
  const st = typeof status === "string" ? status.trim().toLowerCase() : "skipped";
  switch (st) {
    case "pass":
      return { status: "pass", cls: "is-pass", label: "PASS", isFailure: false };
    case "fail":
      return { status: "fail", cls: "is-fail", label: "FAIL", isFailure: true };
    case "pending":
      return { status: "pending", cls: "is-pending", label: "PENDING", isFailure: false };
    case "info":
      return { status: "info", cls: "is-info", label: "INFO", isFailure: false };
    default:
      return { status: "skipped", cls: "is-skip", label: "SKIPPED", isFailure: false };
  }
}

/**
 * Groups diagnostic check items by category in canonical order with per-group counts.
 * @template {{category?: string, status?: string}} T
 * @param {T[]} checks
 * @returns {Array<{category: string, title: string, checks: T[], counts: {total: number, passed: number, failed: number, pending: number, info: number, skipped: number}}>}
 */
export function groupDiagChecksByCategory(checks) {
  /** @type {Map<string, T[]>} */
  const buckets = new Map();
  for (const c of Array.isArray(checks) ? checks : []) {
    const key = typeof c?.category === "string" && c.category.trim() !== "" ? c.category.trim().toLowerCase() : "other";
    const list = buckets.get(key) ?? [];
    list.push(c);
    buckets.set(key, list);
  }

  /** @param {string} category @param {T[]} items */
  const toGroup = (category, items) => {
    const counts = { total: items.length, passed: 0, failed: 0, pending: 0, info: 0, skipped: 0 };
    for (const item of items) {
      const st = diagStatusMeta(item?.status).status;
      if (st === "pass") counts.passed += 1;
      else if (st === "fail") counts.failed += 1;
      else if (st === "pending") counts.pending += 1;
      else if (st === "info") counts.info += 1;
      else counts.skipped += 1;
    }
    const title = DIAG_CATEGORY_TITLES[/** @type {keyof typeof DIAG_CATEGORY_TITLES} */ (category)] || category.toUpperCase();
    return { category, title, checks: items, counts };
  };

  const ordered = [];
  for (const key of DIAG_CATEGORY_ORDER) {
    const items = buckets.get(key);
    if (items && items.length > 0) {
      ordered.push(toGroup(key, items));
      buckets.delete(key);
    }
  }
  for (const key of Array.from(buckets.keys()).sort()) {
    const items = buckets.get(key);
    if (items && items.length > 0) {
      ordered.push(toGroup(key, items));
    }
  }
  return ordered;
}

/**
 * Formats loop summary totals including pending and optional info counts.
 * @param {{total?: number, passed?: number, failed?: number, skipped?: number, pending?: number, info?: number}} summary
 * @returns {string}
 */
export function formatDiagSummaryLine(summary) {
  const passed = Number(summary?.passed ?? 0);
  const failed = Number(summary?.failed ?? 0);
  const pending = Number(summary?.pending ?? 0);
  const info = Number(summary?.info ?? 0);
  const skipped = Number(summary?.skipped ?? 0);
  const total = Number(summary?.total ?? 0);
  const parts = [`${passed} pass`, `${failed} fail`, `${pending} pending`];
  if (info > 0) parts.push(`${info} info`);
  parts.push(`${skipped} skipped`);
  return `${parts.join(", ")} / ${total}`;
}
