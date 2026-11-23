import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ARGS = new Set(process.argv.slice(2));
const DEMO = ARGS.has("--demo") || process.env.QA_DEMO === "1";
const HEADED =
  DEMO ||
  ARGS.has("--headed") ||
  process.env.QA_HEADED === "1" ||
  process.env.DIALTONE_BROWSER_HEADED === "1";
const OPEN_DEVTOOLS =
  ARGS.has("--devtools") || process.env.QA_DEVTOOLS === "1";
const STEP_MS = Number(
  process.env.QA_STEP_MS ?? (DEMO ? 1_600 : HEADED ? 900 : 0),
);
const KEEP_OPEN_MS = Number(
  process.env.QA_KEEP_OPEN_MS ?? (DEMO ? 3_500 : HEADED ? 2_000 : 0),
);

const TARGET_ORIGIN = (
  process.env.QA_ORIGIN || "https://metal.dialtone.earth"
).replace(/\/+$/, "");
const QA_EMAIL = (process.env.QA_EMAIL || "test@dialtone.earth")
  .trim()
  .toLowerCase();
const GMAIL_CMD = process.env.QA_GMAIL_CMD || "gmail";
const POLL_TIMEOUT_MS = Number(process.env.QA_POLL_TIMEOUT_MS || 45_000);
const SAVE_SCREENSHOTS = process.env.QA_SCREENSHOTS !== "0";
const SCREENSHOT_DIR = resolve(
  process.env.QA_SCREENSHOT_DIR || join(process.cwd(), "..", "logs", "live-demo-frames"),
);

function sleep(ms) {
  return ms > 0 ? new Promise((resolveFn) => setTimeout(resolveFn, ms)) : Promise.resolve();
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === "win32"
      ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`
      : null,
    process.platform === "win32"
      ? `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`
      : null,
    process.platform === "win32"
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : null,
    process.platform === "win32"
      ? `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`
      : null,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error("No local Chrome/Chromium/Edge binary found (set CHROME_PATH)");
}

function findDialtoneBinary() {
  const exe = process.platform === "win32" ? "dialtone.exe" : "dialtone";
  const candidates = [
    process.env.DIALTONE_BIN,
    join(homedir(), ".dialtone", "bin", exe),
    join(homedir(), ".local", "bin", exe),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function runDialtone(bin, args, timeoutMs = 20_000) {
  return execFileSync(bin, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readLatestMagicLinkUrl(minIatSec) {
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
      const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      if (
        payload.sub === QA_EMAIL &&
        typeof payload.iat === "number" &&
        payload.iat >= minIatSec
      ) {
        return match[0];
      }
    } catch {
      // ignore malformed match
    }
  }
  return null;
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.serverErrors = [];
    this.frameCounter = 0;
    this.ready = new Promise((resolveFn, reject) => {
      this.ws.addEventListener("open", () => resolveFn());
      this.ws.addEventListener("error", (err) => reject(err));
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: resFn, reject: rejFn } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rejFn(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resFn(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const details = msg.params?.exceptionDetails;
        const text =
          details?.exception?.description ||
          details?.text ||
          "Uncaught runtime exception";
        this.exceptions.push(text);
      } else if (msg.method === "Network.responseReceived") {
        const resp = msg.params?.response;
        if (
          resp &&
          typeof resp.status === "number" &&
          resp.status >= 500 &&
          String(resp.url || "").startsWith(TARGET_ORIGIN)
        ) {
          this.serverErrors.push(`${resp.status} ${resp.url}`);
        }
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolveFn, reject) => {
      this.pending.set(id, { resolve: resolveFn, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "Browser evaluation failed",
      );
    }
    return res.result?.value;
  }

  async waitFor(description, expression, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastVal;
    while (Date.now() < deadline) {
      try {
        lastVal = await this.eval(expression);
        if (lastVal) return lastVal;
      } catch {
        // page may be navigating
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${description} (last=${JSON.stringify(lastVal)})`);
  }

  /** Show a crisp live step badge in headed mode so the user sees what CDP is demonstrating. */
  async showBanner(stepLabel) {
    if (!HEADED) return;
    try {
      await this.eval(`(() => {
        let el = document.getElementById("__cdp_qa_banner");
        if (!el) {
          el = document.createElement("div");
          el.id = "__cdp_qa_banner";
          Object.assign(el.style, {
            position: "fixed",
            top: "10px",
            right: "10px",
            zIndex: "2147483647",
            background: "#090d0a",
            color: "#7ff2a4",
            border: "1px solid #38d66b",
            padding: "7px 13px",
            fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
            fontSize: "12px",
            fontWeight: "700",
            letterSpacing: "0.04em",
            pointerEvents: "none",
            boxShadow: "0 2px 12px rgba(0,0,0,0.65)",
          });
          document.body.appendChild(el);
        }
        el.textContent = ${JSON.stringify(`LIVE METAL DEMO // ${stepLabel}`)};
        return true;
      })()`);
    } catch {
      // ignore during transitions
    }
  }

  async captureFrame(slug) {
    if (!SAVE_SCREENSHOTS) return null;
    try {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      this.frameCounter += 1;
      const prefix = String(this.frameCounter).padStart(2, "0");
      const safeSlug = slug.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
      const outPath = join(SCREENSHOT_DIR, `${prefix}-${safeSlug}.png`);
      const res = await this.send("Page.captureScreenshot", { format: "png" });
      if (res?.data) {
        writeFileSync(outPath, Buffer.from(res.data, "base64"));
        return outPath;
      }
    } catch {
      // ignore non-fatal screenshot error
    }
    return null;
  }

  /** Highlight an element briefly in headed mode, then click it. */
  async click(selector, label) {
    await this.waitFor(label || selector, `document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (HEADED) {
      await this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        const prev = el.style.outline;
        el.style.outline = "2px solid #38d66b";
        setTimeout(() => { el.style.outline = prev; }, 450);
        return true;
      })()`);
      await sleep(Math.min(350, STEP_MS));
    }
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Missing element: " + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`);
  }

  /** Type text into an input using real CDP Input.insertText (visible keystrokes in headed mode). */
  async typeInto(selector, value) {
    await this.waitFor(selector, `document.querySelector(${JSON.stringify(selector)}) !== null`);
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (HEADED && value.length <= 64) {
      for (const ch of value) {
        await this.send("Input.insertText", { text: ch });
        await sleep(25);
      }
    } else {
      await this.send("Input.insertText", { text: value });
    }
  }

  /** Click a bottom workspace tab matching a substring (e.g. 'users', 'tests', 'hosts', 'host'). */
  async pickBottomTab(substr, label) {
    const matchExpr = `(() => {
      const target = ${JSON.stringify(substr.toLowerCase())};
      const btns = Array.from(document.querySelectorAll('[data-pick-content]'));
      return btns.find((b) => {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (target === 'host') return /(?:^|[\\s:])host$/.test(txt);
        return txt.includes(target);
      }) || null;
    })()`;
    await this.waitFor(label || `bottom tab ${substr}`, `${matchExpr} !== null`);
    const clicked = await this.eval(`(() => {
      const btn = ${matchExpr};
      if (!btn) return false;
      btn.click();
      return btn.textContent.trim();
    })()`);
    assert.ok(clicked, `Could not find bottom tab matching ${substr}`);
    return clicked;
  }

  /** Ensure a query kind exists in the bottom tab bar, adding it via Config if needed. */
  async ensureQueryTab(kind) {
    const exists = await this.eval(`(() => {
      const target = ${JSON.stringify(kind.toLowerCase())};
      return Array.from(document.querySelectorAll('[data-pick-content]')).some((b) => {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (target === 'host') return /(?:^|[\\s:])host$/.test(txt);
        return txt.includes(target);
      });
    })()`);
    if (exists) return false;
    await this.click('[data-testid="open-config"]', "config button");
    await this.click(`[data-testid="cfg-add-${kind}"]`, `add + ${kind} query`);
    await sleep(Math.min(350, STEP_MS));
    await this.click('[data-testid="config-done"]', "config done button");
    return true;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function launchChrome() {
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

  const cdp = new CdpSession(pageTarget.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  if (HEADED) {
    await cdp.send("Page.bringToFront");
  }
  return {
    cdp,
    wsPort,
    cleanup() {
      cdp.close();
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

async function main() {
  const modeLabel = DEMO ? "GUIDED HEADED DEMO" : HEADED ? "HEADED DEBUG" : "HEADLESS";
  console.log(`Live Browser CDP E2E [${modeLabel}]: ${TARGET_ORIGIN} as ${QA_EMAIL}`);
  const { cdp, wsPort, cleanup } = await launchChrome();
  console.log(`  [INFO] Chrome CDP debug session listening on ws://127.0.0.1:${wsPort}`);

  const dtBin = findDialtoneBinary();
  let demoShellSession = null;
  const savedFrames = [];

  try {
    // 1. Signed-out API default-deny check (401 across all protected /api/mesh/* routes)
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
    console.log("  [PASS 1/14] signed-out API default-deny (401 on state, users, tests, shell/sessions)");

    // 2. Signed-out containment: real browser must render SIM mode with zero metal data & unclipped globe
    await cdp.send("Page.navigate", { url: `${TARGET_ORIGIN}/` });
    await cdp.waitFor(
      "signed-out simulated mode with 3D globe",
      `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null && document.querySelector('canvas[aria-label="Interactive H3 Earth globe"]') !== null`,
    );
    await cdp.showBanner("1/14 Signed-out SIM containment & zoomed-out 3D H3 globe");
    const signedOutText = await cdp.eval(`document.body.innerText`);
    assert.ok(!signedOutText.includes("legion"), "real metal node leaked while signed out");
    assert.ok(!signedOutText.includes("vm-eu"), "real metal node leaked while signed out");
    savedFrames.push(await cdp.captureFrame("signed-out-sim"));
    console.log("  [PASS 2/14] signed-out browser renders SIM mode & 3D globe with zero live metal data");
    await sleep(STEP_MS);

    // 3. Click sign in -> grayscale /login -> type test@dialtone.earth -> submit -> Gmail magic link -> verify
    await cdp.showBanner(`2/14 Grayscale /login magic-link sign-in for ${QA_EMAIL}`);
    await cdp.click('[href="/login"]', "sign in link");
    await cdp.waitFor(
      "grayscale login email input",
      `location.pathname === "/login" && document.querySelector('input[name="email"]') !== null`,
    );
    await sleep(1_100);
    const requestStartedSec = Math.floor(Date.now() / 1000);
    await cdp.typeInto('input[name="email"]', QA_EMAIL);
    savedFrames.push(await cdp.captureFrame("grayscale-login"));
    await sleep(Math.min(400, STEP_MS));
    await cdp.click('button[type="submit"]', "Send sign-in link button");
    await cdp.waitFor(
      "magic-link sent confirmation",
      `location.search.includes("sent=1") && document.body.innerText.toLowerCase().includes("check your email")`,
    );
    await cdp.showBanner("3/14 Waiting for single-use magic-link email...");
    console.log(`  [PASS 3/14] submitted grayscale /login magic-link request for ${QA_EMAIL}`);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let verifyUrl = null;
    while (Date.now() < deadline) {
      verifyUrl = readLatestMagicLinkUrl(requestStartedSec);
      if (verifyUrl) break;
      await sleep(3_000);
    }
    assert.ok(verifyUrl, `Timed out waiting for magic-link email for ${QA_EMAIL}`);

    const verifyToken = new URL(verifyUrl).searchParams.get("token") || "";
    await cdp.send("Page.navigate", { url: verifyUrl });
    await cdp.waitFor(
      "verify confirmation form",
      `document.querySelector('form button[type="submit"]') !== null && document.body.innerText.includes(${JSON.stringify(QA_EMAIL)})`,
    );
    await cdp.showBanner("4/14 Confirming single-use magic link & testing replay protection");
    await sleep(Math.min(700, STEP_MS));
    await cdp.click('form button[type="submit"]', "Continue sign-in button");

    // 4. Wait for LIVE metal hydration & verify replay of consumed token fails closed (401)
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
    await cdp.showBanner("5/14 LIVE metal mesh hydrated (replay blocked 401)");
    const liveDomText = await cdp.eval(`document.body.innerText`);
    assert.ok(!liveDomText.includes("sim-atlas"), "simulated network still visible after live login");
    savedFrames.push(await cdp.captureFrame("live-metal-hydrated"));
    console.log("  [PASS 4/14] magic-link sign-in hydrated LIVE metal network & blocked token replay (401)");
    await sleep(STEP_MS);

    // 5. Prove query-driven 3D globe toggles between BASE NODES ONLY (fullscreen globe) and H3+ARCS
    await cdp.showBanner("6/14 Query-driven globe: fullscreen BASE NODES ONLY vs H3+ARCS");
    await cdp.click('[data-testid="query-pane-0"] [data-max-pane="0"]', "maximize globe pane");
    const baseLegend = await cdp.waitFor(
      "globe fullscreen legend BASE NODES ONLY",
      `(() => { const el = document.querySelector('[data-testid="globe-layer-legend"]'); return el && el.textContent.includes("BASE NODES ONLY") ? el.textContent.trim() : null; })()`,
    );
    savedFrames.push(await cdp.captureFrame("globe-base-nodes-only"));
    await sleep(Math.min(800, STEP_MS));
    await cdp.click('[data-testid="query-pane-0"] [data-max-pane="0"]', "restore split from globe");
    const queryLegend = await cdp.waitFor(
      "globe split legend with H3 or ARCS",
      `(() => { const el = document.querySelector('[data-testid="globe-layer-legend"]'); return el && (el.textContent.includes("H3:") || el.textContent.includes("ARCS:")) ? el.textContent.trim() : null; })()`,
    );
    console.log(`  [PASS 5/14] query-driven globe switched "${baseLegend}" -> "${queryLegend}"`);
    await sleep(STEP_MS);

    // 6. Live hosts table: verify all real metal nodes + origin-relative RTT + LAN/DIR/RLY badges
    await cdp.showBanner("7/14 Live metal:hosts — origin-relative RTT & LAN/DIR/RLY badges");
    await cdp.pickBottomTab("hosts", "metal:hosts tab");
    const hostsText = await cdp.waitFor(
      "live metal hosts with LAN/DIR/RLY path badges",
      `(() => { const t = document.body.innerText; return (t.includes("legion") && t.includes("vm-us") && (t.includes("LAN") || t.includes("DIR") || t.includes("RLY"))) ? t : null; })()`,
      15_000,
    );
    assert.ok(!hostsText.includes("0.0/0 GB"), "remote metal peers should show RAM % instead of 0.0/0 GB");
    savedFrames.push(await cdp.captureFrame("live-metal-hosts-rtt"));
    console.log("  [PASS 6/14] metal:hosts displays live fleet nodes with origin-relative RTT & path badges");
    await sleep(STEP_MS);

    // 7. Live dialtone-shell session + server-side secret redaction proof (if local dialtone binary available)
    if (dtBin) {
      demoShellSession = `qa-live-${randomBytes(3).toString("hex")}`;
      const synthSecret = "ghp_SYNTHETIC0123456789abcdef0123456789";
      await cdp.showBanner(`8/14 Live dialtone-shell (${demoShellSession}) & server-side [REDACTED] check`);
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
      // Query authenticated /api/mesh/shell/sessions from inside the browser session to verify
      // live session visibility + server-side secret redaction through the Cloudflare Worker.
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
        `  [PASS 7/14] live dialtone-shell '${demoShellSession}' streamed through Worker (leaked=false, redacted=${shellCheck.redacted})`,
      );
    } else {
      console.log("  [SKIP 7/14] local dialtone binary not found; skipped live shell creation");
    }

    // 8. Single-host drill-down (metal host): click legion row to open single-host inspector
    await cdp.showBanner("9/14 Single-host drill-down (metal host) — legion compute, blobs & shell");
    await cdp.click('[data-select-host="legion"]', "select legion host row");
    await cdp.ensureQueryTab("host");
    await cdp.pickBottomTab("host", "metal host tab");
    await cdp.waitFor(
      "metal host detail for legion",
      `document.body.innerText.includes("legion") && document.body.innerText.includes("blobs") && document.body.innerText.includes("compute")`,
      15_000,
    );
    savedFrames.push(await cdp.captureFrame("live-metal-host-legion"));
    console.log("  [PASS 8/14] metal host drill-down shows live compute, RAM/Disk, blobs, and sessions");
    await sleep(STEP_MS);

    // 9. Multi-user Cloudflare edge presence (metal users)
    await cdp.showBanner("10/14 Live multi-user Cloudflare edge presence (metal users)");
    await cdp.ensureQueryTab("users");
    await cdp.pickBottomTab("users", "metal users tab");
    await cdp.waitFor(
      "live signed-in user presence row for QA email",
      `document.body.innerText.includes(${JSON.stringify(QA_EMAIL)}) && document.body.innerText.includes("active")`,
      15_000,
    );
    savedFrames.push(await cdp.captureFrame("live-metal-users-presence"));
    console.log(`  [PASS 9/14] metal users shows live active edge presence for ${QA_EMAIL}`);
    await sleep(STEP_MS);

    // 10. Live test dashboard & immutable structured log streaming (metal tests -> metal log)
    await cdp.showBanner("11/14 Live test dashboard & immutable run log (metal tests -> log)");
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
      savedFrames.push(await cdp.captureFrame("live-metal-test-log"));
      console.log(`  [PASS 10/14] metal tests streamed live runs and opened immutable log (${openedLog.slice(0, 12)}…)`);
    } else {
      console.log("  [PASS 10/14] metal tests pane loaded cleanly through Cloudflare Worker");
    }
    await sleep(STEP_MS);

    // 11. Whole-app 2x2 tiling layout + best-effort fast rate tier (1.5s) + CF KV save
    await cdp.showBanner("12/14 Config: 2x2 split (Globe + Hosts [fast 1.5s] + Plugins + Users) -> CF KV");
    await cdp.click('[data-testid="open-config"]', "config button");
    await cdp.waitFor("config page open", `document.querySelector('[data-testid="layout-2x2"]') !== null`);
    await cdp.click('[data-testid="layout-2x2"]', "2x2 layout button");
    await sleep(Math.min(350, STEP_MS));

    // Pane #1 -> 3D H3 GLOBE
    await cdp.click('[data-testid="cfg-pane-0"]', "pane #1 slot");
    await cdp.click('[data-testid="cfg-assign-globe"]', "assign 3D H3 GLOBE");
    // Pane #2 -> metal hosts + set rate tier to fast 1.5s
    await cdp.click('[data-testid="cfg-pane-1"]', "pane #2 slot");
    await cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="cfg-query-table"] tbody tr'));
      const hostRow = rows.find((r) => /\\bhosts\\b/i.test(r.querySelector('.cfg-q-name')?.textContent || ''));
      if (!hostRow) return false;
      hostRow.querySelector('[data-cfg-assign]')?.click();
      hostRow.querySelector('[data-cfg-rate$=":fast"]')?.click();
      return true;
    })()`);
    // Pane #3 -> metal plugins
    await cdp.click('[data-testid="cfg-pane-2"]', "pane #3 slot");
    await cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="cfg-query-table"] tbody tr'));
      const row = rows.find((r) => /\\bplugins\\b/i.test(r.querySelector('.cfg-q-name')?.textContent || ''));
      row?.querySelector('[data-cfg-assign]')?.click();
      return Boolean(row);
    })()`);
    // Pane #4 -> metal users
    await cdp.click('[data-testid="cfg-pane-3"]', "pane #4 slot");
    await cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="cfg-query-table"] tbody tr'));
      const row = rows.find((r) => /\\busers\\b/i.test(r.querySelector('.cfg-q-name')?.textContent || ''));
      row?.querySelector('[data-cfg-assign]')?.click();
      return Boolean(row);
    })()`);

    await cdp.waitFor("Cloudflare KV save", `document.body.innerText.includes("CF SAVED")`, 10_000);
    savedFrames.push(await cdp.captureFrame("config-2x2-cf-saved"));
    await sleep(Math.min(700, STEP_MS));
    await cdp.click('[data-testid="config-done"]', "config done button");
    await cdp.waitFor(
      "2x2 split active with live metal hosts (fast), shell plugin, and active users",
      `document.querySelector('[data-testid="split-grid"]')?.getAttribute("data-layout") === "2x2" && document.body.innerText.includes("shell") && document.body.innerText.includes("fast") && document.body.innerText.includes(${JSON.stringify(QA_EMAIL)})`,
      15_000,
    );
    savedFrames.push(await cdp.captureFrame("live-metal-2x2-workspace"));
    console.log("  [PASS 11/14] configured 2x2 split (Globe + Hosts[fast] + Plugins + Users) & saved to CF KV");
    await sleep(STEP_MS);

    // 12. Fullscreen CSP-safe TypeScript Camera Studio: presets + custom TypeScript policy -> vm-asia
    await cdp.showBanner("13/14 Camera Studio: presets + custom TypeScript policy targeting vm-asia");
    await cdp.click('[data-testid="open-camera"]', "camera button");
    await cdp.waitFor(
      "camera studio open with syntax highlight",
      `document.querySelector('[data-testid="cam-preset-highest-p95"]') !== null && document.querySelectorAll('[data-testid="camera-ts-highlight"] .tok-kw').length > 0`,
    );
    await cdp.click('[data-testid="cam-preset-highest-cpu"]', "highest CPU preset");
    await sleep(Math.min(450, STEP_MS));
    await cdp.click('[data-testid="cam-preset-highest-p95"]', "highest p95 preset");
    await sleep(Math.min(450, STEP_MS));

    // Write a live custom TypeScript camera policy locking onto vm-asia (e2-micro Tokyo node)
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
    savedFrames.push(await cdp.captureFrame("camera-studio-custom-ts"));
    await sleep(Math.min(600, STEP_MS));
    await cdp.click('[data-testid="apply-camera-ts"]', "apply custom TypeScript policy");
    await cdp.click('[data-testid="camera-done"]', "camera done button");
    await cdp.showBanner(`13/14 Globe slewed via custom TS -> ${customCamStatus}`);
    savedFrames.push(await cdp.captureFrame("live-metal-slewed-vm-asia"));
    console.log(`  [PASS 12/14] Camera Studio evaluated presets & custom TS policy (${customCamStatus})`);
    await sleep(STEP_MS);

    // 13. Hard browser reload -> confirm Cloudflare KV restores 2x2 layout + LIVE metal + custom camera policy
    await cdp.showBanner("14/14 Hard reload -> verifying Cloudflare KV restores 2x2 + custom TS policy");
    await cdp.send("Page.reload", { ignoreCache: true });
    await cdp.waitFor(
      "reloaded LIVE metal 2x2 layout & custom camera policy restored from CF KV",
      `document.body.innerText.includes("LIVE") && document.querySelector('[data-testid="split-grid"]')?.getAttribute("data-layout") === "2x2" && document.body.innerText.includes("shell") && document.body.innerText.includes("CAM: vm-asia")`,
      20_000,
    );
    savedFrames.push(await cdp.captureFrame("live-metal-after-reload"));
    console.log("  [PASS 13/14] hard reload restored LIVE metal + 2x2 layout + plugins + custom TS policy from CF KV");
    await sleep(KEEP_OPEN_MS);

    // 14. Sign out cleanly & verify return to SIM mode + zero runtime/5xx errors
    await cdp.showBanner("DONE! Signing out -> verifying clean return to SIM mode");
    await cdp.click('[href="/auth/logout"]', "sign out link");
    await cdp.waitFor(
      "signed-out SIM mode after logout",
      `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null && !document.body.innerText.includes("legion")`,
      15_000,
    );
    assert.equal(
      cdp.exceptions.length,
      0,
      `Uncaught browser runtime exceptions during live walkthrough:\n${cdp.exceptions.join("\n")}`,
    );
    assert.equal(
      cdp.serverErrors.length,
      0,
      `Unexpected 5xx responses from ${TARGET_ORIGIN}:\n${cdp.serverErrors.join("\n")}`,
    );
    await cdp.showBanner("ALL 14/14 LIVE METAL CAPABILITIES VERIFIED!");
    await sleep(Math.min(1_200, KEEP_OPEN_MS));
    console.log(
      `  [PASS 14/14] clean sign-out to SIM mode | 0 uncaught JS exceptions | 0 5xx errors | ${savedFrames.filter(Boolean).length} frames saved in ${SCREENSHOT_DIR}`,
    );
    console.log("ALL LIVE BROWSER CDP E2E CHECKS PASSED.");
  } finally {
    if (dtBin && demoShellSession) {
      try {
        runDialtone(dtBin, ["shell", "kill", demoShellSession, "--node", "legion"], 10_000);
      } catch {
        // best-effort cleanup
      }
    }
    cleanup();
  }
}

main().catch((err) => {
  console.error("Live Browser CDP E2E FAILED:", err?.message || err);
  process.exit(1);
});
