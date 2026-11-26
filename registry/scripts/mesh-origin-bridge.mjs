import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

const ALLOWED_MESH_ROUTES = new Set([
  "/api/mesh",
  "/api/state",
  "/api/details",
  "/api/plugins",
  "/api/shell/sessions",
  "/api/processes",
  "/api/probe",
  "/api/net",
  "/api/links",
]);

const TEST_RUN_RE = /^\/api\/test-runs\/([a-f0-9]{32})(\/log)?$/;
const STAGING_PREFIX = "/__staging";

export function constantTimeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sanitizeStatePayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return {
    node: raw.node ?? "",
    events: Array.isArray(raw.events) ? raw.events.slice(-25) : [],
    alerts: Array.isArray(raw.alerts) ? raw.alerts.slice(-25) : [],
    blob_fetches: Array.isArray(raw.blob_fetches) ? raw.blob_fetches.slice(-25) : [],
    probe: raw.probe ?? null,
    processes: Array.isArray(raw.processes) ? raw.processes : [],
    stats: raw.stats ?? null,
  };
}

export function createOriginBridgeHandler({
  token,
  meshOrigin = "http://127.0.0.1:8788",
  testOrigin = "http://127.0.0.1:5174",
  fetchImpl = fetch,
}) {
  if (!token || token.length < 16) {
    throw new Error("MESH_ORIGIN_TOKEN (>= 16 chars) is required");
  }

  return async function handle(req, res) {
    const sendJson = (status, payload) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(payload));
    };

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const isStagingProxy =
      url.pathname === STAGING_PREFIX ||
      url.pathname.startsWith(`${STAGING_PREFIX}/`);

    // Non-staging mesh routes remain strictly read-only.
    if (!isStagingProxy && req.method !== "GET" && req.method !== "HEAD") {
      sendJson(405, { error: "Method not allowed; origin bridge is read-only" });
      return;
    }

    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    if (!constantTimeTokenMatch(bearer, token)) {
      sendJson(401, { error: "Unauthorized" });
      return;
    }

    // Owner-verified staging proxy for https://test.dialtone.earth/ -> local Vite Test Dashboard (127.0.0.1:5174)
    if (isStagingProxy) {
      const ownerHeader = String(req.headers["x-dialtone-staging-owner"] || "").trim();
      if (!ownerHeader) {
        sendJson(403, { error: "Missing verified staging owner header" });
        return;
      }
      const subPath = url.pathname.slice(STAGING_PREFIX.length) || "/";
      const target = new URL(`${subPath}${url.search}`, testOrigin).toString();
      try {
        const chunks = [];
        if (req.method !== "GET" && req.method !== "HEAD") {
          for await (const chunk of req) chunks.push(chunk);
        }
        const controller = new AbortController();
        req.once("close", () => controller.abort());
        const isStream = subPath === "/api/cdp/stream";
        const upstream = await fetchImpl(target, {
          method: req.method,
          headers: {
            ...(req.headers["content-type"]
              ? { "Content-Type": String(req.headers["content-type"]) }
              : {}),
            ...(req.headers.accept ? { Accept: String(req.headers.accept) } : {}),
          },
          body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          redirect: "manual",
          signal: isStream ? controller.signal : AbortSignal.timeout(15_000),
        });
        const outHeaders = {
          "Content-Type":
            upstream.headers.get("Content-Type") || "application/octet-stream",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        };
        const loc = upstream.headers.get("Location");
        if (loc) outHeaders.Location = loc;
        res.writeHead(upstream.status, outHeaders);
        if (upstream.body) {
          const nodeStream = Readable.fromWeb(upstream.body);
          nodeStream.on("error", () => {
            if (!res.writableEnded) res.end();
          });
          nodeStream.pipe(res);
        } else {
          res.end();
        }
      } catch {
        if (!res.headersSent) {
          sendJson(502, { error: "Local staging test dashboard upstream unavailable" });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    let upstreamBase = null;
    let upstreamPath = url.pathname;

    if (ALLOWED_MESH_ROUTES.has(url.pathname)) {
      upstreamBase = meshOrigin;
      if (url.pathname === "/api/details") {
        const nodeId = url.searchParams.get("node_id") || "";
        if (/^[a-zA-Z0-9_-]{1,128}$/.test(nodeId)) {
          upstreamPath = `/api/details?node_id=${encodeURIComponent(nodeId)}`;
        }
      }
    } else if (url.pathname === "/api/tests" || TEST_RUN_RE.test(url.pathname)) {
      upstreamBase = testOrigin;
    } else {
      sendJson(404, { error: "Route not allowlisted" });
      return;
    }

    try {
      const target = new URL(upstreamPath, upstreamBase).toString();
      const upstream = await fetchImpl(target, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (url.pathname === "/api/state" && upstream.ok) {
        const parsed = await upstream.json();
        sendJson(200, sanitizeStatePayload(parsed));
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("Content-Type") ||
          "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(buf);
    } catch {
      sendJson(502, { error: "Local Dialtone upstream unavailable" });
    }
  };
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (isDirectRun) {
  const token = (process.env.MESH_ORIGIN_TOKEN || "").trim();
  const port = Number(process.env.ORIGIN_BRIDGE_PORT || 8790);
  const meshOrigin = process.env.DIALTONE_ORIGIN || "http://127.0.0.1:8788";
  const testOrigin = process.env.TEST_DASHBOARD_ORIGIN || "http://127.0.0.1:5174";
  const handler = createOriginBridgeHandler({ token, meshOrigin, testOrigin });
  createServer(handler).listen(port, "127.0.0.1", () => {
    console.log(`dialtone-earth origin bridge listening on http://127.0.0.1:${port}`);
    console.log(`  mesh upstream:    ${meshOrigin}`);
    console.log(`  staging upstream: ${testOrigin}`);
  });
}
