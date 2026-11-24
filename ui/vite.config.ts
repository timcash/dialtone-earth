import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const uiDir = dirname(fileURLToPath(import.meta.url));
const commandRoot = resolve(uiDir, "..");

// `go run . dev` and `go run . test` generate this file. The dashboard only
// reads it: the CLI is the single writer, so the two can never disagree.
const statePath = resolve(process.env.DIALTONE_EARTH_STATE_PATH || resolve(commandRoot, "logs", "state.json"));
const logsDir = dirname(statePath);
const cdpPort = Number(process.env.DIALTONE_CDP_PORT || 9222);
const SAFE_FILTER_RE = /^[\^$A-Za-z0-9_.|*-]+$/;
const SAFE_TARGET_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
let activeRun: ChildProcess | null = null;

type TestRecord = {
  name: string;
  title: string;
  section: string;
  source: string;
  status: string;
  elapsed: string;
  timestamp: string;
  "test-id": string;
};

type RunOptions = {
  browser: boolean;
  keepSignedIn: boolean;
  deployOnPass: boolean;
  prod: boolean;
  filter: string;
  dashboardUrl: string;
};

type CdpPageTarget = {
  id: string;
  title: string;
  url: string;
  wsUrl: string;
};

function testApiPlugin(): Plugin {
  return {
    name: "dialtone-earth-test-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const parsedUrl = new URL(request.url || "/", "http://local");
        const pathname = parsedUrl.pathname;
        if (pathname === "/api/tests" && request.method === "GET") {
          readTests()
            .then((tests) => sendJson(response, { tests }))
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/tests/run" && request.method === "POST") {
          const filter = (parsedUrl.searchParams.get("filter") || "").trim();
          if (filter !== "" && !SAFE_FILTER_RE.test(filter)) {
            sendJson(response, { error: "Invalid test filter pattern" }, 400);
            return;
          }
          const browser = parsedUrl.searchParams.get("browser") === "1";
          const keepSignedIn = parsedUrl.searchParams.get("keepSignedIn") === "1";
          const deployOnPass = parsedUrl.searchParams.get("deployOnPass") === "1";
          const prod = parsedUrl.searchParams.get("prod") === "1";
          const hostHeader = typeof request.headers.host === "string" ? request.headers.host : "127.0.0.1:5174";
          startTests(response, {
            browser,
            keepSignedIn,
            deployOnPass,
            prod,
            filter,
            dashboardUrl: `http://${hostHeader}/`,
          });
          return;
        }
        if (pathname === "/api/pipeline" && request.method === "GET") {
          readPipeline()
            .then((pipeline) => sendJson(response, pipeline))
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/promote" && request.method === "POST") {
          promoteStagingToLive(response).catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/staging/env" && request.method === "GET") {
          readStagingEnvStatus()
            .then((envStatus) => sendJson(response, envStatus))
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/cdp/status" && request.method === "GET") {
          readCdpStatus()
            .then((status) => sendJson(response, status))
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/cdp/new-tab" && request.method === "POST") {
          const rawTargetUrl = (parsedUrl.searchParams.get("url") || "http://127.0.0.1:5175/").trim();
          createNewCdpTab(rawTargetUrl)
            .then((created) => sendJson(response, created, 201))
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/cdp/stream" && request.method === "GET") {
          const targetId = (parsedUrl.searchParams.get("targetId") || "").trim();
          const viewport = (parsedUrl.searchParams.get("viewport") || "").trim().toLowerCase();
          streamCdpViewport(request, response, targetId, viewport).catch((error: unknown) => {
            if (!response.headersSent) sendError(response, error);
            else response.end();
          });
          return;
        }
        if (pathname === "/api/cdp/frame" && request.method === "GET") {
          const targetId = (parsedUrl.searchParams.get("targetId") || "").trim();
          const viewport = (parsedUrl.searchParams.get("viewport") || "").trim().toLowerCase();
          captureSingleCdpFrame(targetId, viewport)
            .then((jpeg) => {
              if (!jpeg) {
                sendJson(response, { error: "No active CDP browser page" }, 503);
                return;
              }
              response.statusCode = 200;
              response.setHeader("Content-Type", "image/jpeg");
              response.setHeader("Cache-Control", "no-store");
              response.end(jpeg);
            })
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/cdp/ensure" && request.method === "POST") {
          const hostHeader = typeof request.headers.host === "string" ? request.headers.host : "127.0.0.1:5174";
          ensureCdpBrowser(response, `http://${hostHeader}/`);
          return;
        }
        if (pathname === "/api/cdp/close" && request.method === "POST") {
          closeCdpBrowser(request, response);
          return;
        }
        if (pathname.startsWith("/api/test-runs/") && request.method === "GET") {
          const match = /^\/api\/test-runs\/([a-f0-9]{32})(\/log)?$/.exec(pathname);
          if (!match) {
            sendJson(response, { error: "Invalid test-id" }, 400);
            return;
          }
          readTestRun(match[1])
            .then((run) => {
              if (match[2]) {
                response.setHeader("Content-Type", "text/plain; charset=utf-8");
                response.setHeader("Cache-Control", "no-store");
                response.end(run.log);
              } else sendJson(response, { run });
            })
            .catch((error: unknown) => {
              const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
              sendJson(response, { error: missing ? "Test run not found" : "Could not read test run" }, missing ? 404 : 500);
            });
          return;
        }
        next();
      });
      server.httpServer?.once("close", () => {
        if (activeRun?.exitCode === null) {
          activeRun.kill("SIGTERM");
        }
      });
    },
  };
}

function startTests(response: ServerResponse, opts: RunOptions): void {
  if (activeRun?.exitCode === null) {
    sendJson(response, { error: "tests are already running" }, 409);
    return;
  }
  const extraArgs: string[] = [];
  if (opts.prod) {
    extraArgs.push("--prod");
  }
  if (opts.browser) {
    extraArgs.push("--browser", "--cdp-port", String(cdpPort), "--dashboard-url", opts.dashboardUrl);
    if (opts.keepSignedIn) extraArgs.push("--keep-signed-in");
  }
  if (opts.deployOnPass) {
    extraArgs.push("--deploy-on-pass");
  }
  if (opts.filter) {
    extraArgs.push("--filter", opts.filter);
  }
  activeRun = spawn("go", ["run", ".", "test"].concat(extraArgs), {
    cwd: commandRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeRun.stdout?.pipe(process.stdout, { end: false });
  activeRun.stderr?.pipe(process.stdout, { end: false });
  activeRun.once("error", (error) => {
    console.error("[dialtone-earth-ui] test process failed to start", error);
  });
  activeRun.once("exit", () => {
    activeRun = null;
  });
  sendJson(response, { started: true, pid: activeRun.pid ?? null, browser: opts.browser, filter: opts.filter || null }, 202);
}

async function promoteStagingToLive(response: ServerResponse): Promise<void> {
  if (activeRun?.exitCode === null) {
    sendJson(response, { error: "Staging gate blocked: tests or deploy are currently running" }, 409);
    return;
  }
  const readiness = await evaluateDeployReadiness({});
  if (!readiness.ready) {
    sendJson(response, { error: `Deploy blocked: ${readiness.reason}` }, 412);
    return;
  }
  activeRun = spawn("go", ["run", ".", "deploy", "--live", "--require-pass"], {
    cwd: commandRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeRun.stdout?.pipe(process.stdout, { end: false });
  activeRun.stderr?.pipe(process.stdout, { end: false });
  activeRun.once("exit", () => {
    activeRun = null;
  });
  sendJson(response, { promoting: true, passed: readiness.passed, total: readiness.total }, 202);
}

async function listCdpPageTargets(): Promise<CdpPageTarget[]> {
  try {
    const listResp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(900),
    });
    if (!listResp.ok) return [];
    const list: unknown = await listResp.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (t): t is Record<string, unknown> =>
          isRecord(t) &&
          t.type === "page" &&
          typeof t.id === "string" &&
          typeof t.webSocketDebuggerUrl === "string" &&
          !text(t.url).startsWith("devtools://") &&
          !text(t.url).startsWith("http://127.0.0.1:5174"),
      )
      .map((t) => ({
        id: text(t.id),
        title: text(t.title, text(t.url)),
        url: text(t.url),
        wsUrl: text(t.webSocketDebuggerUrl),
      }));
  } catch {
    return [];
  }
}

const MOBILE_PREVIEW_HASH = "#mobile-preview";
let creatingMobileTarget: Promise<CdpPageTarget | null> | null = null;

async function activeTargetOrigin(): Promise<string> {
  const pipe = await readPipeline();
  const target = text(pipe.target_origin);
  if (target) return target.replace(/\/+$/, "");
  const st = text(pipe.stage);
  if (st === "verifying_prod" || st === "deployed") {
    return "https://metal.dialtone.earth";
  }
  return (process.env.STAGING_PREVIEW_URL || "http://127.0.0.1:5175").replace(/\/+$/, "");
}

async function findActiveAppPageTarget(targetId = "", viewport = ""): Promise<CdpPageTarget | null> {
  const pages = await listCdpPageTargets();
  const preferredOrigin = await activeTargetOrigin();
  if (viewport === "mobile") {
    const existing = pages.find((p) => p.url.includes(MOBILE_PREVIEW_HASH));
    if (existing) return existing;
    if (!creatingMobileTarget) {
      creatingMobileTarget = (async () => {
        try {
          await createNewCdpTab(`${preferredOrigin}/${MOBILE_PREVIEW_HASH}`);
          await new Promise((r) => setTimeout(r, 450));
          const updated = await listCdpPageTargets();
          return updated.find((p) => p.url.includes(MOBILE_PREVIEW_HASH)) || null;
        } catch {
          return null;
        } finally {
          creatingMobileTarget = null;
        }
      })();
    }
    return creatingMobileTarget;
  }
  if (pages.length === 0) return null;
  if (targetId && SAFE_TARGET_ID_RE.test(targetId)) {
    const exact = pages.find((p) => p.id === targetId);
    if (exact) return exact;
  }
  const desktopPages = pages.filter((p) => !p.url.includes(MOBILE_PREVIEW_HASH));
  const pool = desktopPages.length > 0 ? desktopPages : pages;
  return (
    pool.find((t) => t.url.startsWith(preferredOrigin)) ||
    pool.find((t) => t.url.includes("127.0.0.1:5175")) ||
    pool.find((t) => t.url.includes("metal.dialtone.earth")) ||
    pool.find((t) => t.url.includes("dialtone.earth")) ||
    pool[0]
  );
}

async function createNewCdpTab(rawUrl: string): Promise<Record<string, unknown>> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL for new projected browser tab");
  }
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"));
  if (!allowed) {
    throw new Error("Only https:// or loopback http:// URLs are allowed");
  }
  const versionResp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
    signal: AbortSignal.timeout(1_200),
  });
  if (!versionResp.ok) {
    throw new Error("Persistent Chrome CDP is offline — launch browser first");
  }
  const version: unknown = await versionResp.json();
  const browserWsUrl = isRecord(version) ? text(version.webSocketDebuggerUrl) : "";
  if (!browserWsUrl) {
    throw new Error("Browser WebSocket URL unavailable");
  }
  const targetId = await new Promise<string>((resolveFn, rejectFn) => {
    const ws = new WebSocket(browserWsUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      rejectFn(new Error("Timed out creating CDP target"));
    }, 3_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: parsed.toString() } }));
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { id?: number; result?: { targetId?: string }; error?: { message?: string } };
        if (msg.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (msg.error) rejectFn(new Error(msg.error.message || "Target.createTarget failed"));
        else resolveFn(msg.result?.targetId || "");
      } catch {
        // ignore
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      rejectFn(new Error("CDP browser WebSocket error"));
    });
  });
  return { ok: true, targetId, url: parsed.toString() };
}

async function captureSingleCdpFrame(targetId = "", viewport = ""): Promise<Buffer | null> {
  const target = await findActiveAppPageTarget(targetId, viewport);
  if (!target) return null;
  return new Promise((resolveFn) => {
    const ws = new WebSocket(target.wsUrl);
    let settled = false;
    const done = (buf: Buffer | null) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolveFn(buf);
    };
    const timer = setTimeout(() => done(null), 2_500);
    ws.addEventListener("open", () => {
      if (viewport === "mobile") {
        ws.send(
          JSON.stringify({
            id: 9,
            method: "Emulation.setDeviceMetricsOverride",
            params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
          }),
        );
      }
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 78 } }));
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { id?: number; result?: { data?: string } };
        if (msg.id === 1 && msg.result?.data) {
          clearTimeout(timer);
          done(Buffer.from(msg.result.data, "base64"));
        }
      } catch {
        // ignore
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

async function streamCdpViewport(
  request: IncomingMessage,
  response: ServerResponse,
  targetId = "",
  viewport = "",
): Promise<void> {
  const target = await findActiveAppPageTarget(targetId, viewport);
  if (!target) {
    sendJson(response, { error: "CDP browser offline" }, 503);
    return;
  }
  response.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=cdpframe",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Connection: "keep-alive",
    Pragma: "no-cache",
  });

  const ws = new WebSocket(target.wsUrl);
  let closed = false;
  let nextId = 10;

  const writeFrame = (base64Jpeg: string) => {
    if (closed || response.writableEnded) return;
    const buf = Buffer.from(base64Jpeg, "base64");
    response.write(`--cdpframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
    response.write(buf);
    response.write("\r\n");
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: nextId++, method: "Page.stopScreencast" }));
      }
      ws.close();
    } catch {
      // ignore
    }
    if (!response.writableEnded) {
      response.end();
    }
  };

  request.once("close", cleanup);
  response.once("close", cleanup);

  ws.addEventListener("open", () => {
    if (closed) return;
    ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    if (viewport === "mobile") {
      ws.send(
        JSON.stringify({
          id: 4,
          method: "Emulation.setDeviceMetricsOverride",
          params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
        }),
      );
      ws.send(
        JSON.stringify({
          id: 5,
          method: "Emulation.setTouchEmulationEnabled",
          params: { enabled: true },
        }),
      );
    }
    ws.send(JSON.stringify({ id: 2, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 80 } }));
    ws.send(
      JSON.stringify({
        id: 3,
        method: "Page.startScreencast",
        params:
          viewport === "mobile"
            ? { format: "jpeg", quality: 82, maxWidth: 460, maxHeight: 900, everyNthFrame: 1 }
            : { format: "jpeg", quality: 80, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 },
      }),
    );
  });

  ws.addEventListener("message", (event) => {
    if (closed) return;
    try {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: { data?: string };
        params?: { data?: string; sessionId?: number };
      };
      if (msg.id === 2 && msg.result?.data) {
        writeFrame(msg.result.data);
      } else if (msg.method === "Page.screencastFrame" && msg.params?.data) {
        writeFrame(msg.params.data);
        if (typeof msg.params.sessionId === "number" && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              id: nextId++,
              method: "Page.screencastFrameAck",
              params: { sessionId: msg.params.sessionId },
            }),
          );
        }
      }
    } catch {
      // ignore malformed message
    }
  });

  ws.addEventListener("close", cleanup);
  ws.addEventListener("error", cleanup);
}

async function readCdpStatus(): Promise<Record<string, unknown>> {
  let meta: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(resolve(logsDir, "cdp.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) meta = parsed;
  } catch {
    // no cdp.json yet
  }
  try {
    const versionResp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(900),
    });
    if (!versionResp.ok) {
      return { connected: false, port: cdpPort, pid: null, app_url: text(meta?.app_url), targets: [] };
    }
    const version: unknown = await versionResp.json();
    const pages = await listCdpPageTargets();
    const visiblePages = pages.filter((p) => !p.url.includes(MOBILE_PREVIEW_HASH));
    const preferredOrigin = await activeTargetOrigin();
    const appPage =
      visiblePages.find((t) => t.url.startsWith(preferredOrigin)) ||
      visiblePages.find((t) => t.url.includes("127.0.0.1:5175")) ||
      visiblePages.find((t) => t.url.includes("metal.dialtone.earth")) ||
      visiblePages[0];
    return {
      connected: true,
      port: cdpPort,
      pid: typeof meta?.pid === "number" ? meta.pid : null,
      browser: isRecord(version) ? text(version.Browser) : "",
      app_url: appPage ? appPage.url : text(meta?.app_url),
      active_target_id: appPage ? appPage.id : "",
      active_origin: preferredOrigin,
      page_count: visiblePages.length,
      targets: visiblePages.map((p) => ({ id: p.id, title: p.title, url: p.url })),
    };
  } catch {
    return { connected: false, port: cdpPort, pid: null, app_url: text(meta?.app_url), targets: [] };
  }
}

function ensureCdpBrowser(response: ServerResponse, dashboardUrl: string): void {
  const script = resolve(commandRoot, "registry", "scripts", "cdp-session.mjs");
  const launcher = spawn("node", [script, "ensure", "--port", String(cdpPort), "--dashboard", dashboardUrl], {
    cwd: commandRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let errOut = "";
  launcher.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  launcher.stderr?.on("data", (chunk: Buffer) => {
    errOut += chunk.toString("utf8");
  });
  launcher.once("exit", (code) => {
    if (code === 0) {
      try {
        sendJson(response, JSON.parse(out.trim()));
      } catch {
        sendJson(response, { connected: true, port: cdpPort });
      }
    } else {
      sendJson(response, { error: errOut.trim() || "Could not start persistent CDP browser" }, 500);
    }
  });
  launcher.once("error", (error) => {
    sendError(response, error);
  });
}

function closeCdpBrowser(_request: IncomingMessage, response: ServerResponse): void {
  const closer = spawn("go", ["run", ".", "test"].concat(["--close-browser", "--cdp-port", String(cdpPort)]), {
    cwd: commandRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errOut = "";
  closer.stderr?.on("data", (chunk: Buffer) => {
    errOut += chunk.toString("utf8");
  });
  closer.once("exit", (code) => {
    if (code === 0) {
      sendJson(response, { closed: true, port: cdpPort });
    } else {
      sendJson(response, { error: errOut.trim() || "Could not close persistent CDP browser" }, 500);
    }
  });
  closer.once("error", (error) => {
    sendError(response, error);
  });
}

async function readPipeline(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(resolve(logsDir, "pipeline.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // no pipeline run yet
  }
  return { stage: "idle", message: "Ready — edit code or start tests to run and auto-deploy to dialtone.earth" };
}

async function readTests(): Promise<TestRecord[]> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    // No run and no `go run . dev` yet: there is simply nothing to show.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  const tests = isRecord(parsed) && Array.isArray(parsed.tests) ? parsed.tests : [];
  return tests.filter(isRecord).map((value) => ({
    name: text(value.name),
    title: text(value.title, text(value.name)),
    section: text(value.section),
    source: text(value.source),
    status: normalizeStatus(value.status),
    elapsed: text(value.elapsed, "0"),
    timestamp: text(value.timestamp, "none"),
    "test-id": text(value["test-id"]),
  }));
}

async function readTestRun(testId: string): Promise<Record<string, unknown> & { log: string }> {
  // Only server-validated opaque IDs select files; no path from state.json is used.
  const [metadata, log] = await Promise.all([
    readFile(resolve(logsDir, `${testId}.json`), "utf8"),
    readFile(resolve(logsDir, `${testId}.log`), "utf8"),
  ]);
  const run: unknown = JSON.parse(metadata);
  if (!isRecord(run) || run["test-id"] !== testId) throw new Error("Invalid run metadata");
  return { ...run, log };
}

function normalizeStatus(value: unknown): string {
  const status = text(value);
  return status === "running" || status === "pass" || status === "fail" || status === "skip" ? status : "pending";
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, error: unknown): void {
  sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
}

async function collectDeployableFiles(root: string): Promise<string[]> {
  const relPaths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
        await walk(resolve(dir, entry.name));
      } else if (entry.isFile()) {
        relPaths.push(relative(root, resolve(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  };
  await walk(resolve(root, "registry", "src"));
  await walk(resolve(root, "registry", "worker"));
  for (const single of ["registry/index.html", "registry/wrangler.jsonc", "install.sh", "install.ps1"]) {
    try {
      const st = await stat(resolve(root, single));
      if (st.isFile()) relPaths.push(single);
    } catch {
      // optional
    }
  }
  relPaths.sort();
  return relPaths;
}

async function computeStagingFingerprint(root: string): Promise<string> {
  const relPaths = await collectDeployableFiles(root);
  const hash = createHash("sha256");
  for (const rel of relPaths) {
    try {
      const data = await readFile(resolve(root, rel));
      hash.update(rel);
      hash.update("\n");
      hash.update(data);
      hash.update("\n");
    } catch {
      // skip unreadable
    }
  }
  return hash.digest("hex");
}

async function readDeployedHash(): Promise<{ deployedHash: string; versionId: string; deployedAt: string }> {
  try {
    const raw = await readFile(resolve(logsDir, "deployed.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      return {
        deployedHash: text(parsed.deployed_hash),
        versionId: text(parsed.version_id),
        deployedAt: text(parsed.deployed_at),
      };
    }
  } catch {
    // not deployed yet
  }
  return { deployedHash: "", versionId: "", deployedAt: "" };
}

type DeployReadiness = {
  ready: boolean;
  has_changes: boolean;
  all_tests_passed: boolean;
  tested_matches_current: boolean;
  browser_passed: number;
  browser_total: number;
  passed: number;
  failed: number;
  running: number;
  pending: number;
  total: number;
  current_hash: string;
  tested_hash: string;
  deployed_hash: string;
  reason: string;
};

async function evaluateDeployReadiness(
  releaseChannels: Record<string, unknown>,
): Promise<DeployReadiness> {
  const [tests, pipeline, deployed, currentHash] = await Promise.all([
    readTests(),
    readPipeline(),
    readDeployedHash(),
    computeStagingFingerprint(commandRoot),
  ]);
  const failed = tests.filter((t) => t.status === "fail").length;
  const running = tests.filter((t) => t.status === "running").length;
  const pending = tests.filter((t) => t.status === "pending" || !t.status).length;
  const passed = tests.filter((t) => t.status === "pass").length;
  const browserTests = tests.filter((t) => t.name.startsWith("TestBrowser"));
  const browserPassed = browserTests.filter((t) => t.status === "pass").length;

  const testedHash = text(pipeline.tested_hash);
  const deployedHash = deployed.deployedHash || text(pipeline.deployed_hash);

  const testCh = isRecord(releaseChannels.test) ? text(releaseChannels.test.tag) : "";
  const latestCh = isRecord(releaseChannels.latest) ? text(releaseChannels.latest.tag) : "";
  const hasReleaseUpdate = Boolean(testCh && testCh !== latestCh);
  const hasChanges = (Boolean(currentHash) && currentHash !== deployedHash) || hasReleaseUpdate;
  const allTestsPassed =
    tests.length > 0 &&
    failed === 0 &&
    running === 0 &&
    pending === 0 &&
    passed > 0 &&
    browserTests.length > 0 &&
    browserPassed === browserTests.length;
  const testedMatchesCurrent = Boolean(testedHash) && testedHash === currentHash;
  const ready = hasChanges && allTestsPassed && testedMatchesCurrent;

  let reason = "ready to deploy";
  if (!hasChanges) {
    reason = "up to date — nothing new to deploy";
  } else if (running > 0) {
    reason = `${running} test(s) still running`;
  } else if (failed > 0) {
    reason = `${failed} test(s) failed — fix before deploying`;
  } else if (pending > 0 || passed === 0) {
    reason = "run all tests on test network before deploying";
  } else if (browserTests.length === 0 || browserPassed < browserTests.length) {
    reason = `test-network browser suite incomplete (${browserPassed}/${browserTests.length})`;
  } else if (!testedMatchesCurrent) {
    reason = "code changed since last passing test-network run — re-run tests";
  }

  return {
    ready,
    has_changes: hasChanges,
    all_tests_passed: allTestsPassed,
    tested_matches_current: testedMatchesCurrent,
    browser_passed: browserPassed,
    browser_total: browserTests.length,
    passed,
    failed,
    running,
    pending,
    total: tests.length,
    current_hash: currentHash,
    tested_hash: testedHash,
    deployed_hash: deployedHash,
    reason,
  };
}

let cachedReleaseChannels: Record<string, unknown> = {};
let cachedReleaseChannelsAt = 0;
let stagingEnvInFlight: Promise<Record<string, unknown>> | null = null;

async function readStagingEnvStatus(): Promise<Record<string, unknown>> {
  if (stagingEnvInFlight) return stagingEnvInFlight;
  stagingEnvInFlight = (async () => {
    const previewBase = (process.env.STAGING_PREVIEW_URL || "http://127.0.0.1:5175").replace(/\/+$/, "");
    let preview: Record<string, unknown> = { ok: false, channel: "test", preview_url: `${previewBase}/`, nodes: [] };
    try {
      const resp = await fetch(`${previewBase}/api/staging-test/status`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (resp.ok) {
        preview = (await resp.json()) as Record<string, unknown>;
      }
    } catch {
      // preview offline
    }
    const now = Date.now();
    if (now - cachedReleaseChannelsAt > 30_000) {
      try {
        const chResp = await fetch("https://dialtone.earth/api/releases/dialtone/channels", {
          signal: AbortSignal.timeout(2_000),
        });
        if (chResp.ok) {
          const data = (await chResp.json()) as { channels?: Record<string, unknown> };
          cachedReleaseChannels = data.channels || {};
          cachedReleaseChannelsAt = now;
        }
      } catch {
        // offline or not yet deployed
      }
    }
    const deploy = await evaluateDeployReadiness(cachedReleaseChannels);
    return {
      preview,
      release_channels: cachedReleaseChannels,
      deploy,
    };
  })().finally(() => {
    stagingEnvInFlight = null;
  });
  return stagingEnvInFlight;
}

export default defineConfig({
  base: "/",
  plugins: [testApiPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
