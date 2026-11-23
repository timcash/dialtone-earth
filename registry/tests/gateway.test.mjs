import assert from "node:assert/strict";
import test from "node:test";
import {
  handleGatewayRequest,
  resolveAllowedUpstreamPath,
  verifyCloudflareAccessJwt,
} from "../worker/gateway.ts";
import { redactSecrets } from "../worker/redact.ts";

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
    async list(options = {}) {
      const prefix = options?.prefix ?? "";
      const keys = [];
      for (const name of store.keys()) {
        if (!prefix || name.startsWith(prefix)) {
          keys.push({ name });
        }
      }
      return { keys };
    },
  };
}

test("GET /login renders pure grayscale dialtone.earth form without Cloudflare/oakleon branding", async () => {
  const env = {
    SESSION_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      "metal.dialtone.earth": ["owner@example.test"],
    }),
  };
  const resp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/login"),
    env,
  );
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("Cache-Control"), "private, no-store");
  assert.equal(resp.headers.get("X-Frame-Options"), "DENY");
  assert.equal(resp.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(resp.headers.get("Content-Security-Policy")?.includes("script-src 'self'"));

  const html = await resp.text();
  assert.ok(html.includes("dialtone.earth"));
  assert.ok(html.includes('type="email"'));
  assert.ok(html.includes("Send sign-in link"));
  assert.ok(!/oakleon|cloudflareaccess/i.test(html));
  assert.ok(!/<script\b/i.test(html), "login page must not embed inline scripts");
});

test("magic-link end-to-end: request, scanner-safe GET verify, single-use POST verify, live session, and logout", async () => {
  const kv = createMemoryKv();
  const sentEmails = [];
  let originFetches = 0;
  let now = 1_800_000_000;

  const env = {
    DIALTONE_AUTH_TOKENS: kv,
    SESSION_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      "metal.dialtone.earth": ["owner@example.test"],
    }),
    MESH_ORIGINS_MAP: JSON.stringify({
      "metal.dialtone.earth": ["https://origin-metal.example.test"],
    }),
    MESH_ORIGIN_TOKEN: "secret-mesh-token",
  };

  const deps = {
    nowSec: () => now,
    sendEmail: async (payload) => {
      sentEmails.push(payload);
    },
    fetchImpl: async (url) => {
      originFetches += 1;
      return new Response(JSON.stringify({ ok: true, url: String(url) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  // Signed-out /api/session advertises /login and /auth/logout
  const signedOutSession = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/session"),
    env,
    deps,
  );
  const signedOutBody = await signedOutSession.json();
  assert.equal(signedOutBody.authenticated, false);
  assert.equal(signedOutBody.login_url, "/login");
  assert.equal(signedOutBody.logout_url, "/auth/logout");

  // Non-allowlisted email returns identical redirect and sends 0 emails
  const deniedReq = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=stranger%40example.test",
    }),
    env,
    deps,
  );
  assert.equal(deniedReq.status, 303);
  assert.equal(deniedReq.headers.get("Location"), "/login?sent=1");
  assert.equal(sentEmails.length, 0);

  // Allowlisted email sends 1 email with clickable /auth/verify?token=... link
  const allowedReq = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=OWNER%40example.test",
    }),
    env,
    deps,
  );
  assert.equal(allowedReq.status, 303);
  assert.equal(allowedReq.headers.get("Location"), "/login?sent=1");
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "owner@example.test");

  const linkMatch = sentEmails[0].text.match(
    /https:\/\/metal\.dialtone\.earth\/auth\/verify\?token=([^\s]+)/,
  );
  assert.ok(linkMatch, "email must include clickable magic link");
  const token = decodeURIComponent(linkMatch[1]);

  // Scanner-safe GET /auth/verify must NOT consume KV nonce
  const getVerify1 = await handleGatewayRequest(
    new Request(`https://metal.dialtone.earth/auth/verify?token=${encodeURIComponent(token)}`),
    env,
    deps,
  );
  assert.equal(getVerify1.status, 200);
  const verifyHtml = await getVerify1.text();
  assert.ok(verifyHtml.includes("owner@example.test"));
  assert.ok(verifyHtml.includes('action="/api/auth/verify"'));

  // Wrong hostname must reject the token without consuming it
  const wrongHostVerify = await handleGatewayRequest(
    new Request("https://other.dialtone.earth/api/auth/verify", {
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
  assert.equal(wrongHostVerify.status, 401);

  // Valid POST /api/auth/verify sets HttpOnly Secure SameSite=Lax session cookie
  const postVerify = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
    }),
    env,
    deps,
  );
  assert.equal(postVerify.status, 303);
  assert.equal(postVerify.headers.get("Location"), "/");
  const setCookie = postVerify.headers.get("Set-Cookie") ?? "";
  assert.ok(setCookie.startsWith("dialtone_session="));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("Secure"));
  assert.ok(setCookie.includes("SameSite=Lax"));
  const cookiePair = setCookie.split(";")[0];

  // Replaying the same magic link token MUST fail closed (single-use)
  const replay = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/auth/verify", {
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
  assert.equal(replay.status, 401);

  // Authenticated session cookie grants live /api/session and /api/mesh/state
  const liveSession = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/session", {
      headers: { Cookie: cookiePair },
    }),
    env,
    deps,
  );
  const liveSessionBody = await liveSession.json();
  assert.equal(liveSessionBody.authenticated, true);
  assert.equal(liveSessionBody.mode, "live");
  assert.equal(liveSessionBody.network, "metal");
  assert.equal(liveSessionBody.subject, "owner@example.test");
  assert.equal(liveSessionBody.gateway, "dialtone-magic-link");

  const liveMesh = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/mesh/state", {
      headers: { Cookie: cookiePair },
    }),
    env,
    deps,
  );
  assert.equal(liveMesh.status, 200);
  assert.equal(originFetches, 1);

  // Revoking email from allowlist invalidates existing session immediately
  const revokedMesh = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/mesh/state", {
      headers: { Cookie: cookiePair },
    }),
    { ...env, MAGIC_LINK_ALLOWLIST: JSON.stringify({ "metal.dialtone.earth": [] }) },
    deps,
  );
  assert.equal(revokedMesh.status, 401);
  assert.equal(originFetches, 1);

  // Expired session cookie is rejected
  now += 90_000;
  const expiredMesh = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/mesh/state", {
      headers: { Cookie: cookiePair },
    }),
    env,
    deps,
  );
  assert.equal(expiredMesh.status, 401);
  assert.equal(originFetches, 1);

  // Logout clears dialtone_session cookie
  const logout = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/auth/logout"),
    env,
    deps,
  );
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("Location"), "/");
  assert.ok((logout.headers.get("Set-Cookie") ?? "").includes("Max-Age=0"));
});

test("redactSecrets strips private keys, SSH keys, bearer/API tokens, passwords, and URL credentials", () => {
  const sample = [
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123secretbody\n-----END OPENSSH PRIVATE KEY-----",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyPayloadForTesting123456 qa@host",
    'curl -H "Authorization: Bearer super_secret_token_987654" https://admin:mySecretPass@api.example.test',
    "dialtone shell exec --password topsecret --token tok_live_abc123456789 --node legion",
    "export MESH_ORIGIN_TOKEN=deadbeef0123456789abcdef API_KEY=sk-proj-secret1234567890abcd",
    "ghp_1234567890abcdefghij1234567890",
  ].join("\n");

  const result = redactSecrets(sample);
  assert.ok(result.redactedCount >= 7);
  for (const leaked of [
    "abc123secretbody",
    "AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyPayloadForTesting123456",
    "super_secret_token_987654",
    "mySecretPass",
    "topsecret",
    "tok_live_abc123456789",
    "deadbeef0123456789abcdef",
    "sk-proj-secret1234567890abcd",
    "ghp_1234567890abcdefghij1234567890",
  ]) {
    assert.ok(!result.text.includes(leaked), `secret leaked after redaction: ${leaked}`);
  }
  assert.ok(result.text.includes("[REDACTED]"));
  assert.ok(result.text.includes("--node legion"), "non-secret flags must remain readable");
});

test("multi-location user presence and redacted dialtone-shell audit log per private network", async () => {
  const kv = createMemoryKv();
  const sentEmails = [];
  const now = 1_800_000_000;
  const env = {
    DIALTONE_AUTH_TOKENS: kv,
    SESSION_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      "metal.dialtone.earth": ["owner@example.test"],
    }),
    MESH_ORIGINS_MAP: JSON.stringify({
      "metal.dialtone.earth": ["https://origin-metal.example.test"],
    }),
  };
  const deps = {
    nowSec: () => now,
    sendEmail: async (payload) => {
      sentEmails.push(payload);
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/shell/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                name: "ops-shell",
                node: "legion",
                user: "owner@example.test",
                shell: "powershell",
                cwd: "C:\\Users\\timca",
                last_command:
                  'curl -H "Authorization: Bearer live_secret_bearer_999" --password my_pw_123 http://127.0.0.1:8788/api/mesh',
                last_output: "MESH_ORIGIN_TOKEN=0123456789abcdef0123456789abcdef ok",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ node: "legion", events: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };

  // Unauthenticated /api/mesh/users and /api/mesh/presence fail closed with 401
  const unauthUsers = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/mesh/users"),
    env,
    deps,
  );
  assert.equal(unauthUsers.status, 401);
  const unauthPresence = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/mesh/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ view: "host", node: "legion" }),
    }),
    env,
    deps,
  );
  assert.equal(unauthPresence.status, 401);

  // Mint 2 distinct sessions for the same user (simulating 2 different locations)
  const mintSession = async () => {
    await handleGatewayRequest(
      new Request("https://metal.dialtone.earth/api/auth/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=owner%40example.test",
      }),
      env,
      deps,
    );
    const email = sentEmails[sentEmails.length - 1];
    const token = decodeURIComponent(
      email.text.match(/\/auth\/verify\?token=([^\s]+)/)[1],
    );
    const verify = await handleGatewayRequest(
      new Request("https://metal.dialtone.earth/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }),
      env,
      deps,
    );
    return (verify.headers.get("Set-Cookie") ?? "").split(";")[0];
  };

  const cookieSeattle = await mintSession();
  const cookieTokyo = await mintSession();

  const makeGeoReq = (url, init, cf) => {
    const req = new Request(url, init);
    Object.defineProperty(req, "cf", { value: cf });
    return req;
  };

  await handleGatewayRequest(
    makeGeoReq(
      "https://metal.dialtone.earth/api/mesh/presence",
      {
        method: "POST",
        headers: { Cookie: cookieSeattle, "Content-Type": "application/json" },
        body: JSON.stringify({ view: "host", node: "legion" }),
      },
      { city: "Seattle", regionCode: "WA", country: "US", colo: "SEA" },
    ),
    env,
    deps,
  );
  await handleGatewayRequest(
    makeGeoReq(
      "https://metal.dialtone.earth/api/mesh/presence",
      {
        method: "POST",
        headers: { Cookie: cookieTokyo, "Content-Type": "application/json" },
        body: JSON.stringify({ view: "host", node: "vm-02" }),
      },
      { city: "Tokyo", regionCode: "13", country: "JP", colo: "NRT" },
    ),
    env,
    deps,
  );

  // GET /api/mesh/users aggregates BOTH locations under owner@example.test and redacts shell secrets
  const usersResp = await handleGatewayRequest(
    makeGeoReq(
      "https://metal.dialtone.earth/api/mesh/users",
      { headers: { Cookie: cookieSeattle } },
      { city: "Seattle", regionCode: "WA", country: "US", colo: "SEA" },
    ),
    env,
    deps,
  );
  assert.equal(usersResp.status, 200);
  const usersBody = await usersResp.json();
  assert.equal(usersBody.redaction_policy, "keys-and-passwords-redacted");
  assert.equal(usersBody.users.length, 1);
  assert.equal(usersBody.users[0].email, "owner@example.test");
  assert.equal(usersBody.users[0].locations.length, 2);
  const locLabels = usersBody.users[0].locations.map((l) => l.location).sort();
  assert.deepEqual(locLabels, ["Seattle, WA, US (SEA)", "Tokyo, 13, JP (NRT)"]);
  const viewedNodes = usersBody.users[0].locations.map((l) => l.viewingNode).sort();
  assert.deepEqual(viewedNodes, ["legion", "vm-02"]);
  assert.deepEqual(usersBody.users[0].shellNodes, ["legion"]);

  // Verify raw secrets were scrubbed server-side
  const serialized = JSON.stringify(usersBody.shell_audit_log);
  assert.ok(!serialized.includes("live_secret_bearer_999"));
  assert.ok(!serialized.includes("my_pw_123"));
  assert.ok(!serialized.includes("0123456789abcdef0123456789abcdef"));
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(usersBody.shell_audit_log[0].redactedCount >= 3);

  // Also verify /api/mesh/shell/sessions redacts secrets directly
  const directSessions = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/mesh/shell/sessions", {
      headers: { Cookie: cookieSeattle },
    }),
    env,
    deps,
  );
  const directText = await directSessions.text();
  assert.ok(!directText.includes("live_secret_bearer_999"));
  assert.ok(directText.includes("[REDACTED]"));

  // Logging out the Tokyo session removes ONLY that location
  await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/auth/logout", {
      headers: { Cookie: cookieTokyo },
    }),
    env,
    deps,
  );
  const afterLogoutResp = await handleGatewayRequest(
    makeGeoReq(
      "https://metal.dialtone.earth/api/mesh/users",
      { headers: { Cookie: cookieSeattle } },
      { city: "Seattle", regionCode: "WA", country: "US", colo: "SEA" },
    ),
    env,
    deps,
  );
  const afterLogoutBody = await afterLogoutResp.json();
  assert.equal(afterLogoutBody.users[0].locations.length, 1);
  assert.equal(afterLogoutBody.users[0].locations[0].location, "Seattle, WA, US (SEA)");
});

test("MAGIC_LINK_DELIVERY_MAP routes test@dialtone.earth to verified mailbox while preserving test@dialtone.earth identity", async () => {
  const kv = createMemoryKv();
  const sentEmails = [];
  const env = {
    DIALTONE_AUTH_TOKENS: kv,
    SESSION_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      "metal.dialtone.earth": ["test@dialtone.earth"],
    }),
    MAGIC_LINK_DELIVERY_MAP: JSON.stringify({
      "test@dialtone.earth": "verified-qa-inbox@example.test",
    }),
    MESH_ORIGINS_MAP: JSON.stringify({
      "metal.dialtone.earth": ["https://origin-metal.example.test"],
    }),
  };
  const deps = {
    nowSec: () => 1_800_000_000,
    sendEmail: async (payload) => {
      sentEmails.push(payload);
    },
  };

  const reqResp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=test%40dialtone.earth",
    }),
    env,
    deps,
  );
  assert.equal(reqResp.status, 303);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "verified-qa-inbox@example.test");
  assert.ok(sentEmails[0].subject.includes("test@dialtone.earth"));

  const token = decodeURIComponent(
    sentEmails[0].text.match(/\/auth\/verify\?token=([^\s]+)/)[1],
  );
  const verifyResp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
    }),
    env,
    deps,
  );
  assert.equal(verifyResp.status, 303);
  const cookie = (verifyResp.headers.get("Set-Cookie") ?? "").split(";")[0];

  const sessionResp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/session", {
      headers: { Cookie: cookie },
    }),
    env,
    deps,
  );
  const sessionBody = await sessionResp.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.subject, "test@dialtone.earth");
});

test("public /api/live supports Bearer-authenticated PATCH/DELETE on dialtone.earth only", async () => {
  const store = new Map();
  const kv = {
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
  const env = {
    DIALTONE_AUTH_TOKENS: kv,
    LIVE_CONTROL_TOKEN: "secret-live-control-token-123",
  };
  const deps = { nowSec: () => 1_795_420_000 };

  // Private mesh host is strictly excluded from public /api/live
  const privateResp = await handleGatewayRequest(
    new Request("https://metal.dialtone.earth/api/live"),
    env,
    deps,
  );
  assert.equal(privateResp.status, 404);

  // Public GET returns default revision 0
  const getInitial = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live"),
    env,
    deps,
  );
  assert.equal(getInitial.status, 200);
  assert.equal(getInitial.headers.get("Cache-Control"), "no-store");
  assert.equal(getInitial.headers.get("X-Frame-Options"), "DENY");
  const initialBody = await getInitial.json();
  assert.equal(initialBody.revision, 0);
  assert.equal(initialBody.banner, null);

  // Unauthenticated or wrong-token PATCH -> 401
  const unauthPatch = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ banner: "hack" }),
    }),
    env,
    deps,
  );
  assert.equal(unauthPatch.status, 401);

  const wrongTokenPatch = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ banner: "hack" }),
    }),
    env,
    deps,
  );
  assert.equal(wrongTokenPatch.status, 401);

  // Valid Bearer PATCH updates live state & increments revision
  const patchResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-live-control-token-123",
      },
      body: JSON.stringify({
        banner: "Live update from dialtone-earth CLI",
        headline: "LIVE DEMO",
        theme: "light",
        network: "sim-orbit",
        view: "network",
        tour_playing: false,
      }),
    }),
    env,
    deps,
  );
  assert.equal(patchResp.status, 200);
  const patched = await patchResp.json();
  assert.equal(patched.ok, true);
  assert.equal(patched.state.revision, 1);
  assert.equal(patched.state.banner, "Live update from dialtone-earth CLI");
  assert.equal(patched.state.theme, "light");
  assert.equal(patched.state.network, "sim-orbit");
  assert.equal(patched.state.view, "network");
  assert.equal(patched.state.tour_playing, false);

  // Subsequent public GET sees the live mutation and returns ETag for 304 polls
  const getAfter = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live"),
    env,
    deps,
  );
  const etag = getAfter.headers.get("ETag");
  assert.equal(etag, '"live-rev-1"');
  const afterBody = await getAfter.json();
  assert.equal(afterBody.revision, 1);
  assert.equal(afterBody.headline, "LIVE DEMO");

  // Conditional GET with matching ETag returns zero-body 304 Not Modified
  const notModified = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live", {
      headers: { "If-None-Match": etag },
    }),
    env,
    deps,
  );
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), "");

  // Authenticated DELETE resets fields & increments revision so browsers revert live
  const delResp = await handleGatewayRequest(
    new Request("https://dialtone.earth/api/live", {
      method: "DELETE",
      headers: { Authorization: "Bearer secret-live-control-token-123" },
    }),
    env,
    deps,
  );
  assert.equal(delResp.status, 200);
  const deleted = await delResp.json();
  assert.equal(deleted.state.revision, 2);
  assert.equal(deleted.state.banner, null);
  assert.equal(deleted.state.theme, null);
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
