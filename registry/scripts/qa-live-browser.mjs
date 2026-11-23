import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CdpClient,
  DEFAULT_CDP_PORT,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_TARGET_ORIGIN,
  connectAppSession,
  findChromeBinary,
  findDialtoneBinary,
  tryReadLatestMagicLinkUrl,
  runDialtone,
  sleep,
} from "./cdp-session.mjs";

const RAW_ARGS = process.argv.slice(2);
const ARGS = new Set(RAW_ARGS);
function argValue(flagName) {
  const idx = RAW_ARGS.indexOf(flagName);
  return idx >= 0 && idx + 1 < RAW_ARGS.length ? RAW_ARGS[idx + 1] : null;
}

const STEP = argValue("--step") || process.env.QA_STEP || "all";
const DEMO = ARGS.has("--demo") || process.env.QA_DEMO === "1";
const REUSE_CDP =
  ARGS.has("--reuse") ||
  process.env.DIALTONE_CDP_REUSE === "1" ||
  STEP !== "all";
const HEADED =
  REUSE_CDP ||
  DEMO ||
  ARGS.has("--headed") ||
  process.env.QA_HEADED === "1" ||
  process.env.DIALTONE_BROWSER_HEADED === "1";
const OPEN_DEVTOOLS =
  ARGS.has("--devtools") || process.env.QA_DEVTOOLS === "1";
const KEEP_SIGNED_IN =
  ARGS.has("--keep-signed-in") || process.env.QA_KEEP_SIGNED_IN === "1";
const CDP_PORT = Number(argValue("--cdp-port") || process.env.DIALTONE_CDP_PORT || DEFAULT_CDP_PORT);
const DASHBOARD_URL = argValue("--dashboard") || process.env.DIALTONE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL;
const STEP_MS = Number(
  process.env.QA_STEP_MS ?? (DEMO ? 1_400 : HEADED ? 600 : 0),
);
const KEEP_OPEN_MS = Number(
  process.env.QA_KEEP_OPEN_MS ?? (DEMO ? 2_500 : HEADED ? 800 : 0),
);

const TARGET_ORIGIN = (
  argValue("--origin") || process.env.QA_ORIGIN || DEFAULT_TARGET_ORIGIN
).replace(/\/+$/, "");
const QA_EMAIL = (process.env.QA_EMAIL || "test@dialtone.earth")
  .trim()
  .toLowerCase();
const POLL_TIMEOUT_MS = Number(process.env.QA_POLL_TIMEOUT_MS || 45_000);
const SAVE_SCREENSHOTS = process.env.QA_SCREENSHOTS !== "0";
const SCREENSHOT_DIR = resolve(
  process.env.QA_SCREENSHOT_DIR || join(process.cwd(), "..", "logs", "live-demo-frames"),
);

async function openBrowser() {
  if (REUSE_CDP) {
    const session = await connectAppSession({
      port: CDP_PORT,
      targetOrigin: TARGET_ORIGIN,
      dashboardUrl: DASHBOARD_URL,
      headless: !HEADED,
      stepMs: STEP_MS,
      saveScreenshots: SAVE_SCREENSHOTS,
      screenshotDir: SCREENSHOT_DIR,
    });
    return {
      cdp: session.cdp,
      wsPort: session.port,
      reused: session.reused,
      cleanup() {
        // Persistent mode: only disconnect the CDP WebSocket so Chrome stays open!
        session.cdp.disconnect();
      },
    };
  }

  // Legacy ephemeral Chrome launch (standalone headless CI)
  const bin = findChromeBinary();
  const profileDir = mkdtempSync(join(tmpdir(), "dialtone-earth-cdp-"));
  const flags = [
    ...(HEADED ? ["--new-window", "--window-position=60,30"] : ["--headless=new", "--disable-gpu"]),
    ...(HEADED && OPEN_DEVTOOLS ? ["--auto-open-devtools-for-tabs"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,980",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  const proc = spawn(bin, flags, { stdio: ["ignore", "pipe", "pipe"] });

  let stderrBuf = "";
  const wsPort = await new Promise((resolveFn, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Chrome DevTools did not start within 10s:\n${stderrBuf}`));
    }, 10_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      const m = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolveFn(Number(m[1]));
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early with code ${code}:\n${stderrBuf}`));
    });
  });

  const targetsResp = await fetch(`http://127.0.0.1:${wsPort}/json/list`);
  const targets = await targetsResp.json();
  const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  assert.ok(pageTarget, "No CDP page target found");

  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl, {
    targetOrigin: TARGET_ORIGIN,
    headed: HEADED,
    stepMs: STEP_MS,
    saveScreenshots: SAVE_SCREENSHOTS,
    screenshotDir: SCREENSHOT_DIR,
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  if (HEADED) {
    await cdp.send("Page.bringToFront");
  }
  return {
    cdp,
    wsPort,
    reused: false,
    cleanup() {
      cdp.disconnect();
      try {
        proc.kill();
      } catch {
        // ignore
      }
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // ignore brief Windows lock
      }
    },
  };
}

async function isSignedInLive(cdp) {
  try {
    return await cdp.eval(`(() => {
      if (!location.href.startsWith(${JSON.stringify(TARGET_ORIGIN)})) return false;
      const t = document.body?.innerText || "";
      return location.pathname === "/" &&
        t.includes("LIVE") &&
        t.includes("metal") &&
        document.querySelector('[href="/auth/logout"]') !== null;
    })()`);
  } catch {
    return false;
  }
}

async function dismissOverlays(cdp) {
  // If a prior run left Config or Camera Studio open, close it cleanly.
  try {
    await cdp.eval(`(() => {
      const cfgDone = document.querySelector('[data-testid="config-done"]');
      if (cfgDone) cfgDone.click();
      const camDone = document.querySelector('[data-testid="camera-done"]');
      if (camDone) camDone.click();
      return true;
    })()`);
  } catch {
    // ignore
  }
}

async function performMagicLinkLogin(cdp) {
  await cdp.showBanner(`02 Magic-link sign-in for ${QA_EMAIL}`);
  const onTarget = await cdp.eval(`location.href.startsWith(${JSON.stringify(TARGET_ORIGIN)})`);
  if (!onTarget) {
    await cdp.send("Page.navigate", { url: `${TARGET_ORIGIN}/` });
  }
  await cdp.waitFor(
    "sign-in link on landing page",
    `document.querySelector('[href="/login"]') !== null || location.pathname === "/login"`,
  );
  const alreadyAtLogin = await cdp.eval(`location.pathname === "/login"`);
  if (!alreadyAtLogin) {
    await cdp.click('[href="/login"]', "sign in link");
  }
  await cdp.waitFor(
    "grayscale login email input",
    `location.pathname === "/login" && document.querySelector('input[name="email"]') !== null`,
  );
  await sleep(1_100);
  const requestStartedSec = Math.floor(Date.now() / 1000);
  await cdp.typeInto('input[name="email"]', QA_EMAIL);
  await cdp.captureFrame("02-grayscale-login");
  await sleep(Math.min(350, STEP_MS));
  await cdp.click('button[type="submit"]', "Send sign-in link button");
  await cdp.waitFor(
    "magic-link sent confirmation",
    `location.search.includes("sent=1") && document.body.innerText.toLowerCase().includes("check your email")`,
  );
  await cdp.showBanner("02 Waiting for single-use magic-link email...");

  let verifyUrl = null;
  let manualAuthWarned = false;
  let lastAuthError = "";
  let deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isSignedInLive(cdp)) {
      await cdp.captureFrame("02-live-metal-hydrated");
      return;
    }
    const mailRes = tryReadLatestMagicLinkUrl(requestStartedSec, {
      targetOrigin: TARGET_ORIGIN,
      qaEmail: QA_EMAIL,
    });
    if (mailRes.url) {
      verifyUrl = mailRes.url;
      break;
    }
    if (mailRes.authError && !manualAuthWarned) {
      manualAuthWarned = true;
      lastAuthError = mailRes.authError;
      // Give the user up to 2 minutes to click the magic link in email when gmail CLI is unauthenticated locally.
      deadline = Math.max(deadline, Date.now() + 120_000);
      console.log(
        `  [INFO] gmail CLI unavailable in this shell (${mailRes.authError.split(/\r?\n/)[0]}). Waiting for manual sign-in in Chrome (or run 'gmail auth login' for automatic magic-link reading)...`,
      );
      await cdp.showBanner(
        `02 Click magic-link email for ${QA_EMAIL} (or run 'gmail auth login')`,
      );
    }
    await sleep(2_500);
  }
  if (!verifyUrl) {
    if (await isSignedInLive(cdp)) {
      await cdp.captureFrame("02-live-metal-hydrated");
      return;
    }
    throw new Error(
      `Timed out waiting for magic-link sign-in for ${QA_EMAIL}${lastAuthError ? ` (gmail CLI: ${lastAuthError.split(/\r?\n/)[0]})` : ""}`,
    );
  }

  const verifyToken = new URL(verifyUrl).searchParams.get("token") || "";
  await cdp.send("Page.navigate", { url: verifyUrl });
  await cdp.waitFor(
    "verify confirmation form",
    `document.querySelector('form button[type="submit"]') !== null && document.body.innerText.includes(${JSON.stringify(QA_EMAIL)})`,
  );
  await cdp.showBanner("02 Confirming single-use magic link & testing replay 401");
  await sleep(Math.min(500, STEP_MS));
  await cdp.click('form button[type="submit"]', "Continue sign-in button");

  await cdp.waitFor(
    "authenticated LIVE metal mode with real nodes",
    `location.pathname === "/" && document.body.innerText.includes("LIVE") && document.body.innerText.includes("metal") && document.querySelector('[href="/auth/logout"]') !== null && (document.body.innerText.includes("legion") || document.body.innerText.includes("vm-us") || document.body.innerText.includes("vm-eu"))`,
    20_000,
  );
  const replayResp = await fetch(`${TARGET_ORIGIN}/api/auth/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: `token=${encodeURIComponent(verifyToken)}`,
  });
  assert.equal(replayResp.status, 401, "replayed single-use magic link must return 401");
  const liveDomText = await cdp.eval(`document.body.innerText`);
  assert.ok(!liveDomText.includes("sim-atlas"), "simulated network still visible after live login");
  await cdp.captureFrame("02-live-metal-hydrated");
}

async function ensureSignedIn(cdp, allowLogin = false) {
  await dismissOverlays(cdp);
  if (await isSignedInLive(cdp)) {
    return true;
  }
  // If we're on another tab/url, try navigating to TARGET_ORIGIN first (cookie may already exist in persistent profile!)
  await cdp.send("Page.navigate", { url: `${TARGET_ORIGIN}/` });
  await cdp.waitFor(
    "landing page ready",
    `document.querySelector('[href="/auth/logout"]') !== null || document.querySelector('[href="/login"]') !== null`,
    15_000,
  );
  if (await isSignedInLive(cdp)) {
    return true;
  }
  if (!allowLogin) {
    throw new Error(
      "Persistent Chrome is signed out — run TestBrowser02MagicLinkLogin (or sign in once in Chrome) before running this step",
    );
  }
  await performMagicLinkLogin(cdp);
  return false;
}

function assertNoBrowserErrors(cdp) {
  assert.equal(
    cdp.exceptions.length,
    0,
    `Uncaught browser runtime exceptions:\n${cdp.exceptions.join("\n")}`,
  );
  assert.equal(
    cdp.serverErrors.length,
    0,
    `Unexpected 5xx responses from ${TARGET_ORIGIN}:\n${cdp.serverErrors.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// Individual Synced Steps (each reconnectable & independently runnable)
// ---------------------------------------------------------------------------

async function step01SignedOut(cdp) {
  const protectedRoutes = [
    "/api/mesh/state",
    "/api/mesh/users",
    "/api/mesh/tests",
    "/api/mesh/shell/sessions",
  ];
  const unauthResults = await Promise.all(
    protectedRoutes.map((route) => fetch(`${TARGET_ORIGIN}${route}`)),
  );
  unauthResults.forEach((resp, idx) => {
    assert.equal(
      resp.status,
      401,
      `signed-out ${protectedRoutes[idx]} must return 401 (got ${resp.status})`,
    );
  });

  // When --keep-signed-in is active and persistent Chrome is already signed into LIVE metal,
  // verify unauthenticated containment via fresh cookieless fetch without destroying the live session.
  await dismissOverlays(cdp);
  if (KEEP_SIGNED_IN && process.env.QA_FORCE_RELOGIN !== "1" && (await isSignedInLive(cdp))) {
    const anonHome = await fetch(`${TARGET_ORIGIN}/`);
    assert.equal(anonHome.status, 200, "signed-out GET / should return 200");
    const anonHtml = await anonHome.text();
    assert.ok(!anonHtml.includes("vm-asia"), "real metal node leaked in signed-out HTML");
    await cdp.showBanner("01 Signed-out 401 checks passed (preserving LIVE metal session)");
    console.log("  [PASS 01] 401 default-deny on protected routes + zero signed-out leaks (preserved existing LIVE metal session)");
    await sleep(Math.min(400, STEP_MS));
    return;
  }

  // Otherwise sign out if currently logged in so we verify live browser SIM containment end-to-end.
  if (await isSignedInLive(cdp)) {
    await cdp.showBanner("01 Signing out existing session to verify SIM containment");
    await cdp.click('[href="/auth/logout"]', "sign out link");
  } else {
    await cdp.send("Page.navigate", { url: `${TARGET_ORIGIN}/` });
  }

  await cdp.waitFor(
    "signed-out simulated mode with 3D globe",
    `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null && document.querySelector('canvas[aria-label="Interactive H3 Earth globe"]') !== null`,
    15_000,
  );
  await cdp.showBanner("01 Signed-out SIM containment & zoomed-out 3D H3 globe");
  const signedOutText = await cdp.eval(`document.body.innerText`);
  assert.ok(!signedOutText.includes("legion"), "real metal node leaked while signed out");
  assert.ok(!signedOutText.includes("vm-eu"), "real metal node leaked while signed out");
  await cdp.captureFrame("01-signed-out-sim");
  console.log("  [PASS 01] 401 default-deny on protected routes + SIM mode renders zoomed-out 3D globe with zero metal leaks");
  await sleep(STEP_MS);
}

async function step02Login(cdp) {
  await dismissOverlays(cdp);
  const alreadyLive = (await isSignedInLive(cdp)) && process.env.QA_FORCE_RELOGIN !== "1";
  if (alreadyLive) {
    await cdp.showBanner("02 Reusing authenticated LIVE metal session in persistent Chrome");
    const liveDomText = await cdp.eval(`document.body.innerText`);
    assert.ok(!liveDomText.includes("sim-atlas"), "simulated network still visible in live mode");
    console.log("  [PASS 02] reconnected to already-authenticated LIVE metal session (zero re-login needed)");
    await sleep(Math.min(450, STEP_MS));
    return;
  }
  await performMagicLinkLogin(cdp);
  await cdp.showBanner("02 LIVE metal mesh hydrated (magic-link replay blocked 401)");
  console.log("  [PASS 02] magic-link sign-in hydrated LIVE metal network & blocked token replay (401)");
  await sleep(STEP_MS);
}

async function step03GlobeAndPaths(cdp) {
  await ensureSignedIn(cdp);
  await cdp.showBanner("03 Query-driven 3D globe: BASE NODES ONLY vs H3+ARCS & LAN/DIR paths");
  // Ensure pane 0 is not already maximized; click maximize -> verify BASE NODES ONLY -> restore -> verify H3/ARCS
  const alreadyBaseOnly = await cdp.eval(
    `Boolean(document.querySelector('[data-testid="globe-layer-legend"]')?.textContent?.includes("BASE NODES ONLY"))`,
  );
  if (!alreadyBaseOnly) {
    await cdp.click('[data-testid="query-pane-0"] [data-max-pane="0"]', "maximize globe pane");
  }
  const baseLegend = await cdp.waitFor(
    "globe fullscreen legend BASE NODES ONLY",
    `(() => { const el = document.querySelector('[data-testid="globe-layer-legend"]'); return el && el.textContent.includes("BASE NODES ONLY") ? el.textContent.trim() : null; })()`,
  );
  await cdp.captureFrame("03-globe-base-nodes-only");
  await sleep(Math.min(600, STEP_MS));
  await cdp.click('[data-testid="query-pane-0"] [data-max-pane="0"]', "restore split from globe");
  const queryLegend = await cdp.waitFor(
    "globe split legend with H3 or ARCS",
    `(() => { const el = document.querySelector('[data-testid="globe-layer-legend"]'); return el && (el.textContent.includes("H3:") || el.textContent.includes("ARCS:")) ? el.textContent.trim() : null; })()`,
  );

  await cdp.ensureQueryTab("hosts");
  await cdp.pickBottomTab("hosts", "metal hosts tab");
  const hostsText = await cdp.waitFor(
    "live metal hosts with LAN/DIR/RLY path badges",
    `(() => { const t = document.body.innerText; return (t.includes("legion") && t.includes("vm-us") && (t.includes("LAN") || t.includes("DIR") || t.includes("RLY"))) ? t : null; })()`,
    15_000,
  );
  assert.ok(!hostsText.includes("0.0/0 GB"), "remote metal peers should show RAM % instead of 0.0/0 GB");
  await cdp.captureFrame("03-live-metal-hosts-rtt");
  console.log(`  [PASS 03] globe switched "${baseLegend}" -> "${queryLegend}" & metal hosts shows live RTT + LAN/DIR/RLY badges`);
  await sleep(STEP_MS);
}

async function step04ShellRedaction(cdp) {
  await ensureSignedIn(cdp);
  const dtBin = findDialtoneBinary();
  if (!dtBin) {
    console.log("  [SKIP 04] local dialtone binary not found; skipped live shell creation");
    return;
  }
  const demoShellSession = `qa-live-${randomBytes(3).toString("hex")}`;
  const synthSecret = "ghp_SYNTHETIC0123456789abcdef0123456789";
  try {
    await cdp.showBanner(`04 Live dialtone-shell (${demoShellSession}) & [REDACTED] secret check`);
    runDialtone(dtBin, ["shell", "new", demoShellSession, "--node", "legion"]);
    runDialtone(dtBin, [
      "shell",
      "send",
      demoShellSession,
      "--node",
      "legion",
      "--",
      `Write-Output "QA_SHELL_OK token=${synthSecret}"`,
    ]);
    const shellCheck = await cdp.waitFor(
      "live dialtone-shell session via /api/mesh/shell/sessions with redaction",
      `(async () => {
        const r = await fetch("/api/mesh/shell/sessions", { cache: "no-store" });
        if (!r.ok) return null;
        const raw = await r.text();
        if (!raw.includes(${JSON.stringify(demoShellSession)})) return null;
        return { leaked: raw.includes(${JSON.stringify(synthSecret)}), redacted: raw.includes("[REDACTED]"), len: raw.length };
      })()`,
      15_000,
    );
    assert.equal(shellCheck.leaked, false, "RAW synthetic secret leaked through /api/mesh/shell/sessions!");
    console.log(
      `  [PASS 04] live dialtone-shell '${demoShellSession}' streamed through Worker (leaked=false, redacted=${shellCheck.redacted})`,
    );
  } finally {
    try {
      runDialtone(dtBin, ["shell", "kill", demoShellSession, "--node", "legion"], 10_000);
    } catch {
      // best-effort cleanup
    }
  }
}

async function step05HostAndUsers(cdp) {
  await ensureSignedIn(cdp);
  await cdp.showBanner("05 Single-host drill-down (legion) & Cloudflare edge users presence");
  await cdp.ensureQueryTab("hosts");
  await cdp.pickBottomTab("hosts", "metal hosts tab");
  await cdp.click('[data-select-host="legion"]', "select legion host row");
  await cdp.ensureQueryTab("host");
  await cdp.pickBottomTab("host", "metal host tab");
  await cdp.waitFor(
    "metal host detail for legion",
    `document.body.innerText.includes("legion") && document.body.innerText.includes("blobs") && document.body.innerText.includes("compute")`,
    15_000,
  );
  await cdp.captureFrame("05-live-metal-host-legion");

  await cdp.ensureQueryTab("users");
  await cdp.pickBottomTab("users", "metal users tab");
  await cdp.waitFor(
    "live signed-in user presence row for QA email",
    `document.body.innerText.includes(${JSON.stringify(QA_EMAIL)}) && document.body.innerText.includes("active")`,
    15_000,
  );
  await cdp.captureFrame("05-live-metal-users-presence");
  console.log(`  [PASS 05] metal host (legion) & metal users active edge presence (${QA_EMAIL}) verified`);
  await sleep(STEP_MS);
}

async function step06TestsAndLogs(cdp) {
  await ensureSignedIn(cdp);
  await cdp.showBanner("06 Live test dashboard stream & immutable run log (metal tests)");
  await cdp.ensureQueryTab("tests");
  await cdp.pickBottomTab("tests", "metal tests tab");
  const hasLiveTests = await cdp.waitFor(
    "metal tests pane loaded",
    `document.body.innerText.includes("TEST") && (document.querySelector('[data-open-log]') !== null || document.body.innerText.includes("No test runs"))`,
    15_000,
  );
  assert.ok(hasLiveTests);
  const openedLog = await cdp.eval(`(() => {
    const row = document.querySelector('[data-open-log]');
    if (!row) return false;
    row.click();
    return row.getAttribute('data-open-log');
  })()`);
  if (openedLog) {
    await cdp.waitFor(
      "structured test run log rendered",
      `document.body.innerText.includes("LOG ·") || document.body.innerText.includes("go run")`,
      15_000,
    );
    await cdp.captureFrame("06-live-metal-test-log");
    console.log(`  [PASS 06] metal tests streamed live runs & opened immutable log (${openedLog.slice(0, 12)}…)`);
  } else {
    console.log("  [PASS 06] metal tests pane loaded cleanly through Cloudflare Worker");
  }
  await sleep(STEP_MS);
}

async function step07Tiling2x2AndKv(cdp) {
  await ensureSignedIn(cdp);
  await cdp.showBanner("07 Config: 2x2 split (Globe + Hosts[fast] + Plugins + Users) -> CF KV");
  await cdp.ensureQueryTab("hosts");
  await cdp.ensureQueryTab("plugins");
  await cdp.ensureQueryTab("users");
  await cdp.click('[data-testid="open-config"]', "config button");
  await cdp.waitFor("config page open", `document.querySelector('[data-testid="layout-2x2"]') !== null`);
  await cdp.click('[data-testid="layout-2x2"]', "2x2 layout button");
  await sleep(Math.min(350, STEP_MS));

  await cdp.click('[data-testid="cfg-pane-0"]', "pane #1 slot");
  await cdp.click('[data-testid="cfg-assign-globe"]', "assign 3D H3 GLOBE");

  await cdp.click('[data-testid="cfg-pane-1"]', "pane #2 slot");
  await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="cfg-query-table"] tbody tr'));
    const hostRow = rows.find((r) => /\\bhosts\\b/i.test(r.querySelector('.cfg-q-name')?.textContent || ''));
    if (!hostRow) return false;
    hostRow.querySelector('[data-cfg-assign]')?.click();
    hostRow.querySelector('[data-cfg-rate$=":fast"]')?.click();
    return true;
  })()`);

  await cdp.click('[data-testid="cfg-pane-2"]', "pane #3 slot");
  await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="cfg-query-table"] tbody tr'));
    const row = rows.find((r) => /\\bplugins\\b/i.test(r.querySelector('.cfg-q-name')?.textContent || ''));
    row?.querySelector('[data-cfg-assign]')?.click();
    return Boolean(row);
  })()`);

  await cdp.click('[data-testid="cfg-pane-3"]', "pane #4 slot");
  await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="cfg-query-table"] tbody tr'));
    const row = rows.find((r) => /\\busers\\b/i.test(r.querySelector('.cfg-q-name')?.textContent || ''));
    row?.querySelector('[data-cfg-assign]')?.click();
    return Boolean(row);
  })()`);

  await cdp.waitFor("Cloudflare KV save", `document.body.innerText.includes("CF SAVED")`, 10_000);
  await cdp.captureFrame("07-config-2x2-cf-saved");
  await sleep(Math.min(500, STEP_MS));
  await cdp.click('[data-testid="config-done"]', "config done button");
  await cdp.waitFor(
    "2x2 split active with live metal hosts (fast), shell plugin, and active users",
    `document.querySelector('[data-testid="split-grid"]')?.getAttribute("data-layout") === "2x2" && document.body.innerText.includes("shell") && document.body.innerText.includes("fast") && document.body.innerText.includes(${JSON.stringify(QA_EMAIL)})`,
    15_000,
  );
  await cdp.captureFrame("07-live-metal-2x2-workspace");
  console.log("  [PASS 07] configured 2x2 split (Globe + Hosts[fast] + Plugins + Users) & persisted to CF KV");
  await sleep(STEP_MS);
}

async function step08CameraTsAndReload(cdp) {
  await ensureSignedIn(cdp);
  await cdp.showBanner("08 Camera Studio: custom TS targeting vm-asia + hard reload CF KV restore");
  await cdp.click('[data-testid="open-camera"]', "camera button");
  await cdp.waitFor(
    "camera studio open with syntax highlight",
    `document.querySelector('[data-testid="cam-preset-highest-p95"]') !== null && document.querySelectorAll('[data-testid="camera-ts-highlight"] .tok-kw').length > 0`,
  );
  await cdp.click('[data-testid="cam-preset-highest-cpu"]', "highest CPU preset");
  await sleep(Math.min(350, STEP_MS));
  await cdp.click('[data-testid="cam-preset-highest-p95"]', "highest p95 preset");
  await sleep(Math.min(350, STEP_MS));

  const customTsPolicy = [
    `// Custom live metal policy: track vm-asia (Tokyo e2-micro) zoomed out`,
    `const target = ctx.nodes.find((n) => n.name === "vm-asia") ?? ctx.nodes[0];`,
    `return {`,
    `  lat: target.lat,`,
    `  lng: target.lng,`,
    `  distance: 235,`,
    `  node: target.name,`,
    `  reason: "tokyo e2-micro",`,
    `};`,
  ].join("\n");
  await cdp.typeInto('[data-testid="camera-ts-editor"]', customTsPolicy);
  const customCamStatus = await cdp.waitFor(
    "custom TypeScript policy targeting vm-asia",
    `(() => { const el = document.querySelector('[data-testid="cam-status"]'); return el && el.textContent.includes("vm-asia") ? el.textContent.trim() : null; })()`,
  );
  await cdp.captureFrame("08-camera-studio-custom-ts");
  await sleep(Math.min(450, STEP_MS));
  await cdp.click('[data-testid="apply-camera-ts"]', "apply custom TypeScript policy");
  await cdp.click('[data-testid="camera-done"]', "camera done button");
  await cdp.waitFor(
    "custom TS camera policy applied on main view",
    `document.body.innerText.includes("CAM: vm-asia")`,
    10_000,
  );
  // Allow debounced PUT /api/user/ui-config to commit to Cloudflare KV before hard reload.
  await sleep(1_400);

  await cdp.showBanner("08 Hard reload -> verifying CF KV restores 2x2 + CAM: vm-asia");
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor(
    "reloaded LIVE metal 2x2 layout & custom camera policy restored from CF KV",
    `document.body.innerText.includes("LIVE") && document.body.innerText.includes("CAM: vm-asia")`,
    20_000,
  );
  await cdp.captureFrame("08-live-metal-after-reload");
  console.log(`  [PASS 08] Camera Studio (${customCamStatus}) + hard reload restored LIVE metal & CAM: vm-asia from CF KV`);
  await sleep(STEP_MS);
}

async function step09SignOut(cdp) {
  if (KEEP_SIGNED_IN) {
    await ensureSignedIn(cdp);
    await cdp.showBanner("DONE! Chrome kept open & signed into LIVE metal for inspection");
    console.log("  [PASS 09] --keep-signed-in active: leaving persistent Chrome open on LIVE metal");
    return;
  }
  await dismissOverlays(cdp);
  if (await isSignedInLive(cdp)) {
    await cdp.showBanner("09 Signing out -> verifying clean return to SIM mode");
    await cdp.click('[href="/auth/logout"]', "sign out link");
  }
  await cdp.waitFor(
    "signed-out SIM mode after logout",
    `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null && !document.body.innerText.includes("legion")`,
    15_000,
  );
  await cdp.showBanner("09 ALL LIVE BROWSER CAPABILITIES VERIFIED!");
  await sleep(Math.min(800, KEEP_OPEN_MS));
  console.log("  [PASS 09] clean sign-out to SIM mode with zero leaked nodes");
}

const STEPS = {
  "01-signed-out": step01SignedOut,
  "02-login": step02Login,
  "03-globe-and-paths": step03GlobeAndPaths,
  "04-shell-redaction": step04ShellRedaction,
  "05-host-and-users": step05HostAndUsers,
  "06-tests-and-logs": step06TestsAndLogs,
  "07-tiling-2x2-kv": step07Tiling2x2AndKv,
  "08-camera-ts-reload": step08CameraTsAndReload,
  "09-sign-out": step09SignOut,
};

async function main() {
  const modeLabel = REUSE_CDP
    ? `PERSISTENT CDP :${CDP_PORT}`
    : DEMO
      ? "GUIDED HEADED DEMO"
      : HEADED
        ? "HEADED DEBUG"
        : "HEADLESS";
  console.log(`Live Browser CDP E2E [${modeLabel}] step=${STEP}: ${TARGET_ORIGIN} as ${QA_EMAIL}`);

  const { cdp, wsPort, reused, cleanup } = await openBrowser();
  console.log(
    `  [INFO] ${reused ? "Reconnected to" : "Started"} Chrome CDP on 127.0.0.1:${wsPort}`,
  );

  try {
    if (STEP === "all") {
      for (const fn of Object.values(STEPS)) {
        await fn(cdp);
      }
      assertNoBrowserErrors(cdp);
      console.log("ALL LIVE BROWSER CDP E2E CHECKS PASSED.");
    } else {
      const fn = STEPS[STEP];
      if (!fn) {
        throw new Error(`Unknown --step "${STEP}". Valid steps: ${Object.keys(STEPS).join(", ")}`);
      }
      await fn(cdp);
      assertNoBrowserErrors(cdp);
    }
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("Live Browser CDP E2E FAILED:", err?.message || err);
  process.exit(1);
});
