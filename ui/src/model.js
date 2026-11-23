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
