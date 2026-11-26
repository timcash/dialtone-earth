import assert from "node:assert/strict";
import test from "node:test";

import { handleGatewayRequest } from "../worker/gateway.ts";

function createMemoryKv() {
  const store = new Map();
  return {
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

test("test.dialtone.earth /screenshots/ is owner-only and overwrites cleanly per test loop", async () => {
  const nowSec = 1_795_500_000;
  const kv = createMemoryKv();
  const r2 = createMemoryR2();
  const env = {
    DIALTONE_AUTH_TOKENS: kv,
    DIALTONE_REGISTRY: r2,
    SESSION_SIGNING_KEY: "super-secret-signing-key-for-screenshot-worker-tests",
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

  const deps = {
    nowSec: () => nowSec,
    fetchImpl: async () => new Response("fallback-local-origin", { status: 404 }),
    verifyJwt: async (jwt) => {
      if (jwt === "cf-jwt-intruder") return { valid: true, subject: "intruder@example.com" };
      return { valid: false, reason: "invalid" };
    },
  };
  const ownerAuth = { Authorization: "Bearer owner-cli-bearer-secret-token-2026" };

  // 1. Anonymous and non-owner requests are blocked.
  const anonGallery = await handleGatewayRequest(new Request("https://test.dialtone.earth/screenshots/"), env, deps);
  assert.equal(anonGallery.status, 302);
  assert.equal(anonGallery.headers.get("Location"), "/login");

  const anonApi = await handleGatewayRequest(new Request("https://test.dialtone.earth/api/screenshots/latest"), env, deps);
  assert.equal(anonApi.status, 401);

  const intruderGallery = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/screenshots/", {
      headers: { "Cf-Access-Jwt-Assertion": "cf-jwt-intruder" },
    }),
    env,
    deps,
  );
  assert.equal(intruderGallery.status, 403);

  // 2. Owner uploads Loop 1 files and commits.
  const uploadFile = async (filename, body, contentType, loopId) => {
    const resp = await handleGatewayRequest(
      new Request(`https://test.dialtone.earth/api/screenshots/latest/files/${encodeURIComponent(filename)}`, {
        method: "PUT",
        headers: {
          ...ownerAuth,
          "Content-Type": contentType,
          "X-Dialtone-Loop-Id": loopId,
        },
        body,
      }),
      env,
      deps,
    );
    assert.equal(resp.status, 200, `PUT ${filename} failed`);
  };

  await uploadFile("index.html", "<html><body>Loop 1 Gallery</body></html>", "text/html; charset=utf-8", "loop-1");
  await uploadFile("manifest.json", JSON.stringify({ loop_id: "loop-1" }), "application/json", "loop-1");
  await uploadFile("test-alpha.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), "image/png", "loop-1");
  await uploadFile("test-stale.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]), "image/png", "loop-1");

  const commit1 = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/api/screenshots/latest/commit", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        loop_id: "loop-1",
        generated_at: "2026-11-25T19:00:00Z",
        files: [
          { filename: "index.html", content_type: "text/html; charset=utf-8", bytes: 40, sha256: "a1" },
          { filename: "manifest.json", content_type: "application/json", bytes: 20, sha256: "a2" },
          { filename: "test-alpha.png", content_type: "image/png", bytes: 5, sha256: "a3" },
          { filename: "test-stale.png", content_type: "image/png", bytes: 5, sha256: "a4" },
        ],
      }),
    }),
    env,
    deps,
  );
  assert.equal(commit1.status, 200);

  // Verify redirect /screenshots -> /screenshots/ and served gallery HTML + PNG.
  const redir = await handleGatewayRequest(new Request("https://test.dialtone.earth/screenshots", { headers: ownerAuth }), env, deps);
  assert.equal(redir.status, 302);
  assert.equal(redir.headers.get("Location"), "/screenshots/");

  const gallery1 = await handleGatewayRequest(new Request("https://test.dialtone.earth/screenshots/", { headers: ownerAuth }), env, deps);
  assert.equal(gallery1.status, 200);
  assert.match(await gallery1.text(), /Loop 1 Gallery/);
  assert.equal(gallery1.headers.get("Cache-Control"), "private, no-store");

  const staleBefore = await handleGatewayRequest(new Request("https://test.dialtone.earth/screenshots/test-stale.png", { headers: ownerAuth }), env, deps);
  assert.equal(staleBefore.status, 200);
  assert.equal(staleBefore.headers.get("Content-Type"), "image/png");

  // 3. Loop 2 overwrites the stable URL and prunes test-stale.png from R2.
  await uploadFile("index.html", "<html><body>Loop 2 Gallery</body></html>", "text/html; charset=utf-8", "loop-2");
  await uploadFile("manifest.json", JSON.stringify({ loop_id: "loop-2" }), "application/json", "loop-2");
  await uploadFile("test-alpha.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]), "image/png", "loop-2");
  await uploadFile("test-fresh.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 8]), "image/png", "loop-2");

  const commit2 = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/api/screenshots/latest/commit", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        loop_id: "loop-2",
        generated_at: "2026-11-25T19:05:00Z",
        files: [
          { filename: "index.html", content_type: "text/html; charset=utf-8", bytes: 40, sha256: "b1" },
          { filename: "manifest.json", content_type: "application/json", bytes: 20, sha256: "b2" },
          { filename: "test-alpha.png", content_type: "image/png", bytes: 5, sha256: "b3" },
          { filename: "test-fresh.png", content_type: "image/png", bytes: 5, sha256: "b4" },
        ],
      }),
    }),
    env,
    deps,
  );
  assert.equal(commit2.status, 200);
  const commit2Json = await commit2.json();
  assert.deepEqual(commit2Json.pruned_stale_files, ["test-stale.png"]);
  assert.equal(r2.store.has("screenshots/latest/test-stale.png"), false);

  const gallery2 = await handleGatewayRequest(new Request("https://test.dialtone.earth/screenshots/", { headers: ownerAuth }), env, deps);
  assert.equal(gallery2.status, 200);
  assert.match(await gallery2.text(), /Loop 2 Gallery/);

  const latestManifest = await handleGatewayRequest(new Request("https://test.dialtone.earth/api/screenshots/latest", { headers: ownerAuth }), env, deps);
  assert.equal(latestManifest.status, 200);
  const latestJson = await latestManifest.json();
  assert.equal(latestJson.loop_id, "loop-2");
});
