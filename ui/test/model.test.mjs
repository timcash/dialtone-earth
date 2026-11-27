import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTestSection,
  computeTestProgress,
  diagStatusMeta,
  elapsedSeconds,
  formatDiagSummaryLine,
  groupDiagChecksByCategory,
  groupTestsBySection,
  normalizeStatus,
  parseStructuredLogLine,
  statusLabel,
  testLogHref,
} from "../src/model.js";

test("unknown status starts pending", () => {
  assert.equal(normalizeStatus("unknown"), "pending");
  assert.equal(statusLabel("pass"), "passed");
  assert.equal(statusLabel("fail"), "failed");
  assert.equal(statusLabel("skip"), "skipped");
});

test("running elapsed time advances from its timestamp", () => {
  const row = { status: "running", timestamp: "2026-01-01T00:00:00.000Z", elapsed: "0" };
  assert.equal(elapsedSeconds(row, Date.parse("2026-01-01T00:00:01.250Z")), 1.25);
});

test("completed elapsed time uses the recorded value", () => {
  assert.equal(elapsedSeconds({ status: "pass", timestamp: "none", elapsed: "0.375" }), 0.375);
});

test("log links open a separate page for a specific test execution", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const url = new URL(testLogHref(id), "http://localhost:5174");
  assert.equal(url.pathname, "/logs/");
  assert.equal(url.searchParams.get("test-id"), id);
  assert.notEqual(testLogHref(id), testLogHref("f".repeat(32)));
  assert.equal(testLogHref(id, "/copied/v1/"), `/copied/v1/logs/?test-id=${id}`);
});

test("unstarted tests and invalid identifiers do not get log links", () => {
  for (const id of [undefined, "", "pending", "../state.json", "<script>", "a".repeat(33)]) {
    assert.equal(testLogHref(id), null);
  }
});

test("groupTestsBySection splits tests into ordered functional sections", () => {
  const rows = [
    { name: "TestDialtoneEarthLiveMetalUIParity", section: "Live metal Data & UI" },
    { name: "TestDialtoneEarthCloudflareGateway", section: "Cloudflare Gateway & Security" },
    { name: "TestBuildArtifacts" },
    { name: "TestHelpListsEveryAction" },
  ];
  assert.equal(classifyTestSection(rows[2]), "Build, Live CLI & PWA");
  const groups = groupTestsBySection(rows);
  assert.deepEqual(
    groups.map((g) => g.title),
    [
      "Live metal Data & UI",
      "Cloudflare Gateway & Security",
      "Build, Live CLI & PWA",
      "CLI & Test Runner Contracts",
    ],
  );
  assert.equal(groups[0].tests.length, 1);
});

test("parseStructuredLogLine extracts timestamp, log level, and file:line source", () => {
  const errLine = parseStructuredLogLine(
    "2026-11-23T18:30:01.245Z [ERROR] registry/tests/metal-ui-e2e.test.mjs:290 | AssertionError: boom",
  );
  assert.equal(errLine.structured, true);
  assert.equal(errLine.timestamp, "2026-11-23T18:30:01.245Z");
  assert.equal(errLine.level, "ERROR");
  assert.equal(errLine.source, "registry/tests/metal-ui-e2e.test.mjs:290");
  assert.equal(errLine.message, "AssertionError: boom");

  const passLine = parseStructuredLogLine(
    "2026-11-23T18:30:01.250Z [PASS ] cli_test.go:25 | --- PASS: TestExample (0.01s)",
  );
  assert.equal(passLine.structured, true);
  assert.equal(passLine.level, "PASS");
  assert.equal(passLine.source, "cli_test.go:25");
});

test("synced browser tests classify into Synced Live Browser (CDP) section first", () => {
  const rows = [
    { name: "TestDialtoneEarthLiveMetalUIParity", section: "Live metal Data & UI" },
    { name: "TestBrowser01SignedOutContainment" },
    { name: "TestBrowser02MagicLinkLogin" },
  ];
  assert.equal(classifyTestSection(rows[1]), "Synced Live Browser (CDP)");
  const groups = groupTestsBySection(rows);
  assert.equal(groups[0].title, "Synced Live Browser (CDP)");
  assert.equal(groups[0].tests.length, 2);
});

test("computeTestProgress fills against last_elapsed and marks overtime red when exceeded", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const under = computeTestProgress(
    { status: "running", timestamp: start, elapsed: "0", last_elapsed: "10" },
    0,
    Date.parse("2026-01-01T00:00:05.000Z"),
  );
  assert.equal(under.percent, 50);
  assert.equal(under.overtime, false);

  const over = computeTestProgress(
    { status: "running", timestamp: start, elapsed: "0", last_elapsed: "10" },
    0,
    Date.parse("2026-01-01T00:00:12.500Z"),
  );
  assert.equal(over.percent, 100);
  assert.equal(over.overtime, true);

  const passedFast = computeTestProgress({ status: "pass", elapsed: "4.5", last_elapsed: "10" });
  assert.equal(passedFast.percent, 100);
  assert.equal(passedFast.overtime, false);

  const passedSlow = computeTestProgress({ status: "pass", elapsed: "11.2", last_elapsed: "10" });
  assert.equal(passedSlow.percent, 100);
  assert.equal(passedSlow.overtime, true);
});

test("diagStatusMeta and groupDiagChecksByCategory render pending-migration distinctly without counting as failure", () => {
  const pend = diagStatusMeta("pending");
  assert.equal(pend.cls, "is-pending");
  assert.equal(pend.label, "PENDING");
  assert.equal(pend.isFailure, false);

  const info = diagStatusMeta("info");
  assert.equal(info.cls, "is-info");
  assert.equal(info.isFailure, false);

  const checks = [
    { check_id: "gb35.api.channels", category: "gb35", status: "skipped" },
    { check_id: "version.task.node.rosie", category: "versions", status: "pass" },
    { check_id: "migration.dialtone.v060", category: "migration", status: "pending" },
    { check_id: "gb34.logs.chunk", category: "gb34", status: "pass" },
    { check_id: "macapp.version.rosie", category: "macapp", status: "info" },
  ];
  const groups = groupDiagChecksByCategory(checks);
  assert.deepEqual(
    groups.map((g) => g.category),
    ["versions", "migration", "gb34", "gb35", "macapp"],
  );
  assert.equal(groups[1].counts.pending, 1);
  assert.equal(groups[1].counts.failed, 0);

  const summaryLine = formatDiagSummaryLine({ total: 5, passed: 2, failed: 0, skipped: 1, pending: 1, info: 1 });
  assert.match(summaryLine, /2 pass/);
  assert.match(summaryLine, /0 fail/);
  assert.match(summaryLine, /1 pending/);
  assert.match(summaryLine, /1 info/);
  assert.match(summaryLine, /1 skipped/);
});

test("TestDiag tests classify into Diagnostic Loop & Coverage section", () => {
  assert.equal(classifyTestSection({ name: "TestDiagCoverageDAGWiringAndDefaultNodes" }), "Diagnostic Loop & Coverage");
});
