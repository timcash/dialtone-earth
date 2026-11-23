import assert from "node:assert/strict";
import test from "node:test";
import {
  handleGatewayRequest,
  resolveAllowedUpstreamPath,
  verifyCloudflareAccessJwt,
} from "../worker/gateway.ts";

test("unauthenticated /api/session returns simulated mode with zero origin fetches", async () => {
  let fetchCalls = 0;
  const response = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/session"),
    {
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUD_MAP: JSON.stringify({ "atlas.dialtone.earth": "aud-atlas" }),
      MESH_ORIGINS_MAP: JSON.stringify({
        "atlas.dialtone.earth": ["https://origin-a.example.test"],
      }),
    },
    {
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 0);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  const body = await response.json();
  assert.equal(body.authenticated, false);
  assert.equal(body.mode, "simulated");
  assert.equal(body.network, null);
});

test("default-deny: unauthenticated, wrong-host, and non-GET /api/mesh/* perform zero origin fetches", async () => {
  let originFetches = 0;
  const env = {
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUD_MAP: JSON.stringify({ "atlas.dialtone.earth": "aud-atlas" }),
    MESH_ORIGINS_MAP: JSON.stringify({
      "atlas.dialtone.earth": ["https://origin-a.example.test"],
    }),
  };
  const deps = {
    fetchImpl: async () => {
      originFetches += 1;
      return new Response("{}", { status: 200 });
    },
    verifyJwt: async () => ({ valid: false, reason: "wrong_audience" }),
  };

  // Unauthenticated GET -> 401
  const unauth = await handleGatewayRequest(
    new Request("https://atlas.dialtone.earth/api/mesh/state"),
    env,
    deps,
  );
  assert.equal(unauth.status, 401);

  // Wrong audience -> 401
  const wrongAud = await handleGatewayRequest(
    new Request("https://atlas.dialtone.earth/api/mesh/plugins", {
      headers: { "Cf-Access-Jwt-Assertion": "fake.jwt.token" },
    }),
    env,
    deps,
  );
  assert.equal(wrongAud.status, 401);

  // Unenrolled hostname -> 401
  const unknownHost = await handleGatewayRequest(
    new Request("https://other.dialtone.earth/api/mesh/state", {
      headers: { "Cf-Access-Jwt-Assertion": "fake.jwt.token" },
    }),
    env,
    deps,
  );
  assert.equal(unknownHost.status, 401);

  // Mutation method blocked -> 405
  const postResp = await handleGatewayRequest(
    new Request("https://atlas.dialtone.earth/api/mesh/state", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "fake.jwt.token" },
    }),
    env,
    deps,
  );
  assert.equal(postResp.status, 405);

  // Path traversal on test-runs -> 404
  const badLog = await handleGatewayRequest(
    new Request("https://atlas.dialtone.earth/api/mesh/test-runs/..%2Fsecret"),
    env,
    deps,
  );
  assert.equal(badLog.status, 404);

  assert.equal(originFetches, 0, "denied requests must perform zero origin fetches");
});

test("verified Cloudflare Access JWT fails over from dead origin A to enrolled origin B only", async () => {
  const contacted = [];
  const env = {
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUD_MAP: JSON.stringify({ "atlas.dialtone.earth": "aud-atlas" }),
    MESH_ORIGINS_MAP: JSON.stringify({
      "atlas.dialtone.earth": [
        "https://origin-a.example.test",
        "https://origin-b.example.test",
      ],
      "other.dialtone.earth": ["https://origin-c.example.test"],
    }),
    MESH_ORIGIN_TOKEN: "test-origin-bearer",
  };

  const response = await handleGatewayRequest(
    new Request("https://atlas.dialtone.earth/api/mesh/shell/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt.token" },
    }),
    env,
    {
      verifyJwt: async (_tok, aud, team) => {
        assert.equal(aud, "aud-atlas");
        assert.equal(team, "https://team.cloudflareaccess.com");
        return { valid: true, subject: "qa@example.test" };
      },
      fetchImpl: async (url, init) => {
        contacted.push({ url: String(url), auth: init?.headers?.get?.("Authorization") ?? new Headers(init?.headers).get("Authorization") });
        if (String(url).startsWith("https://origin-a.example.test")) {
          return new Response("origin down", { status: 503 });
        }
        return new Response(JSON.stringify({ sessions: [{ name: "ci-runner" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(
    contacted.map((c) => c.url),
    [
      "https://origin-a.example.test/api/shell/sessions",
      "https://origin-b.example.test/api/shell/sessions",
    ],
  );
  assert.equal(contacted[1].auth, "Bearer test-origin-bearer");
  const payload = await response.json();
  assert.equal(payload.sessions[0].name, "ci-runner");
});

test("real Web Crypto RS256 Access JWT verification accepts valid token and rejects wrong audience or expiry", async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwksFetch = async (_url, init) => {
    assert.equal(init?.redirect, "manual", "workerd only supports manual/follow redirect modes");
    return new Response(
      JSON.stringify({ keys: [{ ...publicJwk, kid: "test-kid-1" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const now = Math.floor(Date.now() / 1000);
  const goodJwt = await signJwt(
    keyPair.privateKey,
    { alg: "RS256", kid: "test-kid-1" },
    {
      iss: "https://team.cloudflareaccess.com",
      aud: ["aud-atlas"],
      exp: now + 300,
      email: "qa@example.test",
    },
  );
  const goodRes = await verifyCloudflareAccessJwt(
    goodJwt,
    "aud-atlas",
    "https://team.cloudflareaccess.com",
    jwksFetch,
  );
  assert.equal(goodRes.valid, true);
  assert.equal(goodRes.subject, "qa@example.test");

  const wrongAudRes = await verifyCloudflareAccessJwt(
    goodJwt,
    "aud-other",
    "https://team.cloudflareaccess.com",
    jwksFetch,
  );
  assert.equal(wrongAudRes.valid, false);
  assert.equal(wrongAudRes.reason, "wrong_audience");

  const expiredJwt = await signJwt(
    keyPair.privateKey,
    { alg: "RS256", kid: "test-kid-1" },
    {
      iss: "https://team.cloudflareaccess.com",
      aud: ["aud-atlas"],
      exp: now - 10,
      email: "qa@example.test",
    },
  );
  const expiredRes = await verifyCloudflareAccessJwt(
    expiredJwt,
    "aud-atlas",
    "https://team.cloudflareaccess.com",
    jwksFetch,
  );
  assert.equal(expiredRes.valid, false);
  assert.equal(expiredRes.reason, "expired");
});

test("resolveAllowedUpstreamPath maps Dialtone v0.5.5 read routes and rejects arbitrary paths", () => {
  assert.equal(resolveAllowedUpstreamPath("/api/mesh/state", ""), "/api/mesh");
  assert.equal(resolveAllowedUpstreamPath("/api/mesh/plugins", ""), "/api/plugins");
  assert.equal(resolveAllowedUpstreamPath("/api/mesh/blobs", ""), "/api/blob");
  assert.equal(
    resolveAllowedUpstreamPath("/api/mesh/test-runs/" + "a".repeat(32) + "/log", ""),
    "/api/test-runs/" + "a".repeat(32) + "/log",
  );
  assert.equal(resolveAllowedUpstreamPath("/api/mesh/exec", ""), null);
  assert.equal(resolveAllowedUpstreamPath("/api/mesh/restart", ""), null);
});

async function signJwt(privateKey, header, payload) {
  const enc = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const input = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input),
  );
  const sigB64 = Buffer.from(sig)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${input}.${sigB64}`;
}
