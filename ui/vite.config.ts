import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  filter: string;
  dashboardUrl: string;
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
          const hostHeader = typeof request.headers.host === "string" ? request.headers.host : "127.0.0.1:5174";
          startTests(response, {
            browser,
            keepSignedIn,
            filter,
            dashboardUrl: `http://${hostHeader}/`,
          });
          return;
        }
        if (pathname === "/api/cdp/status" && request.method === "GET") {
          readCdpStatus()
            .then((status) => sendJson(response, status))
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/cdp/stream" && request.method === "GET") {
          streamCdpViewport(request, response).catch((error: unknown) => {
            if (!response.headersSent) sendError(response, error);
            else response.end();
          });
          return;
        }
        if (pathname === "/api/cdp/frame" && request.method === "GET") {
          captureSingleCdpFrame()
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
  if (opts.browser) {
    extraArgs.push("--browser", "--cdp-port", String(cdpPort), "--dashboard-url", opts.dashboardUrl);
    if (opts.keepSignedIn) extraArgs.push("--keep-signed-in");
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

async function findActiveAppPageTarget(): Promise<{ url: string; wsUrl: string } | null> {
  try {
    const listResp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(900),
    });
    if (!listResp.ok) return null;
    const list: unknown = await listResp.json();
    const pages = Array.isArray(list)
      ? list.filter((t): t is Record<string, unknown> => isRecord(t) && t.type === "page" && typeof t.webSocketDebuggerUrl === "string")
      : [];
    const target =
      pages.find((t) => text(t.url).includes("dialtone.earth")) ||
      pages.find((t) => !text(t.url).includes("127.0.0.1:5174") && !text(t.url).startsWith("devtools://")) ||
      pages[0];
    if (!target) return null;
    return { url: text(target.url), wsUrl: text(target.webSocketDebuggerUrl) };
  } catch {
    return null;
  }
}

async function captureSingleCdpFrame(): Promise<Buffer | null> {
  const target = await findActiveAppPageTarget();
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

async function streamCdpViewport(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const target = await findActiveAppPageTarget();
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
    response.write(
      `--cdpframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`,
    );
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
    ws.send(JSON.stringify({ id: 2, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 78 } }));
    ws.send(
      JSON.stringify({
        id: 3,
        method: "Page.startScreencast",
        params: { format: "jpeg", quality: 78, maxWidth: 1280, maxHeight: 840, everyNthFrame: 1 },
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
      return { connected: false, port: cdpPort, pid: null, app_url: text(meta?.app_url) };
    }
    const version: unknown = await versionResp.json();
    const listResp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(900),
    });
    const list: unknown = listResp.ok ? await listResp.json() : [];
    const pages = Array.isArray(list) ? list.filter((t) => isRecord(t) && t.type === "page") : [];
    const appPage = pages.find((t) => text(t.url).includes("dialtone.earth")) || pages[0];
    return {
      connected: true,
      port: cdpPort,
      pid: typeof meta?.pid === "number" ? meta.pid : null,
      browser: isRecord(version) ? text(version.Browser) : "",
      app_url: isRecord(appPage) ? text(appPage.url) : text(meta?.app_url),
      page_count: pages.length,
    };
  } catch {
    return { connected: false, port: cdpPort, pid: null, app_url: text(meta?.app_url) };
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

export default defineConfig({
  base: "/",
  plugins: [testApiPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5174,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
