import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET_ORIGIN = (
  process.env.QA_ORIGIN || "https://metal.dialtone.earth"
).replace(/\/+$/, "");
const QA_EMAIL = (process.env.QA_EMAIL || "test@dialtone.earth")
  .trim()
  .toLowerCase();
const GMAIL_CMD = process.env.QA_GMAIL_CMD || "gmail";
const POLL_TIMEOUT_MS = Number(process.env.QA_POLL_TIMEOUT_MS || 45_000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function launchHeadlessChrome() {
  const bin = findChromeBinary();
  const profileDir = mkdtempSync(join(tmpdir(), "dialtone-earth-cdp-"));
  const proc = spawn(
    bin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,960",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

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
  return {
    cdp,
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
        // ignore Windows handle lock briefly
      }
    },
  };
}

async function main() {
  console.log(`Live Browser CDP E2E: ${TARGET_ORIGIN} as ${QA_EMAIL}`);
  const { cdp, cleanup } = await launchHeadlessChrome();
  try {
    // 1. Signed-out check: real browser must stay in SIMULATED mode with zero metal nodes
    await cdp.send("Page.navigate", { url: `${TARGET_ORIGIN}/` });
    await cdp.waitFor(
      "signed-out simulated mode",
      `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null`,
    );
    const signedOutText = await cdp.eval(`document.body.innerText`);
    assert.ok(!signedOutText.includes("legion"), "real metal node leaked while signed out");
    console.log("  [PASS] signed-out browser renders SIM mode with zero live metal data");

    // 2. Open /login, type test@dialtone.earth into email input, and submit form
    await sleep(1_200);
    const requestStartedSec = Math.floor(Date.now() / 1000);
    await cdp.send("Page.navigate", { url: `${TARGET_ORIGIN}/login` });
    await cdp.waitFor(
      "grayscale login email input",
      `document.querySelector('input[name="email"]') !== null`,
    );
    await cdp.eval(`(() => {
      const input = document.querySelector('input[name="email"]');
      input.value = ${JSON.stringify(QA_EMAIL)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('button[type="submit"]').click();
      return true;
    })()`);
    await cdp.waitFor(
      "magic-link sent confirmation",
      `location.search.includes("sent=1") && document.body.innerText.toLowerCase().includes("check your email")`,
    );
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

    // 4. Open /auth/verify?token=... in real browser and click confirmation submit button
    await cdp.send("Page.navigate", { url: verifyUrl });
    await cdp.waitFor(
      "verify confirmation form",
      `document.querySelector('form button[type="submit"]') !== null && document.body.innerText.includes(${JSON.stringify(QA_EMAIL)})`,
    );
    await cdp.eval(`document.querySelector('form button[type="submit"]').click()`);

    // 5. Wait for LIVE metal mode & real metal nodes in DOM
    await cdp.waitFor(
      "authenticated LIVE metal mode with real nodes",
      `location.pathname === "/" && document.body.innerText.includes("LIVE") && document.body.innerText.includes("metal") && document.querySelector('[href="/auth/logout"]') !== null && (document.body.innerText.includes("legion") || document.body.innerText.includes("vm-us") || document.body.innerText.includes("vm-eu"))`,
      20_000,
    );
    const liveDomText = await cdp.eval(`document.body.innerText`);
    assert.ok(!liveDomText.includes("sim-atlas"), "simulated network still visible after live login");
    console.log("  [PASS] real browser signed in and hydrated LIVE metal network in DOM");

    // 6. Open config, select 1|2 split, verify CF SAVED, close config
    await cdp.eval(`document.querySelector('[data-testid="open-config"]').click()`);
    await cdp.waitFor("config page open", `document.querySelector('[data-testid="layout-1_2"]') !== null`);
    await cdp.eval(`document.querySelector('[data-testid="layout-1_2"]').click()`);
    await cdp.waitFor("Cloudflare KV save", `document.body.innerText.includes("CF SAVED")`, 10_000);
    await cdp.eval(`document.querySelector('[data-testid="config-done"]').click()`);
    await cdp.waitFor(
      "1|2 split active with live metal hosts",
      `document.querySelector('[data-testid="split-grid"]')?.getAttribute("data-layout") === "1|2"`,
    );
    console.log("  [PASS] configured 1|2 split layout and persisted to Cloudflare KV (CF SAVED)");

    // 7. Open fullscreen Camera Studio, apply highest-p95 preset on real metal nodes
    await cdp.eval(`document.querySelector('[data-testid="open-camera"]').click()`);
    await cdp.waitFor(
      "camera studio open with highest-p95 preset",
      `document.querySelector('[data-testid="cam-preset-highest-p95"]') !== null`,
    );
    await cdp.eval(`document.querySelector('[data-testid="cam-preset-highest-p95"]').click()`);
    const camStatus = await cdp.waitFor(
      "live metal camera target status",
      `(() => { const el = document.querySelector('[data-testid="cam-status"]'); return el && el.textContent.includes("TARGET:") ? el.textContent.trim() : null; })()`,
    );
    await cdp.eval(`document.querySelector('[data-testid="apply-camera-ts"]').click()`);
    await cdp.eval(`document.querySelector('[data-testid="camera-done"]').click()`);
    console.log(`  [PASS] Camera Studio applied highest-p95 on live metal (${camStatus})`);

    // 8. Reload real browser and confirm Cloudflare KV restores 1|2 layout & LIVE metal session
    await cdp.send("Page.reload", { ignoreCache: true });
    await cdp.waitFor(
      "reloaded LIVE metal 1|2 layout restored from CF KV",
      `document.body.innerText.includes("LIVE") && document.querySelector('[data-testid="split-grid"]')?.getAttribute("data-layout") === "1|2"`,
      20_000,
    );
    console.log("  [PASS] browser reload restored signed-in LIVE metal + 1|2 layout from Cloudflare KV");

    // 9. Sign out in real browser and verify return to SIM mode with zero metal data
    await cdp.eval(`document.querySelector('[href="/auth/logout"]').click()`);
    await cdp.waitFor(
      "signed-out SIM mode after logout",
      `document.body.innerText.includes("SIM") && document.querySelector('[href="/login"]') !== null && !document.body.innerText.includes("legion")`,
      15_000,
    );
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
