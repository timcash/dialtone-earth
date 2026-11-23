import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
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
let activeRun: ChildProcess | null = null;

type TestRecord = {
  name: string;
  title: string;
  status: string;
  elapsed: string;
  timestamp: string;
  "test-id": string;
};

function testApiPlugin(): Plugin {
  return {
    name: "dialtone-earth-test-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://local").pathname;
        if (pathname === "/api/tests" && request.method === "GET") {
          readTests()
            .then((tests) => sendJson(response, { tests }))
            .catch((error: unknown) => sendError(response, error));
          return;
        }
        if (pathname === "/api/tests/run" && request.method === "POST") {
          startTests(response);
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

function startTests(response: ServerResponse): void {
  if (activeRun?.exitCode === null) {
    sendJson(response, { error: "tests are already running" }, 409);
    return;
  }
  activeRun = spawn("go", ["run", ".", "test"], {
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
  sendJson(response, { started: true, pid: activeRun.pid ?? null }, 202);
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
