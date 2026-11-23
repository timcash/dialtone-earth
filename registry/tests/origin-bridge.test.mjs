import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  createOriginBridgeHandler,
  sanitizeStatePayload,
} from "../scripts/mesh-origin-bridge.mjs";

test("origin bridge enforces Bearer auth on GET, blocks mutations, and sanitizes /api/state", async (ctx) => {
  let upstreamCalls = 0;
  const handler = createOriginBridgeHandler({
    token: "super-secret-origin-token-123456",
    meshOrigin: "http://127.0.0.1:8788",
    testOrigin: "http://127.0.0.1:5174",
    fetchImpl: async (url) => {
      upstreamCalls += 1;
      if (String(url).endsWith("/api/state")) {
        return new Response(
          JSON.stringify({
            node: "example",
            mesh_config: { secret_key: "must-not-leak" },
            events: [{ id: "e1", message: "ok" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // Missing token -> 401, 0 upstream calls
  assert.equal((await fetch(`${base}/api/mesh`)).status, 401);
  // Wrong token -> 401, 0 upstream calls
  assert.equal(
    (
      await fetch(`${base}/api/mesh`, {
        headers: { Authorization: "Bearer wrong-token" },
      })
    ).status,
    401,
  );
  // POST -> 405, 0 upstream calls
  assert.equal(
    (
      await fetch(`${base}/api/mesh`, {
        method: "POST",
        headers: { Authorization: "Bearer super-secret-origin-token-123456" },
      })
    ).status,
    405,
  );
  // Disallowed route -> 404, 0 upstream calls
  assert.equal(
    (
      await fetch(`${base}/api/exec`, {
        headers: { Authorization: "Bearer super-secret-origin-token-123456" },
      })
    ).status,
    404,
  );
  assert.equal(upstreamCalls, 0);

  // Authorized /api/state -> 200 sanitized (no mesh_config/secret_key)
  const okResp = await fetch(`${base}/api/state`, {
    headers: { Authorization: "Bearer super-secret-origin-token-123456" },
  });
  assert.equal(okResp.status, 200);
  const body = await okResp.json();
  assert.equal(body.node, "example");
  assert.equal(body.mesh_config, undefined);
  assert.equal(body.events.length, 1);
  assert.equal(upstreamCalls, 1);
});

test("sanitizeStatePayload drops secrets and preserves events/probe", () => {
  const out = sanitizeStatePayload({
    node: "n1",
    mesh_config: { secret_key: "dt-secret" },
    events: [{ id: "1" }],
    probe: { passed_count: 3 },
  });
  assert.equal("mesh_config" in out, false);
  assert.equal(out.events.length, 1);
  assert.equal(out.probe.passed_count, 3);
});
