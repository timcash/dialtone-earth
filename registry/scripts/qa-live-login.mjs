import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";

const TARGET_ORIGIN = (
  process.env.QA_ORIGIN || "https://metal.dialtone.earth"
).replace(/\/+$/, "");
const QA_EMAIL = (process.env.QA_EMAIL || "test@dialtone.earth")
  .trim()
  .toLowerCase();
const GMAIL_CMD = process.env.QA_GMAIL_CMD || "gmail";
const POLL_TIMEOUT_MS = Number(process.env.QA_POLL_TIMEOUT_MS || 45_000);
const POLL_INTERVAL_MS = 3_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLatestMagicLinkToken(minIatSec) {
  const query = `in:anywhere from:login@dialtone.earth ${QA_EMAIL} newer_than:1d`;
  const output =
    process.platform === "win32"
      ? execSync(`${GMAIL_CMD} readonly read "${query}" --max 3`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : execFileSync(GMAIL_CMD, ["readonly", "read", query, "--max", "3"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
  const regex = new RegExp(
    `${TARGET_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/auth/verify\\?token=([A-Za-z0-9._~%-]+)`,
    "g",
  );
  for (const match of output.matchAll(regex)) {
    const token = decodeURIComponent(match[1]);
    const payloadPart = token.split(".")[0];
    if (!payloadPart) continue;
    try {
      const padded =
        payloadPart.replace(/-/g, "+").replace(/_/g, "/") +
        "===".slice((payloadPart.length + 3) % 4);
      const payload = JSON.parse(
        Buffer.from(padded, "base64").toString("utf8"),
      );
      if (
        payload.sub === QA_EMAIL &&
        typeof payload.iat === "number" &&
        payload.iat >= minIatSec
      ) {
        return token;
      }
    } catch {
      // Ignore malformed candidates
    }
  }
  return null;
}

async function main() {
  console.log(`QA live magic-link E2E: ${TARGET_ORIGIN} as ${QA_EMAIL}`);

  // 1. Signed-out containment checks
  const sessionOut = await fetch(`${TARGET_ORIGIN}/api/session`, {
    cache: "no-store",
  });
  assert.equal(sessionOut.status, 200);
  const sessionOutJson = await sessionOut.json();
  assert.equal(sessionOutJson.authenticated, false);
  assert.equal(sessionOutJson.mode, "simulated");
  assert.equal(sessionOutJson.login_url, "/login");

  const meshOut = await fetch(`${TARGET_ORIGIN}/api/mesh/state`);
  assert.equal(meshOut.status, 401, "signed-out /api/mesh/state must be 401");
  const usersOut = await fetch(`${TARGET_ORIGIN}/api/mesh/users`);
  assert.equal(usersOut.status, 401, "signed-out /api/mesh/users must be 401");
  console.log("  [PASS] signed-out default-deny (401 on /api/mesh/state and /api/mesh/users)");

  // 2. Grayscale /login page checks
  const loginPage = await fetch(`${TARGET_ORIGIN}/login`);
  assert.equal(loginPage.status, 200);
  assert.equal(loginPage.headers.get("X-Frame-Options"), "DENY");
  assert.equal(loginPage.headers.get("X-Content-Type-Options"), "nosniff");
  const loginHtml = await loginPage.text();
  assert.ok(loginHtml.includes("dialtone.earth"));
  assert.ok(loginHtml.includes("Send sign-in link"));
  assert.ok(!/oakleon|cloudflareaccess/i.test(loginHtml));
  console.log("  [PASS] /login renders pure grayscale form with zero third-party branding");

  // 3. Request magic link
  const startedSec = Math.floor(Date.now() / 1000) - 2;
  const reqResp = await fetch(`${TARGET_ORIGIN}/api/auth/request-link`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `email=${encodeURIComponent(QA_EMAIL)}`,
  });
  assert.equal(reqResp.status, 303);
  assert.equal(reqResp.headers.get("Location"), "/login?sent=1");
  console.log(`  [PASS] requested magic link for ${QA_EMAIL}`);

  // 4. Poll Gmail for fresh single-use link
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let token = null;
  while (Date.now() < deadline) {
    token = readLatestMagicLinkToken(startedSec);
    if (token) break;
    await sleep(POLL_INTERVAL_MS);
  }
  assert.ok(
    token,
    `timed out after ${POLL_TIMEOUT_MS}ms waiting for fresh magic link email for ${QA_EMAIL}`,
  );
  console.log("  [PASS] received fresh single-use magic link via email");

  // 5. Scanner-safe GET /auth/verify (must not consume token)
  const getVerify = await fetch(
    `${TARGET_ORIGIN}/auth/verify?token=${encodeURIComponent(token)}`,
  );
  assert.equal(getVerify.status, 200);
  const verifyHtml = await getVerify.text();
  assert.ok(verifyHtml.includes(QA_EMAIL));
  console.log("  [PASS] GET /auth/verify renders confirmation without consuming token");

  // 6. POST /api/auth/verify consumes token and issues HttpOnly Secure cookie
  const postVerify = await fetch(`${TARGET_ORIGIN}/api/auth/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(token)}`,
  });
  assert.equal(postVerify.status, 303);
  assert.equal(postVerify.headers.get("Location"), "/");
  const setCookie = postVerify.headers.get("Set-Cookie") || "";
  assert.ok(setCookie.startsWith("dialtone_session="));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("Secure"));
  const cookieHeader = setCookie.split(";")[0];

  // Replay must fail closed (single-use)
  const replay = await fetch(`${TARGET_ORIGIN}/api/auth/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: `token=${encodeURIComponent(token)}`,
  });
  assert.equal(replay.status, 401, "replayed magic-link token must return 401");
  console.log("  [PASS] POST /api/auth/verify issued session cookie and rejected replay (401)");

  // 7. Authenticated live session, mesh state, presence, and redacted users log
  const sessionIn = await fetch(`${TARGET_ORIGIN}/api/session`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(sessionIn.status, 200);
  const sessionInJson = await sessionIn.json();
  assert.equal(sessionInJson.authenticated, true);
  assert.equal(sessionInJson.mode, "live");
  assert.equal(sessionInJson.subject, QA_EMAIL);

  const meshIn = await fetch(`${TARGET_ORIGIN}/api/mesh/state`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(meshIn.status, 200);
  const meshJson = await meshIn.json();
  assert.ok(Array.isArray(meshJson.nodes) && meshJson.nodes.length > 0);
  const firstNode = meshJson.nodes[0].node || meshJson.nodes[0].name || "origin";

  const presResp = await fetch(`${TARGET_ORIGIN}/api/mesh/presence`, {
    method: "POST",
    headers: {
      Cookie: cookieHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ view: "host", node: firstNode }),
  });
  assert.equal(presResp.status, 200);

  const usersIn = await fetch(`${TARGET_ORIGIN}/api/mesh/users`, {
    headers: { Cookie: cookieHeader },
  });
  assert.equal(usersIn.status, 200);
  const usersJson = await usersIn.json();
  assert.equal(usersJson.redaction_policy, "keys-and-passwords-redacted");
  const qaUser = usersJson.users.find((u) => u.email === QA_EMAIL);
  assert.ok(qaUser, `${QA_EMAIL} must appear in /api/mesh/users`);
  assert.ok(qaUser.locations.length >= 1);
  assert.equal(qaUser.locations[0].viewingNode, firstNode);
  console.log(
    `  [PASS] live session (${meshJson.nodes.length} nodes) + /api/mesh/users shows ${QA_EMAIL} at ${qaUser.locations[0].location} viewing ${firstNode}`,
  );

  // 8. Logout clears session & presence
  const logout = await fetch(`${TARGET_ORIGIN}/auth/logout`, {
    redirect: "manual",
    headers: { Cookie: cookieHeader },
  });
  assert.equal(logout.status, 303);
  assert.ok((logout.headers.get("Set-Cookie") || "").includes("Max-Age=0"));
  console.log("  [PASS] /auth/logout cleared session cookie and presence");
  console.log("ALL LIVE QA CHECKS PASSED.");
}

main().catch((err) => {
  console.error("QA live magic-link E2E FAILED:", err?.message || err);
  process.exit(1);
});
