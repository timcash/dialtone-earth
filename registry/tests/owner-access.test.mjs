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

async function loginViaMagicLink(origin, email, env, nowSec) {
  const sentEmails = [];
  const deps = {
    nowSec: () => nowSec,
    sendEmail: async (payload) => {
      sentEmails.push(payload);
    },
  };

  const reqResp = await handleGatewayRequest(
    new Request(`${origin}/api/auth/request-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: `email=${encodeURIComponent(email)}`,
    }),
    env,
    deps,
  );
  assert.equal(reqResp.status, 200);

  if (sentEmails.length === 0) {
    return { sent: false, cookie: null, sentEmails };
  }

  const text = String(sentEmails[0].text || "");
  const match = text.match(/https?:\/\/[^/\s]+\/auth\/verify\?token=([A-Za-z0-9._~%-]+)/);
  assert.ok(match, `Magic link missing from email:\n${text}`);
  const token = decodeURIComponent(match[1]);

  const verifyResp = await handleGatewayRequest(
    new Request(`${origin}/api/auth/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: `token=${encodeURIComponent(token)}`,
    }),
    env,
    deps,
  );
  assert.equal(verifyResp.status, 200);
  const setCookie = verifyResp.headers.get("Set-Cookie") || "";
  const cookiePair = setCookie.split(";")[0];
  assert.ok(cookiePair.startsWith("dialtone_session="), `Expected dialtone_session cookie, got ${setCookie}`);
  return { sent: true, cookie: cookiePair, sentEmails };
}

test("only timcash@gmail.com can log into dialtone.earth, modify the site, and access the git repo", async () => {
  const nowSec = 1_795_490_000;
  const env = {
    DIALTONE_AUTH_TOKENS: createMemoryKv(),
    DIALTONE_REGISTRY: createMemoryR2(),
    SESSION_SIGNING_KEY: "super-secret-signing-key-for-owner-access-tests-256bit",
    LIVE_CONTROL_TOKEN: "owner-cli-bearer-secret-token-2026",
    OWNER_EMAIL: "timcash@gmail.com",
    MAGIC_LINK_FROM: "login@dialtone.earth",
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      "dialtone.earth": ["timcash@gmail.com"],
      "metal.dialtone.earth": ["timcash@gmail.com", "test@dialtone.earth"],
    }),
  };
  const deps = { nowSec: () => nowSec };

  // 1. Only timcash@gmail.com can receive a magic link on dialtone.earth
  const attackerLogin = await loginViaMagicLink("https://dialtone.earth", "attacker@evil.com", env, nowSec);
  assert.equal(attackerLogin.sent, false, "attacker@evil.com must NEVER receive a dialtone.earth magic link");

  const nonOwnerLogin = await loginViaMagicLink("https://dialtone.earth", "test@dialtone.earth", env, nowSec);
  assert.equal(nonOwnerLogin.sent, false, "test@dialtone.earth must NOT be allowed to log into apex dialtone.earth");

  const ownerLogin = await loginViaMagicLink("https://dialtone.earth", "timcash@gmail.com", env, nowSec);
  assert.equal(ownerLogin.sent, true, "timcash@gmail.com must receive a dialtone.earth magic link");
  assert.equal(ownerLogin.sentEmails[0].to, "timcash@gmail.com");
  const ownerCookie = { Cookie: ownerLogin.cookie };

  // Also mint a legitimate cross-host session on metal.dialtone.earth for both test@dialtone.earth and timcash@gmail.com
  const metalTestLogin = await loginViaMagicLink("https://metal.dialtone.earth", "test@dialtone.earth", env, nowSec);
  assert.equal(metalTestLogin.sent, true);
  const metalOwnerLogin = await loginViaMagicLink("https://metal.dialtone.earth", "timcash@gmail.com", env, nowSec);
  assert.equal(metalOwnerLogin.sent, true);

  // 2. Owner (timcash@gmail.com session cookie) can push git repo, upload archive, and modify dialtone.earth
  const bundlePayload = new TextEncoder().encode("# v2 git bundle\nprivate-timcash-repo\n");
  const pushOwner = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/code/dialtone-earth/push", {
      method: "PUT",
      headers: {
        ...ownerCookie,
        "X-Dialtone-Branch": "main",
        "X-Dialtone-Sha": "ba389355041234",
        "X-Dialtone-Subject": "owner-only git push",
      },
      body: bundlePayload,
    }),
    env,
    deps,
  );
  assert.equal(pushOwner.status, 200, "timcash@gmail.com must be able to push git repo");

  const archiveOwner = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/code/dialtone-earth/archive/main.tar.gz", {
      method: "PUT",
      headers: ownerCookie,
      body: new TextEncoder().encode("synthetic-tar-gz"),
    }),
    env,
    deps,
  );
  assert.equal(archiveOwner.status, 200);

  const liveOwner = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live", {
      method: "PATCH",
      headers: { ...ownerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ banner: "Verified owner edit by timcash@gmail.com" }),
    }),
    env,
    deps,
  );
  assert.equal(liveOwner.status, 200, "timcash@gmail.com must be able to modify dialtone.earth live");

  // 3. Anonymous, wrong-token, and cross-host sessions are ALL denied access to /api/code/* AND mutations
  const badCredentials = [
    { label: "anonymous", headers: {} },
    { label: "wrong bearer", headers: { Authorization: "Bearer stolen-wrong-token" } },
    { label: "forged cookie", headers: { Cookie: "dialtone_session=forged.signature" } },
    { label: "metal test@dialtone.earth cookie", headers: { Cookie: metalTestLogin.cookie } },
    { label: "metal timcash@gmail.com cross-host cookie", headers: { Cookie: metalOwnerLogin.cookie } },
  ];

  const protectedEndpoints = [
    { method: "GET", url: "https://dialtone.earth/api/code" },
    { method: "GET", url: "https://dialtone.earth/api/code/dialtone-earth" },
    { method: "GET", url: "https://dialtone.earth/api/code/dialtone-earth/bundle" },
    { method: "GET", url: "https://dialtone.earth/api/code/dialtone-earth/archive/main.tar.gz" },
    {
      method: "PUT",
      url: "https://dialtone.earth/api/code/dialtone-earth/push",
      extraHeaders: { "X-Dialtone-Sha": "deadbeef1234" },
      body: new Uint8Array([9, 9, 9]),
    },
    {
      method: "PATCH",
      url: "https://dialtone.earth/api/live",
      extraHeaders: { "Content-Type": "application/json" },
      body: JSON.stringify({ banner: "hacked" }),
    },
    {
      method: "POST",
      url: "https://dialtone.earth/api/releases/dialtone-earth/v9.9.9",
      extraHeaders: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: "deadbeef1234" }),
    },
    {
      method: "PUT",
      url: "https://dialtone.earth/api/plugins/malicious-plugin",
      extraHeaders: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "1.0.0" }),
    },
  ];

  for (const cred of badCredentials) {
    for (const ep of protectedEndpoints) {
      const resp = await handleGatewayRequest(
        new Request(ep.url, {
          method: ep.method,
          headers: { ...cred.headers, ...(ep.extraHeaders || {}) },
          body: ep.body,
        }),
        env,
        deps,
      );
      assert.equal(
        resp.status,
        401,
        `${cred.label} must get 401 on ${ep.method} ${ep.url} (got ${resp.status})`,
      );
    }
  }

  // 4. Even if another email were ever added to dialtone.earth's allowlist, OWNER_EMAIL still blocks them with 403!
  const widenedEnv = {
    ...env,
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      "dialtone.earth": ["timcash@gmail.com", "coworker@example.com"],
    }),
  };
  const coworkerLogin = await loginViaMagicLink(
    "https://dialtone.earth",
    "coworker@example.com",
    widenedEnv,
    nowSec + 10,
  );
  assert.equal(coworkerLogin.sent, true);

  for (const [method, endpoint] of [
    ["GET", "https://dialtone.earth/api/code"],
    ["GET", "https://dialtone.earth/api/code/dialtone-earth/bundle"],
    ["PATCH", "https://dialtone.earth/api/live"],
  ]) {
    const resp = await handleGatewayRequest(
      new Request(endpoint, {
        method,
        headers: {
          Cookie: coworkerLogin.cookie,
          ...(method === "PATCH" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "PATCH" ? JSON.stringify({ banner: "unauthorized" }) : undefined,
      }),
      widenedEnv,
      { nowSec: () => nowSec + 10 },
    );
    assert.equal(
      resp.status,
      403,
      `non-owner coworker@example.com must get 403 Forbidden on ${method} ${endpoint} (got ${resp.status})`,
    );
  }

  // 5. Owner (timcash@gmail.com session cookie) CAN read and download the private git repo
  const ownerCodeList = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/code", { headers: ownerCookie }),
    env,
    deps,
  );
  assert.equal(ownerCodeList.status, 200);
  const ownerCodeJson = await ownerCodeList.json();
  assert.equal(ownerCodeJson.repos[0].name, "dialtone-earth");

  const ownerBundle = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/code/dialtone-earth/bundle", { headers: ownerCookie }),
    env,
    deps,
  );
  assert.equal(ownerBundle.status, 200);
  assert.deepEqual(new Uint8Array(await ownerBundle.arrayBuffer()), bundlePayload);
});

test("test.dialtone.earth staging UI is strictly restricted to timcash@gmail.com and proxies only after owner auth", async () => {
  const nowSec = 1_795_495_000;
  let upstreamCalls = 0;
  const env = {
    DIALTONE_AUTH_TOKENS: createMemoryKv(),
    DIALTONE_REGISTRY: createMemoryR2(),
    SESSION_SIGNING_KEY: "super-secret-signing-key-for-staging-owner-tests-256bit",
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
    MAGIC_LINK_FROM: "login@dialtone.earth",
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      "test.dialtone.earth": ["timcash@gmail.com"],
    }),
  };

  const deps = {
    nowSec: () => nowSec,
    fetchImpl: async (url, init) => {
      upstreamCalls += 1;
      assert.ok(String(url).startsWith("https://staging-origin.example/__staging/"));
      assert.equal(init.headers.get("Authorization"), "Bearer staging-origin-secret-token-1234");
      assert.equal(init.headers.get("X-Dialtone-Staging-Owner"), "timcash@gmail.com");
      return new Response("<html>staging-dashboard-ok</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
    verifyJwt: async (jwt) => {
      if (jwt === "cf-jwt-timcash") return { valid: true, subject: "timcash@gmail.com" };
      if (jwt === "cf-jwt-intruder") return { valid: true, subject: "intruder@example.com" };
      return { valid: false, reason: "invalid_jwt" };
    },
  };

  // 1. Anonymous HTML -> 302 /login (0 upstream calls)
  const anonHtml = await handleGatewayRequest(new Request("https://test.dialtone.earth/"), env, deps);
  assert.equal(anonHtml.status, 302);
  assert.equal(anonHtml.headers.get("Location"), "/login");

  // 2. Anonymous API -> 401 (0 upstream calls)
  const anonApi = await handleGatewayRequest(new Request("https://test.dialtone.earth/api/tests"), env, deps);
  assert.equal(anonApi.status, 401);

  // 3. Cloudflare Access JWT for intruder@example.com -> 403 Forbidden (0 upstream calls)
  const intruderResp = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/", {
      headers: { "Cf-Access-Jwt-Assertion": "cf-jwt-intruder" },
    }),
    env,
    deps,
  );
  assert.equal(intruderResp.status, 403);
  assert.equal(upstreamCalls, 0);

  // 4. Cloudflare Access JWT for timcash@gmail.com -> 200 OK proxied staging UI!
  const ownerCfResp = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/", {
      headers: { "Cf-Access-Jwt-Assertion": "cf-jwt-timcash" },
    }),
    env,
    deps,
  );
  assert.equal(ownerCfResp.status, 200);
  assert.match(await ownerCfResp.text(), /staging-dashboard-ok/);
  assert.equal(upstreamCalls, 1);

  // 5. Magic-link login for timcash@gmail.com on test.dialtone.earth also unlocks staging UI, /code, and /logs
  const anonCodePage = await handleGatewayRequest(new Request("https://test.dialtone.earth/code"), env, deps);
  assert.equal(anonCodePage.status, 302);
  assert.equal(anonCodePage.headers.get("Location"), "/login");
  const anonLogsPage = await handleGatewayRequest(new Request("https://test.dialtone.earth/logs"), env, deps);
  assert.equal(anonLogsPage.status, 302);
  assert.equal(anonLogsPage.headers.get("Location"), "/login");
  const anonCodeApi = await handleGatewayRequest(new Request("https://test.dialtone.earth/api/code"), env, deps);
  assert.equal(anonCodeApi.status, 401);

  const ownerMagic = await loginViaMagicLink("https://test.dialtone.earth", "timcash@gmail.com", env, nowSec);
  assert.equal(ownerMagic.sent, true);
  const ownerCookieResp = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/", { headers: { Cookie: ownerMagic.cookie } }),
    env,
    deps,
  );
  assert.equal(ownerCookieResp.status, 200);
  assert.equal(upstreamCalls, 2);

  const ownerCodePage = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/code", { headers: { Cookie: ownerMagic.cookie } }),
    env,
    deps,
  );
  assert.equal(ownerCodePage.status, 200);
  assert.match(await ownerCodePage.text(), /DIALTONE \/\/ CODE/);

  const ownerCodeApi = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/api/code", { headers: { Cookie: ownerMagic.cookie } }),
    env,
    deps,
  );
  assert.equal(ownerCodeApi.status, 200);

  const ownerLogsPage = await handleGatewayRequest(
    new Request("https://test.dialtone.earth/logs", { headers: { Cookie: ownerMagic.cookie } }),
    env,
    deps,
  );
  assert.equal(ownerLogsPage.status, 200);
  assert.equal(upstreamCalls, 3);
});
