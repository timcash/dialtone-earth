import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

export const DEFAULT_CDP_PORT = Number(process.env.DIALTONE_CDP_PORT || 9222);
export const DEFAULT_PROFILE_DIR = resolve(
  process.env.DIALTONE_CDP_PROFILE || join(REPO_ROOT, "logs", "cdp-profile"),
);
export const DEFAULT_META_PATH = resolve(
  process.env.DIALTONE_CDP_META || join(REPO_ROOT, "logs", "cdp.json"),
);
export const DEFAULT_TARGET_ORIGIN = (
  process.env.QA_ORIGIN || "http://127.0.0.1:5175"
).replace(/\/+$/, "");
export const DEFAULT_DASHBOARD_URL =
  (process.env.DIALTONE_DASHBOARD_URL || "http://127.0.0.1:5174").replace(/\/+$/, "") + "/";

export function sleep(ms) {
  return ms > 0 ? new Promise((resolveFn) => setTimeout(resolveFn, ms)) : Promise.resolve();
}

export function findChromeBinary() {
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

export function findDialtoneBinary() {
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

export function runDialtone(bin, args, timeoutMs = 20_000, envOverrides = null) {
  return execFileSync(bin, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
  });
}

export function readLatestMagicLinkUrl(minIatSec, opts = {}) {
  const res = tryReadLatestMagicLinkUrl(minIatSec, opts);
  if (res.authError) throw new Error(res.authError);
  return res.url;
}

export function tryReadLatestMagicLinkUrl(minIatSec, opts = {}) {
  const targetOrigin = (opts.targetOrigin || DEFAULT_TARGET_ORIGIN).replace(/\/+$/, "");
  const qaEmail = (opts.qaEmail || process.env.QA_EMAIL || "test@dialtone.earth")
    .trim()
    .toLowerCase();
  const gmailCmd = opts.gmailCmd || process.env.QA_GMAIL_CMD || "gmail";
  const query = `in:anywhere from:login@dialtone.earth ${qaEmail} newer_than:1d`;
  let output = "";
  try {
    output =
      process.platform === "win32"
        ? execSync(`${gmailCmd} readonly read "${query}" --max 3`, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          })
        : execFileSync(gmailCmd, ["readonly", "read", query, "--max", "3"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim();
    return { url: null, authError: detail };
  }
  const regex = new RegExp(
    `${targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/auth/verify\\?token=([A-Za-z0-9._~%-]+)`,
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
        payload.sub === qaEmail &&
        typeof payload.iat === "number" &&
        payload.iat >= minIatSec
      ) {
        return { url: match[0], authError: null };
      }
    } catch {
      // ignore malformed match
    }
  }
  return { url: null, authError: null };
}

export class CdpClient {
  constructor(wsUrl, opts = {}) {
    this.wsUrl = wsUrl;
    this.targetOrigin = (opts.targetOrigin || DEFAULT_TARGET_ORIGIN).replace(/\/+$/, "");
    this.headed = opts.headed ?? true;
    this.stepMs = Number(opts.stepMs ?? (this.headed ? 650 : 0));
    this.saveScreenshots = opts.saveScreenshots ?? process.env.QA_SCREENSHOTS !== "0";
    this.screenshotDir = resolve(
      opts.screenshotDir ||
        process.env.QA_SCREENSHOT_DIR ||
        join(REPO_ROOT, "logs", "live-demo-frames"),
    );
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.serverErrors = [];
    this.frameCounter = 0;
    this.closedByCaller = false;
    this.ready = new Promise((resolveFn, reject) => {
      this.ws.addEventListener("open", () => resolveFn());
      this.ws.addEventListener("error", (err) => {
        if (this.closedByCaller) {
          resolveFn();
          return;
        }
        reject(new Error(`CDP WebSocket error (${wsUrl}): ${err?.message || "connection failed"}`));
      });
    });
    // Prevent unhandled rejection if caller disconnects before awaiting ready.
    this.ready.catch(() => {});
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
          String(resp.url || "").startsWith(this.targetOrigin)
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

  async showBanner(stepLabel) {
    if (!this.headed) return;
    if (this.mirror) {
      await this.mirror.showBanner(stepLabel).catch(() => {});
    }
    try {
      await this.eval(`(() => {
        let el = document.getElementById("__cdp_qa_banner");
        if (!el) {
          el = document.createElement("div");
          el.id = "__cdp_qa_banner";
          Object.assign(el.style, {
            position: "fixed",
            top: "8px",
            left: "10px",
            maxWidth: "min(460px, calc(100vw - 20px))",
            zIndex: "2147483647",
            background: "rgba(10, 10, 10, 0.94)",
            color: "#ffffff",
            border: "1.5px solid #ffffff",
            padding: "4px 9px",
            fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
            fontSize: "11px",
            fontWeight: "700",
            letterSpacing: "0.04em",
            pointerEvents: "none",
            boxShadow: "0 2px 12px rgba(0,0,0,0.75)",
          });
          document.body.appendChild(el);
        }
        el.textContent = ${JSON.stringify(`TEST // ${stepLabel}`)};
        return true;
      })()`);
    } catch {
      // ignore during page navigation
    }
  }

  async clearOverlays() {
    if (this.mirror) {
      await this.mirror.clearOverlays().catch(() => {});
    }
    try {
      await this.eval(`(() => {
        for (const id of ["__cdp_qa_banner", "__cdp_spotlight_box", "__cdp_spotlight_label"]) {
          document.getElementById(id)?.remove();
        }
        return true;
      })()`);
    } catch {
      // ignore
    }
  }

  async captureFrame(slug) {
    if (!this.saveScreenshots) return null;
    try {
      mkdirSync(this.screenshotDir, { recursive: true });
      this.frameCounter += 1;
      const safeSlug = slug.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
      const outPath = join(this.screenshotDir, `${safeSlug}.png`);
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

  async spotlight(selector, caption = "", holdMs = 350) {
    if (!this.headed) return;
    if (this.mirror) {
      await this.mirror.spotlight(selector, caption, 0).catch(() => {});
    }
    try {
      await this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;

        let box = document.getElementById("__cdp_spotlight_box");
        if (!box) {
          box = document.createElement("div");
          box.id = "__cdp_spotlight_box";
          Object.assign(box.style, {
            position: "fixed",
            zIndex: "2147483645",
            pointerEvents: "none",
            border: "2.5px solid #ffffff",
            background: "rgba(255, 255, 255, 0.11)",
            boxShadow: "0 0 0 3px rgba(255, 255, 255, 0.25), 0 0 24px rgba(255, 255, 255, 0.45)",
            transition: "all 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          });
          document.body.appendChild(box);
        }
        const pad = 4;
        const left = Math.max(2, rect.left - pad);
        const top = Math.max(2, rect.top - pad);
        const width = Math.min(window.innerWidth - left - 2, rect.width + pad * 2);
        const height = Math.min(window.innerHeight - top - 2, rect.height + pad * 2);
        Object.assign(box.style, {
          opacity: "1",
          left: left + "px",
          top: top + "px",
          width: width + "px",
          height: height + "px",
        });

        let lbl = document.getElementById("__cdp_spotlight_label");
        if (!lbl) {
          lbl = document.createElement("div");
          lbl.id = "__cdp_spotlight_label";
          Object.assign(lbl.style, {
            position: "fixed",
            zIndex: "2147483646",
            pointerEvents: "none",
            background: "#ffffff",
            color: "#0b0b0b",
            border: "1px solid #ffffff",
            padding: "3px 8px",
            fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
            fontSize: "11px",
            fontWeight: "800",
            letterSpacing: "0.04em",
            boxShadow: "0 4px 16px rgba(0,0,0,0.8)",
            whiteSpace: "nowrap",
            transition: "all 220ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          });
          document.body.appendChild(lbl);
        }
        const labelTop = top > 34 ? top - 26 : Math.min(window.innerHeight - 28, top + height + 6);
        const labelLeft = Math.min(Math.max(6, window.innerWidth - 220), Math.max(6, left));
        lbl.textContent = ${JSON.stringify(caption ? `▶ ${caption}` : `▶ ${selector}`)};
        Object.assign(lbl.style, {
          opacity: "1",
          left: labelLeft + "px",
          top: labelTop + "px",
        });
        return true;
      })()`);
      if (holdMs > 0) await sleep(Math.min(holdMs, this.stepMs + 250));
    } catch {
      // ignore during transitions
    }
  }

  async pulseClick(selector) {
    if (!this.headed) return;
    if (this.mirror) {
      await this.mirror.pulseClick(selector).catch(() => {});
    }
    try {
      await this.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const dot = document.createElement("div");
        Object.assign(dot.style, {
          position: "fixed",
          zIndex: "2147483647",
          pointerEvents: "none",
          left: (r.left + r.width / 2 - 14) + "px",
          top: (r.top + r.height / 2 - 14) + "px",
          width: "28px",
          height: "28px",
          borderRadius: "50%",
          border: "3px solid #ffffff",
          background: "rgba(255, 255, 255, 0.35)",
          transform: "scale(0.5)",
          opacity: "1",
          transition: "transform 360ms ease-out, opacity 360ms ease-out",
        });
        document.body.appendChild(dot);
        requestAnimationFrame(() => {
          dot.style.transform = "scale(2.1)";
          dot.style.opacity = "0";
        });
        setTimeout(() => dot.remove(), 420);
        return true;
      })()`);
    } catch {
      // ignore
    }
  }

  async click(selector, label) {
    await this.waitFor(label || selector, `document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (this.headed) {
      await this.spotlight(selector, `CLICK: ${label || selector}`, Math.min(350, this.stepMs));
      await this.pulseClick(selector);
    }
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Missing element: " + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`);
    // Mirror non-mutating UI navigation clicks onto mobile preview so both formats
    // stay visually synced without racing KV writes, triggering duplicate magic-link
    // submits on empty forms, or navigating mobile away from #mobile-preview.
    const skipMirrorClick =
      selector.includes("apply-camera-ts") ||
      selector.includes("cam-preset-") ||
      selector.includes("layout-") ||
      selector.includes("cfg-add-") ||
      selector.includes("cfg-assign") ||
      selector.includes('type="submit"') ||
      selector.includes("/login") ||
      selector.includes("/auth/logout");
    if (this.mirror && !skipMirrorClick) {
      await this.mirror
        .eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return Boolean(el); })()`)
        .catch(() => {});
    }
  }

  async typeInto(selector, value, label = "") {
    await this.waitFor(selector, `document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (this.headed) {
      await this.spotlight(selector, `TYPE: ${label || selector}`, Math.min(250, this.stepMs));
    }
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (this.headed && value.length <= 64) {
      for (const ch of value) {
        await this.send("Input.insertText", { text: ch });
        await sleep(20);
      }
    } else {
      await this.send("Input.insertText", { text: value });
    }
  }

  async openConfigMenu() {
    const isOpen = await this.eval(
      `Boolean(document.querySelector('#config-page:not([hidden]) [data-testid="config-done"]'))`,
    );
    if (!isOpen) {
      await this.click('[data-testid="open-config"]', "menu button");
      await this.waitFor(
        "menu overlay open",
        `document.querySelector('#config-page:not([hidden]) [data-testid="config-done"]') !== null && document.querySelector('#config-page:not([hidden]) [data-testid="cfg-query-table"]') !== null`,
      );
    }
  }

  async closeConfigMenu() {
    const isOpen = await this.eval(
      `Boolean(document.querySelector('#config-page:not([hidden]) [data-testid="config-done"]'))`,
    );
    if (isOpen) {
      await this.click('#config-page:not([hidden]) [data-testid="config-done"]', "menu done button");
      await this.waitFor(
        "menu overlay closed",
        `document.querySelector('#config-page:not([hidden])') === null`,
      );
    }
  }

  async pickBottomTab(substr, label) {
    // Window selection is done through the menu overlay (`open-config`).
    const target = substr.toLowerCase();
    await this.openConfigMenu();
    // Focus pane #2 if present (so pane #1 stays 3D globe), else pane #1
    const hasPane1 = await this.eval(
      `document.querySelector('#config-page:not([hidden]) [data-testid="cfg-pane-1"]') !== null`,
    );
    if (hasPane1) {
      await this.click('#config-page:not([hidden]) [data-testid="cfg-pane-1"]', "pane #2 slot");
    } else {
      await this.click('#config-page:not([hidden]) [data-testid="cfg-pane-0"]', "pane #1 slot");
    }
    const assigned = await this.eval(`(() => {
      const target = ${JSON.stringify(target)};
      const rows = Array.from(document.querySelectorAll('#config-page:not([hidden]) [data-testid="cfg-query-table"] tbody tr'));
      const row = rows.find((r) => {
        const txt = (r.querySelector('.cfg-q-name')?.textContent || '').trim().toLowerCase();
        if (target === 'host') return /(?:^|[\\s:])host$/.test(txt);
        return txt.includes(target);
      });
      if (!row) return null;
      const btn = row.querySelector('[data-cfg-assign]');
      if (!btn) return null;
      btn.click();
      return (row.querySelector('.cfg-q-name')?.textContent || '').trim();
    })()`);
    assert.ok(assigned, `Could not find window set matching ${substr} in menu`);
    await sleep(Math.min(200, this.stepMs));
    await this.closeConfigMenu();
    return assigned;
  }

  async ensureQueryTab(kind) {
    const target = kind.toLowerCase();
    await this.openConfigMenu();
    const exists = await this.eval(`(() => {
      const target = ${JSON.stringify(target)};
      const rows = Array.from(document.querySelectorAll('#config-page:not([hidden]) [data-testid="cfg-query-table"] tbody tr'));
      return rows.some((r) => {
        const txt = (r.querySelector('.cfg-q-name')?.textContent || '').trim().toLowerCase();
        if (target === 'host') return /(?:^|[\\s:])host$/.test(txt);
        return txt.includes(target);
      });
    })()`);
    if (!exists) {
      await this.click(`#config-page:not([hidden]) [data-testid="cfg-add-${kind}"]`, `add + ${kind} query`);
      await sleep(Math.min(250, this.stepMs));
    }
    await this.closeConfigMenu();
    return !exists;
  }

  /** Close only the CDP WebSocket connection — never terminates the browser. */
  disconnect() {
    this.closedByCaller = true;
    try {
      this.mirror?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }

  close() {
    this.disconnect();
  }
}

export async function probeCdp(port = DEFAULT_CDP_PORT) {
  try {
    const versionResp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!versionResp.ok) return { connected: false, port };
    const version = await versionResp.json();
    const listResp = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1_500),
    });
    const targets = listResp.ok ? await listResp.json() : [];
    return {
      connected: true,
      port,
      browser: version.Browser || "",
      browserWsUrl: version.webSocketDebuggerUrl || "",
      targets: Array.isArray(targets) ? targets : [],
    };
  } catch {
    return { connected: false, port };
  }
}

async function isUrlReachable(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function readMeta(metaPath = DEFAULT_META_PATH) {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(meta, metaPath = DEFAULT_META_PATH) {
  try {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  } catch {
    // non-fatal
  }
}

async function setWindowBounds(browserCdp, targetId, bounds) {
  try {
    const win = await browserCdp.send("Browser.getWindowForTarget", { targetId });
    if (typeof win?.windowId === "number") {
      await browserCdp.send("Browser.setWindowBounds", {
        windowId: win.windowId,
        bounds: { windowState: "normal", ...bounds },
      });
    }
  } catch {
    // headless or unsupported platform
  }
}

/**
 * Ensures a persistent Chrome instance is running with CDP on `port` and
 * returns the live page target for `targetOrigin`. Never kills Chrome on exit.
 */
export async function ensurePersistentBrowser(opts = {}) {
  const port = Number(opts.port || DEFAULT_CDP_PORT);
  const targetOrigin = (opts.targetOrigin || DEFAULT_TARGET_ORIGIN).replace(/\/+$/, "");
  const dashboardUrl =
    (opts.dashboardUrl || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "") + "/";
  const dashboardOrigin = new URL(dashboardUrl).origin;
  const profileDir = resolve(opts.profileDir || DEFAULT_PROFILE_DIR);
  const metaPath = resolve(opts.metaPath || DEFAULT_META_PATH);
  const headless = Boolean(opts.headless);
  const forceArrange = Boolean(opts.forceArrange);

  let status = await probeCdp(port);
  let launchedPid = readMeta(metaPath)?.pid ?? null;
  let reused = true;

  if (!status.connected) {
    reused = false;
    mkdirSync(profileDir, { recursive: true });
    const bin = findChromeBinary();
    const flags = [
      ...(headless
        ? ["--headless=new", "--disable-gpu", "--window-size=1440,980"]
        : ["--new-window", "--window-position=545,20", "--window-size=1365,980"]),
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `${targetOrigin}/`,
    ];
    const proc = spawn(bin, flags, {
      detached: true,
      stdio: "ignore",
      windowsHide: headless,
    });
    launchedPid = proc.pid ?? null;
    proc.unref();

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      status = await probeCdp(port);
      if (status.connected && status.browserWsUrl) break;
      await sleep(250);
    }
    if (!status.connected || !status.browserWsUrl) {
      throw new Error(`Persistent Chrome CDP did not come online on 127.0.0.1:${port}`);
    }
  }

  let browserCdp = null;
  const getBrowserCdp = () => {
    if (!browserCdp) {
      browserCdp = new CdpClient(status.browserWsUrl, { headed: !headless, targetOrigin });
    }
    return browserCdp;
  };
  let appTarget = null;
  let dashboardTarget = null;

  try {
    let pageTargets = status.targets.filter(
      (t) => t.type === "page" && t.webSocketDebuggerUrl,
    );

    appTarget =
      pageTargets.find((t) => String(t.url || "").startsWith(targetOrigin) && !String(t.url || "").includes("#mobile-preview")) ||
      pageTargets.find(
        (t) =>
          !String(t.url || "").startsWith(dashboardOrigin) &&
          !String(t.url || "").startsWith("devtools://") &&
          !String(t.url || "").includes("#mobile-preview"),
      ) ||
      null;

    if (!appTarget) {
      const created = await getBrowserCdp().send("Target.createTarget", {
        url: `${targetOrigin}/`,
      });
      await sleep(300);
      status = await probeCdp(port);
      pageTargets = status.targets.filter(
        (t) => t.type === "page" && t.webSocketDebuggerUrl,
      );
      appTarget =
        pageTargets.find((t) => t.id === created.targetId) ||
        pageTargets.find((t) => String(t.url || "").startsWith(targetOrigin)) ||
        null;
    }

    assert.ok(appTarget?.webSocketDebuggerUrl, "Could not locate or create CDP page target");

    // In headed mode, open the live Test Dashboard side-by-side when it is reachable.
    if (!headless && opts.arrangeWindows !== false) {
      dashboardTarget =
        pageTargets.find((t) => String(t.url || "").startsWith(dashboardOrigin)) || null;
      const shouldCreateDashboard =
        !dashboardTarget && (await isUrlReachable(dashboardUrl));

      if (shouldCreateDashboard) {
        const created = await getBrowserCdp().send("Target.createTarget", {
          url: dashboardUrl,
          newWindow: true,
        });
        await sleep(300);
        status = await probeCdp(port);
        dashboardTarget =
          status.targets.find((t) => t.id === created.targetId) || null;
      }

      if (!reused || forceArrange || shouldCreateDashboard) {
        const bCdp = getBrowserCdp();
        await setWindowBounds(bCdp, appTarget.id, {
          left: 40,
          top: 20,
          width: 1440,
          height: 940,
        });
      }
    }
  } finally {
    browserCdp?.disconnect();
  }

  const meta = {
    connected: true,
    port,
    pid: launchedPid,
    reused,
    browser: status.browser,
    profile_dir: profileDir,
    target_origin: targetOrigin,
    dashboard_url: dashboardUrl,
    app_target_id: appTarget.id,
    app_url: appTarget.url,
    dashboard_target_id: dashboardTarget?.id || null,
    updated_at: new Date().toISOString(),
  };
  writeMeta(meta, metaPath);

  return {
    port,
    reused,
    appTarget,
    dashboardTarget,
    meta,
  };
}

export async function connectAppSession(opts = {}) {
  const ensured = await ensurePersistentBrowser(opts);
  const cdp = new CdpClient(ensured.appTarget.webSocketDebuggerUrl, {
    targetOrigin: opts.targetOrigin || DEFAULT_TARGET_ORIGIN,
    headed: !opts.headless,
    stepMs: opts.stepMs,
    saveScreenshots: opts.saveScreenshots,
    screenshotDir: opts.screenshotDir,
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  // Attach optional mobile preview mirror (#mobile-preview) so spotlights, banners & UI steps highlight BOTH formats!
  try {
    const targetOrigin = (opts.targetOrigin || DEFAULT_TARGET_ORIGIN).replace(/\/+$/, "");
    const status = await probeCdp(ensured.port);
    const mobileTarget = (status.targets || []).find(
      (t) => t.type === "page" && String(t.url || "").includes("#mobile-preview"),
    );
    if (mobileTarget?.webSocketDebuggerUrl) {
      const mirror = new CdpClient(mobileTarget.webSocketDebuggerUrl, {
        targetOrigin,
        headed: !opts.headless,
        stepMs: 0,
        saveScreenshots: false,
      });
      await mirror.send("Page.enable");
      await mirror.send("Runtime.enable");
      if (!String(mobileTarget.url || "").startsWith(targetOrigin)) {
        await mirror.send("Page.navigate", { url: `${targetOrigin}/#mobile-preview` });
        await sleep(600);
      }
      cdp.mirror = mirror;
    }
  } catch {
    // mobile mirror is optional
  }
  if (!opts.headless) {
    await cdp.send("Page.bringToFront");
  }
  return { cdp, ...ensured };
}

export async function closePersistentBrowser(port = DEFAULT_CDP_PORT, metaPath = DEFAULT_META_PATH) {
  const status = await probeCdp(port);
  if (status.connected && status.browserWsUrl) {
    const browserCdp = new CdpClient(status.browserWsUrl, { headed: false });
    try {
      await browserCdp.send("Browser.close");
    } catch {
      // Chrome closes socket immediately on Browser.close
    } finally {
      browserCdp.disconnect();
    }
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const check = await probeCdp(port);
      if (!check.connected) break;
      await sleep(200);
    }
  }
  try {
    rmSync(metaPath, { force: true });
  } catch {
    // ignore
  }
  return { closed: true, port };
}

export async function getCdpStatus(port = DEFAULT_CDP_PORT, metaPath = DEFAULT_META_PATH) {
  const probe = await probeCdp(port);
  const meta = readMeta(metaPath);
  const pageTargets = (probe.targets || []).filter((t) => t.type === "page");
  const appTarget =
    pageTargets.find((t) =>
      String(t.url || "").startsWith(meta?.target_origin || DEFAULT_TARGET_ORIGIN),
    ) || pageTargets[0] || null;
  const dashboardTarget =
    pageTargets.find((t) =>
      String(t.url || "").startsWith(new URL(meta?.dashboard_url || DEFAULT_DASHBOARD_URL).origin),
    ) || null;
  return {
    connected: probe.connected,
    port,
    pid: probe.connected ? meta?.pid ?? null : null,
    browser: probe.browser || "",
    app_url: appTarget?.url || meta?.target_origin || DEFAULT_TARGET_ORIGIN,
    dashboard_open: Boolean(dashboardTarget),
    page_count: pageTargets.length,
  };
}

export async function updateBannerIfConnected(label, port = DEFAULT_CDP_PORT, targetOrigin = DEFAULT_TARGET_ORIGIN) {
  const probe = await probeCdp(port);
  if (!probe.connected) return false;
  const pageTargets = (probe.targets || []).filter(
    (t) => t.type === "page" && t.webSocketDebuggerUrl,
  );
  const appTarget =
    pageTargets.find((t) => String(t.url || "").startsWith(targetOrigin)) || null;
  if (!appTarget) return false;
  const cdp = new CdpClient(appTarget.webSocketDebuggerUrl, { headed: true, targetOrigin });
  try {
    await cdp.showBanner(label);
    return true;
  } catch {
    return false;
  } finally {
    cdp.disconnect();
  }
}

function parseCliArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const parsed = parseCliArgs(process.argv.slice(2));
  const cmd = parsed._[0] || "status";
  const port = Number(parsed.port || DEFAULT_CDP_PORT);
  const targetOrigin = parsed.origin || DEFAULT_TARGET_ORIGIN;
  const dashboardUrl = parsed.dashboard || DEFAULT_DASHBOARD_URL;

  (async () => {
    if (cmd === "ensure") {
      const res = await ensurePersistentBrowser({
        port,
        targetOrigin,
        dashboardUrl,
        headless: Boolean(parsed.headless),
        forceArrange: Boolean(parsed.arrange),
      });
      console.log(JSON.stringify(res.meta));
    } else if (cmd === "status") {
      const st = await getCdpStatus(port);
      console.log(JSON.stringify(st));
    } else if (cmd === "close") {
      const res = await closePersistentBrowser(port);
      console.log(JSON.stringify(res));
    } else if (cmd === "banner") {
      const text = parsed._.slice(1).join(" ") || "";
      const ok = await updateBannerIfConnected(text, port, targetOrigin);
      console.log(JSON.stringify({ updated: ok }));
    } else {
      console.error(`Usage: node registry/scripts/cdp-session.mjs <ensure|status|close|banner> [--port 9222]`);
      process.exit(2);
    }
  })().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
