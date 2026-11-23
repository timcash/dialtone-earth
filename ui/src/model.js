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
