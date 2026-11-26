import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  };
}

test("Cloudflare R2 + KV registry stores code bundles, releases, and public plugins with SHA-256 verification", async () => {
  const env = {
    DIALTONE_AUTH_TOKENS: createMemoryKv(),
    DIALTONE_REGISTRY: createMemoryR2(),
    LIVE_CONTROL_TOKEN: "test-control-secret-token",
  };
  const authHeader = { Authorization: `Bearer ${env.LIVE_CONTROL_TOKEN}` };
  const deps = { nowSec: () => 1_795_480_000 };

  // 1. Unauthenticated write must fail closed (401)
  const unauthPush = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/code/dialtone-earth/push", {
      method: "PUT",
      headers: { "X-Dialtone-Sha": "abcdef1234567" },
      body: new Uint8Array([1, 2, 3]),
    }),
    env,
    deps,
  );
  assert.equal(unauthPush.status, 401);

  // 2. Push git bundle & verify round-trip download + repo listing
  const bundleBytes = new TextEncoder().encode("# v2 git bundle\nsynthetic-bundle-bytes\n");
  const expectedBundleSha = createHash("sha256").update(bundleBytes).digest("hex");
  const pushResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/code/dialtone-earth/push", {
      method: "PUT",
      headers: {
        ...authHeader,
        "X-Dialtone-Branch": "main",
        "X-Dialtone-Sha": "69b49eed1234567890",
        "X-Dialtone-Subject": "move version control to cloudflare R2",
        "X-Dialtone-Author": "timcash",
      },
      body: bundleBytes,
    }),
    env,
    deps,
  );
  assert.equal(pushResp.status, 200);
  const pushJson = await pushResp.json();
  assert.equal(pushJson.bundle_sha256, expectedBundleSha);

  const listRepos = await (
    await handleGatewayRequest(
      new Request("https://dialtone.earth/api/code", { headers: authHeader }),
      env,
      deps,
    )
  ).json();
  assert.equal(listRepos.repos.length, 1);
  assert.equal(listRepos.repos[0].name, "dialtone-earth");
  assert.equal(listRepos.repos[0].head_sha, "69b49eed1234567890");

  const dlBundle = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/code/dialtone-earth/bundle", {
      headers: authHeader,
    }),
    env,
    deps,
  );
  assert.equal(dlBundle.status, 200);
  assert.equal(dlBundle.headers.get("X-Dialtone-Sha256"), expectedBundleSha);
  assert.deepEqual(new Uint8Array(await dlBundle.arrayBuffer()), bundleBytes);

  // 3. Tag release + upload binary asset + verify installer-compatible /releases/<repo>/download/<tag>/<asset> & .sha256
  const relResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone-earth/v0.6.0", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ sha: "69b49eed1234567890", notes: "First Cloudflare-hosted release" }),
    }),
    env,
    deps,
  );
  assert.equal(relResp.status, 200);

  const binBytes = new TextEncoder().encode("ELF-synthetic-dialtone-earth-v0.6.0\n");
  const expectedBinSha = createHash("sha256").update(binBytes).digest("hex");
  const assetUp = await handleGatewayRequest(
    new Request(
      "https://dialtone.earth/api/releases/dialtone-earth/v0.6.0/assets/dialtone-earth-linux-amd64",
      { method: "PUT", headers: authHeader, body: binBytes },
    ),
    env,
    deps,
  );
  assert.equal(assetUp.status, 200);

  const binDl = await handleGatewayRequest(
    new Request(
      "https://dialtone.earth/releases/dialtone-earth/download/v0.6.0/dialtone-earth-linux-amd64",
    ),
    env,
    deps,
  );
  assert.equal(binDl.status, 200);
  assert.deepEqual(new Uint8Array(await binDl.arrayBuffer()), binBytes);

  const shaDl = await handleGatewayRequest(
    new Request(
      "https://dialtone.earth/releases/dialtone-earth/download/v0.6.0/dialtone-earth-linux-amd64.sha256",
    ),
    env,
    deps,
  );
  assert.equal(shaDl.status, 200);
  assert.equal(await shaDl.text(), `${expectedBinSha}  dialtone-earth-linux-amd64\n`);

  // 4. Publish public Dialtone plugin (dialtone-shell) and list it publicly
  const pubPlugin = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/plugins/dialtone-shell", {
      method: "PUT",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "0.5.5",
        description: "Persistent Iroh-backed remote shell plugin for Dialtone",
        protocols: ["dialtone/shell/1"],
        repo: "dialtone-shell",
        iroh_ticket: "blob-ticket:synthetic-dialtone-shell",
        blake3_hash: "ea062aef",
        blob_digest: "sha256:74c23f57",
        bytes: 455168,
      }),
    }),
    env,
    deps,
  );
  assert.equal(pubPlugin.status, 200);

  const pluginsResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/plugins"),
    env,
    deps,
  );
  assert.equal(pluginsResp.status, 200);
  const pluginsJson = await pluginsResp.json();
  assert.equal(pluginsJson.plugins.length, 1);
  assert.equal(pluginsJson.plugins[0].name, "dialtone-shell");
  assert.deepEqual(pluginsJson.plugins[0].protocols, ["dialtone/shell/1"]);
  assert.equal(pluginsJson.plugins[0].iroh_ticket, "blob-ticket:synthetic-dialtone-shell");

  // 5. Private host metal.dialtone.earth does not expose public write registry
  const privateResp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/code"),
    env,
    deps,
  );
  assert.equal(privateResp.status, 404);
});

test("dialtone release channels isolate test from latest and promote atomically for auto-update", async () => {
  const env = {
    DIALTONE_AUTH_TOKENS: createMemoryKv(),
    DIALTONE_REGISTRY: createMemoryR2(),
    LIVE_CONTROL_TOKEN: "test-owner-token-1234567890",
    OWNER_EMAIL: "timcash@gmail.com",
  };
  const deps = { nowSec: () => 1_795_450_000 };
  const ownerAuth = { Authorization: `Bearer ${env.LIVE_CONTROL_TOKEN}` };

  // Seed stable v0.5.5 on latest
  await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/v0.5.5", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ sha: "aaaa1111", notes: "stable" }),
    }),
    env,
    deps,
  );
  const manifest55 = JSON.stringify({ schema: "dialtone.release.v1", version: "0.5.5", assets: [] });
  await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/v0.5.5/assets/dialtone-release.json", {
      method: "PUT",
      headers: ownerAuth,
      body: manifest55,
    }),
    env,
    deps,
  );
  await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/v0.5.5/assets/dialtone-release.json.sig", {
      method: "PUT",
      headers: ownerAuth,
      body: "sig-055",
    }),
    env,
    deps,
  );
  const setLatest = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/channel/latest", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "v0.5.5" }),
    }),
    env,
    deps,
  );
  assert.equal(setLatest.status, 200);

  // Stage v0.5.6 ONLY on channel/test
  await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/v0.5.6", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ sha: "bbbb2222", notes: "test channel candidate" }),
    }),
    env,
    deps,
  );
  const manifest56 = JSON.stringify({ schema: "dialtone.release.v1", version: "0.5.6", assets: [] });
  await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/v0.5.6/assets/dialtone-release.json", {
      method: "PUT",
      headers: ownerAuth,
      body: manifest56,
    }),
    env,
    deps,
  );
  await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/v0.5.6/assets/dialtone-release.json.sig", {
      method: "PUT",
      headers: ownerAuth,
      body: "sig-056",
    }),
    env,
    deps,
  );
  await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/v0.5.6/assets/dialtone-windows-x86_64.exe", {
      method: "PUT",
      headers: ownerAuth,
      body: new TextEncoder().encode("MZ-dialtone-0.5.6"),
    }),
    env,
    deps,
  );
  const setTest = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/channel/test", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "v0.5.6" }),
    }),
    env,
    deps,
  );
  assert.equal(setTest.status, 200);

  // Before promotion: test channel sees v0.5.6, production latest STILL sees v0.5.5!
  const testManifestResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/releases/dialtone/channel/test/latest/download/dialtone-release.json"),
    env,
    deps,
  );
  assert.equal(testManifestResp.status, 200);
  assert.equal(testManifestResp.headers.get("X-Dialtone-Release-Tag"), "v0.5.6");
  assert.equal((await testManifestResp.json()).version, "0.5.6");

  const testBinResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/releases/dialtone/channel/test/download/v0.5.6/dialtone-windows-x86_64.exe"),
    env,
    deps,
  );
  assert.equal(testBinResp.status, 200);
  assert.equal(await testBinResp.text(), "MZ-dialtone-0.5.6");

  const prodBeforeResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/releases/dialtone/latest/download/dialtone-release.json"),
    env,
    deps,
  );
  assert.equal(prodBeforeResp.status, 200);
  assert.equal(prodBeforeResp.headers.get("X-Dialtone-Release-Tag"), "v0.5.5");
  assert.equal((await prodBeforeResp.json()).version, "0.5.5");

  // Unauthenticated promote is rejected with 401
  const anonPromote = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/channel/latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_channel: "test" }),
    }),
    env,
    deps,
  );
  assert.equal(anonPromote.status, 401);

  // Owner promotes test -> latest atomically
  const ownerPromote = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/releases/dialtone/channel/latest", {
      method: "POST",
      headers: { ...ownerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ from_channel: "test" }),
    }),
    env,
    deps,
  );
  assert.equal(ownerPromote.status, 200);

  // Production auto-updater feed now returns v0.5.6 + sig!
  const prodAfterResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/releases/dialtone/latest/download/dialtone-release.json"),
    env,
    deps,
  );
  assert.equal(prodAfterResp.status, 200);
  assert.equal(prodAfterResp.headers.get("X-Dialtone-Release-Tag"), "v0.5.6");
  assert.equal((await prodAfterResp.json()).version, "0.5.6");

  const prodSigResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/releases/dialtone/latest/download/dialtone-release.json.sig"),
    env,
    deps,
  );
  assert.equal(prodSigResp.status, 200);
  assert.equal(await prodSigResp.text(), "sig-056");
});
