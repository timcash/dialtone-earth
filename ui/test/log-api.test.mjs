import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServer, loadConfigFromFile } from "vite";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the dashboard serves generated state and per-execution logs", async (context) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "dialtone-earth-log-api-"));
  const logsDir = resolve(fixture, "logs");
  const statePath = resolve(logsDir, "state.json");
  await mkdir(logsDir);
  const firstId = "a".repeat(32);
  const secondId = "b".repeat(32);
  for (const [id, status, log] of [
    [firstId, "pass", "first execution output\n"],
    [secondId, "running", "second execution output\n"],
  ]) {
    await writeFile(
      resolve(logsDir, `${id}.json`),
      JSON.stringify({
        "test-id": id,
        name: "TestDialtoneEarthOfflineGuardedAuth",
        title: "Dialtone Earth Offline Guarded Auth",
        command: 'go run . test --filter "^TestDialtoneEarthOfflineGuardedAuth$"',
        artifact: `logs/${id}.log`,
        status,
        elapsed: "0",
        timestamp: "none",
      }),
    );
    await writeFile(resolve(logsDir, `${id}.log`), log);
  }
  await writeFile(
    statePath,
    `${JSON.stringify({
      generated_at: "2026-01-01T00:00:00Z",
      tests: [{ name: "TestDialtoneEarthOfflineGuardedAuth", title: "Dialtone Earth Offline Guarded Auth", status: "running", elapsed: "0", timestamp: "none", "test-id": secondId }],
    })}\n`,
    "utf8",
  );

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
  const tests = (await (await fetch(`${base}/api/tests`)).json()).tests;
  assert.equal(tests.length, 1);
  assert.equal(tests[0].name, "TestDialtoneEarthOfflineGuardedAuth");
  assert.equal(tests[0]["test-id"], secondId);

  const readRun = async (id) => {
    const response = await fetch(`${base}/api/test-runs/${id}`);
    assert.equal(response.status, 200);
    return (await response.json()).run;
  };
  const details = await readRun(firstId);
  assert.equal(details.log, "first execution output\n");
  assert.equal(details.name, "TestDialtoneEarthOfflineGuardedAuth");
  assert.match(details.command, /--filter/);
  assert.equal((await readRun(secondId)).status, "running");
  await writeFile(resolve(logsDir, `${secondId}.log`), "second execution output\nmore live output\n");
  assert.match((await readRun(secondId)).log, /more live output/);
  assert.equal((await readRun(firstId))["test-id"], firstId);
  const raw = await fetch(`${base}/api/test-runs/${firstId}/log`);
  assert.equal(raw.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await raw.text(), "first execution output\n");
  assert.equal((await fetch(`${base}/api/test-runs/${"c".repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/test-runs/not-a-run`)).status, 400);
  assert.equal((await fetch(`${base}/api/test-runs/..%2Fstate.json`)).status, 400);
  const page = await fetch(`${base}/logs/?test-id=${firstId}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);

  const cdpResp = await fetch(`${base}/api/cdp/status`);
  assert.equal(cdpResp.status, 200);
  const cdpPayload = await cdpResp.json();
  assert.equal(typeof cdpPayload.connected, "boolean");
  assert.equal(typeof cdpPayload.port, "number");

  const badFilter = await fetch(`${base}/api/tests/run?filter=${encodeURIComponent("Test;rm -rf")}`, { method: "POST" });
  assert.equal(badFilter.status, 400);
});
