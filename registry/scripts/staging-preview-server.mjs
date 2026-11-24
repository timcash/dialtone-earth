import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handleGatewayRequest } from "../worker/gateway.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = resolve(SCRIPT_DIR, "..");
const DIST_DIR = resolve(REGISTRY_DIR, "dist");

const PORT = Number(process.env.STAGING_PREVIEW_PORT || 5175);
const PREVIEW_VIRTUAL_HOST = (
  process.env.STAGING_PREVIEW_HOST || "test-channel.dialtone.earth"
).toLowerCase();
const TEST_MESH_ORIGINS = (
  process.env.STAGING_TEST_MESH_ORIGINS ||
  "http://127.0.0.1:8798,http://127.0.0.1:8799"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_DASHBOARD_ORIGIN = (
  process.env.DIALTONE_DASHBOARD_URL || "http://127.0.0.1:5174"
).replace(/\/+$/, "");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
};

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function createMemoryR2() {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        body: entry.buf,
        size: entry.buf.byteLength,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
        async arrayBuffer() {
          return entry.buf.slice(0);
        },
      };
    },
    async put(key, value, options = {}) {
      let buf;
      if (value instanceof ArrayBuffer) {
        buf = new Uint8Array(value.slice(0));
      } else if (ArrayBuffer.isView(value)) {
        buf = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      } else if (typeof value === "string") {
        buf = new TextEncoder().encode(value);
      } else {
        buf = new Uint8Array(0);
      }
      store.set(key, {
        buf,
        httpMetadata: options.httpMetadata || {},
        customMetadata: options.customMetadata || {},
      });
    },
  };
}

function createDistAssetFetcher(distDir) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let reqPath = decodeURIComponent(url.pathname || "/");
      if (reqPath === "/") reqPath = "/index.html";
      const safeRel = reqPath.replace(/^\/+/, "");
      const candidate = resolve(distDir, safeRel);
      const isInside =
        candidate === distDir || candidate.startsWith(`${distDir}${process.platform === "win32" ? "\\" : "/"}`);
      let filePath = isInside && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : null;
      if (!filePath && !extname(safeRel)) {
        const fallback = join(distDir, "index.html");
        if (existsSync(fallback)) filePath = fallback;
      }
      if (!filePath) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const data = readFileSync(filePath);
      const mime = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "no-store",
        },
      });
    },
  };
}

async function probeTestMeshNodes() {
  const results = await Promise.all(
    TEST_MESH_ORIGINS.map(async (origin) => {
      try {
        const resp = await fetch(`${origin}/api/mesh`, {
          signal: AbortSignal.timeout(2_500),
        });
        if (!resp.ok) {
          return { origin, reachable: false, error: `HTTP ${resp.status}` };
        }
        const data = await resp.json();
        const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
        return {
          origin,
          reachable: true,
          node: data?.self_node || nodes[0]?.node || "",
          channel: data?.channel || "test",
          nodeCount: nodes.length,
          nodes: nodes.map((n) => n?.node || n?.name || "").filter(Boolean),
        };
      } catch (err) {
        return {
          origin,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return results;
}

export function createStagingPreviewServer({
  port = PORT,
  distDir = DIST_DIR,
  virtualHost = PREVIEW_VIRTUAL_HOST,
  meshOrigins = TEST_MESH_ORIGINS,
  dashboardOrigin = TEST_DASHBOARD_ORIGIN,
} = {}) {
  const kv = createMemoryKv();
  const r2 = createMemoryR2();
  const signingKey =
    (process.env.STAGING_PREVIEW_SIGNING_KEY || "").trim() ||
    randomBytes(32).toString("hex");
  const liveToken =
    (process.env.DIALTONE_LIVE_TOKEN || "").trim() ||
    randomBytes(24).toString("hex");
  const assets = createDistAssetFetcher(distDir);

  let lastMagicLink = null;
  const env = {
    ASSETS: assets,
    DIALTONE_AUTH_TOKENS: kv,
    DIALTONE_REGISTRY: r2,
    SESSION_SIGNING_KEY: signingKey,
    LIVE_CONTROL_TOKEN: liveToken,
    OWNER_EMAIL: "timcash@gmail.com",
    MAGIC_LINK_FROM: "login@dialtone.earth",
    MAGIC_LINK_ALLOWLIST: JSON.stringify({
      [virtualHost]: ["timcash@gmail.com", "test@dialtone.earth"],
    }),
    MESH_ORIGINS_MAP: JSON.stringify({
      [virtualHost]: meshOrigins,
    }),
    TEST_DASHBOARD_ORIGIN: dashboardOrigin,
  };

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    // Loopback-only staging helper endpoints for the Test Dashboard & CDP E2E tests
    if (reqUrl.pathname === "/api/staging-test/status" && req.method === "GET") {
      const nodes = await probeTestMeshNodes();
      const indexPath = join(distDir, "index.html");
      const distBuiltAt = existsSync(indexPath)
        ? statSync(indexPath).mtime.toISOString()
        : null;
      const body = JSON.stringify({
        ok: nodes.some((n) => n.reachable),
        isolated: true,
        channel: "test",
        virtual_host: virtualHost,
        preview_url: `http://127.0.0.1:${port}/`,
        dist_built_at: distBuiltAt,
        mesh_origins: meshOrigins,
        nodes,
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    if (reqUrl.pathname === "/api/staging-test/last-magic-link" && req.method === "GET") {
      res.writeHead(lastMagicLink ? 200 : 404, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify(
          lastMagicLink || { error: "No magic link requested yet in this staging preview" },
        ),
      );
      return;
    }

    const chunks = [];
    if (req.method !== "GET" && req.method !== "HEAD") {
      for await (const chunk of req) chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (k.toLowerCase() === "host") continue;
      if (Array.isArray(v)) headers.set(k, v.join(", "));
      else headers.set(k, v);
    }
    headers.set("Host", virtualHost);

    const syntheticUrl = `https://${virtualHost}${reqUrl.pathname}${reqUrl.search}`;
    const webReq = new Request(syntheticUrl, {
      method: req.method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });

    const deps = {
      nowSec: () => Math.floor(Date.now() / 1000),
      sendEmail: async (payload) => {
        const text = String(payload?.text || "");
        const m = text.match(/https?:\/\/[^/\s]+(\/auth\/verify\?token=[A-Za-z0-9._~%-]+)/);
        if (m) {
          lastMagicLink = {
            to: payload?.to || "",
            url: `http://127.0.0.1:${port}${m[1]}`,
            created_at: new Date().toISOString(),
          };
        }
      },
    };

    try {
      const response = await handleGatewayRequest(webReq, env, deps);
      const outHeaders = {};
      const setCookies = [];
      for (const [k, v] of response.headers.entries()) {
        if (k.toLowerCase() === "set-cookie") {
          // Allow HTTP loopback cookie storage on http://127.0.0.1:<port>
          setCookies.push(v.replace(/;\s*Secure\b/gi, ""));
        } else if (k.toLowerCase() === "strict-transport-security") {
          // Do not pin HSTS on loopback 127.0.0.1
          continue;
        } else {
          outHeaders[k] = v;
        }
      }
      if (setCookies.length > 0) {
        outHeaders["set-cookie"] = setCookies;
      }
      res.writeHead(response.status, outHeaders);
      const ab = await response.arrayBuffer();
      res.end(Buffer.from(ab));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = createStagingPreviewServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(
      `[staging-preview] isolated dialtone.earth preview listening at http://127.0.0.1:${PORT}/ -> test Iroh channel (${TEST_MESH_ORIGINS.join(", ")})`,
    );
  });
}
