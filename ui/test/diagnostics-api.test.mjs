import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, loadConfigFromFile } from "vite";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("local dev server accepts POST /api/diagnostics/runs and serves /diagnostics and history", async (context) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "dialtone-earth-diag-api-"));
  const logsDir = resolve(fixture, "logs");
  const statePath = resolve(logsDir, "state.json");
  await mkdir(logsDir, { recursive: true });

  const previousPath = process.env.DIALTONE_EARTH_STATE_PATH;
  process.env.DIALTONE_EARTH_STATE_PATH = statePath;
  const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, resolve(uiDir, "vite.config.ts"));
  if (previousPath === undefined) {
    delete process.env.DIALTONE_EARTH_STATE_PATH;
  } else {
    process.env.DIALTONE_EARTH_STATE_PATH = previousPath;
  }
  assert.ok(loaded, "vite config should load");

  const server = await createServer({
    ...loaded.config,
    configFile: false,
    root: uiDir,
    logLevel: "silent",
    server: { ...loaded.config.server, host: "127.0.0.1", port: 0, strictPort: false },
  });
  context.after(async () => {
    await server.close();
    await rm(fixture, { recursive: true, force: true });
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const testId = "f".repeat(32);
  const postResp = await fetch(`${base}/api/diagnostics/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      report: {
        schema_version: 1,
        loop_id: "20261126-221000Z-local1",
        source: "cli",
        runner_node: "rosie",
        interval: "10m0s",
        started_at: "2026-11-26T22:10:00Z",
        ended_at: "2026-11-26T22:10:02Z",
        duration_ms: 2000,
        status: "pass",
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        screenshots_url: "/screenshots/",
        checks: [
          {
            check_id: "http.dialtone.home",
            test_id: testId,
            category: "http",
            title: "dialtone.earth home",
            depends_on: [],
            status: "pass",
            duration_ms: 55,
            summary: "HTTP 200 OK",
          },
        ],
      },
      logs: {
        [testId]: {
          record: {
            "test-id": testId,
            name: "http.dialtone.home",
            title: "dialtone.earth home",
            status: "pass",
            elapsed: "0.055",
            timestamp: "2026-11-26T22:10:00Z",
          },
          log: "2026-11-26T22:10:00.000Z [PASS ] diag | HTTP 200 OK\n",
        },
      },
    }),
  });
  assert.equal(postResp.status, 200);
  const postJson = await postResp.json();
  assert.equal(postJson.ok, true);
  assert.equal(postJson.loop_id, "20261126-221000Z-local1");

  const latestResp = await fetch(`${base}/api/diagnostics/latest`);
  assert.equal(latestResp.status, 200);
  const latest = await latestResp.json();
  assert.equal(latest.loop_id, "20261126-221000Z-local1");

  const histResp = await fetch(`${base}/api/diagnostics/history`);
  assert.equal(histResp.status, 200);
  const hist = await histResp.json();
  assert.equal(hist.history.length, 1);

  const runResp = await fetch(`${base}/api/diagnostics/runs/20261126-221000Z-local1`);
  assert.equal(runResp.status, 200);
  const runData = await runResp.json();
  assert.equal(runData.checks[0].test_id, testId);

  const pageResp = await fetch(`${base}/diagnostics`);
  assert.equal(pageResp.status, 200);
  assert.match(pageResp.headers.get("content-type") || "", /text\/html/);
});
