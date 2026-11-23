import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTestSection,
  elapsedSeconds,
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
