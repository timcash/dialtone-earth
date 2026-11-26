import assert from "node:assert/strict";
import test from "node:test";

import { handleGatewayRequest } from "../worker/gateway.ts";
import { runScheduledHttpDiagnostics } from "../worker/diagnostics.ts";

function createMemoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function createMemoryR2() {
  const store = new Map();
  return {
    store,
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        body: entry.buf,
        size: entry.buf.byteLength,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
        async arrayBuffer() {
          return entry.buf.slice(0);
        },
        async text() {
          return new TextDecoder().decode(entry.buf);
        },
      };
    },
    async put(key, value, options = {}) {
      let buf;
      if (value instanceof ArrayBuffer) {
        buf = new Uint8Array(value.slice(0));
      } else if (ArrayBuffer.isView(value)) {
        buf = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      } else if (typeof value === "string") {
        buf = new TextEncoder().encode(value);
      } else {
        buf = new Uint8Array(0);
      }
      store.set(key, {
        buf,
        httpMetadata: options.httpMetadata || {},
        customMetadata: options.customMetadata || {},
      });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function makeEnv(kv, r2) {
  return {
    DIALTONE_AUTH_TOKENS: kv,
    DIALTONE_REGISTRY: r2,
    SESSION_SIGNING_KEY: "super-secret-signing-key-for-diagnostics-worker-tests",
    LIVE_CONTROL_TOKEN: "owner-cli-bearer-secret-token-2026",
    OWNER_EMAIL: "timcash@gmail.com",
    MESH_ORIGIN_TOKEN: "staging-origin-secret-token-1234",
    MESH_ORIGINS_MAP: JSON.stringify({
      "test.dialtone.earth": "https://staging-origin.example",
    }),
    ACCESS_TEAM_DOMAIN: "https://oakleon.cloudflareaccess.com",
    ACCESS_AUD_MAP: JSON.stringify({
      "test.dialtone.earth": "aud-test-staging-123",
    }),
  };
}

test("test.dialtone.earth /diagnostics is owner-only, persists runs/logs in R2+KV, and renders DAG + history", async () => {
  const nowSec = 1_795_600_000;
  const kv = createMemoryKv();
  const r2 = createMemoryR2();
  const env = makeEnv(kv, r2);
  const deps = {
    nowSec: () => nowSec,
    fetchImpl: async () => new Response("fallback", { status: 404 }),
    verifyJwt: async (jwt) => {
      if (jwt === "cf-jwt-intruder") return { valid: true, subject: "intruder@example.com" };
      return { valid: false, reason: "invalid" };
    },
  };
  const ownerAuth = { Authorization: "Bearer owner-cli-bearer-secret-token-2026" };

  // 1. Anonymous and non-owner requests are blocked.
  const anonPage = await handleGatewayRequest(new Request("https://test.dialtone.earth/diagnostics"), env, deps);
  assert.equal(anonPage.status, 302);
  assert.equal(anonPage.headers.get("Location"), "/login");

  const anonApi = await handleGatewayRequest(new Request("https://test.dialtone.earth/api/diagnostics/latest"), env, deps);
  assert.equal(anonApi.status, 401);

  const anonPost = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/api/diagnostics/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report: { loop_id: "unauth" } }),
    }),
    env,
    deps,
  );
  assert.equal(anonPost.status, 401);

  const intruderPage = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/diagnostics", {
      headers: { "Cf-Access-Jwt-Assertion": "cf-jwt-intruder" },
    }),
    env,
    deps,
  );
  assert.equal(intruderPage.status, 403);

  // 2. Owner publishes loop 1 with checks + logs.
  const testId1 = "1".repeat(32);
  const testId2 = "2".repeat(32);
  const loop1Payload = {
    report: {
      schema_version: 1,
      loop_id: "20261126-220000Z-aaaa11",
      source: "cli",
      runner_node: "rosie",
      interval: "10m0s",
      started_at: "2026-11-26T22:00:00Z",
      ended_at: "2026-11-26T22:00:04Z",
      duration_ms: 4000,
      status: "fail",
      summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
      screenshots_url: "/screenshots/",
      checks: [
        {
          check_id: "mesh.local.probe",
          test_id: testId1,
          category: "metal",
          title: "Local mesh probe",
          depends_on: [],
          status: "pass",
          duration_ms: 120,
          summary: "3/3 checks ok",
        },
        {
          check_id: "mesh.node.grok-bot-metal",
          test_id: testId2,
          category: "metal",
          title: "Peer grok-bot-metal",
          depends_on: ["mesh.local.probe"],
          status: "fail",
          duration_ms: 1500,
          summary: "peer offline",
          error: "timeout",
          task_id: "t-fake-1",
        },
      ],
    },
    logs: {
      [testId1]: {
        record: {
          "test-id": testId1,
          name: "mesh.local.probe",
          title: "Local mesh probe",
          status: "pass",
          elapsed: "0.120",
          timestamp: "2026-11-26T22:00:00Z",
        },
        log: "2026-11-26T22:00:00.000Z [PASS ] diag | mesh.local.probe ok\n",
      },
    },
  };

  const post1 = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/api/diagnostics/runs", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify(loop1Payload),
    }),
    env,
    deps,
  );
  assert.equal(post1.status, 200);
  assert.equal(r2.store.has("diag/runs/20261126-220000Z-aaaa11.json"), true);
  assert.equal(r2.store.has(`diag/logs/${testId1}.log`), true);

  // 3. Owner GET /diagnostics HTML renders DAG, statuses, test-id log link, screenshot link, history.
  const page = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/diagnostics", { headers: ownerAuth }),
    env,
    deps,
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /mesh\.local\.probe/);
  assert.match(html, /mesh\.node\.grok-bot-metal/);
  assert.match(html, new RegExp(`/logs/\\?test-id=${testId1}`));
  assert.match(html, /\/screenshots\//);
  assert.match(html, /\/diagnostics\/runs\/20261126-220000Z-aaaa11/);
  assert.equal(html.includes("\u2014"), false, "HTML must not contain em-dashes");

  // 4. Per-loop page & JSON APIs & /api/test-runs/<test-id> integration.
  const runPage = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/diagnostics/runs/20261126-220000Z-aaaa11", { headers: ownerAuth }),
    env,
    deps,
  );
  assert.equal(runPage.status, 200);
  assert.match(await runPage.text(), /20261126-220000Z-aaaa11/);

  const latestApi = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/api/diagnostics/latest", { headers: ownerAuth }),
    env,
    deps,
  );
  assert.equal(latestApi.status, 200);
  const latestJson = await latestApi.json();
  assert.equal(latestJson.loop_id, "20261126-220000Z-aaaa11");

  const histApi = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/api/diagnostics/history", { headers: ownerAuth }),
    env,
    deps,
  );
  assert.equal(histApi.status, 200);
  const histJson = await histApi.json();
  assert.equal(histJson.history.length, 1);

  const testRunApi = await handleGatewayRequest(
    new Request(`https://test.dialtone.earth/api/test-runs/${testId1}`, { headers: ownerAuth }),
    env,
    deps,
  );
  assert.equal(testRunApi.status, 200);
  const testRunJson = await testRunApi.json();
  assert.match(testRunJson.run.log, /mesh\.local\.probe ok/);
});

test("scheduled HTTP-only diagnostics cron runs read-only GET checks and persists to R2+KV", async () => {
  const kv = createMemoryKv();
  const r2 = createMemoryR2();
  const env = makeEnv(kv, r2);

  const fakeFetch = async (url) => {
    const u = String(url);
    if (u === "https://dialtone.earth/") {
      return new Response('<html><div id="app"></div></html>', {
        status: 200,
        headers: {
          "strict-transport-security": "max-age=31536000",
          "content-security-policy": "default-src 'self'",
          "x-frame-options": "DENY",
        },
      });
    }
    if (u === "https://dialtone.earth/api/session") {
      return new Response(JSON.stringify({ authenticated: false, mode: "simulated" }), { status: 200 });
    }
    if (u === "https://dialtone.earth/api/plugins") {
      return new Response(JSON.stringify({ plugins: [{ name: "dialtone-shell" }] }), { status: 200 });
    }
    if (u === "https://dialtone.earth/api/live") {
      return new Response(JSON.stringify({ revision: 1 }), { status: 200 });
    }
    if (u === "https://metal.dialtone.earth/") {
      return new Response('<html><div id="app"></div></html>', { status: 200 });
    }
    if (u === "https://metal.dialtone.earth/api/mesh/state") {
      return new Response(JSON.stringify({ error: "auth required" }), { status: 401 });
    }
    if (u === "https://test.dialtone.earth/") {
      return new Response(null, { status: 302, headers: { Location: "/login" } });
    }
    return new Response("not found", { status: 404 });
  };

  const report = await runScheduledHttpDiagnostics(env, {
    fetchImpl: fakeFetch,
    nowMs: () => 1_795_600_000_000,
  });
  assert.equal(report.source, "cron");
  assert.equal(report.status, "pass");
  assert.ok(report.summary.passed >= 5);
  assert.ok(r2.store.has(`diag/runs/${report.loop_id}.json`));
  assert.ok(kv.store.has("diag:latest"));
  assert.ok(kv.store.has("diag:history"));
});
