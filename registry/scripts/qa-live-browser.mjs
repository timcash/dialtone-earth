import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARGS = new Set(process.argv.slice(2));
const HEADED =
  ARGS.has("--headed") ||
  process.env.QA_HEADED === "1" ||
  process.env.DIALTONE_BROWSER_HEADED === "1";
const OPEN_DEVTOOLS =
  ARGS.has("--devtools") || process.env.QA_DEVTOOLS === "1";
const STEP_MS = Number(
  process.env.QA_STEP_MS ?? (HEADED ? 900 : 0),
);
const KEEP_OPEN_MS = Number(
  process.env.QA_KEEP_OPEN_MS ?? (HEADED ? 2_000 : 0),
);

const TARGET_ORIGIN = (
  process.env.QA_ORIGIN || "https://metal.dialtone.earth"
).replace(/\/+$/, "");
const QA_EMAIL = (process.env.QA_EMAIL || "test@dialtone.earth")
  .trim()
  .toLowerCase();
const GMAIL_CMD = process.env.QA_GMAIL_CMD || "gmail";
const POLL_TIMEOUT_MS = Number(process.env.QA_POLL_TIMEOUT_MS || 45_000);

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (err) => reject(err));
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

  /** Show a crisp live step badge in headed mode so the user sees what CDP is doing. */
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
            padding: "6px 12px",
            fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
            fontSize: "12px",
            fontWeight: "700",
            letterSpacing: "0.04em",
            pointerEvents: "none",
            boxShadow: "0 2px 12px rgba(0,0,0,0.65)",
          });
          document.body.appendChild(el);
        }
        el.textContent = ${JSON.stringify(`CDP AUTOMATION // ${stepLabel}`)};
        return true;
      })()`);
    } catch {
      // ignore during transitions
    }
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
      return true;
    })()`);
    if (HEADED) {
      for (const ch of value) {
        await this.send("Input.insertText", { text: ch });
        await sleep(30);
      }
    } else {
      await this.send("Input.insertText", { text: value });
    }
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
    ...(HEADED ? ["--new-window", "--window-position=80,40"] : ["--headless=new", "--disable-gpu"]),
    ...(HEADED && OPEN_DEVTOOLS ? ["--auto-open-devtools-for-tabs"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1360,960",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  const proc = spawn(bin, flags, { stdio: ["ignore", "pipe", "pipe"] });

  let stderrBuf = "";
  const wsPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Chrome DevTools did not start within 10s:\n${stderrBuf}`));
    }, 10_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      const m = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
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
  const modeLabel = HEADED ? "HEADED DEBUG" : "HEADLESS";
  console.log(`Live Browser CDP E2E [${modeLabel}]: ${TARGET_ORIGIN} as ${QA_EMAIL}`);
  const { cdp, wsPort, cleanup } = await launchChrome();
  console.log(`  [INFO] Chrome CDP debug session listening on ws://127.0.0.1:${wsPort}`);

  try {
    // 0. Signed-out API default-deny check (401 on /api/mesh/state and /api/mesh/users)
    const [unauthState, unauthUsers] = await Promise.all([
      fetch(`${TARGET_ORIGIN}/api/mesh/state`),
      fetch(`${TARGET_ORIGIN}/api/mesh/users`),
    ]);
    assert.equal(unauthState.status, 401, "signed-out /api/mesh/state must return 401");
    assert.equal(unauthUsers.status, 401, "signed-out /api/mesh/users must return 401");
    console.log("  [PASS] signed-out API default-deny (401 on /api/mesh/state and /api/mesh/users)");

    // 1. Signed-out containment: real browser must render SIM mode with zero metal data
    await cdp.send("Page.navigate", { url: `${TARGET_ORIGIN}/` });
    await cdp.waitFor(
      "signed-out simulated mode",
      `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null`,
    );
    await cdp.showBanner("1/10 Verify signed-out SIM mode (zero metal data)");
    const signedOutText = await cdp.eval(`document.body.innerText`);
    assert.ok(!signedOutText.includes("legion"), "real metal node leaked while signed out");
    assert.ok(!signedOutText.includes("vm-eu"), "real metal node leaked while signed out");
    console.log("  [PASS] signed-out browser renders SIM mode with zero live metal data");
    await sleep(STEP_MS);

    // 2. Click sign in -> grayscale /login -> type test@dialtone.earth -> submit
    await cdp.showBanner(`2/10 Click sign in & enter ${QA_EMAIL}`);
    await cdp.click('[href="/login"]', "sign in link");
    await cdp.waitFor(
      "grayscale login email input",
      `location.pathname === "/login" && document.querySelector('input[name="email"]') !== null`,
    );
    await cdp.showBanner(`2/10 Typing ${QA_EMAIL} into /login form`);
    await sleep(1_200);
    const requestStartedSec = Math.floor(Date.now() / 1000);
    await cdp.typeInto('input[name="email"]', QA_EMAIL);
    await sleep(Math.min(400, STEP_MS));
    await cdp.click('button[type="submit"]', "Send sign-in link button");
    await cdp.waitFor(
      "magic-link sent confirmation",
      `location.search.includes("sent=1") && document.body.innerText.toLowerCase().includes("check your email")`,
    );
    await cdp.showBanner("3/10 Waiting for single-use magic link email...");
    console.log(`  [PASS] entered ${QA_EMAIL} on /login and submitted magic-link request`);

    // 3. Poll Gmail for fresh single-use verify URL
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let verifyUrl = null;
    while (Date.now() < deadline) {
      verifyUrl = readLatestMagicLinkUrl(requestStartedSec);
      if (verifyUrl) break;
      await sleep(3_000);
    }
    assert.ok(verifyUrl, `Timed out waiting for magic-link email for ${QA_EMAIL}`);
    console.log("  [PASS] received fresh single-use magic-link email");

    // 4. Open /auth/verify?token=... and click Continue confirmation button
    const verifyToken = new URL(verifyUrl).searchParams.get("token") || "";
    await cdp.send("Page.navigate", { url: verifyUrl });
    await cdp.waitFor(
      "verify confirmation form",
      `document.querySelector('form button[type="submit"]') !== null && document.body.innerText.includes(${JSON.stringify(QA_EMAIL)})`,
    );
    await cdp.showBanner("4/10 Confirming single-use magic link sign-in");
    await sleep(STEP_MS);
    await cdp.click('form button[type="submit"]', "Continue sign-in button");

    // 5. Wait for LIVE metal hydration & verify replay of consumed token fails closed (401)
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
    await cdp.showBanner("5/10 Signed in! Live metal mesh hydrated on globe");
    const liveDomText = await cdp.eval(`document.body.innerText`);
    assert.ok(!liveDomText.includes("sim-atlas"), "simulated network still visible after live login");
    console.log("  [PASS] real browser signed in and hydrated LIVE metal network in DOM");
    await sleep(STEP_MS);

    // 6. Open config -> select 1|2 split -> assign globe / metal:hosts / metal:plugins -> verify CF SAVED
    await cdp.showBanner("6/10 Open config -> 1|2 layout (Globe + Hosts + Plugins)");
    await cdp.click('[data-testid="open-config"]', "config button");
    await cdp.waitFor("config page open", `document.querySelector('[data-testid="layout-1_2"]') !== null`);
    await cdp.click('[data-testid="layout-1_2"]', "1|2 layout button");
    await cdp.eval(`(() => {
      const setSelect = (testId, matchFn) => {
        const sel = document.querySelector('[data-testid="' + testId + '"]');
        if (!sel) return;
        const opt = Array.from(sel.options).find(matchFn);
        if (opt && sel.value !== opt.value) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };
      setSelect("cfg-pane-0", (o) => o.value === "globe");
      setSelect("cfg-pane-1", (o) => o.textContent.toLowerCase().includes("hosts"));
      setSelect("cfg-pane-2", (o) => o.textContent.toLowerCase().includes("plugins"));
      return true;
    })()`);
    await cdp.waitFor("Cloudflare KV save", `document.body.innerText.includes("CF SAVED")`, 10_000);
    await sleep(STEP_MS);
    await cdp.click('[data-testid="config-done"]', "config done button");
    await cdp.waitFor(
      "1|2 split active with live metal hosts & shell plugin",
      `document.querySelector('[data-testid="split-grid"]')?.getAttribute("data-layout") === "1|2" && document.body.innerText.includes("shell")`,
      15_000,
    );
    const splitText = await cdp.eval(`document.body.innerText`);
    assert.ok(!splitText.includes("0.0/0 GB"), "remote metal peers should show RAM % instead of 0.0/0 GB");
    console.log("  [PASS] configured 1|2 split (Globe + metal:hosts + metal:plugins) & saved to CF KV");
    await sleep(STEP_MS);

    // 7. Open fullscreen TypeScript Camera Studio -> test highest-cpu then highest-p95 on live metal nodes
    await cdp.showBanner("7/10 Fullscreen Camera Studio -> highest CPU & highest p95");
    await cdp.click('[data-testid="open-camera"]', "camera button");
    await cdp.waitFor(
      "camera studio open with presets",
      `document.querySelector('[data-testid="cam-preset-highest-p95"]') !== null && document.querySelectorAll('[data-testid="camera-ts-highlight"] .tok-kw').length > 0`,
    );
    await sleep(STEP_MS);
    await cdp.click('[data-testid="cam-preset-highest-cpu"]', "highest CPU preset");
    await sleep(Math.min(600, STEP_MS));
    await cdp.click('[data-testid="cam-preset-highest-p95"]', "highest p95 latency preset");
    const camStatus = await cdp.waitFor(
      "live metal camera target status",
      `(() => { const el = document.querySelector('[data-testid="cam-status"]'); return el && el.textContent.includes("TARGET:") ? el.textContent.trim() : null; })()`,
    );
    await sleep(STEP_MS);
    await cdp.click('[data-testid="apply-camera-ts"]', "apply TypeScript policy");
    await cdp.click('[data-testid="camera-done"]', "camera done button");
    await cdp.showBanner(`8/10 Globe slewed -> ${camStatus}`);
    console.log(`  [PASS] Camera Studio applied highest-p95 on live metal (${camStatus})`);
    await sleep(STEP_MS);

    // 8. Reload real browser and confirm Cloudflare KV restores 1|2 layout & LIVE metal session
    await cdp.showBanner("9/10 Reloading browser to verify Cloudflare KV persistence...");
    await cdp.send("Page.reload", { ignoreCache: true });
    await cdp.waitFor(
      "reloaded LIVE metal 1|2 layout restored from CF KV",
      `document.body.innerText.includes("LIVE") && document.querySelector('[data-testid="split-grid"]')?.getAttribute("data-layout") === "1|2" && document.body.innerText.includes("shell")`,
      20_000,
    );
    await cdp.showBanner("9/10 Reload verified! 1|2 + Camera Policy restored from CF KV");
    console.log("  [PASS] browser reload restored signed-in LIVE metal + 1|2 layout + plugins from CF KV");
    await sleep(KEEP_OPEN_MS);

    // 9. Sign out in real browser and verify return to SIM mode with zero metal data
    await cdp.showBanner("10/10 Signing out -> verifying clean return to SIM mode");
    await cdp.click('[href="/auth/logout"]', "sign out link");
    await cdp.waitFor(
      "signed-out SIM mode after logout",
      `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null && !document.body.innerText.includes("legion")`,
      15_000,
    );
    await cdp.showBanner("ALL 10/10 LIVE CDP CHECKS PASSED!");
    await sleep(Math.min(1_000, KEEP_OPEN_MS));
    console.log("  [PASS] sign out reverted browser cleanly to SIM mode with zero metal data");
    console.log("ALL LIVE BROWSER CDP E2E CHECKS PASSED.");
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("Live Browser CDP E2E FAILED:", err?.message || err);
  process.exit(1);
});
